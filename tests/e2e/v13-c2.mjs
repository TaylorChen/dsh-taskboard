/**
 * E2E v1.3 C2 (cross-process write safety): another process rewrites the JSON
 * unit file while this process holds its snapshot; the next write must be
 * refused with `concurrent-modification` instead of silently clobbering the
 * other process's changes. Restoring the file to the snapshot lets the write
 * through again.
 *
 * Same long-lived runner shape as full-chain.mjs. Env: DSH_HOME,
 * E2E_DSH_PACKAGE, E2E_APP_BOOT_PACKAGE, E2E_PROFILE.
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dshPackage = process.env.E2E_DSH_PACKAGE
const appBootPackage = process.env.E2E_APP_BOOT_PACKAGE
if (dshPackage === undefined || appBootPackage === undefined) {
  console.error('[runner] set E2E_DSH_PACKAGE and E2E_APP_BOOT_PACKAGE')
  process.exit(2)
}
const { runProfile } = await import(`${dshPackage}/lib/profile-boot-BnJoK_kl.js`)
const { loadLayeredEnv } = await import(`${appBootPackage}/lib/index.js`)

const require = createRequire(import.meta.url)
const { installModelSelection } = require('@deepseek-ai/dsh-agent')
const { createUserMessage } = require('@deepseek-ai/dsh-llm')
const { SessionId } = require('@deepseek-ai/dsh-session')

const log = (line) => console.log(`[runner] ${line}`)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

process.on('unhandledRejection', (reason) => {
  console.error(`[runner] UNHANDLED REJECTION: ${reason instanceof Error ? `${reason.message} @ ${reason.stack?.split('\n').slice(1, 4).join(' | ')}` : String(reason)}`)
})
process.on('uncaughtException', (error) => {
  console.error(`[runner] UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}`)
  process.exit(3)
})

const { ctx, shutdown } = await runProfile({
  profile: process.env.E2E_PROFILE ?? 'e2e',
  patchFiles: [],
  args: [],
  environment: loadLayeredEnv('dsh'),
})
const agents = ctx.get('agents')
const defaultModel = ctx.get('agentDefaultModel')
const taskboard = ctx.get('taskboard')
if (agents === undefined || defaultModel === undefined || taskboard === undefined) {
  console.error('[runner] missing services')
  await shutdown.shutdown(1)
  process.exit(1)
}

const home = process.env.DSH_HOME
if (home === undefined) {
  console.error('[runner] DSH_HOME is required to locate the medium file')
  await shutdown.shutdown(1)
  process.exit(1)
}
const mediumPath = join(home, 'storages', 'taskboard.json')
const projectId = taskboard.projects()[0]?.id
const human = { kind: 'human', via: 'panel' }

// ---- C2: simulate another process's write ----
const original = readFileSync(mediumPath, 'utf8')
const edited = JSON.parse(original)
edited.global = { ...edited.global, nextTaskNumber: (edited.global?.nextTaskNumber ?? 1) + 1 }
writeFileSync(mediumPath, JSON.stringify(edited, null, 2))
log('C2: rewrote the medium as "another process" (global counter advanced)')

let refused = false
try {
  await taskboard.create({
    projectId, title: 'E2E v1.3 clobber probe', status: 'open',
    acceptanceCriteria: ['never created'],
  }, human)
} catch (error) {
  refused = error instanceof Error && error.code === 'concurrent-modification'
  log(`C2: create refused with concurrent-modification: ${refused}`)
}
if (!refused) {
  log('C2 FAIL: a stale-snapshot write must be refused, not silently applied')
  await shutdown.shutdown(1)
  process.exit(1)
}

// Restore the medium to the snapshot; the same write now succeeds.
log('C2: restoring the medium…')
writeFileSync(mediumPath, original)
log('C2: medium restored, creating again…')

let restored
try {
  restored = await taskboard.create({
    projectId, title: 'E2E v1.3 after restore', status: 'open',
    acceptanceCriteria: ['created after restore'],
  }, human)
} catch (error) {
  log(`C2: second create ALSO failed: ${error instanceof Error ? error.message : String(error)}`)
  await shutdown.shutdown(1)
  process.exit(1)
}
log(`C2: after restoring the medium, create succeeds -> ${restored.key}`)
if (restored.key === undefined) {
  log('C2 FAIL: restored write did not land')
  await shutdown.shutdown(1)
  process.exit(1)
}
log('C2 PASS (stale write refused; restored write lands)')

// Keep the process alive briefly so the write chain fully drains, then exit.
await sleep(500)
await shutdown.shutdown(0)
console.log('E2E-V13-C2-PASS')
process.exit(0)
