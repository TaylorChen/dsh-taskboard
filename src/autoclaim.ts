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
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import type {} from './index.ts'
import type { Task } from './domain.ts'
import type { TaskboardService } from './service.ts'

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
    dispose(): Promise<void>
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
  /**
   * v1.1 (A1): how long a dispatched subagent may run before the driver
   * disposes it and settles the task `blocked` with a budget/timeout reason.
   */
  dispatchTimeoutMs: number
  /**
   * v1.6 (C2): bounded auto-retry — a failed dispatch goes back to `open`
   * for one more auto-claim, up to `maxRetries` times, with at least
   * `backoffMs` between attempts. Off by default (0). The retry is recorded
   * in the notes (`retry n/max`, quoted into the next dispatch prompt) and
   * the activity stream, so attempts are auditable. Retry is a budget
   * decision: each attempt costs another full dispatch.
   */
  autoRetry: { maxRetries: number, backoffMs: number }
  /**
   * v1.6 (C3): liveness heartbeat — while a task is dispatched, append a
   * `heartbeat: running <n> min` activity entry every `heartbeatMs` so the
   * stream proves the execution is alive (not stuck silently). 0 disables.
   */
  heartbeatMs: number
  /**
   * v1.8 (M3): stale-claim recovery — a task stuck in `in_progress` whose
   * claiming session is gone, or idle with nothing dispatched, for at least
   * this many minutes is released back to `open` (with a recovery note) so it
   * can be re-claimed. 0 disables.
   */
  staleClaimMinutes: number
}

