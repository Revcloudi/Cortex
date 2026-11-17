import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { ensureFeatureColumns } from '../../src/host/cortex/schema.js'
import { createGraphDatabaseAdapter } from '../../src/host/cortex/graph-adapter.js'
import {
  cleanupDir,
  createTestDb,
  insertVuln,
  openRawDb,
  startTestHost,
} from './helpers.mjs'

/**
 * Client findings (Android / iOS / desktop) are separate from normal Web
 * findings: they get their own dashboard tab, are filtered out of the retest
 * workbench and the Memory Nebula graph, and use the same raw vulnerability
 * record structure.
 */

const PROJECT = 'Project Alpha'
const ASSET_ID = 'http://127.0.0.1:8080/'

const fixture = createTestDb()
{
  const db = openRawDb(fixture.dbPath)
  try {
    ensureFeatureColumns({ db, readOnly: false })
    db.prepare('UPDATE assets SET system_name = ? WHERE host_port = ?').run('星港物流客户门户', ASSET_ID)
    const rows = [
      {
        id: 'VULN-CLIENT-ANDROID',
        host: 'com.example.starport',
        vuln_name: 'Android exported component',
        vuln_type: 'Android Exported Component',
        severity: 'High',
        target_url: 'app://com.example.starport/orders',
        client_type: 'android',
        client_connection: 'usb',
        created_at: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'VULN-CLIENT-IOS',
        host: 'com.example.starport.ios',
        vuln_name: 'iOS URL scheme',
        vuln_type: 'iOS URL Scheme',
        severity: 'Medium',
        target_url: 'app://com.example.starport/orders',
        client_type: 'ios',
        client_connection: 'ssh',
        created_at: '2026-02-01T00:00:01.000Z',
      },
      {
        id: 'VULN-CLIENT-DESKTOP',
        host: 'com.example.starport.desktop',
        vuln_name: 'Desktop update signature',
        vuln_type: 'Desktop Update',
        severity: 'Critical',
        target_url: 'app://com.example.starport/update',
        client_type: 'desktop',
        client_connection: 'remote',
        created_at: '2026-02-01T00:00:02.000Z',
      },
    ]
    for (const row of rows) {
      insertVuln(db, row)
      db.prepare('UPDATE vulnerabilities SET client_type = ?, client_connection = ? WHERE id = ?').run(
        row.client_type,
        row.client_connection,
        row.id,
      )
    }
  } finally {
    db.close()
  }
}

const serverCount = (() => {
  const db = openRawDb(fixture.dbPath)
  try {
    return Number(
      db
        .prepare("SELECT COUNT(*) AS c FROM vulnerabilities WHERE realm = 'web' AND COALESCE(client_type, '') = ''")
        .get().c,
    )
  } finally {
    db.close()
  }
})()

const server = await startTestHost({ dbPath: fixture.dbPath })

after(async () => {
  await server.close()
  cleanupDir(fixture.dir)
})

function list(query) {
  return server.request(`/cortex-api/cortex/vulns${query}`)
}

