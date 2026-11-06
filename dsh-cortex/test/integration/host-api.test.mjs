/**
 * End-to-end integration tests for the Host half.
 *
 * Starts a REAL `node:http` server on 127.0.0.1:0 that calls the real
 * `createCortexHost({ config }).handler`, backed by a throwaway fixture DB
 * (fixtures/build.mjs → schema v5 + seed.json), and exercises every
 * `/cortex-api` endpoint from the contract, including:
 *   - health / stats / vulns (filters + pagination) / vulns/:id / assets /
 *     internal / snapshots / reports / retest-send
 *   - write path: PATCH status + append-only POST retest (asserted against DB)
 *   - schema guard (v4 → 409, no writes), read-only mode (403), loopback fences
 *   - credential secret never leaks in any JSON response
 *
 * The DB file is always a temp fixture; the live ~/.cortex DB is never touched.
 *
 * Run: node --test test/integration/
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

import { createFixtureDb, FIXTURE } from '../../fixtures/build.mjs'
import { createCortexHost } from '../../src/host/app.js'

// ---------------------------------------------------------------- helpers

let tempDir
let dbPath
let origin
let server
let host

let readOnlyOrigin
let readOnlyServer
let readOnlyHost

let schemaOrigin
let schemaServer
let schemaHost

let retestServer
let retestOrigin

const RETEST_TARGET = () => `${retestOrigin}/redirect`

function startHostServer(instance) {
  const httpServer = createServer((req, res) => {
    Promise.resolve()
      .then(() => instance.handler(req, res))
      .catch(() => {
        try {
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json; charset=utf-8')
          }
          res.end(JSON.stringify({ error: 'internal error', code: 'INTERNAL' }))
        } catch {
          /* socket already gone */
        }
      })
  })
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      resolve({
        server: httpServer,
        origin: `http://127.0.0.1:${httpServer.address().port}`,
      })
    })
  })
}

function closeServer(httpServer) {
  return new Promise((resolve) => httpServer.close(() => resolve()))
}

/** Fetch an endpoint under /cortex-api and return status/headers/raw text/JSON. */
async function api(baseOrigin, path, options = {}) {
  const headers = Object.assign({}, options.headers)
  const init = { method: options.method || 'GET', headers, redirect: 'manual' }
  if (options.body !== undefined) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json'
    }
  }
  const response = await fetch(`${baseOrigin}/cortex-api${path}`, init)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text,
    json,
  }
}

/** Raw HTTP request (needed to forge Host/Origin headers, which fetch forbids). */
function rawRequest(baseOrigin, options = {}) {
  const url = new URL(baseOrigin)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: options.path || '/cortex-api/health',
        method: options.method || 'GET',
        headers: Object.assign({ Host: url.host }, options.headers),
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.on('error', reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}

function readDb() {
  return new DatabaseSync(dbPath, { readOnly: true })
}

function readRetestResults(vulnId) {
  const db = readDb()
  try {
    const row = db.prepare('SELECT retest_results FROM vulnerabilities WHERE id = ?').get(vulnId)
    return row ? JSON.parse(row.retest_results) : null
  } finally {
    db.close()
  }
}

function readVulnRow(vulnId) {
  const db = readDb()
  try {
    return db.prepare('SELECT * FROM vulnerabilities WHERE id = ?').get(vulnId)
  } finally {
    db.close()
  }
}

const SUMMARY_KEYS = [
  'id',
  'host',
  'vulnName',
  'vulnType',
  'severity',
  'status',
  'realm',
  'serviceHost',
  'targetUrl',
  'entryPoint',
  'createdAt',
  'retestCount',
  'latestRetestAt',
]

const DETAIL_KEYS = [
  ...SUMMARY_KEYS,
  'description',
  'impact',
  'affectedInterfaces',
  'reproductionSteps',
  'remediation',
  'cryptoDetails',
  'testBoundaries',
  'retestResults',
  'relatedVulnIds',
  'internalServiceId',
]

function assertKeys(object, keys, label) {
  assert.ok(object && typeof object === 'object', `${label} is an object`)
  for (const key of keys) {
    assert.ok(key in object, `${label} has field ${key}`)
  }
}

// ---------------------------------------------------------------- lifecycle

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-cortex-integration-'))
  dbPath = join(tempDir, 'data.db')
  createFixtureDb(dbPath)

  // Throwaway outbound target for /retest/send (redirect + 200 endpoints).
  retestServer = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/final', 'X-Fixture': 'redirect-step' })
      response.end('redirecting')
      return
    }
    if (request.url === '/final') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Fixture': 'final-step' })
      response.end('final-response-body')
      return
    }
    if (request.url === '/json') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ fixture: true }))
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('not found')
  })
  retestServer.listen(0, '127.0.0.1')
  await once(retestServer, 'listening')
  retestOrigin = `http://127.0.0.1:${retestServer.address().port}`

  // The retest-send allowlist is derived from the vulnerability target_url, so
  // point the fixture vulnerability at the throwaway server before the Host
  // opens the DB. This is a disposable temp fixture, never the live DB.
  {
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE vulnerabilities SET target_url = ? WHERE id = ?').run(
      `${retestOrigin}/redirect`,
      FIXTURE.vulnForRetestSend,
    )
    db.close()
  }

  host = createCortexHost({ config: { dbPath, readOnly: false } })
  ;({ server, origin } = await startHostServer(host))

  // Read-only Host against the same fixture.
  readOnlyHost = createCortexHost({ config: { dbPath, readOnly: true } })
  ;({ server: readOnlyServer, origin: readOnlyOrigin } = await startHostServer(readOnlyHost))

  // Schema-v4 fixture: every data endpoint must 409 and never write.
  const schemaPath = join(tempDir, 'schema4.db')
  createFixtureDb(schemaPath, { schemaVersion: 4 })
  schemaHost = createCortexHost({ config: { dbPath: schemaPath } })
  ;({ server: schemaServer, origin: schemaOrigin } = await startHostServer(schemaHost))
})

