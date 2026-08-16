/**
 * The auto-claim driver (`@navidid/dsh-taskboard/autoclaim`): when an agent
 * session is idle and the deployment has mounted this row, claim the oldest
 * claimable `open` task for that session — provided the quota allows — and
 * hand it to a background subagent (v0.4 W2), or to the session itself as a
 * follow-up turn when the subagent seam is unavailable (the v0.3 fallback).
 *
 * v0.3's automation is bound to **quota**, not to a manual toggle (the v0.2
 * plan's design idea 5): the decision to claim is
 * `contextWindow − currentPressure ≥ minRemainingTokens`. The row itself is
 * the opt-in — a deployment that does not mount it gets no auto-claim, and the
 * bundle patch ships it `disabled: true` so installing the bundle never
 * surprises anyone. When enabled, the claim is a system automation write that
 * bypasses the approval gate (ARCHITECTURE decision 25); everything the agent
 * does AFTER the claim still passes the normal gate.
 *
 * v0.4 additions (ARCHITECTURE decisions 28–30):
 * - **Workspace scoping (W1).** When the session's cwd resolves to a workspace
 *   (the optional web-only seam), only tasks of that workspace — or unbound
 *   board-global tasks — are claimable. Unresolvable cwd keeps the pre-v0.4
 *   whole-board scan.
 * - **Subagent dispatch (W2).** A claimed task is handed to a background
 *   subagent via the optional `ctx.subagents` seam; `run.result` settles the
 *   task (`completed` → `awaiting_human`, `error` → `blocked` + reason). The
 *   subagent seam ships in `dsh-base`, so the fallback is defensive only.
 *
 * Quota signals researched in v0.3 (ARCHITECTURE decision 26):
 * `agent.session.requestContext()` carries the resolved route plus the
 * provider-advertised `contextWindow`, and `ctx.tokenMeter.measure(session)`
 * reports the current `totalTokens` pressure. When capacity is unknown the
 * driver conservatively does nothing.
 *
 * The driver mirrors `dsh-goal-round-driver`'s coalescing pattern: an
 * `agent/status → idle` event requests one serialized drive per agent, so a
 * burst of status transitions collapses into a single scan.
 * @module @navidid/dsh-taskboard/autoclaim
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the subagent package's Context augmentation (ctx.subagents).
import type {} from '@deepseek-ai/dsh-subagent'
// Type-only: pulls the token-meter package's Context augmentation (ctx.tokenMeter).
import type {} from '@deepseek-ai/dsh-token-meter'
import z from '@deepseek-ai/schemastery'
import type {} from './index.ts'
import type { Task } from './domain.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The auto-claim driver's follow-up turn; `key` names the claimed task. */
    taskboard: { kind: 'taskboard', key: string }
  }
}

/** The subagent seam face the driver needs, structurally (W2). */
interface SubagentsLike {
  start(
    name: string,
    request: {
      prompt: ContentBlock[]
      parent: Agent
      signal: AbortSignal
      outputSchema?: { type: 'object' } & Record<string, unknown>
      agentOptions?: { maxTokens?: number }
    },
  ): Promise<{
    id: string
    result: Promise<{
      stopReason: string
      output?: readonly ContentBlock[]
      structured?: unknown
    }>
  }>
}

/**
 * The structured report a dispatched subagent must produce (v0.6): a
 * per-criterion self-assessment plus produced artifacts and a summary. The
 * object-rooted subset `ctx.subagents.start` accepts.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          met: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['criterion', 'met'],
        additionalProperties: false,
      },
    },
    artifacts: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['criteria', 'artifacts', 'summary'],
  additionalProperties: false,
} as const

/** Cordis plugin name. */
export const name = 'taskboard-autoclaim'

/** Services required before the driver can run. */
export const inject = ['agents', 'taskboard', 'tokenMeter']

/** Driver configuration. */
export interface Config {
  /**
   * Floor on remaining context budget (`contextWindow − totalTokens`) before
   * the driver will claim. Guards against pulling a task into a nearly full
   * context, where the follow-up turn would immediately overflow.
   */
  minRemainingTokens: number
  /**
   * The `ctx.subagents` provider to dispatch with (v0.4 W2). `spawn` is the
   * in-process provider dsh-base registers; a deployment with another provider
   * can name it here.
   */
  subagentProvider: string
  /**
   * v0.8 (L5): inject a task-board context digest into a new session's first
   * pre-step (via `agent.inject`, which does not wake the driver). Off by
   * default — the digest costs context, and opt-in keeps the board quiet.
   */
  sessionContext: boolean
  /** v0.8: how many of each digest section (open tasks / experience cards). */
  sessionContextLimit: number
}

