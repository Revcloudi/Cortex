import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createCortexHost, resolveHostConfig } from '../../src/host/app.js'
import {
  cleanupDir,
  createTestDb,
  invokeFake,
  makeTempDir,
  openRawDb,
  startTestHost,
} from './helpers.mjs'

const fixture = createTestDb()
const server = await startTestHost({ dbPath: fixture.dbPath })

const schemaFixture = createTestDb({ schemaVersion: 4, seed: true })
const schemaServer = await startTestHost({ dbPath: schemaFixture.dbPath })

const readOnlyFixture = createTestDb()
const readOnlyServer = await startTestHost({ dbPath: readOnlyFixture.dbPath, readOnly: true })

const missingDir = makeTempDir()
const missingDbPath = join(missingDir, 'data.db')
const missingServer = await startTestHost({ dbPath: missingDbPath })

after(async () => {
  await Promise.all([server.close(), schemaServer.close(), readOnlyServer.close(), missingServer.close()])
  for (const dir of [fixture.dir, schemaFixture.dir, readOnlyFixture.dir, missingDir]) cleanupDir(dir)
})

function readVulnRow(dbPath, id) {
  const db = openRawDb(dbPath)
  try {
    return db.prepare('SELECT * FROM vulnerabilities WHERE id = ?').get(id)
  } finally {
    db.close()
  }
}

describe('vulns: list', () => {
  it('returns the paginated list with filters and defaults', async () => {
    const res = await server.request('/cortex-api/vulns')
    assert.equal(res.status, 200)
    const body = res.json
    assert.equal(body.total, 4)
    assert.equal(body.page, 1)
    assert.equal(body.pageSize, 20)
    assert.equal(body.pages, 1)
    assert.equal(body.items.length, 4)
    assert.deepEqual(body.filters.severities, ['Critical', 'High', 'Medium', 'Low', 'Info'])
    assert.deepEqual(body.filters.statuses, ['Confirmed', 'Inconclusive', 'Retest_Passed'])
    assert.deepEqual(body.filters.realms, ['web', 'internal'])
    assert.equal(body.items[0].id, 'VULN-20260101-004')
    assert.deepEqual(Object.keys(body.items[0]).sort(), [
      'createdAt',
      'entryPoint',
      'host',
      'id',
      'latestRetestAt',
      'realm',
      'retestCount',
      'serviceHost',
      'severity',
      'status',
      'targetUrl',
      'vulnName',
      'vulnType',
    ])
  })

  it('filters by realm, severity, status and search', async () => {
    let res = await server.request('/cortex-api/vulns?realm=web')
    assert.equal(res.json.total, 3)
    res = await server.request('/cortex-api/vulns?realm=internal')
    assert.equal(res.json.total, 1)
    assert.equal(res.json.items[0].realm, 'internal')
    assert.equal(res.json.items[0].serviceHost, '10.0.0.5:6379')

    res = await server.request('/cortex-api/vulns?severity=Critical')
    assert.equal(res.json.total, 1)
    res = await server.request('/cortex-api/vulns?status=Retest_Passed')
    assert.equal(res.json.total, 1)
    assert.equal(res.json.items[0].id, 'VULN-20260101-002')

    res = await server.request('/cortex-api/vulns?search=Redis')
    assert.equal(res.json.total, 1)
    res = await server.request('/cortex-api/vulns?search=invoices')
    assert.equal(res.json.total, 1)
    // LIKE wildcards must be escaped, not interpreted.
    res = await server.request('/cortex-api/vulns?search=%25')
    assert.equal(res.json.total, 0)
  })

  it('paginates and caps pageSize', async () => {
    const res = await server.request('/cortex-api/vulns?pageSize=2&page=2')
    assert.equal(res.status, 200)
    assert.equal(res.json.page, 2)
    assert.equal(res.json.pageSize, 2)
    assert.equal(res.json.pages, 2)
    assert.equal(res.json.items.length, 2)

    const tooBig = await server.request('/cortex-api/vulns?pageSize=101')
    assert.equal(tooBig.status, 400)
    assert.equal(tooBig.json.code, 'BAD_REQUEST')
  })

  it('rejects invalid filter values', async () => {
    for (const path of ['realm=allx', 'severity=Highx', 'status=done', 'page=-1', 'pageSize=1.5']) {
      const res = await server.request(`/cortex-api/vulns?${path}`)
      assert.equal(res.status, 400, path)
      assert.equal(res.json.code, 'BAD_REQUEST', path)
    }
  })
})

