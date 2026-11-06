/**
 * Cortex SQLite access for the host half (schema v5, contract §2.2).
 *
 * Design notes:
 *  - Lazy open: nothing touches the filesystem until the first request.
 *  - A failed open never throws into the process and is never cached for good:
 *    every request retries at most one open attempt.
 *  - `PRAGMA busy_timeout = 5000` and `PRAGMA foreign_keys = ON` are applied on
 *    open; `journal_mode` is deliberately never touched.
 *  - `PRAGMA user_version` must be exactly 5. Any other value (or an
 *    unavailable file) is reported through `status()` and blocks every data
 *    route; nothing is ever migrated or written.
 *  - Writes use `BEGIN IMMEDIATE` plus a bounded SQLITE_BUSY retry loop
 *    (3 retries, 50/100/200 ms).
 */

import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ApiError, schemaIncompatible } from './http.js'

/** Supported Cortex database schema version. */
export const SCHEMA_VERSION = 5

export const DEFAULT_BUSY_TIMEOUT_MS = 5000

/** SQLITE_BUSY retry delays, per contract §2.3. */
export const BUSY_RETRY_DELAYS = [50, 100, 200]

/** @param {unknown} err */
export function isBusyError(err) {
  if (!err) return false
  const errcode = Number(err.errcode)
  if (errcode === 5 || errcode === 6) return true
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(err.message || ''))
}

/** @param {unknown} err */
export function isReadOnlyError(err) {
  return Boolean(err) && Number(err.errcode) === 8
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `fn` and retry it when SQLite reports BUSY/LOCKED.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{retries?:number, delays?:number[], sleepFn?:(ms:number)=>Promise<void>}} [options]
 * @returns {Promise<T>}
 */
export async function withBusyRetry(fn, options = {}) {
  const retries = options.retries ?? 3
  const delays = options.delays ?? BUSY_RETRY_DELAYS
  const sleepFn = options.sleepFn ?? sleep
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (!isBusyError(err) || attempt >= retries) throw err
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0
      attempt += 1
      await sleepFn(delay)
    }
  }
}

/** Map a raw SQLite error onto a safe, path-free message for /health. */
function safeOpenError(err) {
  if (!err) return 'database open failed'
  const errcode = Number(err.errcode)
  if (errcode === 14) return 'database file could not be opened'
  if (errcode === 26) return 'database file is not a valid SQLite database'
  if (errcode === 11) return 'database file is corrupt'
  if (errcode === 8) return 'database file is read-only'
  return 'database open failed'
}

/**
 * Holds one lazily opened `DatabaseSync` connection and its compatibility
 * state. One instance per plugin host; safe for sequential HTTP handling.
 */
