/**
 * Real-HTTP tests for the ported Cortex desktop UI host API.
 *
 * Every test builds its own throwaway schema-v5 database with
 * `createFixtureDb()` from `fixtures/build.mjs` (never the live
 * `~/.cortex/data.db`), starts a real loopback `node:http` server wired to
 * `createCortexHost()`, and talks to it over 127.0.0.1.
 *
 * Contract exercised (see `src/cortex-ui/dsh/api.ts` + `shared/types.ts`):
 *   /rev, /vulns*, /stats, /assets*, /snapshots*, /loot, /db/info, /app/info,
 *   /setup/info, /poc/config, desktop-only 501 stubs, /repeater/send,
 *   delegated /graph + /internal/*, security fences and DB guards.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createFixtureDb, FIXTURE } from '../../fixtures/build.mjs'
import {
  cleanupDir,
  insertVuln,
  invokeFake,
  makeTempDir,
  openRawDb,
  startTestHost,
} from './helpers.mjs'

/** Build a fresh fixture DB (schema v5 + `fixtures/seed.json`). */
function createFixture(options = {}) {
  const dir = makeTempDir()
  const dbPath = join(dir, 'data.db')
  createFixtureDb(dbPath, options)
  return { dir, dbPath }
}

/** Mutate the fixture through a raw connection before the host opens it. */
function prepareDb(dbPath, mutate) {
  const db = openRawDb(dbPath)
  try {
    mutate(db)
  } finally {
    db.close()
  }
}

/** The shared read-only fixture: no test in this file writes to it. */
const read = createFixture()
const readServer = await startTestHost({ dbPath: read.dbPath })

const schemaFixture = createFixture({ schemaVersion: 4 })
const schemaServer = await startTestHost({ dbPath: schemaFixture.dbPath })

const readOnlyFixture = createFixture()
const readOnlyServer = await startTestHost({ dbPath: readOnlyFixture.dbPath, readOnly: true })

const missingDir = makeTempDir()
const missingDbPath = join(missingDir, 'data.db')
const missingServer = await startTestHost({ dbPath: missingDbPath })

after(async () => {
  await Promise.all([
    readServer.close(),
    schemaServer.close(),
    readOnlyServer.close(),
    missingServer.close(),
  ])
  for (const dir of [read.dir, schemaFixture.dir, readOnlyFixture.dir, missingDir]) cleanupDir(dir)
})

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

/** @param {{status:number, json:any, text:string}} res */
function expectOk(res) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text.slice(0, 300)}`)
  assert.ok(res.json !== null, 'expected a JSON body')
  return res.json
}

/** @param {{status:number, json:any, text:string}} res */
function expectCode(res, status, code) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`)
  assert.equal(res.json && res.json.code, code)
  assert.equal(typeof (res.json && res.json.error), 'string')
  return res.json
}

const VULN_ITEM_KEYS = [
  'created_at',
  'entry_point',
  'host',
  'id',
  'internal_service_id',
  'realm',
  'service_host',
  'severity',
  'status',
  'target_url',
  'vuln_name',
  'vuln_type',
]

const VULN_KEYS = [
  ...VULN_ITEM_KEYS,
  'affected_interfaces',
  'crypto_details',
  'description',
  'impact',
  'related_vuln_ids',
  'remediation',
  'reproduction_steps',
  'retest_results',
  'test_boundaries',
].sort()

const ASSET_ITEM_KEYS = [
  'auth_required',
  'host',
  'host_port',
  'interface_count',
  'last_seen',
  'leak_count',
  'project_name',
  'related_vuln_count',
  'status',
  'tech_stack',
]

const SNAPSHOT_SUMMARY_KEYS = [
  'archived_at',
  'child_count',
  'created_at',
  'current_phase',
  'failed_count',
  'has_previous_state',
  'next_steps_excerpt',
  'parent_session_id',
  'project_name',
  'session_id',
  'target_hosts',
  'tested_interface_count',
  'unfinished_count',
  'updated_at',
]

/** Full `SnapshotSession` keys: the nine payload fields + session metadata. */
const SNAPSHOT_KEYS = [
  'project_name',
  'target_hosts',
  'current_phase',
  'unfinished_tasks',
  'failed_paths',
  'tested_interfaces',
  'notes',
  'related_vuln_ids',
  'next_steps',
  'session_id',
  'parent_session_id',
  'archived_at',
  'child_count',
  'created_at',
  'updated_at',
  'has_previous_state',
].sort()

/* ------------------------------------------------------------------------- */
/* /rev                                                                      */
/* ------------------------------------------------------------------------- */

