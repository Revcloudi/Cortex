import Database from 'better-sqlite3'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ASSET_STATUSES,
  DATABASE_SCHEMA_VERSION,
  DEFAULT_VULN_PAGE_SIZE,
  SEVERITIES,
  SNAPSHOT_MAX_PAYLOAD_CHARS,
  SnapshotPayloadSchema,
  TestParameterCandidateSchema,
  VULN_STATUSES,
  deriveAssetHost,
  interfaceDirFromInterfaces,
  normalizeAssetIdentifier,
  normalizeAssetInterfaces,
  type AssetContext,
  type AssetFilters,
  type AssetInterface,
  type AssetListItem,
  type AssetStatus,
  type AssetSyncMode,
  type DashboardStats,
  type DatabaseInfo,
  type LeakedInfo,
  type PaginatedVulnerabilities,
  type RetestResult,
  type Severity,
  type SnapshotListFilters,
  type SnapshotListResult,
  type SnapshotPayload,
  type SnapshotSavePayload,
  type SnapshotSession,
  type SnapshotSummary,
  type SnapshotTestedInterface,
  type TestParameterCandidate,
  type VulnListQuery,
  type Vulnerability,
  type VulnerabilityListItem,
  type VulnStatus,
  type VulnSummary
} from '../../shared/types'

type SeverityMap = Record<Severity, number>
type StatusMap = Record<VulnStatus, number>

/**
 * Concurrency / durability defaults shared by every hub entry point.
 *
 * - WAL lets the Electron GUI read while an agent's stdio MCP process writes.
 * - busy_timeout makes SQLite wait for a lock instead of failing immediately.
 * - synchronous=NORMAL is the safe WAL pairing (no fsync per commit).
 * - foreign_keys=ON keeps the schema strict for future relations.
 */
const SQLITE_BUSY_TIMEOUT_MS = 5_000
const WRITE_TRANSACTION_MAX_RETRIES = 3
const WRITE_TRANSACTION_BASE_DELAY_MS = 50

/** Blocking sleep used between synchronous SQLITE_BUSY retries. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: string }).code
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED'
}

function statIfExists(filePath: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(filePath)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Read the on-disk schema version without migrating. Used by read-only CLI
 * commands and `ctx doctor`; returns null when the file does not exist yet.
 */
export function readSchemaVersion(dbPath: string): number | null {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return null
  const database = new Database(dbPath, { readonly: true })
  try {
    return database.pragma('user_version', { simple: true }) as number
  } finally {
    database.close()
  }
}

interface VulnerabilityRow {
  id: string
  host: string
  entry_point: string
  vuln_name: string
  vuln_type: string
  severity: string
  target_url: string
  description: string
  impact: string
  affected_interfaces: string
  reproduction_steps: string
  remediation: string
  crypto_details: string
  test_boundaries: string
  retest_results: string
  related_vuln_ids: string
  status: string
  created_at: string
}

interface SummaryRow {
  id: string
  vuln_name: string
  severity: string
  target_url: string
}

interface AssetRow {
  host_port: string
  host: string
  project_name: string
  tech_stack: string | null
  auth_required: number
  status: string
  interfaces: string | null
  interface_dir: string
  leaked_infos: string
  test_parameters: string | null
  related_vuln_ids: string
  last_seen: string
}

interface SnapshotSessionRow {
  session_id: string
  project_name: string
  target_hosts: string
  current_phase: string
  unfinished_tasks: string
  failed_paths: string
  tested_interfaces: string
  notes: string
  related_vuln_ids: string
  next_steps: string
  previous_state: string | null
  /** Root (project) sessions are NULL; child sessions point at their project. */
  parent_session_id: string | null
  /** NULL while active; ISO timestamp once archived (cascades to children). */
  archived_at: string | null
  /** Number of direct child sessions (computed by the SELECT below). */
  child_count: number
  created_at: string
  updated_at: string
}

/** The nine cognitive-state fields stored on one snapshot session. */
const SNAPSHOT_PAYLOAD_FIELDS = [
  'project_name',
  'target_hosts',
  'current_phase',
  'unfinished_tasks',
  'failed_paths',
  'tested_interfaces',
  'notes',
  'related_vuln_ids',
  'next_steps'
] as const

/**
 * Session row projection shared by every snapshot read path. `child_count` is
 * computed in SQL so summaries/sessions can show the hierarchy without an N+1
 * query; archived children are still counted (the UI needs to reveal them).
 */
const SNAPSHOT_SELECT_COLUMNS = `
  s.session_id, s.project_name, s.target_hosts, s.current_phase,
  s.unfinished_tasks, s.failed_paths, s.tested_interfaces, s.notes,
  s.related_vuln_ids, s.next_steps, s.previous_state,
  s.parent_session_id, s.archived_at, s.created_at, s.updated_at,
  (
    SELECT COUNT(*) FROM snapshot_sessions child
    WHERE child.parent_session_id = s.session_id
  ) AS child_count
`

const MAX_SNAPSHOT_TARGET_HOSTS = 50
const SNAPSHOT_SUMMARY_EXCERPT_LENGTH = 160
const SNAPSHOT_LIST_DEFAULT_LIMIT = 50
const SNAPSHOT_ARCHIVED_WRITE_ERROR = '，请先在桌面端取消归档后再操作'

export class DatabaseError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'STALE' | 'INTERNAL'

  constructor(code: DatabaseError['code'], message: string) {
    super(message)
    this.name = 'DatabaseError'
    this.code = code
  }
}

const LIST_COLUMNS = `
  id, host, entry_point, vuln_name, vuln_type, severity,
  target_url, status, created_at
`

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/**
 * Parse the persisted `interfaces` column. Returns `null` when the raw value is
 * missing or not a JSON array, so the migration can tell "already canonical"
 * apart from "needs a rewrite".
 */
function parseStoredAssetInterfaces(raw: string | null | undefined): AssetInterface[] | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as AssetInterface[]) : null
  } catch {
    return null
  }
}

function toSeverity(value: string): Severity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as Severity) : 'Info'
}

function toStatus(value: string): VulnStatus {
  return (VULN_STATUSES as readonly string[]).includes(value) ? (value as VulnStatus) : 'Confirmed'
}

function toAssetStatus(value: string): AssetStatus {
  return (ASSET_STATUSES as readonly string[]).includes(value) ? (value as AssetStatus) : 'Alive'
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function leakedInfoKey(info: LeakedInfo): string {
  return `${info.info_type}\u0000${info.source}\u0000${info.value}`
}

function uniqueLeakedInfos(values: readonly LeakedInfo[]): LeakedInfo[] {
  const seen = new Set<string>()
  const result: LeakedInfo[] = []
  for (const info of values) {
    const key = leakedInfoKey(info)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(info)
  }
  return result
}

function parseLeakedInfos(raw: string): LeakedInfo[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LeakedInfo[]) : []
  } catch {
    return []
  }
}

const MAX_TEST_PARAMETER_VALUES = 50
const MAX_TEST_PARAMETER_RELATED_VULNS = 100

function testParameterKey(parameter: TestParameterCandidate): string {
  return `${parameter.endpoint}\u0000${parameter.name}\u0000${parameter.location}`
}

