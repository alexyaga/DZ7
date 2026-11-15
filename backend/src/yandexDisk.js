import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { maxVideoBytes, videoExtension, VideoValidationError } from './videoValidation.js'

const publicApi = 'https://cloud-api.yandex.net/v1/disk/public/resources'
const shareHosts = ['disk.yandex.ru', 'disk.yandex.com', 'yadi.sk']
const redirectStatuses = new Set([301, 302, 303, 307, 308])

function parseShareUrl(value) {
  const url = typeof value === 'string' && value.length <= 2048 ? URL.parse(value.trim()) : null
  if (!url || url.protocol !== 'https:' || !shareHosts.includes(url.hostname)
    || url.username || url.password || url.port || !/^\/(d|i)\/[\w-]+\/?$/.test(url.pathname)) {
    throw new VideoValidationError(400, 'Укажите публичную HTTPS-ссылку на файл Яндекс Диска.')
  }
  return url.origin + url.pathname.replace(/\/$/, '')
}

async function rejectResponse(response) {
  await response.body?.cancel()
  if ([401, 403, 404, 410, 451].includes(response.status)) {
    throw new VideoValidationError(422, 'Файл недоступен. Проверьте публичную ссылку и разрешение на скачивание.')
  }
  if (response.status === 429) {
    throw new VideoValidationError(429, 'Яндекс Диск ограничил скачивание. Попробуйте позже.')
  }
  throw new VideoValidationError(502, 'Яндекс Диск не смог отдать файл. Попробуйте позже.')
}

async function getResource(endpoint, shareUrl, signal) {
  const url = new URL(endpoint)
  url.searchParams.set('public_key', shareUrl)
  const response = await fetch(url, { redirect: 'manual', signal })
  if (!response.ok) await rejectResponse(response)
  return response.json()
}

async function getDownload(href, signal) {
  let url = typeof href === 'string' ? URL.parse(href) : null
  for (let redirects = 0; redirects <= 4; redirects++) {
    const host = url?.hostname
    const trusted = host?.endsWith('.disk.yandex.net')
      || host === 'downloader.disk.yandex.ru' || host === 'downloader.disk.yandex.com'
      || host === 'mds.storage.yandex.net'
    if (!trusted || url.protocol !== 'https:' || url.username || url.password || url.port) break

    const response = await fetch(url, { redirect: 'manual', signal })
    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      url = location ? URL.parse(location, url) : null
      continue
    }
    if (response.status !== 200 || !response.body) await rejectResponse(response)
    return response
  }
  throw new VideoValidationError(502, 'Яндекс Диск вернул неподдерживаемый адрес скачивания.')
}

function checkSize(bytes) {
  if (bytes > maxVideoBytes) throw new VideoValidationError(413, 'Размер видео превышает 750 МБ.')
}

export async function downloadYandexVideo(link, path, signal, findDuplicate) {
  const shareUrl = parseShareUrl(link)
  const deadline = AbortSignal.timeout(300_000)
  const downloadSignal = AbortSignal.any([signal, deadline])
  let outputStarted = false
  try {
    const metadata = await getResource(publicApi, shareUrl, downloadSignal)
    if (metadata?.type !== 'file' || typeof metadata.name !== 'string') {
      throw new VideoValidationError(422, 'Ссылка должна вести на один файл, а не на папку.')
    }
    videoExtension(metadata.name)
    checkSize(metadata.size)
    const yandexResourceId = typeof metadata.resource_id === 'string' && metadata.resource_id
      ? metadata.resource_id
      : undefined
    const providerHash = typeof metadata.sha256 === 'string' ? metadata.sha256.toLowerCase() : ''
    if (yandexResourceId && /^[a-f0-9]{64}$/.test(providerHash)) {
      const duplicate = findDuplicate?.(providerHash, yandexResourceId)
      if (duplicate) return { duplicate }
    }
    const { href } = await getResource(publicApi + '/download', shareUrl, downloadSignal)
    const response = await getDownload(href, downloadSignal)
    try {
      checkSize(Number(response.headers.get('content-length')))
    } catch (error) {
      await response.body.cancel()
      throw error
    }

    let size = 0
    const countBytes = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length
        try {
          checkSize(size)
          done(null, chunk)
        } catch (error) {
          done(error)
        }
      },
    })
    outputStarted = true
    await pipeline(response.body, countBytes, createWriteStream(path, { flags: 'wx' }), { signal: downloadSignal })
    return { path, size, originalname: metadata.name, yandexResourceId }
  } catch (error) {
    if (outputStarted && error.code !== 'EEXIST') await rm(path, { force: true })
    if (error instanceof VideoValidationError || signal.aborted) throw error
    if (deadline.aborted) throw new VideoValidationError(504, 'Скачивание с Яндекс Диска заняло больше 5 минут.')
    if (['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw error
    throw new VideoValidationError(502, 'Не удалось скачать видео с Яндекс Диска.')
  }
}
