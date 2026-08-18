#!/usr/bin/env node
/**
 * MCP server for the task board (v1.8 M1): a STANDALONE stdio server speaking
 * Model Context Protocol (JSON-RPC 2.0, newline-delimited) over stdin/stdout,
 * so any MCP client — Claude Desktop, Claude Code, dsh's own mcp-client —
 * can manage the board through `ctx.taskboard`.
 *
 * Boots a dsh profile that carries the storage + taskboard rows (autoclaim is
 * the deployment's choice; the default `mcp` profile should keep it off so the
 * external agent drives explicitly). Writes pass the normal approval gate:
 * under `writePolicy: auto` they land directly (headless-friendly); under
 * `ask` they are refused with a clear message (MCP has no approval surface).
 *
 * Env: DSH_HOME (the home whose profile to boot), DSH_PACKAGE (path to the dsh
 * package, for runProfile), DSH_MCP_PROFILE (default `mcp`).
 */
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

const dshPackage = process.env.DSH_PACKAGE
if (dshPackage === undefined) {
  console.error('dsh-taskboard-mcp: set DSH_PACKAGE to the dsh package path (e.g. the npx checkout @deepseek-ai/dsh)')
  process.exit(2)
}
const { runProfile } = await import(`${dshPackage}/lib/profile-boot-BnJoK_kl.js`)
const { loadLayeredEnv } = await import(`${dshPackage}/../dsh-app-boot/lib/index.js`)

const { ctx, shutdown } = await runProfile({
  profile: process.env.DSH_MCP_PROFILE ?? 'mcp',
  patchFiles: [],
  args: [],
  environment: loadLayeredEnv('dsh'),
})
const taskboard = ctx.get('taskboard')
if (taskboard === undefined) {
  console.error(`dsh-taskboard-mcp: profile '${process.env.DSH_MCP_PROFILE ?? 'mcp'}' did not mount the taskboard service (storage + taskboard rows required)`)
  await shutdown.shutdown(1)
  process.exit(1)
}

const MCP_ACTOR = { kind: 'agent', agent: { id: 'mcp' } }

const TOOL_DEFS = [
  {
    name: 'task_list',
    description: 'Read the board: tasks with key/title/status, optionally filtered by project_id or status.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, status: { type: 'string' } } },
    run: (args) => taskboard.list({
      ...typeof args.project_id === 'string' ? { projectId: args.project_id } : {},
      ...typeof args.status === 'string' ? { status: args.status } : {},
    }).map(task => `${task.key ?? task.id} [${task.status}] ${task.title}`).join('\n'),
  },
  {
    name: 'task_create',
    description: 'Add a task. Without acceptance_criteria it lands in draft; with them and status open it is claimable.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string' },
        status: { type: 'string' }, acceptance_criteria: { type: 'array', items: { type: 'string' } },
        project_id: { type: 'string' },
        next_task: { type: 'object' },
      },
      required: ['title'],
    },
    run: async (args) => {
      const task = await taskboard.create({
        projectId: args.project_id ?? taskboard.projects()[0]?.id ?? '',
        title: args.title,
        ...args.body === undefined ? {} : { body: args.body },
        ...args.priority === undefined ? {} : { priority: args.priority },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.acceptance_criteria === undefined ? {} : { acceptanceCriteria: args.acceptance_criteria },
        ...args.next_task === undefined ? {} : { nextTask: args.next_task },
      }, MCP_ACTOR)
      return `Created ${task.key} — ${task.title} (${task.status})`
    },
  },
  {
    name: 'task_update',
    description: 'Move a task between columns or edit fields. Pass expected_revision (from task_list stats) to refuse stale writes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, status: { type: 'string' }, title: { type: 'string' },
        body: { type: 'string' }, note: { type: 'string' }, priority: { type: 'string' },
        executor: { type: 'string' }, due_at: { type: 'integer' }, project_id: { type: 'string' },
        expected_revision: { type: 'integer' },
      },
      required: ['id'],
    },
    run: async (args) => {
      const task = await taskboard.update(args.id, {
        ...args.status === undefined ? {} : { status: args.status },
        ...args.title === undefined ? {} : { title: args.title },
        ...args.body === undefined ? {} : { body: args.body },
        ...args.note === undefined ? {} : { note: args.note },
        ...args.priority === undefined ? {} : { priority: args.priority },
        ...args.executor === undefined ? {} : { executor: args.executor },
        ...args.due_at === undefined ? {} : { dueAt: args.due_at },
        ...args.project_id === undefined ? {} : { projectId: args.project_id },
        ...args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision },
      }, MCP_ACTOR)
      return `Updated ${task.key ?? task.id} — now ${task.status} (rev ${task.revision})`
    },
  },
  {
    name: 'task_claim',
    description: 'Claim a task for the given session (default mcp) and move it to in_progress.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, session_id: { type: 'string' } }, required: ['id'] },
    run: async (args) => {
      const claimed = await taskboard.autoClaim(args.id, args.session_id ?? 'mcp')
      if (claimed === null) return `task ${args.id} was not claimable`
      return `Claimed ${claimed.key ?? claimed.id}`
    },
  },
  {
    name: 'task_block',
    description: 'Report a task as blocked with the reason (agent report; human unblocks).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
    run: async (args) => {
      const task = await taskboard.block(args.id, args.reason, MCP_ACTOR)
      return `Blocked ${task.key ?? task.id}: ${args.reason}`
    },
  },
  {
    name: 'task_comment',
    description: 'Append a comment to a task. It lands in the notes, which the next dispatched agent reads.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] },
    run: async (args) => {
      const task = await taskboard.update(args.id, { note: args.note }, MCP_ACTOR)
      return `Commented on ${task.key ?? task.id}`
    },
  },
  {
    name: 'task_stats',
    description: 'Board statistics: ratios, averages, trend, stuck, cost.',
    inputSchema: { type: 'object', properties: {} },
    run: () => JSON.stringify(taskboard.stats(), null, 2),
  },
]

const TOOL_INDEX = new Map(TOOL_DEFS.map(tool => [tool.name, tool]))

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function errorResult(message, detail) {
  return {
    content: [{ type: 'text', text: `${message}${detail === undefined ? '' : ` — ${detail}`}` }],
    isError: true,
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (line.trim() === '') return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dsh-taskboard-mcp', version: '1.8.0' } } })
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })
    } else if (method === 'tools/call') {
      const tool = TOOL_INDEX.get(params?.name)
      if (tool === undefined) {
        send({ jsonrpc: '2.0', id, result: errorResult(`unknown tool ${params?.name}`) })
        return
      }
      try {
        const text = await tool.run(params?.arguments ?? {})
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
      } catch (error) {
        send({ jsonrpc: '2.0', id, result: errorResult(error instanceof Error ? error.message : String(error)) })
      }
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
    // Notifications (no id): accepted silently.
  } catch (error) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } })
  }
})
process.stdin.on('end', () => { void shutdown.shutdown(0) })
