/**
 * E2E v1.1 (A1/A2 stop-loss): a dispatched subagent is visible via
 * `executionOf`; when a human moves the task out of in_progress, the driver
 * cancels it and a late child result never double-settles the task.
 *
 * Same long-lived runner shape as full-chain.mjs. Env: DSH_HOME,
 * E2E_DSH_PACKAGE, E2E_APP_BOOT_PACKAGE, E2E_PROFILE.
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

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

const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 120_000)
const log = (line) => console.log(`[runner] ${line}`)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

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

const projectId = taskboard.projects()[0]?.id
const human = { kind: 'human', via: 'panel' }
const task = await taskboard.create({
  projectId, title: 'E2E v1.1 cancel', status: 'open',
  acceptanceCriteria: ['reply with exactly DONE-V11 and nothing else'],
}, human)
log(`seeded ${task.key} (open)`)

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
  content: [{ type: 'text', text: 'Do not touch the task board at all. Just reply "done" and stop.' }],
  source: { kind: 'user' },
}))
await agent.whenIdle()

// Wait until the dispatch is visible (A2).
const deadline = Date.now() + TIMEOUT_MS
let visible = false
while (Date.now() < deadline) {
  const info = taskboard.executionOf(task.id)
  if (info !== undefined) { visible = true; break }
  await sleep(500)
}
log(`dispatch visible via executionOf: ${visible}${visible ? ` (subagent ${taskboard.executionOf(task.id)?.subagentId})` : ''}`)

// Human takes the task over: move it out of in_progress.
await taskboard.update(task.id, { status: 'done' }, human)
log('human moved task to done; waiting for cancellation…')
await sleep(3000)

const after = taskboard.get(task.id)
const stillVisible = taskboard.executionOf(task.id) !== undefined
log(`after takeover: status=${after?.status} executionVisible=${stillVisible}`)

// Give a late child result time to (try to) settle; the task must stay done.
await sleep(8000)
const final = taskboard.get(task.id)
const finalVisible = taskboard.executionOf(task.id) !== undefined
log(`after settle window: status=${final?.status} executionVisible=${finalVisible}`)

await shutdown.shutdown(0)
const pass = visible
  && after?.status === 'done'
  && !stillVisible
  && final?.status === 'done'
  && !finalVisible
console.log(pass ? 'E2E-V11-PASS' : 'E2E-V11-FAIL')
process.exit(pass ? 0 : 1)
