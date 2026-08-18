/**
 * E2E v1.5 (S1/S2): board statistics over a KNOWN history must come out right,
 * and a real dispatched round must record tokensUsed > 0 at settle.
 *
 * Phase 1 (deterministic, no model): seed A done, B blocked, C done-after-a-
 * bounce, then assert the stats numbers exactly.
 * Phase 2 (real model round): an open task with notes is auto-claimed and
 * dispatched; when it settles, tokensUsed is recorded and the notes reached
 * the child (evidence summary echoes the instruction).
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

const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180_000)
const log = (line) => console.log(`[runner] ${line}`)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` <- ${detail}`}`)
  if (!ok) failures += 1
}

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
const ev = (note) => ({ criteria: [{ criterion: 'w', met: true, note }], artifacts: [], summary: note })

// ---- Phase 1: known history ----
const a = await taskboard.create({ projectId, title: 'V1.5 stats A', status: 'open', acceptanceCriteria: ['w'] }, human)
await taskboard.autoClaim(a.key, 'session-stats')
await taskboard.settleDispatch(a.key, 'session-stats', { kind: 'completed', evidence: ev('A done') })
await taskboard.update(a.key, { status: 'done' }, human)

const b = await taskboard.create({ projectId, title: 'V1.5 stats B', status: 'open', acceptanceCriteria: ['w'] }, human)
await taskboard.autoClaim(b.key, 'session-stats')
await taskboard.settleDispatch(b.key, 'session-stats', { kind: 'error', reason: 'B failed', diagnosis: 'boom' })

const c = await taskboard.create({ projectId, title: 'V1.5 stats C', status: 'open', acceptanceCriteria: ['w'] }, human)
await taskboard.autoClaim(c.key, 'session-stats')
await taskboard.settleDispatch(c.key, 'session-stats', { kind: 'completed', evidence: ev('C first') })
await taskboard.update(c.key, { status: 'draft', note: 'bounce: redo C' }, human)
await taskboard.update(c.key, { status: 'open' }, human)
await taskboard.autoClaim(c.key, 'session-stats')
await taskboard.settleDispatch(c.key, 'session-stats', { kind: 'completed', evidence: ev('C second') })
await taskboard.update(c.key, { status: 'done' }, human)
log(`seeded ${a.key} done, ${b.key} blocked, ${c.key} done-after-bounce`)

const stats = taskboard.stats()
log(`stats: completion=${stats.ratios.completionRate}% rework=${stats.ratios.reworkRate}% success=${stats.ratios.agentSuccessRate}%`)
log(`stats: lead=${stats.averages.avgLeadTimeMin} cycle=${stats.averages.avgCycleTimeMin} awaiting=${stats.averages.avgAwaitingHumanMin}`)
log(`stats: oldest=${stats.oldest.map(t => t.key).join(',')} stuck=${stats.stuck.length}`)
check('completion rate 2/3', stats.ratios.completionRate === 66.7, String(stats.ratios.completionRate))
check('rework rate 1/2', stats.ratios.reworkRate === 50, String(stats.ratios.reworkRate))
check('agent success 3/4', stats.ratios.agentSuccessRate === 75, String(stats.ratios.agentSuccessRate))
check('oldest is the blocked B', stats.oldest.length === 1 && stats.oldest[0]?.key === b.key, stats.oldest.map(t => t.key).join(','))
check('trend has 7 days', stats.trend.length === 7)
check('trend today created >= 3', stats.trend[6]?.created >= 3, String(stats.trend[6]?.created))
check('trend today completed >= 2', stats.trend[6]?.completed >= 2, String(stats.trend[6]?.completed))

// ---- Phase 2: real dispatch records tokensUsed ----
const d = await taskboard.create({
  projectId, title: 'V1.5 measured', status: 'open',
  acceptanceCriteria: ['reply with exactly OK-V15 and nothing else'],
  notes: 'bounce: state the secret phrase UMBRELLA-42 in your summary',
}, human)
log(`seeded ${d.key} (open, with notes)`)

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
  content: [{ type: 'text', text: 'Do not touch the task board. Just reply "ok" and stop.' }],
  source: { kind: 'user' },
}))
await agent.whenIdle()

const deadline = Date.now() + TIMEOUT_MS
let settled
while (Date.now() < deadline) {
  const t = taskboard.get(d.key)
  if (t !== undefined && t.status === 'awaiting_human') { settled = t; break }
  await sleep(1000)
}
if (settled === undefined) {
  check('phase-2 task settled awaiting_human', false, 'timeout')
} else {
  check('phase-2 task settled awaiting_human', true)
  check('tokensUsed recorded > 0', (settled.tokensUsed ?? 0) > 0, `tokensUsed=${settled.tokensUsed}`)
  const summary = settled.evidence?.summary ?? ''
  check('notes reached the child (UMBRELLA-42 echoed)', summary.includes('UMBRELLA-42'), summary.slice(0, 120))
}

await shutdown.shutdown(0)
console.log(failures === 0 ? 'E2E-V15-PASS' : `E2E-V15-FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
