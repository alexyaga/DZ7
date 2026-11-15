import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import multer from 'multer'
import { processMeeting, removeMeetingFiles } from './meetingProcessor.js'
import { createMeeting, dataDir, findDuplicateMeeting } from './meetingRepository.js'
import { maxVideoBytes, validateVideo, videoExtension, VideoValidationError } from './videoValidation.js'
import { downloadYandexVideo } from './yandexDisk.js'

const uploadDir = join(dataDir, 'tmp')
const upload = multer({
  storage: multer.diskStorage({ destination: (_request, _file, callback) => callback(null, uploadDir) }),
  limits: { fileSize: maxVideoBytes, files: 1, fields: 0, parts: 1 },
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

let uploadInProgress = false
let intakeStage = null

export function getIntakeStage() {
  return intakeStage
}

async function hashVideo(path, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

export async function prepareUploadDirectory() {
  await mkdir(uploadDir, { recursive: true })
  const files = await readdir(uploadDir, { withFileTypes: true })
  for (const file of files) {
    if (file.isFile() && /^[a-f0-9]{32}(\.mp3)?$/.test(file.name)) {
      await rm(join(uploadDir, file.name), { force: true })
    }
  }
}

export function handleVideoUpload(request, response) {
  if (!request.is('multipart/form-data')) {
    return response.status(400).json({ error: 'Загрузите файл в поле video формы multipart.' })
  }
  return acceptVideo(response, 'manual', async () => {
    await new Promise((done, reject) => {
      upload(request, response, error => {
        if (!error) return done()
        if (error.code || error instanceof VideoValidationError) return reject(error)
        return reject(new VideoValidationError(400, 'Не удалось прочитать форму загрузки.'))
      })
    })
    if (!request.file) {
      throw new VideoValidationError(400, 'Выберите видео для загрузки.')
    }
    return request.file
  })
}

export function handleYandexImport(request, response) {
  const path = join(uploadDir, randomBytes(16).toString('hex'))
  return acceptVideo(response, 'yandex_disk', signal =>
    downloadYandexVideo(request.body?.url, path, signal, findDuplicateMeeting))
}

async function acceptVideo(response, source, receiveVideo) {
  if (uploadInProgress) {
    return response.status(409).json({ error: 'Дождитесь завершения обработки предыдущего видео.' })
  }

  uploadInProgress = true
  intakeStage = source === 'manual' ? 'uploading' : 'downloading'
  const controller = new AbortController()
  const abort = () => controller.abort()
  response.once('close', abort)
  let accepted = false
  let file
  let failure

  try {
    file = await receiveVideo(controller.signal)
    if (file.duplicate) {
      if (!controller.signal.aborted) return response.json({ id: file.duplicate.id, duplicate: true })
      return
    }
    intakeStage = 'validating'
    const { durationSeconds } = await validateVideo(file, videoExtension(file.originalname), controller.signal)
    const videoHash = await hashVideo(file.path, controller.signal)
    if (controller.signal.aborted) return

    const duplicate = findDuplicateMeeting(videoHash)
    if (duplicate) {
      await removeMeetingFiles(file.path)
      file = null
      if (!controller.signal.aborted) return response.json({ id: duplicate.id, duplicate: true })
      return
    }

    const meeting = await createMeeting({
      filename: file.originalname,
      durationSeconds,
      source,
      videoHash,
      yandexResourceId: file.yandexResourceId,
    })
    accepted = true
    void processMeeting(meeting.id, file.path)
      .catch(error => console.error('Could not save meeting result:', error.code ?? error.name))
      .finally(() => { uploadInProgress = false })
    if (!controller.signal.aborted) return response.status(202).json({ id: meeting.id })
  } catch (error) {
    failure = error
  } finally {
    response.off('close', abort)
    intakeStage = null
    if (!accepted) {
      if (file?.path) await removeMeetingFiles(file.path)
      uploadInProgress = false
    }
  }

  if (controller.signal.aborted) return
  if (failure instanceof VideoValidationError) {
    return response.status(failure.status).json({ error: failure.message })
  }
  if (failure instanceof multer.MulterError) {
    if (failure.code === 'LIMIT_FILE_SIZE') {
      return response.status(413).json({ error: 'Размер видео превышает 750 МБ.' })
    }
    return response.status(400).json({ error: 'Загрузите один видеофайл в поле video.' })
  }
  console.error('Video upload failed:', failure.code ?? failure.name)
  return response.status(500).json({ error: 'Не удалось принять видео. Повторите попытку.' })
}