describe('vulns: detail', () => {
  it('returns the full detail DTO and related summaries', async () => {
    const res = await server.request('/cortex-api/vulns/VULN-20260101-001')
    assert.equal(res.status, 200)
    const { vuln, related } = res.json
    assert.deepEqual(Object.keys(vuln).sort(), [
      'affectedInterfaces',
      'createdAt',
      'cryptoDetails',
      'description',
      'entryPoint',
      'host',
      'id',
      'impact',
      'internalServiceId',
      'latestRetestAt',
      'realm',
      'relatedVulnIds',
      'remediation',
      'reproductionSteps',
      'retestCount',
      'retestResults',
      'serviceHost',
      'severity',
      'status',
      'targetUrl',
      'testBoundaries',
      'vulnName',
      'vulnType',
    ])
    assert.deepEqual(vuln.affectedInterfaces, ['/orders?q=', '/login'])
    assert.deepEqual(vuln.remediation, ['使用参数化查询', '部署 WAF'])
    assert.equal(vuln.retestCount, 1)
    assert.equal(vuln.retestResults[0].timeRange, '2026-01-02 10:00-10:04 (Asia/Shanghai)')
    assert.equal(vuln.latestRetestAt, '2026-01-02 10:00-10:04 (Asia/Shanghai)')
    assert.deepEqual(vuln.relatedVulnIds, ['VULN-20260101-002', 'VULN-20260101-004'])
    assert.deepEqual(related.map((item) => item.id), ['VULN-20260101-002', 'VULN-20260101-004'])
    assert.equal(JSON.stringify(related).includes('"description"'), false)
  })

  it('degrades corrupt JSON columns to empty arrays', async () => {
    const res = await server.request('/cortex-api/vulns/VULN-20260101-002')
    assert.equal(res.status, 200)
    const { vuln } = res.json
    assert.deepEqual(vuln.affectedInterfaces, [])
    assert.deepEqual(vuln.remediation, [])
    assert.deepEqual(vuln.retestResults, [])
    assert.deepEqual(vuln.relatedVulnIds, [])
    assert.equal(vuln.retestCount, 0)
    assert.equal(vuln.latestRetestAt, null)
  })

  it('returns 404 for unknown vulnerability ids', async () => {
    const res = await server.request('/cortex-api/vulns/VULN-00000000-999')
    assert.equal(res.status, 404)
    assert.equal(res.json.code, 'NOT_FOUND')
  })
})