after(async () => {
  for (const httpServer of [server, readOnlyServer, schemaServer, retestServer]) {
    if (httpServer) await closeServer(httpServer)
  }
  for (const instance of [host, readOnlyHost, schemaHost]) {
    if (instance && typeof instance.dispose === 'function') {
      try {
        await instance.dispose()
      } catch {
        /* ignore */
      }
    }
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// ---------------------------------------------------------------- health / stats

test('GET /health exposes plugin, DSH and schema-v5 metadata', async () => {
  const { status, headers, json } = await api(origin, '/health')
  assert.equal(status, 200)
  assert.match(headers['content-type'], /application\/json/)
  assert.match(headers['cache-control'] || '', /no-store/)
  assert.equal(headers['access-control-allow-origin'], undefined, 'no CORS headers')

  assert.equal(json.ok, true)
  assert.equal(json.plugin, 'dsh-cortex')
  assert.equal(json.sqlite, true)
  assert.equal(json.dsh.version, '0.2.2-rc.1')
  assert.equal(json.db.available, true)
  assert.equal(json.db.schemaVersion, 5)
  assert.equal(json.db.compatible, true)
  assert.equal(json.db.readOnly, false)
  assert.equal(json.server.loopbackOnly, true)
  assert.equal(typeof json.server.time, 'string')
  assert.equal(json.db.dbFile, 'data.db', 'dbFile is a basename, never an absolute path')
  assert.ok(!JSON.stringify(json).includes(tempDir), 'health never leaks the absolute DB path')
})

test('GET /stats aggregates web/internal, severity, status, hosts, assets and recent', async () => {
  const { status, json } = await api(origin, '/stats')
  assert.equal(status, 200)
  assert.equal(json.counts.total, 9)
  assert.equal(json.counts.web, 7)
  assert.equal(json.counts.internal, 2)
  assert.equal(json.bySeverity.Critical, 2)
  assert.equal(json.bySeverity.High, 3)
  assert.equal(json.bySeverity.Medium, 2)
  assert.equal(json.bySeverity.Low, 1)
  assert.equal(json.bySeverity.Info, 1)
  assert.equal(json.byStatus.Confirmed, 6)
  assert.equal(json.byStatus.Inconclusive, 2)
  assert.equal(json.byStatus.Retest_Passed, 1)
  assert.ok(json.hosts >= 1)
  assert.equal(json.assets, 2)
  assert.ok(json.projects.includes(FIXTURE.webProject))
  assert.ok(Array.isArray(json.recent))
  assert.ok(json.recent.length >= 1 && json.recent.length <= 8)
  for (const item of json.recent) assertKeys(item, SUMMARY_KEYS, 'stats.recent[]')

  // realm filter: `counts` stays global for the overview banner (documented in
  // repository.stats), while severity/status distributions + recent are narrowed.
  const internal = await api(origin, '/stats?realm=internal')
  assert.equal(internal.json.counts.total, 9)
  assert.equal(internal.json.bySeverity.Critical, 1)
  assert.equal(internal.json.bySeverity.High, 1)
  assert.equal(internal.json.bySeverity.Medium, 0)
  assert.equal(internal.json.recent.length, 2)
  assert.ok(internal.json.recent.every((item) => item.realm === 'internal'))
  const web = await api(origin, '/stats?realm=web')
  assert.equal(web.json.counts.total, 9)
  assert.equal(web.json.bySeverity.Critical, 1)
  assert.equal(web.json.bySeverity.High, 2)
  assert.ok(web.json.recent.every((item) => item.realm === 'web'))
  const all = await api(origin, '/stats?realm=all')
  assert.equal(all.json.counts.total, 9)
  assert.equal(all.json.recent.length, 8)
  const bad = await api(origin, '/stats?realm=bogus')
  assert.equal(bad.status, 400)
  assert.equal(bad.json.code, 'BAD_REQUEST')
})

// ---------------------------------------------------------------- vulns

test('GET /vulns supports filters + pagination and returns complete summaries', async () => {
  const page1 = await api(origin, '/vulns?pageSize=5&page=1')
  assert.equal(page1.status, 200)
  assert.equal(page1.json.total, 9)
  assert.equal(page1.json.page, 1)
  assert.equal(page1.json.pageSize, 5)
  assert.equal(page1.json.pages, 2)
  assert.equal(page1.json.items.length, 5)
  assert.ok(page1.json.filters)
  assert.ok(page1.json.filters.severities.includes('Critical'))
  assert.ok(page1.json.filters.statuses.includes('Retest_Passed'))
  assert.deepEqual([...page1.json.filters.realms].sort(), ['internal', 'web'])
  for (const item of page1.json.items) assertKeys(item, SUMMARY_KEYS, 'vulns.items[]')

  const page2 = await api(origin, '/vulns?pageSize=5&page=2')
  assert.equal(page2.json.page, 2)
  assert.equal(page2.json.items.length, 4)
  const ids = [...page1.json.items, ...page2.json.items].map((item) => item.id)
  assert.equal(new Set(ids).size, 9, 'pagination returns every row exactly once')

  const high = await api(origin, '/vulns?severity=High')
  assert.ok(high.json.items.every((item) => item.severity === 'High'))
  assert.equal(high.json.total, 3)

  const internal = await api(origin, '/vulns?realm=internal')
  assert.equal(internal.json.total, 2)
  assert.ok(internal.json.items.every((item) => item.realm === 'internal'))
  const internalRedis = internal.json.items.find((item) => item.id === FIXTURE.vulnInternalRedis)
  assert.equal(internalRedis.serviceHost, '192.0.2.15:6379')

  const inconclusive = await api(origin, '/vulns?status=Inconclusive')
  assert.equal(inconclusive.json.total, 2)

  const search = await api(origin, `/vulns?search=${encodeURIComponent('SQL 注入')}`)
  assert.equal(search.json.total, 1)
  assert.equal(search.json.items[0].id, FIXTURE.vulnMultiHttp)

  const badSeverity = await api(origin, '/vulns?severity=Catastrophic')
  assert.equal(badSeverity.status, 400)
  assert.equal(badSeverity.json.code, 'BAD_REQUEST')
})

test('GET /vulns/:id returns full detail with safe JSON fallbacks', async () => {
  const multi = await api(origin, `/vulns/${FIXTURE.vulnMultiHttp}`)
  assert.equal(multi.status, 200)
  assertKeys(multi.json.vuln, DETAIL_KEYS, 'vuln detail')
  assert.equal(multi.json.vuln.id, FIXTURE.vulnMultiHttp)
  assert.match(multi.json.vuln.reproductionSteps, /```http/)
  assert.ok(Array.isArray(multi.json.vuln.affectedInterfaces))
  assert.ok(Array.isArray(multi.json.vuln.remediation))
  assert.ok(Array.isArray(multi.json.vuln.retestResults))
  assert.ok(Array.isArray(multi.json.vuln.relatedVulnIds))
  assert.ok(multi.json.vuln.relatedVulnIds.includes('VULN-20261101-002'))
  assert.ok(Array.isArray(multi.json.related))
  assert.ok(multi.json.related.every((item) => item.id !== FIXTURE.vulnMultiHttp))

  // Corrupt JSON columns must fall back to [] instead of crashing.
  const corrupt = await api(origin, `/vulns/${FIXTURE.vulnCorruptJson}`)
  assert.equal(corrupt.status, 200)
  assert.deepEqual(corrupt.json.vuln.affectedInterfaces, [])
  assert.deepEqual(corrupt.json.vuln.relatedVulnIds, [])
  assert.deepEqual(corrupt.json.related, [])

  // Empty/defaults row: every field present with null/[]/'' defaults.
  const empty = await api(origin, `/vulns/${FIXTURE.vulnEmptyDefaults}`)
  assert.equal(empty.status, 200)
  assertKeys(empty.json.vuln, DETAIL_KEYS, 'empty vuln detail')
  assert.deepEqual(empty.json.vuln.remediation, [])
  assert.equal(empty.json.vuln.description, '')

  const retestVuln = await api(origin, `/vulns/${FIXTURE.vulnWithRetest}`)
  assert.equal(retestVuln.json.vuln.retestCount, 1)
  assert.equal(retestVuln.json.vuln.retestResults.length, 1)

  const internal = await api(origin, `/vulns/${FIXTURE.vulnInternalRedis}`)
  assert.equal(internal.json.vuln.realm, 'internal')
  assert.equal(internal.json.vuln.serviceHost, '192.0.2.15:6379')
  assert.equal(internal.json.vuln.internalServiceId, FIXTURE.internalServiceRedis)

  const missing = await api(origin, '/vulns/VULN-DOES-NOT-EXIST')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.code, 'NOT_FOUND')
  assert.equal(typeof missing.json.error, 'string')
})

test('PATCH /vulns/:id/status writes status only, validates input and rejects readonly', async () => {
  const targetId = 'VULN-20261101-002'
  const before = readVulnRow(targetId)
  assert.equal(before.status, 'Confirmed')

  const patched = await api(origin, `/vulns/${targetId}/status`, {
    method: 'PATCH',
    body: { status: 'Retest_Passed' },
  })
  assert.equal(patched.status, 200, patched.text)

  const after = readVulnRow(targetId)
  assert.equal(after.status, 'Retest_Passed', 'fixture DB status actually changed')
  // Only the status column may change.
  for (const column of ['vuln_name', 'host', 'description', 'reproduction_steps', 'retest_results']) {
    assert.equal(after[column], before[column], `PATCH must not modify ${column}`)
  }
  const detail = await api(origin, `/vulns/${targetId}`)
  assert.equal(detail.json.vuln.status, 'Retest_Passed')

  const invalid = await api(origin, `/vulns/${targetId}/status`, {
    method: 'PATCH',
    body: { status: 'NotAStatus' },
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.code, 'BAD_REQUEST')
  assert.equal(readVulnRow(targetId).status, 'Retest_Passed')

  const missing = await api(origin, '/vulns/VULN-DOES-NOT-EXIST/status', {
    method: 'PATCH',
    body: { status: 'Confirmed' },
  })
  assert.equal(missing.status, 404)

  // Read-only Host: writes are refused with READ_ONLY and the DB is unchanged.
  const readOnlyBefore = readVulnRow(FIXTURE.vulnWithRetest).status
  const readOnlyPatch = await api(readOnlyOrigin, `/vulns/${FIXTURE.vulnWithRetest}/status`, {
    method: 'PATCH',
    body: { status: 'Confirmed' },
  })
  assert.equal(readOnlyPatch.status, 403)
  assert.equal(readOnlyPatch.json.code, 'READ_ONLY')
  assert.equal(readVulnRow(FIXTURE.vulnWithRetest).status, readOnlyBefore)
})

test('POST /vulns/:id/retest appends without overwriting existing evidence', async () => {
  const id = FIXTURE.vulnWithRetest
  const beforeRow = readVulnRow(id)
  const beforeEntries = JSON.parse(beforeRow.retest_results)
  assert.equal(beforeEntries.length, 1)

  const appended = await api(origin, `/vulns/${id}/retest`, {
    method: 'POST',
    body: {
      timeRange: '2026-11-06T12:00:00.000Z/2026-11-06T12:30:00.000Z',
      conclusion: '## QA 追加复测\n\n- 第二轮验证仍无法触发弹窗（CSP）',
    },
  })
  assert.equal(appended.status, 200, appended.text)

  const afterRow = readVulnRow(id)
  const afterEntries = JSON.parse(afterRow.retest_results)
  assert.equal(afterEntries.length, 2, 'retest_results grew by exactly one entry')
  assert.deepEqual(afterEntries[0], beforeEntries[0], 'existing retest evidence is preserved verbatim')
  // Cortex stores retest entries as `{ time_range, conclusion }`; the API maps
  // them to `{ timeRange, conclusion }`, so accept either key at the DB layer.
  const appendedEntry = afterEntries[1]
  assert.equal(
    appendedEntry.timeRange ?? appendedEntry.time_range,
    '2026-11-06T12:00:00.000Z/2026-11-06T12:30:00.000Z',
  )
  assert.match(appendedEntry.conclusion, /QA 追加复测/)
  // Append-only: the original evidence columns are untouched.
  for (const column of ['description', 'impact', 'reproduction_steps', 'affected_interfaces', 'status']) {
    assert.equal(afterRow[column], beforeRow[column], `retest append must not modify ${column}`)
  }
  const detail = await api(origin, `/vulns/${id}`)
  assert.equal(detail.json.vuln.retestCount, 2)
  assert.equal(detail.json.vuln.retestResults.length, 2)
  assert.deepEqual(detail.json.vuln.retestResults[0], beforeEntries[0].timeRange !== undefined ? beforeEntries[0] : {
    timeRange: beforeEntries[0].time_range,
    conclusion: beforeEntries[0].conclusion,
  })
  assert.equal(detail.json.vuln.retestResults[1].timeRange, '2026-11-06T12:00:00.000Z/2026-11-06T12:30:00.000Z')
  assert.equal(detail.json.vuln.latestRetestAt !== null, true)

  const invalid = await api(origin, `/vulns/${id}/retest`, {
    method: 'POST',
    body: { timeRange: '', conclusion: '' },
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.code, 'BAD_REQUEST')

  const readOnly = await api(readOnlyOrigin, `/vulns/${id}/retest`, {
    method: 'POST',
    body: { timeRange: 'x', conclusion: 'y' },
  })
  assert.equal(readOnly.status, 403)
  assert.equal(readOnly.json.code, 'READ_ONLY')
})

// ---------------------------------------------------------------- assets

test('GET /assets and /assets/:hostPort expose structured recon data', async () => {
  const list = await api(origin, '/assets')
  assert.equal(list.status, 200)
  assert.equal(list.json.total, 2)
  assert.equal(list.json.items.length, 2)
  assert.ok(Array.isArray(list.json.projects) && list.json.projects.includes(FIXTURE.webProject))
  const summary = list.json.items.find((item) => item.hostPort === FIXTURE.webAssetHostPort)
  assert.ok(summary)
  for (const key of [
    'hostPort',
    'host',
    'projectName',
    'techStack',
    'authRequired',
    'status',
    'lastSeen',
    'interfaceCount',
    'vulnCount',
  ]) {
    assert.ok(key in summary, `AssetSummary has ${key}`)
  }
  assert.equal(summary.interfaceCount, 4)
  assert.ok(summary.vulnCount >= 1)

  const detail = await api(origin, `/assets/${encodeURIComponent(FIXTURE.webAssetHostPort)}`)
  assert.equal(detail.status, 200, detail.text)
  const asset = detail.json.asset
  for (const key of [
    'hostPort',
    'host',
    'projectName',
    'techStack',
    'authRequired',
    'status',
    'lastSeen',
    'interfaceCount',
    'vulnCount',
    'interfaces',
    'interfaceDir',
    'leakedInfos',
    'testParameters',
    'relatedVulnIds',
  ]) {
    assert.ok(key in asset, `AssetDetail has ${key}`)
  }
  assert.equal(asset.hostPort, FIXTURE.webAssetHostPort)
  assert.equal(asset.interfaces.length, 4)
  const requestIface = asset.interfaces.find((iface) => iface.request && iface.request.includes('HTTP/1.1'))
  assert.ok(requestIface, 'structured interface keeps the raw HTTP request text')
  assert.match(requestIface.request, /Host: demo\.example\.test/)
  assert.equal(asset.leakedInfos.length, 2)
  assert.ok(asset.leakedInfos.every((info) => info.infoType && info.value && info.source && info.potentialImpact))
  assert.equal(asset.testParameters.length, 2)
  assert.ok(asset.testParameters.every((param) => Array.isArray(param.values)))
  assert.ok(asset.relatedVulnIds.length >= 1)
  assert.ok(Array.isArray(detail.json.related))
  assert.ok(detail.json.related.every((item) => item.id !== undefined))

  const minimal = await api(origin, `/assets/${encodeURIComponent(FIXTURE.minimalAssetHostPort)}`)
  assert.equal(minimal.status, 200)
  assert.deepEqual(minimal.json.asset.interfaces, [])
  assert.deepEqual(minimal.json.asset.leakedInfos, [])

  const missing = await api(origin, `/assets/${encodeURIComponent('https://missing.example.test')}`)
  assert.equal(missing.status, 404)
  assert.equal(missing.json.code, 'NOT_FOUND')
})

// ---------------------------------------------------------------- internal

test('GET /internal/projects, /overview and /graph expose the internal operation scope', async () => {
  const projects = await api(origin, '/internal/projects')
  assert.equal(projects.status, 200)
  assert.ok(Array.isArray(projects.json.projects))
  const project = projects.json.projects.find((item) => item.projectName === FIXTURE.internalProject)
  assert.ok(project, 'internal fixture project is listed')
  assert.deepEqual(
    {
      footholds: project.footholds,
      hosts: project.hosts,
      services: project.services,
      credentials: project.credentials,
      pivots: project.pivots,
    },
    { footholds: 2, hosts: 3, services: 3, credentials: 2, pivots: 2 },
  )

  const overview = await api(origin, `/internal/overview?project=${encodeURIComponent(FIXTURE.internalProject)}`)
  assert.equal(overview.status, 200)
  assert.equal(overview.json.project, FIXTURE.internalProject)
  const data = overview.json
  for (const key of ['project', 'footholds', 'hosts', 'services', 'credentials', 'pivots', 'stats']) {
    assert.ok(key in data, `InternalOverview has ${key}`)
  }
  assert.deepEqual(data.stats, { footholds: 2, hosts: 3, services: 3, credentials: 2, pivots: 2 })
  assert.equal(data.footholds.length, 2)
  assert.equal(data.hosts.length, 3)
  assert.equal(data.services.length, 3)
  assert.equal(data.credentials.length, 2)
  assert.equal(data.pivots.length, 2)
  for (const foothold of data.footholds) {
    for (const key of [
      'id',
      'entryHostPort',
      'entryVulnId',
      'accessType',
      'privilegeLevel',
      'status',
      'evidence',
      'notes',
      'establishedAt',
      'hostIds',
    ]) {
      assert.ok(key in foothold, `Foothold has ${key}`)
    }
    assert.ok(Array.isArray(foothold.hostIds) && foothold.hostIds.length >= 1)
  }
  for (const service of data.services) {
    for (const key of ['id', 'hostId', 'port', 'protocol', 'service', 'banner', 'state', 'source']) {
      assert.ok(key in service, `InternalService has ${key}`)
    }
  }
  const pivot = data.pivots.find((item) => item.id === FIXTURE.pivotChain)
  assert.ok(pivot)
  assert.equal(pivot.kind, 'chain')
  assert.deepEqual(pivot.hops.map((hop) => hop.seq), [0, 1])
  assert.ok(pivot.hops.every((hop) => hop.refKind && hop.refId))
  assert.ok(pivot.reachableSubnets.includes('192.0.2.0/24'))

  const graph = await api(origin, `/internal/graph?project=${encodeURIComponent(FIXTURE.internalProject)}`)
  assert.equal(graph.status, 200)
  const nodeIds = new Set(graph.json.nodes.map((node) => node.id))
  assert.equal(nodeIds.size, graph.json.nodes.length, 'graph node ids are unique')
  assert.ok(graph.json.nodes.length >= 10)
  for (const kind of ['foothold', 'host', 'service', 'credential', 'pivot']) {
    assert.ok(graph.json.nodes.some((node) => node.kind === kind), `graph has ${kind} nodes`)
  }
  for (const edge of graph.json.edges) {
    assert.ok(nodeIds.has(edge.from), `graph edge from ${edge.from} references a node`)
    assert.ok(nodeIds.has(edge.to), `graph edge to ${edge.to} references a node`)
  }
  assert.ok(graph.json.edges.length >= 1)

  const defaultOverview = await api(origin, '/internal/overview')
  assert.equal(defaultOverview.status, 200)
  assert.equal(typeof defaultOverview.json.project, 'string')
})

test('credentials are masked: no secret ever reaches any JSON response', async () => {
  const responses = await Promise.all([
    api(origin, '/health'),
    api(origin, '/stats'),
    api(origin, '/vulns?pageSize=100'),
    api(origin, `/vulns/${FIXTURE.vulnInternalRedis}`),
    api(origin, '/assets'),
    api(origin, `/assets/${encodeURIComponent(FIXTURE.webAssetHostPort)}`),
    api(origin, '/internal/projects'),
    api(origin, `/internal/overview?project=${encodeURIComponent(FIXTURE.internalProject)}`),
    api(origin, `/internal/graph?project=${encodeURIComponent(FIXTURE.internalProject)}`),
    api(origin, '/snapshots?includeArchived=1'),
    api(origin, `/snapshots/${FIXTURE.parentSession}`),
  ])

  for (const response of responses) {
    assert.equal(response.status, 200, `unexpected status for ${response.text.slice(0, 120)}`)
    assert.ok(!response.text.includes(FIXTURE.credentialSecret), 'credential secret MUST NOT appear in any response')
    assert.ok(!response.text.includes('Fixture-Redis-Pass'), 'credential secret prefix must not leak either')
  }

  const overview = responses[7].json
  const credentials = overview.credentials
  assert.equal(credentials.length, 2)
  for (const credential of credentials) {
    assert.ok(!('secret' in credential), 'CredentialMasked has no secret field')
    assert.equal(typeof credential.secretMasked, 'string')
    assert.ok(credential.secretMasked.length > 0)
    assert.ok(credential.secretMasked !== FIXTURE.credentialSecret)
    assert.equal(typeof credential.secretLength, 'number')
    assert.ok(credential.secretLength > 0)
  }

  const projects = responses[6].json
  assert.ok(!JSON.stringify(projects).includes(FIXTURE.credentialSecret))
})

// ---------------------------------------------------------------- snapshots

test('GET /snapshots lists parent/child sessions, filters archived, and returns details', async () => {
  const active = await api(origin, `/snapshots?project=${encodeURIComponent(FIXTURE.webProject)}`)
  assert.equal(active.status, 200)
  assert.ok(Array.isArray(active.json.projects) && active.json.projects.includes(FIXTURE.webProject))
  assert.ok(Array.isArray(active.json.sessions))
  const activeIds = active.json.sessions.map((session) => session.sessionId)
  assert.equal(active.json.sessions.length, 2, 'archived session excluded by default')
  assert.ok(activeIds.includes(FIXTURE.parentSession))
  assert.ok(activeIds.includes(FIXTURE.childSession))
  assert.ok(!activeIds.includes(FIXTURE.archivedSession))

  const parent = active.json.sessions.find((session) => session.sessionId === FIXTURE.parentSession)
  const child = active.json.sessions.find((session) => session.sessionId === FIXTURE.childSession)
  for (const key of [
    'sessionId',
    'projectName',
    'currentPhase',
    'targetHosts',
    'parentSessionId',
    'archivedAt',
    'createdAt',
    'updatedAt',
    'nextSteps',
    'relatedVulnIds',
    'childCount',
  ]) {
    assert.ok(key in parent, `SnapshotSummary has ${key}`)
  }
  assert.equal(parent.parentSessionId, null)
  assert.equal(parent.childCount, 1)
  assert.equal(child.parentSessionId, FIXTURE.parentSession)
  assert.ok(Array.isArray(child.targetHosts))

  const all = await api(origin, `/snapshots?project=${encodeURIComponent(FIXTURE.webProject)}&includeArchived=1`)
  assert.equal(all.json.sessions.length, 3)
  const archived = all.json.sessions.find((session) => session.sessionId === FIXTURE.archivedSession)
  assert.ok(archived)
  assert.ok(archived.archivedAt)

  const detail = await api(origin, `/snapshots/${FIXTURE.parentSession}`)
  assert.equal(detail.status, 200)
  for (const key of [
    'unfinishedTasks',
    'failedPaths',
    'testedInterfaces',
    'notes',
    'nextSteps',
    'previousState',
    'relatedVulnIds',
  ]) {
    assert.ok(key in detail.json.session, `SnapshotDetail has ${key}`)
  }
  assert.ok(Array.isArray(detail.json.session.unfinishedTasks))
  assert.ok(Array.isArray(detail.json.session.testedInterfaces))
  assert.ok(detail.json.session.testedInterfaces.length >= 1)
  for (const iface of detail.json.session.testedInterfaces) {
    for (const key of ['target', 'method', 'result']) assert.ok(key in iface, `testedInterfaces has ${key}`)
  }
  assert.equal(detail.json.children.length, 1)
  assert.equal(detail.json.children[0].sessionId, FIXTURE.childSession)
  assert.ok(Array.isArray(detail.json.relatedVulns))

  const childDetail = await api(origin, `/snapshots/${FIXTURE.childSession}`)
  assert.equal(childDetail.status, 200)
  assert.ok(childDetail.json.session.previousState)
  assert.equal(childDetail.json.session.previousState.session, FIXTURE.parentSession)
  assert.deepEqual(childDetail.json.children, [])

  const missing = await api(origin, '/snapshots/SESS-DOES-NOT-EXIST')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.code, 'NOT_FOUND')
})

// ---------------------------------------------------------------- reports

test('GET /reports/:vulnId returns a downloadable Markdown report', async () => {
  const report = await api(origin, `/reports/${FIXTURE.vulnMultiHttp}`)
  assert.equal(report.status, 200)
  assert.match(report.headers['content-type'], /text\/markdown/)
  assert.match(report.headers['content-disposition'] || '', /attachment/)
  assert.match(report.headers['content-disposition'] || '', /VULN-20261101-001\.md/)
  assert.match(report.text, /^# /m)
  assert.ok(report.text.includes('登录接口 SQL 注入可绕过认证'))
  assert.ok(report.text.includes('复现步骤'))
  assert.ok(report.text.includes('修复建议'))
  assert.match(report.text, /```http/)

  const internalReport = await api(origin, `/reports/${FIXTURE.vulnInternalRedis}`)
  assert.equal(internalReport.status, 200)
  assert.match(internalReport.headers['content-type'], /text\/markdown/)

  const missing = await api(origin, '/reports/VULN-DOES-NOT-EXIST')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.code, 'NOT_FOUND')
})

// ---------------------------------------------------------------- retest send

test('POST /retest/send: no redirect by default, follows on demand, blocks foreign origins', async () => {
  const body = {
    vulnId: FIXTURE.vulnForRetestSend,
    method: 'GET',
    url: RETEST_TARGET(),
    headers: { 'X-Fixture-Header': 'qa' },
    followRedirects: false,
  }
  const first = await api(origin, '/retest/send', { method: 'POST', body })
  assert.equal(first.status, 200, first.text)
  const firstResult = first.json
  for (const key of [
    'status',
    'statusText',
    'url',
    'finalUrl',
    'headers',
    'body',
    'bodyBytes',
    'bodyTruncated',
    'contentType',
    'durationMs',
    'redirects',
  ]) {
    assert.ok(key in firstResult, `retest/send result has ${key}`)
  }
  assert.equal(firstResult.status, 302, 'default is NOT to follow redirects')
  assert.ok(!firstResult.body.includes('final-response-body'), 'redirect body not fetched by default')
  assert.equal(firstResult.headers.location, '/final')
  assert.ok(Array.isArray(firstResult.redirects))
  assert.ok(firstResult.durationMs >= 0)

  const followed = await api(origin, '/retest/send', {
    method: 'POST',
    body: Object.assign({}, body, { followRedirects: true }),
  })
  assert.equal(followed.status, 200, followed.text)
  assert.equal(followed.json.status, 200)
  assert.ok(followed.json.finalUrl.endsWith('/final'))
  assert.ok(followed.json.body.includes('final-response-body'))
  assert.ok(Array.isArray(followed.json.redirects) && followed.json.redirects.length >= 1)
  assert.equal(followed.json.redirects[0].status, 302)
  assert.equal(followed.json.redirects[0].location, '/final')

  // A valid http(s) URL outside the allowlist is rejected.
  const foreign = await api(origin, '/retest/send', {
    method: 'POST',
    body: Object.assign({}, body, { url: 'https://evil.example.test/collect' }),
  })
  assert.equal(foreign.status, 403)
  assert.equal(foreign.json.code, 'ORIGIN_NOT_ALLOWED')
  assert.ok(Array.isArray(foreign.json.details.allowed))
  assert.ok(!foreign.json.details.allowed.includes('https://evil.example.test'))

  // Non-http schemes are rejected as bad input.
  const fileScheme = await api(origin, '/retest/send', {
    method: 'POST',
    body: Object.assign({}, body, { url: 'file:///etc/passwd' }),
  })
  assert.ok([400, 403].includes(fileScheme.status), `file:// rejected (got ${fileScheme.status})`)

  // Unknown vulnerability id cannot be used for the allowlist lookup.
  const unknownVuln = await api(origin, '/retest/send', {
    method: 'POST',
    body: Object.assign({}, body, { vulnId: 'VULN-DOES-NOT-EXIST' }),
  })
  assert.ok([403, 404].includes(unknownVuln.status), `unknown vuln rejected (got ${unknownVuln.status})`)
})

// ---------------------------------------------------------------- fences / schema

test('loopback fences, method handling and error format', async () => {
  // 1) Host header must be loopback.
  const forgedHost = await rawRequest(origin, {
    path: '/cortex-api/health',
    headers: { Host: 'evil.example.test' },
  })
  assert.equal(forgedHost.status, 403)
  assert.equal(JSON.parse(forgedHost.text).code, 'FORBIDDEN_HOST')

  // 2) Write requests from a foreign Origin are rejected.
  const statusBody = JSON.stringify({ status: 'Confirmed' })
  const forgedOrigin = await rawRequest(origin, {
    path: `/cortex-api/vulns/${FIXTURE.vulnWithRetest}/status`,
    method: 'PATCH',
    headers: {
      Origin: 'http://evil.example.test',
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(statusBody)),
    },
    body: statusBody,
  })
  assert.equal(forgedOrigin.status, 403)
  const forgedOriginBody = JSON.parse(forgedOrigin.text)
  assert.ok(['FORBIDDEN_ORIGIN', 'FORBIDDEN_HEADER'].includes(forgedOriginBody.code), forgedOriginBody.code)

  // 3) Writes require Content-Type: application/json.
  const wrongContentType = await rawRequest(origin, {
    path: `/cortex-api/vulns/${FIXTURE.vulnWithRetest}/status`,
    method: 'PATCH',
    headers: {
      'Content-Type': 'text/plain',
      'Content-Length': String(Buffer.byteLength(statusBody)),
    },
    body: statusBody,
  })
  assert.equal(wrongContentType.status, 403)
  assert.equal(JSON.parse(wrongContentType.text).code, 'FORBIDDEN_CONTENT_TYPE')

  // 4) OPTIONS is not allowed (no CORS preflight support).
  const options = await rawRequest(origin, { path: '/cortex-api/health', method: 'OPTIONS' })
  assert.equal(options.status, 405)

  // 5) Unknown route -> JSON 404 in the documented error shape.
  const notFound = await api(origin, '/does-not-exist')
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.code, 'NOT_FOUND')
  assert.equal(typeof notFound.json.error, 'string')

  // 6) Responses carry no CORS header.
  assert.equal(notFound.headers['access-control-allow-origin'], undefined)
})

