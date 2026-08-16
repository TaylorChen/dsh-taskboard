/**
 * `/task` — the human surface, dispatched without spending a model turn.
 *
 * Read subcommands (`list`, `show`, `export`) work anywhere. Write subcommands
 * reach the same gate as everything else, and under the default
 * `writePolicy: 'ask'` a command dispatched between turns is refused rather
 * than auto-allowed, because the approval seam's asked/decided audit pair must
 * sit inside an open turn. `import` is therefore documented as an `auto`-policy
 * or in-turn operation.
 *
 * `commands` is an OPTIONAL peer: a composition without it simply gets no slash
 * commands. Optionality is expressed with `ctx.inject([...], cb)`, which runs
 * the callback in a sub-fiber once the service exists and never runs it
 * otherwise. Reading `ctx.commands` behind a TypeScript optional would throw at
 * runtime — Cordis rejects a property read for a service this fiber did not
 * inject, rather than returning `undefined`.
 *
 * v0.2: status arguments validate against the seven-state machine, list shows
 * the short key instead of a truncated id, and `show` accepts the key or the
 * full id (the service resolves either).
 * @module @navidid/dsh-taskboard/src/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { TaskStatus } from './domain.ts'
import { TASK_STATUSES } from './domain.ts'
import { TaskboardError } from './errors.ts'
import type { TaskboardService } from './service.ts'

/**
 * Register the `/task` command once a commands registry exists.
 * @param ctx - plugin context; the registration runs in an injected sub-fiber.
 * @param service - the board service.
 * @param listLimit - default page size for `list`.
 */
export function registerCommands(
  ctx: Context,
  service: TaskboardService,
  listLimit: number,
): void {
  ctx.inject(['commands'], (scoped: Context) => {
    scoped.effect(() => scoped.commands.register({
      name: 'task',
      description: 'Browse the task board: list [status] · show <id|key> · export',
      handler: (invocation: CommandInvocation): CommandResult =>
        run(service, listLimit, invocation.rawInput.trim()),
    }), 'dsh-taskboard.commands')
  })
}

/** Dispatch one `/task` invocation. */
function run(service: TaskboardService, listLimit: number, input: string): CommandResult {
  const [verb = 'list', ...rest] = input.split(/\s+/).filter(part => part !== '')
  try {
    switch (verb) {
      case 'list': return listResult(service, listLimit, rest[0])
      case 'show': return showResult(service, rest[0])
      case 'export': return { kind: 'success', text: JSON.stringify(service.exportAll(), null, 2) }
      default: return { kind: 'error', text: `unknown subcommand '${verb}' (list | show | export)` }
    }
  } catch (error) {
    if (error instanceof TaskboardError) return { kind: 'error', text: `${error.code}: ${error.message}` }
    throw error
  }
}

/** Render one board column, or the whole board. */
function listResult(service: TaskboardService, limit: number, status?: string): CommandResult {
  if (status !== undefined && !isStatus(status)) {
    return { kind: 'error', text: `unknown status '${status}' (${TASK_STATUSES.join(' | ')})` }
  }
  const tasks = service.list({ status, limit })
  if (tasks.length === 0) return { kind: 'success', text: 'No matching tasks.' }
  const lines = tasks.map(task =>
    `${task.status.padEnd(15)} ${task.priority.padEnd(7)} ${(task.key ?? task.id).padEnd(6)}  ${task.title}`)
  return { kind: 'success', text: lines.join('\n') }
}

/** Render one task in full. */
function showResult(service: TaskboardService, ref?: string): CommandResult {
  if (ref === undefined) return { kind: 'error', text: 'usage: /task show <id|key>' }
  const task = service.get(ref)
  if (task === undefined) return { kind: 'error', text: `no task '${ref}'` }
  return {
    kind: 'success',
    text: [
      `${task.key ?? task.id}  ${task.title}`,
      `id ${task.id}  rev ${task.revision}`,
      `status ${task.status}  priority ${task.priority}`,
      task.labels.length > 0 ? `labels ${task.labels.join(', ')}` : '',
      task.blockedReason === null ? '' : `blocked: ${task.blockedReason}`,
      task.claimedBySessionId === null ? '' : `claimed by session ${task.claimedBySessionId}`,
      '',
      task.body,
    ].filter(line => line !== '').join('\n'),
  }
}

/** Narrow a raw argument to a board column. */
function isStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value)
}