describe('vulns: status write', () => {
  it('updates only the status column and persists it', async () => {
    const before = readVulnRow(fixture.dbPath, 'VULN-20260101-002')
    const res = await server.request('/cortex-api/vulns/VULN-20260101-002/status', {
      method: 'PATCH',
      body: { status: 'Confirmed' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.vuln.status, 'Confirmed')

    const after = readVulnRow(fixture.dbPath, 'VULN-20260101-002')
    assert.equal(after.status, 'Confirmed')
    assert.equal(after.vuln_name, before.vuln_name)
    assert.equal(after.description, before.description)
    assert.equal(after.created_at, before.created_at)
    assert.equal(after.retest_results, before.retest_results)
  })

  it('rejects invalid status values and unknown ids', async () => {
    const invalid = await server.request('/cortex-api/vulns/VULN-20260101-001/status', {
      method: 'PATCH',
      body: { status: 'Open' },
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.code, 'BAD_REQUEST')

    const missing = await server.request('/cortex-api/vulns/VULN-20260101-001/status', {
      method: 'PATCH',
      body: {},
    })
    assert.equal(missing.status, 400)

    const unknown = await server.request('/cortex-api/vulns/VULN-00000000-999/status', {
      method: 'PATCH',
      body: { status: 'Confirmed' },
    })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.code, 'NOT_FOUND')
  })
})

describe('vulns: append-only retest history', () => {
  it('appends a retest entry, preserves history and leaves other columns intact', async () => {
    const before = readVulnRow(fixture.dbPath, 'VULN-20260101-003')
    assert.equal(before.retest_results, '[]')

    const first = await server.request('/cortex-api/vulns/VULN-20260101-003/retest', {
      method: 'POST',
      body: { timeRange: '2026-02-01 09:00-09:05', conclusion: '### 复测\n\n仍可未授权访问。' },
    })
    assert.equal(first.status, 200)
    assert.equal(first.json.ok, true)
    assert.equal(first.json.vuln.retestResults.length, 1)
    assert.equal(first.json.vuln.retestCount, 1)
    assert.equal(first.json.vuln.latestRetestAt, '2026-02-01 09:00-09:05')

    let raw = readVulnRow(fixture.dbPath, 'VULN-20260101-003')
    assert.equal(raw.status, before.status)
    assert.equal(raw.vuln_name, before.vuln_name)
    assert.equal(raw.description, before.description)
    assert.equal(raw.created_at, before.created_at)
    const stored = JSON.parse(raw.retest_results)
    assert.equal(stored.length, 1)
    assert.deepEqual(stored[0], {
      time_range: '2026-02-01 09:00-09:05',
      conclusion: '### 复测\n\n仍可未授权访问。',
    })
    assert.equal(Object.prototype.hasOwnProperty.call(stored[0], 'timeRange'), false)

    const second = await server.request('/cortex-api/vulns/VULN-20260101-003/retest', {
      method: 'POST',
      body: { timeRange: '2026-02-02 10:00-10:02', conclusion: '已修复确认。' },
    })
    assert.equal(second.status, 200)
    assert.equal(second.json.vuln.retestResults.length, 2)
    assert.deepEqual(second.json.vuln.retestResults[0], {
      timeRange: '2026-02-01 09:00-09:05',
      conclusion: '### 复测\n\n仍可未授权访问。',
    })
    raw = readVulnRow(fixture.dbPath, 'VULN-20260101-003')
    assert.equal(JSON.parse(raw.retest_results).length, 2)
  })

  it('preserves pre-existing retest entries on append', async () => {
    const before = readVulnRow(fixture.dbPath, 'VULN-20260101-001')
    const original = JSON.parse(before.retest_results)
    const res = await server.request('/cortex-api/vulns/VULN-20260101-001/retest', {
      method: 'POST',
      body: { timeRange: '2026-03-01 11:00-11:10', conclusion: '第三次复测。' },
    })
    assert.equal(res.status, 200)
    const raw = readVulnRow(fixture.dbPath, 'VULN-20260101-001')
    const stored = JSON.parse(raw.retest_results)
    assert.equal(stored.length, original.length + 1)
    assert.deepEqual(stored.slice(0, original.length), original)
  })

  it('validates retest payloads', async () => {
    const path = '/cortex-api/vulns/VULN-20260101-003/retest'
    const cases = [
      { conclusion: 'x' },
      { timeRange: 'x' },
      { timeRange: 'x'.repeat(201), conclusion: 'y' },
      { timeRange: 'x', conclusion: 'y'.repeat(50001) },
      { timeRange: '', conclusion: 'y' },
    ]
    for (const body of cases) {
      const res = await server.request(path, { method: 'POST', body })
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60))
      assert.equal(res.json.code, 'BAD_REQUEST')
    }
  })

  it('returns 404 for unknown ids on retest append', async () => {
    const res = await server.request('/cortex-api/vulns/VULN-00000000-999/retest', {
      method: 'POST',
      body: { timeRange: 'x', conclusion: 'y' },
    })
    assert.equal(res.status, 404)
  })

  it('rejects retest history beyond the 100-entry Cortex limit', async () => {
    const db = openRawDb(fixture.dbPath)
    try {
      const entries = Array.from({ length: 100 }, (_, index) => ({
        time_range: `t${index}`,
        conclusion: 'c',
      }))
      db.prepare('UPDATE vulnerabilities SET retest_results = ? WHERE id = ?').run(
        JSON.stringify(entries),
        'VULN-20260101-004',
      )
    } finally {
      db.close()
    }
    const res = await server.request('/cortex-api/vulns/VULN-20260101-004/retest', {
      method: 'POST',
      body: { timeRange: 't', conclusion: 'c' },
    })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'BAD_REQUEST')
  })
})

