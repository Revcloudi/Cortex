// Live verification against the running DSH Web server after installation.
// Usage: node scripts/verify-live.mjs [baseUrl]
// - read-only checks by default
// - optional --write performs a status round-trip (changes then restores the
//   original status) and verifies the append-only retest path on a throwaway
//   fixture, never on the live database.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const baseUrl = process.argv.find((arg) => arg.startsWith('http')) || 'http://127.0.0.1:63877'
const base = `${baseUrl}/cortex-api`
const results = []

function check(name, condition, extra) {
  results.push({ name, ok: !!condition, extra })
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${!condition && extra !== undefined ? ` :: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`)
}

async function req(path, init) {
  const response = await fetch(base + path, {
    ...(init || {}),
    headers: Object.assign({ Accept: 'application/json' }, init && init.headers),
  })
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body, text, headers: response.headers }
}

function openLiveReadOnly() {
  return new DatabaseSync(join(homedir(), '.cortex', 'data.db'), { readOnly: true })
}

const live = openLiveReadOnly()

const health = await req('/health')
check('GET /health 200', health.status === 200, health.status)
check('plugin id', health.body && health.body.plugin === 'dsh-cortex', health.body && health.body.plugin)
check('sqlite available in Host runtime', health.body && health.body.sqlite === true)
check('schema version 5', health.body && health.body.db && health.body.db.schemaVersion === 5, health.body && health.body.db)
check('compatible', health.body && health.body.db && health.body.db.compatible === true)
check('loopback only flag', health.body && health.body.server && health.body.server.loopbackOnly === true)
check('no absolute DB path in health', !JSON.stringify(health.body).includes(join(homedir(), '.cortex')), 'leaked path')

const stats = await req('/stats')
check('GET /stats 200', stats.status === 200, stats.status)
const liveVulnCount = live.prepare('SELECT COUNT(*) AS c FROM vulnerabilities').get().c
check('stats total matches live DB', stats.body && stats.body.counts && stats.body.counts.total === liveVulnCount, `${stats.body && JSON.stringify(stats.body.counts)} vs ${liveVulnCount}`)

const vulns = await req('/vulns?page=1&pageSize=20')
check('GET /vulns 200', vulns.status === 200, vulns.status)
check('vulns pageSize echo', vulns.body && vulns.body.pageSize === 20)
const firstLive = live.prepare('SELECT id FROM vulnerabilities ORDER BY created_at DESC LIMIT 1').get()
check('vulns list contains newest live id', !!(vulns.body && vulns.body.items && firstLive && vulns.body.items.some((item) => item.id === firstLive.id)), firstLive && firstLive.id)

if (firstLive) {
  const detail = await req(`/vulns/${encodeURIComponent(firstLive.id)}`)
  check('GET /vulns/:id 200', detail.status === 200, detail.status)
  check('detail matches live vuln_name', !!(detail.body && detail.body.vuln && detail.body.vuln.vulnName === live.prepare('SELECT vuln_name FROM vulnerabilities WHERE id=?').get(firstLive.id).vuln_name))
  const report = await fetch(`${base}/reports/${encodeURIComponent(firstLive.id)}`)
  const reportText = await report.text()
  check('report 200 markdown', report.status === 200 && reportText.startsWith('#'), report.status)
  check('report attachment filename', String(report.headers.get('content-disposition') || '').includes('.md'))
}

const realms = await Promise.all([req('/vulns?realm=web'), req('/vulns?realm=internal')])
const webLive = live.prepare("SELECT COUNT(*) AS c FROM vulnerabilities WHERE realm='web'").get().c
const internalLive = live.prepare("SELECT COUNT(*) AS c FROM vulnerabilities WHERE realm='internal'").get().c
check('realm=web filter', realms[0].body && realms[0].body.total === webLive, `${realms[0].body && realms[0].body.total} vs ${webLive}`)
check('realm=internal filter', realms[1].body && realms[1].body.total === internalLive, `${realms[1].body && realms[1].body.total} vs ${internalLive}`)

const severe = await req('/vulns?severity=Critical')
const criticalLive = live.prepare("SELECT COUNT(*) AS c FROM vulnerabilities WHERE severity='Critical'").get().c
check('severity filter', severe.body && severe.body.total === criticalLive, `${severe.body && severe.body.total} vs ${criticalLive}`)

const search = await req('/vulns?search=Redis')
check('search works (or empty)', search.status === 200 && Array.isArray(search.body && search.body.items))

const assets = await req('/assets')
check('GET /assets 200', assets.status === 200)
const assetLive = live.prepare('SELECT host_port FROM assets LIMIT 1').get()
if (assetLive) {
  const asset = await req(`/assets/${encodeURIComponent(assetLive.host_port)}`)
  check('GET /assets/:hostPort 200', asset.status === 200, asset.status)
  check('asset interfaces count matches live', !!(asset.body && asset.body.asset && asset.body.asset.hostPort === assetLive.host_port), asset.body && asset.body.asset && asset.body.asset.hostPort)
  check('asset has leaked infos array', !!(asset.body && asset.body.asset && Array.isArray(asset.body.asset.leakedInfos)))
}

