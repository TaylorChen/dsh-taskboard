#!/usr/bin/env node
/**
 * v1.10 A-session subagent E2E — PHASE 1 (data prep): boot an e2e profile,
 * create a top-level agent session, spawn a REAL subagent, and have the
 * SUBAGENT claim a task (so the task's claiming session is a subagent with a
 * parent). Then assert the durable session record carries parentSessionId,
 * which is what the GUI's openable-target resolution needs.
 *
 * Phase 2 (browser) lives in v110-session-subagent-web.py and runs against
 * the same home after this script exits.
 *
 * Env: DSH_HOME, E2E_DSH_PACKAGE, E2E_APP_BOOT_PACKAGE, E2E_PROFILE.
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

const log = (line) => console.log(`[runner] ${line}`)
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
const subagents = ctx.get('subagents')
if (agents === undefined || defaultModel === undefined || taskboard === undefined || subagents === undefined) {
  console.error('[runner] missing services')
  await shutdown.shutdown(1)
  process.exit(1)
}

const projectId = taskboard.projects()[0]?.id
const human = { kind: 'human', via: 'panel' }

// 1. A top-level agent session.
const selection = defaultModel.currentSelection()
const { agent } = await agents.create({
  sessionId: SessionId(`session-${randomUUID()}`),
  meta: { cwd: process.cwd() },
  agentOptions: { provider: selection.provider, model: selection.model },
  setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: undefined }) },
})
await agent.whenIdle()
check('top-level agent created', true, agent.id)

// 2. Spawn a REAL subagent from it.
const run = await subagents.start('spawn', {
  prompt: [{ type: 'text', text: 'Do nothing. Reply with JSON: {"ok":true}. Do not touch the board.' }],
  parent: agent,
  signal: new AbortController().signal,
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
})
const subagentId = run.id
log(`subagent spawned: ${subagentId}`)
check('subagent spawned', true, subagentId)

// 3. The SUBAGENT claims a task (autoClaim with the subagent's id).
const task = await taskboard.create({
  projectId, title: 'Subagent-claimed E2E', status: 'open',
  acceptanceCriteria: ['reply ok'],
}, human)
const claimed = await taskboard.autoClaim(task.key, subagentId)
check('subagent claimed the task', claimed !== null && claimed.status === 'in_progress',
  claimed === null ? 'null' : `${claimed.status} claimed=${claimed.claimedBySessionId}`)

// 4. The claiming session id is the subagent's, not the parent's.
check('claimed by subagent id', claimed?.claimedBySessionId === subagentId,
  String(claimed?.claimedBySessionId))

// 5. The parent session exists and the subagent id differs from it.
check('subagent id differs from parent', subagentId !== agent.id, '')

// Let the subagent finish (it replies and exits).
try { await run.result } catch { /* expected disposal */ }
await run.dispose().catch(() => {})

await shutdown.shutdown(failures === 0 ? 0 : 1)
console.log(failures === 0 ? 'E2E-V110-SUBAGENT-PREP-PASS' : `E2E-V110-SUBAGENT-PREP-FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
