/**
 * E2E v0.7 (L4 dependencies & scheduling): seed B (open) and A (open,
 * dependsOn B). A trivial model turn goes idle; the auto-claim driver must
 * claim ONLY B (A waits on its unfinished dependency). After the runner
 * confirms B done, the next idle event must claim A.
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

const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 480_000)
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
const b = await taskboard.create({
  projectId, title: 'E2E v0.7 dep B', status: 'open',
  acceptanceCriteria: ['reply with exactly DEP-B and nothing else'],
}, human)
const a = await taskboard.create({
  projectId, title: 'E2E v0.7 worker A', status: 'open',
  acceptanceCriteria: ['reply with exactly DEP-A and nothing else'],
  dependsOn: [b.key],
}, human)
log(`seeded ${b.key} (B) and ${a.key} (A depends on ${b.key})`)

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
log('turn 1 done; B should be claimed, A must wait…')

// Wait until B is claimed (in_progress) and dispatched/settled.
const deadline1 = Date.now() + TIMEOUT_MS
let bClaimed = false
while (Date.now() < deadline1) {
  const current = taskboard.get(b.key)
  if (current !== undefined && current.status !== 'open') { bClaimed = true; break }
  await sleep(1000)
}
const bNow = taskboard.get(b.key)
const aAfterTurn1 = taskboard.get(a.key)
log(`after turn 1: B=${bNow?.status} A=${aAfterTurn1?.status} claimed=${aAfterTurn1?.claimedBySessionId ?? '-'}`)
const gated = bClaimed && aAfterTurn1?.status === 'open' && aAfterTurn1?.claimedBySessionId === null

// Confirm B done, then a fresh idle event should let the driver claim A.
await taskboard.update(b.key, { status: 'done' }, human)
log(`confirmed ${b.key} done`)
await sleep(1500) // the claim driver re-arms on the next idle transition

// Give the driver another idle signal: it listens to agent/status; a second
// trivial follow-up turn produces one.
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Say "again" and stop. Do not touch the board.' }],
  source: { kind: 'user' },
}))
await agent.whenIdle()

const deadline2 = Date.now() + TIMEOUT_MS
let aClaimed = false
while (Date.now() < deadline2) {
  const current = taskboard.get(a.key)
  if (current !== undefined && current.claimedBySessionId !== null) { aClaimed = true; break }
  await sleep(1000)
}
const aFinal = taskboard.get(a.key)
log(`after B done: A=${aFinal?.status} claimed=${aFinal?.claimedBySessionId ?? '-'}`)

await shutdown.shutdown(0)
const pass = gated && aClaimed && aFinal?.claimedBySessionId !== null
console.log(pass ? 'E2E-V07-PASS' : 'E2E-V07-FAIL')
process.exit(pass ? 0 : 1)
