/**
 * Host-side tests for the Cortex Nebula (Memory Graph) + internal-operations
 * endpoints: `/cortex-api/cortex/graph`, `/internal/*`, `/loot`.
 *
 * The tests start a REAL loopback `node:http` server around the same handler
 * contract the plugin router uses (loopback peer/Host fences from `http.js`,
 * then `handleGraph(ctx)` / `handleInternal(ctx)`), against a temporary
 * schema-v5 SQLite fixture — never the operator's live `~/.cortex/data.db`.
 *
 * They also import the compiled vendored builder (`graph-builder.js`) and run it
 * directly against `createGraphDatabaseAdapter()` with the fixture to lock the
 * adapter ↔ builder contract (method names / shapes / truncation flags).
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { DatabaseHolder } from '../../src/host/db.js'
import { createGraphDatabaseAdapter } from '../../src/host/cortex/graph-adapter.js'
import { buildMemoryGraph } from '../../src/host/cortex/graph-builder.js'
import { handleGraph } from '../../src/host/cortex/graph.js'
import { handleInternal } from '../../src/host/cortex/internal.js'
import {
  assertLoopbackHost,
  assertLoopbackPeer,
  assertSameOriginWrite,
  notFound,
  parseRequestUrl,
  sendError,
} from '../../src/host/http.js'
import {
  cleanupDir,
  createTestDb,
  fakeResponse,
  httpRequest,
  insertVuln,
  openRawDb,
  startTestHost,
} from './helpers.mjs'

const PREFIX = '/cortex-api/cortex'

const GRAPH_NODE_TYPES = [
  'project',
  'target',
  'host',
  'vuln',
  'leak',
  'snapshot',
  'foothold',
  'internal_host',
  'internal_service',
]

/** Route `/cortex-api/cortex/**` to this teammate's handlers, like index.js. */
async function dispatch(req, res, holder, config) {
  try {
    const { pathname, searchParams } = parseRequestUrl(req)
    assertLoopbackPeer(req)
    assertLoopbackHost(req)
    if (!pathname.startsWith(PREFIX)) {
      sendError(res, notFound())
      return
    }
    const path = pathname === PREFIX ? '/' : pathname.slice(PREFIX.length)
    const method = String(req.method || 'GET').toUpperCase()
    // The central router applies the same-origin write fence to every write,
    // including POST /graph (which is a read-only projection over POST). The
    // DSH desktop main process strips Origin/Sec-Fetch-Site before forwarding,
    // and the browser GUI origin is loopback http, so both pass in practice.
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      assertSameOriginWrite(req)
    }
    const ctx = {
      req,
      res,
      method,
      path,
      searchParams,
      holder,
      repository: null,
      config,
    }
    if (await handleGraph(ctx)) return
    if (await handleInternal(ctx)) return
    sendError(res, notFound())
  } catch (err) {
    sendError(res, err)
  }
}

