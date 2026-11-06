/**
 * Schema / seed smoke tests for the fixture builder.
 *
 * Run: node --test fixtures/build-schema.test.mjs
 *
 * These tests do not need any devDependencies: they use node:sqlite directly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createFixtureDb,
  FIXTURE,
  SCHEMA5_TABLES,
  SEED,
} from './build.mjs'

/**
 * Build a temp fixture DB, open it read-only and register a single cleanup hook
 * that closes the connection *before* removing the temp directory (Windows
 * refuses to unlink open SQLite files).
 */
function fixtureDb(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cortex-fixture-'))
  const dbPath = join(dir, 'data.db')
  const meta = createFixtureDb(dbPath, opts)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  t.after(() => {
    try {
      db.close()
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { dir, dbPath, meta, db }
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n
}

const JSON_COLUMNS = {
  vulnerabilities: ['affected_interfaces', 'remediation', 'retest_results', 'related_vuln_ids'],
  assets: ['interfaces', 'interface_dir', 'leaked_infos', 'test_parameters', 'related_vuln_ids'],
  snapshot_sessions: ['target_hosts', 'unfinished_tasks', 'failed_paths', 'tested_interfaces', 'related_vuln_ids'],
}

test('createFixtureDb builds a schema-v5 database with all Cortex tables', (t) => {
  const { db, meta } = fixtureDb(t)

  assert.equal(meta.schemaVersion, 5)
  assert.equal(meta.seeded, true)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5)

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name)
  assert.deepEqual(tables, [...SCHEMA5_TABLES].sort())

  for (const table of SCHEMA5_TABLES) {
    assert.equal(typeof count(db, table), 'number', `table ${table} is queryable`)
  }

  // Seeded row counts.
  assert.deepEqual(
    {
      vulnerabilities: count(db, 'vulnerabilities'),
      assets: count(db, 'assets'),
      internal_hosts: count(db, 'internal_hosts'),
      internal_services: count(db, 'internal_services'),
      footholds: count(db, 'footholds'),
      foothold_hosts: count(db, 'foothold_hosts'),
      credentials: count(db, 'credentials'),
      pivots: count(db, 'pivots'),
      pivot_hops: count(db, 'pivot_hops'),
      pivot_reachability: count(db, 'pivot_reachability'),
      snapshot_sessions: count(db, 'snapshot_sessions'),
    },
    {
      vulnerabilities: 9,
      assets: 2,
      internal_hosts: 3,
      internal_services: 3,
      footholds: 2,
      foothold_hosts: 3,
      credentials: 2,
      pivots: 2,
      pivot_hops: 3,
      pivot_reachability: 3,
      snapshot_sessions: 3,
    },
  )

  // Referential integrity of the seed data.
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])

  // Deterministic fixture constants used by host/client/integration tests.
  assert.equal(FIXTURE.webProject, 'FIXTURE-PROJECT-WEB')
  assert.equal(FIXTURE.internalProject, 'FIXTURE-PROJECT-INTRANET')
  assert.equal(FIXTURE.credentialSecret, 'Fixture-Redis-Pass!2026-NotReal')
  assert.ok(/^https:\/\/demo\.example\.test:\d+$/.test(FIXTURE.webAssetHostPort))
})

