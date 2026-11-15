import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'

const maxAudioBytes = 25_000_000

export class AudioExtractionError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// The caller owns the temporary output and removes it after use or failure.
export async function extractAudio(videoPath, audioPath, { signal, timeoutMs = 120_000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs)
  const conversionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const processHandle = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'info', '-nostats', '-xerror', '-n',
    '-abort_on', 'empty_output',
    '-protocol_whitelist', 'file',
    '-i', videoPath,
    '-map', '0:a:0',
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000',
    '-af', 'aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono,volumedetect',
    '-c:a', 'libmp3lame', '-b:a', '64k',
    '-map_metadata', '-1',
    '-f', 'mp3', audioPath,
  ], { windowsHide: true, signal: conversionSignal, stdio: ['ignore', 'ignore', 'pipe'] })

  let diagnostics = ''
  processHandle.stderr.setEncoding('utf8')
  processHandle.stderr.on('data', chunk => {
    diagnostics = (diagnostics + chunk).slice(-8192)
  })

  // Wait for FFmpeg to close its file handles before the caller cleans up on Windows.
  let processError
  processHandle.once('error', error => { processError = error })
  const exitCode = await new Promise(resolve => processHandle.once('close', resolve))

  signal?.throwIfAborted()
  if (processError || exitCode !== 0) {
    if (processError?.code === 'ENOENT' || processError?.code === 'EACCES') {
      throw new AudioExtractionError(503, 'На сервере недоступен FFmpeg. Проверьте FFMPEG_PATH.')
    }
    if (deadline.aborted) {
      throw new AudioExtractionError(504, 'Истекло время извлечения аудио. Попробуйте более короткую запись.')
    }
    throw new AudioExtractionError(422, 'Не удалось извлечь аудио. Проверьте целостность записи и её аудиодорожку.')
  }

  const audio = await stat(audioPath)
  if (!audio.isFile() || audio.size === 0) {
    throw new AudioExtractionError(422, 'После обработки получился пустой аудиофайл.')
  }
  if (audio.size > maxAudioBytes) {
    throw new AudioExtractionError(413, 'Размер извлечённого аудио превышает 25 МБ.')
  }
  const peak = diagnostics.match(/^\[Parsed_volumedetect_\d+ @ [^\]\r\n]+\] max_volume:\s+(-?\d+(?:\.\d+)?) dB/m)
  const isSilent = Boolean(peak && Number(peak[1]) <= -90)
  return { format: 'mp3', sizeBytes: audio.size, isSilent }
}
