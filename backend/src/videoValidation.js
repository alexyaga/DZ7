import { execFile } from 'node:child_process'
import { extname } from 'node:path'
import { promisify } from 'node:util'
import { fileTypeFromFile } from 'file-type'

const exec = promisify(execFile)
export const maxVideoBytes = 750_000_000
const maxVideoSeconds = 30 * 60

export class VideoValidationError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function videoExtension(filename) {
  const extension = extname(filename).slice(1).toLowerCase()
  if (extension !== 'mp4' && extension !== 'webm') {
    throw new VideoValidationError(415, 'Выберите видео в формате MP4 или WebM.')
  }
  return extension
}

export async function validateVideo(file, extension, signal) {
  if (file.size === 0) {
    throw new VideoValidationError(422, 'Файл пуст.')
  }

  const type = await fileTypeFromFile(file.path)
  if (type?.ext !== extension) {
    throw new VideoValidationError(415, 'Содержимое файла не соответствует формату MP4 или WebM.')
  }

  let metadata
  try {
    const { stdout } = await exec(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error',
      '-protocol_whitelist', 'file',
      '-f', extension === 'mp4' ? 'mov' : 'matroska',
      '-show_entries', 'format=duration:stream=codec_type:stream_disposition=attached_pic',
      '-of', 'json',
      file.path,
    ], { timeout: 30_000, windowsHide: true, signal })
    metadata = JSON.parse(stdout)
  } catch (error) {
    if (signal.aborted) throw error
    if (error.code === 'ENOENT' || error.code === 'EACCES') {
      throw new VideoValidationError(503, 'На сервере недоступен ffprobe. Проверьте установку FFmpeg.')
    }
    throw new VideoValidationError(422, 'Не удалось прочитать видео. Проверьте, что файл открывается в плеере.')
  }

  const streams = metadata.streams ?? []
  if (!streams.some(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)) {
    throw new VideoValidationError(422, 'В файле нет видеодорожки.')
  }
  if (!streams.some(stream => stream.codec_type === 'audio')) {
    throw new VideoValidationError(422, 'В видео нет аудиодорожки.')
  }

  const durationSeconds = Number(metadata.format?.duration)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new VideoValidationError(422, 'Не удалось определить длительность видео.')
  }
  if (durationSeconds > maxVideoSeconds) {
    throw new VideoValidationError(422, 'Длительность видео превышает 30 минут.')
  }

  return { format: extension, durationSeconds, sizeBytes: file.size }
}