test('seed covers severities, statuses, realms, corrupt JSON and empty defaults', (t) => {
  const { db } = fixtureDb(t)

  const vulns = db.prepare('SELECT * FROM vulnerabilities ORDER BY id').all()
  assert.ok(vulns.length >= 8, 'at least 8 seeded vulnerabilities')
  assert.deepEqual(
    [...new Set(vulns.map((v) => v.severity))].sort(),
    ['Critical', 'High', 'Info', 'Low', 'Medium'],
  )
  assert.deepEqual(
    [...new Set(vulns.map((v) => v.status))].sort(),
    ['Confirmed', 'Inconclusive', 'Retest_Passed'],
  )
  assert.deepEqual([...new Set(vulns.map((v) => v.realm))].sort(), ['internal', 'web'])
  assert.equal(vulns.filter((v) => v.realm === 'internal').length, 2)

  // One row deliberately carries corrupt JSON text; raw read must keep it.
  const corrupt = vulns.find((v) => v.id === FIXTURE.vulnCorruptJson)
  assert.ok(corrupt, 'corrupt-JSON fixture row exists')
  assert.equal(corrupt.affected_interfaces, '{bad json')
  assert.equal(corrupt.related_vuln_ids, '{bad json')

  // All other JSON columns parse cleanly.
  for (const vuln of vulns) {
    if (vuln.id === FIXTURE.vulnCorruptJson) continue
    for (const column of JSON_COLUMNS.vulnerabilities) {
      assert.doesNotThrow(
        () => JSON.parse(vuln[column]),
        `vulnerabilities.${column} parses for ${vuln.id}`,
      )
    }
  }

  // One row uses empty strings / defaults.
  const empty = vulns.find((v) => v.id === FIXTURE.vulnEmptyDefaults)
  assert.ok(empty, 'empty/defaults fixture row exists')
  assert.equal(empty.description, '')
  assert.equal(empty.impact, '')
  assert.equal(empty.reproduction_steps, '')
  assert.equal(empty.affected_interfaces, '[]')
  assert.equal(empty.remediation, '[]')
  assert.equal(empty.entry_point, '')

  // Multi-request Markdown reproduction with a 3xx step.
  const multi = vulns.find((v) => v.id === FIXTURE.vulnMultiHttp)
  assert.ok(multi, 'multi-http fixture row exists')
  const httpBlocks = multi.reproduction_steps.match(/```http\b/g) ?? []
  assert.ok(httpBlocks.length >= 2, `expected multiple \`\`\`http blocks, got ${httpBlocks.length}`)
  for (const marker of ['POST /api/v1/login HTTP/1.1', 'Host: demo.example.test:8443', '302 Found']) {
    assert.ok(multi.reproduction_steps.includes(marker), `reproduction steps contain ${marker}`)
  }

  // At least one existing retest record (append-only tests rely on it).
  const withRetest = vulns.find((v) => v.id === FIXTURE.vulnWithRetest)
  assert.ok(withRetest)
  const retests = JSON.parse(withRetest.retest_results)
  assert.equal(retests.length, 1)
  assert.ok(retests[0].time_range && retests[0].conclusion.includes('复测结论'))
})

test('assets include one full structured asset and one minimal asset', (t) => {
  const { db } = fixtureDb(t)

  const assets = db.prepare('SELECT * FROM assets ORDER BY host_port').all()
  assert.equal(assets.length, 2)

  const full = assets.find((a) => a.host_port === FIXTURE.webAssetHostPort)
  assert.ok(full, 'full asset exists')
  assert.equal(full.project_name, FIXTURE.webProject)
  assert.equal(full.auth_required, 1)

  const interfaces = JSON.parse(full.interfaces)
  assert.ok(interfaces.length >= 3)
  for (const iface of interfaces) {
    assert.equal(typeof iface.path, 'string')
    if (iface.request) {
      assert.ok(iface.request.includes(' HTTP/1.1\n'), 'raw request text keeps request line')
      assert.ok(iface.request.includes('Host: '))
    }
  }
  const leaked = JSON.parse(full.leaked_infos)
  assert.ok(leaked.length >= 2)
  for (const info of leaked) {
    for (const key of ['info_type', 'value', 'source', 'potential_impact']) {
      assert.ok(info[key], `leaked_infos.${key} is populated`)
    }
  }
  const params = JSON.parse(full.test_parameters)
  assert.ok(params.length >= 2)
  for (const param of params) {
    for (const key of ['name', 'endpoint', 'location', 'source']) assert.ok(param[key], `test_parameters.${key}`)
    assert.ok(Array.isArray(param.values))
  }
  assert.ok(JSON.parse(full.related_vuln_ids).length >= 1)
  assert.ok(JSON.parse(full.interface_dir).length >= 1)

  const minimal = assets.find((a) => a.host_port === FIXTURE.minimalAssetHostPort)
  assert.ok(minimal, 'minimal asset exists')
  assert.equal(minimal.interfaces, '[]')
  assert.equal(minimal.leaked_infos, '[]')
  assert.equal(minimal.related_vuln_ids, '[]')

  // Assets and snapshots share one project name; the fixture host is also used
  // by seeded vulnerabilities (project association lives on the asset).
  assert.deepEqual([...new Set(assets.map((a) => a.project_name))], [FIXTURE.webProject])
  const snapshotProjects = db
    .prepare('SELECT DISTINCT project_name FROM snapshot_sessions')
    .all()
    .map((row) => row.project_name)
  assert.deepEqual(snapshotProjects, [FIXTURE.webProject])
  const sameHostVulns = db
    .prepare('SELECT COUNT(*) AS n FROM vulnerabilities WHERE host = ? OR host LIKE ?')
    .get(`${full.host}:8443`, `${full.host}:%`)
  assert.ok(sameHostVulns.n >= 1, 'a seeded vulnerability lives on the full asset host')
})

