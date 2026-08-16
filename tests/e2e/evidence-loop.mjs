/**
 * E2E v0.6 (L3 verification loop): seed an open task WITH acceptance criteria,
 * drive one trivial model turn, and let the auto-claim driver dispatch a
 * subagent that MUST produce a structured report (outputSchema). Assert the
 * task settles to awaiting_human WITH evidence: per-criterion self-assessment,
 * artifacts, summary.
 *
 * Same long-lived runner shape as full-chain.mjs. Env: DSH_HOME,
 * E2E_DSH_PACKAGE, E2E_APP_BOOT_PACKAGE, E2E_PROFILE. Run from the
 * package directory (or set NODE_PATH) so @deepseek-ai resolves.
 *
 * The acceptance criterion must be trivially completable by the subagent, or
 * the child spins without producing a structured report.
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

const TASK_TITLE = 'E2E v0.6 evidence'
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 480_000)
const log = (line) => console.log(`[runner] ${line}`)

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
if (projectId === undefined) {
  console.error('[runner] no project')
  await shutdown.shutdown(1)
  process.exit(1)
}
const seeded = await taskboard.create({
  projectId,
  title: TASK_TITLE,
  status: 'open',
  acceptanceCriteria: ['reply with exactly DONE-V06 and nothing else'],
}, { kind: 'human', via: 'panel' })
log(`seeded ${seeded.key} (${seeded.status}, criteria: 1)`)

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

agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Do not touch the task board at all. Just reply "done" and stop.' }],
  source: { kind: 'user' },
}))
await agent.whenIdle()
log('turn 1 done; waiting for claim -> dispatch -> structured report -> settle…')

const deadline = Date.now() + TIMEOUT_MS
let settled = null
let phase = 'none'
while (Date.now() < deadline) {
  const task = taskboard.list().find(t => t.title === TASK_TITLE)
  if (task === undefined) phase = 'created'
  else if (task.status === 'in_progress') phase = 'claimed'
  else if (phase === 'claimed' || phase === 'dispatched') {
    phase = 'settled'
    settled = task
    break
  }
  await new Promise(resolve => setTimeout(resolve, 1000))
}

let pass = false
if (settled !== null) {
  const evidence = taskboard.evidenceOf(settled.id)
  log(`settled: ${settled.key} -> ${settled.status}`)
  log(`evidence: ${JSON.stringify(evidence)}`)
  pass = settled.status === 'awaiting_human'
    && evidence !== null
    && evidence.criteria.length === 1
    && evidence.criteria[0]?.criterion.includes('DONE-V06')
    && evidence.criteria[0]?.met === true
}
if (!pass) log(`chain stalled at phase '${phase}'`)

await shutdown.shutdown(0)
console.log(pass ? 'E2E-V06-PASS' : 'E2E-V06-FAIL')
process.exit(pass ? 0 : 1)
