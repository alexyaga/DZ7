import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { parseEnv } from 'node:util'

const settings = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {}
const backendPort = process.env.PORT ?? settings.PORT ?? '3001'
const backendUrl = `http://localhost:${backendPort}`
const frontendUrl = 'http://localhost:5173/'
const vitePath = 'node_modules/vite/bin/vite.js'

async function check(url, matches) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) })
    return response.ok && await matches(response)
  } catch {
    return false
  }
}

async function startService(name, args, isReady) {
  if (await isReady()) return

  const logPath = `${name}.log`
  const log = openSync(logPath, 'a')
  let child
  try {
    child = spawn(process.execPath, args, {
      windowsHide: true,
      detached: true,
      stdio: ['ignore', log, log],
    })
  } finally {
    closeSync(log)
  }

  let startupError
  child.once('error', error => { startupError = error })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await isReady()) {
      child.unref()
      return
    }
    if (startupError || child.exitCode !== null) break
    await delay(300)
  }

  child.kill()
  throw new Error(`${name} did not start. See ${logPath} in this folder.`)
}

try {
  if (!existsSync(vitePath)) {
    throw new Error('Dependencies are missing. Run pnpm.cmd install --frozen-lockfile and try again.')
  }
  await startService('backend', [
    '--use-system-ca', '--env-file-if-exists=.env', 'backend/src/server.js',
  ], () => check(`${backendUrl}/api/meetings`, async response => Array.isArray(await response.json())))
  await startService('frontend', [
    vitePath, '--config', 'frontend/vite.config.js',
  ], () => check(frontendUrl, async response => (await response.text()).includes('<title>AI Meeting Analyzer</title>')))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
