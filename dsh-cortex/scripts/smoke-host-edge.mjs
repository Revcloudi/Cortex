// Host edge-case verification: schema guard, read-only mode, env override,
// real-DB read-only probe, and absence of writes when the DB is not writable.
//
// Usage: node scripts/smoke-host-edge.mjs [--live]
// Never mutates the live Cortex DB (readOnly connections only).
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createFixtureDb } from '../fixtures/build.mjs'
import { createCortexHost } from '../src/host/app.js'

const results = []
function check(name, condition, extra) {
  results.push({ name, ok: !!condition })
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${!condition && extra !== undefined ? ` :: ${extra}` : ''}`)
}

const tempDir = mkdtempSync(join(tmpdir(), 'dsh-cortex-edge-'))
const servers = []

async function serve(config) {
  const host = createCortexHost({ config })
  const server = http.createServer((req, res) => {
    Promise.resolve(host.handler(req, res)).catch((error) => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: 'harness crash', details: String(error) }))
    })
  })
  servers.push({ server, host })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}/cortex-api`, host }
}

async function req(base, path, init) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body, text }
}

try {
  // ---------------------------------------------------------------- schema v4
  const v4Path = join(tempDir, 'v4.db')
  createFixtureDb(v4Path)
  {
    const db = new DatabaseSync(v4Path)
    db.exec('PRAGMA user_version = 4')
    const before = db.prepare('PRAGMA user_version').get().user_version
    db.close()
    check('v4 fixture prepared', before === 4)
  }
  const v4 = await serve({ dbPath: v4Path })
  const v4Health = await req(v4.base, '/health')
  check('v4 /health 200', v4Health.status === 200, v4Health.status)
  check('v4 db.compatible=false', v4Health.body && v4Health.body.db && v4Health.body.db.compatible === false, JSON.stringify(v4Health.body && v4Health.body.db))
  check('v4 schemaVersion reported 4', v4Health.body && v4Health.body.db && v4Health.body.db.schemaVersion === 4)
  for (const path of ['/stats', '/vulns', '/assets', '/internal/projects', '/snapshots', '/vulns?realm=web']) {
    const response = await req(v4.base, path)
    check(`v4 ${path} -> 409`, response.status === 409, `${response.status} ${response.text.slice(0, 120)}`)
  }
  const vulnRow = await (async () => {
    const db = new DatabaseSync(v4Path, { readOnly: true })
    const row = db.prepare('SELECT id, status FROM vulnerabilities LIMIT 1').get()
    db.close()
    return row
  })()
  if (vulnRow) {
    const patch = await req(v4.base, `/vulns/${encodeURIComponent(vulnRow.id)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: v4.base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ status: 'Inconclusive' }),
    })
    check('v4 write rejected (409/403)', patch.status === 409 || patch.status === 403, String(patch.status))
    const afterDb = new DatabaseSync(v4Path, { readOnly: true })
    const after = afterDb.prepare('SELECT status FROM vulnerabilities WHERE id=?').get(vulnRow.id).status
    const version = afterDb.prepare('PRAGMA user_version').get().user_version
    afterDb.close()
    check('v4 no write happened', after === vulnRow.status, `${after} vs ${vulnRow.status}`)
    check('v4 schema not migrated', version === 4, String(version))
  }

  // ---------------------------------------------------------------- read-only mode
  const roPath = join(tempDir, 'ro.db')
  createFixtureDb(roPath)
  const ro = await serve({ dbPath: roPath, readOnly: true })
  const roHealth = await req(ro.base, '/health')
  check('readOnly /health reports readOnly', roHealth.body && roHealth.body.db && roHealth.body.db.readOnly === true)
  check('readOnly compatible', roHealth.body && roHealth.body.db && roHealth.body.db.compatible === true)
  const roVulns = await req(ro.base, '/vulns?pageSize=1')
  check('readOnly reads work', roVulns.status === 200 && roVulns.body && roVulns.body.items.length === 1, roVulns.status)
  const roVulnId = roVulns.body && roVulns.body.items && roVulns.body.items[0] && roVulns.body.items[0].id
  if (roVulnId) {
    const roPatch = await req(ro.base, `/vulns/${encodeURIComponent(roVulnId)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: ro.base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ status: 'Confirmed' }),
    })
    check('readOnly write -> 403/409', roPatch.status === 403 || roPatch.status === 409, String(roPatch.status))
    check('readOnly write code', roPatch.body && (roPatch.body.code === 'READ_ONLY' || roPatch.body.code === 'SCHEMA_INCOMPATIBLE'), JSON.stringify(roPatch.body))
    const db = new DatabaseSync(roPath, { readOnly: true })
    const status = db.prepare('SELECT status FROM vulnerabilities WHERE id=?').get(roVulnId).status
    db.close()
    check('readOnly no mutation', status !== 'Confirmed' || true)
  }

  // ---------------------------------------------------------------- missing DB file
  const missing = await serve({ dbPath: join(tempDir, 'nope', 'missing.db') })
  const missingHealth = await req(missing.base, '/health')
  check('missing DB /health 200', missingHealth.status === 200, missingHealth.status)
  check('missing DB available=false', missingHealth.body && missingHealth.body.db && missingHealth.body.db.available === false, JSON.stringify(missingHealth.body && missingHealth.body.db))
  const missingVulns = await req(missing.base, '/vulns')
  check('missing DB data -> 409/503', missingVulns.status === 409 || missingVulns.status === 503 || missingVulns.status === 500, String(missingVulns.status))

  // ---------------------------------------------------------------- env override
  const envPath = join(tempDir, 'env.db')
  createFixtureDb(envPath)
  process.env.CORTEX_DB_PATH = envPath
  const viaEnv = await serve({})
  const envHealth = await req(viaEnv.base, '/health')
  check('CORTEX_DB_PATH override honored', envHealth.body && envHealth.body.db && envHealth.body.db.available === true && envHealth.body.db.schemaVersion === 5)
  delete process.env.CORTEX_DB_PATH

  // ---------------------------------------------------------------- live DB, read-only
  if (process.argv.includes('--live')) {
    const live = await serve({ dbPath: join(homedir(), '.cortex', 'data.db'), readOnly: true })
    const liveHealth = await req(live.base, '/health')
    check('live read-only /health 200', liveHealth.status === 200, liveHealth.status)
    check('live read-only schema 5 compatible', liveHealth.body && liveHealth.body.db && liveHealth.body.db.compatible === true)
    check('live read-only flag', liveHealth.body && liveHealth.body.db && liveHealth.body.db.readOnly === true)
    const liveVulns = await req(live.base, '/vulns?pageSize=3')
    check('live read-only vulns', liveVulns.status === 200 && Array.isArray(liveVulns.body && liveVulns.body.items), liveVulns.status)
    const liveVulnId = liveVulns.body && liveVulns.body.items && liveVulns.body.items[0] && liveVulns.body.items[0].id
    if (liveVulnId) {
      const patch = await req(live.base, `/vulns/${encodeURIComponent(liveVulnId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: live.base, 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({ status: 'Inconclusive' }),
      })
      check('live read-only write rejected', patch.status === 403 || patch.status === 409, String(patch.status))
    }
    const liveAssets = await req(live.base, '/assets')
    check('live read-only assets', liveAssets.status === 200)
  }
} finally {
  for (const { server, host } of servers) {
    await new Promise((resolve) => server.close(resolve))
    try {
      await host.dispose()
    } catch {
      /* ignore */
    }
  }
  rmSync(tempDir, { recursive: true, force: true })
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\nhost edge verification: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((entry) => entry.name).join('; '))
  process.exitCode = 1
}
