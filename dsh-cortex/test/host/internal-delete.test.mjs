import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  cleanupDir,
  createTestDb,
  openRawDb,
  startTestHost,
} from './helpers.mjs'

/**
 * Internal-operations entity deletion. The route whitelists the five entity
 * kinds, relies on the schema's FK cascades for dependent rows, and never
 * accepts an arbitrary table name.
 */

const PROJECT = 'Project Alpha'
const fixture = createTestDb()
const server = await startTestHost({ dbPath: fixture.dbPath })

after(async () => {
  await server.close()
  cleanupDir(fixture.dir)
})

async function graph() {
  const res = await server.request(
    `/cortex-api/cortex/internal/graph?project_name=${encodeURIComponent(PROJECT)}`,
  )
  assert.equal(res.status, 200, res.text)
  return res.json
}

function count(db, table, id) {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE id = ?`).get(id).c)
}

describe('internal operations: delete entities', () => {
  it('deletes only the requested row and is reflected in the next projection', async () => {
    const before = await graph()
    const service = before.services[0]
    assert.ok(service)
    const deleted = await server.request(
      `/cortex-api/cortex/internal/services/${encodeURIComponent(service.id)}`,
      { method: 'DELETE' },
    )
    assert.equal(deleted.status, 200, deleted.text)
    assert.equal(deleted.json.deleted, true)
    const db = openRawDb(fixture.dbPath)
    try {
      assert.equal(count(db, 'internal_services', service.id), 0)
    } finally {
      db.close()
    }
    const after = await graph()
    assert.equal(after.services.some((item) => item.id === service.id), false)
  })

  it('covers hosts, footholds, credentials and pivots', async () => {
    // Delete dependents before parents: pivots cascade from footholds, and
    // services cascade from hosts.
    for (const [kind, table] of [
      ['pivots', 'pivots'],
      ['credentials', 'credentials'],
      ['footholds', 'footholds'],
      ['hosts', 'internal_hosts'],
    ]) {
      const current = await graph()
      const entity = current[kind][0]
      assert.ok(entity, `${kind} fixture missing`)
      const res = await server.request(
        `/cortex-api/cortex/internal/${kind}/${encodeURIComponent(entity.id)}`,
        { method: 'DELETE' },
      )
      assert.equal(res.status, 200, `${kind}: ${res.text}`)
      const db = openRawDb(fixture.dbPath)
      try {
        assert.equal(count(db, table, entity.id), 0, `${kind} row removed`)
      } finally {
        db.close()
      }
    }
  })

  it('404s unknown ids and rejects non-DELETE methods', async () => {
    const missing = await server.request(
      '/cortex-api/cortex/internal/hosts/does-not-exist',
      { method: 'DELETE' },
    )
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'NOT_FOUND')

    const wrongMethod = await server.request(
      '/cortex-api/cortex/internal/hosts/does-not-exist',
      { method: 'GET' },
    )
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.json.code, 'METHOD_NOT_ALLOWED')

    const unknownKind = await server.request(
      '/cortex-api/cortex/internal/tables/hosts',
      { method: 'DELETE' },
    )
    assert.equal(unknownKind.status, 404)
  })

  it('rejects deletes on a read-only database', async () => {
    const readonlyFixture = createTestDb()
    const readonlyServer = await startTestHost({ dbPath: readonlyFixture.dbPath, readOnly: true })
    try {
      const res = await readonlyServer.request(
        `/cortex-api/cortex/internal/hosts/${encodeURIComponent('IH-NOPE')}`,
        { method: 'DELETE' },
      )
      assert.equal(res.status, 403)
      assert.equal(res.json.code, 'READ_ONLY')
    } finally {
      await readonlyServer.close()
      cleanupDir(readonlyFixture.dir)
    }
  })
})
