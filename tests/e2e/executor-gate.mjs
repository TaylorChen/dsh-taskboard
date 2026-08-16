/**
 * E2E v0.9 (executor): seed a `human`-executor open task and an
 * `agent`-executor open task, drive one trivial model turn; the auto-claim
 * driver must claim ONLY the agent task — the human task is never picked up.
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
const humanTask = await taskboard.create({
  projectId, title: 'E2E v0.9 human', status: 'open', executor: 'human',
  acceptanceCriteria: ['requires a human decision'],
}, human)
const agentTask = await taskboard.create({
  projectId, title: 'E2E v0.9 agent', status: 'open', executor: 'agent',
  acceptanceCriteria: ['reply with exactly DONE-V09 and nothing else'],
}, human)
log(`seeded ${humanTask.key} (executor=human) and ${agentTask.key} (executor=agent)`)

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
log('turn 1 done; the agent task should be claimed, the human task must not…')

const deadline = Date.now() + TIMEOUT_MS
let agentClaimed = false
while (Date.now() < deadline) {
  const t = taskboard.get(agentTask.key)
  if (t !== undefined && t.claimedBySessionId !== null) { agentClaimed = true; break }
  await sleep(1000)
}
const a = taskboard.get(agentTask.key)
const h = taskboard.get(humanTask.key)
log(`agent task: ${a?.status} claimed=${a?.claimedBySessionId ?? '-'}`)
log(`human task: ${h?.status} claimed=${h?.claimedBySessionId ?? '-'} executor=${h?.executor}`)

await shutdown.shutdown(0)
const pass = agentClaimed && h?.claimedBySessionId === null && h?.status === 'open'
console.log(pass ? 'E2E-V09-PASS' : 'E2E-V09-FAIL')
process.exit(pass ? 0 : 1)
