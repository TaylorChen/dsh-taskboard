/**
 * JSON API (`@navidid/dsh-taskboard/routes`) for the browser panel: three read
 * routes, two write routes, and one activity route.
 *
 * **Why writes are allowed here.** The approval gate is about the initiator,
 * not the surface: a model is not the authority over the board, a human is. A
 * write arriving on these routes came from the panel, so it is attributed to a
 * human actor and skips the gate — asking someone to approve their own click is
 * ceremony. `writePolicy: 'off'` still refuses, because that is a deployment
 * declaring the board read-only.
 *
 * **Cross-site protection.** The host web server ships no TLS, auth, or origin
 * policy (documented, deliberate for a loopback dev server), so a write route
 * must not be reachable from a page the user merely visits. Every write here
 * requires `content-type: application/json`, which is not a CORS-simple type:
 * a cross-origin caller must first pass a preflight, and this server answers
 * none. A same-origin panel fetch is unaffected.
 *
 * Task paths accept the short key (`/task/TB-1`) or the full id — the service
 * resolves either.
 * @module @navidid/dsh-taskboard/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from './index.ts'
import { TaskboardError } from './errors.ts'
import {
  TASK_PRIORITIES, TASK_STATUSES,
  type TaskExecutor, type TaskPriority, type TaskStatus,
} from './domain.ts'
import type { Actor } from './service.ts'

/** Cordis plugin name. */
export const name = 'taskboard-routes'

/**
 * Services required before the routes can mount. `workspaceRegistry` is a
 * web-only seam and this row is web-only (its headless sibling is disabled),
 * so a direct inject is safe here — unlike the always-active rows.
 */
export const inject = ['webServer', 'taskboard', 'workspaceRegistry']

/** Route prefix owned by this package. */
const BASE = '/api/taskboard'

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** Every write on these routes is the panel acting for the human at the keyboard. */
const PANEL: Actor = { kind: 'human', via: 'panel' }

/**
 * Mount the board's routes.
 * @param ctx - context carrying the web server and `ctx.taskboard`.
 */
