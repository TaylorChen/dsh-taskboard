/**
 * E2E v0.9 full verification (executor + dueAt + notes) in one real process:
 * 1. A real model appends a note via task_update -> notes appended + a
 *    'noted' activity entry lands.
 * 2. Auto-claim must pick the EARLIEST-due agent task (A), skipping the
 *    later-due (B), the undated (C), and the human-executor task.
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

const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 240_000)
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
const now = Date.now()
const humanTask = await taskboard.create({
  projectId, title: 'V09 human', status: 'open', executor: 'human',
  acceptanceCriteria: ['human decision'], notes: 'for the human',
}, human)
const taskA = await taskboard.create({
  projectId, title: 'V09 agent A', status: 'open', executor: 'agent',
  acceptanceCriteria: ['reply A'], dueAt: now + 60_000,
}, human)
const taskB = await taskboard.create({
  projectId, title: 'V09 agent B', status: 'open', executor: 'agent',
  acceptanceCriteria: ['reply B'], dueAt: now + 86_400_000,
}, human)
const taskC = await taskboard.create({
  projectId, title: 'V09 agent C', status: 'open', executor: 'agent',
  acceptanceCriteria: ['reply C'],
}, human)
log(`seeded: ${humanTask.key}(human) ${taskA.key}(due soon) ${taskB.key}(due later) ${taskC.key}(undated)`)

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

// Turn 1: the model appends a note through the real tool path.
agent.followup(createUserMessage({
  content: [{
    type: 'text',
    text: `Use task_update on ${taskB.key} to append the note "model-note-v09" (parameter note). Do not change anything else. Then reply "done".`,
  }],
  source: { kind: 'user' },
}))
await agent.whenIdle()
const bAfterNote = taskboard.get(taskB.key)
const noted = bAfterNote?.notes.includes('model-note-v09') === true
  && taskboard.activityOf(taskB.id).some(entry => entry.action === 'noted')
log(`model appended note: ${noted} (notes=${JSON.stringify(bAfterNote?.notes)})`)

// Turn 2: trivial; idle triggers auto-claim with dueAt ordering.
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Do not touch the task board at all. Just reply "done" and stop.' }],
  source: { kind: 'user' },
}))
await agent.whenIdle()
log('waiting for auto-claim (earliest due should win)…')

const deadline = Date.now() + TIMEOUT_MS
let aClaimed = false
while (Date.now() < deadline) {
  const t = taskboard.get(taskA.key)
  if (t !== undefined && t.claimedBySessionId !== null) { aClaimed = true; break }
  await sleep(1000)
}
const show = (t) => `${t?.status} claimed=${t?.claimedBySessionId ?? '-'}`
const bFinal = taskboard.get(taskB.key)
const cFinal = taskboard.get(taskC.key)
const hFinal = taskboard.get(humanTask.key)
log(`A: ${show(taskboard.get(taskA.key))}`)
log(`B: ${show(bFinal)}`)
log(`C: ${show(cFinal)}`)
log(`human: ${show(hFinal)}`)

const pass = noted
  && aClaimed
  && bFinal?.claimedBySessionId === null
  && cFinal?.claimedBySessionId === null
  && hFinal?.claimedBySessionId === null

await shutdown.shutdown(0)
console.log(pass ? 'E2E-V09-FULL-PASS' : 'E2E-V09-FULL-FAIL')
process.exit(pass ? 0 : 1)
