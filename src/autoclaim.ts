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
    request: { prompt: readonly ContentBlock[], parent: Agent, signal: AbortSignal },
  ): Promise<{ id: string, result: Promise<{ stopReason: string }> }>
}

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
}

/** Loader schema with the deployment's defaults. */
export const Config: z<Config> = z.object({
  minRemainingTokens: z.number().step(1).min(0).default(8000),
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
    const scoped = ctx.taskboard.list({ status: 'open' }).filter(task =>
      workspaceId === undefined || task.workspaceId === null || task.workspaceId === workspaceId)
    const candidate = selectClaimCandidate(scoped)
    if (candidate === undefined) return

    const claimed = await ctx.taskboard.autoClaim(candidate.id, agent.id, cwd)
    if (claimed === null) return // lost the claim to another session

    // v0.4 W2: hand the task to a background subagent; fall back to a
    // follow-up turn in the claiming session when the seam is unavailable or
    // starting it fails.
    if (subagents !== undefined) {
      try {
        const run = await subagents.start('taskboard', {
          prompt: [{ type: 'text', text: renderDispatchPrompt(claimed) }],
          parent: agent,
          signal: new AbortController().signal,
        })
        await ctx.taskboard.recordDispatched(claimed.id, agent.id, run.id)
        void run.result.then(
          (result) => {
            const outcome = result.stopReason === 'completed'
              ? { kind: 'completed' as const }
              : {
                kind: 'error' as const,
                reason: `subagent ${run.id} ended with ${result.stopReason}`,
              }
            void ctx.taskboard.settleDispatch(claimed.id, agent.id, outcome)
              .catch(error => ctx.logger.warn(
                `taskboard-autoclaim: could not settle dispatch of ${claimed.key ?? claimed.id}: ${renderThrown(error)}`,
              ))
          },
          (error) => {
            // `run.result` rejects only on an infrastructure fault.
            void ctx.taskboard.settleDispatch(claimed.id, agent.id, {
              kind: 'error',
              reason: `subagent ${run.id} failed to run: ${renderThrown(error)}`,
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
    const onSessionStart = ({ agent }: { agent: Agent }): void => { void stateFor(agent) }
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
 * Pick the oldest claimable task: `open` and unclaimed, earliest `createdAt`
 * first. Pure so the scan order is unit-testable; workspace scoping happens in
 * the driver before this filter.
 * @param tasks - tasks to scan (any status; the filter is applied here).
 * @returns the claim candidate, or `undefined` when none is claimable.
 */
export function selectClaimCandidate(tasks: readonly Task[]): Task | undefined {
  return tasks
    .filter(task => task.status === 'open' && task.claimedBySessionId === null)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
}

/** The dispatch prompt handed to a background subagent (W2). */
function renderDispatchPrompt(task: Task): string {
  const key = task.key ?? task.id
  return [
    `You were assigned task ${key} on the task board: ${task.title}.`,
    'Work on it in this session. When finished, report your result as your final message.',
    'Do not modify the task board yourself — the dispatcher records your outcome.',
    task.body === '' ? undefined : `\nTask description:\n${bounded(task.body)}`,
  ].filter(line => line !== undefined).join('\n')
}

/** The fallback follow-up turn handed to the claiming session (v0.3 path). */
function renderFollowup(task: Task): string {
  const key = task.key ?? task.id
  return [
    `You claimed ${key} on the task board: ${task.title}.`,
    'Work on it now in this session; report progress on the task when done.',
    task.body === '' ? undefined : `\nTask description:\n${bounded(task.body)}`,
  ].filter(line => line !== undefined).join('\n')
}

/** Bound free text quoted into the dispatch prompt. */
function bounded(text: string): string {
  return text.length <= BODY_PREVIEW_CHARS
    ? text
    : `${text.slice(0, BODY_PREVIEW_CHARS)}… (${text.length} chars total)`
}

/** Render a thrown value into a logger line. */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
