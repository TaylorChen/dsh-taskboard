/**
 * E2E v0.5 (L2 spec layer): a real model creates a task WITHOUT acceptance
 * criteria -> it lands in `draft`; the model then adds criteria and moves it
 * to `open`; the auto-claim driver claims it and dispatches a subagent that
 * settles the task.
 *
 * Same long-lived runner shape as full-chain.mjs (no one-shot headless exit).
 * Env: DSH_HOME, E2E_DSH_PACKAGE, E2E_APP_BOOT_PACKAGE, E2E_PROFILE.
 *
 * The acceptance criteria must be trivially completable by the subagent
 * (self-referential criteria made the child spin without producing output).
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

const TASK_TITLE = 'E2E v0.5 spec'
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 480_000)
const log = (line) => console.log(`[runner] ${line}`)
const find = (tb) => tb.list().find(t => t.title === TASK_TITLE)

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
log(`model: ${selection.provider}/${selection.model}`)

const followup = (text) => {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}
const waitFor = async (predicate, what) => {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  log(`TIMEOUT waiting for ${what}`)
  return false
}

// Turn 1: create the task WITHOUT acceptance criteria.
followup(
  `Use task_create to create a task titled '${TASK_TITLE}' on the task board. ` +
  'Do NOT provide acceptance_criteria, context_refs, or definition_of_done. ' +
  'Do not claim it. Then reply with the task key and its status.',
)
await agent.whenIdle()
const draftOk = await waitFor(() => {
  const t = find(taskboard)
  return t !== undefined && t.status === 'draft' && (t.spec?.acceptanceCriteria ?? []).length === 0
}, 'task in draft without criteria')
const afterTurn1 = find(taskboard)
log(`turn 1 -> ${afterTurn1?.key} status=${afterTurn1?.status} spec=${JSON.stringify(afterTurn1?.spec)}`)

// Turn 2: add criteria and move to open.
followup(
  `Use task_update on ${afterTurn1?.key ?? 'TB-1'} to set acceptance_criteria to ` +
  '["reply with exactly DONE-V05 and nothing else"] and move it to status open. ' +
  'Then reply with the task status.',
)
await agent.whenIdle()
const openOk = await waitFor(() => find(taskboard)?.status === 'open', 'task in open')
const afterTurn2 = find(taskboard)
log(`turn 2 -> ${afterTurn2?.key} status=${afterTurn2?.status} criteria=${JSON.stringify(afterTurn2?.spec?.acceptanceCriteria)}`)

// Phase 3: auto-claim + dispatch + settle (draft was never claimable).
let settled = false
if (openOk) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const t = find(taskboard)
    if (t !== undefined && t.status === 'in_progress') {
      // claimed
    } else if (t !== undefined && t.status !== 'in_progress' && t.status !== 'open') {
      settled = true
      log(`settled: ${t.key} -> ${t.status}`)
      break
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

for (const task of taskboard.list()) {
  console.log(`[board] ${task.key ?? task.id} | ${task.status} | ${task.title} | claimed: ${task.claimedBySessionId ?? '-'}`)
}
const t = find(taskboard)
if (t !== undefined) {
  console.log(`[activity ${t.key}] ` + taskboard.activityOf(t.id).map(a => `${a.action}(${a.from}->${a.to})`).join(' '))
}

await shutdown.shutdown(0)
const pass = draftOk && openOk && settled
console.log(pass ? 'E2E-V05-PASS' : 'E2E-V05-FAIL')
process.exit(pass ? 0 : 1)
