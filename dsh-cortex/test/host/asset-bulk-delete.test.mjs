import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { upsertMiniappIdentity } from '../../src/host/cortex/asset-identity.js'
import {
  cleanupDir,
  createTestDb,
  insertAsset,
  openRawDb,
  startTestHost,
} from './helpers.mjs'

/**
 * Bulk asset deletion: selected rows + additive sidecars only. Vulnerability
 * records are never touched. All fixture data is reserved/example-only.
 */

const PROJECT = 'Project Alpha'
const WEB_ASSET = 'http://127.0.0.1:8080/'
const BETA_ASSET = 'https://beta.example.test:8443/app'
const MINIAPP_KEY = 'miniapp:wechat:wxdemo000000000002:0a1b2c3d4e'

const fixture = createTestDb()
{
  const db = openRawDb(fixture.dbPath)
  try {
    upsertMiniappIdentity(db, {
      projectName: PROJECT,
      appid: 'wxdemo000000000002',
      appName: 'Bulk Delete Demo',
      platform: 'wechat',
      version: '7',
      packageHash: 'b'.repeat(64),
      packageDir: 'C:\\demo-packages\\bulk\\7',
      domains: [{ host: 'api.example.test', count: 2 }],
      metadata: {},
    })
    db.prepare('UPDATE asset_meta SET asset_key = ? WHERE asset_key LIKE ?').run(
      MINIAPP_KEY,
      'miniapp:wechat:wxdemo000000000002:%',
    )
    db.prepare('UPDATE asset_domains SET asset_key = ? WHERE asset_key LIKE ?').run(
      MINIAPP_KEY,
      'miniapp:wechat:wxdemo000000000002:%',
    )
    db.prepare('UPDATE miniapp_versions SET asset_key = ? WHERE asset_key LIKE ?').run(
      MINIAPP_KEY,
      'miniapp:wechat:wxdemo000000000002:%',
    )
    insertAsset(db, {
      host_port: MINIAPP_KEY,
      host: 'api.example.test',
      project_name: PROJECT,
      interfaces: '[]',
      related_vuln_ids: JSON.stringify(['VULN-20260101-004']),
      last_seen: '2026-01-03T00:00:00.000Z',
    })
    db.prepare(
      'INSERT INTO asset_vuln_links (asset_key, vuln_id, created_at) VALUES (?, ?, ?)',
    ).run(MINIAPP_KEY, 'VULN-20260101-004', '2026-01-03T00:00:00.000Z')
  } finally {
    db.close()
  }
}

const server = await startTestHost({ dbPath: fixture.dbPath })

after(async () => {
  await server.close()
  cleanupDir(fixture.dir)
})

function bulkDelete(body) {
  return server.request('/cortex-api/cortex/assets/bulk-delete', { method: 'POST', body })
}

function sidecarCounts(db) {
  return {
    meta: Number(db.prepare('SELECT COUNT(*) AS c FROM asset_meta WHERE asset_key = ?').get(MINIAPP_KEY).c),
    domains: Number(db.prepare('SELECT COUNT(*) AS c FROM asset_domains WHERE asset_key = ?').get(MINIAPP_KEY).c),
    versions: Number(db.prepare('SELECT COUNT(*) AS c FROM miniapp_versions WHERE asset_key = ?').get(MINIAPP_KEY).c),
    links: Number(db.prepare('SELECT COUNT(*) AS c FROM asset_vuln_links WHERE asset_key = ?').get(MINIAPP_KEY).c),
  }
}

describe('assets/bulk-delete', () => {
  it('deletes only selected assets and their sidecars, keeps vulnerabilities and idempotency', async () => {
    const db = openRawDb(fixture.dbPath)
    let vulnsBefore
    try {
      vulnsBefore = Number(db.prepare('SELECT COUNT(*) AS c FROM vulnerabilities').get().c)
    } finally {
      db.close()
    }

    const res = await bulkDelete({
      asset_ids: [WEB_ASSET, MINIAPP_KEY, 'missing-asset-key'],
    })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json.deleted, 2)
    assert.deepEqual(res.json.missing, ['missing-asset-key'])

    const check = openRawDb(fixture.dbPath)
    try {
      assert.equal(
        check.prepare('SELECT COUNT(*) AS c FROM assets WHERE host_port = ?').get(WEB_ASSET).c,
        0,
      )
      assert.equal(
        check.prepare('SELECT COUNT(*) AS c FROM assets WHERE host_port = ?').get(MINIAPP_KEY).c,
        0,
      )
      assert.equal(
        check.prepare('SELECT COUNT(*) AS c FROM assets WHERE host_port = ?').get(BETA_ASSET).c,
        1,
        'unselected assets must survive',
      )
      assert.deepEqual(sidecarCounts(check), { meta: 0, domains: 0, versions: 0, links: 0 })
      assert.equal(
        Number(check.prepare('SELECT COUNT(*) AS c FROM vulnerabilities').get().c),
        vulnsBefore,
        'vulnerability records must never be deleted',
      )
      assert.ok(
        check.prepare('SELECT 1 AS ok FROM vulnerabilities WHERE id = ?').get('VULN-20260101-004'),
      )
    } finally {
      check.close()
    }

    // Repeating the same ids is a no-op, not an error: everything is missing.
    const again = await bulkDelete({ asset_ids: [WEB_ASSET, MINIAPP_KEY] })
    assert.equal(again.status, 200)
    assert.equal(again.json.deleted, 0)
    assert.deepEqual(again.json.missing.sort(), [MINIAPP_KEY, WEB_ASSET].sort())
  })

  it('validates the id list and supports the ids alias', async () => {
    const invalid = [
      { asset_ids: 'not-an-array' },
      { asset_ids: [42] },
      { asset_ids: [''] },
      { asset_ids: Array.from({ length: 501 }, (_, index) => `asset-${index}`) },
    ]
    for (const body of invalid) {
      const res = await bulkDelete(body)
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80))
      assert.equal(res.json.code, 'BAD_REQUEST')
    }

    const alias = await bulkDelete({ ids: ['never-existed'] })
    assert.equal(alias.status, 200)
    assert.equal(alias.json.deleted, 0)
    assert.deepEqual(alias.json.missing, ['never-existed'])
  })

  it('rejects bulk delete on a read-only database', async () => {
    const readonlyServer = await startTestHost({ dbPath: fixture.dbPath, readOnly: true })
    try {
      const res = await readonlyServer.request('/cortex-api/cortex/assets/bulk-delete', {
        method: 'POST',
        body: { asset_ids: [BETA_ASSET] },
      })
      assert.equal(res.status, 403)
      assert.equal(res.json.code, 'READ_ONLY')
    } finally {
      await readonlyServer.close()
    }
  })
})
