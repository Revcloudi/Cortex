/**
 * Plugin-local SQLite store for the mini-program (wxapkg) feature.
 *
 * The Cortex desktop app owns `~/.cortex/data.db`; this module deliberately
 * keeps its own database (`~/.cortex/plugin.db`) so the schema v5 contract is
 * never touched or migrated. `CORTEX_PLUGIN_DB` overrides the path for tests.
 *
 * Tables (created on `ensure`, all `IF NOT EXISTS`):
 *   miniapp_sources   one row per package directory (root_path + package_dir)
 *   miniapp_jobs      unpack/analyze job queue metadata
 *   miniapp_analyses  cached Overview JSON per source
 *   miniapp_settings  key/value settings (custom roots, last scan, ...)
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Statuses a miniapp source may carry (contract §2). */
export const MINIAPP_STATUSES = ['detected', 'decrypting', 'unpacked', 'unsupported', 'failed']

/** Formats `detectFormat` / unpack may record. */
export const MINIAPP_FORMATS = ['plain', 'v1mmwx', 'unknown']

/** Statuses and unpacked output preserved across an idempotent re-scan. */
const PRESERVED_STATUSES = new Set(['unpacked', 'unsupported', 'failed'])

/** Setting key holding the user's custom scan roots (JSON array). */
const CUSTOM_ROOTS_KEY = 'customRoots'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS miniapp_sources (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  root_kind TEXT NOT NULL,
  appid TEXT NOT NULL,
  app_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  package_dir TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  package_hash TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'detected',
  unpacked_path TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (root_path, package_dir)
);
CREATE TABLE IF NOT EXISTS miniapp_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS miniapp_analyses (
  source_id TEXT PRIMARY KEY,
  overview_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS miniapp_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_miniapp_sources_appid ON miniapp_sources(appid, version);
CREATE INDEX IF NOT EXISTS idx_miniapp_jobs_source ON miniapp_jobs(source_id, created_at);
`

/** @param {NodeJS.ProcessEnv} env */
function homeDir(env) {
  if (env && typeof env.HOME === 'string' && env.HOME.trim()) return env.HOME.trim()
  if (env && typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim()) return env.USERPROFILE.trim()
  return homedir()
}

/**
 * Default `plugin.db` path: `~/.cortex/plugin.db`, overridable via
 * `CORTEX_PLUGIN_DB`. Always absolute (except the `:memory:` test sentinel).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function defaultPluginDbPath(env = process.env) {
  const override =
    env && typeof env.CORTEX_PLUGIN_DB === 'string' ? env.CORTEX_PLUGIN_DB.trim() : ''
  if (override) return override === ':memory:' ? override : resolve(override)
  return resolve(join(homeDir(env), '.cortex', 'plugin.db'))
}

/**
 * Stable source id: `sha1(resolve(rootPath) + '\0' + resolve(packageDir))`.
 * @param {string} rootPath
 * @param {string} packageDir
 */
export function sourceIdFor(rootPath, packageDir) {
  const root = resolve(String(rootPath ?? ''))
  const pkg = resolve(String(packageDir ?? ''))
  return createHash('sha1').update(root, 'utf8').update('\0', 'utf8').update(pkg, 'utf8').digest('hex')
}

const nowIso = () => new Date().toISOString()

/** @param {unknown} value */
function toText(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** @param {unknown} value @param {number} fallback */
function toInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/** @param {unknown} value @param {string} fallback */
function normalizeStatus(value, fallback) {
  return MINIAPP_STATUSES.includes(value) ? String(value) : fallback
}

/** @param {unknown} value */
function normalizeFormat(value) {
  return MINIAPP_FORMATS.includes(value) ? String(value) : 'unknown'
}

/** @param {unknown} value @param {string} field */
function requirePath(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`MiniappStore: ${field} is required`)
  }
  return resolve(value)
}

/** @param {string} value */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

/**
 * Canonical file entries sorted by name: `{name, path, size}`.
 * Accepts the contract shape, bare path strings, or a parsed files array.
 * @param {unknown} files
 */
function normalizeFiles(files) {
  const input = Array.isArray(files) ? files : []
  /** @type {{name:string,path:string,size:number}[]} */
  const out = []
  for (const item of input) {
    let filePath = ''
    let name = ''
    let size = 0
    if (typeof item === 'string') {
      filePath = resolve(item)
      name = basename(filePath)
    } else if (item && typeof item === 'object') {
      filePath = typeof item.path === 'string' && item.path ? resolve(item.path) : ''
      name = typeof item.name === 'string' && item.name ? item.name : filePath ? basename(filePath) : ''
      size = toInt(item.size, 0)
    }
    if (!filePath && !name) continue
    out.push({ name, path: filePath, size })
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  return out
}

/** @param {string} filesJson */
function parseFilesJson(filesJson) {
  try {
    const parsed = JSON.parse(filesJson)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** @param {any} row */
function rowToSource(row) {
  if (!row) return null
  const source = { ...row }
  source.files = parseFilesJson(source.files_json)
  return source
}

/** @param {any[]} a @param {any[]} b */
function sameFiles(a, b) {
  const left = Array.isArray(a) ? a : []
  const right = Array.isArray(b) ? b : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const one = left[index] || {}
    const two = right[index] || {}
    if (one.name !== two.name || one.path !== two.path || Number(one.size) !== Number(two.size)) {
      return false
    }
  }
  return true
}

/** Columns compared when deciding whether an upsert changed anything. */
const CHANGE_COLUMNS = [
  'root_path',
  'root_kind',
  'appid',
  'app_name',
  'version',
  'package_dir',
  'files_json',
  'size_bytes',
  'file_count',
  'package_hash',
  'format',
  'status',
  'unpacked_path',
  'error',
]

/** @param {any} before @param {any} after */
function contentChanged(before, after) {
  for (const column of CHANGE_COLUMNS) {
    if (before[column] !== after[column]) return true
  }
  return false
}

/** Newest-first version compare used by `listSources` / `findSources`. */
function compareVersionDesc(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    const diff = Number(right) - Number(left)
    if (diff !== 0) return diff
  }
  return right.localeCompare(left, undefined, { numeric: true })
}

/** Deterministic source ordering: appid asc, version desc (numeric), dir asc. */
function compareSources(a, b) {
  const byAppid = String(a.appid ?? '').localeCompare(String(b.appid ?? ''))
  if (byAppid !== 0) return byAppid
  const byVersion = compareVersionDesc(a.version, b.version)
  if (byVersion !== 0) return byVersion
  return String(a.package_dir ?? '').localeCompare(String(b.package_dir ?? ''))
}

const SOURCE_INSERT = `INSERT INTO miniapp_sources
  (id, root_path, root_kind, appid, app_name, version, package_dir, files_json,
   size_bytes, file_count, package_hash, format, status, unpacked_path, error,
   detected_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const SOURCE_UPDATE = `UPDATE miniapp_sources SET
  root_path = ?, root_kind = ?, appid = ?, app_name = ?, version = ?, package_dir = ?,
  files_json = ?, size_bytes = ?, file_count = ?, package_hash = ?, format = ?,
  status = ?, unpacked_path = ?, error = ?, updated_at = ?
  WHERE id = ?`

/**
 * Single-connection wrapper around `plugin.db`. Methods auto-`ensure()` so the
 * host can construct the store lazily; call `close()` on dispose.
 */
export class MiniappStore {
  /**
   * @param {{dbPath?:string, env?:NodeJS.ProcessEnv}} [options]
   */
  constructor({ dbPath = defaultPluginDbPath(), env = process.env } = {}) {
    /** @type {string} */
    this.dbPath = String(dbPath)
    /** @type {NodeJS.ProcessEnv} */
    this.env = env || process.env
    /** @type {DatabaseSync|null} */
    this.db = null
  }

  /** Create the directory/file and tables. Idempotent. */
  ensure() {
    if (this.db) return
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true })
    const db = new DatabaseSync(this.dbPath)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(SCHEMA_SQL)
    } catch (err) {
      try {
        db.close()
      } catch {
        /* ignore close failure on a half-open db */
      }
      throw err
    }
    this.db = db
  }

  /** @returns {DatabaseSync} */
  _db() {
    this.ensure()
    if (!this.db) throw new Error('MiniappStore: database is not open')
    return this.db
  }

  /** Close the connection; later calls reopen through `ensure()`. */
  close() {
    const db = this.db
    this.db = null
    if (db) {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * @param {{search?:string, status?:string, appid?:string}} [filters]
   * @returns {any[]}
   */
  listSources({ search = '', status = '', appid = '' } = {}) {
    const db = this._db()
    const where = []
    const params = []
    const term = String(search ?? '').trim()
    if (term) {
      const like = `%${escapeLike(term)}%`
      where.push(
        "(appid LIKE ? ESCAPE '\\' OR app_name LIKE ? ESCAPE '\\' OR version LIKE ? ESCAPE '\\' " +
          "OR package_dir LIKE ? ESCAPE '\\' OR root_path LIKE ? ESCAPE '\\')",
      )
      params.push(like, like, like, like, like)
    }
    if (status) {
      where.push('status = ?')
      params.push(String(status))
    }
    if (appid) {
      where.push('appid = ?')
      params.push(String(appid))
    }
    let sql = 'SELECT * FROM miniapp_sources'
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`
    const rows = db.prepare(sql).all(...params).map(rowToSource)
    rows.sort(compareSources)
    return rows
  }

  /** @param {string} id @returns {any|null} */
  getSource(id) {
    const row = this._db().prepare('SELECT * FROM miniapp_sources WHERE id = ?').get(String(id))
    return row ? rowToSource(row) : null
  }

  /**
   * @param {{appid:string, version?:string}} query
   * @returns {any[]} newest version first
   */
  findSources({ appid, version = '' } = {}) {
    const db = this._db()
    const rows = version
      ? db
          .prepare('SELECT * FROM miniapp_sources WHERE appid = ? AND version = ?')
          .all(String(appid), String(version))
      : db.prepare('SELECT * FROM miniapp_sources WHERE appid = ?').all(String(appid))
    const sources = rows.map(rowToSource)
    sources.sort((a, b) => compareVersionDesc(a.version, b.version))
    return sources
  }

  /** @param {string} appid @returns {any|null} */
  latestForApp(appid) {
    const rows = this.findSources({ appid })
    return rows.length > 0 ? rows[0] : null
  }

  /**
   * Insert or reconcile one detected package directory.
   *
   * - identical file list/sizes -> no write, `changed:false`; an existing
   *   `unpacked`/`unsupported`/`failed` status and `unpacked_path` are kept;
   * - changed file list/sizes -> reset to `detected` and drop stale output.
   *
   * @param {Record<string, any>} input
   * @returns {{row:any, created:boolean, changed:boolean}}
   */
  upsertSource(input = {}) {
    const db = this._db()
    const rootPath = requirePath(input.root_path, 'root_path')
    const packageDir = requirePath(input.package_dir, 'package_dir')
    const incomingFiles =
      input.files !== undefined ? input.files : parseFilesJson(toText(input.files_json))
    const files = normalizeFiles(incomingFiles)
    const filesJson = JSON.stringify(files)
    const computedBytes = files.reduce((sum, file) => sum + file.size, 0)
    const sizeBytes = input.size_bytes !== undefined ? toInt(input.size_bytes, computedBytes) : computedBytes
    const fileCount = input.file_count !== undefined ? toInt(input.file_count, files.length) : files.length
    const id =
      typeof input.id === 'string' && input.id
        ? input.id
        : sourceIdFor(rootPath, packageDir)
    const now = nowIso()

    const existingRow = db.prepare('SELECT * FROM miniapp_sources WHERE id = ?').get(id)
    const existing = existingRow ? rowToSource(existingRow) : null
    const format = input.format !== undefined ? normalizeFormat(input.format) : existing ? existing.format : 'unknown'

    if (!existing) {
      const row = {
        id,
        root_path: rootPath,
        root_kind: toText(input.root_kind) || 'custom',
        appid: toText(input.appid),
        app_name: toText(input.app_name),
        version: toText(input.version),
        package_dir: packageDir,
        files_json: filesJson,
        size_bytes: sizeBytes,
        file_count: fileCount,
        package_hash: toText(input.package_hash),
        format,
        status: normalizeStatus(input.status, 'detected'),
        unpacked_path: toText(input.unpacked_path),
        error: toText(input.error),
        detected_at: toText(input.detected_at) || now,
        updated_at: now,
      }
      db.prepare(SOURCE_INSERT).run(
        row.id,
        row.root_path,
        row.root_kind,
        row.appid,
        row.app_name,
        row.version,
        row.package_dir,
        row.files_json,
        row.size_bytes,
        row.file_count,
        row.package_hash,
        row.format,
        row.status,
        row.unpacked_path,
        row.error,
        row.detected_at,
        row.updated_at,
      )
      return { row: rowToSource(row), created: true, changed: true }
    }

    const filesChanged =
      !sameFiles(existing.files, files) ||
      sizeBytes !== Number(existing.size_bytes) ||
      fileCount !== Number(existing.file_count)

    const next = {
      ...existing,
      root_path: rootPath,
      root_kind: input.root_kind !== undefined ? toText(input.root_kind) : existing.root_kind,
      appid: input.appid !== undefined ? toText(input.appid) : existing.appid,
      app_name: input.app_name !== undefined ? toText(input.app_name) : existing.app_name,
      version: input.version !== undefined ? toText(input.version) : existing.version,
      package_dir: packageDir,
      files_json: filesJson,
      files,
      size_bytes: sizeBytes,
      file_count: fileCount,
      format,
      updated_at: now,
    }

    if (filesChanged) {
      // The package payload changed: previous unpack/analysis output is stale.
      next.status = 'detected'
      next.unpacked_path = ''
      next.package_hash = ''
      next.error = ''
    } else if (PRESERVED_STATUSES.has(existing.status)) {
      next.status = existing.status
      next.unpacked_path = existing.unpacked_path
      next.package_hash = existing.package_hash
      next.error = existing.error
    } else {
      next.status =
        input.status !== undefined ? normalizeStatus(input.status, existing.status) : existing.status
      next.unpacked_path =
        input.unpacked_path !== undefined ? toText(input.unpacked_path) : existing.unpacked_path
      next.package_hash =
        input.package_hash !== undefined ? toText(input.package_hash) : existing.package_hash
      next.error = input.error !== undefined ? toText(input.error) : existing.error
    }

    const changed = contentChanged(existing, next)
    if (!changed) return { row: existing, created: false, changed: false }

    db.prepare(SOURCE_UPDATE).run(
      next.root_path,
      next.root_kind,
      next.appid,
      next.app_name,
      next.version,
      next.package_dir,
      next.files_json,
      next.size_bytes,
      next.file_count,
      next.package_hash,
      next.format,
      next.status,
      next.unpacked_path,
      next.error,
      now,
      next.id,
    )
    return { row: rowToSource({ ...next, updated_at: now }), created: false, changed: true }
  }

  /**
   * Patch a source after unpack/analyze. Unknown keys and invalid statuses are
   * ignored; `updated_at` is always refreshed when something is applied.
   * @param {string} id
   * @param {Record<string, any>} patch
   * @returns {any|null}
   */
  updateSource(id, patch = {}) {
    const db = this._db()
    const existingRow = db.prepare('SELECT * FROM miniapp_sources WHERE id = ?').get(String(id))
    if (!existingRow) return null
    const existing = rowToSource(existingRow)
    const sets = []
    const params = []
    const textFields = ['root_kind', 'appid', 'app_name', 'version', 'package_hash', 'unpacked_path', 'error']
    for (const field of textFields) {
      if (patch[field] !== undefined) {
        sets.push(`${field} = ?`)
        params.push(toText(patch[field]))
      }
    }
    if (patch.status !== undefined) {
      const status = normalizeStatus(patch.status, '')
      if (status) {
        sets.push('status = ?')
        params.push(status)
      }
    }
    if (patch.format !== undefined) {
      sets.push('format = ?')
      params.push(normalizeFormat(patch.format))
    }
    if (patch.files !== undefined) {
      const files = normalizeFiles(patch.files)
      sets.push('files_json = ?')
      params.push(JSON.stringify(files))
      sets.push('file_count = ?')
      params.push(files.length)
      sets.push('size_bytes = ?')
      params.push(files.reduce((sum, file) => sum + file.size, 0))
    } else if (patch.files_json !== undefined) {
      sets.push('files_json = ?')
      params.push(toText(patch.files_json))
    }
    if (patch.size_bytes !== undefined) {
      sets.push('size_bytes = ?')
      params.push(toInt(patch.size_bytes, existing.size_bytes))
    }
    if (patch.file_count !== undefined) {
      sets.push('file_count = ?')
      params.push(toInt(patch.file_count, existing.file_count))
    }
    if (sets.length === 0) return existing
    sets.push('updated_at = ?')
    params.push(nowIso())
    params.push(String(id))
    db.prepare(`UPDATE miniapp_sources SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.getSource(id)
  }

  /** @param {string} sourceId @returns {object|null} */
  getAnalysis(sourceId) {
    const row = this._db()
      .prepare('SELECT overview_json FROM miniapp_analyses WHERE source_id = ?')
      .get(String(sourceId))
    if (!row) return null
    try {
      const parsed = JSON.parse(row.overview_json)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /** @param {string} sourceId @param {object} overview */
  saveAnalysis(sourceId, overview) {
    const db = this._db()
    const json = JSON.stringify(overview ?? {})
    db.prepare(
      `INSERT INTO miniapp_analyses (source_id, overview_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET overview_json = excluded.overview_json,
         updated_at = excluded.updated_at`,
    ).run(String(sourceId), json, nowIso())
  }

  /** @param {string} key @param {string|null} [fallback] @returns {string|null} */
  getSetting(key, fallback = null) {
    const row = this._db().prepare('SELECT value FROM miniapp_settings WHERE key = ?').get(String(key))
    return row ? String(row.value) : fallback
  }

  /** @param {string} key @param {unknown} value @returns {string} */
  setSetting(key, value) {
    const text = value === undefined || value === null ? '' : String(value)
    this._db()
      .prepare(
        `INSERT INTO miniapp_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(String(key), text, nowIso())
    return text
  }

  /** @returns {string[]} */
  customRoots() {
    const raw = this.getSetting(CUSTOM_ROOTS_KEY, '[]')
    try {
      const parsed = JSON.parse(raw ?? '[]')
      if (!Array.isArray(parsed)) return []
      return parsed.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
    } catch {
      return []
    }
  }

  /** @param {string[]} roots @returns {string[]} normalized, de-duplicated */
  setCustomRoots(roots) {
    const list = []
    const seen = new Set()
    for (const entry of Array.isArray(roots) ? roots : []) {
      if (typeof entry !== 'string' || entry.trim() === '') continue
      const absolute = resolve(entry.trim())
      const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
      if (seen.has(key)) continue
      seen.add(key)
      list.push(absolute)
    }
    this.setSetting(CUSTOM_ROOTS_KEY, JSON.stringify(list))
    return list
  }

  /**
   * @param {{source_id:string, kind:string, status?:string, message?:string}} input
   * @returns {any}
   */
  createJob({ source_id, kind, status = 'queued', message = '' } = {}) {
    const db = this._db()
    const now = nowIso()
    const job = {
      id: randomUUID(),
      source_id: toText(source_id),
      kind: toText(kind),
      status: toText(status) || 'queued',
      progress: 0,
      message: toText(message),
      created_at: now,
      updated_at: now,
    }
    db.prepare(
      `INSERT INTO miniapp_jobs
        (id, source_id, kind, status, progress, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(job.id, job.source_id, job.kind, job.status, job.progress, job.message, job.created_at, job.updated_at)
    return job
  }

  /**
   * @param {string} id
   * @param {{status?:string, progress?:number, message?:string}} patch
   * @returns {any|null}
   */
  updateJob(id, patch = {}) {
    const db = this._db()
    const existing = db.prepare('SELECT * FROM miniapp_jobs WHERE id = ?').get(String(id))
    if (!existing) return null
    const sets = []
    const params = []
    if (patch.status !== undefined) {
      sets.push('status = ?')
      params.push(toText(patch.status) || existing.status)
    }
    if (patch.progress !== undefined) {
      const progress = Math.max(0, Math.min(100, toInt(patch.progress, existing.progress)))
      sets.push('progress = ?')
      params.push(progress)
    }
    if (patch.message !== undefined) {
      sets.push('message = ?')
      params.push(toText(patch.message))
    }
    if (sets.length === 0) return { ...existing }
    sets.push('updated_at = ?')
    params.push(nowIso())
    params.push(String(id))
    db.prepare(`UPDATE miniapp_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.getJob(id)
  }

  /** @param {string} id @returns {any|null} */
  getJob(id) {
    const row = this._db().prepare('SELECT * FROM miniapp_jobs WHERE id = ?').get(String(id))
    return row ? { ...row } : null
  }

  /**
   * @param {{sourceId?:string, limit?:number}} [options]
   * @returns {any[]}
   */
  listJobs({ sourceId, limit = 20 } = {}) {
    const db = this._db()
    const bounded = Math.max(1, Math.min(200, toInt(limit, 20)))
    const rows = sourceId
      ? db
          .prepare('SELECT * FROM miniapp_jobs WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(String(sourceId), bounded)
      : db.prepare('SELECT * FROM miniapp_jobs ORDER BY created_at DESC, id DESC LIMIT ?').all(bounded)
    return rows.map((row) => ({ ...row }))
  }
}

/** @type {Map<string, MiniappStore>} */
const stores = new Map()

/**
 * Process-wide singleton keyed by database path.
 * @param {{dbPath?:string, env?:NodeJS.ProcessEnv}} [options]
 * @returns {MiniappStore}
 */
export function getMiniappStore(options = {}) {
  const env = options.env ?? process.env
  const dbPath = options.dbPath ?? defaultPluginDbPath(env)
  let store = stores.get(dbPath)
  if (!store) {
    store = new MiniappStore({ dbPath, env })
    store.ensure()
    stores.set(dbPath, store)
  }
  return store
}

/** Close and forget every singleton (tests only). */
export function resetMiniappStoreForTests() {
  for (const store of stores.values()) store.close()
  stores.clear()
}
