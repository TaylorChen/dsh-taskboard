/**
 * E2E v1.2 (governance): C1 — a done task archived via the service leaves the
 * active board (`list()`), is visible under `{ archived: true }`, and restores;
 * B2 — an open task with a tiny `contextBudgetTokens` is claimed by the
 * auto-claim driver but NEVER dispatched: it settles `blocked` with the
 * over-budget reason and no subagent execution is ever registered.
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

// ---- C1: soft archive round-trip over the real store ----
const toDone = await taskboard.create({
  projectId, title: 'E2E v1.2 archive-me', status: 'open',
  acceptanceCriteria: ['was done'],
}, human)
const done = await taskboard.update(toDone.key, { status: 'done' }, human)
log(`seeded ${done.key} (done, rev ${done.revision})`)

const archived = await taskboard.archive(done.key, true)
const activeIds = taskboard.list().map(task => task.id)
const archivedIds = taskboard.list({ archived: true }).map(task => task.id)
log(`after archive: active=${activeIds.includes(done.id)} archivedOnly=${archivedIds.includes(done.id)}`)
if (archived.archivedAt === null || activeIds.includes(done.id) || !archivedIds.includes(done.id)) {
  log('C1 archive FAIL: task must leave the active board and appear under archived=true')
  await shutdown.shutdown(1)
  process.exit(1)
}

const restored = await taskboard.archive(done.key, false)
const activeAfterRestore = taskboard.list().map(task => task.id)
log(`after restore: active=${activeAfterRestore.includes(done.id)} archivedAt=${restored.archivedAt}`)
if (restored.archivedAt !== null || !activeAfterRestore.includes(done.id)) {
  log('C1 restore FAIL: task must come back to the active board')
  await shutdown.shutdown(1)
  process.exit(1)
}
// Leave it archived again: the active board should hold only the B2 task.
await taskboard.archive(done.key, true)
log('C1 PASS (archive -> hidden -> restore -> visible; re-archived)')

// ---- B2: over-budget dispatch refusal ----
const over = await taskboard.create({
  projectId, title: 'E2E v1.2 over-budget', status: 'open',
  acceptanceCriteria: ['reply with exactly OK-V12 and nothing else'],
  contextBudgetTokens: 10, // any dispatch prompt is far larger than 10 tokens
}, human)
log(`seeded ${over.key} (open, contextBudgetTokens=10)`)

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

// The driver claims the over-budget task, refuses the dispatch, and settles
// it blocked — no subagent execution is ever registered.
const deadline = Date.now() + TIMEOUT_MS
let settled
while (Date.now() < deadline) {
  const t = taskboard.get(over.key)
  if (t !== undefined && t.status === 'blocked') { settled = t; break }
  await sleep(1000)
}
if (settled === undefined) {
  log('B2 FAIL: over-budget task never settled blocked')
  await shutdown.shutdown(1)
  process.exit(1)
}
const execution = taskboard.executionOf(over.key)
log(`over-budget task: status=${settled.status} reason=${settled.blockedReason}`)
log(`execution registered: ${execution === undefined ? 'none (refused before dispatch)' : execution.subagentId}`)
if (!settled.blockedReason.includes('over budget') || execution !== undefined) {
  log('B2 FAIL: must settle blocked with the over-budget reason and never dispatch')
  await shutdown.shutdown(1)
  process.exit(1)
}
log('B2 PASS (claimed -> refused -> blocked, no subagent)')

await shutdown.shutdown(0)
console.log('E2E-V12-PASS')
process.exit(0)
