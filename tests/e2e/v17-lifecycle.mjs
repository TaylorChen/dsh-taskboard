#!/usr/bin/env node
/**
 * E2E v1.7 (P1/P2/P3, HTTP layer): against a running web instance —
 *   P1  POST /projects creates; tasks land in the new project; a task
 *       migrates via PATCH project_id; a non-empty project refuses DELETE.
 *   P2  PATCH note lands as a `noted` activity entry (the thread).
 *   P3  a task with next_task auto-creates its child on done.
 *
 * Env: BASE (default http://127.0.0.1:3099/api/taskboard).
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3099/api/taskboard'
const log = (line) => console.log(`[runner] ${line}`)
let failures = 0
const check = (name, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` <- ${detail}`}`)
  if (!ok) failures += 1
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try { json = text === '' ? {} : JSON.parse(text) } catch { json = { raw: text } }
  return { status: response.status, json }
}

// ---- P1: project lifecycle ----
const inbox = (await api('/board')).json.projects[0]
const created = await api('/projects', 'POST', { name: 'V17 Project' })
check('POST /projects creates', created.status === 201 && created.json.name === 'V17 Project', `HTTP ${created.status}`)
const newId = created.json.id

const t1 = await api('/task', 'POST', {
  title: 'V1.7 in new project', status: 'open', acceptance_criteria: ['p'],
  project_id: newId,
})
check('task created into the new project', t1.status === 201 && t1.json.projectId === newId, t1.json.projectId)
const filtered = (await api(`/board?project=${encodeURIComponent(newId)}`)).json
check('project filter sees the task', filtered.tasks.some(task => task.id === t1.json.id))

// While the task is still in the new project, DELETE must refuse.
const refused = await api(`/projects/${encodeURIComponent(newId)}`, 'DELETE')
check('non-empty project refuses DELETE', refused.status === 400, `HTTP ${refused.status} ${JSON.stringify(refused.json)}`)

const migrated = await api(`/task/${encodeURIComponent(t1.json.id)}`, 'PATCH', {
  project_id: inbox.id, expectedRevision: t1.json.revision,
})
check('task migrates projects', migrated.status === 200 && migrated.json.projectId === inbox.id)
const filtered2 = (await api(`/board?project=${encodeURIComponent(newId)}`)).json
check('old project no longer shows it', !filtered2.tasks.some(task => task.id === t1.json.id))

const emptyDelete = await api(`/projects/${encodeURIComponent(newId)}`, 'DELETE')
check('empty project deletes', emptyDelete.status === 200, `HTTP ${emptyDelete.status}`)

// ---- P2: comment/note lands in the activity stream ----
const t2 = await api('/task', 'POST', { title: 'V1.7 thread', status: 'open', acceptance_criteria: ['t'] })
const note = await api(`/task/${encodeURIComponent(t2.json.id)}`, 'PATCH', {
  note: 'please use the sqlite path', expectedRevision: t2.json.revision,
})
const activity = (await api(`/task/${encodeURIComponent(t2.json.id)}/activity`)).json
check('comment becomes a noted activity entry',
  note.status === 200 && activity.some(entry => entry.action === 'noted' && entry.to === 'please use the sqlite path'),
  `HTTP ${note.status}`)

// ---- P3: task chaining ----
const CHILD_TITLE = `V1.7 child ${Date.now()}`
const t3 = await api('/task', 'POST', {
  title: 'V1.7 parent', status: 'open', acceptance_criteria: ['p'],
  next_task: { title: CHILD_TITLE, acceptanceCriteria: ['c'] },
})
check('next_task accepted on create', t3.status === 201 && t3.json.nextTask?.title === CHILD_TITLE,
  `HTTP ${t3.status} nextTask=${JSON.stringify(t3.json.nextTask)} want=${CHILD_TITLE}`)
const done = await api(`/task/${encodeURIComponent(t3.json.id)}`, 'PATCH', {
  status: 'done', expectedRevision: t3.json.revision,
})
check('parent done clears nextTask + notes the chain',
  done.json.nextTask === null && (done.json.notes ?? '').includes('chained →'),
  `nextTask=${JSON.stringify(done.json.nextTask)}`)
const board = (await api('/board')).json
const child = board.tasks.find(task => task.title === CHILD_TITLE)
check('child auto-created', child !== undefined && child.status === 'open' && child.spec?.acceptanceCriteria?.includes('c'))
const childKey = child?.key
const doneAgain = await api(`/task/${encodeURIComponent(t3.json.id)}`, 'PATCH', {
  status: 'open', expectedRevision: done.json.revision,
})
await api(`/task/${encodeURIComponent(t3.json.id)}`, 'PATCH', { status: 'done', expectedRevision: doneAgain.json.revision })
const board2 = (await api('/board')).json
check('chain is idempotent (no second child)',
  board2.tasks.filter(task => task.title === CHILD_TITLE).length === 1, `childKey=${childKey}`)

log(`HTTP E2E: ${failures === 0 ? 'ALL PASS' : `FAILURES (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