describe('client findings: list and stats filters', () => {
  it('separates server and client findings and narrows by client platform', async () => {
    const serverOnly = await list('?realm=web&client=server&pageSize=100')
    assert.equal(serverOnly.status, 200, serverOnly.text)
    assert.equal(serverOnly.json.total, serverCount)
    assert.ok(serverOnly.json.items.every((item) => !item.client_type))

    const clientOnly = await list('?realm=web&client=client&pageSize=100')
    assert.equal(clientOnly.status, 200, clientOnly.text)
    assert.equal(clientOnly.json.total, 3)
    assert.deepEqual(
      clientOnly.json.items.map((item) => item.client_type).sort(),
      ['android', 'desktop', 'ios'],
    )
    assert.equal(clientOnly.json.items[0].client_connection.length > 0, true)

    const android = await list('?realm=web&client=client&client_type=android')
    assert.equal(android.json.total, 1)
    assert.equal(android.json.items[0].id, 'VULN-CLIENT-ANDROID')

    const invalid = await list('?realm=web&client=unknown')
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.code, 'BAD_REQUEST')
  })

  it('scopes stats and keeps independent client counters', async () => {
    const serverStats = await server.request('/cortex-api/cortex/stats?realm=web&client=server')
    assert.equal(serverStats.status, 200)
    assert.equal(serverStats.json.total, serverCount)
    assert.deepEqual(serverStats.json.client, {
      total: 3,
      critical: 1,
      high: 1,
      hosts: 3,
    })

    const clientStats = await server.request('/cortex-api/cortex/stats?realm=web&client=client')
    assert.equal(clientStats.status, 200)
    assert.equal(clientStats.json.total, 3)
    assert.deepEqual(clientStats.json.client, serverStats.json.client)
    assert.equal(clientStats.json.bySeverity.Critical, 1)
  })

  it('does not include client findings in the Memory Nebula graph', async () => {
    const db = openRawDb(fixture.dbPath)
    try {
      const adapter = createGraphDatabaseAdapter({ db })
      const rows = adapter.listGraphVulnerabilities(100)
      assert.ok(rows.length > 0)
      assert.equal(rows.some((row) => row.id.startsWith('VULN-CLIENT-')), false)
      assert.equal(adapter.countVulnerabilities('web'), serverCount)
    } finally {
      db.close()
    }
  })
})

describe('asset system name', () => {
  it('exposes the editable system name without using the project as the label', async () => {
    const listRes = await server.request('/cortex-api/cortex/assets')
    assert.equal(listRes.status, 200)
    const asset = listRes.json.find((item) => item.host_port === ASSET_ID)
    assert.ok(asset)
    assert.equal(asset.system_name, '星港物流客户门户')
    assert.equal(asset.project_name, PROJECT)

    const updated = await server.request(
      `/cortex-api/cortex/assets/${encodeURIComponent(ASSET_ID)}/system-name`,
      { method: 'PATCH', body: { system_name: '星港物流 · 客户门户' } },
    )
    assert.equal(updated.status, 200, updated.text)
    assert.deepEqual(updated.json, { ok: true, system_name: '星港物流 · 客户门户' })

    const detail = await server.request(`/cortex-api/cortex/assets/${encodeURIComponent(ASSET_ID)}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.json.system_name, '星港物流 · 客户门户')
  })

  it('validates the name and rejects writes on a read-only database', async () => {
    const tooLong = await server.request(
      `/cortex-api/cortex/assets/${encodeURIComponent(ASSET_ID)}/system-name`,
      { method: 'PATCH', body: { system_name: 'x'.repeat(201) } },
    )
    assert.equal(tooLong.status, 400)
    assert.equal(tooLong.json.code, 'BAD_REQUEST')

    const readonlyServer = await startTestHost({ dbPath: fixture.dbPath, readOnly: true })
    try {
      const res = await readonlyServer.request(
        `/cortex-api/cortex/assets/${encodeURIComponent(ASSET_ID)}/system-name`,
        { method: 'PATCH', body: { system_name: 'nope' } },
      )
      assert.equal(res.status, 403)
      assert.equal(res.json.code, 'READ_ONLY')
    } finally {
      await readonlyServer.close()
    }
  })
})

describe('read-only legacy database', () => {
  it('degrades client filters instead of failing when the optional columns are absent', async () => {
    const legacy = createTestDb()
    const legacyServer = await startTestHost({ dbPath: legacy.dbPath, readOnly: true })
    try {
      const res = await legacyServer.request('/cortex-api/cortex/vulns?realm=web&client=client')
      assert.equal(res.status, 200, res.text)
      assert.equal(res.json.total, 0)
      assert.equal(res.json.items.length, 0)
      const stats = await legacyServer.request('/cortex-api/cortex/stats?realm=web&client=server')
      assert.equal(stats.status, 200)
      assert.equal(stats.json.client.total, 0)
    } finally {
      await legacyServer.close()
      cleanupDir(legacy.dir)
    }
  })
})
