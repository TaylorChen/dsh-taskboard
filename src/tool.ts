/**
 * The model-facing half (`@navidid/dsh-taskboard/tool`): six tools over
 * `ctx.taskboard`. Mounted as its own cordis row so a deployment can run the
 * board as a human-only surface by disabling this row alone.
 *
 * Every write here goes through the service, which owns the approval gate —
 * nothing in this file may touch the medium. Enum-constrained parameters carry
 * their `enum` in the schema so the tool pipeline rejects an out-of-range value
 * before `execute` runs; model-supplied JSON is a validation boundary.
 *
 * Task references: `id` parameters accept the human-readable short key (`TB-1`)
 * or the full id alike, and every rendered output shows the key — the UUID is
 * never model-visible (ARCHITECTURE decisions 12 and 20).
 * @module @navidid/dsh-taskboard/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from './index.ts'
import type { Actor } from './service.ts'
import { TASK_PRIORITIES, TASK_STATUSES, type Task } from './domain.ts'
import { DEFAULT_LIST_LIMIT } from './defaults.ts'

/** Cordis plugin name. */
export const name = 'taskboard-tool'

/** Services required before the tools can register. */
export const inject = ['tools', 'taskboard']

/** Tool-half configuration. */
export interface Config {
  /** Ceiling on tasks returned by one `task_list` call. */
  listLimit: number
}

/** Loader schema with the deployment's defaults. */
export const Config: z<Config> = z.object({
  listLimit: z.number().step(1).min(1).default(DEFAULT_LIST_LIMIT),
})

/** The model-visible projection of a task: what a decision needs, nothing else. */
const taskValueSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true },
    priority: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    project_id: { type: 'string', required: true },
    acceptance_criteria: { type: 'array', items: { type: 'string' }, required: true },
  },
  additionalProperties: false,
} as const

/** One model-visible task. */
interface TaskView {
  key: string
  title: string
  status: string
  priority: string
  revision: number
  project_id: string
  acceptance_criteria: string[]
}

