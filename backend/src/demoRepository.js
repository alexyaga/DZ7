import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export const demoDataDir = resolve('data', 'public-demo')
const recordsDir = join(demoDataDir, 'meetings')
const videosDir = join(demoDataDir, 'videos')
const lifetimeMs = 7 * 24 * 60 * 60 * 1000
const idPattern = /^[a-f0-9-]{36}$/
const jobs = new Map()

export function demoVideoPath(id, extension) {
  return join(videosDir, `${id}.${extension}`)
}

export function getDemoJob(id) {
  const job = jobs.get(id)
  return job && Date.parse(job.expiresAt) > Date.now() ? job : undefined
}

export function listDemoJobs() {
  return [...jobs.values()]
    .filter(job => Date.parse(job.expiresAt) > Date.now())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function findDemoJobByLink(shareUrl) {
  return listDemoJobs().find(job => job.shareUrl === shareUrl
    && (job.status !== 'error' || typeof job.transcript === 'string'))
}

export async function saveDemoJob(job) {
  const snapshot = { ...job }
  await writeFileAtomic(join(recordsDir, job.id + '.json'), JSON.stringify(snapshot))
  jobs.set(job.id, snapshot)
}

export async function createDemoJob(job) {
  job.expiresAt = new Date(Date.parse(job.createdAt) + lifetimeMs).toISOString()
  await saveDemoJob(job)
}

export async function deleteDemoJob(job) {
  if (job.videoFormat) await rm(demoVideoPath(job.id, job.videoFormat), { force: true })
  await rm(join(recordsDir, job.id + '.json'), { force: true })
  jobs.delete(job.id)
}

async function removeExpiredJobs() {
  for (const job of jobs.values()) {
    if (job.status !== 'processing' && Date.parse(job.expiresAt) <= Date.now()) {
      try {
        await deleteDemoJob(job)
      } catch (error) {
        console.error('Could not remove expired demo meeting:', error.code ?? error.name)
      }
    }
  }
}

export async function initializeDemoJobs() {
  await mkdir(recordsDir, { recursive: true })
  await mkdir(videosDir, { recursive: true })
  for (const name of await readdir(recordsDir)) {
    const id = name.slice(0, -5)
    if (!name.endsWith('.json') || !idPattern.test(id)) continue
    const job = JSON.parse(await readFile(join(recordsDir, name), 'utf8'))
    if (job.id !== id || !Number.isFinite(Date.parse(job.expiresAt))
      || (job.videoFormat && !['mp4', 'webm'].includes(job.videoFormat))) {
      throw new Error('Invalid demo meeting file')
    }
    if (job.status === 'processing') {
      job.status = 'error'
      job.stage = null
      job.error = 'Обработка прервана перезапуском сервера.'
      await saveDemoJob(job)
    } else {
      jobs.set(id, job)
    }
  }
  await removeExpiredJobs()

  for (const name of await readdir(videosDir)) {
    const match = /^([a-f0-9-]{36})\.(mp4|webm)(\.mp3)?$/.exec(name)
    if (match && (match[3] || jobs.get(match[1])?.videoFormat !== match[2])) {
      await rm(join(videosDir, name), { force: true })
    }
  }

  setInterval(() => void removeExpiredJobs(), 60_000).unref()
}