test('internal project has footholds, hosts, services, credentials and pivots', (t) => {
  const { db } = fixtureDb(t)

  const project = FIXTURE.internalProject
  const hosts = db.prepare('SELECT * FROM internal_hosts WHERE project_name = ?').all(project)
  const services = db.prepare('SELECT * FROM internal_services WHERE project_name = ?').all(project)
  const footholds = db.prepare('SELECT * FROM footholds WHERE project_name = ?').all(project)
  const credentials = db.prepare('SELECT * FROM credentials WHERE project_name = ?').all(project)
  const pivots = db.prepare('SELECT * FROM pivots WHERE project_name = ?').all(project)

  assert.equal(hosts.length, 3)
  assert.equal(services.length, 3)
  assert.equal(footholds.length, 2)
  assert.equal(credentials.length, 2)
  assert.equal(pivots.length, 2)

  for (const host of hosts) assert.ok(host.id.startsWith('IH-'))
  for (const service of services) {
    assert.ok(service.id.startsWith('IS-'))
    assert.ok(hosts.some((h) => h.id === service.host_id), `service ${service.id} references a seeded host`)
  }
  for (const foothold of footholds) assert.ok(foothold.id.startsWith('FH-'))

  // Foothold -> host links.
  const linkedHosts = db
    .prepare('SELECT foothold_id, internal_host_id FROM foothold_hosts WHERE foothold_id IN (?, ?)')
    .all(FIXTURE.footholdRce, FIXTURE.footholdCredential)
  assert.equal(linkedHosts.length, 3)

  // Credentials: secret populated but synthetic; only masked values may reach clients.
  const passwordCred = credentials.find((c) => c.id === FIXTURE.credentialPassword)
  assert.ok(passwordCred)
  assert.equal(passwordCred.secret, FIXTURE.credentialSecret)
  assert.ok(credentials.every((c) => c.secret.length > 0))
  assert.ok(credentials.every((c) => c.notes.includes('合成') || c.source.includes('合成')))

  // Pivots: hops + reachability.
  const hops = db.prepare('SELECT * FROM pivot_hops WHERE pivot_id = ? ORDER BY seq').all(FIXTURE.pivotChain)
  assert.deepEqual(hops.map((h) => h.seq), [0, 1])
  assert.ok(hops.every((h) => hosts.some((host) => host.id === h.ref_id) || services.some((s) => s.id === h.ref_id)))
  const reach = db
    .prepare('SELECT cidr FROM pivot_reachability WHERE pivot_id = ? ORDER BY cidr')
    .all(FIXTURE.pivotChain)
  assert.deepEqual(reach.map((row) => row.cidr), ['192.0.2.0/24', '198.51.100.0/24'])
  const proxyPivot = pivots.find((p) => p.id === FIXTURE.pivotProxy)
  assert.equal(proxyPivot.kind, 'proxy')

  // The internal realm vulnerabilities reference seeded internal services.
  const internalVulns = db.prepare('SELECT * FROM vulnerabilities WHERE realm = ? ORDER BY id').all('internal')
  assert.equal(internalVulns.length, 2)
  for (const vuln of internalVulns) {
    assert.ok(vuln.internal_service_id, `${vuln.id} has internal_service_id`)
    assert.ok(services.some((s) => s.id === vuln.internal_service_id), `${vuln.id} references a seeded service`)
    assert.ok(vuln.service_host.includes(':'), `${vuln.id} has service_host`)
  }
})

