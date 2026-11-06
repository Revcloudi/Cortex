import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'
import { ApiError } from '../../src/host/http.js'
import {
  BUSY_RETRY_DELAYS,
  DatabaseHolder,
  isBusyError,
  withBusyRetry,
} from '../../src/host/db.js'
import { cleanupDir, createTestDb, makeTempDir, openRawDb } from './helpers.mjs'

const fixture = createTestDb()

after(() => {
  cleanupDir(fixture.dir)
})

/** @param {unknown} err */
function busyError() {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
}

describe('db: SQLITE_BUSY retry helper', () => {
  it('retries 3 times with 50/100/200 ms delays', async () => {
    const delays = []
    let calls = 0
    const result = await withBusyRetry(
      async () => {
        calls += 1
        if (calls <= 3) throw busyError()
        return 'ok'
      },
      { sleepFn: async (ms) => delays.push(ms) },
    )
    assert.equal(result, 'ok')
    assert.equal(calls, 4)
    assert.deepEqual(delays, BUSY_RETRY_DELAYS)
    assert.deepEqual(BUSY_RETRY_DELAYS, [50, 100, 200])
    assert.equal(isBusyError(busyError()), true)
    assert.equal(isBusyError(Object.assign(new Error('database is locked'), { errcode: 6 })), true)
    assert.equal(isBusyError(new Error('nope')), false)
  })

  it('gives up after the configured retry budget', async () => {
    let calls = 0
    await assert.rejects(
      withBusyRetry(
        async () => {
          calls += 1
          throw busyError()
        },
        { sleepFn: async () => {} },
      ),
      (err) => err instanceof Error && err.errcode === 5,
    )
    assert.equal(calls, 4)
  })

  it('does not retry non-busy errors', async () => {
    let calls = 0
    await assert.rejects(
      withBusyRetry(async () => {
        calls += 1
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.equal(calls, 1)
  })
})

describe('db: holder lifecycle', () => {
  it('opens lazily, applies pragmas and keeps journal_mode untouched', async () => {
    const local = createTestDb()
    try {
      const holder = new DatabaseHolder({ dbPath: local.dbPath })
      assert.equal(holder.db, null)
      const status = holder.ensure()
      assert.equal(status.available, true)
      assert.equal(status.schemaVersion, 5)
      assert.equal(status.compatible, true)
      assert.equal(status.readOnly, false)
      assert.equal(status.busy, false)
      assert.equal(status.dbFile, 'data.db')
      assert.equal(status.error, null)
      assert.equal(JSON.stringify(status).includes(local.dir), false)

      const db = holder.db
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete')
      holder.close()
    } finally {
      cleanupDir(local.dir)
    }
  })

  it('never creates a missing database file', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'missing', 'data.db')
    try {
      const holder = new DatabaseHolder({ dbPath })
      const status = holder.ensure()
      assert.equal(status.available, false)
      assert.equal(status.schemaVersion, null)
      assert.equal(status.compatible, false)
      assert.equal(status.error, 'database file not found')
      assert.equal(existsSync(dbPath), false)
      holder.close()
    } finally {
      cleanupDir(dir)
    }
  })

  it('reports schema mismatch but keeps the connection', () => {
    const local = createTestDb({ schemaVersion: 3 })
    try {
      const holder = new DatabaseHolder({ dbPath: local.dbPath })
      const status = holder.ensure()
      assert.equal(status.available, true)
      assert.equal(status.schemaVersion, 3)
      assert.equal(status.compatible, false)
      assert.throws(() => holder.assertUsable(), (err) => err instanceof ApiError && err.status === 409)
      holder.close()
    } finally {
      cleanupDir(local.dir)
    }
  })

  it('read-only holders refuse writes', async () => {
    const local = createTestDb()
    try {
      const holder = new DatabaseHolder({ dbPath: local.dbPath, readOnly: true })
      const status = holder.ensure()
      assert.equal(status.readOnly, true)
      assert.throws(
        () => holder.assertWritable(),
        (err) => err instanceof ApiError && err.status === 403 && err.code === 'READ_ONLY',
      )
      await assert.rejects(
        holder.withWriteTransaction(() => 1),
        (err) => err instanceof ApiError && err.code === 'READ_ONLY',
      )
      holder.close()
    } finally {
      cleanupDir(local.dir)
    }
  })

  it('commits write transactions, rolls back failures, and is idempotent on close', async () => {
    const local = createTestDb()
    try {
      const holder = new DatabaseHolder({ dbPath: local.dbPath })
      holder.ensure()

      const changes = await holder.withWriteTransaction((db) =>
        db.prepare('UPDATE vulnerabilities SET status = ? WHERE id = ?').run('Retest_Passed', 'VULN-20260101-001'),
      )
      assert.equal(changes.changes, 1)
      assert.equal(
        holder.db.prepare('SELECT status FROM vulnerabilities WHERE id = ?').get('VULN-20260101-001').status,
        'Retest_Passed',
      )

      await assert.rejects(
        holder.withWriteTransaction((db) => {
          db.prepare('UPDATE vulnerabilities SET status = ? WHERE id = ?').run('Inconclusive', 'VULN-20260101-001')
          throw new Error('rollback please')
        }),
        /rollback please/,
      )
      assert.equal(
        holder.db.prepare('SELECT status FROM vulnerabilities WHERE id = ?').get('VULN-20260101-001').status,
        'Retest_Passed',
      )

      holder.close()
      holder.close()
      assert.equal(holder.db, null)
      const closedStatus = holder.ensure()
      assert.equal(closedStatus.available, false)
    } finally {
      cleanupDir(local.dir)
    }
  })

  it('retries a real SQLITE_BUSY lock until the other connection releases it', async () => {
    const local = createTestDb()
    try {
      const holder = new DatabaseHolder({ dbPath: local.dbPath, busyTimeoutMs: 50 })
      holder.ensure()

      const locker = new DatabaseSync(local.dbPath)
      locker.exec('BEGIN IMMEDIATE')
      const started = Date.now()
      const releaseTimer = setTimeout(() => {
        try {
          locker.exec('ROLLBACK')
        } catch {
          /* ignore */
        }
        try {
          locker.close()
        } catch {
          /* ignore */
        }
      }, 180)

      try {
        const result = await holder.withWriteTransaction((db) =>
          db.prepare('UPDATE vulnerabilities SET status = ? WHERE id = ?').run('Retest_Passed', 'VULN-20260101-002'),
        )
        assert.equal(result.changes, 1)
        assert.equal(Date.now() - started >= 150, true)
      } finally {
        clearTimeout(releaseTimer)
        try {
          locker.close()
        } catch {
          /* already closed */
        }
      }
      holder.close()
    } finally {
      cleanupDir(local.dir)
    }
  })
})

describe('db: raw fixture sanity', () => {
  it('fixture database is schema v5 and has the expected seed rows', () => {
    const db = openRawDb(fixture.dbPath)
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5)
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vulnerabilities').get().c, 4)
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM assets').get().c, 2)
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM credentials').get().c, 2)
    } finally {
      db.close()
    }
  })
})