test('schema guard: v4 database → compatible:false, data endpoints 409, no writes', async () => {
  const health = await api(schemaOrigin, '/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.db.available, true)
  assert.equal(health.json.db.schemaVersion, 4)
  assert.equal(health.json.db.compatible, false)

  for (const path of ['/stats', '/vulns', '/assets', '/internal/projects', '/snapshots']) {
    const response = await api(schemaOrigin, path)
    assert.equal(response.status, 409, `${path} returns 409 on schema mismatch`)
    assert.equal(response.json.code, 'SCHEMA_INCOMPATIBLE')
  }

  const patch = await api(schemaOrigin, `/vulns/${FIXTURE.vulnWithRetest}/status`, {
    method: 'PATCH',
    body: { status: 'Confirmed' },
  })
  assert.equal(patch.status, 409)
  assert.equal(patch.json.code, 'SCHEMA_INCOMPATIBLE')

  // The schema-v4 fixture DB file must be untouched (same row count + values).
  const db = new DatabaseSync(join(tempDir, 'schema4.db'), { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vulnerabilities').get().n, 9)
    assert.equal(
      db.prepare('SELECT status FROM vulnerabilities WHERE id = ?').get(FIXTURE.vulnWithRetest).status,
      'Inconclusive',
    )
  } finally {
    db.close()
  }
})

test('read-only Host reports readOnly:true and refuses writes', async () => {
  const health = await api(readOnlyOrigin, '/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.db.readOnly, true)
  assert.equal(health.json.db.compatible, true)

  const status = await api(readOnlyOrigin, `/vulns/${FIXTURE.vulnWithRetest}/status`, {
    method: 'PATCH',
    body: { status: 'Confirmed' },
  })
  assert.equal(status.status, 403)
  assert.equal(status.json.code, 'READ_ONLY')

  const retest = await api(readOnlyOrigin, `/vulns/${FIXTURE.vulnWithRetest}/retest`, {
    method: 'POST',
    body: { timeRange: 'a', conclusion: 'b' },
  })
  assert.equal(retest.status, 403)
  assert.equal(retest.json.code, 'READ_ONLY')

  const send = await api(readOnlyOrigin, '/retest/send', {
    method: 'POST',
    body: { vulnId: FIXTURE.vulnForRetestSend, method: 'GET', url: RETEST_TARGET() },
  })
  assert.equal(send.status, 403)
  assert.equal(send.json.code, 'READ_ONLY')

  // Reads still work in read-only mode.
  const list = await api(readOnlyOrigin, '/vulns?pageSize=5')
  assert.equal(list.status, 200)
  assert.equal(list.json.total, 9)
})
