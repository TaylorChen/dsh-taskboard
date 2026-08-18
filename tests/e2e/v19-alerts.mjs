/**
 * E2E v1.9 G4 (proactive alerts): boot with a webhook + a tiny dispatch
 * timeout, dispatch a real task so it times out, and verify the sink receives
 * a `taskboard.alert` (kind=timeout) whose signature validates — while a
 * normally completed task triggers no alert.
 *
 * Env: DSH_HOME, E2E_DSH_PACKAGE, E2E_APP_BOOT_PACKAGE, E2E_PROFILE.
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
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

const log = (line) => console.log(`[runner] ${line}`)
let failures = 0
const check = (name, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` <- ${detail}`}`)
  if (!ok) failures += 1
}

const hits = []
const sink = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
    hits.push({ body, timestamp: req.headers['x-taskboard-timestamp'], signature: req.headers['x-taskboard-signature'] })
  })
})
sink.listen(0, '127.0.0.1')
sink.unref()
const port = await new Promise(resolve => sink.on('listening', () => resolve(sink.address().port)))

const SECRET = 'v19-secret'
const patch = join(mkdtempSync(join(tmpdir(), 'v19-')), 'patch.yml')
writeFileSync(patch, `- id: taskboard
  config:
    writePolicy: auto
    webhook:
      url: http://127.0.0.1:${port}/hook
      secret: ${SECRET}
- id: taskboard-autoclaim
  disabled: false
  config:
    minRemainingTokens: 8000
    subagentProvider: spawn
    sessionContext: false
    sessionContextLimit: 5
    autoRetry:
      maxRetries: 0
      backoffMs: 0
    heartbeatMs: 0
    staleClaimMinutes: 0
    dispatchTimeoutMs: 800
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
  process.exit(1)
}
const projectId = taskboard.projects()[0]?.id
const human = { kind: 'human', via: 'panel' }
const task = await taskboard.create({
  projectId, title: 'V1.9 alert probe', status: 'open',
  acceptanceCriteria: ['reply with exactly OK-V19 and nothing else'],
}, human)

const selection = defaultModel.currentSelection()
const { agent } = await agents.create({
  sessionId: SessionId(`session-${randomUUID()}`),
  meta: { cwd: process.cwd() },
  agentOptions: { provider: selection.provider, model: selection.model },
  setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: undefined }) },
})
await agent.whenIdle()
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Do not touch the task board. Just reply "ok" and stop.' }],
  source: { kind: 'user' },
}))
await agent.whenIdle()

// The 800ms dispatch timeout deterministically settles the task blocked with
// an alert before the child can finish.
const deadline = Date.now() + 30_000
let sawDispatch = false
let settled
while (Date.now() < deadline) {
  const t = taskboard.get(task.key)
  if (t !== undefined && t.status === 'in_progress') sawDispatch = true
  if (sawDispatch && t !== undefined && t.status !== 'in_progress') { settled = t; break }
  await new Promise(resolve => setTimeout(resolve, 500))
}
check('task was dispatched', sawDispatch)
if (settled === undefined) {
  check('task settled', false, 'timeout waiting')
} else {
  check('task settled blocked (timeout)', settled.status === 'blocked', `status=${settled.status} reason=${settled.blockedReason}`)
}

// Give the webhook a moment to deliver, then find the alert.
await new Promise(resolve => setTimeout(resolve, 2000))
const alertHit = hits.find(hit => {
  try { return JSON.parse(hit.body).event === 'taskboard.alert' } catch { return false }
})
if (alertHit === undefined) {
  check('alert delivered', false, `hits=${hits.map(h => { try { return JSON.parse(h.body).event } catch { return '?' } }).join(',')}`)
} else {
  check('alert delivered (taskboard.alert)', true)
  const parsed = JSON.parse(alertHit.body)
  check('alert kind=timeout', parsed.kind === 'timeout', parsed.kind)
  check('alert carries the task key', parsed.taskKey === (task.key ?? task.id), parsed.taskKey)
  const expected = createHmac('sha256', SECRET).update(`${alertHit.timestamp}.${alertHit.body}`).digest('hex')
  check('alert signature verifies', alertHit.signature === `sha256=${expected}`)
}

await shutdown.shutdown(0)
console.log(failures === 0 ? 'E2E-V19-ALERTS-PASS' : `E2E-V19-ALERTS-FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