export function apply(ctx: Context): void {
  const route = (path: string, kind: 'exact' | 'prefix', handler: WebHandler): void => {
    ctx.effect(
      () => ctx.webServer.register({ kind, path, handler }),
      `dsh-taskboard.routes${path}`,
    )
  }

  route(`${BASE}/board`, 'exact', (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const status = url.searchParams.get('status') ?? undefined
    const archived = url.searchParams.get('archived') === 'true'
    // v1.4 E1: project focus — filter the active board to one project.
    const project = url.searchParams.get('project') ?? undefined
    if (status !== undefined && !isStatus(status)) {
      return json(res, 400, { error: `unknown status '${status}'` })
    }
    return json(res, 200, {
      projects: ctx.taskboard.projects(),
      tasks: ctx.taskboard.list({
        ...status === undefined ? {} : { status },
        ...project === undefined ? {} : { projectId: project },
        ...archived ? { archived: true } : {},
      }),
      // v0.4 W1: workspace id -> display title, so the panel can name a
      // task's workspace without knowing the registry itself.
      workspaces: ctx.workspaceRegistry.list().map(workspace => ({
        id: workspace.id,
        name: workspace.title,
      })),
      // v1.1 A2: which subagent is running which task, so the panel can show
      // that an in-progress task is alive (or stuck).
      executions: ctx.taskboard.executions(),
    })
  })

  route(`${BASE}/export`, 'exact', (_req, res) => json(res, 200, ctx.taskboard.exportAll()))

  // v1.5 S1: board-level statistics — ratios, averages, trend, stuck, cost.
  route(`${BASE}/stats`, 'exact', (_req, res) => json(res, 200, ctx.taskboard.stats()))

  // v1.6 C1: server-sent events — every taskboard write pushes a `changed`
  // event so open panels refresh without polling. The connection stays open
  // (the handler never ends the response); the host webserver is a plain node
  // http server, so streaming works as-is.
  route(`${BASE}/events`, 'exact', (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'use GET for the event stream' })
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    const onChanged = (change: { domain?: string }): void => {
      if (change.domain !== 'taskboard') return
      res.write(`event: changed\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)
    }
    const dispose = ctx.on('domain/changed', onChanged)
    // SSE spec: a comment line every 25s keeps proxies from closing idle
    // connections.
    const heartbeat = setInterval(() => { res.write(': heartbeat\n\n') }, 25_000)
    heartbeat.unref?.()
    const cleanup = (): void => {
      clearInterval(heartbeat)
      dispose()
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
  })

  // v1.3 D4: one-click sweep of the done column — the panel's 归档全部 button.
  // A governance write like single-task archiving: human-initiated, no approval.
  route(`${BASE}/archive-done`, 'exact', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST to archive all done tasks' })
    const archived = await ctx.taskboard.archiveAllDone()
    json(res, 200, { archived })
  })

  // v1.4 E3: pin one column's manual order. The body names the column's FULL
  // ordered list (every task of that column), which becomes sortOrder 0..n-1.
  route(`${BASE}/reorder`, 'exact', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST to reorder a column' })
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    await guard(res, async () => {
      const refs = (body as Record<string, unknown>).refs
      if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string')) {
        throw new TaskboardError('invalid-input', 'refs must be an array of task ids or keys')
      }
      const reordered = await ctx.taskboard.reorder(refs as string[])
      json(res, 200, { reordered })
    })
  })

  // Create. POST so a link or an <img> can never reach it, and JSON-only so a
  // cross-origin form post cannot either.
  route(`${BASE}/task`, 'exact', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST to create a task' })
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    await guard(res, async () => {
      const input = body as Record<string, unknown>
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      if (title === '') throw new TaskboardError('invalid-input', 'title is required')
      const projectId = typeof input.projectId === 'string'
        ? input.projectId
        : ctx.taskboard.projects()[0]?.id
      if (projectId === undefined) throw new TaskboardError('not-found', 'the board has no project')
      const priority = isPriority(input.priority) ? input.priority : undefined
      const status = isStatus(input.status) ? input.status : undefined
      const task = await ctx.taskboard.create({
        projectId,
        title,
        ...typeof input.body === 'string' ? { body: input.body } : {},
        ...status === undefined ? {} : { status },
        ...priority === undefined ? {} : { priority },
        ...Array.isArray(input.acceptance_criteria)
          ? { acceptanceCriteria: input.acceptance_criteria as string[] } : {},
        ...Array.isArray(input.context_refs)
          ? { contextRefs: input.context_refs as string[] } : {},
        ...typeof input.definition_of_done === 'string'
          ? { definitionOfDone: input.definition_of_done } : {},
        ...Array.isArray(input.depends_on)
          ? { dependsOn: input.depends_on as string[] } : {},
        ...typeof input.budget_tokens === 'number'
          ? { budgetTokens: input.budget_tokens } : {},
        ...isExecutor(input.executor) ? { executor: input.executor } : {},
        ...typeof input.due_at === 'number' ? { dueAt: input.due_at } : {},
        ...typeof input.notes === 'string' ? { notes: input.notes } : {},
        ...typeof input.context_budget_tokens === 'number'
          ? { contextBudgetTokens: input.context_budget_tokens } : {},
      }, PANEL)
      json(res, 201, task)
    })
  })

  // Update one task; the reference (key or id) is the path tail. The prefix
  // path carries NO trailing slash — the web server documents `path` as
  // "absolute pathname, no trailing slash", and one added here simply never
  // matches. It may repeat the exact route's path because exact and prefix
  // live in separate tables and exact wins first, so POST /task lands above
  // and PATCH /task/<ref> here.
  route(`${BASE}/task`, 'prefix', async (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const tail = decodeURIComponent(url.pathname.slice(`${BASE}/task/`.length))
    if (tail === '') return json(res, 400, { error: 'missing task id' })

    // GET /task/<ref>/activity — the one read sub-path under /task/<ref>.
    const activityRef = tail.match(/^(.*)\/activity$/)
    if (activityRef !== null) {
      if (req.method !== 'GET') return json(res, 405, { error: 'use GET for the activity stream' })
      const task = ctx.taskboard.get(activityRef[1] as string)
      if (task === undefined) return json(res, 404, { error: `no task '${activityRef[1]}'` })
      return json(res, 200, ctx.taskboard.activityOf(task.id))
    }

    if (req.method === 'GET') {
      const task = ctx.taskboard.get(tail)
      return task === undefined
        ? json(res, 404, { error: `no task '${tail}'` })
        : json(res, 200, task)
    }
    if (req.method !== 'PATCH') return json(res, 405, { error: 'use GET or PATCH' })

    const body = await readJsonBody(req, res)
    if (body === undefined) return
    await guard(res, async () => {
      const input = body as Record<string, unknown>
      const status = isStatus(input.status) ? input.status : undefined
      const priority = isPriority(input.priority) ? input.priority : undefined
      // v1.2 C1: archiving is a governance write, not a field patch.
      if (typeof input.archived === 'boolean') {
        const archivedTask = await ctx.taskboard.archive(tail, input.archived)
        return json(res, 200, archivedTask)
      }
      const spec = {
        ...Array.isArray(input.acceptance_criteria)
          ? { acceptanceCriteria: input.acceptance_criteria as string[] } : {},
        ...Array.isArray(input.context_refs)
          ? { contextRefs: input.context_refs as string[] } : {},
        ...typeof input.definition_of_done === 'string'
          ? { definitionOfDone: input.definition_of_done } : {},
      }
      const task = await ctx.taskboard.update(tail, {
        ...status === undefined ? {} : { status },
        ...priority === undefined ? {} : { priority },
        ...typeof input.title === 'string' ? { title: input.title } : {},
        ...typeof input.body === 'string' ? { body: input.body } : {},
        ...typeof input.blockedReason === 'string' ? { blockedReason: input.blockedReason } : {},
        ...Object.keys(spec).length > 0 ? { spec } : {},
        ...Array.isArray(input.depends_on)
          ? { dependsOn: input.depends_on as string[] } : {},
        ...typeof input.budget_tokens === 'number'
          ? { budgetTokens: input.budget_tokens } : {},
        ...isExecutor(input.executor) ? { executor: input.executor } : {},
        ...typeof input.due_at === 'number' ? { dueAt: input.due_at } : {},
        ...typeof input.note === 'string' ? { note: input.note } : {},
        ...typeof input.context_budget_tokens === 'number'
          ? { contextBudgetTokens: input.context_budget_tokens } : {},
        ...typeof input.expectedRevision === 'number'
          ? { expectedRevision: input.expectedRevision }
          : {},
      }, PANEL)
      json(res, 200, task)
    })
  })
}

/** One HTTP handler as the web server expects it. */
type WebHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Read and parse a JSON request body, answering the response on any refusal.
 * @param req - the incoming request.
 * @param res - the response to answer on refusal.
 * @returns the parsed body, or `undefined` when the response was already sent.
 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  // The cross-site guard: `application/json` is not a CORS-simple content type,
  // so a cross-origin caller needs a preflight this server never answers.
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    json(res, 415, { error: 'content-type must be application/json' })
    return undefined
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      json(res, 413, { error: `body over ${MAX_BODY_BYTES} bytes` })
      return undefined
    }
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      json(res, 400, { error: 'body must be a JSON object' })
      return undefined
    }
    return parsed
  } catch {
    json(res, 400, { error: 'body is not valid JSON' })
    return undefined
  }
}

/**
 * Run a write, mapping this package's structured failures onto status codes.
 * @param res - the response to answer.
 * @param run - the write to attempt.
 */
async function guard(res: ServerResponse, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof TaskboardError)) throw error
    const status = {
      'not-found': 404,
      'revision-conflict': 409,
      'invalid-input': 400,
      'write-denied': 403,
      'unsupported-document': 400,
      'limit-exceeded': 409,
      // v1.3 C2: another process rewrote the medium; reload and retry.
      'concurrent-modification': 409,
    }[error.code]
    json(res, status, { error: error.message, code: error.code })
  }
}

/** Narrow a wire value to a board column. */
function isStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

/** Narrow a wire value to a priority. */
function isPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value)
}

/** Narrow a wire value to an executor. */
function isExecutor(value: unknown): value is TaskExecutor {
  return typeof value === 'string' && ['agent', 'human', 'any'].includes(value)
}

/** Write one JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