/** Validate/normalize one stored or submitted candidate (drops malformed rows). */
function normalizeTestParameterCandidate(raw: unknown): TestParameterCandidate | null {
  const parsed = TestParameterCandidateSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Merge two records that describe the same parameter (same endpoint + name +
 * location):
 * - values / related_vuln_ids are order-preserving unions (capped);
 * - pattern / source / notes take the later non-empty value;
 * - tested is OR-ed (a seed stays tested once it has been used).
 *
 * The same rule implements both the replace-mode duplicate collapse and the
 * merge-mode upsert, so stored data and incremental discovery agree.
 */
function mergeTestParameterCandidate(
  existing: TestParameterCandidate,
  incoming: TestParameterCandidate
): TestParameterCandidate {
  const pattern =
    incoming.pattern !== undefined && incoming.pattern.length > 0
      ? incoming.pattern
      : existing.pattern
  const source = incoming.source.length > 0 ? incoming.source : existing.source
  const notes =
    incoming.notes !== undefined && incoming.notes.length > 0 ? incoming.notes : existing.notes
  return {
    name: incoming.name,
    endpoint: incoming.endpoint,
    location: incoming.location,
    values: uniqueStrings([...existing.values, ...incoming.values]).slice(
      0,
      MAX_TEST_PARAMETER_VALUES
    ),
    ...(pattern !== undefined ? { pattern } : {}),
    source,
    tested: existing.tested || incoming.tested,
    ...(notes !== undefined ? { notes } : {}),
    related_vuln_ids: uniqueStrings([
      ...existing.related_vuln_ids,
      ...incoming.related_vuln_ids
    ]).slice(0, MAX_TEST_PARAMETER_RELATED_VULNS)
  }
}

/**
 * Replace-mode canonicalization: dedupe by endpoint + name + location (first
 * position wins) and fold duplicates with the merge rule above.
 */
function canonicalizeTestParameters(rawValues: readonly unknown[]): TestParameterCandidate[] {
  const byKey = new Map<string, TestParameterCandidate>()
  const order: string[] = []
  for (const raw of rawValues) {
    const candidate = normalizeTestParameterCandidate(raw)
    if (candidate === null) continue
    const key = testParameterKey(candidate)
    const existing = byKey.get(key)
    if (existing === undefined) {
      order.push(key)
      byKey.set(key, candidate)
    } else {
      byKey.set(key, mergeTestParameterCandidate(existing, candidate))
    }
  }
  return order.map((key) => byKey.get(key) as TestParameterCandidate)
}

/**
 * Merge-mode upsert: existing entries keep their position, incoming entries
 * either update them in place or append when the key is new.
 */
function mergeTestParameterLists(
  existingRaw: readonly unknown[],
  incomingRaw: readonly unknown[]
): TestParameterCandidate[] {
  const existing = canonicalizeTestParameters(existingRaw)
  const byKey = new Map<string, TestParameterCandidate>(
    existing.map((parameter) => [testParameterKey(parameter), parameter])
  )
  const order = existing.map(testParameterKey)
  for (const raw of incomingRaw) {
    const candidate = normalizeTestParameterCandidate(raw)
    if (candidate === null) continue
    const key = testParameterKey(candidate)
    const current = byKey.get(key)
    if (current === undefined) {
      order.push(key)
      byKey.set(key, candidate)
    } else {
      byKey.set(key, mergeTestParameterCandidate(current, candidate))
    }
  }
  return order.map((key) => byKey.get(key) as TestParameterCandidate)
}

interface LegacyRetestMigration {
  time_range: string
  conclusion: string
  remaining_boundaries: string
}

/**
 * Older retests were written as a timestamped paragraph inside
 * `test_boundaries`. Move that block into the append-only retest history once,
 * preserving any genuine boundaries that came before the timestamp.
 */
function extractLegacyRetest(testBoundaries: string): LegacyRetestMigration | null {
  const text = testBoundaries.trim()
  if (!text.includes('复测')) return null
  const match = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2})\s*（([^）]+)）/.exec(
    text
  )
  if (!match) return null

  const [stamp, date, start, end, timezone] = match
  const suffix = text.slice(match.index + stamp.length).trim()
  if (suffix.length === 0 || !suffix.includes('复测')) return null

  const rawConclusion = suffix.replace(/^[:：\s]+/, '').trim()
  if (rawConclusion.length === 0) return null

  return {
    time_range: `${date} ${start}–${end}（${timezone}）`,
    conclusion: rawConclusion.startsWith('#')
      ? rawConclusion
      : `### 复测结论\n\n${rawConclusion}`,
    remaining_boundaries: text.slice(0, match.index).trim()
  }
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `${year}${month}${day}`
}

/** Extract the nine cognitive-state fields from a stored session row. */
function snapshotPayloadFromRow(row: SnapshotSessionRow): SnapshotPayload {
  return {
    project_name: row.project_name,
    target_hosts: parseJsonArray<string>(row.target_hosts),
    current_phase: row.current_phase,
    unfinished_tasks: parseJsonArray<string>(row.unfinished_tasks),
    failed_paths: parseJsonArray<string>(row.failed_paths),
    tested_interfaces: parseJsonArray<SnapshotTestedInterface>(row.tested_interfaces),
    notes: row.notes ?? '',
    related_vuln_ids: parseJsonArray<string>(row.related_vuln_ids),
    next_steps: row.next_steps
  }
}

/**
 * `previous_state` is an internal rollback buffer: it is parsed here and never
 * copied into the returned `SnapshotSession` (which has no such field).
 */
function hasPreviousState(row: SnapshotSessionRow): boolean {
  return typeof row.previous_state === 'string' && row.previous_state.length > 0
}

/**
 * Parse a stored rollback buffer. Rollback states written before the snapshot
 * schema was extended to nine fields only carry the original six; the three
 * newer fields fall back to their empty defaults instead of failing the
 * restore.
 */
function normalizePreviousSnapshotState(raw: unknown): SnapshotPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>
  const parsed = SnapshotPayloadSchema.safeParse({
    ...candidate,
    tested_interfaces: candidate.tested_interfaces ?? [],
    notes: candidate.notes ?? '',
    related_vuln_ids: candidate.related_vuln_ids ?? []
  })
  return parsed.success ? parsed.data : null
}

/**
 * Convert the old structured JSON reproduction steps (V1.0) into the current
 * Markdown string format so existing databases keep their evidence readable.
 */
function legacyStepsToMarkdown(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null

  const sections: string[] = []
  parsed.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) return
    const step = item as Record<string, unknown>
    const number = typeof step.step === 'number' ? step.step : index + 1
    const description = typeof step.description === 'string' ? step.description : ''
    const request = typeof step.request === 'string' ? step.request : ''
    const response = typeof step.response === 'string' ? step.response : ''
    const judgment = typeof step.judgment === 'string' ? step.judgment : ''

    const lines = [`### 步骤 ${number}${description ? `：${description}` : ''}`]
    if (request) lines.push('', '**请求**', '```http', request, '```')
    if (response) lines.push('', '**响应**', '```http', response, '```')
    if (judgment) lines.push('', `**判据**：${judgment}`)
    sections.push(lines.join('\n'))
  })

  return sections.length > 0 ? sections.join('\n\n') : null
}

/**
 * Single source of truth for persistence. The renderer never touches SQLite;
 * the MCP server and the IPC layer both go through this service.
 *
 * All statements use parameter binding (never string concatenation) so untrusted
 * agent input cannot be injected into SQL.
 */
