#!/usr/bin/env node
/**
 * E2E v1.4 E1/E3 (HTTP layer): against a running web instance —
 *   E1  /board?project=<id> filters to one project;
 *   E3  POST /api/taskboard/reorder pins a column's order and /board serves
 *       it; a partial reorder is refused.
 *
 * Env: BASE (default http://127.0.0.1:3099/api/taskboard).
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3099/api/taskboard'
const log = (line) => console.log(`[runner] ${line}`)
let pass = 0
const ok = (name) => { pass += 1; log(`PASS  ${name}`) }
const bad = (name, detail) => { console.error(`FAIL  ${name} <- ${detail}`); process.exitCode = 1 }

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

// ---- E1: project filter ----
const board = (await api('/board')).json
const projects = board.projects
if (projects.length === 0) {
  bad('E1 needs a project', 'board has none')
} else {
  const firstProject = projects[0]
  const filtered = (await api(`/board?project=${encodeURIComponent(firstProject.id)}`)).json
  const foreign = filtered.tasks.some(task => task.projectId !== firstProject.id)
  if (foreign) {
    bad('E1 project filter', 'a foreign project task leaked in')
  } else {
    ok(`E1 /board?project=<id> keeps only ${firstProject.name} (${filtered.tasks.length} tasks)`)
  }
  const composed = (await api(`/board?project=${encodeURIComponent(firstProject.id)}&archived=true`)).json
  if (composed.tasks.some(task => task.projectId !== firstProject.id)) {
    bad('E1 filter composition', 'project+archived leaked a foreign task')
  } else {
    ok('E1 project filter composes with archived=true')
  }
}

// ---- E3: reorder round-trip on the open column ----
const openTasks = (await api('/board')).json.tasks.filter(task => task.status === 'open')
if (openTasks.length < 2) {
  // Seed two open tasks so the round-trip is meaningful.
  const seeded = []
  for (let i = 0; i < 2; i += 1) {
    const created = await api('/task', 'POST', {
      title: `E2E v1.4 reorder ${i}`, status: 'open',
      acceptance_criteria: [`reorder seed ${i}`],
    })
    seeded.push(created.json)
  }
  openTasks.push(...seeded)
}
const column = openTasks.map(task => task.id)
const reversed = [...column].reverse()
const sweep = await api('/reorder', 'POST', { refs: reversed })
if (sweep.status !== 200 || sweep.json.reordered !== column.length) {
  bad('E3 reorder', `status ${sweep.status} ${JSON.stringify(sweep.json)}`)
} else {
  ok(`E3 POST /reorder pins ${column.length} tasks (rev=${sweep.json.reordered})`)
}
const afterOrder = (await api('/board')).json.tasks
  .filter(task => task.status === 'open').map(task => task.id)
if (afterOrder.join(',') !== reversed.join(',')) {
  bad('E3 /board serves the new order', `got ${afterOrder.join(',')} want ${reversed.join(',')}`)
} else {
  ok('E3 /board serves the reversed column order')
}
// Restore the original order to leave the board tidy.
await api('/reorder', 'POST', { refs: column })
const restoredOrder = (await api('/board')).json.tasks
  .filter(task => task.status === 'open').map(task => task.id)
if (restoredOrder.join(',') !== column.join(',')) {
  bad('E3 restore', `got ${restoredOrder.join(',')}`)
} else {
  ok('E3 restoring the order works')
}

// Partial reorder is refused (the panel only POSTs whole columns).
const partial = await api('/reorder', 'POST', { refs: column.slice(0, 1) })
if (partial.status !== 400) {
  bad('E3 partial reorder refused', `status ${partial.status} ${JSON.stringify(partial.json)}`)
} else {
  ok('E3 partial reorder refused (400)')
}

log(`HTTP E2E: ${process.exitCode === 1 ? 'FAILURES' : 'ALL PASS'} (${pass} checks)`)
process.exit(process.exitCode ?? 0)
