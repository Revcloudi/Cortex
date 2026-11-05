import Database from 'better-sqlite3'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  ASSET_STATUSES,
  CONFIDENCE_LEVELS,
  CREDENTIAL_STATUSES,
  CREDENTIAL_TYPES,
  DATABASE_SCHEMA_VERSION,
  DEFAULT_VULN_PAGE_SIZE,
  FOOTHOLD_ACCESS_TYPES,
  FOOTHOLD_STATUSES,
  INTERNAL_HOST_STATES,
  INTERNAL_ID_PREFIXES,
  INTERNAL_LIMITS,
  INTERNAL_SCOPE_SUMMARY_LIMIT,
  LOOT_FORMATS,
  PIVOT_KINDS,
  PIVOT_STATUSES,
  PRIVILEGE_LEVELS,
  SERVICE_STATES,
  SEVERITIES,
  SNAPSHOT_MAX_PAYLOAD_CHARS,
  SnapshotPayloadSchema,
  TestParameterCandidateSchema,
  VULN_STATUSES,
  ImportLootInputSchema,
  RecordCredentialTrialInputSchema,
  SyncInternalScopeInputSchema,
  buildCredentialSuggestions,
  buildSubnetHeatmap,
  deriveAssetHost,
  generateInternalId,
  interfaceDirFromInterfaces,
  maskSecret,
  normalizeAssetIdentifier,
  normalizeAssetInterfaces,
  normalizeEntryHostPort,
  type AssetContext,
  type AssetFilters,
  type AssetInterface,
  type AssetListItem,
  type AssetStatus,
  type AssetSyncMode,
  type ConfidenceLevel,
  type Credential,
  type CredentialInput,
  type CredentialStatus,
  type CredentialTrial,
  type CredentialType,
  type DashboardStats,
  type DatabaseInfo,
  type Foothold,
  type FootholdAccessType,
  type FootholdInput,
  type FootholdStatus,
  type ImportLootInput,
  type InternalCounts,
  type InternalEntityKind,
  type InternalGraphData,
  type InternalHost,
  type InternalHostInput,
  type InternalHostState,
  type InternalOverview,
  type InternalProjectSummary,
  type InternalScopeCounts,
  type InternalScopeSummary,
  type InternalService,
  type InternalServiceInput,
  type LeakedInfo,
  type LootFormat,
  type LootImport,
  type LootImportStatus,
  type LootImportSummary,
  type PaginatedVulnerabilities,
  type PivotHop,
  type PivotInput,
  type PivotKind,
  type PivotStatus,
  type PivotWithHops,
  type PrivilegeLevel,
  type Realm,
  type RealmFilter,
  type RecordCredentialTrialInput,
  type RetestResult,
  type ServiceState,
  type Severity,
  type SnapshotListFilters,
  type SnapshotListResult,
  type SnapshotPayload,
  type SnapshotSavePayload,
  type SnapshotSession,
  type SnapshotSummary,
  type SnapshotTestedInterface,
  type SyncInternalScopeInput,
  type SyncInternalScopeResult,
  type TestParameterCandidate,
  type VulnListQuery,
  type Vulnerability,
  type VulnerabilityListItem,
  type VulnStatus,
  type VulnSummary
} from '../../shared/types'
import { parseLootFile, type LootParseResult } from '../loot'

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

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: string }).code
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === 'SQLITE_CONSTRAINT'
  )
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
  service_host: string
  realm: string
  internal_service_id: string
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

/**
 * Trimmed vulnerability projection used only by the Memory Nebula graph builder.
 *
 * The full `vulnerabilities` rows can carry up to 500 KB of Markdown evidence per
 * row, so the graph reads a bounded preview instead of the whole archive; the
 * inspector only ever renders a short excerpt of it.
 */
export interface GraphVulnerabilityRecord {
  id: string
  host: string
  service_host: string
  /** Logical realm (`web` / `internal`); the graph builder filters on it. */
  realm: Realm
  /** Structured internal service link (empty when not normalized). */
  internal_service_id: string
  vuln_name: string
  vuln_type: string
  severity: Severity
  status: VulnStatus
  target_url: string
  created_at: string
  /** Markdown preview, already truncated to `GRAPH_REPRODUCTION_PREVIEW_CHARS`. */
  reproduction_steps: string
  related_vuln_ids: string[]
}

/** Max Markdown characters of `reproduction_steps` carried into the graph. */
export const GRAPH_REPRODUCTION_PREVIEW_CHARS = 4_000
/** Hard SQL caps mirroring `MEMORY_GRAPH_HARD_LIMITS` in `shared/graph.ts`. */
const GRAPH_MAX_HOSTS = 500
const GRAPH_MAX_VULNERABILITIES = 2_000
const GRAPH_MAX_SNAPSHOTS = 200
/** SQL caps for the internal graph projections (plan §12). */
const GRAPH_MAX_FOOTHOLDS = 300
const GRAPH_MAX_INTERNAL_HOSTS = 1_000
const GRAPH_MAX_INTERNAL_SERVICES = 3_000
const GRAPH_MAX_INTERNAL_PIVOTS = 100

/** Row shape returned by the graph-specific vulnerability query. */
interface GraphVulnerabilityRow {
  id: string
  host: string
  service_host: string
  realm: string
  internal_service_id: string
  vuln_name: string
  vuln_type: string
  severity: string
  status: string
  target_url: string
  created_at: string
  reproduction_steps: string
  related_vuln_ids: string
}

/* ------------------------------------------------- internal operation rows -- */

interface FootholdRow {
  id: string
  project_name: string
  entry_host_port: string
  entry_vuln_id: string
  access_type: string
  privilege_level: string
  status: string
  evidence: string
  notes: string
  established_at: string
  last_verified_at: string
  created_at: string
  updated_at: string
}

interface InternalHostRow {
  id: string
  project_name: string
  ip: string
  hostname: string
  os: string
  subnet: string
  state: string
  source: string
  confidence: string
  last_seen: string
  created_at: string
  updated_at: string
  service_count: number
}

interface InternalServiceRow {
  id: string
  project_name: string
  host_id: string
  port: number
  protocol: string
  service: string
  banner: string
  state: string
  source: string
  last_seen: string
  created_at: string
  updated_at: string
  host_ip: string
  host_hostname: string
}

/** Stored credential row; the raw `secret` never leaves this layer unmasked. */
interface CredentialRow {
  id: string
  project_name: string
  type: string
  username: string
  domain: string
  secret: string
  source: string
  host_id: string | null
  service_id: string | null
  confidence: string
  status: string
  notes: string
  created_at: string
  updated_at: string
}

interface PivotRow {
  id: string
  project_name: string
  foothold_id: string
  kind: string
  local_host: string
  local_port: number
  local_protocol: string
  tool: string
  status: string
  notes: string
  established_at: string
  last_verified_at: string
  created_at: string
  updated_at: string
}

interface PivotHopRow {
  pivot_id: string
  seq: number
  ref_kind: string
  ref_id: string
  label: string
  via: string
}

interface CredentialTrialRow {
  id: string
  credential_id: string
  service_id: string | null
  action: string
  status: string
  notes: string
  attempted_at: string
}

interface LootImportRow {
  id: string
  project_name: string
  entry_host_port: string
  filename: string
  sha256: string
  format: string
  parser: string
  status: string
  summary_json: string
  error: string
  created_at: string
}

/** Default cap used by the internal overview lists (plan §12). */
const INTERNAL_OVERVIEW_LIST_LIMIT = 200

const FOOTHOLD_SELECT = `
  id, project_name, entry_host_port, entry_vuln_id, access_type, privilege_level,
  status, evidence, notes, established_at, last_verified_at, created_at, updated_at
`

const INTERNAL_HOST_SELECT = `
  h.id, h.project_name, h.ip, h.hostname, h.os, h.subnet, h.state, h.source,
  h.confidence, h.last_seen, h.created_at, h.updated_at,
  (SELECT COUNT(*) FROM internal_services s WHERE s.host_id = h.id) AS service_count
`

const INTERNAL_SERVICE_SELECT = `
  s.id, s.project_name, s.host_id, s.port, s.protocol, s.service, s.banner,
  s.state, s.source, s.last_seen, s.created_at, s.updated_at,
  h.ip AS host_ip, h.hostname AS host_hostname
`

const PIVOT_SELECT = `
  id, project_name, foothold_id, kind, local_host, local_port, local_protocol,
  tool, status, notes, established_at, last_verified_at, created_at, updated_at
`

const CREDENTIAL_SELECT = `
  id, project_name, type, username, domain, secret, source, host_id, service_id,
  confidence, status, notes, created_at, updated_at
`

function toStringList<T extends readonly string[]>(
  allowed: T,
  value: string,
  fallback: T[number]
): T[number] {
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : fallback
}

function toInternalHostState(value: string): InternalHostState {
  return toStringList(INTERNAL_HOST_STATES, value, 'unknown')
}

function toServiceState(value: string): ServiceState {
  return toStringList(SERVICE_STATES, value, 'unknown')
}

function toConfidence(value: string): ConfidenceLevel {
  return toStringList(CONFIDENCE_LEVELS, value, 'medium')
}

function toCredentialType(value: string): CredentialType {
  return toStringList(CREDENTIAL_TYPES, value, 'other')
}

function toCredentialStatus(value: string): CredentialStatus {
  return toStringList(CREDENTIAL_STATUSES, value, 'untested')
}

function toCredentialTrialStatus(value: string): CredentialTrial['status'] {
  return toStringList(
    ['attempted', 'success', 'failed', 'blocked'] as const,
    value,
    'attempted'
  )
}

function toFootholdAccessType(value: string): FootholdAccessType {
  return toStringList(FOOTHOLD_ACCESS_TYPES, value, 'other')
}

function toFootholdStatus(value: string): FootholdStatus {
  return toStringList(FOOTHOLD_STATUSES, value, 'established')
}

function toPrivilegeLevel(value: string): PrivilegeLevel {
  return toStringList(PRIVILEGE_LEVELS, value, 'unknown')
}

function toPivotKind(value: string): PivotKind {
  return toStringList(PIVOT_KINDS, value, 'chain')
}

function toPivotStatus(value: string): PivotStatus {
  return toStringList(PIVOT_STATUSES, value, 'planned')
}

function toLootFormat(value: string): LootFormat {
  return toStringList(LOOT_FORMATS, value, 'unknown')
}

function toLootImportStatus(value: string): LootImportStatus {
  return toStringList(
    ['queued', 'parsed', 'needs_review', 'failed'] as const,
    value,
    'parsed'
  )
}

function emptyScopeCounts(): InternalScopeCounts {
  return { footholds: 0, hosts: 0, services: 0, credentials: 0, pivots: 0 }
}

function emptyInternalCounts(): InternalCounts {
  return {
    ...emptyScopeCounts(),
    internal_vulns: 0,
    loot_imports: 0
  }
}

function emptyEntityCounts(): Record<InternalEntityKind, number> {
  return { footholds: 0, hosts: 0, services: 0, credentials: 0, pivots: 0 }
}

function emptyEntityIdLists(): Record<InternalEntityKind, string[]> {
  return { footholds: [], hosts: [], services: [], credentials: [], pivots: [] }
}

function parseLootSummary(raw: string): LootImportSummary {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { hosts: 0, services: 0, credentials: 0, warnings: [], needs_review: 0 }
    }
    const candidate = parsed as Record<string, unknown>
    return {
      hosts: typeof candidate.hosts === 'number' ? candidate.hosts : 0,
      services: typeof candidate.services === 'number' ? candidate.services : 0,
      credentials: typeof candidate.credentials === 'number' ? candidate.credentials : 0,
      warnings: Array.isArray(candidate.warnings)
        ? candidate.warnings.filter((item): item is string => typeof item === 'string')
        : [],
      needs_review:
        typeof candidate.needs_review === 'number' ? candidate.needs_review : 0
    }
  } catch {
    return { hosts: 0, services: 0, credentials: 0, warnings: [], needs_review: 0 }
  }
}

