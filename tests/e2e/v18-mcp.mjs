#!/usr/bin/env node
/**
 * E2E v1.8 M1 (MCP server): spawn bin/mcp-server.mjs over stdio, run a full
 * JSON-RPC session — initialize → tools/list → task_list → task_create →
 * task_update → task_stats — and verify results.
 *
 * Env: DSH_HOME (home with an e2e-like profile), DSH_PACKAGE, DSH_MCP_PROFILE
 * (default e2e — the profile must mount storage + taskboard).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const dshPackage = process.env.E2E_DSH_PACKAGE ?? process.env.DSH_PACKAGE
const profile = process.env.DSH_MCP_PROFILE ?? 'e2e'
if (dshPackage === undefined) {
  console.error('[runner] set E2E_DSH_PACKAGE')
  process.exit(2)
}
const log = (line) => console.log(`[runner] ${line}`)
let failures = 0
const check = (name, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` <- ${detail}`}`)
  if (!ok) failures += 1
}

const child = spawn(process.execPath, ['bin/mcp-server.mjs'], {
  env: { ...process.env, DSH_PACKAGE: dshPackage, DSH_MCP_PROFILE: profile },
  stdio: ['pipe', 'pipe', 'inherit'],
})
let buffer = ''
const pending = new Map()
let nextId = 1
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let idx
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (line.trim() === '') continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
})

try {
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  check('initialize', init?.serverInfo?.name === 'dsh-taskboard-mcp', JSON.stringify(init?.serverInfo))

  const tools = await rpc('tools/list')
  const names = tools?.tools?.map(tool => tool.name) ?? []
  check('tools/list exposes 7 tools', names.length === 7, names.join(','))
  check('task_create present', names.includes('task_create'))

  const listBefore = await rpc('tools/call', { name: 'task_list', arguments: {} })
  const beforeText = listBefore?.content?.[0]?.text ?? ''
  check('task_list works', typeof beforeText === 'string', beforeText.slice(0, 60))

  const created = await rpc('tools/call', {
    name: 'task_create',
    arguments: { title: 'E2E MCP task', status: 'open', acceptance_criteria: ['done via mcp'] },
  })
  const createText = created?.content?.[0]?.text ?? ''
  check('task_create works', createText.startsWith('Created TB-'), createText)

  const updated = await rpc('tools/call', {
    name: 'task_update',
    arguments: { id: 'TB-1', status: 'in_progress', expected_revision: 0 },
  })
  check('task_update works', (updated?.content?.[0]?.text ?? '').includes('in_progress'), JSON.stringify(updated?.content?.[0]?.text))

  const stats = await rpc('tools/call', { name: 'task_stats', arguments: {} })
  const statsText = stats?.content?.[0]?.text ?? ''
  check('task_stats works', statsText.includes('completionRate'), statsText.slice(0, 40))
} catch (error) {
  check('session completed', false, String(error))
} finally {
  child.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 300))
}
console.log(failures === 0 ? 'E2E-V18-MCP-PASS' : `E2E-V18-MCP-FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
