// Host-half smoke harness: loads the real plugin entry with a fake Cordis context,
// serves the registered /cortex-api route on 127.0.0.1 and checks the contract.
//
// Usage: node scripts/smoke-host.mjs [fixtureDbPath]
// Never writes to the live Cortex DB: defaults to a temp DB built from fixtures/schema5.sql.
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixtureDb } from '../fixtures/build.mjs'
import * as plugin from '../index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-cortex-smoke-'))
const dbPath = process.argv[2] || join(tempDir, 'data.db')
const ownFixture = !process.argv[2]
if (ownFixture) createFixtureDb(dbPath)

const routes = []
const effects = []
const fakeWebServer = {
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
  getOrigin: () => 'http://127.0.0.1',
}
const fakeCtx = {
  effect(factory) {
    const dispose = factory()
    effects.push(dispose)
    return () => {}
  },
  inject(_deps, callback) {
    callback({ webServer: fakeWebServer })
  },
}

plugin.apply(fakeCtx, { dbPath })

if (routes.length !== 1) throw new Error(`expected one route, got ${routes.length}`)
const route = routes[0]
if (route.kind !== 'prefix' || route.path !== '/cortex-api') throw new Error(`unexpected route ${route.kind} ${route.path}`)

const server = http.createServer((req, res) => {
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.statusCode = 500
    res.end(JSON.stringify({ error: 'harness crash', code: 'HARNESS', details: String(error) }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}/cortex-api`

const results = []
function check(name, condition, extra) {
  results.push({ name, ok: !!condition, extra })
  if (!condition) console.error(`FAIL ${name}${extra ? ` :: ${extra}` : ''}`)
  else console.log(`ok   ${name}`)
}

async function json(path) {
  const res = await fetch(base + path, { headers: { Host: `127.0.0.1:${port}` } })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body, headers: res.headers }
}

const raw = async (path, init) => {
  const res = await fetch(base + path, {
    ...init,
    headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...(init && init.headers) },
  })
  return { status: res.status, text: await res.text() }
}

// `fetch` (undici) refuses to override the Host header, so the Host fence must
// be probed with a raw node:http request.
const rawHttp = (path, options) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/cortex-api' + path,
        method: (options && options.method) || 'GET',
        headers: (options && options.headers) || {},
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      },
    )
    request.on('error', reject)
    if (options && options.body) request.write(options.body)
    request.end()
  })

try {
  const health = await json('/health')
  check('health 200', health.status === 200, String(health.status))
  check('health schemaVersion 5', health.body && health.body.db && health.body.db.schemaVersion === 5, JSON.stringify(health.body && health.body.db))
  check('health compatible', health.body && health.body.db && health.body.db.compatible === true)
  check('health sqlite true', health.body && health.body.sqlite === true)
  check('health no absolute db path', !JSON.stringify(health.body).includes(tempDir.replace(/\\/g, '\\\\')), 'db path leaked')

  const stats = await json('/stats')
  check('stats 200', stats.status === 200)
  check('stats has counts', !!(stats.body && stats.body.counts), JSON.stringify(stats.body))

  const vulns = await json('/vulns?pageSize=5&page=1')
  check('vulns 200', vulns.status === 200)
  check('vulns items array', Array.isArray(vulns.body && vulns.body.items))
  check('vulns pageSize echo', vulns.body && vulns.body.pageSize === 5, JSON.stringify(vulns.body && vulns.body.pageSize))
  const first = vulns.body && vulns.body.items && vulns.body.items[0]
  check('vuln summary has camelCase fields', !!(first && first.vulnName !== undefined && first.createdAt !== undefined), JSON.stringify(first && Object.keys(first)))
  check('vuln summary has no secret key', !JSON.stringify(vulns.body).includes('"secret"'))

  if (first) {
    const detail = await json(`/vulns/${encodeURIComponent(first.id)}`)
    check('vuln detail 200', detail.status === 200)
    check('vuln detail has reproductionSteps', !!(detail.body && detail.body.vuln && typeof detail.body.vuln.reproductionSteps === 'string'))
    check('vuln detail has retestResults array', !!(detail.body && detail.body.vuln && Array.isArray(detail.body.vuln.retestResults)))
  }

  const assets = await json('/assets')
  check('assets 200', assets.status === 200)
  const assetHostPort = assets.body && assets.body.items && assets.body.items[0] && assets.body.items[0].hostPort
  if (assetHostPort) {
    const asset = await json(`/assets/${encodeURIComponent(assetHostPort)}`)
    check('asset detail 200', asset.status === 200)
    check('asset interfaces array', !!(asset.body && asset.body.asset && Array.isArray(asset.body.asset.interfaces)))
  }

  const internalProjects = await json('/internal/projects')
  check('internal projects 200', internalProjects.status === 200)
  const overview = await json('/internal/overview')
  check('internal overview 200', overview.status === 200)
  check('internal credentials masked only', !JSON.stringify(overview.body).includes('"secret"'))
  const graph = await json('/internal/graph')
  check('internal graph 200', graph.status === 200)

  const snapshots = await json('/snapshots?includeArchived=1')
  check('snapshots 200', snapshots.status === 200)
  const sessionId = snapshots.body && snapshots.body.sessions && snapshots.body.sessions[0] && snapshots.body.sessions[0].sessionId
  if (sessionId) {
    const snapshot = await json(`/snapshots/${encodeURIComponent(sessionId)}`)
    check('snapshot detail 200', snapshot.status === 200)
    check('snapshot nine fields', !!(snapshot.body && snapshot.body.session && snapshot.body.session.unfinishedTasks !== undefined && snapshot.body.session.failedPaths !== undefined && snapshot.body.session.testedInterfaces !== undefined))
  }

  if (first) {
    const report = await fetch(`${base}/reports/${encodeURIComponent(first.id)}`, { headers: { Host: `127.0.0.1:${port}` } })
    const markdown = await report.text()
    check('report 200 markdown', report.status === 200 && markdown.startsWith('#'), String(report.status))
    check('report attachment header', String(report.headers.get('content-disposition') || '').includes('attachment'))
  }

  // Bad query -> 400; unknown id -> 404
  const badPage = await json('/vulns?pageSize=1000')
  check('pageSize cap -> 400', badPage.status === 400, String(badPage.status))
  const missing = await json('/vulns/VULN-DOES-NOT-EXIST')
  check('missing vuln -> 404', missing.status === 404, String(missing.status))

  // Loopback fence: non-loopback Host header rejected.
  const badHost = await rawHttp('/health', { headers: { Host: 'evil.example.com' } })
  check('non-loopback Host -> 403', badHost.status === 403, String(badHost.status))
  const goodHost = await rawHttp('/health', { headers: { Host: `127.0.0.1:${port}` } })
  check('loopback Host -> 200', goodHost.status === 200, String(goodHost.status))

  // Writes
  if (first) {
    const originalStatus = first.status
    const targetStatus = originalStatus === 'Inconclusive' ? 'Confirmed' : 'Inconclusive'
    const patch = await raw(`/vulns/${encodeURIComponent(first.id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: targetStatus }),
    })
    check('status patch 200', patch.status === 200, `${patch.status} ${patch.text.slice(0, 200)}`)
    const after = await json(`/vulns/${encodeURIComponent(first.id)}`)
    check('status persisted', after.body && after.body.vuln && after.body.vuln.status === targetStatus, after.body && after.body.vuln && after.body.vuln.status)

    const retest = await raw(`/vulns/${encodeURIComponent(first.id)}/retest`, {
      method: 'POST',
      body: JSON.stringify({ timeRange: '2026-11-06 ~ 2026-11-06', conclusion: '### smoke retest\n\n- status: still reproducible' }),
    })
    check('retest append 200', retest.status === 200, `${retest.status} ${retest.text.slice(0, 200)}`)
    const afterRetest = await json(`/vulns/${encodeURIComponent(first.id)}`)
    check('retest appended', !!(afterRetest.body && afterRetest.body.vuln && afterRetest.body.vuln.retestResults && afterRetest.body.vuln.retestResults.length > 0))

    // cross-site write rejected
    const crossSite = await raw(`/vulns/${encodeURIComponent(first.id)}/status`, {
      method: 'PATCH',
      headers: { Origin: 'https://evil.example.com', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ status: 'Confirmed' }),
    })
    check('cross-site write -> 403', crossSite.status === 403, String(crossSite.status))

    // invalid status -> 400
    const badStatus = await raw(`/vulns/${encodeURIComponent(first.id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Hacked' }),
    })
    check('invalid status -> 400', badStatus.status === 400, String(badStatus.status))
  }
} finally {
  server.close()
  for (const dispose of effects) {
    try {
      if (typeof dispose === 'function') await dispose()
    } catch {
      /* ignore */
    }
  }
  if (ownFixture) rmSync(tempDir, { recursive: true, force: true })
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\nhost smoke: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exitCode = 1