test('snapshot sessions include parent, child and archived rows with nine fields populated', (t) => {
  const { db } = fixtureDb(t)

  const sessions = db.prepare('SELECT * FROM snapshot_sessions ORDER BY session_id').all()
  assert.equal(sessions.length, 3)

  const parent = sessions.find((s) => s.session_id === FIXTURE.parentSession)
  const child = sessions.find((s) => s.session_id === FIXTURE.childSession)
  const archived = sessions.find((s) => s.session_id === FIXTURE.archivedSession)

  assert.ok(parent && child && archived)
  assert.equal(parent.parent_session_id, null)
  assert.equal(parent.archived_at, null)
  assert.equal(child.parent_session_id, parent.session_id)
  assert.equal(child.archived_at, null)
  assert.ok(archived.archived_at, 'archived session has archived_at')
  assert.equal(archived.parent_session_id, null)

  // Parent/child relationship is resolvable through the DTO contract.
  const childCount = sessions.filter((s) => s.parent_session_id === parent.session_id).length
  assert.equal(childCount, 1)

  const nineFields = [
    'project_name',
    'target_hosts',
    'current_phase',
    'unfinished_tasks',
    'failed_paths',
    'tested_interfaces',
    'notes',
    'related_vuln_ids',
    'next_steps',
  ]
  for (const session of [parent, child, archived]) {
    for (const field of nineFields) {
      const value = session[field]
      assert.ok(value !== null && value !== '' && value !== '[]', `${session.session_id}.${field} is populated`)
    }
    for (const column of JSON_COLUMNS.snapshot_sessions) {
      assert.doesNotThrow(() => JSON.parse(session[column]), `snapshot_sessions.${column} parses`)
    }
    assert.ok(JSON.parse(session.tested_interfaces).length >= 1)
    assert.ok(JSON.parse(session.related_vuln_ids).length >= 1)
  }

  // Child keeps previous_state as JSON, parent/archived are NULL.
  assert.equal(parent.previous_state, null)
  assert.equal(archived.previous_state, null)
  assert.equal(JSON.parse(child.previous_state).session, parent.session_id)

  assert.equal(parent.project_name, FIXTURE.webProject)
  const webAsset = db.prepare('SELECT host FROM assets WHERE host_port = ?').get(FIXTURE.webAssetHostPort)
  const webVulnCount = db
    .prepare('SELECT COUNT(*) AS n FROM vulnerabilities WHERE host LIKE ?')
    .get(`${webAsset.host}:%`).n
  assert.ok(webVulnCount >= 1, 'web asset host is shared with seeded vulnerabilities')
})

test('options: schemaVersion override, schema-only mode, recreate guard', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cortex-fixture-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  // Schema mismatch fixture for the Host schema guard.
  const mismatchPath = join(dir, 'schema4.db')
  const mismatch = createFixtureDb(mismatchPath, { schemaVersion: 4, seed: false })
  assert.equal(mismatch.schemaVersion, 4)
  {
    const db = new DatabaseSync(mismatchPath, { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
    for (const table of SCHEMA5_TABLES) {
      assert.equal(count(db, table), 0, `${table} is empty in schema-only mode`)
    }
    db.close()
  }

  // createFixtureDb refuses to overwrite when recreate is disabled.
  assert.throws(() => createFixtureDb(mismatchPath, { recreate: false }), /already exists/)

  // Invalid arguments are rejected loudly.
  assert.throws(() => createFixtureDb(''), TypeError)
  assert.throws(() => createFixtureDb(join(dir, 'x.db'), { schemaVersion: 1.5 }), TypeError)

  // A proper v5 fixture is re-created at the same path.
  const fresh = createFixtureDb(mismatchPath)
  assert.equal(fresh.schemaVersion, 5)
  assert.equal(fresh.counts.vulnerabilities, SEED.vulnerabilities.length)
})
