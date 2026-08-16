/**
 * The auto-claim driver (`@navidid/dsh-taskboard/autoclaim`): when an agent
 * session is idle and the deployment has mounted this row, claim the oldest
 * unclaimed `open` task for that session — provided the quota allows — and
 * hand it to the agent as a follow-up turn.
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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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

/** How much task body the follow-up turn quotes; the agent can re-read via tools. */
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
   * One serialized drive: quota check, then claim + dispatch the oldest open
   * task. Returns without side effects when anything is not ready.
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

    const candidate = selectClaimCandidate(ctx.taskboard.list({ status: 'open' }))
    if (candidate === undefined) return

    const claimed = await ctx.taskboard.autoClaim(candidate.id, agent.id)
    if (claimed === null) return // lost the claim to another session

    const key = claimed.key ?? claimed.id
    const text = [
      `You claimed ${key} on the task board: ${claimed.title}.`,
      'Work on it now in this session; report progress on the task when done.',
      claimed.body === '' ? undefined : `\nTask description:\n${bounded(claimed.body)}`,
    ].filter(line => line !== undefined).join('\n')
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
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
 * first. Pure so the scan order is unit-testable.
 * @param tasks - tasks to scan (any status; the filter is applied here).
 * @returns the claim candidate, or `undefined` when none is claimable.
 */
export function selectClaimCandidate(tasks: readonly Task[]): Task | undefined {
  return tasks
    .filter(task => task.status === 'open' && task.claimedBySessionId === null)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
}

/** Bound free text quoted into the follow-up turn. */
function bounded(text: string): string {
  return text.length <= BODY_PREVIEW_CHARS
    ? text
    : `${text.slice(0, BODY_PREVIEW_CHARS)}… (${text.length} chars total)`
}

/** Render a thrown value into a logger line. */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