/** Start a real loopback HTTP server wired to the plugin handler contract. */
async function startNebulaServer(options) {
  const holder = new DatabaseHolder({
    dbPath: options.dbPath,
    readOnly: options.readOnly === true,
  })
  const config = { dbPath: options.dbPath, readOnly: options.readOnly === true }
  const server = http.createServer((req, res) => {
    void dispatch(req, res, holder, config)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    holder,
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    request(path, opts = {}) {
      return httpRequest({ port, path, ...opts })
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await holder.close()
    },
  }
}

/** Fixture: seeded DB + loot import row + one unnormalized internal vuln. */
function createNebulaFixture() {
  const { dir, dbPath } = createTestDb({ seed: true })
  const db = openRawDb(dbPath)
  try {
    db.prepare(
      `INSERT INTO loot_imports (id, project_name, entry_host_port, filename, sha256, format,
         parser, status, summary_json, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'LT-20260101-001',
      'Project Alpha',
      'http://127.0.0.1:8080/',
      'loot.zip',
      'a'.repeat(64),
      'generic-csv',
      'csv',
      'parsed',
      JSON.stringify({ hosts: 1, services: 2, credentials: 1, warnings: [], needs_review: 0 }),
      '',
      '2026-01-03T00:00:00.000Z',
    )
    // Legacy internal finding without `internal_service_id` -> "待归一化" warning.
    insertVuln(db, {
      id: 'VULN-20260101-005',
      host: '127.0.0.1:8080',
      entry_point: 'redis:6379',
      vuln_name: 'Redis 弱口令（未归一化）',
      vuln_type: 'Weak_Password',
      severity: 'Medium',
      target_url: 'redis://10.0.0.5:6379',
      description: 'legacy row',
      impact: '',
      service_host: '10.0.0.5:6379',
      realm: 'internal',
      internal_service_id: '',
      created_at: '2026-01-01T00:00:05.000Z',
    })
  } finally {
    db.close()
  }
  return { dir, dbPath }
}

function assertMemoryGraphShape(graph) {
  assert.ok(Array.isArray(graph.nodes), 'nodes is an array')
  assert.ok(Array.isArray(graph.links), 'links is an array')
  assert.ok(graph.meta && typeof graph.meta === 'object', 'meta object present')
  const ids = new Set(graph.nodes.map((node) => node.id))
  for (const node of graph.nodes) {
    assert.equal(typeof node.id, 'string')
    assert.equal(typeof node.name, 'string')
    assert.equal(typeof node.type, 'string')
    assert.ok(GRAPH_NODE_TYPES.includes(node.type), `known node type ${node.type}`)
    assert.equal(typeof node.val, 'number')
    assert.ok(node.data && typeof node.data === 'object', `node ${node.id} has data`)
  }
  for (const link of graph.links) {
    assert.ok(ids.has(link.source), `link source ${link.source} exists`)
    assert.ok(ids.has(link.target), `link target ${link.target} exists`)
    assert.equal(typeof link.relation, 'string')
    if (link.derived !== undefined) assert.equal(typeof link.derived, 'boolean')
  }
  const counts = graph.meta.counts
  assert.deepEqual(Object.keys(counts).sort(), [...GRAPH_NODE_TYPES].sort())
  for (const type of GRAPH_NODE_TYPES) {
    const observed = graph.nodes.filter((node) => node.type === type).length
    assert.equal(counts[type], observed, `counts.${type} matches nodes`)
  }
  assert.equal(graph.meta.truncated, false)
  assert.ok(!Number.isNaN(Date.parse(graph.meta.generatedAt)))
  assert.ok(Array.isArray(graph.meta.unresolvedTargets))
  assert.ok(graph.meta.limits && typeof graph.meta.limits === 'object')
  return ids
}

/* ---------------------------------------------------------------- graph -- */

test('POST /graph all-scope (web realm) returns a valid MemoryGraphData', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const res = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'all' }, realm: 'web' },
  })
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')
  const graph = res.json
  const ids = assertMemoryGraphShape(graph)
  assert.deepEqual(graph.meta.scope, { kind: 'all' })
  assert.deepEqual(graph.meta.unresolvedTargets, [])
  // The seeded Web fixture: two assets, web vulns, one leaked secret, sessions.
  assert.ok(graph.meta.counts.host >= 2, 'host nodes present')
  assert.ok(graph.meta.counts.vuln >= 3, 'web vulnerability nodes present')
  assert.ok(graph.meta.counts.project >= 1, 'project hierarchy present')
  assert.ok(graph.meta.counts.snapshot >= 1, 'snapshot nodes present')
  // No internal layer in the web realm.
  assert.equal(graph.meta.counts.foothold, 0)
  assert.equal(graph.meta.counts.internal_host, 0)
  assert.equal(graph.routes, undefined)
  // Default limits are applied and clamped.
  assert.deepEqual(graph.meta.limits, {
    hosts: 200,
    vulnerabilities: 600,
    leaks: 1_000,
    snapshots: 100,
    footholds: 100,
    internalHosts: 300,
    internalServices: 1_000,
  })
  // Every link endpoint is a real node (force-graph would crash otherwise).
  for (const link of graph.links) {
    assert.ok(ids.has(link.source) && ids.has(link.target))
  }
  // Credential material never enters the graph payload.
  assert.ok(!res.text.includes('SuperSecretValue!42'))
  assert.ok(!res.text.includes('ssh-private-key-material'))
  assert.ok(!res.text.includes(fixture.dir), 'no absolute database path in the response')
})

test('POST /graph asset scope focuses one host and echoes the scope', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const hostPort = 'http://127.0.0.1:8080/'
  const res = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'asset', hostPort }, depth: 1 },
  })
  assert.equal(res.status, 200)
  const graph = res.json
  assertMemoryGraphShape(graph)
  assert.deepEqual(graph.meta.scope, { kind: 'asset', hostPort })
  const hosts = graph.nodes.filter((node) => node.type === 'host')
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].data.host_port, hostPort)
  assert.equal(hosts[0].data.project_name, 'Project Alpha')
  assert.ok(hosts[0].data.interfaces.includes('/login'))
  assert.ok(hosts[0].data.test_parameters.includes('invoice_id'))
  // Asset scope only contains the focused host and its direct relations.
  assert.ok(graph.nodes.some((node) => node.type === 'vuln'))
  assert.ok(graph.nodes.some((node) => node.type === 'leak'))
  assert.equal(graph.meta.counts.internal_host, 0)
})

test('POST /graph task scope returns the session snapshot neighbourhood', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const res = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'task', sessionId: 'SESS-20260101-001' } },
  })
  assert.equal(res.status, 200)
  const graph = res.json
  assertMemoryGraphShape(graph)
  assert.deepEqual(graph.meta.scope, {
    kind: 'task',
    sessionId: 'SESS-20260101-001',
    includeChildren: false,
  })
  const snapshots = graph.nodes.filter((node) => node.type === 'snapshot')
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].data.session_id, 'SESS-20260101-001')
  assert.ok(graph.nodes.some((node) => node.type === 'host'))

  // Unknown session: empty graph + unresolved target instead of an error.
  const missing = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'task', sessionId: 'SESS-00000000-999' } },
  })
  assert.equal(missing.status, 200)
  assert.deepEqual(missing.json.nodes, [])
  assert.deepEqual(missing.json.meta.unresolvedTargets, ['SESS-00000000-999'])
})

test('POST /graph realm filters isolate web, internal and all nodes', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const internal = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'all' }, realm: 'internal' },
  })
  assert.equal(internal.status, 200)
  assertMemoryGraphShape(internal.json)
  const internalTypes = new Set(internal.json.nodes.map((node) => node.type))
  assert.ok(internalTypes.has('foothold'))
  assert.ok(internalTypes.has('internal_host'))
  assert.ok(internalTypes.has('internal_service'))
  assert.ok(!internalTypes.has('snapshot'), 'no snapshot nodes in the internal realm')
  assert.ok(!internalTypes.has('leak'), 'no leak nodes in the internal realm')
  assert.ok(Array.isArray(internal.json.routes) && internal.json.routes.length === 1)
  const route = internal.json.routes[0]
  assert.equal(route.kind, 'proxy')
  assert.equal(route.tool, 'chisel')
  assert.equal(route.local_endpoint, '127.0.0.1:1080/socks5')
  assert.ok(route.node_ids.length >= 2)
  const ids = new Set(internal.json.nodes.map((node) => node.id))
  for (const nodeId of route.node_ids) assert.ok(ids.has(nodeId))
  assert.deepEqual(route.reachable_subnets, ['10.0.0.0/24'])
  // Internal realm sees only `realm='internal'` vulnerabilities.
  const vulnHosts = internal.json.nodes
    .filter((node) => node.type === 'vuln')
    .map((node) => node.data.vuln_id)
  assert.ok(vulnHosts.includes('VULN-20260101-003'))
  assert.ok(!vulnHosts.includes('VULN-20260101-001'))

  const all = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'all' }, realm: 'all' },
  })
  assert.equal(all.status, 200)
  assertMemoryGraphShape(all.json)
  const allTypes = new Set(all.json.nodes.map((node) => node.type))
  for (const type of ['host', 'vuln', 'snapshot', 'foothold', 'internal_host', 'internal_service']) {
    assert.ok(allTypes.has(type), `all realm includes ${type}`)
  }
  assert.ok(Array.isArray(all.json.routes))
  const allVulnIds = all.json.nodes
    .filter((node) => node.type === 'vuln')
    .map((node) => node.data.vuln_id)
  assert.ok(allVulnIds.includes('VULN-20260101-001'))
  assert.ok(allVulnIds.includes('VULN-20260101-003'))

  // `internal: false` keeps the all realm at the Web projection.
  const webOnly = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'all' }, realm: 'all', filters: { internal: false } },
  })
  assert.equal(webOnly.status, 200)
  assert.equal(webOnly.json.meta.counts.foothold, 0)
  assert.equal(webOnly.json.meta.counts.internal_host, 0)
})

test('POST /graph honours filters and per-type limits (truncated flag)', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const noVulns = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'all' }, filters: { vulnerabilities: false } },
  })
  assert.equal(noVulns.status, 200)
  assert.equal(noVulns.json.meta.counts.vuln, 0)

  const limited = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: {
      scope: { kind: 'all' },
      limits: { hosts: 1, vulnerabilities: 1, snapshots: 1, leaks: 1 },
    },
  })
  assert.equal(limited.status, 200)
  assert.equal(limited.json.meta.limits.hosts, 1)
  assert.equal(limited.json.meta.limits.vulnerabilities, 1)
  assert.equal(limited.json.meta.truncated, true, 'small limit flags truncation')
})

test('POST /graph rejects malformed queries instead of silently guessing', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const badBodies = [
    {}, // scope required
    { scope: { kind: 'bogus' } },
    { scope: { kind: 'asset' } }, // hostPort required
    { scope: { kind: 'asset', hostPort: 'http://example.com/a b' } }, // whitespace
    { scope: { kind: 'task' } }, // sessionId required
    { scope: { kind: 'all' }, depth: 3 },
    { scope: { kind: 'all' }, realm: 'bogus' },
    { scope: { kind: 'all' }, filters: { internal: 'yes' } },
    { scope: { kind: 'all' }, limits: { hosts: 0 } },
    { scope: { kind: 'all' }, limits: { hosts: 999 } },
    { scope: { kind: 'all' }, limits: { bogus: 1 } },
    { scope: { kind: 'all' }, extra: true }, // strict: unknown top-level key
  ]
  for (const body of badBodies) {
    const res = await server.request(`${PREFIX}/graph`, { method: 'POST', body })
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`)
    assert.equal(res.json.code, 'BAD_REQUEST')
    assert.ok(res.json.error)
  }

  const wrongMethod = await server.request(`${PREFIX}/graph`)
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.json.code, 'METHOD_NOT_ALLOWED')

  const wrongContentType = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    rawBody: '{"scope":{"kind":"all"}}',
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(wrongContentType.status, 403)
  assert.equal(wrongContentType.json.code, 'FORBIDDEN_CONTENT_TYPE')

  const notJson = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    rawBody: 'not-json',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(notJson.status, 400)
})