/** Loader schema with the deployment's defaults. */
export const Config: z<Config> = z.object({
  minRemainingTokens: z.number().step(1).min(0).default(8000),
  subagentProvider: z.string().min(1).default('spawn'),
  sessionContext: z.boolean().default(false),
  sessionContextLimit: z.number().step(1).min(1).default(5),
})

/** How much task body the dispatch prompt quotes; the agent can re-read via tools. */
const BODY_PREVIEW_CHARS = 2000

/** One driver's per-agent state. */
interface DriverState {
  readonly agent: Agent
  /** In-flight serialized drive. */
  run: Promise<void> | undefined
  /** A drive was requested while one was running. */
  requested: boolean
  stopping: boolean
}

/**
 * Register the auto-claim driver.
 * @param ctx - context carrying agents, taskboard, and the token meter.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const states = new Map<Agent, DriverState>()
  // Optional subagent seam: `dsh-base` ships it everywhere, so this is a
  // defensive fallback, not a real deployment branch.
  let subagents: SubagentsLike | undefined
  ctx.inject(['subagents'], (scoped) => {
    subagents = scoped.subagents
  })

  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = { agent, run: undefined, requested: false, stopping: false }
    states.set(agent, state)
    return state
  }

  /** Whether this exact agent is quiescent with nothing else queued. */
  function readyToClaim(agent: Agent): boolean {
    // Fiber ACTIVE = 2: never drive while this row is loading or unloading.
    return ctx.fiber.state === 2
      && agent.status === 'idle'
      && !agent.inbox.hasPending
      && ctx.agents.get(agent.id) === agent
  }

  /**
   * One serialized drive: quota check, workspace-scoped scan, then claim +
   * dispatch the oldest claimable task. Returns without side effects when
   * anything is not ready.
   */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!readyToClaim(agent)) return

    const route = agent.session.requestContext()
    const remaining = route === undefined || route.contextWindow === undefined
      ? undefined
      : route.contextWindow - ctx.tokenMeter.measure(agent.session).totalTokens
    // Unknown capacity, or not enough headroom: do not pull work in.
    if (remaining === undefined || remaining < config.minRemainingTokens) return

    // v0.4 W1: scope the scan to the session's workspace when resolvable.
    const cwd = agent.session.header?.cwd
    const workspaceId = await ctx.taskboard.workspaceIdOfCwd(cwd)
    // v0.7 W2: only dependency-ready tasks are candidates; v0.9 W1: `human`
    // tasks are never auto-claimed.
    const scoped = ctx.taskboard.list({ status: 'open' }).filter(task =>
      (workspaceId === undefined || task.workspaceId === null || task.workspaceId === workspaceId)
      && ctx.taskboard.isReady(task.id)
      && task.executor !== 'human')
    const candidate = selectClaimCandidate(scoped)
    if (candidate === undefined) return

    const claimed = await ctx.taskboard.autoClaim(candidate.id, agent.id, cwd)
    if (claimed === null) return // lost the claim to another session

    // v0.4 W2: hand the task to a background subagent; fall back to a
    // follow-up turn in the claiming session when the seam is unavailable or
    // starting it fails.
    if (subagents !== undefined) {
      try {
        const run = await subagents.start(config.subagentProvider, {
          prompt: [{ type: 'text', text: renderDispatchPrompt(claimed) }],
          parent: agent,
          signal: new AbortController().signal,
          outputSchema: OUTPUT_SCHEMA,
          // v0.7 W3: a task-level output-token budget caps the child's reply.
          ...claimed.budgetTokens === null ? {} : {
            agentOptions: { maxTokens: claimed.budgetTokens },
          },
        })
        await ctx.taskboard.recordDispatched(claimed.id, agent.id, run.id)
        void run.result.then(
          (result) => {
            if (result.stopReason === 'completed') {
              const report = isTaskEvidence(result.structured)
              if (report !== undefined) {
                void ctx.taskboard.settleDispatch(claimed.id, agent.id, {
                  kind: 'completed',
                  evidence: {
                    criteria: report.criteria.map(entry => ({
                      criterion: entry.criterion,
                      met: entry.met,
                      note: entry.note ?? '',
                    })),
                    artifacts: report.artifacts,
                    summary: report.summary,
                  },
                }).catch(error => ctx.logger.warn(
                  `taskboard-autoclaim: could not settle dispatch of ${claimed.key ?? claimed.id}: ${renderThrown(error)}`,
                ))
                return
              }
              // No valid structured capture: no half-evidence — settle as error.
              void ctx.taskboard.settleDispatch(claimed.id, agent.id, {
                kind: 'error',
                reason: `subagent ${run.id} finished without a structured report`,
                diagnosis: tailOf(result.output),
              }).catch(failure => ctx.logger.warn(
                `taskboard-autoclaim: could not settle missing-report dispatch of ${claimed.key ?? claimed.id}: ${renderThrown(failure)}`,
              ))
              return
            }
            // v0.7 W3: a child that hit its token ceiling is a budget
            // overrun, reported distinctly from a plain failure.
            const budgetOverrun = result.stopReason === 'max-tokens'
            void ctx.taskboard.settleDispatch(claimed.id, agent.id, {
              kind: 'error',
              reason: budgetOverrun
                ? `subagent ${run.id} exceeded the task's token budget`
                : `subagent ${run.id} ended with ${result.stopReason}`,
              diagnosis: tailOf(result.output),
            }).catch(error => ctx.logger.warn(
              `taskboard-autoclaim: could not settle failed dispatch of ${claimed.key ?? claimed.id}: ${renderThrown(error)}`,
            ))
          },
          (error) => {
            // `run.result` rejects only on an infrastructure fault.
            void ctx.taskboard.settleDispatch(claimed.id, agent.id, {
              kind: 'error',
              reason: `subagent ${run.id} failed to run`,
              diagnosis: renderThrown(error),
            }).catch(failure => ctx.logger.warn(
              `taskboard-autoclaim: could not settle failed dispatch of ${claimed.key ?? claimed.id}: ${renderThrown(failure)}`,
            ))
          },
        )
        return
      } catch (error) {
        ctx.logger.warn(
          `taskboard-autoclaim: could not start subagent for ${claimed.key ?? claimed.id}: ${renderThrown(error)}`,
        )
      }
    }

    const key = claimed.key ?? claimed.id
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: renderFollowup(claimed) }],
        source: { kind: 'taskboard', key },
      }))
    } catch (error) {
      ctx.logger.warn(
        `taskboard-autoclaim: could not queue claimed task ${key} for agent "${agent.id}": ${renderThrown(error)}`,
      )
    }
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error) {
            ctx.logger.warn(
              `taskboard-autoclaim: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`,
            )
          }
        }
      })
    } catch (error) {
      ctx.logger.warn(`taskboard-autoclaim: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    run.then(retire, () => retire())
  }

  ctx.effect(() => {
    const onCreated = ({ agent }: { agent: Agent }): void => { void stateFor(agent) }
    const onDisposed = ({ agent }: { agent: Agent }): void => { states.delete(agent) }
    const onSessionStart = ({ agent }: { agent: Agent }): void => {
      void stateFor(agent)
      // v0.8 (L5): seed a fresh session with the board's relevant state —
      // open work and related completed experience — as context for the first
      // pre-step, without waking the driver.
      if (config.sessionContext) void injectSessionContext(ctx, config, agent)
    }
    const onStatus = ({ agent, status }: { agent: Agent, status: string }): void => {
      if (status === 'idle') requestDrive(stateFor(agent))
    }
    ctx.on('agent/created', onCreated)
    ctx.on('agent/disposed', onDisposed)
    ctx.on('agent/session-start', onSessionStart)
    ctx.on('agent/status', onStatus)
    return () => {
      for (const state of states.values()) state.stopping = true
      states.clear()
    }
  }, 'dsh-taskboard.autoclaim')
}

/**
 * Build and inject the session context digest (v0.8): open work and related
 * experience for the session's workspace, capped so the digest cannot balloon
 * the context. Uses `agent.inject`, which queues model-facing context for the
 * next pre-step without waking the driver.
 */
async function injectSessionContext(
  ctx: Context,
  config: Config,
  agent: Agent,
): Promise<void> {
  try {
    const cwd = agent.session.header?.cwd
    const workspaceId = await ctx.taskboard.workspaceIdOfCwd(cwd)
    const inWorkspace = (id: string | null): boolean =>
      workspaceId === undefined || id === null || id === workspaceId

    const open = ctx.taskboard.list({ status: 'open' })
      .filter(task => inWorkspace(task.workspaceId))
      .slice(0, config.sessionContextLimit)
    const experience = ctx.taskboard.relatedExperience({
      workspaceId: workspaceId === undefined ? undefined : workspaceId,
      limit: config.sessionContextLimit,
    })

    const sections: string[] = []
    if (open.length > 0) {
      sections.push('Open tasks (claimable):\n' + open
        .map(task => `- ${task.key ?? task.id} ${task.title}`).join('\n'))
    }
    if (experience.length > 0) {
      sections.push('Related experience:\n' + experience
        .map(card => `- ${card.key} ${card.title} — ${clip(card.summary, 80)}`).join('\n'))
    }
    if (sections.length === 0) return

    const digest = `<taskboard_session_context>\n${sections.join('\n\n')}\n</taskboard_session_context>`
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: digest }],
      source: { kind: 'taskboard', key: 'session-context' },
    }))
  } catch (error) {
    ctx.logger.warn(
      `taskboard-autoclaim: could not inject session context for agent "${agent.id}": ${renderThrown(error)}`,
    )
  }
}

/**
 * Pick the highest-priority claimable task: `open`, unclaimed, sorted by
 * priority weight (urgent→low), then deadline (earlier `dueAt` first, none
 * last), then age. Pure so the scheduling order is unit-testable; workspace
 * scoping, dependency readiness, and the `human` executor filter happen in
 * the driver before this.
 * @param tasks - tasks to scan (any status; the filters are applied here).
 * @returns the claim candidate, or `undefined` when none is claimable.
 */
export function selectClaimCandidate(tasks: readonly Task[]): Task | undefined {
  return tasks
    .filter(task => task.status === 'open' && task.claimedBySessionId === null)
    .sort((a, b) =>
      priorityWeight(b) - priorityWeight(a)
      || dueOrder(a) - dueOrder(b)
      || a.createdAt - b.createdAt)[0]
}

/** Deadline order: dated tasks before undated, earlier first. */
function dueOrder(task: Task): number {
  return task.dueAt == null ? Number.MAX_SAFE_INTEGER : task.dueAt
}

/** Priority scheduling weight: urgent 4 … low 1 (v0.7 W2). */
function priorityWeight(task: Task): number {
  switch (task.priority) {
    case 'urgent': return 4
    case 'high': return 3
    case 'normal': return 2
    case 'low': return 1
  }
}

/** The dispatch prompt handed to a background subagent (W2). */
function renderDispatchPrompt(task: Task): string {
  const key = task.key ?? task.id
  const spec = task.spec
  return [
    `You were assigned task ${key} on the task board: ${task.title}.`,
    'Work on it in this session.',
    'Do not modify the task board yourself — the dispatcher records your outcome.',
    spec === null || spec.acceptanceCriteria.length === 0
      ? undefined
      : `\nAcceptance criteria (verify each):\n${spec.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`,
    spec === null || spec.contextRefs.length === 0
      ? undefined
      : `\nContext to read:\n${spec.contextRefs.join('\n')}`,
    spec !== null && spec.definitionOfDone !== ''
      ? `\nDefinition of done: ${spec.definitionOfDone}`
      : undefined,
    task.body === '' ? undefined : `\nTask description:\n${bounded(task.body)}`,
    '\nWhen finished, report as a JSON object with exactly these fields:\n'
    + '- criteria: array of {criterion: <one acceptance criterion>, met: <true|false>, note: <evidence or reason>}\n'
    + '- artifacts: array of produced file paths / commit hashes\n'
    + '- summary: one paragraph stating what you did and the result',
  ].filter(line => line !== undefined).join('\n')
}

/** The fallback follow-up turn handed to the claiming session (v0.3 path). */
function renderFollowup(task: Task): string {
  const key = task.key ?? task.id
  const spec = task.spec
  return [
    `You claimed ${key} on the task board: ${task.title}.`,
    'Work on it now in this session; report progress on the task when done.',
    spec === null || spec.acceptanceCriteria.length === 0
      ? undefined
      : `\nAcceptance criteria (verify each):\n${spec.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`,
    task.body === '' ? undefined : `\nTask description:\n${bounded(task.body)}`,
  ].filter(line => line !== undefined).join('\n')
}

/** Bound free text quoted into the dispatch prompt. */
function bounded(text: string): string {
  return text.length <= BODY_PREVIEW_CHARS
    ? text
    : `${text.slice(0, BODY_PREVIEW_CHARS)}… (${text.length} chars total)`
}

/** Bound text quoted into a digest line. */
function clip(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`
}

/** Whether an unknown structured value is a usable task-evidence report. */
function isTaskEvidence(value: unknown): {
  criteria: Array<{ criterion: string, met: boolean, note?: string }>
  artifacts: string[]
  summary: string
} | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.criteria) || !Array.isArray(record.artifacts)) return undefined
  if (typeof record.summary !== 'string') return undefined
  if (!record.criteria.every(criterion =>
    typeof criterion === 'object' && criterion !== null
    && typeof (criterion as Record<string, unknown>).criterion === 'string'
    && typeof (criterion as Record<string, unknown>).met === 'boolean')) return undefined
  return record as {
    criteria: Array<{ criterion: string, met: boolean, note?: string }>
    artifacts: string[]
    summary: string
  }
}

/** The tail of the subagent's partial output, for a failure diagnosis. */
function tailOf(output: readonly ContentBlock[] | undefined): string {
  const text = (output ?? [])
    .map(block => (block as { text?: string }).text ?? '')
    .join('\n')
    .trim()
  if (text === '') return 'no output captured'
  return text.length <= 2000 ? text : `…${text.slice(-2000)}`
}

/** Render a thrown value into a logger line. */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
