import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { summarySchema } from './summaryService.js'

export const dataDir = resolve(process.env.DATA_DIR || './data')
const historyPath = join(dataDir, 'meetings.json')
const historySchema = z.array(z.object({
  id: z.uuid(),
  filename: z.string(),
  createdAt: z.iso.datetime(),
  source: z.enum(['manual', 'yandex_disk']),
  durationSeconds: z.number().positive(),
  status: z.enum(['processing', 'completed', 'error']),
  stage: z.enum(['extracting', 'transcribing', 'summarizing']).nullable().optional(),
  videoHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  yandexResourceId: z.string().optional(),
  transcript: z.string().nullable(),
  summary: summarySchema.nullable(),
  error: z.string().nullable(),
}))
let meetings = []
let pendingWrite = Promise.resolve()

function commit(change) {
  const operation = pendingWrite.then(async () => {
    const next = change(meetings)
    if (next === meetings) return false
    await writeFileAtomic(historyPath, JSON.stringify(next, null, 2) + '\n')
    meetings = next
    return true
  })
  pendingWrite = operation.catch(() => {})
  return operation
}

export async function initializeMeetings() {
  await mkdir(dataDir, { recursive: true })
  try {
    meetings = JSON.parse(await readFile(historyPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    if (error instanceof SyntaxError) throw new Error('Не удалось прочитать JSON истории встреч.')
    throw error
  }

  if (!historySchema.safeParse(meetings).success) {
    throw new Error('Файл истории имеет неверную структуру.')
  }
  if (meetings.some(meeting => meeting.status === 'processing')) {
    await commit(current => current.map(meeting => meeting.status === 'processing'
      ? { ...meeting, status: 'error', stage: null, error: 'Обработка прервана перезапуском сервера.' }
      : meeting))
  }
}

export async function createMeeting({ filename, durationSeconds, source, videoHash, yandexResourceId }) {
  const meeting = {
    id: randomUUID(),
    filename,
    createdAt: new Date().toISOString(),
    source,
    durationSeconds,
    status: 'processing',
    stage: 'extracting',
    videoHash,
    yandexResourceId,
    transcript: null,
    summary: null,
    error: null,
  }
  await commit(current => [meeting, ...current])
  return meeting
}

export function updateMeeting(id, changes) {
  return commit(current => {
    const index = current.findIndex(meeting => meeting.id === id)
    if (index === -1) throw new Error('Meeting not found')
    return current.with(index, { ...current[index], ...changes })
  })
}

export function deleteMeeting(id) {
  return commit(current => {
    const index = current.findIndex(meeting => meeting.id === id)
    if (index === -1) return current
    if (current[index].status === 'processing') return current
    return current.toSpliced(index, 1)
  })
}

export function listMeetings() {
  return meetings.map(({ id, filename, createdAt, source, status, stage, durationSeconds }) => ({
    id, filename, createdAt, source, status, stage, durationSeconds,
  }))
}

export function findDuplicateMeeting(videoHash, yandexResourceId) {
  return meetings.find(meeting =>
    (meeting.status === 'completed' || (meeting.status === 'error' && meeting.transcript !== null))
    && meeting.videoHash === videoHash
    && (!yandexResourceId || meeting.yandexResourceId === yandexResourceId),
  )
}

export function getMeeting(id) {
  return meetings.find(meeting => meeting.id === id)
}