/* ------------------------------------------------------------- internal -- */

test('GET /internal/projects lists internal projects with scope counts', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const res = await server.request(`${PREFIX}/internal/projects`)
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.json))
  const project = res.json.find((item) => item.project_name === 'Project Alpha')
  assert.ok(project, 'Project Alpha listed')
  assert.deepEqual(project.counts, {
    footholds: 2,
    hosts: 2,
    services: 2,
    credentials: 2,
    pivots: 1,
  })
  assert.ok(!res.text.includes('SuperSecretValue'))
})

test('GET /internal/overview returns InternalOverview without secrets', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const res = await server.request(
    `${PREFIX}/internal/overview?project_name=${encodeURIComponent('Project Alpha')}`,
  )
  assert.equal(res.status, 200)
  const overview = res.json
  assert.equal(overview.project_name, 'Project Alpha')
  assert.deepEqual(overview.counts, {
    footholds: 2,
    hosts: 2,
    services: 2,
    credentials: 2,
    pivots: 1,
    internal_vulns: 2,
    loot_imports: 1,
  })
  assert.equal(overview.footholds.length, 2)
  assert.equal(overview.hosts.length, 2)
  assert.equal(overview.services.length, 2)
  assert.equal(overview.pivots.length, 1)
  assert.equal(overview.trials.length, 0)
  assert.equal(overview.loot_imports.length, 1)
  assert.equal(overview.loot_imports[0].format, 'generic-csv')
  assert.deepEqual(overview.loot_imports[0].summary, {
    hosts: 1,
    services: 2,
    credentials: 1,
    warnings: [],
    needs_review: 0,
  })
  // Legacy internal vuln without internal_service_id is kept + warned about.
  assert.ok(overview.internal_vulns.some((vuln) => vuln.id === 'VULN-20260101-005'))
  assert.ok(overview.warnings.some((warning) => warning.includes('待归一化')))
  assert.ok(overview.projects.some((item) => item.project_name === 'Project Alpha'))

  // Credentials are masked projections: secret_preview + secret_length only.
  for (const credential of overview.credentials) {
    assert.equal(typeof credential.secret_preview, 'string')
    assert.equal(typeof credential.secret_length, 'number')
    assert.ok(!('secret' in credential), 'raw secret field is never returned')
  }
  assert.ok(!res.text.includes('SuperSecretValue!42'))
  assert.ok(!res.text.includes('ssh-private-key-material'))
  assert.ok(!res.text.includes(fixture.dir), 'no absolute database path')
  // The masked preview keeps a recognizable suffix for long secrets.
  const password = overview.credentials.find((item) => item.id === 'CR-1')
  assert.ok(password.secret_preview.endsWith('e!42'), 'masked preview keeps last 4 chars')
  assert.equal(password.secret_length, 'SuperSecretValue!42'.length)

  // No project filter -> empty overview plus the project selector.
  const empty = await server.request(`${PREFIX}/internal/overview`)
  assert.equal(empty.status, 200)
  assert.equal(empty.json.project_name, '')
  assert.deepEqual(empty.json.hosts, [])
  assert.deepEqual(empty.json.credentials, [])
  assert.ok(empty.json.projects.length >= 1)
})