/** Loader schema with the deployment's defaults. */
export const Config: z<Config> = z.object({
  minRemainingTokens: z.number().step(1).min(0).default(8000),
  subagentProvider: z.string().min(1).default('spawn'),
  sessionContext: z.boolean().default(false),
  sessionContextLimit: z.number().step(1).min(1).default(5),
  dispatchTimeoutMs: z.number().step(1).min(1).default(30 * 60 * 1000),
  autoRetry: z.object({
    maxRetries: z.number().step(1).min(0).default(0),
    backoffMs: z.number().step(1).min(0).default(30_000),
  }).default({ maxRetries: 0, backoffMs: 30_000 }),
  heartbeatMs: z.number().step(1).min(0).default(10 * 60 * 1000),
  staleClaimMinutes: z.number().step(1).min(0).default(60),
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

/** One live dispatched execution (v1.1 A1/A2): cancel + timeout + visibility. */
interface Execution {
  readonly taskId: string
  readonly sessionId: string
  readonly run: { id: string, dispose(): Promise<void> }
  readonly startedAt: number
  readonly timer: ReturnType<typeof setTimeout>
  /** v1.6 C3: liveness heartbeat interval (cleared with `timer`). */
  readonly heartbeat: ReturnType<typeof setInterval> | undefined
}

/**
 * Register the auto-claim driver.
 * @param ctx - context carrying agents, taskboard, and the token meter.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const states = new Map<Agent, DriverState>()
  // Live dispatched executions, keyed by task id (v1.1 A1/A2). Also the
  // visibility source the service exposes to the panel.
  const executions = new Map<string, Execution>()
  // Optional subagent seam: `dsh-base` ships it everywhere, so this is a
  // defensive fallback, not a real deployment branch.
  let subagents: SubagentsLike | undefined
  ctx.inject(['subagents'], (scoped) => {
    subagents = scoped.subagents
  })
  ctx.taskboard.setExecutionTracker({
    executionOf: (taskId: string) => {
      const execution = executions.get(taskId)
      return execution === undefined
        ? undefined
        : { subagentId: execution.run.id, startedAt: execution.startedAt }
    },
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
  /**
   * v1.6 C2: settle a failed dispatch, or send it back to `open` for one more
   * bounded attempt. Only dispatch-attempted failures retry (the pre-dispatch
   * budget refusal at 258 does not — retrying cannot fix an over-budget
   * prompt); the timeout path stays terminal (v1.1).
   */
  /** v1.9 G4: emit a proactive alert (the webhook row forwards it when
   * configured; otherwise it is a no-op cordis event). */
  function alert(kind: string, task: Task, detail: string): void {
    ctx.emit('taskboard/alert', { kind, taskKey: task.key ?? task.id, detail })
  }

  async function settleOrRetry(
    task: Task, agent: Agent, run: { id: string }, promptText: string,
    reason: string, diagnosis: string,
  ): Promise<void> {
    const max = config.autoRetry.maxRetries
    if (max > 0 && (task.spec?.acceptanceCriteria.length ?? 0) > 0) {
      const attempts = retryCount(ctx.taskboard, task.id)
      if (attempts < max) {
        try {
          await ctx.taskboard.markForRetry(task.id, attempts + 1, max, agent.id)
          ctx.logger.info(
            `taskboard-autoclaim: retry ${attempts + 1}/${max} of ${task.key ?? task.id} (${reason})`,
          )
          return
        } catch (error) {
          ctx.logger.warn(
            `taskboard-autoclaim: retry of ${task.key ?? task.id} failed: ${renderThrown(error)}`,
          )
          // fall through to settle
        }
      }
    }
    // v1.9 G4: a permanent blocked settle is an alert (retries are not).
    alert(reason.includes('token budget') ? 'budget' : 'blocked', task, reason)
    await ctx.taskboard.settleDispatch(
      task.id, agent.id,
      { kind: 'error', reason, diagnosis },
      measureChildTokens(run, promptText, ctx),
    )
  }

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
    // v1.6 C2: a task retried too recently is not a candidate — the failed
    // attempt needs its backoff window before the next full dispatch.
    const now = Date.now()
    const scoped = ctx.taskboard.list({ status: 'open' }).filter(task =>
      (workspaceId === undefined || task.workspaceId === null || task.workspaceId === workspaceId)
      && ctx.taskboard.isReady(task.id)
      && task.executor !== 'human'
      && !inRetryBackoff(ctx.taskboard, task.id, config.autoRetry.backoffMs, now))
    const candidate = selectClaimCandidate(scoped)
    if (candidate === undefined) return

    const claimed = await ctx.taskboard.autoClaim(candidate.id, agent.id, cwd)
    if (claimed === null) return // lost the claim to another session

    // v0.4 W2: hand the task to a background subagent; fall back to a
    // follow-up turn in the claiming session when the seam is unavailable or
    // starting it fails.
    if (subagents !== undefined) {
      // v1.2 B2: an input-context budget refuses a dispatch whose prompt is
      // estimated to overflow the child's context — settle blocked instead of
      // dispatching a doomed run.
      const promptText = renderDispatchPrompt(claimed)
      if (claimed.contextBudgetTokens !== null) {
        const estimated = estimateInputTokens(promptText)
        if (estimated > claimed.contextBudgetTokens) {
          await ctx.taskboard.settleDispatch(claimed.id, agent.id, {
            kind: 'error',
            reason: 'dispatch refused: input context over budget',
            diagnosis: `estimated ${estimated} tokens exceeds the task's ${claimed.contextBudgetTokens} context budget`,
          })
          return
        }
      }
      try {
        const run = await subagents.start(config.subagentProvider, {
          prompt: [{ type: 'text', text: promptText }],
          parent: agent,
          signal: new AbortController().signal,
          outputSchema: OUTPUT_SCHEMA,
          // v0.7 W3: a task-level output-token budget caps the child's reply.
          ...claimed.budgetTokens === null ? {} : {
            agentOptions: { maxTokens: claimed.budgetTokens },
          },
        })
        await ctx.taskboard.recordDispatched(claimed.id, agent.id, run.id)
        // v1.1 (A1/A2): register the execution — the settle callback only
        // writes back while this execution is still owned, so a cancelled
        // child can never double-settle, and the timeout timer can fire.
        const execution: Execution = {
          taskId: claimed.id,
          sessionId: agent.id,
          run,
          startedAt: Date.now(),
          timer: setTimeout(() => { void timeoutExecution(executions, ctx, config, claimed.id) }, config.dispatchTimeoutMs),
          // v1.6 C3: liveness beat while the child runs (unref'd, cleared with
          // the timeout timer at settle/cancel/timeout).
          heartbeat: config.heartbeatMs > 0
            ? setInterval(() => {
              void ctx.taskboard.heartbeat(claimed.id, agent.id).catch(error => ctx.logger.warn(
                `taskboard-autoclaim: heartbeat of ${claimed.key ?? claimed.id} failed: ${renderThrown(error)}`,
              ))
            }, config.heartbeatMs)
            : undefined,
        }
        execution.timer.unref?.()
        executions.set(claimed.id, execution)
        // The settle runs after the child's turn — possibly long after this
        // drive returns, even after the app starts closing. The whole callback
        // is guarded so a settling child can never produce an unhandled
        // rejection (e.g. `ctx.taskboard` read on an inactive context during
        // shutdown); a failed settle is a logged warning, never a crash.
        void run.result.then(
          async (result) => {
            try {
              // Ownership guard: if the execution was cancelled (task moved
              // off in_progress, or timed out), do not settle a second time.
              if (executions.delete(claimed.id) === false) return
              clearTimeout(execution.timer)
              if (execution.heartbeat !== undefined) clearInterval(execution.heartbeat)
              if (result.stopReason === 'completed') {
                const report = isTaskEvidence(result.structured)
                if (report !== undefined) {
                  await ctx.taskboard.settleDispatch(claimed.id, agent.id, {
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
                  }, measureChildTokens(run, promptText, ctx))
                  return
                }
                // No valid structured capture: no half-evidence — settle as
                // error (or retry, v1.6 C2).
                await settleOrRetry(
                  claimed, agent, run, promptText,
                  `subagent ${run.id} finished without a structured report`,
                  tailOf(result.output),
                )
                return
              }
              // v0.7 W3: a child that hit its token ceiling is a budget
              // overrun, reported distinctly from a plain failure.
              const budgetOverrun = result.stopReason === 'max-tokens'
              await settleOrRetry(
                claimed, agent, run, promptText,
                budgetOverrun
                  ? `subagent ${run.id} exceeded the task's token budget`
                  : `subagent ${run.id} ended with ${result.stopReason}`,
                tailOf(result.output),
              )
            } catch (error) {
              ctx.logger.warn(
                `taskboard-autoclaim: could not settle dispatch of ${claimed.key ?? claimed.id}: ${renderThrown(error)}`,
              )
            }
          },
          async (error) => {
            // `run.result` rejects only on an infrastructure fault.
            try {
              if (executions.delete(claimed.id) === false) return
              clearTimeout(execution.timer)
              if (execution.heartbeat !== undefined) clearInterval(execution.heartbeat)
              await settleOrRetry(
                claimed, agent, run, promptText,
                `subagent ${run.id} failed to run`,
                renderThrown(error),
              )
            } catch (failure) {
              ctx.logger.warn(
                `taskboard-autoclaim: could not settle failed dispatch of ${claimed.key ?? claimed.id}: ${renderThrown(failure)}`,
              )
            }
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
    // v1.1 (A1): if a dispatched task leaves in_progress (a human took over,
    // cancelled it, moved it on), stop the child instead of letting it burn
    // tokens. `domain/changed` carries the new task snapshot.
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== 'taskboard' || change.table !== 'tasks' || change.operation !== 'put') return
      const task = change.value as { status?: string } | undefined
      if (task === undefined || task.status === 'in_progress') return
      const execution = executions.get(change.key)
      if (execution === undefined) return
      executions.delete(change.key)
      clearTimeout(execution.timer)
              if (execution.heartbeat !== undefined) clearInterval(execution.heartbeat)
      void execution.run.dispose().catch(error => ctx.logger.warn(
        `taskboard-autoclaim: could not dispose cancelled execution of task ${change.key}: ${renderThrown(error)}`,
      ))
      ctx.logger.info(
        `taskboard-autoclaim: cancelled dispatched subagent ${execution.run.id} (task ${change.key} left in_progress)`,
      )
    })
    // v1.8 M3: stale-claim recovery sweep — scan every minute for claims
    // past their threshold with a gone/idle session and nothing dispatched.
    let sweep: ReturnType<typeof setInterval> | undefined
    if (config.staleClaimMinutes > 0) {
      sweep = setInterval(() => {
        const now = Date.now()
        for (const task of staleClaimCandidates(
          ctx.taskboard, ctx.agents, executions, now, config.staleClaimMinutes,
        )) {
          const dwellMin = Math.max(1, Math.round((now - task.updatedAt) / 60_000))
          void ctx.taskboard.recoverStaleClaim(task.id, 'driver', dwellMin)
            .then(recovered => alert('stale', recovered, `session lost (claimed ${dwellMin} min ago)`))
            .catch(error => ctx.logger.warn(
              `taskboard-autoclaim: stale recovery of ${task.key ?? task.id} failed: ${renderThrown(error)}`,
            ))
        }
      }, 60_000)
      sweep.unref?.()
    }

    return () => {
      if (sweep !== undefined) clearInterval(sweep)
      for (const state of states.values()) state.stopping = true
      for (const execution of executions.values()) {
        clearTimeout(execution.timer)
        if (execution.heartbeat !== undefined) clearInterval(execution.heartbeat)
      }
      states.clear()
      executions.clear()
    }
  }, 'dsh-taskboard.autoclaim')
}

