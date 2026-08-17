#!/usr/bin/env node
/**
 * E2E v1.3 D1/D2/D4 + C2 (HTTP layer): against a running web instance on the
 * taskboard's JSON API —
 *   D4  POST /api/taskboard/archive-done sweeps the done column;
 *   D1  /board?archived=true shows the archive and PATCH {archived:false}
 *       restores a card;
 *   D2  PATCH title/priority/executor/due_at edits a card;
 *   C2  a hand-edited storage file makes the next write answer 409
 *       concurrent-modification, and restoring the file unblocks it.
 *
 * Env: BASE (default http://127.0.0.1:3099/api/taskboard), MEDIUM (the
 * storage file to hand-edit for the C2 check).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3099/api/taskboard'
const MEDIUM = process.env.MEDIUM
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

// ---- D4: archive all done ----
const boardBefore = (await api('/board')).json
const doneBefore = boardBefore.tasks.filter(task => task.status === 'done').length
const sweep = await api('/archive-done', 'POST')
if (sweep.status !== 200 || typeof sweep.json.archived !== 'number') {
  bad('D4 archive-done route', `status ${sweep.status} body ${JSON.stringify(sweep.json)}`)
} else if (sweep.json.archived !== doneBefore) {
  bad('D4 archived count matches done column', `expected ${doneBefore} got ${sweep.json.archived}`)
} else {
  ok(`D4 archive-done -> {archived: ${sweep.json.archived}}`)
}
const boardAfter = (await api('/board')).json
const doneAfter = boardAfter.tasks.filter(task => task.status === 'done').length
if (doneAfter !== 0) {
  bad('D4 done column cleared', `still ${doneAfter} unarchived done tasks`)
} else {
  ok('D4 done column empty after sweep')
}

// ---- D1: archive view + restore ----
const archive = (await api('/board?archived=true')).json
const archivedTask = archive.tasks.find(task => task.status === 'done' && task.archivedAt !== null)
if (archivedTask === undefined) {
  bad('D1 archived view has archived tasks', 'none found after the sweep')
} else {
  ok(`D1 /board?archived=true shows ${archive.tasks.length} archived (${archivedTask.key})`)
  const restore = await api(`/task/${encodeURIComponent(archivedTask.id)}`, 'PATCH', {
    archived: false, expectedRevision: archivedTask.revision,
  })
  if (restore.status !== 200 || restore.json.archivedAt !== null) {
    bad('D1 restore', `status ${restore.status} archivedAt ${restore.json.archivedAt}`)
  } else {
    ok('D1 PATCH {archived:false} restores the card')
  }
  const back = (await api('/board')).json
  if (!back.tasks.some(task => task.id === archivedTask.id)) {
    bad('D1 restored card back on active board', 'not found')
  } else {
    ok('D1 restored card is on the active board')
  }
}

// ---- D2: edit a card ----
const editable = (await api('/board')).json.tasks[0]
if (editable === undefined) {
  bad('D2 needs a task', 'board empty')
} else {
  const edit = await api(`/task/${encodeURIComponent(editable.id)}`, 'PATCH', {
    title: `${editable.title} (v1.3 edited)`,
    priority: 'high',
    executor: 'agent',
    due_at: 1_999_999_999_000,
    expectedRevision: editable.revision,
  })
  if (edit.status !== 200) {
    bad('D2 edit', `status ${edit.status} ${JSON.stringify(edit.json)}`)
  } else if (edit.json.priority !== 'high' || edit.json.executor !== 'agent' || edit.json.dueAt !== 1_999_999_999_000) {
    bad('D2 fields stored', JSON.stringify({ priority: edit.json.priority, executor: edit.json.executor, dueAt: edit.json.dueAt }))
  } else {
    ok(`D2 PATCH edits title/priority/executor/due_at (${editable.key})`)
  }
}

// ---- C2: hand-edit the medium -> next write is 409 ----
if (MEDIUM !== undefined) {
  const original = readFileSync(MEDIUM, 'utf8')
  const edited = JSON.parse(original)
  edited.global = { ...edited.global, nextTaskNumber: (edited.global?.nextTaskNumber ?? 1) + 1 }
  writeFileSync(MEDIUM, JSON.stringify(edited, null, 2))
  const target = (await api('/board')).json.tasks[0]
  const clash = target === undefined
    ? await api('/task', 'POST', { title: 'E2E v1.3 C2 probe', status: 'open', acceptance_criteria: ['never'] })
    : await api(`/task/${encodeURIComponent(target.id)}`, 'PATCH', {
      title: `${target.title} C2`, expectedRevision: target.revision,
    })
  if (clash.status !== 409 || clash.json.code !== 'concurrent-modification') {
    bad('C2 stale write refused with 409', `status ${clash.status} ${JSON.stringify(clash.json)}`)
  } else {
    ok('C2 hand-edited medium -> 409 concurrent-modification')
  }
  writeFileSync(MEDIUM, original)
  const retry = target === undefined
    ? await api('/task', 'POST', { title: 'E2E v1.3 C2 retry', status: 'open', acceptance_criteria: ['now'] })
    : await api(`/task/${encodeURIComponent(target.id)}`, 'PATCH', {
      title: `${target.title} C2`, expectedRevision: target.revision,
    })
  if (retry.status !== 200) {
    bad('C2 restored medium -> write succeeds', `status ${retry.status} ${JSON.stringify(retry.json)}`)
  } else {
    ok('C2 after restoring the medium the write succeeds')
  }
}

log(`HTTP E2E: ${process.exitCode === 1 ? 'FAILURES' : 'ALL PASS'} (${pass} checks)`)
process.exit(process.exitCode ?? 0)
