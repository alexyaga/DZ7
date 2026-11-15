import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { maxVideoBytes, videoExtension, VideoValidationError } from './videoValidation.js'

const publicApi = 'https://cloud-api.yandex.net/v1/disk/public/resources'
const shareHosts = ['disk.yandex.ru', 'disk.yandex.com', 'yadi.sk']
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const transientNetworkCodes = new Set([
  'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])

function isTransient(error) {
  return transientNetworkCodes.has(error.cause?.code ?? error.code)
    || (error instanceof AggregateError && error.errors.some(isTransient))
}

async function retryNetwork(operation, signal) {
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      try {
        return await operation(AbortSignal.any([signal, controller.signal]))
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      if (signal.aborted || attempt >= 4 || (!controller.signal.aborted && !isTransient(error))) throw error
      await wait(attempt * 400, undefined, { signal })
    }
  }
}

export function parseShareUrl(value) {
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
  return retryNetwork(async attemptSignal => {
    const response = await fetch(url, { redirect: 'manual', signal: attemptSignal })
    if (!response.ok) await rejectResponse(response)
    return response.json()
  }, signal)
}

async function getDownload(href, signal, range) {
  let url = typeof href === 'string' ? URL.parse(href) : null
  for (let redirects = 0; redirects <= 4; redirects++) {
    const host = url?.hostname
    const trusted = host?.endsWith('.disk.yandex.net')
      || host === 'downloader.disk.yandex.ru' || host === 'downloader.disk.yandex.com'
      || host === 'mds.storage.yandex.net'
    if (!trusted || url.protocol !== 'https:' || url.username || url.password || url.port) break

    // The request timeout covers headers. The overall deadline covers the video body.
    const response = await retryNetwork(attemptSignal =>
      fetch(url, {
        redirect: 'manual',
        signal: attemptSignal,
        headers: range ? { Range: range, 'Accept-Encoding': 'identity' } : undefined,
      }), signal)
    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      url = location ? URL.parse(location, url) : null
      continue
    }
    if (response.status !== (range ? 206 : 200) || !response.body) await rejectResponse(response)
    return response
  }
  throw new VideoValidationError(502, 'Яндекс Диск вернул неподдерживаемый адрес скачивания.')
}

async function saveRanges(href, path, size, signal) {
  const chunkSize = 1024 * 1024
  async function* readRanges() {
    for (let start = 0; start < size; start += chunkSize) {
      const end = Math.min(start + chunkSize, size) - 1
      const bytes = await retryNetwork(async attemptSignal => {
        const response = await getDownload(href, attemptSignal, `bytes=${start}-${end}`)
        if (response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) {
          await response.body.cancel()
          throw new VideoValidationError(502, 'Яндекс Диск вернул неверный диапазон байтов.')
        }
        const chunkBuffer = Buffer.allocUnsafe(end - start + 1)
        let received = 0
        for await (const chunk of response.body) {
          if (received + chunk.byteLength > chunkBuffer.length) {
            throw new VideoValidationError(502, 'Яндекс Диск вернул лишние данные.')
          }
          chunkBuffer.set(chunk, received)
          received += chunk.byteLength
        }
        if (received !== chunkBuffer.length) throw new VideoValidationError(502, 'Яндекс Диск вернул неполный файл.')
        return chunkBuffer
      }, signal)
      yield bytes
    }
  }
  try {
    await pipeline(readRanges, createWriteStream(path, { flags: 'wx' }), { signal })
    return size
  } catch (error) {
    if (error.code !== 'EEXIST') await rm(path, { force: true })
    throw error
  }
}

async function saveDownload(href, path, signal, checkSize) {
  for (let attempt = 1; ; attempt++) {
    const response = await getDownload(href, signal)
    const expected = Number(response.headers.get('content-length'))
    try {
      checkSize(expected)
    } catch (error) {
      await response.body.cancel()
      throw error
    }

    let size = 0
    const idle = new AbortController()
    const idleTimer = setTimeout(() => idle.abort(), 25_000)
    const countBytes = new Transform({
      transform(chunk, _encoding, done) {
        idleTimer.refresh()
        size += chunk.length
        try {
          checkSize(size)
          done(null, chunk)
        } catch (error) {
          done(error)
        }
      },
    })
    try {
      await pipeline(response.body, countBytes, createWriteStream(path, { flags: 'wx' }), {
        signal: AbortSignal.any([signal, idle.signal]),
      })
      return size
    } catch (error) {
      if (error.code !== 'EEXIST') await rm(path, { force: true })
      if (signal.aborted || attempt >= 2 || (!idle.signal.aborted && !isTransient(error))) throw error
      if (Number.isSafeInteger(expected) && expected > 0
        && response.headers.get('accept-ranges') === 'bytes') {
        return saveRanges(href, path, expected, signal)
      }
    } finally {
      clearTimeout(idleTimer)
    }
  }
}

export async function downloadYandexVideo(link, path, signal, findDuplicate, { maxBytes = maxVideoBytes, onFilename } = {}) {
  const shareUrl = parseShareUrl(link)
  function checkSize(bytes) {
    if (bytes > maxBytes) throw new VideoValidationError(413, `Размер видео превышает ${maxBytes / 1_000_000} МБ.`)
  }
  const deadline = AbortSignal.timeout(300_000)
  const downloadSignal = AbortSignal.any([signal, deadline])
  try {
    const metadata = await getResource(publicApi, shareUrl, downloadSignal)
    if (metadata?.type !== 'file' || typeof metadata.name !== 'string') {
      throw new VideoValidationError(422, 'Ссылка должна вести на один файл, а не на папку.')
    }
    onFilename?.(metadata.name)
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
    const size = await saveDownload(href, path, downloadSignal, checkSize)
    return { path, size, originalname: metadata.name, yandexResourceId }
  } catch (error) {
    if (error instanceof VideoValidationError || signal.aborted) throw error
    if (deadline.aborted) throw new VideoValidationError(504, 'Скачивание с Яндекс Диска заняло больше 5 минут.')
    if (['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw error
    const code = error.cause?.code ?? error.code ?? error.name
    console.warn('Yandex Disk download failed:', code)
    throw new VideoValidationError(502, 'Не удалось скачать видео с Яндекс Диска.')
  }
}