describe('vulns: schema and read-only guards', () => {
  it('schema != 5: /health 200 incompatible, data routes 409, no writes', async () => {
    const initial = readVulnRow(schemaFixture.dbPath, 'VULN-20260101-001')
    const health = await schemaServer.request('/cortex-api/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, false)
    assert.equal(health.json.db.available, true)
    assert.equal(health.json.db.schemaVersion, 4)
    assert.equal(health.json.db.compatible, false)

    const list = await schemaServer.request('/cortex-api/vulns')
    assert.equal(list.status, 409)
    assert.equal(list.json.code, 'SCHEMA_INCOMPATIBLE')
    assert.equal(list.json.details.expected, 5)

    const status = await schemaServer.request('/cortex-api/vulns/VULN-20260101-001/status', {
      method: 'PATCH',
      body: { status: 'Retest_Passed' },
    })
    assert.equal(status.status, 409)
    assert.equal(status.json.code, 'SCHEMA_INCOMPATIBLE')

    const retest = await schemaServer.request('/cortex-api/vulns/VULN-20260101-001/retest', {
      method: 'POST',
      body: { timeRange: 'x', conclusion: 'y' },
    })
    assert.equal(retest.status, 409)

    const raw = readVulnRow(schemaFixture.dbPath, 'VULN-20260101-001')
    assert.equal(raw.status, initial.status)
    assert.equal(raw.retest_results, initial.retest_results)
  })

  it('read-only mode: writes 403 READ_ONLY with zero DB mutation', async () => {
    const health = await readOnlyServer.request('/cortex-api/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.db.readOnly, true)

    const list = await readOnlyServer.request('/cortex-api/vulns')
    assert.equal(list.status, 200)

    const before = readVulnRow(readOnlyFixture.dbPath, 'VULN-20260101-001')
    const patch = await readOnlyServer.request('/cortex-api/vulns/VULN-20260101-001/status', {
      method: 'PATCH',
      body: { status: 'Retest_Passed' },
    })
    assert.equal(patch.status, 403)
    assert.equal(patch.json.code, 'READ_ONLY')

    const retest = await readOnlyServer.request('/cortex-api/vulns/VULN-20260101-001/retest', {
      method: 'POST',
      body: { timeRange: 'x', conclusion: 'y' },
    })
    assert.equal(retest.status, 403)
    assert.equal(retest.json.code, 'READ_ONLY')

    const after = readVulnRow(readOnlyFixture.dbPath, 'VULN-20260101-001')
    assert.deepEqual(after, before)
  })

  it('unavailable DB: /health 200 unavailable, data routes 409, file is never created', async () => {
    const health = await missingServer.request('/cortex-api/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, false)
    assert.equal(health.json.db.available, false)
    assert.equal(health.json.db.schemaVersion, null)
    assert.equal(health.json.db.compatible, false)
    assert.equal(typeof health.json.db.error, 'string')
    assert.equal(health.json.db.dbFile, 'data.db')
    assert.equal(existsSync(missingDbPath), false)

    const list = await missingServer.request('/cortex-api/vulns')
    assert.equal(list.status, 409)
    assert.equal(list.json.code, 'SCHEMA_INCOMPATIBLE')

    const write = await missingServer.request('/cortex-api/vulns/VULN-1/status', {
      method: 'PATCH',
      body: { status: 'Confirmed' },
    })
    assert.equal(write.status, 409)
    assert.equal(existsSync(missingDbPath), false)
  })
})

describe('vulns: environment configuration', () => {
  it('honours CORTEX_DB_PATH', async () => {
    const envFixture = createTestDb()
    process.env.CORTEX_DB_PATH = envFixture.dbPath
    try {
      const host = createCortexHost({ config: {} })
      const { json } = await invokeFake(host, {
        headers: { host: '127.0.0.1' },
        url: '/cortex-api/health',
      })
      assert.equal(json.db.available, true)
      assert.equal(json.db.schemaVersion, 5)
      assert.equal(json.db.dbFile, 'data.db')
      await host.dispose()
    } finally {
      delete process.env.CORTEX_DB_PATH
      cleanupDir(envFixture.dir)
    }
  })

  it('honours CORTEX_DB_READONLY=1', () => {
    process.env.CORTEX_DB_READONLY = '1'
    try {
      const resolved = resolveHostConfig({})
      assert.equal(resolved.readOnly, true)
      assert.equal(resolveHostConfig({ readOnly: false }).readOnly, true)
    } finally {
      delete process.env.CORTEX_DB_READONLY
    }
    assert.equal(resolveHostConfig({ readOnly: false }).readOnly, false)
  })
})
