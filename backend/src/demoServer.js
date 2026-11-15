import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import writeFileAtomic from 'write-file-atomic'
import { analyzeMeeting, removeMeetingFiles } from './meetingProcessor.js'
import { validateVideo, videoExtension, VideoValidationError } from './videoValidation.js'
import { downloadYandexVideo, parseShareUrl } from './yandexDisk.js'

const maxBytes = 100_000_000
const maxDurationSeconds = 300
const dailyLimit = 10
const dailyBonus = Number(process.env.DEMO_DAILY_BONUS ?? 0)
const dailyBonusUntil = Date.parse(process.env.DEMO_DAILY_BONUS_UNTIL ?? '')

function currentDailyLimit(now) {
  return Number.isSafeInteger(dailyBonus) && dailyBonus > 0
    && Number.isSafeInteger(dailyLimit + dailyBonus) && now.getTime() < dailyBonusUntil
    ? dailyLimit + dailyBonus
    : dailyLimit
}
const resultLifetimeMs = 60 * 60 * 1000
const dataDir = resolve('data', 'public-demo')
const quotaPath = join(dataDir, 'quota.json')
const tempDir = join(dataDir, 'tmp')
const jobs = new Map()
const clientOrigin = process.env.DEMO_CLIENT_ORIGIN || 'http://localhost:5173'
let accepting = false
let ready = false
let quota = { day: '', count: 0 }

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, tempDir),
    filename: (_request, _file, callback) => callback(null, randomUUID()),
  }),
  limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 },
  defParamCharset: 'utf8',
  fileFilter(_request, file, callback) {
    try {
      videoExtension(file.originalname)
    } catch (error) {
      return callback(error)
    }
    return callback(null, true)
  },
}).single('video')

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
  const shareUrl = parseShareUrl(request.body?.url)
  const knownIds = Array.isArray(request.body?.knownIds) ? request.body.knownIds : []
  // Look up only results whose private identifiers the browser already holds.
  const duplicateId = knownIds.find(id => {
    const job = jobs.get(id)
    return job?.shareUrl === shareUrl
      && (job.status !== 'error' || typeof job.transcript === 'string')
      && (!job.expiresAt || Date.parse(job.expiresAt) > Date.now())
  })
  if (duplicateId) return response.json({ id: duplicateId, duplicate: true })

  return acceptDemoJob(response, async () => ({ shareUrl }))
})

app.post('/api/demo/jobs/upload', (request, response) => {
  if (!request.is('multipart/form-data')) {
    return response.status(400).json({ error: 'Выберите видео для загрузки.' })
  }
  return acceptDemoJob(response, async () => {
    await new Promise((resolveUpload, rejectUpload) => {
      upload(request, response, error => {
        if (!error) return resolveUpload()
        if (error.code || error instanceof VideoValidationError) return rejectUpload(error)
        return rejectUpload(new VideoValidationError(400, 'Не удалось прочитать форму загрузки.'))
      })
    })
    if (!request.file) throw new VideoValidationError(400, 'Выберите видео для загрузки.')
    return { file: request.file }
  })
})

async function acceptDemoJob(response, receiveSource) {
  if (accepting) return response.status(409).json({ error: 'Сейчас обрабатывается другая запись. Попробуйте позже.' })
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const count = quota.day === day ? quota.count : 0
  if (count >= currentDailyLimit(now)) {
    return response.status(429).json({ error: 'Лимит демо на сегодня исчерпан. Готовый пример доступен ниже.' })
  }

  accepting = true
  let accepted = false
  let input
  try {
    input = await receiveSource()
    if (response.destroyed) return
    const nextQuota = { day, count: count + 1 }
    await writeFileAtomic(quotaPath, JSON.stringify(nextQuota))
    quota = nextQuota

    const id = randomUUID()
    const job = {
      shareUrl: input.shareUrl,
      source: input.file ? 'manual' : 'yandex_disk',
      filename: input.file?.originalname ?? null,
      createdAt: new Date().toISOString(),
      status: 'processing',
      stage: input.file ? 'validating' : 'downloading',
      transcript: null,
      summary: null,
      error: null,
      expiresAt: null,
    }
    jobs.set(id, job)
    accepted = true
    void processDemoJob(id, input, job)
    return response.status(202).json({ id, createdAt: job.createdAt, source: job.source, stage: job.stage })
  } finally {
    if (!accepted) {
      if (input?.file) await removeMeetingFiles(input.file.path)
      accepting = false
    }
  }
}

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
  if (response.headersSent) return next(error)
  if (response.destroyed) return
  if (error instanceof VideoValidationError) return response.status(error.status).json({ error: error.message })
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return response.status(413).json({ error: 'Размер видео превышает 100 МБ.' })
    }
    return response.status(400).json({ error: 'Выберите один видеофайл для загрузки.' })
  }
  if (error.type === 'entity.too.large') return response.status(413).json({ error: 'Ссылка слишком длинная.' })
  if (error.type === 'entity.parse.failed') return response.status(400).json({ error: 'Передайте ссылку в поле url.' })
  console.error('Could not accept demo job:', error.code ?? error.name)
  return response.status(503).json({ error: 'Не удалось запустить демо-анализ.' })
})

async function processDemoJob(id, input, job) {
  const videoPath = input.file?.path ?? join(tempDir, id)
  const signal = AbortSignal.timeout(330_000)
  try {
    const file = input.file ?? await downloadYandexVideo(input.shareUrl, videoPath, signal, undefined, {
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
console.log(`Public demo daily limit at startup: ${currentDailyLimit(new Date())}`)