describe('cortex: /rev', () => {
  it('returns a numeric revision with no absolute path in the payload', async () => {
    const body = expectOk(await readServer.request('/cortex-api/cortex/rev'))
    assert.deepEqual(Object.keys(body), ['rev'])
    assert.equal(typeof body.rev, 'number')
    assert.ok(Number.isFinite(body.rev))
  })

  it('changes after a write and stays stable when nothing changes', async () => {
    const fixture = createFixture()
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const first = expectOk(await server.request('/cortex-api/cortex/rev')).rev
      const stable = expectOk(await server.request('/cortex-api/cortex/rev')).rev
      assert.equal(first, stable)
      const patch = await server.request('/cortex-api/cortex/vulns/VULN-20261101-001/status', {
        method: 'PATCH',
        body: { status: 'Inconclusive' },
      })
      assert.equal(patch.status, 200)
      const afterWrite = expectOk(await server.request('/cortex-api/cortex/rev')).rev
      assert.notEqual(afterWrite, first)
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* /vulns                                                                    */
/* ------------------------------------------------------------------------- */

describe('cortex: GET /vulns', () => {
  it('returns PaginatedVulnerabilities with the shared snake_case item shape', async () => {
    const body = expectOk(await readServer.request('/cortex-api/cortex/vulns'))
    assert.equal(body.total, 9)
    assert.equal(body.page, 1)
    assert.equal(body.pageSize, 10)
    assert.equal(body.items.length, 9)
    assert.deepEqual(Object.keys(body.items[0]).sort(), VULN_ITEM_KEYS)
    assert.equal(body.items[0].id, 'VULN-20261103-009')
    assert.equal(body.items[0].realm, 'web')
    assert.equal(body.items[0].vulnName, undefined)
  })

  it('filters by realm, severity, status, search and host', async () => {
    let body = expectOk(await readServer.request('/cortex-api/cortex/vulns?realm=web'))
    assert.equal(body.total, 7)
    body = expectOk(await readServer.request('/cortex-api/cortex/vulns?realm=internal'))
    assert.equal(body.total, 2)
    assert.ok(body.items.every((item) => item.realm === 'internal'))

    body = expectOk(await readServer.request('/cortex-api/cortex/vulns?severity=Critical'))
    assert.equal(body.total, 2)
    assert.ok(body.items.every((item) => item.severity === 'Critical'))

    body = expectOk(await readServer.request('/cortex-api/cortex/vulns?status=Retest_Passed'))
    assert.equal(body.total, 1)
    assert.equal(body.items[0].id, 'VULN-20261102-004')

    body = expectOk(await readServer.request('/cortex-api/cortex/vulns?search=SQL'))
    assert.equal(body.total, 1)
    assert.equal(body.items[0].id, 'VULN-20261101-001')

    body = expectOk(
      await readServer.request('/cortex-api/cortex/vulns?host=minimal.example.test%3A8080'),
    )
    assert.equal(body.total, 1)
    assert.equal(body.items[0].id, 'VULN-20261102-005')

    body = expectOk(
      await readServer.request(
        '/cortex-api/cortex/vulns?realm=internal&severity=High&status=Inconclusive',
      ),
    )
    assert.equal(body.total, 1)
    assert.equal(body.items[0].id, 'VULN-20261103-007')
  })

  it('sorts by whitelisted fields with a leading - for descending', async () => {
    let body = expectOk(await readServer.request('/cortex-api/cortex/vulns?sort=severity'))
    assert.equal(body.items[0].severity, 'Critical')
    body = expectOk(await readServer.request('/cortex-api/cortex/vulns?sort=-severity'))
    assert.equal(body.items[0].severity, 'Info')
    body = expectOk(await readServer.request('/cortex-api/cortex/vulns?sort=-created_at'))
    assert.equal(body.items[0].id, 'VULN-20261103-009')
    expectCode(
      await readServer.request('/cortex-api/cortex/vulns?sort=drop%20table'),
      400,
      'BAD_REQUEST',
    )
  })

  it('paginates, clamps the page and enforces the pageSize ceiling', async () => {
    let body = expectOk(await readServer.request('/cortex-api/cortex/vulns?page=2&pageSize=4'))
    assert.equal(body.page, 2)
    assert.equal(body.pageSize, 4)
    assert.equal(body.items.length, 4)
    assert.equal(body.total, 9)

    body = expectOk(await readServer.request('/cortex-api/cortex/vulns?page=99&pageSize=4'))
    assert.equal(body.page, 3)
    assert.equal(body.items.length, 1)

    // The Cortex renderer's retest page asks for pageSize=200, so the cortex API
    // ceiling is 500 (legacy DSH-style routes keep their own 100 ceiling).
    body = expectOk(await readServer.request('/cortex-api/cortex/vulns?pageSize=200'))
    assert.equal(body.pageSize, 200)

    expectCode(
      await readServer.request('/cortex-api/cortex/vulns?pageSize=501'),
      400,
      'BAD_REQUEST',
    )
    expectCode(await readServer.request('/cortex-api/cortex/vulns?page=0'), 400, 'BAD_REQUEST')
    expectCode(await readServer.request('/cortex-api/cortex/vulns?page=abc'), 400, 'BAD_REQUEST')
    expectCode(await readServer.request('/cortex-api/cortex/vulns?realm=bogus'), 400, 'BAD_REQUEST')
  })
})

describe('cortex: GET /vulns/:id', () => {
  it('returns the full Vulnerability record', async () => {
    const body = expectOk(
      await readServer.request(`/cortex-api/cortex/vulns/${FIXTURE.vulnWithRetest}`),
    )
    assert.deepEqual(Object.keys(body).sort(), VULN_KEYS)
    assert.equal(body.id, FIXTURE.vulnWithRetest)
    assert.equal(body.retest_results.length, 1)
    assert.equal(body.retest_results[0].time_range.length > 0, true)
    assert.equal(typeof body.retest_results[0].conclusion, 'string')
    assert.ok(body.related_vuln_ids.length > 0)
  })

  it('degrades corrupt JSON columns to empty arrays', async () => {
    const body = expectOk(
      await readServer.request(`/cortex-api/cortex/vulns/${FIXTURE.vulnCorruptJson}`),
    )
    assert.deepEqual(body.affected_interfaces, [])
    assert.deepEqual(body.related_vuln_ids, [])
  })

  it('returns 200 null for an unknown id and 400 for a malformed one', async () => {
    const res = await readServer.request('/cortex-api/cortex/vulns/VULN-DOES-NOT-EXIST')
    assert.equal(res.status, 200)
    assert.equal(res.json, null)
    expectCode(await readServer.request('/cortex-api/cortex/vulns/%E0%A4%A'), 400, 'BAD_REQUEST')
  })
})

/* ------------------------------------------------------------------------- */
/* /stats                                                                    */
/* ------------------------------------------------------------------------- */

describe('cortex: GET /stats', () => {
  it('returns the DashboardStats shape scoped by realm', async () => {
    const web = expectOk(await readServer.request('/cortex-api/cortex/stats?realm=web'))
    assert.deepEqual(Object.keys(web).sort(), [
      'bySeverity',
      'byStatus',
      'critical',
      'high',
      'hosts',
      'internal',
      'today',
      'total',
    ])
    assert.equal(web.total, 7)
    assert.equal(web.critical, 1)
    assert.equal(web.high, 2)
    assert.equal(web.hosts, 2)
    assert.deepEqual(web.bySeverity, { Critical: 1, High: 2, Medium: 2, Low: 1, Info: 1 })
    assert.deepEqual(web.byStatus, { Confirmed: 5, Inconclusive: 1, Retest_Passed: 1 })
    assert.deepEqual(web.internal, { total: 2, critical: 1, high: 1, hosts: 1 })

    const internal = expectOk(await readServer.request('/cortex-api/cortex/stats?realm=internal'))
    assert.equal(internal.total, 2)
    assert.equal(internal.critical, 1)
    assert.equal(internal.bySeverity.High, 1)

    const all = expectOk(await readServer.request('/cortex-api/cortex/stats'))
    assert.equal(all.total, 9)
    assert.equal(all.byStatus.Confirmed, 6)
  })

  it('counts rows created since local midnight', async () => {
    const fixture = createFixture()
    prepareDb(fixture.dbPath, (db) => {
      insertVuln(db, {
        id: 'VULN-TODAY-001',
        host: 'today.example.test',
        vuln_name: '今天新增',
        vuln_type: 'Test',
        severity: 'Info',
        target_url: 'http://today.example.test/',
        created_at: new Date().toISOString(),
      })
    })
    const db = openRawDb(fixture.dbPath)
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const expectedToday = Number(
      db.prepare('SELECT COUNT(*) AS c FROM vulnerabilities WHERE created_at >= ?').get(
        start.toISOString(),
      ).c,
    )
    db.close()

    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const stats = expectOk(await server.request('/cortex-api/cortex/stats'))
      assert.equal(stats.today, expectedToday)
      assert.ok(stats.today >= 1)
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* /assets                                                                   */
/* ------------------------------------------------------------------------- */

describe('cortex: GET /assets', () => {
  it('lists AssetListItem rows without pagination', async () => {
    const items = expectOk(await readServer.request('/cortex-api/cortex/assets'))
    assert.ok(Array.isArray(items))
    assert.equal(items.length, 2)
    assert.deepEqual(Object.keys(items[0]).sort(), ASSET_ITEM_KEYS)
    assert.equal(items[0].host_port, FIXTURE.webAssetHostPort)
    assert.equal(items[0].interface_count, 9)
    assert.equal(items[0].leak_count, 2)
    assert.equal(items[0].related_vuln_count, 4)
    assert.equal(items[0].auth_required, true)
    assert.equal(items[1].host_port, FIXTURE.minimalAssetHostPort)
    assert.equal(items[1].interface_count, 0)
  })

  it('filters by search and status', async () => {
    let items = expectOk(await readServer.request('/cortex-api/cortex/assets?status=Dead'))
    assert.equal(items.length, 1)
    assert.equal(items[0].host_port, FIXTURE.minimalAssetHostPort)
    items = expectOk(await readServer.request('/cortex-api/cortex/assets?search=minimal'))
    assert.equal(items.length, 1)
    items = expectOk(await readServer.request('/cortex-api/cortex/assets?search=nope-xyz'))
    assert.deepEqual(items, [])
    expectCode(await readServer.request('/cortex-api/cortex/assets?status=Hacked'), 400, 'BAD_REQUEST')
  })

  it('returns the full AssetContext for an encoded host_port (URL with scheme/port)', async () => {
    const body = expectOk(
      await readServer.request(
        `/cortex-api/cortex/assets/${encodeURIComponent(FIXTURE.webAssetHostPort)}`,
      ),
    )
    assert.equal(body.host_port, FIXTURE.webAssetHostPort)
    assert.equal(body.host, 'demo.example.test')
    assert.equal(body.project_name, FIXTURE.webProject)
    assert.equal(body.auth_required, true)
    assert.equal(body.interfaces.length, 4)
    assert.equal(body.interfaces[0].path, '/api/v1/login')
    assert.equal(body.interfaces[0].method, 'POST')
    assert.equal(body.interfaces[0].request.startsWith('POST /api/v1/login HTTP/1.1'), true)
    assert.equal(body.interface_dir.length, 5)
    assert.equal(body.leaked_infos.length, 2)
    assert.equal(body.leaked_infos[0].info_type, 'API_Key')
    assert.equal(body.test_parameters.length, 2)
    assert.equal(body.test_parameters[0].location, 'path')
    assert.deepEqual(body.test_parameters[0].related_vuln_ids, ['VULN-20261101-002'])
    assert.equal(body.related_vuln_ids.length, 4)
    assert.equal(typeof body.last_seen, 'string')
  })

  it('returns 200 null for an unknown asset and [] for its related vulns', async () => {
    const detail = await readServer.request(
      `/cortex-api/cortex/assets/${encodeURIComponent('https://nope.example.test')}`,
    )
    assert.equal(detail.status, 200)
    assert.equal(detail.json, null)
    const related = expectOk(
      await readServer.request(
        `/cortex-api/cortex/assets/${encodeURIComponent('https://nope.example.test')}/related-vulns`,
      ),
    )
    assert.deepEqual(related, [])
  })

  it('returns related VulnerabilityListItem rows in stored order', async () => {
    const items = expectOk(
      await readServer.request(
        `/cortex-api/cortex/assets/${encodeURIComponent(FIXTURE.webAssetHostPort)}/related-vulns`,
      ),
    )
    assert.equal(items.length, 4)
    assert.deepEqual(Object.keys(items[0]).sort(), VULN_ITEM_KEYS)
    assert.deepEqual(
      items.map((item) => item.id),
      ['VULN-20261101-001', 'VULN-20261101-002', 'VULN-20261101-003', 'VULN-20261102-006'],
    )
  })
})

/* ------------------------------------------------------------------------- */
/* /snapshots                                                                */
/* ------------------------------------------------------------------------- */

describe('cortex: GET /snapshots', () => {
  it('returns compact SnapshotSummary rows and honors the renderer filters', async () => {
    let body = expectOk(await readServer.request('/cortex-api/cortex/snapshots'))
    assert.equal(body.total, 2)
    assert.equal(body.items.length, 2)
    assert.deepEqual(Object.keys(body.items[0]).sort(), SNAPSHOT_SUMMARY_KEYS)
    assert.ok(body.items[0].next_steps_excerpt.length <= 300)

    body = expectOk(await readServer.request('/cortex-api/cortex/snapshots?rootsOnly=true'))
    assert.equal(body.total, 1)
    assert.equal(body.items[0].session_id, FIXTURE.parentSession)

    body = expectOk(
      await readServer.request('/cortex-api/cortex/snapshots?rootsOnly=true&includeArchived=true'),
    )
    assert.equal(body.total, 2)

    body = expectOk(
      await readServer.request(
        `/cortex-api/cortex/snapshots?parentSessionId=${encodeURIComponent(FIXTURE.parentSession)}&includeArchived=true`,
      ),
    )
    assert.equal(body.total, 1)
    assert.equal(body.items[0].session_id, FIXTURE.childSession)

    body = expectOk(
      await readServer.request('/cortex-api/cortex/snapshots?includeArchived=1&limit=10'),
    )
    assert.equal(body.total, 3)
    assert.equal(body.items.length, 3)
    assert.ok(body.items.some((item) => item.archived_at !== null))

    body = expectOk(await readServer.request('/cortex-api/cortex/snapshots?limit=1'))
    assert.equal(body.total, 2)
    assert.equal(body.items.length, 1)
    expectCode(await readServer.request('/cortex-api/cortex/snapshots?limit=101'), 400, 'BAD_REQUEST')
  })

  it('returns the full nine-field SnapshotSession or null', async () => {
    let body = expectOk(
      await readServer.request(`/cortex-api/cortex/snapshots/${FIXTURE.parentSession}`),
    )
    assert.deepEqual(Object.keys(body).sort(), SNAPSHOT_KEYS)
    assert.equal(body.session_id, FIXTURE.parentSession)
    assert.equal(body.parent_session_id, null)
    assert.equal(body.archived_at, null)
    assert.equal(body.child_count, 1)
    assert.equal(body.unfinished_tasks.length, 2)
    assert.equal(body.failed_paths.length, 2)
    assert.equal(body.tested_interfaces.length, 2)
    assert.equal(body.tested_interfaces[0].target.length > 0, true)
    assert.equal(body.has_previous_state, false)

    body = expectOk(
      await readServer.request(`/cortex-api/cortex/snapshots/${FIXTURE.childSession}`),
    )
    assert.equal(body.parent_session_id, FIXTURE.parentSession)
    assert.equal(body.has_previous_state, true)

    const missing = await readServer.request('/cortex-api/cortex/snapshots/SESS-19700101-001')
    assert.equal(missing.status, 200)
    assert.equal(missing.json, null)
  })
})

/* ------------------------------------------------------------------------- */
/* /loot (delegated to internal-ops) + delegated graph/internal              */
/* ------------------------------------------------------------------------- */

describe('cortex: delegated /graph + /internal + /loot', () => {
  it('POST /graph returns MemoryGraphData from the Nebula builder', async () => {
    const body = expectOk(
      await readServer.request('/cortex-api/cortex/graph', {
        method: 'POST',
        body: { scope: { kind: 'all' } },
      }),
    )
    assert.ok(Array.isArray(body.nodes))
    assert.ok(Array.isArray(body.links))
    assert.equal(body.meta.scope.kind, 'all')
    assert.equal(typeof body.meta.counts, 'object')
    assert.equal(typeof body.meta.truncated, 'boolean')
    assert.ok(body.nodes.length > 0)

    expectCode(
      await readServer.request('/cortex-api/cortex/graph', { method: 'GET' }),
      405,
      'METHOD_NOT_ALLOWED',
    )
    expectCode(
      await readServer.request('/cortex-api/cortex/graph', {
        method: 'POST',
        body: { scope: { kind: 'bogus' } },
      }),
      400,
      'BAD_REQUEST',
    )
  })

  it('GET /internal/* and GET /loot return the internal-ops projections', async () => {
    const projects = expectOk(await readServer.request('/cortex-api/cortex/internal/projects'))
    assert.ok(Array.isArray(projects))
    assert.ok(projects.length >= 1)
    assert.equal(typeof projects[0].project_name, 'string')
    assert.equal(typeof projects[0].counts.hosts, 'number')

    const overview = expectOk(await readServer.request('/cortex-api/cortex/internal/overview'))
    assert.ok(overview && typeof overview === 'object')
    assert.ok(Array.isArray(overview.footholds))
    assert.ok(Array.isArray(overview.hosts))
    assert.ok(Array.isArray(overview.services))
    assert.ok(Array.isArray(overview.pivots))

    const graph = expectOk(
      await readServer.request(
        `/cortex-api/cortex/internal/graph?project_name=${encodeURIComponent(projects[0].project_name)}`,
      ),
    )
    // InternalGraphData: entity lists for the heatmap / credential matrix /
    // route view of the internal-ops page (not a node/link graph).
    assert.equal(graph.project_name, projects[0].project_name)
    assert.equal(typeof graph.generated_at, 'string')
    assert.equal(typeof graph.counts, 'object')
    for (const field of [
      'footholds',
      'hosts',
      'services',
      'credentials',
      'pivots',
      'trials',
      'heatmap',
      'suggestions',
      'warnings',
    ]) {
      assert.ok(Array.isArray(graph[field]), `internal graph ${field} must be an array`)
    }
    assert.equal(typeof graph.truncated, 'boolean')
    assert.ok(graph.credentials.every((credential) => credential.secret === undefined))

    const loot = expectOk(await readServer.request('/cortex-api/cortex/loot'))
    assert.ok(Array.isArray(loot))
  })

  it('GET /loot returns the exact LootImport[] shape', async () => {
    const fixture = createFixture()
    prepareDb(fixture.dbPath, (db) => {
      db.prepare(
        `INSERT INTO loot_imports (id, project_name, entry_host_port, filename, sha256, format, parser, status, summary_json, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'LOOT-20260101-001',
        'FIXTURE-PROJECT-WEB',
        FIXTURE.webAssetHostPort,
        'secretsdump.txt',
        'a'.repeat(64),
        'secretsdump-text',
        'secretsdump',
        'parsed',
        JSON.stringify({ hosts: 2, services: 3, credentials: 4, warnings: ['w'], needs_review: 1 }),
        '',
        '2026-01-01T00:00:00.000Z',
      )
    })
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const items = expectOk(await server.request('/cortex-api/cortex/loot'))
      assert.equal(items.length, 1)
      assert.deepEqual(Object.keys(items[0]).sort(), [
        'created_at',
        'entry_host_port',
        'error',
        'filename',
        'format',
        'id',
        'parser',
        'project_name',
        'sha256',
        'status',
        'summary',
      ])
      assert.deepEqual(items[0].summary, {
        hosts: 2,
        services: 3,
        credentials: 4,
        warnings: ['w'],
        needs_review: 1,
      })
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* Misc metadata + desktop-only stubs                                        */
/* ------------------------------------------------------------------------- */

describe('cortex: metadata endpoints', () => {
  it('GET /db/info never leaks the absolute database path', async () => {
    const res = await readServer.request('/cortex-api/cortex/db/info')
    const body = expectOk(res)
    assert.deepEqual(Object.keys(body).sort(), [
      'dbPath',
      'exists',
      'lastModifiedAt',
      'schemaVersion',
      'sizeBytes',
      'walSizeBytes',
    ])
    assert.equal(body.dbPath, 'data.db')
    assert.equal(body.schemaVersion, 5)
    assert.equal(body.exists, true)
    assert.ok(body.sizeBytes > 0)
    assert.ok(body.lastModifiedAt === null || typeof body.lastModifiedAt === 'string')
    assert.equal(res.text.includes(read.dir), false)
    assert.equal(res.text.includes(JSON.stringify(read.dir).slice(1, -1)), false)
  })

  it('GET /app/info returns AppInfo fields without absolute paths', async () => {
    const res = await readServer.request('/cortex-api/cortex/app/info')
    const body = expectOk(res)
    assert.deepEqual(Object.keys(body).sort(), [
      'chromeVersion',
      'dbPath',
      'electronVersion',
      'mcpRuntime',
      'name',
      'nodeVersion',
      'platform',
      'projectRoot',
      'schemaVersion',
      'version',
    ])
    assert.equal(body.name, 'Cortex')
    assert.match(body.version, /^\d+\.\d+\.\d+/)
    assert.equal(body.dbPath, 'data.db')
    assert.equal(body.schemaVersion, 5)
    assert.equal(body.platform, process.platform)
    assert.equal(body.nodeVersion, process.version)
    assert.equal(body.projectRoot, '')
    assert.deepEqual(Object.keys(body.mcpRuntime).sort(), ['command', 'display', 'entry', 'mode'])
    assert.equal(res.text.includes(read.dir), false)
  })

  it('GET /setup/info and GET /poc/config are safe stubs', async () => {
    const setup = expectOk(await readServer.request('/cortex-api/cortex/setup/info'))
    assert.deepEqual(Object.keys(setup).sort(), [
      'agents',
      'alreadyConfigured',
      'defaultSkillLanguage',
      'defaultUiLanguage',
    ])
    assert.deepEqual(setup.agents, [])
    assert.equal(setup.alreadyConfigured, true)

    const poc = expectOk(await readServer.request('/cortex-api/cortex/poc/config'))
    assert.deepEqual(Object.keys(poc).sort(), [
      'activeProviderId',
      'configFileExists',
      'enabled',
      'executionEnabled',
      'limits',
      'overriddenByEnv',
      'path',
      'permissionWarning',
      'providers',
      'proxy',
    ])
    assert.deepEqual(poc.providers, [])
    assert.equal(poc.enabled, false)
    assert.deepEqual(Object.keys(poc.proxy).sort(), [
      'allowInsecureTls',
      'caConfigured',
      'enabled',
      'url',
    ])
    assert.equal(poc.limits.totalTimeoutMs, 10_000)
  })

  it('desktop-only stubs answer 501 UNSUPPORTED', async () => {
    const cases = [
      ['POST', '/cortex-api/cortex/setup/run', { agents: [] }],
      ['POST', '/cortex-api/cortex/seed-demo', {}],
      ['POST', '/cortex-api/cortex/loot/import', {}],
      ['POST', '/cortex-api/cortex/poc/config', {}],
      ['POST', '/cortex-api/cortex/poc/reload', {}],
      ['POST', '/cortex-api/cortex/poc/providers', {}],
      ['DELETE', '/cortex-api/cortex/poc/providers/abc', undefined],
      ['POST', '/cortex-api/cortex/poc/models', {}],
      ['POST', '/cortex-api/cortex/poc/provider-test', {}],
    ]
    for (const [method, path, body] of cases) {
      const res = await readServer.request(path, body === undefined ? { method } : { method, body })
      expectCode(res, 501, 'UNSUPPORTED')
    }
  })
})

/* ------------------------------------------------------------------------- */
/* Vulnerability writes                                                      */
/* ------------------------------------------------------------------------- */

describe('cortex: vulnerability writes', () => {
  it('PATCH /vulns/:id/status changes only status and returns the full record', async () => {
    const fixture = createFixture()
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const before = expectOk(
        await server.request(`/cortex-api/cortex/vulns/${FIXTURE.vulnMultiHttp}`),
      )
      const res = await server.request(
        `/cortex-api/cortex/vulns/${FIXTURE.vulnMultiHttp}/status`,
        { method: 'PATCH', body: { status: 'Inconclusive' } },
      )
      const body = expectOk(res)
      assert.deepEqual(Object.keys(body).sort(), VULN_KEYS)
      assert.equal(body.status, 'Inconclusive')
      assert.equal(body.vuln_name, before.vuln_name)
      assert.equal(body.reproduction_steps, before.reproduction_steps)
      assert.deepEqual(body.retest_results, before.retest_results)

      const persisted = expectOk(
        await server.request(`/cortex-api/cortex/vulns/${FIXTURE.vulnMultiHttp}`),
      )
      assert.equal(persisted.status, 'Inconclusive')

      expectCode(
        await server.request(`/cortex-api/cortex/vulns/${FIXTURE.vulnMultiHttp}/status`, {
          method: 'PATCH',
          body: { status: 'Bogus' },
        }),
        400,
        'BAD_REQUEST',
      )
      expectCode(
        await server.request('/cortex-api/cortex/vulns/VULN-MISSING/status', {
          method: 'PATCH',
          body: { status: 'Confirmed' },
        }),
        404,
        'NOT_FOUND',
      )
      expectCode(
        await server.request(`/cortex-api/cortex/vulns/${FIXTURE.vulnMultiHttp}/status`, {
          method: 'POST',
          body: { status: 'Confirmed' },
        }),
        405,
        'METHOD_NOT_ALLOWED',
      )
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })

  it('DELETE /vulns/:id works without a body/Content-Type and reports deleted', async () => {
    const fixture = createFixture()
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const deleted = expectOk(
        await server.request(`/cortex-api/cortex/vulns/${FIXTURE.vulnMultiHttp}`, {
          method: 'DELETE',
        }),
      )
      assert.deepEqual(deleted, { deleted: true })
      const missing = await server.request('/cortex-api/cortex/vulns/VULN-MISSING', {
        method: 'DELETE',
      })
      assert.equal(missing.status, 200)
      assert.deepEqual(missing.json, { deleted: false })

      const db = openRawDb(fixture.dbPath)
      try {
        assert.equal(
          db.prepare('SELECT id FROM vulnerabilities WHERE id = ?').get(FIXTURE.vulnMultiHttp),
          undefined,
        )
      } finally {
        db.close()
      }
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })

  it('POST /vulns/delete-many deletes only the requested ids', async () => {
    const fixture = createFixture()
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const ids = ['VULN-20261102-004', 'VULN-20261102-005']
      const body = expectOk(
        await server.request('/cortex-api/cortex/vulns/delete-many', {
          method: 'POST',
          body: { ids },
        }),
      )
      assert.deepEqual(body, { deleted: 2 })
      const empty = expectOk(
        await server.request('/cortex-api/cortex/vulns/delete-many', {
          method: 'POST',
          body: { ids: [] },
        }),
      )
      assert.deepEqual(empty, { deleted: 0 })
      expectCode(
        await server.request('/cortex-api/cortex/vulns/delete-many', {
          method: 'POST',
          body: { ids: 'not-an-array' },
        }),
        400,
        'BAD_REQUEST',
      )
      const list = expectOk(await server.request('/cortex-api/cortex/vulns'))
      assert.equal(list.total, 7)
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })

  it('POST /vulns/export returns inline Markdown reports', async () => {
    const fixture = createFixture()
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const ids = [FIXTURE.vulnMultiHttp, FIXTURE.vulnWithRetest]
      const body = expectOk(
        await server.request('/cortex-api/cortex/vulns/export', {
          method: 'POST',
          body: { ids },
        }),
      )
      assert.equal(body.cancelled, false)
      assert.equal(body.files.length, 2)
      for (const file of body.files) {
        assert.ok(ids.includes(file.id))
        assert.equal(file.filename.endsWith('.md'), true)
        assert.equal(file.content.startsWith('# '), true)
      }
      const retestFile = body.files.find((file) => file.id === FIXTURE.vulnWithRetest)
      assert.ok(retestFile.content.includes('## 复测记录'))

      const empty = expectOk(
        await server.request('/cortex-api/cortex/vulns/export', {
          method: 'POST',
          body: { ids: [] },
        }),
      )
      assert.deepEqual(empty, { cancelled: true, files: [] })
      const unknown = expectOk(
        await server.request('/cortex-api/cortex/vulns/export', {
          method: 'POST',
          body: { ids: ['VULN-MISSING'] },
        }),
      )
      assert.deepEqual(unknown, { cancelled: true, files: [] })
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* Asset / snapshot writes                                                   */
/* ------------------------------------------------------------------------- */

describe('cortex: asset writes', () => {
  it('DELETE /assets/:hostPort deletes only the asset row', async () => {
    const fixture = createFixture()
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const target = FIXTURE.minimalAssetHostPort
      const body = expectOk(
        await server.request(`/cortex-api/cortex/assets/${encodeURIComponent(target)}`, {
          method: 'DELETE',
        }),
      )
      assert.deepEqual(body, { deleted: true })
      const detail = await server.request(
        `/cortex-api/cortex/assets/${encodeURIComponent(target)}`,
      )
      assert.equal(detail.status, 200)
      assert.equal(detail.json, null)

      const list = expectOk(await server.request('/cortex-api/cortex/assets'))
      assert.equal(list.length, 1)

      const vulns = expectOk(await server.request('/cortex-api/cortex/vulns'))
      assert.equal(vulns.total, 9)
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })
})

describe('cortex: snapshot writes', () => {
  it('POST /snapshots/:id/archive cascades to child sessions', async () => {
    const fixture = createFixture()
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const archived = expectOk(
        await server.request(`/cortex-api/cortex/snapshots/${FIXTURE.parentSession}/archive`, {
          method: 'POST',
          body: { archived: true },
        }),
      )
      assert.equal(archived.session_id, FIXTURE.parentSession)
      assert.equal(typeof archived.archived_at, 'string')

      const child = expectOk(
        await server.request(`/cortex-api/cortex/snapshots/${FIXTURE.childSession}`),
      )
      assert.equal(child.archived_at, archived.archived_at)

      const hidden = expectOk(await server.request('/cortex-api/cortex/snapshots'))
      assert.equal(hidden.total, 0)

      const unarchived = expectOk(
        await server.request(`/cortex-api/cortex/snapshots/${FIXTURE.parentSession}/archive`, {
          method: 'POST',
          body: { archived: false },
        }),
      )
      assert.equal(unarchived.archived_at, null)
      const childAfter = expectOk(
        await server.request(`/cortex-api/cortex/snapshots/${FIXTURE.childSession}`),
      )
      assert.equal(childAfter.archived_at, null)

      expectCode(
        await server.request(`/cortex-api/cortex/snapshots/${FIXTURE.parentSession}/archive`, {
          method: 'POST',
          body: { archived: 'yes' },
        }),
        400,
        'BAD_REQUEST',
      )
      expectCode(
        await server.request('/cortex-api/cortex/snapshots/SESS-MISSING/archive', {
          method: 'POST',
          body: { archived: true },
        }),
        404,
        'NOT_FOUND',
      )
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })

  it('POST /snapshots/:id/restore-previous rolls back and clears the backup', async () => {
    const fixture = createFixture()
    prepareDb(fixture.dbPath, (db) => {
      db.prepare(
        'UPDATE snapshot_sessions SET previous_state = ?, current_phase = ?, next_steps = ? WHERE session_id = ?',
      ).run(
        JSON.stringify({ current_phase: '回滚前的阶段', next_steps: '旧下一步', notes: '旧备注' }),
        '被覆盖的新阶段',
        '新下一步',
        FIXTURE.childSession,
      )
    })
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const restored = expectOk(
        await server.request(
          `/cortex-api/cortex/snapshots/${FIXTURE.childSession}/restore-previous`,
          { method: 'POST', body: {} },
        ),
      )
      assert.equal(restored.current_phase, '回滚前的阶段')
      assert.equal(restored.next_steps, '旧下一步')
      assert.equal(restored.notes, '旧备注')
      assert.equal(restored.has_previous_state, false)

      expectCode(
        await server.request(`/cortex-api/cortex/snapshots/${FIXTURE.childSession}/restore-previous`, {
          method: 'POST',
          body: {},
        }),
        400,
        'BAD_REQUEST',
      )
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })

  it('DELETE /snapshots/:id cascades child sessions and reports the count', async () => {
    const fixture = createFixture()
    const server = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const body = expectOk(
        await server.request(`/cortex-api/cortex/snapshots/${FIXTURE.parentSession}`, {
          method: 'DELETE',
        }),
      )
      assert.deepEqual(body, { deleted: 2 })
      const parent = await server.request(
        `/cortex-api/cortex/snapshots/${FIXTURE.parentSession}`,
      )
      assert.equal(parent.json, null)
      const child = await server.request(`/cortex-api/cortex/snapshots/${FIXTURE.childSession}`)
      assert.equal(child.json, null)
      const list = expectOk(
        await server.request('/cortex-api/cortex/snapshots?includeArchived=true'),
      )
      assert.equal(list.total, 1)
    } finally {
      await server.close()
      cleanupDir(fixture.dir)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* /repeater/send                                                            */
/* ------------------------------------------------------------------------- */

describe('cortex: POST /repeater/send', () => {
  /** @type {import('node:http').Server} */
  let target
  /** @type {number} */
  let targetPort
  let targetOrigin
  let fixture
  let server
  let targetRequestCount = 0

  before(async () => {
    target = http.createServer((req, res) => {
      targetRequestCount += 1
      const chunks = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/hello' })
          res.end()
          return
        }
        if (req.url === '/big') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('x'.repeat(2 * 1024 * 1024 + 64 * 1024))
          return
        }
        if (req.url === '/echo') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(`${req.method}|${Buffer.concat(chunks).toString('utf8')}`)
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Target': 'local' })
        res.end('hello world')
      })
    })
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
    targetPort = target.address().port
    targetOrigin = `http://127.0.0.1:${targetPort}`

    fixture = createFixture()
    prepareDb(fixture.dbPath, (db) => {
      insertVuln(db, {
        id: 'VULN-REPEATER-001',
        host: `127.0.0.1:${targetPort}`,
        entry_point: '/',
        vuln_name: '本地回环 Repeater 目标',
        vuln_type: 'Test',
        severity: 'Info',
        target_url: `${targetOrigin}/hello`,
        created_at: '2026-01-01T00:00:00.000Z',
      })
    })
    server = await startTestHost({ dbPath: fixture.dbPath })
  })

  after(async () => {
    await server.close()
    await new Promise((resolve) => target.close(resolve))
    cleanupDir(fixture.dir)
  })

  it('executes the allowlisted request and maps the exact RepeaterSendResult shape', async () => {
    const result = expectOk(
      await server.request('/cortex-api/cortex/repeater/send', {
        method: 'POST',
        body: {
          vulnId: 'VULN-REPEATER-001',
          method: 'GET',
          url: `${targetOrigin}/hello`,
          headers: { 'X-Test': '1' },
          followRedirects: false,
        },
      }),
    )
    assert.deepEqual(Object.keys(result).sort(), ['request', 'response'])
    assert.deepEqual(Object.keys(result.request).sort(), ['body', 'headers', 'method', 'url'])
    assert.deepEqual(Object.keys(result.response).sort(), [
      'body',
      'durationMs',
      'headers',
      'status',
      'truncated',
    ])
    assert.equal(result.request.method, 'GET')
    assert.equal(result.request.url, `${targetOrigin}/hello`)
    assert.equal(result.request.headers['X-Test'], '1')
    assert.equal(result.request.body, '')
    assert.equal(result.response.status, 200)
    assert.equal(result.response.body, 'hello world')
    assert.equal(result.response.truncated, false)
    assert.equal(typeof result.response.durationMs, 'number')
    assert.ok(result.response.headers['content-type'].includes('text/plain'))
    assert.equal(result.response.headers['x-target'], 'local')
  })

  it('honors followRedirects=true and follows the redirect within the allowlist', async () => {
    const result = expectOk(
      await server.request('/cortex-api/cortex/repeater/send', {
        method: 'POST',
        body: {
          vulnId: 'VULN-REPEATER-001',
          method: 'GET',
          url: `${targetOrigin}/redirect`,
          followRedirects: true,
        },
      }),
    )
    assert.equal(result.response.status, 200)
    assert.equal(result.response.body, 'hello world')
  })

  it('does not follow redirects by default', async () => {
    const result = expectOk(
      await server.request('/cortex-api/cortex/repeater/send', {
        method: 'POST',
        body: {
          vulnId: 'VULN-REPEATER-001',
          method: 'GET',
          url: `${targetOrigin}/redirect`,
          followRedirects: false,
        },
      }),
    )
    assert.equal(result.response.status, 302)
  })

  it('sends a request body for POST and echoes it back', async () => {
    const result = expectOk(
      await server.request('/cortex-api/cortex/repeater/send', {
        method: 'POST',
        body: {
          vulnId: 'VULN-REPEATER-001',
          method: 'POST',
          url: `${targetOrigin}/echo`,
          headers: { 'Content-Type': 'text/plain' },
          body: 'ping-body',
          followRedirects: false,
        },
      }),
    )
    assert.equal(result.response.body, 'POST|ping-body')
  })

  it('flags responses above the 2 MiB cap as truncated', async () => {
    const result = expectOk(
      await server.request('/cortex-api/cortex/repeater/send', {
        method: 'POST',
        body: {
          vulnId: 'VULN-REPEATER-001',
          method: 'GET',
          url: `${targetOrigin}/big`,
          followRedirects: false,
        },
      }),
    )
    assert.equal(result.response.truncated, true)
    assert.equal(result.response.body.length, 2 * 1024 * 1024)
  })

  it('rejects origins outside the vulnerability allowlist', async () => {
    const body = expectCode(
      await server.request('/cortex-api/cortex/repeater/send', {
        method: 'POST',
        body: {
          vulnId: 'VULN-REPEATER-001',
          method: 'GET',
          url: 'https://evil.example.test/',
          followRedirects: false,
        },
      }),
      403,
      'ORIGIN_NOT_ALLOWED',
    )
    assert.ok(Array.isArray(body.details && body.details.allowed))
  })

  it('rejects an unknown vulnId and invalid methods', async () => {
    expectCode(
      await server.request('/cortex-api/cortex/repeater/send', {
        method: 'POST',
        body: {
          vulnId: 'VULN-MISSING',
          method: 'GET',
          url: `${targetOrigin}/hello`,
        },
      }),
      404,
      'NOT_FOUND',
    )
    expectCode(
      await server.request('/cortex-api/cortex/repeater/send', {
        method: 'POST',
        body: { vulnId: 'VULN-REPEATER-001', method: 'TRACE', url: `${targetOrigin}/hello` },
      }),
      400,
      'BAD_REQUEST',
    )
    assert.ok(targetRequestCount >= 1)
  })
})

/* ------------------------------------------------------------------------- */
/* Database availability / read-only mode                                    */
/* ------------------------------------------------------------------------- */

describe('cortex: database guards', () => {
  it('read-only host serves reads but rejects every write with READ_ONLY', async () => {
    expectOk(await readOnlyServer.request('/cortex-api/cortex/vulns'))
    expectOk(await readOnlyServer.request('/cortex-api/cortex/assets'))
    expectOk(await readOnlyServer.request('/cortex-api/cortex/snapshots'))
    expectOk(await readOnlyServer.request('/cortex-api/cortex/rev'))

    const writes = [
      ['PATCH', '/cortex-api/cortex/vulns/VULN-20261101-001/status', { status: 'Confirmed' }],
      ['DELETE', '/cortex-api/cortex/vulns/VULN-20261101-001', undefined],
      ['POST', '/cortex-api/cortex/vulns/delete-many', { ids: ['VULN-20261101-001'] }],
      [
        'POST',
        `/cortex-api/cortex/snapshots/${FIXTURE.parentSession}/archive`,
        { archived: true },
      ],
      ['DELETE', `/cortex-api/cortex/snapshots/${FIXTURE.parentSession}`, undefined],
      [
        'DELETE',
        `/cortex-api/cortex/assets/${encodeURIComponent(FIXTURE.webAssetHostPort)}`,
        undefined,
      ],
      ['POST', '/cortex-api/cortex/internal/credential-trial', {}],
    ]
    for (const [method, path, body] of writes) {
      const res = await readOnlyServer.request(path, body === undefined ? { method } : { method, body })
      expectCode(res, 403, 'READ_ONLY')
    }
  })

  it('schema != 5: data routes are 409 SCHEMA_INCOMPATIBLE, metadata routes still answer', async () => {
    expectCode(
      await schemaServer.request('/cortex-api/cortex/vulns'),
      409,
      'SCHEMA_INCOMPATIBLE',
    )
    expectCode(await schemaServer.request('/cortex-api/cortex/rev'), 409, 'SCHEMA_INCOMPATIBLE')
    expectCode(await schemaServer.request('/cortex-api/cortex/stats'), 409, 'SCHEMA_INCOMPATIBLE')
    expectCode(
      await schemaServer.request('/cortex-api/cortex/graph', {
        method: 'POST',
        body: { scope: { kind: 'all' } },
      }),
      409,
      'SCHEMA_INCOMPATIBLE',
    )
    expectCode(
      await schemaServer.request('/cortex-api/cortex/vulns/VULN-20261101-001/status', {
        method: 'PATCH',
        body: { status: 'Confirmed' },
      }),
      409,
      'SCHEMA_INCOMPATIBLE',
    )

    const appInfo = expectOk(await schemaServer.request('/cortex-api/cortex/app/info'))
    assert.equal(appInfo.schemaVersion, 4)
    const dbInfo = expectOk(await schemaServer.request('/cortex-api/cortex/db/info'))
    assert.equal(dbInfo.schemaVersion, 4)
    expectOk(await schemaServer.request('/cortex-api/cortex/setup/info'))
  })

  it('missing database: 409 for data routes, metadata degrades to zeros, file never created', async () => {
    expectCode(
      await missingServer.request('/cortex-api/cortex/vulns'),
      409,
      'SCHEMA_INCOMPATIBLE',
    )
    expectCode(await missingServer.request('/cortex-api/cortex/assets'), 409, 'SCHEMA_INCOMPATIBLE')
    expectCode(await missingServer.request('/cortex-api/cortex/rev'), 409, 'SCHEMA_INCOMPATIBLE')
    const dbInfo = expectOk(await missingServer.request('/cortex-api/cortex/db/info'))
    assert.equal(dbInfo.exists, false)
    assert.equal(dbInfo.schemaVersion, 0)
    const appInfo = expectOk(await missingServer.request('/cortex-api/cortex/app/info'))
    assert.equal(appInfo.schemaVersion, 0)
    assert.equal(existsSync(missingDbPath), false)
  })
})

/* ------------------------------------------------------------------------- */
/* Fences                                                                    */
/* ------------------------------------------------------------------------- */

describe('cortex: security fences', () => {
  let fixture
  let server

  before(async () => {
    fixture = createFixture()
    server = await startTestHost({ dbPath: fixture.dbPath })
  })

  after(async () => {
    await server.close()
    cleanupDir(fixture.dir)
  })

  it('rejects a non-loopback Host header', async () => {
    const res = await server.request('/cortex-api/cortex/rev', {
      headers: { host: 'evil.example.test' },
    })
    expectCode(res, 403, 'FORBIDDEN_HOST')
  })

  it('rejects a non-loopback peer address', async () => {
    const { json } = await invokeFake(server.host, {
      method: 'GET',
      url: '/cortex-api/cortex/rev',
      socket: { remoteAddress: '10.1.2.3' },
    })
    assert.equal(json && json.code, 'FORBIDDEN_PEER')
  })

  it('accepts writes from the DSH app origin (Sec-Fetch-Site same-origin)', async () => {
    // The DSH page runs on the custom `dsh-app://app` origin, so its writes are
    // same-origin but not loopback http(s); the fence must trust Sec-Fetch-Site
    // instead of the scheme or every UI write (delete/status/archive) fails.
    const dshHeaders = { Origin: 'dsh-app://app', 'Sec-Fetch-Site': 'same-origin' }
    const missing = expectOk(
      await readServer.request('/cortex-api/cortex/vulns/VULN-NOT-EXIST', {
        method: 'DELETE',
        headers: dshHeaders,
      }),
    )
    assert.equal(missing.deleted, false, 'unknown id reports deleted:false instead of a fence 403')

    const patchMissing = await readServer.request('/cortex-api/cortex/vulns/VULN-NOT-EXIST/status', {
      method: 'PATCH',
      headers: { ...dshHeaders, 'Content-Type': 'application/json' },
      body: { status: 'Confirmed' },
    })
    expectCode(patchMissing, 404, 'NOT_FOUND')

    const crossSite = await readServer.request('/cortex-api/cortex/vulns/VULN-NOT-EXIST', {
      method: 'DELETE',
      headers: { Origin: 'dsh-app://app', 'Sec-Fetch-Site': 'cross-site' },
    })
    expectCode(crossSite, 403, 'FORBIDDEN_ORIGIN')
  })

  it('rejects cross-site writes, foreign Origins and non-JSON bodies', async () => {
    let res = await server.request('/cortex-api/cortex/vulns/VULN-20261101-001/status', {
      method: 'PATCH',
      headers: { Origin: 'https://evil.example.test', 'Sec-Fetch-Site': 'cross-site' },
      body: { status: 'Confirmed' },
    })
    expectCode(res, 403, 'FORBIDDEN_ORIGIN')

    res = await server.request('/cortex-api/cortex/vulns/VULN-20261101-001', {
      method: 'DELETE',
      headers: { Origin: 'https://evil.example.test' },
    })
    expectCode(res, 403, 'FORBIDDEN_ORIGIN')

    res = await fetch(`${server.base}/cortex-api/cortex/vulns/delete-many`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    })
    assert.equal(res.status, 403)
    const payload = await res.json()
    assert.equal(payload.code, 'FORBIDDEN_CONTENT_TYPE')
  })

  it('accepts loopback-origin browser writes', async () => {
    const res = await server.request('/cortex-api/cortex/vulns/VULN-20261101-001/status', {
      method: 'PATCH',
      headers: {
        Origin: server.base,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: { status: 'Inconclusive' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.status, 'Inconclusive')
  })

  it('answers 405 for OPTIONS, 404 for unknown routes, 405 for wrong methods', async () => {
    let res = await server.request('/cortex-api/cortex/vulns', { method: 'OPTIONS' })
    expectCode(res, 405, 'METHOD_NOT_ALLOWED')
    res = await server.request('/cortex-api/cortex/does-not-exist')
    expectCode(res, 404, 'NOT_FOUND')
    res = await server.request('/cortex-api/cortex/rev', { method: 'POST', body: {} })
    expectCode(res, 405, 'METHOD_NOT_ALLOWED')
    res = await server.request('/cortex-api/cortex')
    expectCode(res, 404, 'NOT_FOUND')
  })

  it('never serializes credential secrets', async () => {
    const secret = 'FIXTURE-SECRET-MUST-NOT-LEAK-9c1f'
    const fixture2 = createFixture()
    prepareDb(fixture2.dbPath, (db) => {
      db.prepare(
        `INSERT INTO credentials (id, project_name, type, username, domain, secret, source, host_id, service_id,
           confidence, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'CRED-TEST-001',
        'FIXTURE-PROJECT-INTRANET',
        'password',
        'operator',
        'CORP',
        secret,
        'test',
        null,
        null,
        'high',
        'untested',
        '',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      )
    })
    const server2 = await startTestHost({ dbPath: fixture2.dbPath })
    try {
      const paths = [
        '/cortex-api/cortex/internal/overview',
        '/cortex-api/cortex/internal/projects',
        '/cortex-api/cortex/loot',
        '/cortex-api/cortex/vulns',
        '/cortex-api/cortex/assets',
        '/cortex-api/cortex/snapshots',
        '/cortex-api/cortex/db/info',
        '/cortex-api/cortex/app/info',
      ]
      for (const path of paths) {
        const res = await server2.request(path)
        assert.equal(res.text.includes(secret), false, `secret leaked through ${path}`)
      }
      const overview = expectOk(await server2.request('/cortex-api/cortex/internal/overview'))
      const credentials = overview.credentials ?? []
      for (const credential of credentials) {
        assert.equal(Object.prototype.hasOwnProperty.call(credential, 'secret'), false)
      }
    } finally {
      await server2.close()
      cleanupDir(fixture2.dir)
    }
  })
})