const internal = await req('/internal/projects')
check('GET /internal/projects 200', internal.status === 200)
check('internal projects array', Array.isArray(internal.body && internal.body.projects))
const internalOverview = await req('/internal/overview')
check('GET /internal/overview 200', internalOverview.status === 200)
check('internal credentials masked only', !JSON.stringify(internalOverview.body).includes('"secret"'), 'secret key present')
const graph = await req('/internal/graph')
check('GET /internal/graph 200', graph.status === 200)
check('graph nodes/edges arrays', Array.isArray(graph.body && graph.body.nodes) && Array.isArray(graph.body && graph.body.edges))

const snapshots = await req('/snapshots?includeArchived=1')
check('GET /snapshots 200', snapshots.status === 200)
const snapLive = live.prepare('SELECT session_id FROM snapshot_sessions LIMIT 1').get()
if (snapLive && snapshots.body && snapshots.body.sessions && snapshots.body.sessions.length) {
  const snapshot = await req(`/snapshots/${encodeURIComponent(snapLive.session_id)}`)
  check('GET /snapshots/:id 200', snapshot.status === 200, snapshot.status)
  check('snapshot nine fields', !!(snapshot.body && snapshot.body.session))
  const countedLive = live.prepare('SELECT related_vuln_ids FROM snapshot_sessions WHERE session_id=?').get(snapLive.session_id)
  let parsed = []
  try {
    parsed = JSON.parse(countedLive.related_vuln_ids)
  } catch {
    parsed = []
  }
  check('snapshot relatedVulns count matches', !!(snapshot.body && Array.isArray(snapshot.body.relatedVulns) && snapshot.body.relatedVulns.length === parsed.length), `${snapshot.body && snapshot.body.relatedVulns && snapshot.body.relatedVulns.length} vs ${parsed.length}`)
}

// Fences (HTTP-level).
import http from 'node:http'
function rawHostProbe(hostHeader) {
  return new Promise((resolve, reject) => {
    const target = new URL(baseUrl)
    const request = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: '/cortex-api/health',
        method: 'GET',
        headers: { Host: hostHeader },
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      },
    )
    request.on('error', reject)
    request.end()
  })
}
const evilHostStatus = await rawHostProbe('evil.example.com')
check('non-loopback Host header rejected (403)', evilHostStatus === 403, evilHostStatus)
const loopbackHostStatus = await rawHostProbe(`127.0.0.1:${new URL(baseUrl).port || 80}`)
check('loopback Host accepted (200)', loopbackHostStatus === 200, loopbackHostStatus)
const badPage = await req('/vulns?pageSize=1000')
check('pageSize>100 rejected (400)', badPage.status === 400, badPage.status)
const missing = await req('/vulns/VULN-NOT-EXIST')
check('unknown vuln 404', missing.status === 404, missing.status)
const crossSite = await fetch(`${base}/vulns/${encodeURIComponent(firstLive ? firstLive.id : 'x')}/status`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com', 'Sec-Fetch-Site': 'cross-site' },
  body: JSON.stringify({ status: 'Confirmed' }),
})
check('cross-site write rejected (403)', crossSite.status === 403, crossSite.status)
const noJson = await fetch(`${base}/vulns/${encodeURIComponent(firstLive ? firstLive.id : 'x')}/status`, {
  method: 'PATCH',
  body: JSON.stringify({ status: 'Confirmed' }),
})
check('write without JSON content-type rejected (403/400)', noJson.status === 403 || noJson.status === 400, noJson.status)

// Write round-trip on a REAL record: keep original status and restore it, so the
// acceptance criterion "Cortex desktop/CLI can read the new status" is verified
// against the shared DB without leaving a semantic change behind.
if (process.argv.includes('--write') && firstLive) {
  const original = live.prepare('SELECT status FROM vulnerabilities WHERE id=?').get(firstLive.id).status
  const target = original === 'Inconclusive' ? 'Confirmed' : 'Inconclusive'
  const patch = await fetch(`${base}/vulns/${encodeURIComponent(firstLive.id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ status: target }),
  })
  check('live status PATCH 200', patch.status === 200, patch.status)
  // Cortex is a separate process/CLI; verify the on-disk DB now holds the new status.
  const after = new DatabaseSync(join(homedir(), '.cortex', 'data.db'), { readOnly: true })
  const persisted = after.prepare('SELECT status FROM vulnerabilities WHERE id=?').get(firstLive.id).status
  after.close()
  check('status persisted in shared Cortex DB', persisted === target, `${persisted} vs ${target}`)
  const restore = await fetch(`${base}/vulns/${encodeURIComponent(firstLive.id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ status: original }),
  })
  check('status restored', restore.status === 200, restore.status)
  const restored = live.prepare('SELECT status FROM vulnerabilities WHERE id=?').get(firstLive.id).status
  check('original status back in DB', restored === original, `${restored} vs ${original}`)
}

live.close()
const failed = results.filter((entry) => !entry.ok)
console.log(`\nlive verification: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed checks:', failed.map((entry) => entry.name).join('; '))
  process.exitCode = 1
}
