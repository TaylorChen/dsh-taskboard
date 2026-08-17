/**
 * E2E v0.8 (L5 knowledge layer): seed a done task WITH evidence, enable the
 * session-context injection, then run one real model turn that creates a task.
 * Assert: (1) the session log carries the <taskboard_session_context> digest
 * injected at session-start (open work + related experience), and (2) the
 * task_create result renders "Related experience" pointing at the done task.
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

// Seed a completed task with evidence, so there is experience to inject.
const done = await taskboard.create({
  projectId, title: 'E2E v0.8 learned', status: 'open',
  acceptanceCriteria: ['reply with exactly LEARNED and nothing else'],
}, human)
await taskboard.autoClaim(done.id, 'seed-session')
await taskboard.settleDispatch(done.id, 'seed-session', {
  kind: 'completed',
  evidence: {
    criteria: [{ criterion: 'reply with exactly LEARNED', met: true, note: 'ok' }],
    artifacts: [],
    summary: 'E2E v0.8 history: verified the evidence loop end to end.',
  },
})
await taskboard.update(done.id, { status: 'done' }, human)
log(`seeded done ${done.key} with evidence summary`)

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
log(`agent ready: ${agent.id}`)

agent.followup(createUserMessage({
  content: [{
    type: 'text',
    text: `Use task_create to create a task titled 'E2E v0.8 history' with acceptance_criteria ["reply with exactly DONE-V08 and nothing else"]. Then reply with the task key.`,
  }],
  source: { kind: 'user' },
}))
await agent.whenIdle()

// The session log should hold both the injected digest and the create result.
// Sessions live under $DSH_HOME/sessions/<cwd-scope>/<session-id>/; the scope
// name is derived from the runner's cwd (e.g. --private-tmp-dsh-e2e-v06--).
const cwdScope = `--${process.cwd().replace(/^[/\\]+/, '').replace(/[/\\]/g, '-')}--`
const sessionDir = `${process.env.DSH_HOME}/sessions/${cwdScope}/${agent.id}`
const { execFileSync } = await import('node:child_process')
const zstd = execFileSync('zstd', ['-dc', `${sessionDir}/session.jsonl.zstd`], { maxBuffer: 64 * 1024 * 1024 })
const logText = zstd.toString('utf8')
const digestSeen = logText.includes('<taskboard_session_context>')
  && logText.includes('E2E v0.8 learned')
const relatedSeen = logText.includes('Related experience:')
  && logText.includes('E2E v0.8 learned')
log(`digest injected: ${digestSeen}; create result mentions related experience: ${relatedSeen}`)

await shutdown.shutdown(0)
const pass = digestSeen && relatedSeen
console.log(pass ? 'E2E-V08-PASS' : 'E2E-V08-FAIL')
process.exit(pass ? 0 : 1)
