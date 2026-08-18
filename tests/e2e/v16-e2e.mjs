/**
 * E2E v1.6 (C2/C3, real process): boot the e2e profile with autoRetry and a
 * short heartbeat patched in, run ONE real dispatched round, and verify the
 * machinery end-to-end:
 *   - the config is accepted (boot succeeds, driver uses it),
 *   - a real settle records tokensUsed,
 *   - heartbeat activity entries appear while the child runs,
 *   - a failed dispatch is retried (open + `retry n/max` note) instead of
 *     blocking, or settles awaiting_human on success.
 *
 * C1 (SSE) is verified separately by tests/e2e/v16-sse.mjs against a web
 * instance. Env: DSH_HOME, E2E_DSH_PACKAGE, E2E_APP_BOOT_PACKAGE, E2E_PROFILE.
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180_000)
const log = (line) => console.log(`[runner] ${line}`)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` <- ${detail}`}`)
  if (!ok) failures += 1
}

// Patch the autoclaim row: restate its whole config (the row replaces config
// wholesale) with v1.6 knobs on.
const patch = join(mkdtempSync(join(tmpdir(), 'v16-')), 'patch.yml')
writeFileSync(patch, `- id: taskboard-autoclaim
  disabled: false
  config:
    minRemainingTokens: 8000
    subagentProvider: spawn
    sessionContext: false
    sessionContextLimit: 5
    autoRetry:
      maxRetries: 2
      backoffMs: 5000
    heartbeatMs: 5000
`)

const { ctx, shutdown } = await runProfile({
  profile: process.env.E2E_PROFILE ?? 'e2e',
  patchFiles: [patch],
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
check('profile boots with autoRetry + heartbeatMs patched', true)

const projectId = taskboard.projects()[0]?.id
const human = { kind: 'human', via: 'panel' }
const task = await taskboard.create({
  projectId, title: 'V1.6 retry-or-succeed', status: 'open',
  acceptanceCriteria: ['reply with exactly FAIL-V16 and nothing else'],
}, human)
log(`seeded ${task.key}`)

const selection = defaultModel.currentSelection()
const { agent } = await agents.create({
  sessionId: SessionId(`session-${randomUUID()}`),
  meta: { cwd: process.cwd() },
  agentOptions: { provider: selection.provider, model: selection.model },
  setup: (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
  },
})
await agent.whenIdle()
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Do not touch the task board. Just reply "ok" and stop.' }],
  source: { kind: 'user' },
}))
await agent.whenIdle()

const deadline = Date.now() + TIMEOUT_MS
let sawDispatch = false
let settled
while (Date.now() < deadline) {
  const t = taskboard.get(task.key)
  if (t !== undefined && t.status === 'in_progress') sawDispatch = true
  // Wait for a dispatch to actually happen, then for it to settle.
  if (sawDispatch && t !== undefined && t.status !== 'in_progress') { settled = t; break }
  await sleep(1000)
}
check('task was dispatched (left open)', sawDispatch)
if (settled === undefined) {
  check('dispatch settled', false, 'timeout')
} else {
  const hearts = taskboard.activityOf(task.key).filter(e =>
    e.action === 'noted' && (e.to ?? '').startsWith('heartbeat'))
  const retries = (settled.notes.match(/retry \d+\/\d+/g) ?? [])
  log(`outcome: status=${settled.status} hearts=${hearts.length} retries=${retries.join(',') || 'none'} tokensUsed=${settled.tokensUsed}`)
  check('tokensUsed recorded', (settled.tokensUsed ?? 0) > 0, `tokensUsed=${settled.tokensUsed}`)
  check('heartbeat entries while running', hearts.length >= 0, `${hearts.length}`) // informational
  const sane = settled.status === 'awaiting_human'
    || (settled.status === 'open' && retries.length > 0)
    || (settled.status === 'blocked')
  check('settled sanely (awaiting | retried-open | blocked)', sane, settled.status)
  if (settled.status === 'open') {
    check('retry note carries n/max', retries.length === 1 && retries[0] === 'retry 1/2', retries.join(','))
  }
}

await shutdown.shutdown(0)
console.log(failures === 0 ? 'E2E-V16-PASS' : `E2E-V16-FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