test('GET /internal/graph returns InternalGraphData with heatmap and suggestions', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const res = await server.request(
    `${PREFIX}/internal/graph?project_name=${encodeURIComponent('Project Alpha')}`,
  )
  assert.equal(res.status, 200)
  const graph = res.json
  assert.equal(graph.project_name, 'Project Alpha')
  assert.ok(!Number.isNaN(Date.parse(graph.generated_at)))
  assert.equal(graph.counts.hosts, 2)
  assert.equal(graph.truncated, false)
  assert.ok(Array.isArray(graph.warnings))
  assert.equal(graph.heatmap.length, 1)
  const bucket = graph.heatmap[0]
  assert.equal(bucket.subnet, '10.0.0.0/24')
  assert.equal(bucket.host_count, 2)
  assert.equal(bucket.service_count, 2)
  assert.equal(bucket.by_state.alive, 1)
  assert.equal(bucket.by_state.compromised, 1)
  assert.equal(bucket.hosts.length, 2)
  assert.ok(Array.isArray(graph.suggestions))
  // The credential/service matrix never attempts anything; the fixture yields
  // no matching rule pair but every row would carry reason/caveat/confidence.
  for (const suggestion of graph.suggestions) {
    assert.equal(typeof suggestion.rule, 'string')
    assert.equal(typeof suggestion.reason, 'string')
    assert.equal(typeof suggestion.confidence, 'string')
  }
  assert.ok(!res.text.includes('SuperSecretValue!42'))
  assert.ok(!res.text.includes('secret"'))

  // project_name is required for the internal graph projection.
  const missing = await server.request(`${PREFIX}/internal/graph`)
  assert.equal(missing.status, 400)
  assert.equal(missing.json.code, 'BAD_REQUEST')
})

