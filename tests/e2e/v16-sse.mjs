#!/usr/bin/env node
/**
 * E2E v1.6 C1 (SSE live push): connect to GET /api/taskboard/events, make a
 * taskboard write from another connection, and assert a `changed` event
 * arrives on the stream.
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

const controller = new AbortController()
const stream = await fetch(`${BASE}/events`, { signal: controller.signal })
check('events endpoint 200', stream.status === 200, `HTTP ${stream.status}`)
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
let sawConnected = false
let sawChanged = false
const deadline = Date.now() + 15_000

// Kick a write a moment after the stream is up.
setTimeout(async () => {
  await fetch(`${BASE}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'E2E v1.6 SSE probe', status: 'open', acceptance_criteria: ['p'] }),
  })
}, 800)

while (Date.now() < deadline && !sawChanged) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.startsWith('event: changed')) sawChanged = true
    if (line.startsWith(': connected')) sawConnected = true
  }
}
controller.abort()
check('stream opened (: connected)', sawConnected)
check('changed event received after a write', sawChanged)
console.log(failures === 0 ? 'E2E-V16-SSE-PASS' : `E2E-V16-SSE-FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
