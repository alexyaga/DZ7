import { readFile } from 'node:fs/promises'
import OpenAI from 'openai'

export class TranscriptionError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function transcribeAudio(audioPath, { signal } = {}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new TranscriptionError(503, 'Укажите OPENAI_API_KEY в локальном .env и перезапустите backend.')
  }

  const model = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe'
  const client = new OpenAI({ apiKey, timeout: 180_000, maxRetries: 0 })
  const audio = await readFile(audioPath, { signal })
  const file = new File([audio], 'recording.mp3', { type: 'audio/mpeg' })
  let result

  try {
    result = await client.audio.transcriptions.create({
      file,
      model,
      language: 'ru',
      response_format: 'json',
      chunking_strategy: 'auto',
    }, { signal })
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof OpenAI.APIConnectionTimeoutError) {
      throw new TranscriptionError(504, 'OpenAI не ответил вовремя. Расшифровка прервана.')
    }
    if (error instanceof OpenAI.APIConnectionError) {
      throw new TranscriptionError(502, 'Не удалось подключиться к OpenAI. Проверьте соединение.')
    }
    if (error.status === 401 || error.status === 403) {
      throw new TranscriptionError(503, 'OpenAI отклонил доступ. Проверьте ключ и права проекта.')
    }
    if (error.status === 429) {
      const message = error.code === 'insufficient_quota'
        ? 'Квота OpenAI исчерпана. Проверьте баланс и лимиты проекта.'
        : 'OpenAI ограничил частоту запросов. Попробуйте позже.'
      throw new TranscriptionError(429, message)
    }
    if (error.status === 413) {
      throw new TranscriptionError(413, 'OpenAI отклонил аудиофайл из-за размера.')
    }
    if (error.status === 404) {
      throw new TranscriptionError(503, 'Модель транскрибации недоступна. Проверьте OPENAI_TRANSCRIPTION_MODEL.')
    }
    throw new TranscriptionError(502, 'OpenAI не удалось расшифровать аудио.')
  }

  if (typeof result?.text !== 'string') {
    throw new TranscriptionError(502, 'OpenAI вернул ответ без текста расшифровки.')
  }
  return result.text
}
