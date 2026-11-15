import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import cors from 'cors'
import express from 'express'
import writeFileAtomic from 'write-file-atomic'
import { analyzeMeeting, removeMeetingFiles } from './meetingProcessor.js'
import { validateVideo, videoExtension, VideoValidationError } from './videoValidation.js'
import { downloadYandexVideo, parseShareUrl } from './yandexDisk.js'

const maxBytes = 100_000_000
const maxDurationSeconds = 300
const dailyLimit = 10
const resultLifetimeMs = 60 * 60 * 1000
const dataDir = resolve('data', 'public-demo')
const quotaPath = join(dataDir, 'quota.json')
const tempDir = join(dataDir, 'tmp')
const jobs = new Map()
const clientOrigin = process.env.DEMO_CLIENT_ORIGIN || 'http://localhost:5173'
let accepting = false
let ready = false
let quota = { day: '', count: 0 }

const app = express()
app.disable('x-powered-by')
app.use(cors({ origin: clientOrigin }))
app.use((request, response, next) => {
  response.set('Cache-Control', 'no-store')
  const origin = request.get('Origin')
  if (origin && origin !== clientOrigin) return response.status(403).json({ error: 'Этот адрес не подключён к демо.' })
  if (!ready) return response.status(503).json({ error: 'Демо запускается. Попробуйте чуть позже.' })
  return next()
})

app.get('/api/demo/health', (_request, response) => response.json({ status: 'ok' }))

app.post('/api/demo/jobs', express.json({ limit: '4kb' }), async (request, response) => {
  try {
    const url = parseShareUrl(request.body?.url)
    const knownIds = Array.isArray(request.body?.knownIds) ? request.body.knownIds : []
    // Look up only results whose private identifiers the browser already holds.
    const duplicateId = knownIds.find(id => {
      const job = jobs.get(id)
      return job?.shareUrl === url
        && (job.status !== 'error' || typeof job.transcript === 'string')
        && (!job.expiresAt || Date.parse(job.expiresAt) > Date.now())
    })
    if (duplicateId) return response.json({ id: duplicateId, duplicate: true })

    if (accepting) return response.status(409).json({ error: 'Сейчас обрабатывается другая запись. Попробуйте позже.' })
    const day = new Date().toISOString().slice(0, 10)
    const count = quota.day === day ? quota.count : 0
    if (count >= dailyLimit) {
      return response.status(429).json({ error: 'Лимит демо на сегодня исчерпан. Готовый пример доступен ниже.' })
    }

    accepting = true
    const nextQuota = { day, count: count + 1 }
    try {
      await writeFileAtomic(quotaPath, JSON.stringify(nextQuota))
      quota = nextQuota
    } catch (error) {
      accepting = false
      throw error
    }

    const id = randomUUID()
    const job = {
      shareUrl: url,
      filename: null,
      createdAt: new Date().toISOString(),
      status: 'processing',
      stage: 'downloading',
      transcript: null,
      summary: null,
      error: null,
      expiresAt: null,
    }
    jobs.set(id, job)
    void processDemoJob(id, url, job)
    return response.status(202).json({ id, createdAt: job.createdAt })
  } catch (error) {
    if (error instanceof VideoValidationError) return response.status(error.status).json({ error: error.message })
    console.error('Could not accept demo job:', error.code ?? error.name)
    return response.status(503).json({ error: 'Не удалось запустить демо-анализ.' })
  }
})

function requireDemoJob(request, response, next) {
  const token = /^Bearer ([a-f0-9-]{36})$/.exec(request.get('Authorization') ?? '')?.[1]
  const job = jobs.get(token)
  if (!job) return response.status(404).json({ error: 'Результат недоступен или срок хранения истёк.' })
  response.locals.demoJob = job
  response.locals.demoToken = token
  return next()
}

app.get('/api/demo/result', requireDemoJob, (_request, response) => {
  const { shareUrl, ...result } = response.locals.demoJob
  return response.json(result)
})

app.delete('/api/demo/result', requireDemoJob, (_request, response) => {
  if (response.locals.demoJob.status === 'processing') {
    return response.status(409).json({ error: 'Дождитесь завершения обработки встречи.' })
  }
  jobs.delete(response.locals.demoToken)
  return response.status(204).end()
})

app.use((error, _request, response, next) => {
  if (error.type === 'entity.too.large') return response.status(413).json({ error: 'Ссылка слишком длинная.' })
  if (error.type === 'entity.parse.failed') return response.status(400).json({ error: 'Передайте ссылку в поле url.' })
  return next(error)
})

async function processDemoJob(id, url, job) {
  const videoPath = join(tempDir, id)
  const signal = AbortSignal.timeout(330_000)
  try {
    const file = await downloadYandexVideo(url, videoPath, signal, undefined, {
      maxBytes,
      onFilename: filename => { job.filename = filename },
    })
    job.stage = 'validating'
    const { durationSeconds } = await validateVideo(file, videoExtension(file.originalname), signal)
    if (durationSeconds > maxDurationSeconds) {
      throw new VideoValidationError(422, 'Для демо нужна запись длительностью до 5 минут.')
    }
    job.stage = 'extracting'
    Object.assign(job, await analyzeMeeting(videoPath, changes => Object.assign(job, changes), { maxDurationSeconds }))
  } catch (error) {
    await removeMeetingFiles(videoPath)
    job.status = 'error'
    job.stage = null
    job.error = error instanceof VideoValidationError ? error.message : 'Не удалось обработать запись.'
    if (!(error instanceof VideoValidationError)) console.error('Demo processing failed:', error.code ?? error.name)
  } finally {
    job.expiresAt = new Date(Date.now() + resultLifetimeMs).toISOString()
    accepting = false
    setTimeout(() => jobs.delete(id), resultLifetimeMs).unref()
  }
}

const server = app.listen(Number(process.env.DEMO_PORT ?? 3002), '127.0.0.1')
await once(server, 'listening')
await mkdir(tempDir, { recursive: true })
for (const filename of await readdir(tempDir)) {
  if (/^[a-f0-9-]{36}$/.test(filename)) await removeMeetingFiles(join(tempDir, filename))
  if (/^[a-f0-9-]{36}\.mp3$/.test(filename)) await removeMeetingFiles(join(tempDir, filename.slice(0, -4)))
}
try {
  quota = JSON.parse(await readFile(quotaPath, 'utf8'))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quota.day) || !Number.isInteger(quota.count) || quota.count < 0) {
    throw new Error('Invalid demo quota file')
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
ready = true
console.log(`Public demo API: http://127.0.0.1:${server.address().port}`)