export class DatabaseService {
  private readonly db: Database.Database
  readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
    }
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  /**
   * Run one write transaction with `BEGIN IMMEDIATE` and bounded retries.
   *
   * `BEGIN IMMEDIATE` takes the write lock up front instead of failing halfway
   * through a deferred transaction, and the retry loop keeps two concurrent
   * agent processes from surfacing a transient SQLITE_BUSY as a tool error.
   */
  private writeTransaction<T>(fn: () => T): T {
    const run = this.db.transaction(fn)
    let lastError: unknown
    for (let attempt = 0; attempt <= WRITE_TRANSACTION_MAX_RETRIES; attempt += 1) {
      try {
        return run.immediate()
      } catch (error) {
        if (!isBusyError(error) || attempt === WRITE_TRANSACTION_MAX_RETRIES) throw error
        lastError = error
        sleepSync(WRITE_TRANSACTION_BASE_DELAY_MS * 2 ** attempt)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('写事务失败')
  }

  private migrate(): void {
    this.writeTransaction(() => this.migrateSchema())
  }

  private migrateSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vulnerabilities (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        entry_point TEXT NOT NULL DEFAULT '',
        vuln_name TEXT NOT NULL,
        vuln_type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('Critical', 'High', 'Medium', 'Low', 'Info')),
        target_url TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        impact TEXT NOT NULL DEFAULT '',
        affected_interfaces TEXT NOT NULL DEFAULT '[]',
        reproduction_steps TEXT NOT NULL DEFAULT '',
        remediation TEXT NOT NULL DEFAULT '[]',
        crypto_details TEXT NOT NULL DEFAULT '',
        test_boundaries TEXT NOT NULL DEFAULT '',
        retest_results TEXT NOT NULL DEFAULT '[]',
        related_vuln_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'Confirmed' CHECK (status IN ('Confirmed', 'Inconclusive', 'Retest_Passed')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vulnerabilities_host ON vulnerabilities (host);
      CREATE INDEX IF NOT EXISTS idx_vulnerabilities_severity ON vulnerabilities (severity);
      CREATE INDEX IF NOT EXISTS idx_vulnerabilities_status ON vulnerabilities (status);
      CREATE INDEX IF NOT EXISTS idx_vulnerabilities_created_at ON vulnerabilities (created_at DESC);

      CREATE TABLE IF NOT EXISTS assets (
        host_port TEXT PRIMARY KEY,
        host TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL,
        tech_stack TEXT NOT NULL DEFAULT '',
        auth_required INTEGER NOT NULL DEFAULT 0 CHECK (auth_required IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'Alive' CHECK (status IN ('Alive', 'Dead', 'WAF_Blocked')),
        interfaces TEXT NOT NULL DEFAULT '[]',
        interface_dir TEXT NOT NULL DEFAULT '[]',
        leaked_infos TEXT NOT NULL DEFAULT '[]',
        test_parameters TEXT NOT NULL DEFAULT '[]',
        related_vuln_ids TEXT NOT NULL DEFAULT '[]',
        last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_assets_project ON assets (project_name);
      CREATE INDEX IF NOT EXISTS idx_assets_last_seen ON assets (last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_assets_status ON assets (status);

      CREATE TABLE IF NOT EXISTS snapshot_sessions (
        session_id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        target_hosts TEXT NOT NULL DEFAULT '[]',
        current_phase TEXT NOT NULL DEFAULT '',
        unfinished_tasks TEXT NOT NULL DEFAULT '[]',
        failed_paths TEXT NOT NULL DEFAULT '[]',
        tested_interfaces TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        related_vuln_ids TEXT NOT NULL DEFAULT '[]',
        next_steps TEXT NOT NULL DEFAULT '',
        previous_state TEXT,
        parent_session_id TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshot_sessions_project ON snapshot_sessions (project_name);
      CREATE INDEX IF NOT EXISTS idx_snapshot_sessions_updated ON snapshot_sessions (updated_at DESC);
    `)

    const snapshotColumnMigrations: Array<[string, string]> = [
      ['previous_state', 'TEXT'],
      ['tested_interfaces', "TEXT NOT NULL DEFAULT '[]'"],
      ['notes', "TEXT NOT NULL DEFAULT ''"],
      ['related_vuln_ids', "TEXT NOT NULL DEFAULT '[]'"],
      ['parent_session_id', 'TEXT'],
      ['archived_at', 'TEXT']
    ]
    const snapshotColumns = this.db.prepare('PRAGMA table_info(snapshot_sessions)').all() as Array<{
      name: string
    }>
    for (const [columnName, columnDefinition] of snapshotColumnMigrations) {
      if (snapshotColumns.some((column) => column.name === columnName)) continue
      this.db.exec(`ALTER TABLE snapshot_sessions ADD COLUMN ${columnName} ${columnDefinition}`)
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_snapshot_sessions_parent ON snapshot_sessions (parent_session_id)'
    )

    const assetColumns = this.db.prepare('PRAGMA table_info(assets)').all() as Array<{
      name: string
    }>
    if (!assetColumns.some((column) => column.name === 'host')) {
      this.db.exec("ALTER TABLE assets ADD COLUMN host TEXT NOT NULL DEFAULT ''")
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_assets_host ON assets (host)')

    const missingHosts = this.db
      .prepare("SELECT host_port FROM assets WHERE host = ''")
      .all() as Array<{ host_port: string }>
    if (missingHosts.length > 0) {
      const updateHost = this.db.prepare('UPDATE assets SET host = ? WHERE host_port = ?')
      this.writeTransaction(() => {
        for (const row of missingHosts) {
          updateHost.run(deriveAssetHost(row.host_port), row.host_port)
        }
      })
    }

    if (!assetColumns.some((column) => column.name === 'interfaces')) {
      this.db.exec("ALTER TABLE assets ADD COLUMN interfaces TEXT NOT NULL DEFAULT '[]'")
    }
    if (!assetColumns.some((column) => column.name === 'test_parameters')) {
      this.db.exec("ALTER TABLE assets ADD COLUMN test_parameters TEXT NOT NULL DEFAULT '[]'")
    }
    this.migrateAssetInterfaces()

    const columns = this.db.prepare('PRAGMA table_info(vulnerabilities)').all() as Array<{
      name: string
    }>

    if (!columns.some((column) => column.name === 'retest_results')) {
      this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN retest_results TEXT NOT NULL DEFAULT '[]'")
    }

    this.migrateLegacyRetestResults()

    const hasReproductionColumn = columns.some((column) => column.name === 'reproduction_steps')
    if (!hasReproductionColumn) {
      this.db.exec(
        "ALTER TABLE vulnerabilities ADD COLUMN reproduction_steps TEXT NOT NULL DEFAULT ''"
      )
    } else {
      const legacyRows = this.db
        .prepare(
          "SELECT id, reproduction_steps FROM vulnerabilities WHERE reproduction_steps LIKE '[%'"
        )
        .all() as Array<{ id: string; reproduction_steps: string }>
      if (legacyRows.length > 0) {
        const update = this.db.prepare(
          'UPDATE vulnerabilities SET reproduction_steps = ? WHERE id = ?'
        )
        this.writeTransaction(() => {
          for (const row of legacyRows) {
            const markdown = legacyStepsToMarkdown(row.reproduction_steps)
            if (markdown !== null) update.run(markdown, row.id)
          }
        })
      }
    }

    this.db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`)
  }

  /**
   * One-time best-effort migration for retest paragraphs written into
   * `test_boundaries` by the previous integration. Only rows with an empty
   * retest history and a recognizable timestamp plus retest keyword are touched.
   */
  private migrateLegacyRetestResults(): void {
    const rows = this.db
      .prepare(
        "SELECT id, test_boundaries, retest_results FROM vulnerabilities WHERE retest_results = '[]' AND test_boundaries LIKE '%复测%'"
      )
      .all() as Array<{ id: string; test_boundaries: string; retest_results: string }>

    if (rows.length === 0) return
    const update = this.db.prepare(
      'UPDATE vulnerabilities SET retest_results = ?, test_boundaries = ? WHERE id = ?'
    )
    this.writeTransaction(() => {
      for (const row of rows) {
        if (parseJsonArray<RetestResult>(row.retest_results).length > 0) continue
        const legacy = extractLegacyRetest(row.test_boundaries)
        if (legacy === null) continue
        const retest: RetestResult = {
          time_range: legacy.time_range,
          conclusion: legacy.conclusion
        }
        update.run(
          JSON.stringify([retest]),
          legacy.remaining_boundaries,
          row.id
        )
      }
    })
  }

  /**
   * Backfill / canonicalize the `assets.interfaces` JSON column.
   *
   * Legacy databases only have `interface_dir: string[]`; those entries become
   * `{ path }`. Structured rows sent by newer clients keep their method / params
   * / raw request. The `interface_dir` column is rewritten to the derived path
   * array so old SQL consumers still read the same paths. A row is rewritten
   * only when its persisted JSON is not already canonical, making this safe to
   * run on every startup.
   */
  private migrateAssetInterfaces(): void {
    interface AssetInterfaceRow {
      host_port: string
      interfaces: string | null
      interface_dir: string | null
    }

    const rows = this.db
      .prepare('SELECT host_port, interfaces, interface_dir FROM assets')
      .all() as AssetInterfaceRow[]
    if (rows.length === 0) return

    const update = this.db.prepare(
      'UPDATE assets SET interfaces = ?, interface_dir = ? WHERE host_port = ?'
    )
    this.writeTransaction(() => {
      for (const row of rows) {
        const stored = parseStoredAssetInterfaces(row.interfaces)
        const canonical = normalizeAssetInterfaces(
          stored ?? [],
          parseJsonArray<string>(row.interface_dir ?? '[]')
        )
        const serialized = JSON.stringify(canonical)
        if (stored !== null && JSON.stringify(stored) === serialized) continue
        update.run(serialized, JSON.stringify(interfaceDirFromInterfaces(canonical)), row.host_port)
      }
    })
  }

  /** Insert a record, or fully replace it when the same id already exists. */
  saveVulnerability(vuln: Vulnerability): { created: boolean } {
    return this.writeTransaction(() => this.insertOrReplaceVulnerability(vuln))
  }

  private insertOrReplaceVulnerability(vuln: Vulnerability): { created: boolean } {
    const existing = this.db.prepare('SELECT 1 AS hit FROM vulnerabilities WHERE id = ?').get(vuln.id)
    const created = existing === undefined

    this.db
      .prepare(
        `
        INSERT INTO vulnerabilities (
          id, host, entry_point, vuln_name, vuln_type, severity, target_url,
          description, impact, affected_interfaces, reproduction_steps, remediation,
          crypto_details, test_boundaries, retest_results, related_vuln_ids, status, created_at
        ) VALUES (
          @id, @host, @entry_point, @vuln_name, @vuln_type, @severity, @target_url,
          @description, @impact, @affected_interfaces, @reproduction_steps, @remediation,
          @crypto_details, @test_boundaries, @retest_results, @related_vuln_ids, @status, @created_at
        )
        ON CONFLICT(id) DO UPDATE SET
          host = excluded.host,
          entry_point = excluded.entry_point,
          vuln_name = excluded.vuln_name,
          vuln_type = excluded.vuln_type,
          severity = excluded.severity,
          target_url = excluded.target_url,
          description = excluded.description,
          impact = excluded.impact,
          affected_interfaces = excluded.affected_interfaces,
          reproduction_steps = excluded.reproduction_steps,
          remediation = excluded.remediation,
          crypto_details = excluded.crypto_details,
          test_boundaries = excluded.test_boundaries,
          retest_results = excluded.retest_results,
          related_vuln_ids = excluded.related_vuln_ids,
          status = excluded.status,
          created_at = excluded.created_at
        `
      )
      .run({
        id: vuln.id,
        host: vuln.host,
        entry_point: vuln.entry_point,
        vuln_name: vuln.vuln_name,
        vuln_type: vuln.vuln_type,
        severity: vuln.severity,
        target_url: vuln.target_url,
        description: vuln.description,
        impact: vuln.impact,
        affected_interfaces: JSON.stringify(vuln.affected_interfaces),
        reproduction_steps: vuln.reproduction_steps,
        remediation: JSON.stringify(vuln.remediation),
        crypto_details: vuln.crypto_details,
        test_boundaries: vuln.test_boundaries,
        retest_results: JSON.stringify(vuln.retest_results),
        related_vuln_ids: JSON.stringify(vuln.related_vuln_ids),
        status: vuln.status,
        created_at: vuln.created_at
      })

    return { created }
  }

  getById(id: string): Vulnerability | null {
    const row = this.db
      .prepare('SELECT * FROM vulnerabilities WHERE id = ?')
      .get(id) as VulnerabilityRow | undefined
    return row ? this.mapRow(row) : null
  }

  /**
   * Server-side paginated + filtered vulnerability list.
   *
   * The same `WHERE` built from search / severity / status drives both the
   * `COUNT(*)` (filtered total) and the `LIMIT / OFFSET` page query, so no full
   * table is ever materialised in memory. The effective page is clamped to the
   * last non-empty page and returned, which lets the UI recover from deleting
   * the final row of the last page.
   */
  list(filters: VulnListQuery = {}): PaginatedVulnerabilities {
    const clauses: string[] = []
    const params: Record<string, string> = {}

    const search = filters.search?.trim()
    if (search) {
      clauses.push(
        `(lower(host) LIKE @search OR lower(vuln_name) LIKE @search OR lower(id) LIKE @search OR lower(vuln_type) LIKE @search OR lower(target_url) LIKE @search)`
      )
      params.search = `%${search.toLowerCase()}%`
    }
    if (filters.severity && filters.severity !== 'all') {
      clauses.push('severity = @severity')
      params.severity = filters.severity
    }
    if (filters.status && filters.status !== 'all') {
      clauses.push('status = @status')
      params.status = filters.status
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const hasParams = Object.keys(params).length > 0

    const countStatement = this.db.prepare(
      `SELECT COUNT(*) AS count FROM vulnerabilities ${where}`
    )
    const countRow = (hasParams ? countStatement.get(params) : countStatement.get()) as {
      count: number
    }
    const total = countRow.count

    const requestedPageSize = Number(filters.pageSize ?? DEFAULT_VULN_PAGE_SIZE)
    const pageSize = Number.isFinite(requestedPageSize)
      ? Math.min(200, Math.max(1, Math.trunc(requestedPageSize)))
      : DEFAULT_VULN_PAGE_SIZE

    const lastPage = Math.max(1, Math.ceil(total / pageSize))
    const requestedPage = Number(filters.page ?? 1)
    const page = Number.isFinite(requestedPage)
      ? Math.min(lastPage, Math.max(1, Math.trunc(requestedPage)))
      : 1

    const statement = this.db.prepare(
      `SELECT ${LIST_COLUMNS} FROM vulnerabilities ${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`
    )
    const pageParams = { ...params, limit: pageSize, offset: (page - 1) * pageSize }
    const rows = statement.all(pageParams) as Array<
      Pick<
        VulnerabilityRow,
        | 'id'
        | 'host'
        | 'entry_point'
        | 'vuln_name'
        | 'vuln_type'
        | 'severity'
        | 'target_url'
        | 'status'
        | 'created_at'
      >
    >

    return {
      items: rows.map((row) => ({
        id: row.id,
        host: row.host,
        entry_point: row.entry_point,
        vuln_name: row.vuln_name,
        vuln_type: row.vuln_type,
        severity: toSeverity(row.severity),
        target_url: row.target_url,
        status: toStatus(row.status),
        created_at: row.created_at
      })),
      total,
      page,
      pageSize
    }
  }

  /** Compact list for the `query_vulnerabilities` MCP tool (host mode). */
  queryByHost(host: string): VulnSummary[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, vuln_name, severity, target_url
        FROM vulnerabilities
        WHERE lower(host) = lower(?)
        ORDER BY
          CASE severity
            WHEN 'Critical' THEN 0
            WHEN 'High' THEN 1
            WHEN 'Medium' THEN 2
            WHEN 'Low' THEN 3
            ELSE 4
          END,
          created_at DESC
        `
      )
      .all(host.trim()) as SummaryRow[]

    return rows.map((row) => ({
      vuln_id: row.id,
      vuln_name: row.vuln_name,
      severity: toSeverity(row.severity),
      target_url: row.target_url
    }))
  }

  updateStatus(id: string, status: VulnStatus): Vulnerability {
    return this.writeTransaction(() => {
      const result = this.db
        .prepare('UPDATE vulnerabilities SET status = ? WHERE id = ?')
        .run(status, id)
      if (result.changes === 0) {
        throw new DatabaseError('NOT_FOUND', `未找到 ID 为 ${id} 的漏洞`)
      }
      const updated = this.getById(id)
      if (!updated) {
        throw new DatabaseError('INTERNAL', `更新后无法读取 ID 为 ${id} 的漏洞`)
      }
      return updated
    })
  }

  /**
   * Append one retest entry without changing the original vulnerability
   * evidence. Status is only changed when explicitly supplied.
   */
  appendRetestResult(
    id: string,
    retest: RetestResult,
    status?: VulnStatus
  ): { vulnerability: Vulnerability; retestIndex: number } {
    return this.writeTransaction(() => {
      const existing = this.getById(id)
      if (!existing) {
        throw new DatabaseError('NOT_FOUND', `未找到 ID 为 ${id} 的漏洞`)
      }
      if (existing.retest_results.length >= 100) {
        throw new DatabaseError('INVALID_INPUT', `漏洞 ${id} 的复测记录已达到上限（100 条）`)
      }

      const retestResults = [...existing.retest_results, retest]
      const updated: Vulnerability = {
        ...existing,
        retest_results: retestResults,
        status: status ?? existing.status
      }
      this.saveVulnerability(updated)
      return { vulnerability: updated, retestIndex: retestResults.length - 1 }
    })
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM vulnerabilities WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** Delete many records atomically; returns the number of removed rows. */
  deleteMany(ids: string[]): number {
    if (ids.length === 0) return 0
    const remove = this.db.prepare('DELETE FROM vulnerabilities WHERE id = ?')
    return this.writeTransaction(() => {
      let deleted = 0
      for (const id of ids) deleted += remove.run(id).changes
      return deleted
    })
  }

  /** `PRAGMA user_version` as written by the last completed migration. */
  getSchemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number
  }

  /**
   * Read-only snapshot of the database location / version / files, used by the
   * MCP page and `ctx doctor`. `:memory:` databases report zeroed file stats.
   */
  getDatabaseInfo(): DatabaseInfo {
    if (this.dbPath === ':memory:') {
      return {
        dbPath: this.dbPath,
        schemaVersion: this.getSchemaVersion(),
        exists: true,
        sizeBytes: 0,
        walSizeBytes: 0,
        lastModifiedAt: null
      }
    }

    const main = statIfExists(this.dbPath)
    const wal = statIfExists(`${this.dbPath}-wal`)
    const shm = statIfExists(`${this.dbPath}-shm`)
    const modifiedAt = Math.max(
      main?.mtimeMs ?? 0,
      wal?.mtimeMs ?? 0,
      shm?.mtimeMs ?? 0
    )
    return {
      dbPath: this.dbPath,
      schemaVersion: this.getSchemaVersion(),
      exists: main !== null,
      sizeBytes: main?.size ?? 0,
      walSizeBytes: wal?.size ?? 0,
      lastModifiedAt: modifiedAt > 0 ? new Date(modifiedAt).toISOString() : null
    }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM vulnerabilities').get() as {
      count: number
    }
    return row.count
  }

  countAssets(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM assets').get() as {
      count: number
    }
    return row.count
  }

  /**
   * Insert or update an asset context.
   *
   * `replace` is the default and mirrors the original INSERT OR REPLACE
   * contract: the payload is the authoritative snapshot. `merge` preserves
   * existing array entries and is intended for incremental discovery.
   * `last_seen` is always server-owned so agent clocks cannot move it backwards.
   */
  upsertAssetContext(
    asset: AssetContext,
    mode: AssetSyncMode = 'replace'
  ): { created: boolean; asset: AssetContext } {
    return this.writeTransaction(() => this.upsertAssetContextInternal(asset, mode))
  }

  private upsertAssetContextInternal(
    asset: AssetContext,
    mode: AssetSyncMode
  ): { created: boolean; asset: AssetContext } {
    const hostPort = normalizeAssetIdentifier(asset.host_port)
    const host = deriveAssetHost(hostPort) || asset.host.trim().toLowerCase()
    const existing = this.getAssetDetail(hostPort)
    const incomingInterfaces = normalizeAssetInterfaces(asset.interfaces, asset.interface_dir)
    const incoming: AssetContext = {
      ...asset,
      host_port: hostPort,
      host,
      project_name: asset.project_name.trim(),
      tech_stack: asset.tech_stack?.trim() ?? '',
      interfaces: incomingInterfaces,
      interface_dir: interfaceDirFromInterfaces(incomingInterfaces),
      leaked_infos: uniqueLeakedInfos(asset.leaked_infos),
      test_parameters: canonicalizeTestParameters(asset.test_parameters),
      related_vuln_ids: uniqueStrings(asset.related_vuln_ids),
      last_seen: new Date().toISOString()
    }

    let stored = incoming
    if (existing !== null && mode === 'merge') {
      const mergedInterfaces = normalizeAssetInterfaces([
        ...existing.interfaces,
        ...incoming.interfaces
      ])
      stored = {
        ...existing,
        ...incoming,
        host: incoming.host || existing.host,
        project_name: incoming.project_name.length > 0 ? incoming.project_name : existing.project_name,
        tech_stack: incoming.tech_stack && incoming.tech_stack.length > 0
          ? incoming.tech_stack
          : existing.tech_stack,
        interfaces: mergedInterfaces,
        interface_dir: interfaceDirFromInterfaces(mergedInterfaces),
        leaked_infos: uniqueLeakedInfos([...existing.leaked_infos, ...incoming.leaked_infos]),
        test_parameters: mergeTestParameterLists(
          existing.test_parameters,
          incoming.test_parameters
        ),
        related_vuln_ids: uniqueStrings([
          ...existing.related_vuln_ids,
          ...incoming.related_vuln_ids
        ]),
        last_seen: incoming.last_seen
      }
    }

    this.db
      .prepare(
        `
        INSERT INTO assets (
          host_port, host, project_name, tech_stack, auth_required, status,
          interfaces, interface_dir, leaked_infos, test_parameters,
          related_vuln_ids, last_seen
        ) VALUES (
          @host_port, @host, @project_name, @tech_stack, @auth_required, @status,
          @interfaces, @interface_dir, @leaked_infos, @test_parameters,
          @related_vuln_ids, @last_seen
        )
        ON CONFLICT(host_port) DO UPDATE SET
          host = excluded.host,
          project_name = excluded.project_name,
          tech_stack = excluded.tech_stack,
          auth_required = excluded.auth_required,
          status = excluded.status,
          interfaces = excluded.interfaces,
          interface_dir = excluded.interface_dir,
          leaked_infos = excluded.leaked_infos,
          test_parameters = excluded.test_parameters,
          related_vuln_ids = excluded.related_vuln_ids,
          last_seen = excluded.last_seen
        `
      )
      .run({
        host_port: stored.host_port,
        host: stored.host,
        project_name: stored.project_name,
        tech_stack: stored.tech_stack ?? '',
        auth_required: stored.auth_required ? 1 : 0,
        status: stored.status,
        interfaces: JSON.stringify(stored.interfaces),
        interface_dir: JSON.stringify(stored.interface_dir),
        leaked_infos: JSON.stringify(stored.leaked_infos),
        test_parameters: JSON.stringify(stored.test_parameters),
        related_vuln_ids: JSON.stringify(stored.related_vuln_ids),
        last_seen: stored.last_seen
      })

    return { created: existing === null, asset: stored }
  }

  getAssetDetail(hostPort: string): AssetContext | null {
    const key = normalizeAssetIdentifier(hostPort)
    const row = this.db.prepare('SELECT * FROM assets WHERE host_port = ?').get(key) as
      | AssetRow
      | undefined
    return row ? this.mapAssetRow(row) : null
  }

  /**
   * Permanently delete one asset context row.
   * Vulnerability records, snapshots and the asset's history in other tables are
   * intentionally untouched: only the asset library entry disappears.
   */
  deleteAsset(hostPort: string): boolean {
    const key = normalizeAssetIdentifier(hostPort)
    const result = this.db.prepare('DELETE FROM assets WHERE host_port = ?').run(key)
    return result.changes > 0
  }

  listAssets(filters: AssetFilters = {}): AssetListItem[] {
    const clauses: string[] = []
    const params: Record<string, string> = {}
    const search = filters.search?.trim()

    if (search) {
      clauses.push(
        "(lower(host_port) LIKE @search OR lower(host) LIKE @search OR lower(project_name) LIKE @search OR lower(COALESCE(tech_stack, '')) LIKE @search)"
      )
      params.search = `%${search.toLowerCase()}%`
    }
    if (filters.status && filters.status !== 'all') {
      clauses.push('status = @status')
      params.status = filters.status
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const statement = this.db.prepare(
      `SELECT * FROM assets ${where} ORDER BY last_seen DESC, host_port ASC LIMIT 500`
    )
    const rows = (
      Object.keys(params).length > 0 ? statement.all(params) : statement.all()
    ) as AssetRow[]

    return rows.map((row) => {
      const context = this.mapAssetRow(row)
      return {
        host_port: context.host_port,
        host: context.host,
        project_name: context.project_name,
        tech_stack: context.tech_stack ?? '',
        auth_required: context.auth_required,
        status: context.status,
        interface_count: context.interfaces.length,
        leak_count: context.leaked_infos.length,
        related_vuln_count: context.related_vuln_ids.length,
        last_seen: context.last_seen
      }
    })
  }

  /** Case-insensitive project-name substring search, newest assets first. */
  queryAssetsByProject(projectName: string): AssetContext[] {
    const needle = projectName.trim()
    if (needle.length === 0) return []
    const rows = this.db
      .prepare(
        `
        SELECT * FROM assets
        WHERE instr(lower(project_name), lower(?)) > 0
        ORDER BY last_seen DESC, host_port ASC
        LIMIT 200
        `
      )
      .all(needle) as AssetRow[]
    return rows.map((row) => this.mapAssetRow(row))
  }

  /**
   * Related vulnerabilities shown in the asset drawer. Both explicit
   * `related_vuln_ids` and host-derived matches are returned; an asset recorded
   * without a port (e.g. `example.com`) links to `example.com:443` findings.
   */
  getAssetRelatedVulnerabilities(hostPort: string): VulnerabilityListItem[] {
    const asset = this.getAssetDetail(hostPort)
    if (asset === null) return []

    const bareHost = asset.host || deriveAssetHost(asset.host_port)
    if (bareHost.length === 0) return []
    const clauses = ['lower(host) = @host', 'lower(host) LIKE @hostPrefix']
    const params: Record<string, string> = {
      host: bareHost,
      hostPrefix: `${bareHost}:%`
    }

    for (const [index, id] of asset.related_vuln_ids.entries()) {
      const placeholder = `explicit${index}`
      clauses.push(`id = @${placeholder}`)
      params[placeholder] = id
    }

    const rows = this.db
      .prepare(
        `
        SELECT ${LIST_COLUMNS}
        FROM vulnerabilities
        WHERE ${clauses.join(' OR ')}
        ORDER BY
          CASE severity
            WHEN 'Critical' THEN 0
            WHEN 'High' THEN 1
            WHEN 'Medium' THEN 2
            WHEN 'Low' THEN 3
            ELSE 4
          END,
          created_at DESC
        LIMIT 500
        `
      )
      .all(params) as Array<
      Pick<
        VulnerabilityRow,
        | 'id'
        | 'host'
        | 'entry_point'
        | 'vuln_name'
        | 'vuln_type'
        | 'severity'
        | 'target_url'
        | 'status'
        | 'created_at'
      >
    >

    return rows.map((row) => ({
      id: row.id,
      host: row.host,
      entry_point: row.entry_point,
      vuln_name: row.vuln_name,
      vuln_type: row.vuln_type,
      severity: toSeverity(row.severity),
      target_url: row.target_url,
      status: toStatus(row.status),
      created_at: row.created_at
    }))
  }

  getStats(): DashboardStats {
    const totals = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS total,
          COUNT(DISTINCT host) AS hosts,
          SUM(CASE WHEN severity = 'Critical' THEN 1 ELSE 0 END) AS critical,
          SUM(CASE WHEN severity = 'High' THEN 1 ELSE 0 END) AS high,
          SUM(CASE WHEN date(created_at, 'localtime') = date('now', 'localtime') THEN 1 ELSE 0 END) AS today
        FROM vulnerabilities
        `
      )
      .get() as {
      total: number | null
      hosts: number | null
      critical: number | null
      high: number | null
      today: number | null
    }

    const severityRows = this.db
      .prepare('SELECT severity, COUNT(*) AS count FROM vulnerabilities GROUP BY severity')
      .all() as Array<{ severity: string; count: number }>
    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM vulnerabilities GROUP BY status')
      .all() as Array<{ status: string; count: number }>

    const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as SeverityMap
    for (const row of severityRows) {
      bySeverity[toSeverity(row.severity)] = row.count
    }
    const byStatus = Object.fromEntries(VULN_STATUSES.map((status) => [status, 0])) as StatusMap
    for (const row of statusRows) {
      byStatus[toStatus(row.status)] = row.count
    }

    return {
      total: totals.total ?? 0,
      critical: totals.critical ?? 0,
      high: totals.high ?? 0,
      hosts: totals.hosts ?? 0,
      today: totals.today ?? 0,
      bySeverity,
      byStatus
    }
  }

  /** Allocate the next readable id, e.g. VULN-20261030-003 (local date). */
  generateId(now: Date = new Date()): string {
    const prefix = `VULN-${formatLocalDate(now)}-`
    const row = this.db
      .prepare('SELECT id FROM vulnerabilities WHERE id LIKE ? ORDER BY id DESC LIMIT 1')
      .get(`${prefix}%`) as { id: string } | undefined

    let sequence = 1
    if (row) {
      const parsed = Number.parseInt(row.id.slice(prefix.length), 10)
      if (Number.isFinite(parsed) && parsed > 0) sequence = parsed + 1
    }

    let candidate = `${prefix}${sequence.toString().padStart(3, '0')}`
    while (this.db.prepare('SELECT 1 FROM vulnerabilities WHERE id = ?').get(candidate)) {
      sequence += 1
      candidate = `${prefix}${sequence.toString().padStart(3, '0')}`
    }
    return candidate
  }

  /** Allocate the next session id, e.g. SESS-20260101-002 (local date). */
  generateSnapshotSessionId(now: Date = new Date()): string {
    const prefix = `SESS-${formatLocalDate(now)}-`
    const row = this.db
      .prepare(
        'SELECT session_id FROM snapshot_sessions WHERE session_id LIKE ? ORDER BY session_id DESC LIMIT 1'
      )
      .get(`${prefix}%`) as { session_id: string } | undefined

    let sequence = 1
    if (row) {
      const parsed = Number.parseInt(row.session_id.slice(prefix.length), 10)
      if (Number.isFinite(parsed) && parsed > 0) sequence = parsed + 1
    }

    let candidate = `${prefix}${sequence.toString().padStart(3, '0')}`
    while (this.db.prepare('SELECT 1 FROM snapshot_sessions WHERE session_id = ?').get(candidate)) {
      sequence += 1
      candidate = `${prefix}${sequence.toString().padStart(3, '0')}`
    }
    return candidate
  }

  /**
   * Create a brand new session. `session_id` / `created_at` / `updated_at` are
   * server-owned; a new session never has a rollback state.
   *
   * Pass `parentSessionId` to create a child (system) session under a root
   * project session. The hierarchy is intentionally one level deep: the parent
   * must exist, must itself be a root session, and must not be archived.
   */
  createSnapshotSession(
    payload: SnapshotPayload,
    now: Date = new Date(),
    parentSessionId?: string
  ): SnapshotSession {
    this.assertSnapshotPayloadSize(payload)
    const sessionId = this.generateSnapshotSessionId(now)
    const timestamp = now.toISOString()
    this.writeTransaction((): void => {
      if (parentSessionId !== undefined) {
        const parent = this.getSnapshotRow(parentSessionId)
        if (!parent) {
          throw new DatabaseError('INVALID_INPUT', `未找到父会话 ${parentSessionId}，无法创建子会话`)
        }
        if (parent.parent_session_id !== null) {
          throw new DatabaseError(
            'INVALID_INPUT',
            `父会话 ${parentSessionId} 本身是子会话；只允许一层层级（项目会话 → 系统子会话）`
          )
        }
        if (parent.archived_at !== null) {
          throw new DatabaseError(
            'INVALID_INPUT',
            `父会话 ${parentSessionId} 已归档${SNAPSHOT_ARCHIVED_WRITE_ERROR}`
          )
        }
      }

      this.db
        .prepare(
          `
          INSERT INTO snapshot_sessions (
            session_id, project_name, target_hosts, current_phase,
            unfinished_tasks, failed_paths, tested_interfaces, notes,
            related_vuln_ids, next_steps, previous_state,
            parent_session_id, archived_at, created_at, updated_at
          ) VALUES (
            @session_id, @project_name, @target_hosts, @current_phase,
            @unfinished_tasks, @failed_paths, @tested_interfaces, @notes,
            @related_vuln_ids, @next_steps, NULL,
            @parent_session_id, NULL, @created_at, @updated_at
          )
          `
        )
        .run({
          session_id: sessionId,
          project_name: payload.project_name,
          target_hosts: JSON.stringify(payload.target_hosts),
          current_phase: payload.current_phase,
          unfinished_tasks: JSON.stringify(payload.unfinished_tasks),
          failed_paths: JSON.stringify(payload.failed_paths),
          tested_interfaces: JSON.stringify(payload.tested_interfaces),
          notes: payload.notes,
          related_vuln_ids: JSON.stringify(payload.related_vuln_ids),
          next_steps: payload.next_steps,
          parent_session_id: parentSessionId ?? null,
          created_at: timestamp,
          updated_at: timestamp
        })
    })
    return this.requireSnapshotSession(sessionId)
  }

  /**
   * Partially update one session. Only the payload fields present in `patch`
   * are overwritten (`undefined` keeps the stored value); arrays are replaced
   * wholesale, so `[]` clears them. The previous nine-field state is kept as the
   * single-step rollback buffer.
   *
   * `baseUpdatedAt` is an optimistic concurrency token: a mismatch raises
   * `DatabaseError('STALE')` so an agent cannot silently overwrite a session
   * that changed after it last loaded it.
   */
  updateSnapshotSession(
    sessionId: string,
    patch: SnapshotSavePayload,
    options: { baseUpdatedAt?: string } = {},
    now: Date = new Date()
  ): SnapshotSession {
    this.writeTransaction((): void => {
      const row = this.getSnapshotRow(sessionId)
      if (!row) throw new DatabaseError('NOT_FOUND', `未找到会话 ${sessionId}`)
      if (row.archived_at !== null) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `会话 ${sessionId} 已归档${SNAPSHOT_ARCHIVED_WRITE_ERROR}`
        )
      }
      if (options.baseUpdatedAt !== undefined && options.baseUpdatedAt !== row.updated_at) {
        throw new DatabaseError(
          'STALE',
          `会话 ${sessionId} 已被更新（当前 updated_at=${row.updated_at}），请先 load 最新会话后再保存`
        )
      }

      const definedFields = SNAPSHOT_PAYLOAD_FIELDS.filter((field) => patch[field] !== undefined)
      if (definedFields.length === 0) {
        throw new DatabaseError('INVALID_INPUT', 'payload 至少需要提供一个要更新的字段')
      }

      const current = snapshotPayloadFromRow(row)
      const next: SnapshotPayload = {
        project_name: patch.project_name ?? current.project_name,
        target_hosts: patch.target_hosts ?? current.target_hosts,
        current_phase: patch.current_phase ?? current.current_phase,
        unfinished_tasks: patch.unfinished_tasks ?? current.unfinished_tasks,
        failed_paths: patch.failed_paths ?? current.failed_paths,
        tested_interfaces: patch.tested_interfaces ?? current.tested_interfaces,
        notes: patch.notes ?? current.notes,
        related_vuln_ids: patch.related_vuln_ids ?? current.related_vuln_ids,
        next_steps: patch.next_steps ?? current.next_steps
      }
      this.persistSnapshotState(sessionId, next, JSON.stringify(current), now.toISOString())
    })
    return this.requireSnapshotSession(sessionId)
  }

  getSnapshotSession(sessionId: string): SnapshotSession | null {
    const row = this.getSnapshotRow(sessionId)
    return row ? this.mapSnapshotRow(row) : null
  }

  /**
   * Existing root (project) sessions for one project name, newest first. Child
   * sessions are never returned as "same project" candidates: saving a project
   * session only conflicts with other project sessions.
   */
  findSnapshotSessionsByProject(projectName: string, limit = 10): SnapshotSummary[] {
    const needle = projectName.trim()
    if (needle.length === 0) return []
    const capped = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.trunc(limit))) : 10
    const rows = this.db
      .prepare(
        `
        SELECT ${SNAPSHOT_SELECT_COLUMNS}
        FROM snapshot_sessions s
        WHERE lower(s.project_name) = lower(?) AND s.parent_session_id IS NULL
        ORDER BY s.updated_at DESC, s.session_id DESC
        LIMIT ?
        `
      )
      .all(needle, capped) as SnapshotSessionRow[]
    return rows.map((row) => this.mapSnapshotSummaryRow(row))
  }

  /**
   * Compact session list for the UI / `manage_snapshot` list action.
   *
   * - Archived sessions are hidden by default (`includeArchived` reveals them).
   * - `rootsOnly` returns only project sessions; `parentSessionId` returns the
   *   direct children of one project session (both may be combined with keyword).
   * - The keyword matches project name, phase, target hosts, notes, interface
   *   test records and next steps; heavy task arrays stay out of the summaries.
   */
  listSnapshotSessions(filters: SnapshotListFilters = {}): SnapshotListResult {
    const clauses: string[] = []
    const params: Record<string, string> = {}

    const keyword = filters.keyword?.trim()
    if (keyword) {
      clauses.push(
        `(lower(s.project_name) LIKE @keyword OR lower(s.current_phase) LIKE @keyword OR lower(s.target_hosts) LIKE @keyword OR lower(s.notes) LIKE @keyword OR lower(s.tested_interfaces) LIKE @keyword OR lower(s.next_steps) LIKE @keyword)`
      )
      params.keyword = `%${keyword.toLowerCase()}%`
    }
    if (filters.rootsOnly === true) {
      clauses.push('s.parent_session_id IS NULL')
    }
    const parentSessionId = filters.parentSessionId?.trim()
    if (parentSessionId) {
      clauses.push('s.parent_session_id = @parentSessionId')
      params.parentSessionId = parentSessionId
    }
    if (filters.includeArchived !== true) {
      clauses.push('s.archived_at IS NULL')
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const countStatement = this.db.prepare(
      `SELECT COUNT(*) AS count FROM snapshot_sessions s ${where}`
    )
    const total = (
      Object.keys(params).length > 0 ? countStatement.get(params) : countStatement.get()
    ) as { count: number }

    const requestedLimit = Number(filters.limit ?? SNAPSHOT_LIST_DEFAULT_LIMIT)
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50, Math.max(1, Math.trunc(requestedLimit)))
      : SNAPSHOT_LIST_DEFAULT_LIMIT
    const statement = this.db.prepare(
      `SELECT ${SNAPSHOT_SELECT_COLUMNS}
       FROM snapshot_sessions s ${where}
       ORDER BY s.updated_at DESC, s.session_id DESC
       LIMIT @limit`
    )
    const rows = (
      Object.keys(params).length > 0
        ? statement.all({ ...params, limit })
        : statement.all({ limit })
    ) as SnapshotSessionRow[]

    return {
      total: total.count,
      items: rows.map((row) => this.mapSnapshotSummaryRow(row))
    }
  }

  /** Direct children of one project session; archived children included by default. */
  listChildSnapshots(
    sessionId: string,
    options: { includeArchived?: boolean; limit?: number } = {}
  ): SnapshotSummary[] {
    return this.listSnapshotSessions({
      parentSessionId: sessionId,
      includeArchived: options.includeArchived ?? true,
      limit: options.limit ?? 50
    }).items
  }

  /**
   * Merge new target hosts into a session (trim + de-duplicate, order kept).
   * The pre-merge state becomes the rollback buffer.
   */
  attachSnapshotAssets(sessionId: string, hosts: string[], now: Date = new Date()): SnapshotSession {
    this.writeTransaction((): void => {
      const row = this.getSnapshotRow(sessionId)
      if (!row) throw new DatabaseError('NOT_FOUND', `未找到会话 ${sessionId}`)
      if (row.archived_at !== null) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `会话 ${sessionId} 已归档${SNAPSHOT_ARCHIVED_WRITE_ERROR}`
        )
      }

      const current = snapshotPayloadFromRow(row)
      const merged = uniqueStrings([...current.target_hosts, ...hosts])
      if (merged.length > MAX_SNAPSHOT_TARGET_HOSTS) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `合并后 target_hosts 超过上限（最多 ${MAX_SNAPSHOT_TARGET_HOSTS} 个）`
        )
      }
      const next: SnapshotPayload = { ...current, target_hosts: merged }
      this.persistSnapshotState(sessionId, next, JSON.stringify(current), now.toISOString())
    })
    return this.requireSnapshotSession(sessionId)
  }

  /**
   * Restore the nine cognitive-state fields from `previous_state` and clear the
   * buffer (single-step rollback). `created_at` and `session_id` never change.
   * Rollback data written before the schema extension falls back to the empty
   * defaults for `tested_interfaces` / `notes` / `related_vuln_ids`.
   */
  restoreSnapshotPrevious(sessionId: string, now: Date = new Date()): SnapshotSession {
    this.writeTransaction((): void => {
      const row = this.getSnapshotRow(sessionId)
      if (!row) throw new DatabaseError('NOT_FOUND', `未找到会话 ${sessionId}`)
      if (row.archived_at !== null) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `会话 ${sessionId} 已归档${SNAPSHOT_ARCHIVED_WRITE_ERROR}`
        )
      }
      if (!hasPreviousState(row)) {
        throw new DatabaseError('INVALID_INPUT', '该会话没有可回滚的上一版')
      }

      let parsedPrevious: unknown
      try {
        parsedPrevious = JSON.parse(row.previous_state as string)
      } catch {
        throw new DatabaseError('INVALID_INPUT', '该会话的上一版快照已损坏，无法回滚')
      }
      const previous = normalizePreviousSnapshotState(parsedPrevious)
      if (previous === null) {
        throw new DatabaseError('INVALID_INPUT', '该会话的上一版快照已损坏，无法回滚')
      }

      this.persistSnapshotState(sessionId, previous, null, now.toISOString())
    })
    return this.requireSnapshotSession(sessionId)
  }

  /**
   * Desktop-only archive toggle. Archiving/unarchiving a session cascades to its
   * direct child sessions so a project never shows active children while the
   * project itself is archived. `updated_at` is left untouched: archiving is a
   * visibility flag, not a cognitive-state edit.
   */
  setSnapshotArchived(sessionId: string, archived: boolean, now: Date = new Date()): SnapshotSession {
    this.writeTransaction((): void => {
      const row = this.getSnapshotRow(sessionId)
      if (!row) throw new DatabaseError('NOT_FOUND', `未找到会话 ${sessionId}`)

      const archivedAt = archived ? now.toISOString() : null
      this.db
        .prepare('UPDATE snapshot_sessions SET archived_at = ? WHERE session_id = ?')
        .run(archivedAt, sessionId)
      this.db
        .prepare('UPDATE snapshot_sessions SET archived_at = ? WHERE parent_session_id = ?')
        .run(archivedAt, sessionId)
    })
    return this.requireSnapshotSession(sessionId)
  }

  /**
   * Desktop-only hard delete. Direct child sessions are removed first, then the
   * session itself; returns the number of deleted rows (0 when it never existed,
   * so the UI delete button is idempotent).
   */
  deleteSnapshotSession(sessionId: string): number {
    return this.writeTransaction((): number => {
      const children = this.db
        .prepare('DELETE FROM snapshot_sessions WHERE parent_session_id = ?')
        .run(sessionId)
      const self = this.db.prepare('DELETE FROM snapshot_sessions WHERE session_id = ?').run(sessionId)
      return children.changes + self.changes
    })
  }

  private getSnapshotRow(sessionId: string): SnapshotSessionRow | undefined {
    return this.db
      .prepare(`SELECT ${SNAPSHOT_SELECT_COLUMNS} FROM snapshot_sessions s WHERE s.session_id = ?`)
      .get(sessionId) as SnapshotSessionRow | undefined
  }

  private requireSnapshotSession(sessionId: string): SnapshotSession {
    const session = this.getSnapshotSession(sessionId)
    if (!session) {
      throw new DatabaseError('INTERNAL', `写入后无法读取会话 ${sessionId}`)
    }
    return session
  }

  private persistSnapshotState(
    sessionId: string,
    payload: SnapshotPayload,
    previousState: string | null,
    updatedAt: string
  ): void {
    this.assertSnapshotPayloadSize(payload)
    this.db
      .prepare(
        `
        UPDATE snapshot_sessions SET
          project_name = @project_name,
          target_hosts = @target_hosts,
          current_phase = @current_phase,
          unfinished_tasks = @unfinished_tasks,
          failed_paths = @failed_paths,
          tested_interfaces = @tested_interfaces,
          notes = @notes,
          related_vuln_ids = @related_vuln_ids,
          next_steps = @next_steps,
          previous_state = @previous_state,
          updated_at = @updated_at
        WHERE session_id = @session_id
        `
      )
      .run({
        session_id: sessionId,
        project_name: payload.project_name,
        target_hosts: JSON.stringify(payload.target_hosts),
        current_phase: payload.current_phase,
        unfinished_tasks: JSON.stringify(payload.unfinished_tasks),
        failed_paths: JSON.stringify(payload.failed_paths),
        tested_interfaces: JSON.stringify(payload.tested_interfaces),
        notes: payload.notes,
        related_vuln_ids: JSON.stringify(payload.related_vuln_ids),
        next_steps: payload.next_steps,
        previous_state: previousState,
        updated_at: updatedAt
      })
  }

  /**
   * Serialized ceiling for the nine cognitive-state fields. Per-field caps can
   * still add up, so a single `load` must never be able to flood the next
   * session's context; detailed evidence belongs in the vulnerability / asset
   * libraries instead of the snapshot.
   */
  private assertSnapshotPayloadSize(payload: SnapshotPayload): void {
    const size = JSON.stringify(payload).length
    if (size <= SNAPSHOT_MAX_PAYLOAD_CHARS) return
    throw new DatabaseError(
      'INVALID_INPUT',
      `快照内容过大（序列化后 ${size} 字符，上限 ${SNAPSHOT_MAX_PAYLOAD_CHARS} 字符）：请精简 notes / tested_interfaces，或把完整证据写入漏洞库/资产库后用 related_vuln_ids 引用`
    )
  }

  private mapSnapshotRow(row: SnapshotSessionRow): SnapshotSession {
    return {
      ...snapshotPayloadFromRow(row),
      session_id: row.session_id,
      parent_session_id: row.parent_session_id ?? null,
      archived_at: row.archived_at ?? null,
      child_count: row.child_count ?? 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      has_previous_state: hasPreviousState(row)
    }
  }

  private mapSnapshotSummaryRow(row: SnapshotSessionRow): SnapshotSummary {
    const unfinished = parseJsonArray<string>(row.unfinished_tasks)
    const failed = parseJsonArray<string>(row.failed_paths)
    const testedInterfaces = parseJsonArray<SnapshotTestedInterface>(row.tested_interfaces)
    return {
      session_id: row.session_id,
      project_name: row.project_name,
      current_phase: row.current_phase,
      target_hosts: parseJsonArray<string>(row.target_hosts),
      parent_session_id: row.parent_session_id ?? null,
      archived_at: row.archived_at ?? null,
      child_count: row.child_count ?? 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      unfinished_count: unfinished.length,
      failed_count: failed.length,
      tested_interface_count: testedInterfaces.length,
      next_steps_excerpt: row.next_steps.slice(0, SNAPSHOT_SUMMARY_EXCERPT_LENGTH),
      has_previous_state: hasPreviousState(row)
    }
  }

  close(): void {
    this.db.close()
  }

  private mapAssetRow(row: AssetRow): AssetContext {
    const interfaces = normalizeAssetInterfaces(
      parseJsonArray<AssetInterface>(row.interfaces ?? '[]'),
      parseJsonArray<string>(row.interface_dir)
    )
    return {
      host_port: row.host_port,
      host: row.host || deriveAssetHost(row.host_port),
      project_name: row.project_name,
      tech_stack: row.tech_stack ?? '',
      auth_required: row.auth_required === 1,
      status: toAssetStatus(row.status),
      interfaces,
      interface_dir: interfaceDirFromInterfaces(interfaces),
      leaked_infos: parseLeakedInfos(row.leaked_infos),
      test_parameters: canonicalizeTestParameters(
        parseJsonArray<unknown>(row.test_parameters ?? '[]')
      ),
      related_vuln_ids: parseJsonArray<string>(row.related_vuln_ids),
      last_seen: row.last_seen
    }
  }

  private mapRow(row: VulnerabilityRow): Vulnerability {
    return {
      id: row.id,
      host: row.host,
      entry_point: row.entry_point,
      vuln_name: row.vuln_name,
      vuln_type: row.vuln_type,
      severity: toSeverity(row.severity),
      target_url: row.target_url,
      description: row.description,
      impact: row.impact,
      affected_interfaces: parseJsonArray<string>(row.affected_interfaces),
      reproduction_steps: row.reproduction_steps ?? '',
      remediation: parseJsonArray<string>(row.remediation),
      crypto_details: row.crypto_details,
      test_boundaries: row.test_boundaries,
      retest_results: parseJsonArray<RetestResult>(row.retest_results),
      related_vuln_ids: parseJsonArray<string>(row.related_vuln_ids),
      status: toStatus(row.status),
      created_at: row.created_at
    }
  }
}