/**
 * Time out one dispatched execution (v1.1 A1): dispose the child and settle the
 * task `blocked` with a timeout reason. The ownership guard in the settle
 * callback keeps a later `run.result` from double-settling.
 */
async function timeoutExecution(
  executions: Map<string, Execution>,
  ctx: Context,
  config: Config,
  taskId: string,
): Promise<void> {
  const execution = executions.get(taskId)
  if (execution === undefined) return
  executions.delete(taskId)
  try {
    await execution.run.dispose()
  } catch (error) {
    ctx.logger.warn(
      `taskboard-autoclaim: could not dispose timed-out subagent ${execution.run.id}: ${renderThrown(error)}`,
    )
  }
  // v1.9 G4: a timeout is a proactive alert.
  const task = ctx.taskboard.get(taskId)
  if (task !== undefined) {
    ctx.emit('taskboard/alert', {
      kind: 'timeout',
      taskKey: task.key ?? task.id,
      detail: `dispatch exceeded ${config.dispatchTimeoutMs} ms`,
    })
  }
  try {
    await ctx.taskboard.settleDispatch(taskId, execution.sessionId, {
      kind: 'error',
      reason: 'execution timed out',
      diagnosis: `dispatched subagent ${execution.run.id} exceeded ${config.dispatchTimeoutMs} ms`,
    })
  } catch (error) {
    ctx.logger.warn(
      `taskboard-autoclaim: could not settle timed-out dispatch of ${taskId}: ${renderThrown(error)}`,
    )
  }
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

/**
 * v1.2 B2: conservative input-cost estimate — ~4 chars per token, rounded up.
 * Deliberately a ceiling: a prompt near the limit is refused rather than
 * dispatched into a truncated context.
 */
export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * v1.5 S2: measure the dispatched child's actual input-context usage at settle.
 * The child session is looked up by its run id and measured through the token
 * meter; by settle time it may already be disposed, in which case the
 * deterministic dispatch-prompt estimate (`ceil(chars / 4)`) stands in — a
 * documented approximation, not a metered figure.
 * @param run - the finished subagent run (its id IS the child session id).
 * @param promptText - the dispatch prompt, for the fallback estimate.
 * @param ctx - context carrying `agents` and `tokenMeter`.
 * @returns measured tokens, or the estimate; never `null` in practice.
 */
function measureChildTokens(run: { id: string }, promptText: string, ctx: Context): number {
  try {
    const child = ctx.agents.get(run.id as never)
    if (child !== undefined) {
      const measured = ctx.tokenMeter.measure(child.session).totalTokens
      if (Number.isFinite(measured) && measured >= 0) return Math.round(measured)
    }
  } catch {
    // fall through to the estimate
  }
  return estimateInputTokens(promptText)
}

/**
 * v1.6 C2: how many `retry n/max` notes a task already carries — the
 * authoritative attempt counter (the retry note is also in the dispatch
 * prompt, so the next child knows how many tries came before).
 */
function retryCount(taskboard: TaskboardService, taskId: string): number {
  let count = 0
  for (const entry of taskboard.activityOf(taskId)) {
    if (entry.action === 'noted' && (entry.to ?? '').startsWith('retry ')) count += 1
  }
  return count
}

/**
 * v1.6 C2: honor the retry backoff — skip an open task whose newest activity
 * entry is a retry note newer than `backoffMs` ago (the failed attempt needs
 * room before the next one is worth a full dispatch).
 */
function inRetryBackoff(
  taskboard: TaskboardService, taskId: string, backoffMs: number, now: number,
): boolean {
  if (backoffMs <= 0) return false
  const newest = taskboard.activityOf(taskId)[0]
  return newest !== undefined
    && newest.action === 'noted'
    && (newest.to ?? '').startsWith('retry ')
    && newest.at > now - backoffMs
}

/**
 * v1.8 M3: in_progress tasks whose claim is stale — the claiming session is
 * gone, or idle with nothing dispatched, for at least `thresholdMin` minutes.
 * Exported for direct unit testing (the sweep timer just calls it).
 */
export function staleClaimCandidates(
  taskboard: TaskboardService,
  agents: { get(id: string): unknown },
  executions: ReadonlyMap<string, unknown>,
  now: number,
  thresholdMin: number,
): Task[] {
  if (thresholdMin <= 0) return []
  return taskboard.list({ status: 'in_progress' }).filter(task => {
    if (task.claimedBySessionId === null) return false
    const dwellMin = Math.round((now - task.updatedAt) / 60_000)
    if (dwellMin < thresholdMin) return false
    const session = agents.get(task.claimedBySessionId)
    if (session === undefined) return true
    if (executions.has(task.id)) return false
    const idle = typeof session === 'object' && session !== null
      && 'status' in session && (session as { status?: string }).status === 'idle'
    return idle
  })
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
    // v1.5 S3: the human's notes (incl. a bounce reason, which lands in notes
    // as `bounce: …`) are part of the execution context — without this the
    // dispatched agent can never see the instruction the human left.
    task.notes === ''
      ? undefined
      : `\nNotes from the human (follow these):\n${clip(task.notes, 1000)}`,
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