/**
 * Register the board tools.
 * @param ctx - context carrying the tool registry and `ctx.taskboard`.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'task_list',
    description:
      'List tasks on the cross-session task board. Unlike todo_write (scoped to the current '
      + 'session), these tasks persist across sessions and workspaces.',
    parameters: {
      status: {
        type: 'string',
        enum: TASK_STATUSES,
        description: 'Filter by board column',
      },
      project_id: { type: 'string', description: 'Filter by project id' },
      limit: {
        type: 'integer',
        description: `Maximum tasks to return (default ${config.listLimit})`,
      },
    },
    output: {
      schema: { type: 'array', items: taskValueSchema },
      // Keys are rendered IN FULL — see ARCHITECTURE decision 12: render is
      // the model's only view, and the key is what a later tool call references.
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? 'No matching tasks.'
          : value.map(t => [
            `[${t.status}] ${t.key} ${t.title} (rev ${t.revision})`,
            t.acceptance_criteria.length === 0 ? undefined : `    criteria: ${t.acceptance_criteria.join('; ')}`,
          ].filter(line => line !== undefined).join('\n')).join('\n'),
      }],
    },
    execute(args) {
      return Promise.resolve(ctx.taskboard.list({
        ...args.status === undefined ? {} : { status: args.status },
        ...args.project_id === undefined ? {} : { projectId: args.project_id },
        limit: args.limit ?? config.listLimit,
      }).map(summarize))
    },
  }))

  // Discovery: task_create needs a project id, and on an empty board no other
  // tool can surface one. Without this the model's only move is to guess.
  ctx.tools.register(defineTool({
    name: 'task_projects',
    description: 'List the projects tasks can be filed under. Call this to obtain a project_id.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            open_tasks: { type: 'integer', required: true },
          },
          additionalProperties: false,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? 'No projects.'
          : value.map(p => `${p.id}  ${p.name} (${p.open_tasks} open)`).join('\n'),
      }],
    },
    execute() {
      return Promise.resolve(ctx.taskboard.projects()
        .filter(project => !project.archived)
        .map(project => ({
          id: project.id,
          name: project.name,
          open_tasks: ctx.taskboard.list({ projectId: project.id })
            .filter(task => task.status !== 'done' && task.status !== 'cancelled').length,
        })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_create',
    description:
      'Create a task on the cross-session board. Requires human approval under the default '
      + 'write policy.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Owning project id' },
      title: { type: 'string', required: true, description: 'Short imperative summary' },
      body: { type: 'string', description: 'Full description' },
      acceptance_criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Checkable success conditions. Without at least one, the task lands in draft, not open.',
      },
      context_refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files, commits, or issues the executor should read (e.g. src/foo.ts, #42)',
      },
      definition_of_done: { type: 'string', description: 'Optional closing conditions text' },
      status: {
        type: 'string',
        enum: TASK_STATUSES,
        description: 'Board column to create in (default draft unless acceptance_criteria are given)',
      },
      priority: {
        type: 'string',
        enum: TASK_PRIORITIES,
        description: 'Task priority (default normal)',
      },
    },
    output: {
      schema: taskValueSchema,
      // v0.8 (L5): the create result also surfaces related completed tasks, so
      // the model can reuse what a previous execution learned instead of
      // exploring from scratch.
      render: (_args, value) => {
        const lines = [`Created ${value.key} — ${value.title}`]
        const related = ctx.taskboard.relatedExperience({ projectId: value.project_id, limit: 3 })
        if (related.length > 0) {
          lines.push('Related experience:')
          for (const card of related) {
            lines.push(`- ${card.key} ${card.title} — ${clip(card.summary, 120)}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const task = await ctx.taskboard.create({
        projectId: args.project_id,
        title: args.title,
        ...args.body === undefined ? {} : { body: args.body },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.priority === undefined ? {} : { priority: args.priority },
        ...args.acceptance_criteria === undefined
          ? {} : { acceptanceCriteria: args.acceptance_criteria },
        ...args.context_refs === undefined ? {} : { contextRefs: args.context_refs },
        ...args.definition_of_done === undefined
          ? {} : { definitionOfDone: args.definition_of_done },
        // v0.4 W1: an unbound task binds to the workspace owning this cwd
        // when the optional workspace seam is available.
        ...exec.agent?.session.header.cwd === undefined
          ? {}
          : { sessionCwd: exec.agent.session.header.cwd },
      }, actorOf(exec))
      return summarize(task)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_update',
    description:
      'Move a task between columns or edit its fields. Pass expected_revision (from task_list) '
      + 'to refuse the write if the task changed meanwhile. Moving a task into blocked requires '
      + 'a reason — use task_block for that. Requires human approval under the default write '
      + 'policy.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id or short key (e.g. TB-1)' },
      status: { type: 'string', enum: TASK_STATUSES, description: 'Move to this board column' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New description' },
      acceptance_criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Checkable success conditions; entering open requires at least one',
      },
      context_refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files, commits, or issues the executor should read',
      },
      definition_of_done: { type: 'string', description: 'Optional closing conditions text' },
      expected_revision: {
        type: 'integer',
        description: 'Revision the caller last read; a mismatch refuses the write',
      },
    },
    output: {
      schema: taskValueSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Updated ${value.key} — now ${value.status} (rev ${value.revision})`,
      }],
    },
    async execute(args, exec) {
      const specFields = {
        ...args.acceptance_criteria !== undefined && args.acceptance_criteria.length > 0
          ? { acceptanceCriteria: args.acceptance_criteria } : {},
        ...args.context_refs !== undefined && args.context_refs.length > 0
          ? { contextRefs: args.context_refs } : {},
        ...args.definition_of_done !== undefined
          ? { definitionOfDone: args.definition_of_done } : {},
      }
      const task = await ctx.taskboard.update(args.id, {
        ...args.status === undefined ? {} : { status: args.status },
        ...args.title === undefined ? {} : { title: args.title },
        ...args.body === undefined ? {} : { body: args.body },
        ...Object.keys(specFields).length > 0 ? { spec: specFields } : {},
        ...args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision },
      }, actorOf(exec))
      return summarize(task)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_claim',
    description:
      'Claim a task for the current session and move it to in_progress, so parallel sessions do '
      + 'not pick up the same work.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id or short key (e.g. TB-1)' },
    },
    output: {
      schema: taskValueSchema,
      render: (_args, value) => [{ type: 'text', text: `Claimed ${value.key} — ${value.title}` }],
    },
    async execute(args, exec) {
      const task = await ctx.taskboard.update(args.id, {
        status: 'in_progress',
        claimedBySessionId: exec.agent?.session.id ?? null,
        // v0.4 W1: an unbound task binds to the workspace owning this cwd.
        ...exec.agent?.session.header.cwd === undefined
          ? {}
          : { sessionCwd: exec.agent.session.header.cwd },
      }, actorOf(exec))
      return summarize(task)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_block',
    description:
      'Report a task as blocked: you are stuck and need a human to unblock you. Moves the task '
      + 'to the blocked column with the reason attached. Requires human approval under the '
      + 'default write policy.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id or short key (e.g. TB-1)' },
      reason: {
        type: 'string',
        required: true,
        description: 'Why you are stuck; shown on the task and to the human',
      },
    },
    output: {
      schema: taskValueSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `Blocked ${value.key} — now ${value.status} (rev ${value.revision})`,
      }],
    },
    async execute(args, exec) {
      const task = await ctx.taskboard.block(args.id, args.reason, actorOf(exec))
      return summarize(task)
    },
  }))
}

/**
 * Carry the execution's agent and cancellation into the service's actor face.
 * A root call always has an agent; the optionality is the registry's, so it is
 * forwarded rather than asserted away — a missing agent surfaces as the
 * service's own `write-denied` under `writePolicy: 'ask'`.
 */
function actorOf(exec: ToolRunContext): Actor {
  return {
    kind: 'agent',
    ...exec.agent === undefined ? {} : { agent: exec.agent },
    signal: exec.signal,
  }
}

/** Project one stored task onto the model-visible fields. */
function summarize(task: Task): TaskView {
  return {
    key: task.key ?? task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    revision: task.revision,
    project_id: task.projectId,
    acceptance_criteria: task.spec?.acceptanceCriteria ?? [],
  }
}

/** Bound text quoted into a rendered line. */
function clip(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`
}
