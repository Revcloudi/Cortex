/**
 * Fixture builder for the dsh-cortex test suite.
 *
 * `createFixtureDb(dbPath, opts)` synchronously creates a throwaway Cortex
 * **schema v5** SQLite database:
 *   1. executes the real schema DDL in `fixtures/schema5.sql`
 *   2. seeds obviously synthetic demo data from `fixtures/seed.json`
 *
 * The fixture contains: 9 vulnerabilities (all severities, all statuses,
 * web + internal realm, one row with deliberately corrupt JSON columns, one
 * row with empty/default fields, one row whose reproduction steps contain
 * multiple ```http request blocks plus a 3xx step), 2 assets, an internal
 * project (2 footholds / 3 hosts / 3 services / 2 credentials / 2 pivots with
 * hops + reachability) and 3 snapshot sessions (parent, child, archived).
 *
 * All hosts/domains are `example.test`, IPs are RFC 5737 documentation ranges
 * and the credential secrets are invented placeholder strings. Never use this
 * database for anything except tests.
 *
 * @example
 *   import { createFixtureDb, FIXTURE } from '../fixtures/build.mjs'
 *   const { dbPath } = createFixtureDb(join(tmpDir, 'data.db'))
 *
 * Options:
 *   seed          boolean = true   - set false to get schema-only DB
 *   schemaVersion number  = 5      - override PRAGMA user_version (schema-guard tests)
 *   recreate      boolean = true   - delete an existing file first
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url))
export const SCHEMA5_PATH = join(FIXTURES_DIR, 'schema5.sql')
export const SEED_PATH = join(FIXTURES_DIR, 'seed.json')

/** Raw seed document (parsed from fixtures/seed.json). */
export const SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8'))

/** Useful fixture identifiers / the intentionally fake credential secret. */
export const FIXTURE = Object.freeze({ ...SEED.fixture })

/**
 * Seed tables, in insert order (parents before children), with the columns that
 * hold JSON text and the columns that hold newline-joined text.
 */
export const SEED_TABLES = Object.freeze({
  vulnerabilities: {
    json: ['affected_interfaces', 'remediation', 'retest_results', 'related_vuln_ids'],
    lines: ['reproduction_steps'],
  },
  assets: {
    json: ['interfaces', 'interface_dir', 'leaked_infos', 'test_parameters', 'related_vuln_ids'],
  },
  internal_hosts: {},
  internal_services: {},
  footholds: {},
  foothold_hosts: {},
  credentials: {},
  pivots: {},
  pivot_hops: {},
  pivot_reachability: {},
  snapshot_sessions: {
    json: ['target_hosts', 'unfinished_tasks', 'failed_paths', 'tested_interfaces', 'related_vuln_ids', 'previous_state'],
  },
})

/** Tables the schema is expected to contain (used by the schema smoke test). */
export const SCHEMA5_TABLES = Object.freeze([
  'assets',
  'credential_trials',
  'credentials',
  'foothold_hosts',
  'footholds',
  'internal_hosts',
  'internal_services',
  'loot_imports',
  'pivot_hops',
  'pivot_reachability',
  'pivots',
  'snapshot_sessions',
  'vulnerabilities',
])

function normalizeValue(value, jsonFields, lineFields, column) {
  if (lineFields.includes(column) && Array.isArray(value)) return value.join('\n')
  if (jsonFields.includes(column)) {
    if (value === null) return null
    if (typeof value === 'string') return value // allows intentional '{bad json' fixtures
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return value.join('\n')
  return value
}

const insertStatementCache = new WeakMap()

function insertRows(db, table, spec, rows) {
  const jsonFields = spec.json ?? []
  const lineFields = spec.lines ?? []
  let cache = insertStatementCache.get(db)
  if (!cache) {
    cache = new Map()
    insertStatementCache.set(db, cache)
  }
  for (const sourceRow of rows) {
    const row = {}
    for (const [column, value] of Object.entries(sourceRow)) {
      row[column] = normalizeValue(value, jsonFields, lineFields, column)
    }
    const columns = Object.keys(row)
    const signature = `${table}|${columns.join(',')}`
    let statement = cache.get(signature)
    if (!statement) {
      const placeholders = columns.map(() => '?').join(', ')
      statement = db.prepare(
        `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
      )
      cache.set(signature, statement)
    }
    statement.run(...columns.map((column) => row[column]))
  }
}

/**
 * Create a fresh fixture DB at `dbPath` (synchronously).
 * @param {string} dbPath absolute or relative file path of the SQLite file
 * @param {{ seed?: boolean, schemaVersion?: number, recreate?: boolean }} [opts]
 * @returns {{ dbPath: string, schemaVersion: number, seeded: boolean,
 *             counts: Record<string, number>, fixture: Record<string, string> }}
 */
export function createFixtureDb(dbPath, opts = {}) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw new TypeError('createFixtureDb(dbPath): dbPath must be a non-empty string')
  }
  const schemaVersion = opts.schemaVersion ?? 5
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new TypeError('createFixtureDb: opts.schemaVersion must be a non-negative integer')
  }
  const seed = opts.seed !== false
  if (opts.recreate === false && existsSync(dbPath)) {
    throw new Error(`createFixtureDb: fixture DB already exists at ${dbPath}`)
  }

  mkdirSync(dirname(dbPath), { recursive: true })
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true })
  }

  const db = new DatabaseSync(dbPath)
  try {
    db.exec(readFileSync(SCHEMA5_PATH, 'utf8'))
    db.exec(`PRAGMA user_version = ${schemaVersion}`)

    const counts = {}
    for (const [table, spec] of Object.entries(SEED_TABLES)) {
      counts[table] = 0
      if (!seed) continue
      const rows = SEED[table] ?? []
      insertRows(db, table, spec, rows)
      counts[table] = rows.length
    }

    return {
      dbPath,
      schemaVersion: Number(db.prepare('PRAGMA user_version').get().user_version),
      seeded: seed,
      counts,
      fixture: { ...FIXTURE },
    }
  } finally {
    db.close()
  }
}

export default createFixtureDb