/** `yyyyMMdd-HHmmss` stamp used for the pre-migration database backup name. */
function formatBackupStamp(now: Date): string {
  const pad = (value: number, length = 2): string => value.toString().padStart(length, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * The nine cognitive-state fields stored on one snapshot session.
 */
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
  id, host, service_host, realm, internal_service_id, entry_point, vuln_name, vuln_type,
  severity, target_url, status, created_at
`

/**
 * Explicit full-row column list (no `SELECT *`): future columns must be added
 * here deliberately, so neither the GUI nor MCP can start exposing one by
 * accident. PoC data lives in separate tables and is never joined in.
 */
const FULL_VULNERABILITY_COLUMNS = `
  id, host, service_host, realm, internal_service_id, entry_point, vuln_name, vuln_type,
  severity, target_url, description, impact, affected_interfaces, reproduction_steps,
  remediation, crypto_details, test_boundaries, retest_results, related_vuln_ids,
  status, created_at
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
export interface DatabaseServiceOptions {
  /**
   * Open the file without write access (Web UI degradation when the server has
   * no permission to write the shared database). Reads keep working; every
   * write throws SQLite's `SQLITE_READONLY`, which the caller must surface
   * clearly instead of pretending the write succeeded.
   */
  readonly?: boolean
}

export class DatabaseService {
  private readonly db: Database.Database
  readonly dbPath: string
  /** True when this instance was opened read-only (never migrates WAL/schema). */
  readonly isReadOnly: boolean
  /** Whether the database file existed before this instance opened it. */
  private readonly fileExistedBeforeOpen: boolean

  constructor(dbPath: string, options: DatabaseServiceOptions = {}) {
    this.dbPath = dbPath
    this.isReadOnly = options.readonly === true
    this.fileExistedBeforeOpen = dbPath === ':memory:' || existsSync(dbPath)
    if (dbPath !== ':memory:' && !this.isReadOnly) {
      mkdirSync(dirname(dbPath), { recursive: true })
    }
    this.db = this.isReadOnly
      ? new Database(dbPath, { readonly: true, fileMustExist: true })
      : new Database(dbPath)
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
    this.db.pragma('foreign_keys = ON')
    if (!this.isReadOnly) {
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = NORMAL')
      this.migrate()
    }
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

  /**
   * Schema migration entry point.
   *
   * The v2 → v3 upgrade is data-preserving and cannot be undone by the app, so
   * an existing database is copied first (`VACUUM INTO`, consistent even with a
   * live WAL) and the copy is never overwritten. `VACUUM` cannot run inside a
   * transaction, so the backup happens before the write transaction; the
   * migration itself stays atomic and idempotent.
   */
  private migrate(): void {
    const previousVersion = this.getSchemaVersion()
    if (
      previousVersion < DATABASE_SCHEMA_VERSION &&
      this.fileExistedBeforeOpen &&
      this.dbPath !== ':memory:'
    ) {
      this.backupBeforeMigration(previousVersion)
    }
    this.writeTransaction(() => this.migrateSchema(previousVersion))
  }

  /**
   * Copy the database next to itself as `data.db.bak-<timestamp>` before a
   * schema upgrade. An existing backup is never overwritten: a numeric suffix
   * is appended instead. A failed backup aborts the migration so existing data
   * can never be upgraded without a restore point.
   */
  private backupBeforeMigration(previousVersion: number): void {
    const stamp = formatBackupStamp(new Date())
    let target = `${this.dbPath}.bak-${stamp}`
    let suffix = 1
    while (existsSync(target)) {
      target = `${this.dbPath}.bak-${stamp}-${suffix}`
      suffix += 1
    }
    try {
      this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new DatabaseError(
        'INTERNAL',
        `数据库 schema v${previousVersion} → v${DATABASE_SCHEMA_VERSION} 迁移前备份失败（${message}），已中止迁移以保护现有数据`
      )
    }
  }

  private migrateSchema(previousVersion: number): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vulnerabilities (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        service_host TEXT NOT NULL DEFAULT '',
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

      /* --------------------------------------------------------------------- */
      /* Internal operations domain (schema v3). Everything is project-scoped   */
      /* and exists only as an internal entity, never as a top-level Web asset. */
      /* --------------------------------------------------------------------- */

      CREATE TABLE IF NOT EXISTS internal_hosts (
        id            TEXT PRIMARY KEY,
        project_name  TEXT NOT NULL,
        ip            TEXT NOT NULL,
        hostname      TEXT NOT NULL DEFAULT '',
        os            TEXT NOT NULL DEFAULT '',
        subnet        TEXT NOT NULL DEFAULT '',
        state         TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (state IN ('unknown','alive','compromised','unreachable','firewalled')),
        source        TEXT NOT NULL DEFAULT '',
        confidence    TEXT NOT NULL DEFAULT 'medium'
                      CHECK (confidence IN ('low','medium','high')),
        last_seen     TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (project_name, ip)
      );
      CREATE INDEX IF NOT EXISTS idx_internal_hosts_project ON internal_hosts (project_name);
      CREATE INDEX IF NOT EXISTS idx_internal_hosts_subnet ON internal_hosts (project_name, subnet);

      CREATE TABLE IF NOT EXISTS internal_services (
        id            TEXT PRIMARY KEY,
        project_name  TEXT NOT NULL,
        host_id       TEXT NOT NULL REFERENCES internal_hosts(id) ON DELETE CASCADE,
        port          INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        protocol      TEXT NOT NULL DEFAULT '',
        service       TEXT NOT NULL DEFAULT '',
        banner        TEXT NOT NULL DEFAULT '',
        state         TEXT NOT NULL DEFAULT 'open'
                      CHECK (state IN ('open','closed','filtered','unknown')),
        source        TEXT NOT NULL DEFAULT '',
        last_seen     TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (host_id, port, protocol)
      );
      CREATE INDEX IF NOT EXISTS idx_internal_services_project ON internal_services (project_name);
      CREATE INDEX IF NOT EXISTS idx_internal_services_host ON internal_services (host_id);

      CREATE TABLE IF NOT EXISTS footholds (
        id               TEXT PRIMARY KEY,
        project_name     TEXT NOT NULL,
        entry_host_port  TEXT NOT NULL,
        entry_vuln_id    TEXT NOT NULL DEFAULT '',
        access_type      TEXT NOT NULL
                         CHECK (access_type IN ('rce','webshell','ssrf_proxy','credential','vpn','other')),
        privilege_level  TEXT NOT NULL DEFAULT 'user'
                         CHECK (privilege_level IN ('user','admin','system','domain_admin','unknown')),
        status           TEXT NOT NULL DEFAULT 'established'
                         CHECK (status IN ('planned','established','degraded','lost')),
        evidence         TEXT NOT NULL DEFAULT '',
        notes            TEXT NOT NULL DEFAULT '',
        established_at   TEXT NOT NULL DEFAULT '',
        last_verified_at TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_footholds_project ON footholds (project_name);
      CREATE INDEX IF NOT EXISTS idx_footholds_entry ON footholds (entry_host_port);

      CREATE TABLE IF NOT EXISTS foothold_hosts (
        foothold_id      TEXT NOT NULL REFERENCES footholds(id) ON DELETE CASCADE,
        internal_host_id TEXT NOT NULL REFERENCES internal_hosts(id) ON DELETE CASCADE,
        discovered_at    TEXT NOT NULL DEFAULT '',
        notes            TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (foothold_id, internal_host_id)
      );
      CREATE INDEX IF NOT EXISTS idx_foothold_hosts_host ON foothold_hosts (internal_host_id);

      CREATE TABLE IF NOT EXISTS credentials (
        id            TEXT PRIMARY KEY,
        project_name  TEXT NOT NULL,
        type          TEXT NOT NULL
                      CHECK (type IN ('password','ntlm_hash','netntlmv2','kerberos_ticket','ssh_key','cert','api_key','other')),
        username      TEXT NOT NULL DEFAULT '',
        domain        TEXT NOT NULL DEFAULT '',
        secret        TEXT NOT NULL DEFAULT '',
        source        TEXT NOT NULL DEFAULT '',
        host_id       TEXT REFERENCES internal_hosts(id) ON DELETE SET NULL,
        service_id    TEXT REFERENCES internal_services(id) ON DELETE SET NULL,
        confidence    TEXT NOT NULL DEFAULT 'medium'
                      CHECK (confidence IN ('low','medium','high')),
        status        TEXT NOT NULL DEFAULT 'untested'
                      CHECK (status IN ('untested','valid','invalid','expired')),
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_project ON credentials (project_name);
      CREATE INDEX IF NOT EXISTS idx_credentials_host ON credentials (host_id);

      CREATE TABLE IF NOT EXISTS pivots (
        id               TEXT PRIMARY KEY,
        project_name     TEXT NOT NULL,
        foothold_id      TEXT NOT NULL REFERENCES footholds(id) ON DELETE CASCADE,
        kind             TEXT NOT NULL CHECK (kind IN ('chain','proxy')),
        local_host       TEXT NOT NULL DEFAULT '127.0.0.1',
        local_port       INTEGER NOT NULL DEFAULT 0 CHECK (local_port BETWEEN 0 AND 65535),
        local_protocol   TEXT NOT NULL DEFAULT '',
        tool             TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'planned'
                         CHECK (status IN ('planned','established','degraded','lost')),
        notes            TEXT NOT NULL DEFAULT '',
        established_at   TEXT NOT NULL DEFAULT '',
        last_verified_at TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pivots_project ON pivots (project_name);
      CREATE INDEX IF NOT EXISTS idx_pivots_foothold ON pivots (foothold_id);

      CREATE TABLE IF NOT EXISTS pivot_hops (
        pivot_id      TEXT NOT NULL REFERENCES pivots(id) ON DELETE CASCADE,
        seq           INTEGER NOT NULL CHECK (seq >= 0),
        ref_kind      TEXT NOT NULL CHECK (ref_kind IN ('internal_host','internal_service')),
        ref_id        TEXT NOT NULL,
        label         TEXT NOT NULL DEFAULT '',
        via           TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (pivot_id, seq)
      );

      CREATE TABLE IF NOT EXISTS pivot_reachability (
        pivot_id      TEXT NOT NULL REFERENCES pivots(id) ON DELETE CASCADE,
        cidr          TEXT NOT NULL,
        note          TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (pivot_id, cidr)
      );

      CREATE TABLE IF NOT EXISTS credential_trials (
        id            TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
        service_id    TEXT REFERENCES internal_services(id) ON DELETE SET NULL,
        action        TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'attempted'
                      CHECK (status IN ('attempted','success','failed','blocked')),
        notes         TEXT NOT NULL DEFAULT '',
        attempted_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_credential_trials_credential
        ON credential_trials (credential_id);

      CREATE TABLE IF NOT EXISTS loot_imports (
        id             TEXT PRIMARY KEY,
        project_name   TEXT NOT NULL,
        entry_host_port TEXT NOT NULL DEFAULT '',
        filename       TEXT NOT NULL,
        sha256         TEXT NOT NULL DEFAULT '',
        format         TEXT NOT NULL DEFAULT 'unknown',
        parser         TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'parsed'
                       CHECK (status IN ('queued','parsed','needs_review','failed')),
        summary_json   TEXT NOT NULL DEFAULT '{}',
        error          TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_loot_imports_project ON loot_imports (project_name);
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

    if (!columns.some((column) => column.name === 'service_host')) {
      this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN service_host TEXT NOT NULL DEFAULT ''")
    }

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

    /*
     * Schema v3: logical Web / internal isolation.
     *
     * - `realm` defaults to 'web' so every legacy row and every old client keeps
     *   working; rows that already carry a `service_host` are backfilled to
     *   'internal' exactly once (when upgrading from a pre-v3 schema).
     * - `internal_service_id` stays empty for legacy rows: the plan explicitly
     *   forbids guessing internal host/service entities from `service_host`, so
     *   the UI marks those rows as "待归一化" until an agent registers them.
     */
    if (!columns.some((column) => column.name === 'realm')) {
      this.db.exec(
        "ALTER TABLE vulnerabilities ADD COLUMN realm TEXT NOT NULL DEFAULT 'web' CHECK (realm IN ('web','internal'))"
      )
    }
    if (!columns.some((column) => column.name === 'internal_service_id')) {
      this.db.exec(
        "ALTER TABLE vulnerabilities ADD COLUMN internal_service_id TEXT NOT NULL DEFAULT ''"
      )
    }
    if (previousVersion < 3) {
      this.db
        .prepare("UPDATE vulnerabilities SET realm = 'internal' WHERE service_host <> '' AND realm = 'web'")
        .run()
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_vulnerabilities_realm ON vulnerabilities (realm)'
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_vulnerabilities_internal_service ON vulnerabilities (internal_service_id)'
    )

    /*
     * Schema v5: remove the abandoned Exploit-as-Code PoC tables. The retest
     * lab is being rebuilt as a raw HTTP repeater; generated JS artifacts and
     * run history are no longer part of the product. Dropping is idempotent.
     */
    this.db.exec('DROP TABLE IF EXISTS poc_runs')
    this.db.exec('DROP TABLE IF EXISTS poc_artifacts')

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

  /**
   * Create a new vulnerability with an atomically allocated id.
   *
   * The id is allocated inside the same `BEGIN IMMEDIATE` transaction as the
   * INSERT, so two MCP processes can never read the same "max id" and silently
   * overwrite each other through the old upsert path.
   */
  createVulnerability(
    payload: Omit<Vulnerability, 'id'>
  ): { vulnerability: Vulnerability; created: true } {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return this.writeTransaction(() => {
          const id = this.generateId()
          const vulnerability: Vulnerability = { ...payload, id }
          this.insertVulnerabilityOnly(vulnerability)
          return { vulnerability, created: true as const }
        })
      } catch (error) {
        // A fixed-id writer may theoretically race us; retry with a fresh id.
        if (!isUniqueConstraintError(error) || attempt === 2) throw error
      }
    }
    throw new Error('无法分配漏洞 ID，请重试')
  }

  private insertVulnerabilityOnly(vuln: Vulnerability): void {
    this.insertVulnerability(vuln, false)
  }

  private insertOrReplaceVulnerability(vuln: Vulnerability): { created: boolean } {
    const existing = this.db.prepare('SELECT 1 AS hit FROM vulnerabilities WHERE id = ?').get(vuln.id)
    const created = existing === undefined
    this.insertVulnerability(vuln, true)
    return { created }
  }

  /** Shared row mapping: `replace` adds ON CONFLICT DO UPDATE, `false` is INSERT-only. */
  private insertVulnerability(vuln: Vulnerability, replaceOnConflict: boolean): void {
    const conflictClause = replaceOnConflict
      ? `
        ON CONFLICT(id) DO UPDATE SET
          host = excluded.host,
          service_host = excluded.service_host,
          realm = excluded.realm,
          internal_service_id = excluded.internal_service_id,
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
          created_at = excluded.created_at`
      : ''

    this.db
      .prepare(
        `
        INSERT INTO vulnerabilities (
          id, host, service_host, realm, internal_service_id, entry_point, vuln_name,
          vuln_type, severity, target_url, description, impact, affected_interfaces,
          reproduction_steps, remediation, crypto_details, test_boundaries,
          retest_results, related_vuln_ids, status, created_at
        ) VALUES (
          @id, @host, @service_host, @realm, @internal_service_id, @entry_point, @vuln_name,
          @vuln_type, @severity, @target_url, @description, @impact, @affected_interfaces,
          @reproduction_steps, @remediation, @crypto_details, @test_boundaries,
          @retest_results, @related_vuln_ids, @status, @created_at
        )
        ${conflictClause}
        `
      )
      .run({
        id: vuln.id,
        host: vuln.host,
        service_host: vuln.service_host,
        realm: vuln.realm,
        internal_service_id: vuln.internal_service_id,
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
  }

  getById(id: string): Vulnerability | null {
    const row = this.db
      .prepare(`SELECT ${FULL_VULNERABILITY_COLUMNS} FROM vulnerabilities WHERE id = ?`)
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
        `(lower(host) LIKE @search
          OR lower(service_host) LIKE @search
          OR lower(vuln_name) LIKE @search
          OR lower(id) LIKE @search
          OR lower(vuln_type) LIKE @search
          OR lower(target_url) LIKE @search
          OR lower(entry_point) LIKE @search
          OR lower(description) LIKE @search
          OR lower(impact) LIKE @search
          OR lower(reproduction_steps) LIKE @search
          OR lower(crypto_details) LIKE @search
          OR lower(test_boundaries) LIKE @search
          OR lower(remediation) LIKE @search
          OR lower(affected_interfaces) LIKE @search
          OR lower(retest_results) LIKE @search
          OR lower(status) LIKE @search)`
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
    if (filters.realm !== undefined && filters.realm !== 'all') {
      clauses.push('realm = @realm')
      params.realm = filters.realm
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
        | 'service_host'
        | 'realm'
        | 'internal_service_id'
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
        service_host: row.service_host ?? '',
        realm: row.realm === 'internal' ? 'internal' : 'web',
        internal_service_id: row.internal_service_id ?? '',
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

  /**
   * Compact list for the `query_vulnerabilities` MCP tool (host mode).
   *
   * Storage keeps the caller's host verbatim, so a bare host query also
   * matches every `host:port` row for that host; a host:port query stays exact.
   * `realm` is optional and defaults to `all` (legacy behavior).
   */
  queryByHost(host: string, realm: RealmFilter = 'all'): VulnSummary[] {
    const value = host.trim()
    const hasPort = /^(?:\[[^\]]+\]:\d{1,5}|[^:]+:\d{1,5})$/.test(value)
    const realmClause = realm === 'all' ? '' : ' AND realm = @realm'
    const sql = hasPort
      ? `
        SELECT id, vuln_name, severity, target_url
        FROM vulnerabilities
        WHERE lower(host) = lower(@host)${realmClause}
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
      : `
        SELECT id, vuln_name, severity, target_url
        FROM vulnerabilities
        WHERE (lower(host) = lower(@host)
           OR (length(host) > length(@host) AND substr(lower(host), 1, length(@host) + 1) = lower(@host) || ':'))${realmClause}
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
    const params: Record<string, string> = { host: value }
    if (realm !== 'all') params.realm = realm
    const rows = this.db.prepare(sql).all(params) as SummaryRow[]

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
        "(lower(host_port) LIKE @search OR lower(host) LIKE @search OR lower(project_name) LIKE @search OR lower(COALESCE(tech_stack, '')) LIKE @search OR lower(COALESCE(interfaces, '')) LIKE @search OR lower(COALESCE(interface_dir, '')) LIKE @search OR lower(COALESCE(leaked_infos, '')) LIKE @search OR lower(COALESCE(test_parameters, '')) LIKE @search)"
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

  /**
   * Read-only asset projection for the Memory Nebula builder.
   *
   * Unlike `listAssets` (compact table rows capped at 500) this returns full
   * `AssetContext` rows including interfaces/leaks, because the graph needs those
   * to derive leak nodes and host weights. The caller bounds the row count.
   */
  listAssetsForGraph(limit: number): AssetContext[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_HOSTS))
    const rows = this.db
      .prepare(
        `SELECT * FROM assets ORDER BY last_seen DESC, host_port ASC LIMIT ?`
      )
      .all(bounded) as AssetRow[]
    return rows.map((row) => this.mapAssetRow(row))
  }

  /**
   * Read-only vulnerability projection for the Memory Nebula builder: newest
   * rows first, bounded count, and `reproduction_steps` truncated in SQL so the
   * graph payload can never explode on large evidence text.
   */
  listGraphVulnerabilities(
    limit: number,
    host?: string,
    realm: Realm = 'web'
  ): GraphVulnerabilityRecord[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_VULNERABILITIES))
    const columns = `
      id, host, service_host, realm, internal_service_id, vuln_name, vuln_type, severity,
      status, target_url, created_at, related_vuln_ids,
      substr(COALESCE(reproduction_steps, ''), 1, ${GRAPH_REPRODUCTION_PREVIEW_CHARS}) AS reproduction_steps
    `
    const rows = (
      host === undefined
        ? this.db
            .prepare(
              `SELECT ${columns} FROM vulnerabilities WHERE realm = ? ORDER BY created_at DESC, id ASC LIMIT ?`
            )
            .all(realm, bounded)
        : this.db
            .prepare(
              `SELECT ${columns} FROM vulnerabilities WHERE lower(host) = lower(?) AND realm = ? ORDER BY created_at DESC, id ASC LIMIT ?`
            )
            .all(host, realm, bounded)
    ) as GraphVulnerabilityRow[]
    return rows.map((row) => ({
      id: row.id,
      host: row.host,
      service_host: row.service_host ?? '',
      realm: row.realm === 'internal' ? 'internal' : 'web',
      internal_service_id: row.internal_service_id ?? '',
      vuln_name: row.vuln_name,
      vuln_type: row.vuln_type,
      severity: toSeverity(row.severity),
      status: toStatus(row.status),
      target_url: row.target_url,
      created_at: row.created_at,
      reproduction_steps: row.reproduction_steps ?? '',
      related_vuln_ids: parseJsonArray<string>(row.related_vuln_ids)
    }))
  }

  /** Count vulnerability rows for one realm (`all` counts both). */
  countVulnerabilities(realm: RealmFilter = 'all'): number {
    const row = (
      realm === 'all'
        ? this.db.prepare('SELECT COUNT(*) AS count FROM vulnerabilities').get()
        : this.db.prepare('SELECT COUNT(*) AS count FROM vulnerabilities WHERE realm = ?').get(realm)
    ) as { count: number }
    return row.count
  }

  /**
   * Read-only snapshot projection for the Memory Nebula builder. Passing
   * `parentSessionId` returns the direct children of a project session.
   */
  listGraphSnapshots(limit: number, parentSessionId?: string): SnapshotSession[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_SNAPSHOTS))
    const where = parentSessionId === undefined ? '' : 'WHERE s.parent_session_id = @parentSessionId'
    const params: Record<string, string | number> = { limit: bounded }
    if (parentSessionId !== undefined) params.parentSessionId = parentSessionId
    const rows = this.db
      .prepare(
        `
        SELECT ${SNAPSHOT_SELECT_COLUMNS}
        FROM snapshot_sessions s
        ${where}
        ORDER BY s.updated_at DESC, s.session_id DESC
        LIMIT @limit
        `
      )
      .all(params) as SnapshotSessionRow[]
    return rows.map((row) => this.mapSnapshotRow(row))
  }

  /** Total snapshot session rows (for `meta.truncated` on the graph). */
  countSnapshotSessions(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM snapshot_sessions').get() as {
      total: number
    }
    return row.total
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
        | 'service_host'
        | 'realm'
        | 'internal_service_id'
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
      service_host: row.service_host ?? '',
      realm: row.realm === 'internal' ? 'internal' : 'web',
      internal_service_id: row.internal_service_id ?? '',
      entry_point: row.entry_point,
      vuln_name: row.vuln_name,
      vuln_type: row.vuln_type,
      severity: toSeverity(row.severity),
      target_url: row.target_url,
      status: toStatus(row.status),
      created_at: row.created_at
    }))
  }

  /**
   * Dashboard counters. `query.realm` scopes the main counters (the Web tab asks
   * for `web`, the internal board for `internal`); `internal` always reports the
   * internal-realm snapshot so the Web tab can show the cross-domain badge.
   */
  getStats(query: { realm?: RealmFilter } = {}): DashboardStats {
    const realm = query.realm ?? 'all'
    const realmClause = realm === 'all' ? '' : 'WHERE realm = @realm'
    const realmParams = realm === 'all' ? undefined : { realm }
    const runWithRealm = <T>(statement: string, params?: Record<string, string>): T => {
      const prepared = this.db.prepare(statement)
      return (params === undefined ? prepared.get() : prepared.get(params)) as T
    }

    const totals = runWithRealm<{
      total: number | null
      hosts: number | null
      critical: number | null
      high: number | null
      today: number | null
    }>(
      `
        SELECT
          COUNT(*) AS total,
          COUNT(DISTINCT host) AS hosts,
          SUM(CASE WHEN severity = 'Critical' THEN 1 ELSE 0 END) AS critical,
          SUM(CASE WHEN severity = 'High' THEN 1 ELSE 0 END) AS high,
          SUM(CASE WHEN date(created_at, 'localtime') = date('now', 'localtime') THEN 1 ELSE 0 END) AS today
        FROM vulnerabilities ${realmClause}
        `,
      realmParams
    )

    const severityStatement = this.db.prepare(
      `SELECT severity, COUNT(*) AS count FROM vulnerabilities ${realmClause} GROUP BY severity`
    )
    const severityRows = (
      realmParams === undefined ? severityStatement.all() : severityStatement.all(realmParams)
    ) as Array<{ severity: string; count: number }>
    const statusStatement = this.db.prepare(
      `SELECT status, COUNT(*) AS count FROM vulnerabilities ${realmClause} GROUP BY status`
    )
    const statusRows = (
      realmParams === undefined ? statusStatement.all() : statusStatement.all(realmParams)
    ) as Array<{ status: string; count: number }>

    const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as SeverityMap
    for (const row of severityRows) {
      bySeverity[toSeverity(row.severity)] = row.count
    }
    const byStatus = Object.fromEntries(VULN_STATUSES.map((status) => [status, 0])) as StatusMap
    for (const row of statusRows) {
      byStatus[toStatus(row.status)] = row.count
    }

    const internalTotals = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS total,
          COUNT(DISTINCT host) AS hosts,
          SUM(CASE WHEN severity = 'Critical' THEN 1 ELSE 0 END) AS critical,
          SUM(CASE WHEN severity = 'High' THEN 1 ELSE 0 END) AS high
        FROM vulnerabilities WHERE realm = 'internal'
        `
      )
      .get() as {
      total: number | null
      hosts: number | null
      critical: number | null
      high: number | null
    }

    return {
      total: totals.total ?? 0,
      critical: totals.critical ?? 0,
      high: totals.high ?? 0,
      hosts: totals.hosts ?? 0,
      today: totals.today ?? 0,
      bySeverity,
      byStatus,
      internal: {
        total: internalTotals.total ?? 0,
        critical: internalTotals.critical ?? 0,
        high: internalTotals.high ?? 0,
        hosts: internalTotals.hosts ?? 0
      }
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
    let sessionId = ''
    const timestamp = now.toISOString()
    this.writeTransaction((): void => {
      // Allocate inside the IMMEDIATE transaction so concurrent processes
      // cannot both read the same latest session id.
      sessionId = this.generateSnapshotSessionId(now)
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

  /* --------------------------------------------------------------------- */
  /*  Internal operations domain (Plan B)                                  */
  /*                                                                       */
  /*  Every write runs inside one `BEGIN IMMEDIATE` transaction. Public     */
  /*  read projections clamp row counts and report `truncated` instead of    */
  /*  silently dropping data; raw credential secrets never leave this layer  */
  /*  (every returned Credential carries a masked preview only).            */
  /* --------------------------------------------------------------------- */

  /**
   * Upsert footholds / internal hosts / services / credentials / pivots for one
   * project in a single transaction.
   *
   * - `merge` (default): upsert by id, natural-key upsert when no id is given,
   *   never deletes.
   * - `replace`: only the entity arrays present in the payload are replaced
   *   (rows absent from that array are deleted); omitted arrays stay untouched.
   * - `removed`: explicit deletion lists, always honored.
   */
  syncInternalScope(input: SyncInternalScopeInput): SyncInternalScopeResult {
    // Re-validate at the storage boundary: defaults are applied here even when a
    // script/CLI calls the service directly instead of going through MCP.
    const parsed = SyncInternalScopeInputSchema.safeParse(input)
    if (!parsed.success) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `sync_internal_scope 参数校验失败: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      )
    }
    return this.writeTransaction(() => this.syncInternalScopeInternal(parsed.data))
  }

  private syncInternalScopeInternal(input: SyncInternalScopeInput): SyncInternalScopeResult {
    const project = input.project_name.trim()
    if (project.length === 0) {
      throw new DatabaseError('INVALID_INPUT', 'project_name 不能为空')
    }
    const mode = input.mode
    const nowIso = new Date().toISOString()
    const warnings: string[] = []
    const created = emptyEntityCounts()
    const updated = emptyEntityCounts()
    const ids = emptyEntityIdLists()
    const keep: Record<InternalEntityKind, Set<string>> = {
      footholds: new Set(),
      hosts: new Set(),
      services: new Set(),
      credentials: new Set(),
      pivots: new Set()
    }

    // Hosts first: services and foothold reachability reference their ids.
    if (input.hosts !== undefined) {
      for (const host of input.hosts) {
        const result = this.upsertInternalHostRow(project, host, nowIso, warnings)
        if (result.created) created.hosts += 1
        else updated.hosts += 1
        ids.hosts.push(result.host.id)
        keep.hosts.add(result.host.id)
      }
    }

    if (input.services !== undefined) {
      for (const service of input.services) {
        const host = this.getInternalHostRowById(service.host_id)
        if (host === undefined || host.project_name !== project) {
          throw new DatabaseError(
            'INVALID_INPUT',
            `内网服务引用失败：host_id ${service.host_id} 不存在于项目「${project}」。请先提交 hosts，并在下一次调用（或同一次调用中先列出 hosts id）复用返回的 IH- id`
          )
        }
        const result = this.upsertInternalServiceRow(project, service, nowIso, warnings)
        if (result.created) created.services += 1
        else updated.services += 1
        ids.services.push(result.service.id)
        keep.services.add(result.service.id)
      }
    }

    if (input.footholds !== undefined) {
      for (const foothold of input.footholds) {
        const result = this.upsertFootholdRow(project, foothold, mode, nowIso, warnings)
        if (result.created) created.footholds += 1
        else updated.footholds += 1
        ids.footholds.push(result.foothold.id)
        keep.footholds.add(result.foothold.id)
      }
    }

    if (input.credentials !== undefined) {
      for (const credential of input.credentials) {
        const result = this.upsertCredentialRow(project, credential, nowIso, warnings)
        if (result.created) created.credentials += 1
        else updated.credentials += 1
        ids.credentials.push(result.credential.id)
        keep.credentials.add(result.credential.id)
      }
    }

    if (input.pivots !== undefined) {
      for (const pivot of input.pivots) {
        const result = this.upsertPivotRow(project, pivot, nowIso, warnings)
        if (result.created) created.pivots += 1
        else updated.pivots += 1
        ids.pivots.push(result.pivot.id)
        keep.pivots.add(result.pivot.id)
      }
    }

    // Replace-mode cleanup, dependency-safe order (children first).
    if (mode === 'replace') {
      if (input.pivots !== undefined) this.deleteInternalRowsNotIn('pivots', project, keep.pivots)
      if (input.credentials !== undefined) {
        this.deleteInternalRowsNotIn('credentials', project, keep.credentials)
      }
      if (input.services !== undefined) {
        this.deleteInternalRowsNotIn('internal_services', project, keep.services)
      }
      if (input.footholds !== undefined) {
        this.deleteInternalRowsNotIn('footholds', project, keep.footholds)
      }
      if (input.hosts !== undefined) {
        this.deleteInternalRowsNotIn('internal_hosts', project, keep.hosts)
      }
    }

    if (input.removed !== undefined) {
      for (const id of input.removed.pivot_ids) {
        this.removeInternalRowById('pivots', project, id, 'pivot', warnings)
      }
      for (const id of input.removed.credential_ids) {
        this.removeInternalRowById('credentials', project, id, '凭据', warnings)
      }
      for (const id of input.removed.service_ids) {
        this.removeInternalRowById('internal_services', project, id, '内网服务', warnings)
      }
      for (const id of input.removed.foothold_ids) {
        this.removeInternalRowById('footholds', project, id, 'foothold', warnings)
      }
      for (const id of input.removed.host_ids) {
        this.removeInternalRowById('internal_hosts', project, id, '内网主机', warnings)
      }
    }

    return { project_name: project, created, updated, ids, warnings }
  }

  /** Delete every row of one internal table in a project that is not in `keepIds`. */
  private deleteInternalRowsNotIn(
    tableName: 'pivots' | 'credentials' | 'internal_services' | 'footholds' | 'internal_hosts',
    project: string,
    keepIds: ReadonlySet<string>
  ): number {
    const rows = this.db
      .prepare(`SELECT id FROM ${tableName} WHERE project_name = ?`)
      .all(project) as Array<{ id: string }>
    const remove = this.db.prepare(`DELETE FROM ${tableName} WHERE id = ?`)
    let removed = 0
    for (const row of rows) {
      if (keepIds.has(row.id)) continue
      removed += remove.run(row.id).changes
    }
    return removed
  }

  /** Delete one explicitly removed internal row (cross-project ids are rejected). */
  private removeInternalRowById(
    tableName: 'pivots' | 'credentials' | 'internal_services' | 'footholds' | 'internal_hosts',
    project: string,
    id: string,
    label: string,
    warnings: string[]
  ): void {
    const row = this.db
      .prepare(`SELECT project_name FROM ${tableName} WHERE id = ?`)
      .get(id) as { project_name: string } | undefined
    if (row === undefined) {
      warnings.push(`${label} ${id} 不存在，已跳过删除`)
      return
    }
    if (row.project_name !== project) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `${label} ${id} 属于其他项目（${row.project_name}），不能通过项目「${project}」删除`
      )
    }
    this.db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id)
  }

  /* -------------------------------------------------------- internal rows -- */

  private getInternalHostRowById(id: string): InternalHostRow | undefined {
    return this.db
      .prepare(`SELECT ${INTERNAL_HOST_SELECT} FROM internal_hosts h WHERE h.id = ?`)
      .get(id) as InternalHostRow | undefined
  }

  private findInternalHostRow(project: string, ip: string): InternalHostRow | undefined {
    return this.db
      .prepare(
        `SELECT ${INTERNAL_HOST_SELECT} FROM internal_hosts h WHERE h.project_name = ? AND h.ip = ?`
      )
      .get(project, ip) as InternalHostRow | undefined
  }

  private upsertInternalHostRow(
    project: string,
    input: InternalHostInput,
    nowIso: string,
    warnings: string[]
  ): { host: InternalHost; created: boolean } {
    let existing: InternalHostRow | undefined
    if (input.id !== undefined) {
      existing = this.getInternalHostRowById(input.id)
      if (existing !== undefined && existing.project_name !== project) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `内网主机 ${input.id} 属于其他项目（${existing.project_name}），不能写入项目「${project}」`
        )
      }
    }
    if (existing === undefined) {
      const natural = this.findInternalHostRow(project, input.ip)
      if (natural !== undefined) {
        existing = natural
        if (input.id !== undefined && input.id !== natural.id) {
          warnings.push(`内网主机 ${input.ip} 已存在（${natural.id}），本次 id ${input.id} 被忽略`)
        }
      }
    }

    if (existing !== undefined) {
      if (input.ip !== existing.ip) {
        const conflict = this.findInternalHostRow(project, input.ip)
        if (conflict !== undefined && conflict.id !== existing.id) {
          throw new DatabaseError(
            'INVALID_INPUT',
            `项目「${project}」已存在 IP ${input.ip} 的内网主机（${conflict.id}），同一 IP 只能有一条主机记录`
          )
        }
      }
      this.db
        .prepare(
          `UPDATE internal_hosts SET ip = @ip, hostname = @hostname, os = @os, subnet = @subnet,
             state = @state, source = @source, confidence = @confidence, last_seen = @last_seen,
             updated_at = @updated_at WHERE id = @id`
        )
        .run({
          id: existing.id,
          ip: input.ip,
          hostname: input.hostname,
          os: input.os,
          subnet: input.subnet,
          state: input.state,
          source: input.source,
          confidence: input.confidence,
          last_seen: input.last_seen.length > 0 ? input.last_seen : nowIso,
          updated_at: nowIso
        })
      const row = this.getInternalHostRowById(existing.id)
      if (row === undefined) throw new DatabaseError('INTERNAL', `更新后无法读取内网主机 ${existing.id}`)
      return { host: this.mapInternalHostRow(row), created: false }
    }

    const id = input.id ?? generateInternalId(INTERNAL_ID_PREFIXES.internalHost)
    this.db
      .prepare(
        `INSERT INTO internal_hosts (
           id, project_name, ip, hostname, os, subnet, state, source, confidence,
           last_seen, created_at, updated_at
         ) VALUES (
           @id, @project_name, @ip, @hostname, @os, @subnet, @state, @source, @confidence,
           @last_seen, @created_at, @updated_at
         )`
      )
      .run({
        id,
        project_name: project,
        ip: input.ip,
        hostname: input.hostname,
        os: input.os,
        subnet: input.subnet,
        state: input.state,
        source: input.source,
        confidence: input.confidence,
        last_seen: input.last_seen.length > 0 ? input.last_seen : nowIso,
        created_at: nowIso,
        updated_at: nowIso
      })
    const row = this.getInternalHostRowById(id)
    if (row === undefined) throw new DatabaseError('INTERNAL', `写入后无法读取内网主机 ${id}`)
    return { host: this.mapInternalHostRow(row), created: true }
  }

  private getInternalServiceRowById(id: string): InternalServiceRow | undefined {
    return this.db
      .prepare(
        `SELECT ${INTERNAL_SERVICE_SELECT} FROM internal_services s
         JOIN internal_hosts h ON h.id = s.host_id WHERE s.id = ?`
      )
      .get(id) as InternalServiceRow | undefined
  }

  private findInternalServiceRow(
    hostId: string,
    port: number,
    protocol: string
  ): InternalServiceRow | undefined {
    return this.db
      .prepare(
        `SELECT ${INTERNAL_SERVICE_SELECT} FROM internal_services s
         JOIN internal_hosts h ON h.id = s.host_id
         WHERE s.host_id = ? AND s.port = ? AND s.protocol = ?`
      )
      .get(hostId, port, protocol) as InternalServiceRow | undefined
  }

  private upsertInternalServiceRow(
    project: string,
    input: InternalServiceInput,
    nowIso: string,
    warnings: string[]
  ): { service: InternalService; created: boolean } {
    let existing: InternalServiceRow | undefined
    if (input.id !== undefined) {
      existing = this.getInternalServiceRowById(input.id)
      if (existing !== undefined && existing.project_name !== project) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `内网服务 ${input.id} 属于其他项目（${existing.project_name}），不能写入项目「${project}」`
        )
      }
    }
    if (existing === undefined) {
      const natural = this.findInternalServiceRow(input.host_id, input.port, input.protocol)
      if (natural !== undefined) {
        existing = natural
        if (input.id !== undefined && input.id !== natural.id) {
          warnings.push(
            `内网服务 ${input.host_id}:${input.port}/${input.protocol} 已存在（${natural.id}），本次 id ${input.id} 被忽略`
          )
        }
      }
    }

    if (existing !== undefined) {
      this.db
        .prepare(
          `UPDATE internal_services SET port = @port, protocol = @protocol, service = @service,
             banner = @banner, state = @state, source = @source, last_seen = @last_seen,
             updated_at = @updated_at WHERE id = @id`
        )
        .run({
          id: existing.id,
          port: input.port,
          protocol: input.protocol,
          service: input.service,
          banner: input.banner,
          state: input.state,
          source: input.source,
          last_seen: nowIso,
          updated_at: nowIso
        })
      const row = this.getInternalServiceRowById(existing.id)
      if (row === undefined) throw new DatabaseError('INTERNAL', `更新后无法读取内网服务 ${existing.id}`)
      return { service: this.mapInternalServiceRow(row), created: false }
    }

    const id = input.id ?? generateInternalId(INTERNAL_ID_PREFIXES.internalService)
    this.db
      .prepare(
        `INSERT INTO internal_services (
           id, project_name, host_id, port, protocol, service, banner, state, source,
           last_seen, created_at, updated_at
         ) VALUES (
           @id, @project_name, @host_id, @port, @protocol, @service, @banner, @state, @source,
           @last_seen, @created_at, @updated_at
         )`
      )
      .run({
        id,
        project_name: project,
        host_id: input.host_id,
        port: input.port,
        protocol: input.protocol,
        service: input.service,
        banner: input.banner,
        state: input.state,
        source: input.source,
        last_seen: nowIso,
        created_at: nowIso,
        updated_at: nowIso
      })
    const row = this.getInternalServiceRowById(id)
    if (row === undefined) throw new DatabaseError('INTERNAL', `写入后无法读取内网服务 ${id}`)
    return { service: this.mapInternalServiceRow(row), created: true }
  }

  private getFootholdRowById(id: string): FootholdRow | undefined {
    return this.db
      .prepare(`SELECT ${FOOTHOLD_SELECT} FROM footholds WHERE id = ?`)
      .get(id) as FootholdRow | undefined
  }

  /** Resolve an entry host_port to an existing Web asset (exact, then bare host). */
  private findAssetForEntry(entryHostPort: string): AssetContext | null {
    const direct = this.getAssetDetail(entryHostPort)
    if (direct !== null) return direct
    const bareHost = deriveAssetHost(entryHostPort)
    if (bareHost.length === 0) return null
    const row = this.db
      .prepare('SELECT * FROM assets WHERE lower(host) = lower(?) ORDER BY last_seen DESC LIMIT 1')
      .get(bareHost) as AssetRow | undefined
    return row === undefined ? null : this.mapAssetRow(row)
  }

  private upsertFootholdRow(
    project: string,
    input: FootholdInput,
    mode: 'merge' | 'replace',
    nowIso: string,
    warnings: string[]
  ): { foothold: Foothold; created: boolean } {
    const entryHostPort = normalizeEntryHostPort(input.entry_host_port)
    const asset = this.findAssetForEntry(entryHostPort)
    if (asset === null) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `入口 Web 资产「${input.entry_host_port}」不存在：请先调用 sync_asset_info 登记该资产，再登记 foothold`
      )
    }
    if (asset.project_name !== project) {
      warnings.push(
        `入口资产「${asset.host_port}」属于项目「${asset.project_name}」，与本次 project_name「${project}」不一致（按请求项目记录）`
      )
    }
    if (input.entry_vuln_id.length > 0 && this.getById(input.entry_vuln_id) === null) {
      warnings.push(`入口漏洞 ${input.entry_vuln_id} 尚未入库，foothold 已按给定的 id 记录`)
    }
    for (const hostId of input.host_ids) {
      const host = this.getInternalHostRowById(hostId)
      if (host === undefined || host.project_name !== project) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `foothold 可达主机 ${hostId} 不存在于项目「${project}」；请先提交 hosts 再关联 host_ids`
        )
      }
    }

    let existing = input.id !== undefined ? this.getFootholdRowById(input.id) : undefined
    if (existing !== undefined && existing.project_name !== project) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `foothold ${input.id} 属于其他项目（${existing.project_name}），不能写入项目「${project}」`
      )
    }
    if (existing === undefined) {
      const natural = this.db
        .prepare(
          `SELECT ${FOOTHOLD_SELECT} FROM footholds
           WHERE project_name = ? AND lower(entry_host_port) = lower(?) AND access_type = ?`
        )
        .get(project, entryHostPort, input.access_type) as FootholdRow | undefined
      if (natural !== undefined) {
        existing = natural
        if (input.id !== undefined && input.id !== natural.id) {
          warnings.push(`该入口资产已存在同类 foothold（${natural.id}），本次 id ${input.id} 被忽略`)
        }
      }
    }

    const establishedAt =
      input.established_at.length > 0
        ? input.established_at
        : existing !== undefined && existing.established_at.length > 0
          ? existing.established_at
          : nowIso

    let footholdId: string
    let created: boolean
    if (existing !== undefined) {
      footholdId = existing.id
      created = false
      this.db
        .prepare(
          `UPDATE footholds SET entry_host_port = @entry_host_port, entry_vuln_id = @entry_vuln_id,
             access_type = @access_type, privilege_level = @privilege_level, status = @status,
             evidence = @evidence, notes = @notes, established_at = @established_at,
             last_verified_at = @last_verified_at, updated_at = @updated_at WHERE id = @id`
        )
        .run({
          id: footholdId,
          entry_host_port: entryHostPort,
          entry_vuln_id: input.entry_vuln_id,
          access_type: input.access_type,
          privilege_level: input.privilege_level,
          status: input.status,
          evidence: input.evidence,
          notes: input.notes,
          established_at: establishedAt,
          last_verified_at: nowIso,
          updated_at: nowIso
        })
    } else {
      footholdId = input.id ?? generateInternalId(INTERNAL_ID_PREFIXES.foothold)
      created = true
      this.db
        .prepare(
          `INSERT INTO footholds (
             id, project_name, entry_host_port, entry_vuln_id, access_type, privilege_level,
             status, evidence, notes, established_at, last_verified_at, created_at, updated_at
           ) VALUES (
             @id, @project_name, @entry_host_port, @entry_vuln_id, @access_type, @privilege_level,
             @status, @evidence, @notes, @established_at, @last_verified_at, @created_at, @updated_at
           )`
        )
        .run({
          id: footholdId,
          project_name: project,
          entry_host_port: entryHostPort,
          entry_vuln_id: input.entry_vuln_id,
          access_type: input.access_type,
          privilege_level: input.privilege_level,
          status: input.status,
          evidence: input.evidence,
          notes: input.notes,
          established_at: establishedAt,
          last_verified_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso
        })
    }

    // Reachability join table: merge unions, replace is authoritative.
    const link = this.db.prepare(
      `INSERT OR IGNORE INTO foothold_hosts (foothold_id, internal_host_id, discovered_at, notes)
       VALUES (?, ?, ?, '')`
    )
    if (mode === 'replace') {
      this.db.prepare('DELETE FROM foothold_hosts WHERE foothold_id = ?').run(footholdId)
    }
    for (const hostId of input.host_ids) link.run(footholdId, hostId, nowIso)

    const row = this.getFootholdRowById(footholdId)
    if (row === undefined) throw new DatabaseError('INTERNAL', `写入后无法读取 foothold ${footholdId}`)
    const hostIds = this.loadFootholdHostIds([footholdId]).get(footholdId) ?? []
    return { foothold: this.mapFootholdRow(row, hostIds), created }
  }

  private getCredentialRowById(id: string): CredentialRow | undefined {
    return this.db
      .prepare(`SELECT ${CREDENTIAL_SELECT} FROM credentials WHERE id = ?`)
      .get(id) as CredentialRow | undefined
  }

  private upsertCredentialRow(
    project: string,
    input: CredentialInput,
    nowIso: string,
    warnings: string[]
  ): { credential: Credential; created: boolean } {
    if (input.host_id !== undefined && input.host_id.length > 0) {
      const host = this.getInternalHostRowById(input.host_id)
      if (host === undefined || host.project_name !== project) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `凭据引用失败：host_id ${input.host_id} 不存在于项目「${project}」`
        )
      }
    }
    if (input.service_id !== undefined && input.service_id.length > 0) {
      const service = this.getInternalServiceRowById(input.service_id)
      if (service === undefined || service.project_name !== project) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `凭据引用失败：service_id ${input.service_id} 不存在于项目「${project}」`
        )
      }
    }

    const hostId = input.host_id !== undefined && input.host_id.length > 0 ? input.host_id : null
    const serviceId =
      input.service_id !== undefined && input.service_id.length > 0 ? input.service_id : null

    let existing = input.id !== undefined ? this.getCredentialRowById(input.id) : undefined
    if (existing !== undefined && existing.project_name !== project) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `凭据 ${input.id} 属于其他项目（${existing.project_name}），不能写入项目「${project}」`
      )
    }
    if (existing === undefined) {
      const natural = this.db
        .prepare(
          `SELECT ${CREDENTIAL_SELECT} FROM credentials
           WHERE project_name = ? AND type = ? AND username = ? AND domain = ? AND secret = ?`
        )
        .get(project, input.type, input.username, input.domain, input.secret) as
        | CredentialRow
        | undefined
      if (natural !== undefined) {
        existing = natural
        if (input.id !== undefined && input.id !== natural.id) {
          warnings.push(`相同凭据已存在（${natural.id}），本次 id ${input.id} 被忽略`)
        }
      }
    }

    if (existing !== undefined) {
      this.db
        .prepare(
          `UPDATE credentials SET type = @type, username = @username, domain = @domain,
             secret = @secret, source = @source, host_id = @host_id, service_id = @service_id,
             confidence = @confidence, status = @status, notes = @notes, updated_at = @updated_at
           WHERE id = @id`
        )
        .run({
          id: existing.id,
          type: input.type,
          username: input.username,
          domain: input.domain,
          secret: input.secret,
          source: input.source,
          host_id: hostId,
          service_id: serviceId,
          confidence: input.confidence,
          status: input.status,
          notes: input.notes,
          updated_at: nowIso
        })
      const row = this.getCredentialRowById(existing.id)
      if (row === undefined) throw new DatabaseError('INTERNAL', `更新后无法读取凭据 ${existing.id}`)
      return { credential: this.mapCredentialRow(row), created: false }
    }

    const id = input.id ?? generateInternalId(INTERNAL_ID_PREFIXES.credential)
    this.db
      .prepare(
        `INSERT INTO credentials (
           id, project_name, type, username, domain, secret, source, host_id, service_id,
           confidence, status, notes, created_at, updated_at
         ) VALUES (
           @id, @project_name, @type, @username, @domain, @secret, @source, @host_id, @service_id,
           @confidence, @status, @notes, @created_at, @updated_at
         )`
      )
      .run({
        id,
        project_name: project,
        type: input.type,
        username: input.username,
        domain: input.domain,
        secret: input.secret,
        source: input.source,
        host_id: hostId,
        service_id: serviceId,
        confidence: input.confidence,
        status: input.status,
        notes: input.notes,
        created_at: nowIso,
        updated_at: nowIso
      })
    const row = this.getCredentialRowById(id)
    if (row === undefined) throw new DatabaseError('INTERNAL', `写入后无法读取凭据 ${id}`)
    return { credential: this.mapCredentialRow(row), created: true }
  }

  private getPivotRowById(id: string): PivotRow | undefined {
    return this.db
      .prepare(`SELECT ${PIVOT_SELECT} FROM pivots WHERE id = ?`)
      .get(id) as PivotRow | undefined
  }

  private loadPivotHops(pivotIds: readonly string[]): Map<string, PivotHop[]> {
    const result = new Map<string, PivotHop[]>()
    if (pivotIds.length === 0) return result
    const placeholders = pivotIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT pivot_id, seq, ref_kind, ref_id, label, via FROM pivot_hops
         WHERE pivot_id IN (${placeholders}) ORDER BY pivot_id ASC, seq ASC`
      )
      .all(...pivotIds) as PivotHopRow[]
    for (const row of rows) {
      const bucket = result.get(row.pivot_id)
      const hop: PivotHop = {
        seq: row.seq,
        ref_kind: row.ref_kind === 'internal_service' ? 'internal_service' : 'internal_host',
        ref_id: row.ref_id,
        label: row.label,
        via: row.via
      }
      if (bucket === undefined) result.set(row.pivot_id, [hop])
      else bucket.push(hop)
    }
    return result
  }

  private loadPivotReachability(pivotIds: readonly string[]): Map<string, string[]> {
    const result = new Map<string, string[]>()
    if (pivotIds.length === 0) return result
    const placeholders = pivotIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT pivot_id, cidr FROM pivot_reachability
         WHERE pivot_id IN (${placeholders}) ORDER BY pivot_id ASC, cidr ASC`
      )
      .all(...pivotIds) as Array<{ pivot_id: string; cidr: string }>
    for (const row of rows) {
      const bucket = result.get(row.pivot_id)
      if (bucket === undefined) result.set(row.pivot_id, [row.cidr])
      else bucket.push(row.cidr)
    }
    return result
  }

  private upsertPivotRow(
    project: string,
    input: PivotInput,
    nowIso: string,
    warnings: string[]
  ): { pivot: PivotWithHops; created: boolean } {
    const foothold = this.getFootholdRowById(input.foothold_id)
    if (foothold === undefined || foothold.project_name !== project) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `pivot 引用失败：foothold_id ${input.foothold_id} 不存在于项目「${project}」；请先登记 foothold`
      )
    }
    for (const hop of input.hops) {
      const valid =
        hop.ref_kind === 'internal_host'
          ? this.getInternalHostRowById(hop.ref_id)
          : this.getInternalServiceRowById(hop.ref_id)
      const hopProject = valid as { project_name: string } | undefined
      if (hopProject === undefined || hopProject.project_name !== project) {
        throw new DatabaseError(
          'INVALID_INPUT',
          `pivot hop 引用失败：${hop.ref_kind} ${hop.ref_id} 不存在于项目「${project}」`
        )
      }
    }

    let existing = input.id !== undefined ? this.getPivotRowById(input.id) : undefined
    if (existing !== undefined && existing.project_name !== project) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `pivot ${input.id} 属于其他项目（${existing.project_name}），不能写入项目「${project}」`
      )
    }
    if (existing === undefined) {
      const natural = this.db
        .prepare(
          `SELECT ${PIVOT_SELECT} FROM pivots
           WHERE foothold_id = ? AND kind = ? AND local_host = ? AND local_port = ?`
        )
        .get(
          input.foothold_id,
          input.kind,
          input.local_endpoint.host,
          input.local_endpoint.port
        ) as PivotRow | undefined
      if (natural !== undefined) {
        existing = natural
        if (input.id !== undefined && input.id !== natural.id) {
          warnings.push(`相同 pivot 已存在（${natural.id}），本次 id ${input.id} 被忽略`)
        }
      }
    }

    const establishedAt =
      existing !== undefined && existing.established_at.length > 0
        ? existing.established_at
        : input.status === 'established'
          ? nowIso
          : ''

    let pivotId: string
    let created: boolean
    if (existing !== undefined) {
      pivotId = existing.id
      created = false
      this.db
        .prepare(
          `UPDATE pivots SET foothold_id = @foothold_id, kind = @kind, local_host = @local_host,
             local_port = @local_port, local_protocol = @local_protocol, tool = @tool,
             status = @status, notes = @notes, established_at = @established_at,
             last_verified_at = @last_verified_at, updated_at = @updated_at WHERE id = @id`
        )
        .run({
          id: pivotId,
          foothold_id: input.foothold_id,
          kind: input.kind,
          local_host: input.local_endpoint.host,
          local_port: input.local_endpoint.port,
          local_protocol: input.local_endpoint.protocol,
          tool: input.tool,
          status: input.status,
          notes: input.notes,
          established_at: establishedAt,
          last_verified_at: nowIso,
          updated_at: nowIso
        })
    } else {
      pivotId = input.id ?? generateInternalId(INTERNAL_ID_PREFIXES.pivot)
      created = true
      this.db
        .prepare(
          `INSERT INTO pivots (
             id, project_name, foothold_id, kind, local_host, local_port, local_protocol,
             tool, status, notes, established_at, last_verified_at, created_at, updated_at
           ) VALUES (
             @id, @project_name, @foothold_id, @kind, @local_host, @local_port, @local_protocol,
             @tool, @status, @notes, @established_at, @last_verified_at, @created_at, @updated_at
           )`
        )
        .run({
          id: pivotId,
          project_name: project,
          foothold_id: input.foothold_id,
          kind: input.kind,
          local_host: input.local_endpoint.host,
          local_port: input.local_endpoint.port,
          local_protocol: input.local_endpoint.protocol,
          tool: input.tool,
          status: input.status,
          notes: input.notes,
          established_at: establishedAt,
          last_verified_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso
        })
    }

    this.db.prepare('DELETE FROM pivot_hops WHERE pivot_id = ?').run(pivotId)
    const insertHop = this.db.prepare(
      `INSERT INTO pivot_hops (pivot_id, seq, ref_kind, ref_id, label, via)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    input.hops.forEach((hop, index) => {
      insertHop.run(pivotId, index, hop.ref_kind, hop.ref_id, hop.label, hop.via)
    })
    this.db.prepare('DELETE FROM pivot_reachability WHERE pivot_id = ?').run(pivotId)
    const insertSubnet = this.db.prepare(
      'INSERT OR IGNORE INTO pivot_reachability (pivot_id, cidr, note) VALUES (?, ?, ?)'
    )
    for (const subnet of new Set(input.reachable_subnets)) {
      insertSubnet.run(pivotId, subnet, '')
    }

    const row = this.getPivotRowById(pivotId)
    if (row === undefined) throw new DatabaseError('INTERNAL', `写入后无法读取 pivot ${pivotId}`)
    const hops = this.loadPivotHops([pivotId]).get(pivotId) ?? []
    const subnets = this.loadPivotReachability([pivotId]).get(pivotId) ?? []
    return { pivot: this.mapPivotRow(row, hops, subnets), created }
  }

  /* --------------------------------------------------------- read helpers -- */

  private loadFootholdHostIds(footholdIds: readonly string[]): Map<string, string[]> {
    const result = new Map<string, string[]>()
    if (footholdIds.length === 0) return result
    const placeholders = footholdIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT foothold_id, internal_host_id FROM foothold_hosts
         WHERE foothold_id IN (${placeholders})
         ORDER BY foothold_id ASC, discovered_at ASC, internal_host_id ASC`
      )
      .all(...footholdIds) as Array<{ foothold_id: string; internal_host_id: string }>
    for (const row of rows) {
      const bucket = result.get(row.foothold_id)
      if (bucket === undefined) result.set(row.foothold_id, [row.internal_host_id])
      else bucket.push(row.internal_host_id)
    }
    return result
  }

  private mapFootholdRow(row: FootholdRow, hostIds: readonly string[]): Foothold {
    return {
      id: row.id,
      project_name: row.project_name,
      entry_host_port: row.entry_host_port,
      entry_vuln_id: row.entry_vuln_id,
      access_type: toFootholdAccessType(row.access_type),
      privilege_level: toPrivilegeLevel(row.privilege_level),
      status: toFootholdStatus(row.status),
      evidence: row.evidence,
      notes: row.notes,
      established_at: row.established_at,
      last_verified_at: row.last_verified_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      host_ids: [...hostIds]
    }
  }

  private mapInternalHostRow(row: InternalHostRow): InternalHost {
    return {
      id: row.id,
      project_name: row.project_name,
      ip: row.ip,
      hostname: row.hostname,
      os: row.os,
      subnet: row.subnet,
      state: toInternalHostState(row.state),
      source: row.source,
      confidence: toConfidence(row.confidence),
      last_seen: row.last_seen,
      created_at: row.created_at,
      updated_at: row.updated_at,
      service_count: row.service_count ?? 0
    }
  }

  private mapInternalServiceRow(row: InternalServiceRow): InternalService {
    return {
      id: row.id,
      project_name: row.project_name,
      host_id: row.host_id,
      port: row.port,
      protocol: row.protocol,
      service: row.service,
      banner: row.banner,
      state: toServiceState(row.state),
      source: row.source,
      last_seen: row.last_seen,
      created_at: row.created_at,
      updated_at: row.updated_at,
      host_ip: row.host_ip,
      host_hostname: row.host_hostname
    }
  }

  private mapCredentialRow(row: CredentialRow): Credential {
    return {
      id: row.id,
      project_name: row.project_name,
      type: toCredentialType(row.type),
      username: row.username,
      domain: row.domain,
      secret_preview: maskSecret(row.secret),
      secret_length: row.secret.length,
      source: row.source,
      host_id: row.host_id ?? null,
      service_id: row.service_id ?? null,
      confidence: toConfidence(row.confidence),
      status: toCredentialStatus(row.status),
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at
    }
  }

  private mapPivotRow(
    row: PivotRow,
    hops: readonly PivotHop[],
    reachableSubnets: readonly string[]
  ): PivotWithHops {
    return {
      id: row.id,
      project_name: row.project_name,
      foothold_id: row.foothold_id,
      kind: toPivotKind(row.kind),
      local_host: row.local_host,
      local_port: row.local_port,
      local_protocol: row.local_protocol,
      tool: row.tool,
      status: toPivotStatus(row.status),
      notes: row.notes,
      established_at: row.established_at,
      last_verified_at: row.last_verified_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      hops: [...hops],
      reachable_subnets: [...reachableSubnets]
    }
  }

  private mapCredentialTrialRow(row: CredentialTrialRow): CredentialTrial {
    return {
      id: row.id,
      credential_id: row.credential_id,
      service_id: row.service_id ?? null,
      action: row.action,
      status: toCredentialTrialStatus(row.status),
      notes: row.notes,
      attempted_at: row.attempted_at
    }
  }

  private mapLootImportRow(row: LootImportRow): LootImport {
    return {
      id: row.id,
      project_name: row.project_name,
      entry_host_port: row.entry_host_port,
      filename: row.filename,
      sha256: row.sha256,
      format: toLootFormat(row.format),
      parser: row.parser,
      status: toLootImportStatus(row.status),
      summary: parseLootSummary(row.summary_json),
      error: row.error,
      created_at: row.created_at
    }
  }

  /* ---------------------------------------------------------- read models -- */

  /**
   * Projects that own at least one internal entity — or at least one internal
   * vulnerability (entry assets attributed through the asset library). The
   * vulnerability-only case is what a freshly migrated v2 database looks like:
   * legacy `service_host` rows are `realm='internal'` but have no normalized
   * host/service entities yet, and the internal page must still list them as
   * "待归一化" instead of claiming the project has no internal data.
   */
  listInternalProjects(): InternalProjectSummary[] {
    const rows = this.db
      .prepare(
        `
        SELECT project_name FROM (
          SELECT project_name FROM footholds
          UNION SELECT project_name FROM internal_hosts
          UNION SELECT project_name FROM internal_services
          UNION SELECT project_name FROM credentials
          UNION SELECT project_name FROM pivots
          UNION
          SELECT a.project_name FROM assets a
          JOIN vulnerabilities v ON (
            lower(v.host) = lower(a.host)
            OR (length(v.host) > length(a.host)
                AND substr(lower(v.host), 1, length(a.host) + 1) = lower(a.host) || ':')
            OR lower(v.host) = lower(a.host_port)
          )
          WHERE v.realm = 'internal'
        )
        ORDER BY project_name COLLATE NOCASE ASC
        `
      )
      .all() as Array<{ project_name: string }>
    return rows.map((row) => ({
      project_name: row.project_name,
      counts: this.countInternalScope(row.project_name)
    }))
  }

  /** Alias used by the IPC contract (`getInternalProjects`). */
  getInternalProjects(): InternalProjectSummary[] {
    return this.listInternalProjects()
  }

  /** Entity counts for one project. */
  countInternalScope(project: string): InternalScopeCounts {
    const row = this.db
      .prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM footholds WHERE project_name = @project) AS footholds,
          (SELECT COUNT(*) FROM internal_hosts WHERE project_name = @project) AS hosts,
          (SELECT COUNT(*) FROM internal_services WHERE project_name = @project) AS services,
          (SELECT COUNT(*) FROM credentials WHERE project_name = @project) AS credentials,
          (SELECT COUNT(*) FROM pivots WHERE project_name = @project) AS pivots
        `
      )
      .get({ project }) as InternalScopeCounts
    return {
      footholds: row.footholds ?? 0,
      hosts: row.hosts ?? 0,
      services: row.services ?? 0,
      credentials: row.credentials ?? 0,
      pivots: row.pivots ?? 0
    }
  }

  listFootholds(project: string, limit: number = INTERNAL_LIMITS.footholds): Foothold[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_FOOTHOLDS))
    const rows = this.db
      .prepare(
        `SELECT ${FOOTHOLD_SELECT} FROM footholds WHERE project_name = ?
         ORDER BY updated_at DESC, id ASC LIMIT ?`
      )
      .all(project, bounded) as FootholdRow[]
    const hostIds = this.loadFootholdHostIds(rows.map((row) => row.id))
    return rows.map((row) => this.mapFootholdRow(row, hostIds.get(row.id) ?? []))
  }

  listInternalHosts(project: string, limit: number = INTERNAL_LIMITS.hosts): InternalHost[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_INTERNAL_HOSTS))
    const rows = this.db
      .prepare(
        `SELECT ${INTERNAL_HOST_SELECT} FROM internal_hosts h WHERE h.project_name = ?
         ORDER BY h.last_seen DESC, h.ip ASC LIMIT ?`
      )
      .all(project, bounded) as InternalHostRow[]
    return rows.map((row) => this.mapInternalHostRow(row))
  }

  listInternalServices(project: string, limit: number = INTERNAL_LIMITS.services): InternalService[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_INTERNAL_SERVICES))
    const rows = this.db
      .prepare(
        `SELECT ${INTERNAL_SERVICE_SELECT} FROM internal_services s
         JOIN internal_hosts h ON h.id = s.host_id
         WHERE s.project_name = ? ORDER BY h.ip ASC, s.port ASC LIMIT ?`
      )
      .all(project, bounded) as InternalServiceRow[]
    return rows.map((row) => this.mapInternalServiceRow(row))
  }

  /** Masked credential projection: the raw secret never leaves this layer. */
  listCredentials(project: string, limit: number = INTERNAL_LIMITS.credentials): Credential[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_INTERNAL_SERVICES))
    const rows = this.db
      .prepare(
        `SELECT ${CREDENTIAL_SELECT} FROM credentials WHERE project_name = ?
         ORDER BY updated_at DESC, id ASC LIMIT ?`
      )
      .all(project, bounded) as CredentialRow[]
    return rows.map((row) => this.mapCredentialRow(row))
  }

  listPivots(project: string, limit: number = INTERNAL_LIMITS.pivots): PivotWithHops[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_INTERNAL_PIVOTS))
    const rows = this.db
      .prepare(
        `SELECT ${PIVOT_SELECT} FROM pivots WHERE project_name = ?
         ORDER BY updated_at DESC, id ASC LIMIT ?`
      )
      .all(project, bounded) as PivotRow[]
    const ids = rows.map((row) => row.id)
    const hops = this.loadPivotHops(ids)
    const subnets = this.loadPivotReachability(ids)
    return rows.map((row) => this.mapPivotRow(row, hops.get(row.id) ?? [], subnets.get(row.id) ?? []))
  }

  listCredentialTrials(project: string, limit = 200): CredentialTrial[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 500))
    const rows = this.db
      .prepare(
        `SELECT t.id, t.credential_id, t.service_id, t.action, t.status, t.notes, t.attempted_at
         FROM credential_trials t
         JOIN credentials c ON c.id = t.credential_id
         WHERE c.project_name = ?
         ORDER BY t.attempted_at DESC, t.id ASC LIMIT ?`
      )
      .all(project, bounded) as CredentialTrialRow[]
    return rows.map((row) => this.mapCredentialTrialRow(row))
  }

  /** Internal vulnerability rows for one project (or every project when null). */
  private internalVulnerabilityFilter(project: string | null): {
    clause: string
    params: Record<string, string>
  } {
    if (project === null) return { clause: "realm = 'internal'", params: {} }
    return {
      clause: `realm = 'internal' AND (
        (internal_service_id <> '' AND internal_service_id IN (
          SELECT id FROM internal_services WHERE project_name = @project
        ))
        OR host IN (SELECT host_port FROM assets WHERE project_name = @project)
        OR EXISTS (
          SELECT 1 FROM assets a
          WHERE a.project_name = @project
            AND (
              lower(host) = lower(a.host)
              OR lower(host) LIKE lower(a.host) || ':%'
              OR lower(host) = lower(a.host_port)
            )
        )
      )`,
      params: { project }
    }
  }

  listInternalVulnerabilities(project: string | null, limit: number = INTERNAL_LIMITS.internalVulns): VulnerabilityListItem[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_VULNERABILITIES))
    const filter = this.internalVulnerabilityFilter(project)
    const statement = this.db.prepare(
      `SELECT ${LIST_COLUMNS} FROM vulnerabilities WHERE ${filter.clause}
       ORDER BY
         CASE severity
           WHEN 'Critical' THEN 0
           WHEN 'High' THEN 1
           WHEN 'Medium' THEN 2
           WHEN 'Low' THEN 3
           ELSE 4
         END,
         created_at DESC, id DESC
       LIMIT @limit`
    )
    const rows = statement.all({ ...filter.params, limit: bounded }) as Array<
      Pick<
        VulnerabilityRow,
        | 'id'
        | 'host'
        | 'service_host'
        | 'realm'
        | 'internal_service_id'
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
      service_host: row.service_host ?? '',
      realm: row.realm === 'internal' ? 'internal' : 'web',
      internal_service_id: row.internal_service_id ?? '',
      entry_point: row.entry_point,
      vuln_name: row.vuln_name,
      vuln_type: row.vuln_type,
      severity: toSeverity(row.severity),
      target_url: row.target_url,
      status: toStatus(row.status),
      created_at: row.created_at
    }))
  }

  countInternalVulnerabilities(project: string | null): number {
    const filter = this.internalVulnerabilityFilter(project)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM vulnerabilities WHERE ${filter.clause}`)
      .get(filter.params) as { count: number }
    return row.count
  }

  /** Legacy internal vulnerabilities that still lack an internal service link. */
  private countUnnormalizedInternalVulnerabilities(project: string): number {
    const filter = this.internalVulnerabilityFilter(project)
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM vulnerabilities
         WHERE ${filter.clause} AND internal_service_id = ''`
      )
      .get(filter.params) as { count: number }
    return row.count
  }

  countLootImports(project?: string): number {
    const trimmed = (project ?? '').trim()
    const row = (
      trimmed.length === 0
        ? this.db.prepare('SELECT COUNT(*) AS count FROM loot_imports').get()
        : this.db.prepare('SELECT COUNT(*) AS count FROM loot_imports WHERE project_name = ?').get(trimmed)
    ) as { count: number }
    return row.count
  }

  listLootImports(projectName?: string): LootImport[] {
    const trimmed = (projectName ?? '').trim()
    const limit = INTERNAL_LIMITS.lootImports
    const rows = (
      trimmed.length === 0
        ? this.db
            .prepare(
              `SELECT id, project_name, entry_host_port, filename, sha256, format, parser,
                 status, summary_json, error, created_at
               FROM loot_imports ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(limit)
        : this.db
            .prepare(
              `SELECT id, project_name, entry_host_port, filename, sha256, format, parser,
                 status, summary_json, error, created_at
               FROM loot_imports WHERE project_name = ?
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(trimmed, limit)
    ) as LootImportRow[]
    return rows.map((row) => this.mapLootImportRow(row))
  }

  getInternalOverview(projectName?: string): InternalOverview {
    const projects = this.listInternalProjects()
    const project = (projectName ?? '').trim()
    if (project.length === 0) {
      return {
        project_name: '',
        counts: emptyInternalCounts(),
        footholds: [],
        hosts: [],
        services: [],
        credentials: [],
        pivots: [],
        trials: [],
        internal_vulns: [],
        loot_imports: [],
        warnings: [],
        projects
      }
    }

    const scopeCounts = this.countInternalScope(project)
    const counts: InternalCounts = {
      ...scopeCounts,
      internal_vulns: this.countInternalVulnerabilities(project),
      loot_imports: this.countLootImports(project)
    }
    const warnings: string[] = []
    const footholds = this.listFootholds(project, INTERNAL_OVERVIEW_LIST_LIMIT)
    const hosts = this.listInternalHosts(project, INTERNAL_OVERVIEW_LIST_LIMIT)
    const services = this.listInternalServices(project, INTERNAL_OVERVIEW_LIST_LIMIT)
    const credentials = this.listCredentials(project, INTERNAL_OVERVIEW_LIST_LIMIT)
    const pivots = this.listPivots(project, INTERNAL_OVERVIEW_LIST_LIMIT)
    const trials = this.listCredentialTrials(project)
    const internalVulns = this.listInternalVulnerabilities(project, INTERNAL_OVERVIEW_LIST_LIMIT)
    const lootImports = this.listLootImports(project)

    if (scopeCounts.hosts > hosts.length) {
      warnings.push(
        `内网主机共 ${scopeCounts.hosts} 台，概览仅展示最近 ${hosts.length} 台；完整视图见内网作战页`
      )
    }
    if (scopeCounts.services > services.length) {
      warnings.push(`内网服务共 ${scopeCounts.services} 个，概览仅展示前 ${services.length} 个`)
    }
    if (scopeCounts.footholds > footholds.length) {
      warnings.push(`foothold 共 ${scopeCounts.footholds} 条，概览仅展示前 ${footholds.length} 条`)
    }
    const unnormalized = this.countUnnormalizedInternalVulnerabilities(project)
    if (unnormalized > 0) {
      warnings.push(
        `存在 ${unnormalized} 条内网漏洞只有 service_host、缺少 internal_service_id（待归一化）：请在下一次上报时用 sync_internal_scope 登记内网服务，并在 save_vulnerability 中补 internal_service_id`
      )
    }

    return {
      project_name: project,
      counts,
      footholds,
      hosts,
      services,
      credentials,
      pivots,
      trials,
      internal_vulns: internalVulns,
      loot_imports: lootImports,
      warnings,
      projects
    }
  }

  getInternalGraph(projectName: string): InternalGraphData {
    const project = projectName.trim()
    if (project.length === 0) {
      throw new DatabaseError('INVALID_INPUT', 'project_name 不能为空')
    }
    const scopeCounts = this.countInternalScope(project)
    const counts: InternalCounts = {
      ...scopeCounts,
      internal_vulns: this.countInternalVulnerabilities(project),
      loot_imports: this.countLootImports(project)
    }
    const warnings: string[] = []
    const footholds = this.listFootholds(project, INTERNAL_LIMITS.footholds)
    const hosts = this.listInternalHosts(project, INTERNAL_LIMITS.hosts)
    const services = this.listInternalServices(project, INTERNAL_LIMITS.services)
    const credentials = this.listCredentials(project, INTERNAL_LIMITS.credentials)
    const pivots = this.listPivots(project, INTERNAL_LIMITS.pivots)
    const trials = this.listCredentialTrials(project)
    const truncated =
      scopeCounts.hosts > hosts.length ||
      scopeCounts.services > services.length ||
      scopeCounts.credentials > credentials.length ||
      scopeCounts.pivots > pivots.length ||
      scopeCounts.footholds > footholds.length
    if (truncated) {
      warnings.push('内网作战视图已按性能上限截断（主机 ≤300 / 服务 ≤1000 / 凭据 ≤500 / pivot ≤100），请按网段或项目缩小范围')
    }
    const unnormalized = this.countUnnormalizedInternalVulnerabilities(project)
    if (unnormalized > 0) {
      warnings.push(`存在 ${unnormalized} 条内网漏洞待归一化（缺少 internal_service_id）`)
    }

    return {
      project_name: project,
      generated_at: new Date().toISOString(),
      counts,
      footholds,
      hosts,
      services,
      credentials,
      pivots,
      trials,
      heatmap: buildSubnetHeatmap(hosts, services),
      suggestions: buildCredentialSuggestions({ credentials, services, trials }),
      truncated,
      warnings
    }
  }

  private emptyInternalScopeSummary(): InternalScopeSummary {
    return {
      counts: emptyScopeCounts(),
      footholds: [],
      hosts: [],
      services: [],
      credentials: undefined,
      pivots: [],
      truncated: false
    }
  }

  /** Internal summary for one entry Web asset (`query_asset_context` host mode). */
  getInternalScopeForAsset(
    hostPort: string,
    options: { includeCredentials?: boolean } = {}
  ): InternalScopeSummary {
    const normalized = normalizeEntryHostPort(hostPort)
    const asset = this.getAssetDetail(hostPort)
    const project =
      asset?.project_name ?? this.findProjectForEntryHost(normalized)
    if (project === null) return this.emptyInternalScopeSummary()

    const allFootholds = this.listFootholds(project, GRAPH_MAX_FOOTHOLDS)
    const matched = allFootholds.filter((foothold) => {
      const entry = normalizeEntryHostPort(foothold.entry_host_port)
      return entry === normalized || entry === normalizeEntryHostPort(asset?.host_port ?? '')
    })
    if (matched.length === 0) return this.emptyInternalScopeSummary()

    const hostIds = new Set<string>()
    for (const foothold of matched) for (const id of foothold.host_ids) hostIds.add(id)
    const footholdIds = new Set(matched.map((foothold) => foothold.id))

    const allHosts = this.listInternalHosts(project, GRAPH_MAX_INTERNAL_HOSTS)
    const hosts = allHosts.filter((host) => hostIds.has(host.id))
    const serviceHostIds = new Set(hosts.map((host) => host.id))
    const allServices = this.listInternalServices(project, GRAPH_MAX_INTERNAL_SERVICES)
    const services = allServices.filter((service) => serviceHostIds.has(service.host_id))
    const serviceIds = new Set(services.map((service) => service.id))
    const allPivots = this.listPivots(project, GRAPH_MAX_INTERNAL_PIVOTS)
    const pivots = allPivots.filter((pivot) => footholdIds.has(pivot.foothold_id))

    let credentials: Credential[] | undefined
    if (options.includeCredentials === true) {
      credentials = this.listCredentials(project, GRAPH_MAX_INTERNAL_SERVICES).filter(
        (credential) =>
          (credential.host_id !== null && hostIds.has(credential.host_id)) ||
          (credential.service_id !== null && serviceIds.has(credential.service_id))
      )
    }

    const limit = INTERNAL_SCOPE_SUMMARY_LIMIT
    const truncated =
      matched.length > limit ||
      hosts.length > limit ||
      services.length > limit ||
      pivots.length > limit ||
      (credentials?.length ?? 0) > limit

    return {
      counts: {
        footholds: matched.length,
        hosts: hosts.length,
        services: services.length,
        credentials: credentials?.length ?? 0,
        pivots: pivots.length
      },
      footholds: matched.slice(0, limit),
      hosts: hosts.slice(0, limit),
      services: services.slice(0, limit),
      ...(credentials !== undefined ? { credentials: credentials.slice(0, limit) } : {}),
      pivots: pivots.slice(0, limit),
      truncated
    }
  }

  /** Internal summary for one project (`query_asset_context` project mode). */
  getInternalScopeForProject(
    projectName: string,
    options: { includeCredentials?: boolean } = {}
  ): InternalScopeSummary {
    const project = projectName.trim()
    if (project.length === 0) return this.emptyInternalScopeSummary()
    const counts = this.countInternalScope(project)
    const limit = INTERNAL_SCOPE_SUMMARY_LIMIT
    const footholds = this.listFootholds(project, limit + 1)
    const hosts = this.listInternalHosts(project, limit + 1)
    const services = this.listInternalServices(project, limit + 1)
    const pivots = this.listPivots(project, limit + 1)
    const credentials = options.includeCredentials === true
      ? this.listCredentials(project, limit + 1)
      : undefined
    const truncated =
      footholds.length > limit ||
      hosts.length > limit ||
      services.length > limit ||
      pivots.length > limit ||
      (credentials !== undefined && credentials.length > limit)

    return {
      counts,
      footholds: footholds.slice(0, limit),
      hosts: hosts.slice(0, limit),
      services: services.slice(0, limit),
      ...(credentials !== undefined ? { credentials: credentials.slice(0, limit) } : {}),
      pivots: pivots.slice(0, limit),
      truncated
    }
  }

  private findProjectForEntryHost(normalizedEntry: string): string | null {
    const row = this.db
      .prepare(
        'SELECT project_name FROM footholds WHERE lower(entry_host_port) = lower(?) LIMIT 1'
      )
      .get(normalizedEntry) as { project_name: string } | undefined
    return row?.project_name ?? null
  }

  /** Best-effort project of the Web asset behind a vulnerability `host`. */
  private findAssetProjectForHost(host: string): string | null {
    const key = normalizeAssetIdentifier(host)
    const direct = this.db
      .prepare('SELECT project_name FROM assets WHERE host_port = ?')
      .get(key) as { project_name: string } | undefined
    if (direct !== undefined) return direct.project_name
    const bareHost = deriveAssetHost(host)
    if (bareHost.length === 0) return null
    const row = this.db
      .prepare(
        'SELECT project_name FROM assets WHERE lower(host) = lower(?) ORDER BY last_seen DESC LIMIT 1'
      )
      .get(bareHost) as { project_name: string } | undefined
    return row?.project_name ?? null
  }

  /**
   * Validate that `internal_service_id` exists and belongs to the same project
   * as the entry Web asset behind `host`. Throws `DatabaseError('INVALID_INPUT')`
   * so `save_vulnerability` can return an actionable message.
   */
  assertInternalServiceReference(host: string, internalServiceId: string): InternalService {
    const id = internalServiceId.trim()
    if (id.length === 0) {
      throw new DatabaseError('INVALID_INPUT', 'internal_service_id 不能为空')
    }
    const service = this.getInternalServiceRowById(id)
    if (service === undefined) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `internal_service_id「${id}」不存在：请先调用 sync_internal_scope 登记该内网服务，再保存内网漏洞`
      )
    }
    const assetProject = this.findAssetProjectForHost(host)
    if (assetProject !== null && assetProject !== service.project_name) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `internal_service_id「${id}」属于项目「${service.project_name}」，与入口资产 host「${host}」所属项目「${assetProject}」不一致`
      )
    }
    return this.mapInternalServiceRow(service)
  }

  getInternalService(id: string): InternalService | null {
    const row = this.getInternalServiceRowById(id.trim())
    return row === undefined ? null : this.mapInternalServiceRow(row)
  }

  recordCredentialTrial(input: RecordCredentialTrialInput): CredentialTrial {
    const parsed = RecordCredentialTrialInputSchema.safeParse(input)
    if (!parsed.success) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `凭据尝试记录参数校验失败: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      )
    }
    const trial = parsed.data
    return this.writeTransaction(() => {
      const credential = this.getCredentialRowById(trial.credential_id)
      if (credential === undefined) {
        throw new DatabaseError('NOT_FOUND', `未找到凭据 ${trial.credential_id}`)
      }
      if (trial.service_id !== undefined && trial.service_id.length > 0) {
        const service = this.getInternalServiceRowById(trial.service_id)
        if (service === undefined || service.project_name !== credential.project_name) {
          throw new DatabaseError(
            'INVALID_INPUT',
            `service_id ${trial.service_id} 不存在于凭据所属项目「${credential.project_name}」`
          )
        }
      }
      const id = generateInternalId('TR-')
      const attemptedAt = new Date().toISOString()
      this.db
        .prepare(
          `INSERT INTO credential_trials (
             id, credential_id, service_id, action, status, notes, attempted_at
           ) VALUES (@id, @credential_id, @service_id, @action, @status, @notes, @attempted_at)`
        )
        .run({
          id,
          credential_id: trial.credential_id,
          service_id:
            trial.service_id !== undefined && trial.service_id.length > 0
              ? trial.service_id
              : null,
          action: trial.action,
          status: trial.status,
          notes: trial.notes,
          attempted_at: attemptedAt
        })
      return this.mapCredentialTrialRow({
        id,
        credential_id: trial.credential_id,
        service_id:
          trial.service_id !== undefined && trial.service_id.length > 0
            ? trial.service_id
            : null,
        action: trial.action,
        status: trial.status,
        notes: trial.notes,
        attempted_at: attemptedAt
      })
    })
  }

  /* ------------------------------------------------------ loot ingestion -- */

  /**
   * Parse one local loot file and persist the derived internal entities.
   *
   * The file is untrusted input: parsing happens in `core/loot` (size / entry /
   * path caps, no code execution, no network) and only structured rows are
   * written here — never the raw file content. Unknown or unparsable files are
   * recorded as `needs_review` / `failed` loot_imports rows for the review queue.
   */
  importLoot(input: ImportLootInput): LootImport {
    const parsedInput = ImportLootInputSchema.safeParse(input)
    if (!parsedInput.success) {
      throw new DatabaseError(
        'INVALID_INPUT',
        `loot 导入参数校验失败: ${parsedInput.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      )
    }
    const validated = parsedInput.data
    const project = validated.project_name.trim()
    const entryHostPort = validated.entry_host_port.length > 0
      ? normalizeEntryHostPort(validated.entry_host_port)
      : ''
    let parsed: LootParseResult | null = null
    let failure: string | null = null
    try {
      parsed = parseLootFile(
        validated.file_path,
        validated.format === 'auto' ? undefined : { format: validated.format }
      )
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    return this.writeTransaction(() => {
      if (parsed === null) {
        return this.insertLootImportRow({
          project,
          entryHostPort,
          filePath: validated.file_path,
          format: 'unknown',
          parser: '',
          sha256: '',
          status: 'failed',
          summary: {
            hosts: 0,
            services: 0,
            credentials: 0,
            warnings: [],
            needs_review: 0
          },
          error: (failure ?? 'loot 文件解析失败').slice(0, 2_000)
        })
      }

      const nowIso = new Date().toISOString()
      const scopeInput = this.buildLootScopeInput(project, validated.file_path, parsed, nowIso)
      const result = this.syncInternalScopeInternal(scopeInput)
      const needsReview = parsed.credentials.length
      const status: LootImportStatus =
        parsed.status === 'needs_review' || needsReview > 0 ? 'needs_review' : 'parsed'
      const summary: LootImportSummary = {
        hosts: result.created.hosts + result.updated.hosts,
        services: result.created.services + result.updated.services,
        credentials: result.created.credentials + result.updated.credentials,
        warnings: [...parsed.warnings, ...result.warnings].slice(0, 50),
        needs_review: needsReview
      }
      return this.insertLootImportRow({
        project,
        entryHostPort,
        filePath: validated.file_path,
        format: parsed.format,
        parser: parsed.parser,
        sha256: parsed.sha256,
        status,
        summary,
        error: ''
      })
    })
  }

  /**
   * Convert one parser result into the same `sync_internal_scope` payload used by
   * MCP: hosts first (explicit ids so services/credentials can reference them),
   * then services, then credentials. Existing natural keys are reused instead of
   * duplicated.
   */
  private buildLootScopeInput(
    project: string,
    filePath: string,
    parsed: LootParseResult,
    nowIso: string
  ): SyncInternalScopeInput {
    const sourceTag = `loot:${basename(filePath)}`.slice(0, 200)
    const hostIdByIp = new Map<string, string>()
    const hostInputs: InternalHostInput[] = []
    const serviceIdByKey = new Map<string, string>()
    const serviceInputs: InternalServiceInput[] = []

    for (const row of this.db
      .prepare('SELECT id, ip FROM internal_hosts WHERE project_name = ?')
      .all(project) as Array<{ id: string; ip: string }>) {
      hostIdByIp.set(row.ip, row.id)
    }
    for (const row of this.db
      .prepare('SELECT id, host_id, port, protocol FROM internal_services WHERE project_name = ?')
      .all(project) as Array<{ id: string; host_id: string; port: number; protocol: string }>) {
      serviceIdByKey.set(`${row.host_id}\u0000${row.port}\u0000${row.protocol}`, row.id)
    }

    const ensureHost = (
      ip: string,
      hostname = '',
      os = '',
      subnet = '',
      state: InternalHostState = 'unknown',
      confidence: ConfidenceLevel = 'low'
    ): string => {
      const existing = hostIdByIp.get(ip)
      if (existing !== undefined) return existing
      const id = generateInternalId(INTERNAL_ID_PREFIXES.internalHost)
      hostIdByIp.set(ip, id)
      hostInputs.push({
        id,
        ip,
        hostname,
        os,
        subnet,
        state,
        source: sourceTag,
        confidence,
        last_seen: nowIso
      })
      return id
    }

    const ensureService = (
      hostIp: string,
      port: number,
      protocol: string,
      service: string,
      banner = '',
      state: ServiceState = 'open'
    ): string => {
      const hostId = ensureHost(hostIp)
      const key = `${hostId}\u0000${port}\u0000${protocol}`
      const existing = serviceIdByKey.get(key)
      if (existing !== undefined) return existing
      const id = generateInternalId(INTERNAL_ID_PREFIXES.internalService)
      serviceIdByKey.set(key, id)
      serviceInputs.push({
        id,
        host_id: hostId,
        port,
        protocol,
        service,
        banner,
        state,
        source: sourceTag
      })
      return id
    }

    for (const host of parsed.hosts) {
      ensureHost(
        host.ip,
        host.hostname ?? '',
        host.os ?? '',
        host.subnet ?? '',
        host.state ?? 'unknown',
        'medium'
      )
    }
    for (const service of parsed.services) {
      ensureService(
        service.host_ip,
        service.port,
        service.protocol ?? '',
        service.service ?? '',
        service.banner ?? '',
        service.state ?? 'open'
      )
    }

    const credentialInputs: CredentialInput[] = parsed.credentials.map((credential) => {
      const serviceId =
        credential.service_ip !== undefined && credential.service_port !== undefined
          ? ensureService(
              credential.service_ip,
              credential.service_port,
              '',
              ''
            )
          : undefined
      const hostId =
        credential.host_ip !== undefined
          ? ensureHost(credential.host_ip)
          : serviceId !== undefined
            ? (this.db
                .prepare('SELECT host_id FROM internal_services WHERE id = ?')
                .get(serviceId) as { host_id: string } | undefined)?.host_id ??
              serviceInputs.find((item) => item.id === serviceId)?.host_id
            : undefined
      return {
        type: credential.type,
        username: credential.username ?? '',
        domain: credential.domain ?? '',
        secret: credential.secret,
        source: credential.source.length > 0 ? credential.source : sourceTag,
        ...(hostId !== undefined ? { host_id: hostId } : {}),
        ...(serviceId !== undefined ? { service_id: serviceId } : {}),
        confidence: credential.confidence ?? 'low',
        status: 'untested' as const,
        notes: credential.notes ?? ''
      }
    })

    return {
      project_name: project,
      mode: 'merge',
      ...(hostInputs.length > 0 ? { hosts: hostInputs } : {}),
      ...(serviceInputs.length > 0 ? { services: serviceInputs } : {}),
      ...(credentialInputs.length > 0 ? { credentials: credentialInputs } : {})
    }
  }

  private insertLootImportRow(record: {
    project: string
    entryHostPort: string
    filePath: string
    format: LootFormat
    parser: string
    sha256: string
    status: LootImportStatus
    summary: LootImportSummary
    error: string
  }): LootImport {
    const id = generateInternalId(INTERNAL_ID_PREFIXES.lootImport)
    const createdAt = new Date().toISOString()
    const filename = basename(record.filePath) || record.filePath
    this.db
      .prepare(
        `INSERT INTO loot_imports (
           id, project_name, entry_host_port, filename, sha256, format, parser,
           status, summary_json, error, created_at
         ) VALUES (
           @id, @project_name, @entry_host_port, @filename, @sha256, @format, @parser,
           @status, @summary_json, @error, @created_at
         )`
      )
      .run({
        id,
        project_name: record.project,
        entry_host_port: record.entryHostPort,
        filename,
        sha256: record.sha256,
        format: record.format,
        parser: record.parser,
        status: record.status,
        summary_json: JSON.stringify(record.summary),
        error: record.error,
        created_at: createdAt
      })
    return {
      id,
      project_name: record.project,
      entry_host_port: record.entryHostPort,
      filename,
      sha256: record.sha256,
      format: record.format,
      parser: record.parser,
      status: record.status,
      summary: record.summary,
      error: record.error,
      created_at: createdAt
    }
  }

  /* ------------------------------------------------ graph read projections -- */

  listGraphInternalFootholds(limit: number): Foothold[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_FOOTHOLDS))
    const rows = this.db
      .prepare(
        `SELECT ${FOOTHOLD_SELECT} FROM footholds ORDER BY updated_at DESC, id ASC LIMIT ?`
      )
      .all(bounded) as FootholdRow[]
    const hostIds = this.loadFootholdHostIds(rows.map((row) => row.id))
    return rows.map((row) => this.mapFootholdRow(row, hostIds.get(row.id) ?? []))
  }

  countFootholds(): number {
    return this.countTableRows('footholds')
  }

  listGraphInternalHosts(limit: number): InternalHost[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_INTERNAL_HOSTS))
    const rows = this.db
      .prepare(
        `SELECT ${INTERNAL_HOST_SELECT} FROM internal_hosts h
         ORDER BY h.last_seen DESC, h.ip ASC LIMIT ?`
      )
      .all(bounded) as InternalHostRow[]
    return rows.map((row) => this.mapInternalHostRow(row))
  }

  countInternalHosts(): number {
    return this.countTableRows('internal_hosts')
  }

  listGraphInternalServices(limit: number): InternalService[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_INTERNAL_SERVICES))
    const rows = this.db
      .prepare(
        `SELECT ${INTERNAL_SERVICE_SELECT} FROM internal_services s
         JOIN internal_hosts h ON h.id = s.host_id
         ORDER BY h.ip ASC, s.port ASC LIMIT ?`
      )
      .all(bounded) as InternalServiceRow[]
    return rows.map((row) => this.mapInternalServiceRow(row))
  }

  countInternalServices(): number {
    return this.countTableRows('internal_services')
  }

  listGraphInternalPivots(limit: number): PivotWithHops[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_INTERNAL_PIVOTS))
    const rows = this.db
      .prepare(
        `SELECT ${PIVOT_SELECT} FROM pivots ORDER BY updated_at DESC, id ASC LIMIT ?`
      )
      .all(bounded) as PivotRow[]
    const ids = rows.map((row) => row.id)
    const hops = this.loadPivotHops(ids)
    const subnets = this.loadPivotReachability(ids)
    return rows.map((row) => this.mapPivotRow(row, hops.get(row.id) ?? [], subnets.get(row.id) ?? []))
  }

  /** Web assets referenced by at least one foothold (internal graph attribution). */
  listGraphInternalEntryAssets(limit: number): AssetContext[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), GRAPH_MAX_HOSTS))
    const rows = this.db
      .prepare(
        `SELECT * FROM assets
         WHERE host_port IN (SELECT entry_host_port FROM footholds)
         ORDER BY last_seen DESC, host_port ASC LIMIT ?`
      )
      .all(bounded) as AssetRow[]
    return rows.map((row) => this.mapAssetRow(row))
  }

  private countTableRows(tableName: 'footholds' | 'internal_hosts' | 'internal_services' | 'pivots'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
      count: number
    }
    return row.count
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
      service_host: row.service_host ?? '',
      realm: row.realm === 'internal' ? 'internal' : 'web',
      internal_service_id: row.internal_service_id ?? '',
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