export class DatabaseHolder {
  /**
   * @param {{dbPath:string, readOnly?:boolean, busyTimeoutMs?:number}} options
   */
  constructor({ dbPath, readOnly = false, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
    this.dbPath = dbPath
    this.readOnly = Boolean(readOnly)
    this.busyTimeoutMs = busyTimeoutMs
    /** @type {DatabaseSync|null} */
    this.db = null
    /** @type {number|null} */
    this.schemaVersion = null
    this.compatible = false
    /** @type {string|null} */
    this.openError = null
    this.closed = false
    /** @type {{ino:number,size:number,mtimeMs:number}|null} */
    this.stamp = null
    this.openAttempts = 0
  }

  /** Safe status object for GET /health (never contains the absolute path). */
  status() {
    return {
      available: this.db !== null,
      schemaVersion: this.schemaVersion,
      compatible: this.compatible,
      readOnly: this.readOnly,
      busy: false,
      dbFile: basename(this.dbPath || 'data.db'),
      error: this.openError,
    }
  }

  /**
   * Ensure a connection attempt was made. Returns the status snapshot.
   * Re-checks the file stamp so a replaced database file is reopened (at most
   * one reopen per call).
   */
  ensure() {
    if (this.closed) return this.status()
    if (this.db !== null) {
      if (!this._fileReplaced()) return this.status()
      this._closeQuietly()
    }
    if (this.db === null) this._openOnce()
    return this.status()
  }

  /** @returns {boolean} */
  _fileReplaced() {
    if (this.db === null) return true
    try {
      const st = statSync(this.dbPath)
      if (!this.stamp) return true
      return st.ino !== this.stamp.ino || st.size !== this.stamp.size || st.mtimeMs !== this.stamp.mtimeMs
    } catch {
      return true
    }
  }

  _readStamp() {
    try {
      const st = statSync(this.dbPath)
      return { ino: Number(st.ino) || 0, size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return null
    }
  }

  /** Remember the file stamp after our own write so we do not reopen needlessly. */
  refreshFileStamp() {
    if (this.db !== null) this.stamp = this._readStamp()
  }

  _openOnce() {
    this.openAttempts += 1
    this.openError = null
    if (typeof this.dbPath !== 'string' || this.dbPath.length === 0) {
      this.openError = 'database path is not configured'
      this.schemaVersion = null
      this.compatible = false
      return
    }
    // Never let SQLite create an empty database file: a plugin must not invent
    // a Cortex database (and must never migrate one).
    if (!existsSync(this.dbPath)) {
      this.openError = 'database file not found'
      this.schemaVersion = null
      this.compatible = false
      return
    }
    /** @type {DatabaseSync|null} */
    let db = null
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: this.readOnly })
      db.exec(`PRAGMA busy_timeout = ${Number(this.busyTimeoutMs) || 0}`)
      db.exec('PRAGMA foreign_keys = ON')
      const row = db.prepare('PRAGMA user_version').get()
      const version = row && row.user_version !== undefined ? Number(row.user_version) : null
      this.db = db
      this.schemaVersion = Number.isFinite(version) ? version : null
      this.compatible = this.schemaVersion === SCHEMA_VERSION
      this.openError = null
      this.stamp = this._readStamp()
    } catch (err) {
      if (db) {
        try {
          db.close()
        } catch {
          /* already closed */
        }
      }
      this.db = null
      this.schemaVersion = null
      this.compatible = false
      this.openError = safeOpenError(err)
      this.stamp = null
    }
  }

  _closeQuietly() {
    const db = this.db
    this.db = null
    this.schemaVersion = null
    this.compatible = false
    this.stamp = null
    if (db) {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    }
  }

  /** Idempotent close; later `ensure()` calls will not reopen. */
  close() {
    this.closed = true
    this._closeQuietly()
    this.openError = this.openError || 'host disposed'
  }

  /**
   * Throwing guard used by data routes. Returns nothing; throws ApiError 409.
   * Call after `ensure()`.
   */
  assertUsable() {
    if (this.db === null) {
      throw schemaIncompatible('Cortex database is unavailable', {
        reason: 'UNAVAILABLE',
        error: this.openError,
      })
    }
    if (this.schemaVersion !== SCHEMA_VERSION) {
      throw schemaIncompatible('Cortex database schema is not supported', {
        schemaVersion: this.schemaVersion,
        expected: SCHEMA_VERSION,
      })
    }
  }

  /** Throwing guard for write routes (read-only mode is a 403, contract §2.3). */
  assertWritable() {
    this.assertUsable()
    if (this.readOnly) {
      throw new ApiError(403, 'READ_ONLY', 'database is opened in read-only mode')
    }
  }

  /**
   * Run `fn` inside `BEGIN IMMEDIATE` with retry on SQLITE_BUSY.
   * `fn` must be synchronous (node:sqlite is synchronous).
   * @template T
   * @param {(db: DatabaseSync) => T} fn
   * @returns {Promise<T>}
   */
  async withWriteTransaction(fn) {
    this.assertWritable()
    return withBusyRetry(() => {
      const db = this.db
      if (db === null) throw schemaIncompatible('Cortex database is unavailable', { reason: 'UNAVAILABLE' })
      db.exec('BEGIN IMMEDIATE')
      let result
      try {
        result = fn(db)
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* transaction never started / already rolled back */
        }
        throw err
      }
      try {
        db.exec('COMMIT')
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* ignore rollback failure */
        }
        throw err
      }
      this.refreshFileStamp()
      return result
    })
  }
}