test('GET /loot lists loot imports and scopes by project', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const all = await server.request(`${PREFIX}/loot?project_name=${encodeURIComponent('Project Alpha')}`)
  assert.equal(all.status, 200)
  assert.ok(Array.isArray(all.json))
  assert.equal(all.json.length, 1)
  const loot = all.json[0]
  assert.equal(loot.id, 'LT-20260101-001')
  assert.equal(loot.project_name, 'Project Alpha')
  assert.equal(loot.entry_host_port, 'http://127.0.0.1:8080/')
  assert.equal(loot.filename, 'loot.zip')
  assert.equal(loot.sha256, 'a'.repeat(64))
  assert.equal(loot.format, 'generic-csv')
  assert.equal(loot.parser, 'csv')
  assert.equal(loot.status, 'parsed')
  assert.equal(loot.error, '')
  assert.ok(!Number.isNaN(Date.parse(loot.created_at)))
  assert.equal(loot.summary.services, 2)

  const other = await server.request(`${PREFIX}/loot?project_name=${encodeURIComponent('Project Beta')}`)
  assert.equal(other.status, 200)
  assert.deepEqual(other.json, [])

  const invalid = await server.request(`${PREFIX}/loot?project_name=${'a'.repeat(121)}`)
  assert.equal(invalid.status, 400)
})

