/**
 * Real end-to-end of the v0.4 full chain: seed an open task -> auto-claim
 * driver claims it on idle -> dispatches a background subagent (real model
 * child session) -> run.result settles the task to awaiting_human/blocked.
 *
 * Why a custom runner instead of `dsh --profile headless`: the headless
 * launcher is one-shot — it exits right after the first turn, which cuts the
 * post-idle chain (claim lands, dispatch/settle never run; the subagent dies
 * with the parent). This runner boots a profile WITHOUT the headless runner
 * and keeps the process alive until the task settles.
 *
 * Environment:
 *   DSH_HOME            the throwaway home (must contain profiles/e2e below)
 *   E2E_DSH_PACKAGE     dir of the @deepseek-ai/dsh package (runProfile)
 *   E2E_APP_BOOT_PACKAGE dir of @deepseek-ai/dsh-app-boot (loadLayeredEnv)
 *   E2E_PROFILE         profile name to boot (default 'e2e')
 *   DEEPSEEK_API_KEY    the model credential (via the home's credentials)
 *
 * Usage:
 *   DSH_HOME=/tmp/x E2E_DSH_PACKAGE=…/node_modules/@deepseek-ai/dsh \
 *   E2E_APP_BOOT_PACKAGE=…/node_modules/@deepseek-ai/dsh-app-boot \
 *   node tests/e2e/full-chain.mjs
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

const PROFILE = process.env.E2E_PROFILE ?? 'e2e'
const TASK_TITLE = process.env.E2E_TASK_TITLE ?? 'E2E v0.4 full chain'
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 240_000)
const log = (line) => console.log(`[runner] ${line}`)

const { ctx, shutdown } = await runProfile({
  profile: PROFILE,
  patchFiles: [],
  args: [],
  environment: loadLayeredEnv('dsh'),
})

const agents = ctx.get('agents')
const defaultModel = ctx.get('agentDefaultModel')
const taskboard = ctx.get('taskboard')
if (agents === undefined || defaultModel === undefined || taskboard === undefined) {
  console.error('[runner] missing services (agents/defaultModel/taskboard)')
  await shutdown.shutdown(1)
  process.exit(1)
}

// Seed an open task directly (human actor), so the model's turn stays trivial
// and the auto-claim chain is the only thing touching the board.
const projectId = taskboard.projects()[0]?.id
if (projectId === undefined) {
  console.error('[runner] no project seeded')
  await shutdown.shutdown(1)
  process.exit(1)
}
const seeded = await taskboard.create(
  { projectId, title: TASK_TITLE, status: 'open' },
  { kind: 'human', via: 'panel' },
)
log(`seeded ${seeded.key} (${seeded.status})`)

const selection = defaultModel.currentSelection()
log(`model: ${selection.provider}/${selection.model}`)
const { agent } = await agents.create({
  sessionId: SessionId(`session-${randomUUID()}`),
  meta: { cwd: process.cwd() },
  agentOptions: { provider: selection.provider, model: selection.model },
  setup: (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
  },
})
await agent.whenIdle()
log(`agent ready: ${agent.id}`)

// Turn 1: the model does nothing on the board, then goes idle. The auto-claim
// driver should claim the seeded open task and dispatch a subagent.
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Do not touch the task board at all. Just reply "done" and stop.' }],
  source: { kind: 'user' },
}))
await agent.whenIdle()
log('turn 1 done; waiting for auto-claim -> subagent -> settle…')

// Phase A: the task exists. Phase B: it is claimed (in_progress). Phase C:
// it settles (leaves in_progress). Track the phase the chain reached.
const deadline = Date.now() + TIMEOUT_MS
let phase = 'none'
while (Date.now() < deadline) {
  const task = taskboard.list().find(t => t.title === TASK_TITLE)
  if (task === undefined) {
    phase = 'created'
  } else if (task.status === 'in_progress') {
    phase = 'claimed'
  } else if (phase === 'claimed') {
    phase = 'settled'
    log(`settled: ${task.key} -> ${task.status}${task.blockedReason === null ? '' : ` (${task.blockedReason})`}`)
    break
  }
  await new Promise(resolve => setTimeout(resolve, 1000))
}
if (phase !== 'settled') {
  const task = taskboard.list().find(t => t.title === TASK_TITLE)
  log(`chain stalled at phase '${phase}'; last state: ${task === undefined ? 'no task' : `${task.key} ${task.status}`}`)
}

for (const task of taskboard.list()) {
  console.log(`[board] ${task.key ?? task.id} | ${task.status} | ${task.title} | claimed: ${task.claimedBySessionId ?? '-'}`)
}
for (const task of taskboard.list().filter(t => t.title === TASK_TITLE)) {
  console.log(`[activity ${task.key}] ` + taskboard.activityOf(task.id).map(a => `${a.action}(${a.from}->${a.to})`).join(' '))
}

await shutdown.shutdown(0)
console.log(phase === 'settled' ? 'E2E-V04-PASS' : 'E2E-V04-TIMEOUT')
process.exit(phase === 'settled' ? 0 : 1)
