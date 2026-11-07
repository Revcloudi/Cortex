/**
 * Web-DSH database setup: /db/info must force an open, and /db/configure must
 * switch the Host database and persist the choice.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { getConfiguredDbPath } from '../../src/host/cortex/settings.js'
import { cleanupDir, createTestDb, makeTempDir, startTestHost } from './helpers.mjs'

const fixture = createTestDb()
const alternate = createTestDb()
const missingDir = makeTempDir()
const server = await startTestHost({ dbPath: fixture.dbPath })

after(async () => {
  await server.close()
  cleanupDir(fixture.dir)
  cleanupDir(alternate.dir)
  cleanupDir(missingDir)
})

function expectOk(res) {
  assert.equal(res.status, 200, res.text)
  return res.json
}

describe('database setup (web DSH)', () => {
  it('GET /db/info opens the database before reporting its schema', async () => {
    const body = expectOk(await server.request('/cortex-api/cortex/db/info'))
    assert.equal(body.schemaVersion, 5)
    assert.equal(body.compatible, true)
    assert.equal(body.exists, true)
    assert.equal(body.openError, null)
    assert.equal(typeof body.dbPath, 'string')
    assert.equal(body.dbPath.includes('\\'), false)
    assert.equal(body.dbPath.includes('/'), false)
  })

  it('POST /db/configure switches to another Cortex database and persists it', async () => {
    const body = expectOk(
      await server.request('/cortex-api/cortex/db/configure', {
        method: 'POST',
        body: { path: alternate.dbPath },
      }),
    )
    assert.equal(body.schemaVersion, 5)
    assert.equal(body.compatible, true)
    assert.equal(body.exists, true)
    assert.equal(getConfiguredDbPath(), alternate.dbPath)

    const afterSwitch = expectOk(await server.request('/cortex-api/cortex/db/info'))
    assert.equal(afterSwitch.schemaVersion, 5)
    assert.equal(afterSwitch.compatible, true)
  })

  it('reports a missing file without breaking the Host', async () => {
    const missingPath = join(missingDir, 'no-such.db')
    const body = expectOk(
      await server.request('/cortex-api/cortex/db/configure', {
        method: 'POST',
        body: { path: missingPath },
      }),
    )
    assert.equal(body.compatible, false)
    assert.equal(body.exists, false)
    assert.equal(body.openError, 'database file not found')
    // The setting is not persisted for an unusable path.
    assert.equal(getConfiguredDbPath(), alternate.dbPath)
  })

  it('rejects relative paths and restores the startup default', async () => {
    const bad = await server.request('/cortex-api/cortex/db/configure', {
      method: 'POST',
      body: { path: 'relative/data.db' },
    })
    assert.equal(bad.status, 400)

    const restored = expectOk(
      await server.request('/cortex-api/cortex/db/configure', {
        method: 'POST',
        body: { path: '' },
      }),
    )
    assert.equal(restored.compatible, true)
    assert.equal(getConfiguredDbPath(), null)
  })
})