test('POST /internal/credential-trial appends one trial and validates references', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const res = await server.request(`${PREFIX}/internal/credential-trial`, {
    method: 'POST',
    body: {
      credential_id: 'CR-1',
      service_id: 'IS-1',
      action: 'smb login probe',
      status: 'success',
      notes: '人工验证记录',
    },
  })
  assert.equal(res.status, 200)
  const trial = res.json
  assert.match(trial.id, /^TR-[0-9A-F]{12}$/)
  assert.equal(trial.credential_id, 'CR-1')
  assert.equal(trial.service_id, 'IS-1')
  assert.equal(trial.action, 'smb login probe')
  assert.equal(trial.status, 'success')
  assert.equal(trial.notes, '人工验证记录')
  assert.ok(!Number.isNaN(Date.parse(trial.attempted_at)))
  assert.ok(!res.text.includes('SuperSecretValue'))

  // The row is really appended (append-only history), and reaches overview.
  const raw = openRawDb(fixture.dbPath)
  try {
    const rows = raw.prepare('SELECT COUNT(*) AS count FROM credential_trials').get()
    assert.equal(Number(rows.count), 1)
  } finally {
    raw.close()
  }
  const overview = await server.request(
    `${PREFIX}/internal/overview?project_name=${encodeURIComponent('Project Alpha')}`,
  )
  assert.equal(overview.status, 200)
  assert.equal(overview.json.trials.length, 1)
  assert.equal(overview.json.trials[0].id, trial.id)

  // Unknown credential -> 404; unknown/foreign service -> 400; bad payload -> 400.
  const missingCredential = await server.request(`${PREFIX}/internal/credential-trial`, {
    method: 'POST',
    body: { credential_id: 'CR-999', status: 'failed' },
  })
  assert.equal(missingCredential.status, 404)

  const badService = await server.request(`${PREFIX}/internal/credential-trial`, {
    method: 'POST',
    body: { credential_id: 'CR-1', service_id: 'IS-999', status: 'failed' },
  })
  assert.equal(badService.status, 400)

  for (const body of [
    {},
    { credential_id: 'CR-1', status: 'bogus' },
    { credential_id: '', status: 'failed' },
    { credential_id: 'CR-1', status: 'failed', extra: 1 },
    { credential_id: 'CR-1', status: 'failed', notes: 'x'.repeat(2_001) },
  ]) {
    const invalid = await server.request(`${PREFIX}/internal/credential-trial`, {
      method: 'POST',
      body,
    })
    assert.equal(invalid.status, 400, `expected 400 for ${JSON.stringify(body)}`)
    assert.equal(invalid.json.code, 'BAD_REQUEST')
  }

  const wrongMethod = await server.request(`${PREFIX}/internal/credential-trial`)
  assert.equal(wrongMethod.status, 405)
})

test('read-only host rejects the credential-trial write with 403 READ_ONLY', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath, readOnly: true })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const res = await server.request(`${PREFIX}/internal/credential-trial`, {
    method: 'POST',
    body: { credential_id: 'CR-1', action: 'attempt', status: 'failed' },
  })
  assert.equal(res.status, 403)
  assert.equal(res.json.code, 'READ_ONLY')
  assert.ok(!res.text.includes(fixture.dir), 'no absolute database path')

  // Reads still work on the same read-only connection.
  const projects = await server.request(`${PREFIX}/internal/projects`)
  assert.equal(projects.status, 200)
  const graph = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'all' }, realm: 'all' },
  })
  assert.equal(graph.status, 200)
  assertMemoryGraphShape(graph.json)
})

/* ---------------------------------------------------- fences + edge cases -- */

