/**
 * E2E v1.8 M2 (signed webhook): boot the e2e profile with a webhook pointed at
 * a local HTTP sink, create a task, and verify the sink received a payload
 * whose HMAC-SHA256 signature over `timestamp.body` validates with the shared
 * secret.
 *
 * Env: DSH_HOME, E2E_DSH_PACKAGE, E2E_APP_BOOT_PACKAGE, E2E_PROFILE.
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dshPackage = process.env.E2E_DSH_PACKAGE
const appBootPackage = process.env.E2E_APP_BOOT_PACKAGE
if (dshPackage === undefined || appBootPackage === undefined) {
  console.error('[runner] set E2E_DSH_PACKAGE and E2E_APP_BOOT_PACKAGE')
  process.exit(2)
}
const { runProfile } = await import(`${dshPackage}/lib/profile-boot-BnJoK_kl.js`)
const { loadLayeredEnv } = await import(`${appBootPackage}/lib/index.js`)
const log = (line) => console.log(`[runner] ${line}`)
let failures = 0
const check = (name, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` <- ${detail}`}`)
  if (!ok) failures += 1
}

// Local sink: captures the first POST.
const received = new Promise((resolve) => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      resolve({
        body,
        timestamp: req.headers['x-taskboard-timestamp'],
        signature: req.headers['x-taskboard-signature'],
        contentType: req.headers['content-type'],
      })
      server.close()
    })
  })
  server.listen(0, '127.0.0.1')
  server.unref()
  globalThis.__sink = server
})
const port = await new Promise(resolve => {
  const server = globalThis.__sink
  server.on('listening', () => resolve(server.address().port))
})

const SECRET = 'v18-secret'
const patch = join(mkdtempSync(join(tmpdir(), 'v18-')), 'patch.yml')
writeFileSync(patch, `- id: taskboard
  config:
    writePolicy: auto
    webhook:
      url: http://127.0.0.1:${port}/hook
      secret: ${SECRET}
- id: taskboard-autoclaim
  disabled: true
`)

const { ctx, shutdown } = await runProfile({
  profile: process.env.E2E_PROFILE ?? 'e2e',
  patchFiles: [patch],
  args: [],
  environment: loadLayeredEnv('dsh'),
})
const taskboard = ctx.get('taskboard')
if (taskboard === undefined) { console.error('[runner] missing taskboard'); process.exit(1) }

const human = { kind: 'human', via: 'panel' }
await taskboard.create({ projectId: taskboard.projects()[0]?.id, title: 'V1.8 webhook probe', acceptanceCriteria: ['w'] }, human)

const hit = await Promise.race([received, new Promise(resolve => setTimeout(() => resolve(null), 15_000))])
if (hit === null) {
  check('webhook delivered', false, 'timeout')
} else {
  check('webhook delivered', true, `content-type=${hit.contentType}`)
  const body = hit.body ?? ''
  const parsed = JSON.parse(body)
  check('payload carries the taskboard event', parsed.event === 'taskboard.changed' && parsed.domain === 'taskboard', body.slice(0, 120))
  const timestamp = hit.timestamp ?? ''
  const expected = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')
  check('signature verifies (HMAC-SHA256 over ts.body)', hit.signature === `sha256=${expected}`, hit.signature ?? '')
  check('timestamp present', timestamp !== '')
}

await shutdown.shutdown(0)
console.log(failures === 0 ? 'E2E-V18-WEBHOOK-PASS' : `E2E-V18-WEBHOOK-FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