test('loopback fences: non-loopback peer/Host are rejected before any SQL', async (t) => {
  const fixture = createNebulaFixture()
  // Fake req/res so we can spoof the socket address; no TCP involved.
  const holder = new DatabaseHolder({ dbPath: fixture.dbPath, readOnly: true })
  t.after(async () => {
    await holder.close()
    cleanupDir(fixture.dir)
  })

  const peerRes = fakeResponse()
  const peerHandled = await handleInternal({
    req: {
      method: 'GET',
      url: `${PREFIX}/internal/projects`,
      headers: { host: '127.0.0.1:63877' },
      socket: { remoteAddress: '10.9.8.7' },
    },
    res: peerRes,
    method: 'GET',
    path: '/internal/projects',
    searchParams: new URLSearchParams(),
    holder,
  })
  assert.equal(peerHandled, true)
  assert.equal(peerRes.statusCode, 403)
  const peerBody = JSON.parse(peerRes.body)
  assert.equal(peerBody.code, 'FORBIDDEN_PEER')

  const hostRes = fakeResponse()
  const hostHandled = await handleGraph({
    req: {
      method: 'POST',
      url: `${PREFIX}/graph`,
      headers: {
        host: 'evil.example:443',
        'content-type': 'application/json',
      },
      socket: { remoteAddress: '127.0.0.1' },
    },
    res: hostRes,
    method: 'POST',
    path: '/graph',
    searchParams: new URLSearchParams(),
    holder,
  })
  assert.equal(hostHandled, true)
  assert.equal(hostRes.statusCode, 403)
  assert.equal(JSON.parse(hostRes.body).code, 'FORBIDDEN_HOST')

  // Real HTTP: a non-loopback Host header is rejected by the same server path.
  const server = await startNebulaServer({ dbPath: fixture.dbPath, readOnly: true })
  t.after(async () => {
    await server.close()
  })
  const forgedHost = await server.request(`${PREFIX}/internal/projects`, {
    headers: { host: 'evil.example' },
  })
  assert.equal(forgedHost.status, 403)
  assert.equal(forgedHost.json.code, 'FORBIDDEN_HOST')
})

test('unknown routes fall through and cross-site credential-trial writes are fenced', async (t) => {
  const fixture = createNebulaFixture()
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const unknown = await server.request(`${PREFIX}/nope`)
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.code, 'NOT_FOUND')

  const crossSite = await server.request(`${PREFIX}/internal/credential-trial`, {
    method: 'POST',
    body: { credential_id: 'CR-1', status: 'failed' },
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.json.code, 'FORBIDDEN_ORIGIN')

  // POST /graph is a read-only projection, but it is still a POST: the strict
  // write fence applies. A foreign web origin is rejected ...
  const foreignOrigin = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'all' }, realm: 'web' },
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(foreignOrigin.status, 403)
  assert.equal(foreignOrigin.json.code, 'FORBIDDEN_ORIGIN')

  // ... while the real callers pass: the DSH desktop main process strips
  // Origin/Sec-Fetch-Site before forwarding (covered by every other request in
  // this file), and the browser GUI uses a loopback http origin.
  const loopbackOriginGraph = await server.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'all' }, realm: 'web' },
    headers: { origin: `http://127.0.0.1:${server.port}`, 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(loopbackOriginGraph.status, 200)

  // Loopback HTTP origins pass the write fence.
  const loopbackOrigin = await server.request(`${PREFIX}/internal/credential-trial`, {
    method: 'POST',
    body: { credential_id: 'CR-1', status: 'attempted' },
    headers: { origin: `http://127.0.0.1:${server.port}`, 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(loopbackOrigin.status, 200)
})

test('missing database file / incompatible schema report 409 instead of crashing', async (t) => {
  const fixture = createNebulaFixture()
  const missingDir = createTestDb({ seed: true, schemaVersion: 4 })
  const server = await startNebulaServer({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
    cleanupDir(missingDir.dir)
  })
  // Reuse the seeded DB path but point a second server at a nonexistent file.
  const gone = await startNebulaServer({ dbPath: `${fixture.dbPath}.missing` })
  t.after(async () => {
    await gone.close()
  })
  const missing = await gone.request(`${PREFIX}/graph`, {
    method: 'POST',
    body: { scope: { kind: 'all' } },
  })
  assert.equal(missing.status, 409)
  assert.equal(missing.json.code, 'SCHEMA_INCOMPATIBLE')
  assert.ok(!missing.text.includes(fixture.dir))

  const oldSchema = await startNebulaServer({ dbPath: missingDir.dbPath })
  t.after(async () => {
    await oldSchema.close()
  })
  const incompatible = await oldSchema.request(`${PREFIX}/internal/projects`)
  assert.equal(incompatible.status, 409)
  assert.equal(incompatible.json.code, 'SCHEMA_INCOMPATIBLE')
})

/* ---------------------------------- integration: real plugin host wiring -- */

test('createCortexHost serves /cortex-api/cortex/{graph,internal} end to end', async (t) => {
  const fixture = createNebulaFixture()
  // Real host half + real router dispatch (owned by cortex-host-api): this is
  // the path the ported renderer actually uses, including the same-origin write
  // fence (no Origin header -> allowed, content-type application/json).
  const server = await startTestHost({ dbPath: fixture.dbPath })
  t.after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  const graph = await server.request('/cortex-api/cortex/graph', {
    method: 'POST',
    body: { scope: { kind: 'all' }, realm: 'all' },
  })
  assert.equal(graph.status, 200, graph.text.slice(0, 300))
  assertMemoryGraphShape(graph.json)
  assert.ok(graph.json.meta.counts.foothold >= 1)
  assert.ok(graph.json.meta.counts.internal_host >= 1)

  const projects = await server.request('/cortex-api/cortex/internal/projects')
  assert.equal(projects.status, 200)
  assert.ok(Array.isArray(projects.json))

  const overview = await server.request(
    `/cortex-api/cortex/internal/overview?project_name=${encodeURIComponent('Project Alpha')}`,
  )
  assert.equal(overview.status, 200)
  assert.equal(overview.json.project_name, 'Project Alpha')
  assert.ok(!overview.text.includes('SuperSecretValue!42'))

  const loot = await server.request(
    `/cortex-api/cortex/loot?project_name=${encodeURIComponent('Project Alpha')}`,
  )
  assert.equal(loot.status, 200)
  assert.equal(loot.json.length, 1)

  const trialWrite = await server.request('/cortex-api/cortex/internal/credential-trial', {
    method: 'POST',
    body: { credential_id: 'CR-1', status: 'attempted' },
  })
  // Writable fixture host: the append succeeds and returns the trial shape.
  assert.equal(trialWrite.status, 200)
  assert.match(trialWrite.json.id, /^TR-/)
})


test('compiled builder runs against the node:sqlite adapter with the fixture', async (t) => {
  const fixture = createNebulaFixture()
  const db = openRawDb(fixture.dbPath)
  db.exec('PRAGMA busy_timeout = 5000')
  const adapter = createGraphDatabaseAdapter({ db })
  t.after(() => {
    db.close()
    cleanupDir(fixture.dir)
  })

  // The adapter exposes every method the vendored builder calls (including the
  // internal entry-asset projection that is easy to miss).
  for (const method of [
    'listGraphVulnerabilities',
    'countVulnerabilities',
    'listAssetsForGraph',
    'countAssets',
    'listGraphSnapshots',
    'countSnapshotSessions',
    'getAssetDetail',
    'getSnapshotSession',
    'listGraphInternalFootholds',
    'countFootholds',
    'listGraphInternalHosts',
    'countInternalHosts',
    'listGraphInternalServices',
    'countInternalServices',
    'listGraphInternalPivots',
    'listGraphInternalEntryAssets',
  ]) {
    assert.equal(typeof adapter[method], 'function', `adapter.${method} exists`)
  }

  const graph = buildMemoryGraph(adapter, { scope: { kind: 'all' }, realm: 'all' })
  assertMemoryGraphShape(graph)
  const types = new Set(graph.nodes.map((node) => node.type))
  assert.ok(types.has('host') && types.has('vuln') && types.has('snapshot'))
  assert.ok(types.has('foothold') && types.has('internal_host') && types.has('internal_service'))
  assert.ok(Array.isArray(graph.routes) && graph.routes.length === 1)
  assert.ok(!JSON.stringify(graph).includes('SuperSecretValue!42'))

  // Unresolved asset scope: empty graph + the missing hostPort reported.
  const missing = buildMemoryGraph(adapter, {
    scope: { kind: 'asset', hostPort: 'http://does-not-exist.test/' },
  })
  assert.deepEqual(missing.nodes, [])
  assert.deepEqual(missing.meta.unresolvedTargets, ['http://does-not-exist.test/'])

  // getAssetDetail normalizes the stored identifier like the original service.
  const asset = adapter.getAssetDetail('HTTP://127.0.0.1:8080')
  assert.ok(asset)
  assert.equal(asset.project_name, 'Project Alpha')
  assert.deepEqual(asset.interface_dir, ['/login', '/orders'])
  assert.equal(asset.leaked_infos.length, 1)
  assert.deepEqual(asset.leaked_infos[0].info_type, 'Credential')
})
