/**
 * Read-only Cortex schema-v5 database adapter for the plugin Host.
 *
 * Two responsibilities:
 *
 * 1. `createGraphDatabaseAdapter(holder)` implements exactly the subset of the
 *    original `DatabaseService` that the vendored Memory Nebula builder
 *    (`graph-builder.js`, compiled from `src/cortex-ui/graph/buildMemoryGraph.ts`)
 *    calls on its `db` argument. The vendored builder is kept verbatim, so the
 *    method names, argument order, return shapes and ordering must match the
 *    original better-sqlite3 implementation 1:1 (see
 *    `Desktop/Electron/src/core/db/DatabaseService.ts`), only reimplemented with
 *    `node:sqlite`.
 *
 * 2. The same object exposes the Cortex internal-operations read projections
 *    (`InternalOverview` / `InternalGraphData` / `InternalProjectSummary` /
 *    `LootImport[]`) plus the one append-only credential-trial write, matching
 *    `src/cortex-ui/shared/internal.ts` exactly.
 *
 * Hard rules:
 *  - every SQL statement is parameterized (except fixed column/ORDER lists);
 *  - nothing is ever written except `credential_trials` (explicitly allowed);
 *  - raw credential `secret` values never leave this module: the mapping uses
 *    `maskSecret()` exactly like the original `mapCredentialRow`;
 *  - tolerant JSON parsing: corrupt columns degrade to an empty value instead
 *    of throwing, mirroring the original `parseJsonArray` behaviour.
 */

import { randomUUID } from 'node:crypto'
import { badRequest, notFound } from '../http.js'
import {
  ASSET_STATUSES,
  CONFIDENCE_LEVELS,
  CREDENTIAL_STATUSES,
  CREDENTIAL_TRIAL_STATUSES,
  CREDENTIAL_TYPES,
  FOOTHOLD_ACCESS_TYPES,
  FOOTHOLD_STATUSES,
  INTERNAL_HOST_STATES,
  LOOT_FORMATS,
  LOOT_IMPORT_STATUSES,
  PIVOT_KINDS,
  PIVOT_STATUSES,
  PRIVILEGE_LEVELS,
  RecordCredentialTrialInputSchema,
  SERVICE_STATES,
  SEVERITIES,
  TestParameterCandidateSchema,
  VULN_STATUSES,
  deriveAssetHost,
  interfaceDirFromInterfaces,
  normalizeAssetIdentifier,
  normalizeAssetInterfaces,
} from './shared/types.js'
import {
  INTERNAL_LIMITS,
  buildCredentialSuggestions,
  buildSubnetHeatmap,
  maskSecret,
} from './shared/internal.js'

/* ------------------------------------------------------------- constants -- */

/** Max Markdown characters of `reproduction_steps` carried into the graph. */
export const GRAPH_REPRODUCTION_PREVIEW_CHARS = 4_000

/** Hard SQL caps mirroring `MEMORY_GRAPH_HARD_LIMITS` in `shared/graph.ts`. */
const GRAPH_MAX_HOSTS = 500
const GRAPH_MAX_VULNERABILITIES = 2_000
const GRAPH_MAX_SNAPSHOTS = 200
const GRAPH_MAX_FOOTHOLDS = 300
const GRAPH_MAX_INTERNAL_HOSTS = 1_000
const GRAPH_MAX_INTERNAL_SERVICES = 3_000
const GRAPH_MAX_INTERNAL_PIVOTS = 100

/** Default cap used by the internal overview lists (plan §12). */
const INTERNAL_OVERVIEW_LIST_LIMIT = 200

/** Cap for the credential-trial history carried into the internal graph. */
const INTERNAL_TRIALS_LIMIT = 200

/* ----------------------------------------------------------------- SQL -- */

const LIST_COLUMNS = `
  id, host, service_host, realm, internal_service_id, entry_point, vuln_name, vuln_type,
  severity, target_url, status, created_at
`

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

/* ------------------------------------------------------------- utilities -- */

/** Clamp a row limit exactly like the original `Math.max(1, Math.min(..., HARD))`. */
function clampLimit(value, hardMax) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.max(1, Math.min(Math.floor(numeric), hardMax))
}

/** Tolerant JSON array parsing: corrupt/missing columns become `[]`. */
function parseJsonArray(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function toStringList(allowed, value, fallback) {
  return allowed.includes(value) ? value : fallback
}

const toSeverity = (value) => toStringList(SEVERITIES, value, 'Info')
const toStatus = (value) => toStringList(VULN_STATUSES, value, 'Confirmed')
const toAssetStatus = (value) => toStringList(ASSET_STATUSES, value, 'Alive')
const toConfidence = (value) => toStringList(CONFIDENCE_LEVELS, value, 'medium')
const toInternalHostState = (value) => toStringList(INTERNAL_HOST_STATES, value, 'unknown')
const toServiceState = (value) => toStringList(SERVICE_STATES, value, 'unknown')
const toCredentialType = (value) => toStringList(CREDENTIAL_TYPES, value, 'other')
const toCredentialStatus = (value) => toStringList(CREDENTIAL_STATUSES, value, 'untested')
const toCredentialTrialStatus = (value) =>
  toStringList(CREDENTIAL_TRIAL_STATUSES, value, 'attempted')
const toFootholdAccessType = (value) => toStringList(FOOTHOLD_ACCESS_TYPES, value, 'other')
const toFootholdStatus = (value) => toStringList(FOOTHOLD_STATUSES, value, 'established')
const toPrivilegeLevel = (value) => toStringList(PRIVILEGE_LEVELS, value, 'unknown')
const toPivotKind = (value) => toStringList(PIVOT_KINDS, value, 'chain')
const toPivotStatus = (value) => toStringList(PIVOT_STATUSES, value, 'planned')
const toLootFormat = (value) => toStringList(LOOT_FORMATS, value, 'unknown')
const toLootImportStatus = (value) => toStringList(LOOT_IMPORT_STATUSES, value, 'parsed')

/** Extract the nine cognitive-state fields from a stored snapshot row. */
function snapshotPayloadFromRow(row) {
  return {
    project_name: row.project_name,
    target_hosts: parseJsonArray(row.target_hosts),
    current_phase: row.current_phase,
    unfinished_tasks: parseJsonArray(row.unfinished_tasks),
    failed_paths: parseJsonArray(row.failed_paths),
    tested_interfaces: parseJsonArray(row.tested_interfaces),
    notes: row.notes ?? '',
    related_vuln_ids: parseJsonArray(row.related_vuln_ids),
    next_steps: row.next_steps,
  }
}

/** `previous_state` is a rollback buffer; only its presence is exposed. */
function hasPreviousState(row) {
  return typeof row.previous_state === 'string' && row.previous_state.length > 0
}

function parseLootSummary(raw) {
  const empty = { hosts: 0, services: 0, credentials: 0, warnings: [], needs_review: 0 }
  if (typeof raw !== 'string' || raw.length === 0) return empty
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return empty
    return {
      hosts: typeof parsed.hosts === 'number' ? parsed.hosts : 0,
      services: typeof parsed.services === 'number' ? parsed.services : 0,
      credentials: typeof parsed.credentials === 'number' ? parsed.credentials : 0,
      warnings: Array.isArray(parsed.warnings)
        ? parsed.warnings.filter((item) => typeof item === 'string')
        : [],
      needs_review: typeof parsed.needs_review === 'number' ? parsed.needs_review : 0,
    }
  } catch {
    return empty
  }
}

/**
 * Canonicalize stored test-parameter seeds. The original merges duplicates by
 * (endpoint, name, location); the graph only consumes `name`, while the asset
 * drawer shows the whole record, so first-wins de-duplication is enough here.
 * Malformed rows are dropped instead of failing the whole read.
 */
function canonicalizeTestParameters(rawValues) {
  const result = []
  const seen = new Set()
  for (const raw of rawValues) {
    const parsed = TestParameterCandidateSchema.safeParse(raw)
    if (!parsed.success) continue
    const candidate = parsed.data
    const key = `${candidate.endpoint}\u0000${candidate.name}\u0000${candidate.location}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

function parseLeakedInfos(raw) {
  return parseJsonArray(raw)
}

function emptyScopeCounts() {
  return { footholds: 0, hosts: 0, services: 0, credentials: 0, pivots: 0 }
}

function emptyInternalCounts() {
  return { ...emptyScopeCounts(), internal_vulns: 0, loot_imports: 0 }
}

function generateInternalId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.() ?? randomUUID()
  const hex = uuid.replace(/-/g, '').replace(/[^0-9a-f]/gi, '').toUpperCase()
  return `${prefix}${hex.slice(0, 12).padEnd(12, '0')}`
}

/* ---------------------------------------------------------------- mappers -- */

function mapAssetRow(row) {
  const interfaces = normalizeAssetInterfaces(
    parseJsonArray(row.interfaces ?? '[]'),
    parseJsonArray(row.interface_dir),
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
    test_parameters: canonicalizeTestParameters(parseJsonArray(row.test_parameters ?? '[]')),
    related_vuln_ids: parseJsonArray(row.related_vuln_ids),
    last_seen: row.last_seen,
  }
}

function mapSnapshotRow(row) {
  return {
    ...snapshotPayloadFromRow(row),
    session_id: row.session_id,
    parent_session_id: row.parent_session_id ?? null,
    archived_at: row.archived_at ?? null,
    child_count: row.child_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_previous_state: hasPreviousState(row),
  }
}

function mapFootholdRow(row, hostIds) {
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
    host_ids: [...hostIds],
  }
}

function mapInternalHostRow(row) {
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
    service_count: row.service_count ?? 0,
  }
}

function mapInternalServiceRow(row) {
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
    host_hostname: row.host_hostname,
  }
}

/**
 * Credential projection. The raw `secret` column is read only to compute the
 * masked preview / length and is NEVER copied into the returned object.
 */
function mapCredentialRow(row) {
  return {
    id: row.id,
    project_name: row.project_name,
    type: toCredentialType(row.type),
    username: row.username,
    domain: row.domain,
    secret_preview: maskSecret(row.secret ?? ''),
    secret_length: (row.secret ?? '').length,
    source: row.source,
    host_id: row.host_id ?? null,
    service_id: row.service_id ?? null,
    confidence: toConfidence(row.confidence),
    status: toCredentialStatus(row.status),
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapPivotRow(row, hops, reachableSubnets) {
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
    reachable_subnets: [...reachableSubnets],
  }
}

function mapCredentialTrialRow(row) {
  return {
    id: row.id,
    credential_id: row.credential_id,
    service_id: row.service_id ?? null,
    action: row.action,
    status: toCredentialTrialStatus(row.status),
    notes: row.notes,
    attempted_at: row.attempted_at,
  }
}

function mapLootImportRow(row) {
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
    created_at: row.created_at,
  }
}

/* ------------------------------------------------------- relation loaders -- */

function loadFootholdHostIds(db, footholdIds) {
  const result = new Map()
  if (footholdIds.length === 0) return result
  const placeholders = footholdIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT foothold_id, internal_host_id FROM foothold_hosts
       WHERE foothold_id IN (${placeholders})
       ORDER BY foothold_id ASC, discovered_at ASC, internal_host_id ASC`,
    )
    .all(...footholdIds)
  for (const row of rows) {
    const bucket = result.get(row.foothold_id)
    if (bucket === undefined) result.set(row.foothold_id, [row.internal_host_id])
    else bucket.push(row.internal_host_id)
  }
  return result
}

function loadPivotHops(db, pivotIds) {
  const result = new Map()
  if (pivotIds.length === 0) return result
  const placeholders = pivotIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT pivot_id, seq, ref_kind, ref_id, label, via FROM pivot_hops
       WHERE pivot_id IN (${placeholders}) ORDER BY pivot_id ASC, seq ASC`,
    )
    .all(...pivotIds)
  for (const row of rows) {
    const hop = {
      seq: row.seq,
      ref_kind: row.ref_kind === 'internal_service' ? 'internal_service' : 'internal_host',
      ref_id: row.ref_id,
      label: row.label,
      via: row.via,
    }
    const bucket = result.get(row.pivot_id)
    if (bucket === undefined) result.set(row.pivot_id, [hop])
    else bucket.push(hop)
  }
  return result
}

function loadPivotReachability(db, pivotIds) {
  const result = new Map()
  if (pivotIds.length === 0) return result
  const placeholders = pivotIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT pivot_id, cidr FROM pivot_reachability
       WHERE pivot_id IN (${placeholders}) ORDER BY pivot_id ASC, cidr ASC`,
    )
    .all(...pivotIds)
  for (const row of rows) {
    const bucket = result.get(row.pivot_id)
    if (bucket === undefined) result.set(row.pivot_id, [row.cidr])
    else bucket.push(row.cidr)
  }
  return result
}

/* ------------------------------------------- Memory Nebula graph reads -- */

function listGraphVulnerabilities(db, limit, host, realm = 'web') {
  const bounded = clampLimit(limit, GRAPH_MAX_VULNERABILITIES)
  const columns = `
    id, host, service_host, realm, internal_service_id, vuln_name, vuln_type, severity,
    status, target_url, created_at, related_vuln_ids,
    substr(COALESCE(reproduction_steps, ''), 1, ${GRAPH_REPRODUCTION_PREVIEW_CHARS}) AS reproduction_steps
  `
  const rows =
    host === undefined
      ? db
          .prepare(
            `SELECT ${columns} FROM vulnerabilities WHERE realm = ? ORDER BY created_at DESC, id ASC LIMIT ?`,
          )
          .all(realm, bounded)
      : db
          .prepare(
            `SELECT ${columns} FROM vulnerabilities WHERE lower(host) = lower(?) AND realm = ? ORDER BY created_at DESC, id ASC LIMIT ?`,
          )
          .all(host, realm, bounded)
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
    related_vuln_ids: parseJsonArray(row.related_vuln_ids),
  }))
}

function countVulnerabilities(db, realm = 'all') {
  const row =
    realm === 'all'
      ? db.prepare('SELECT COUNT(*) AS count FROM vulnerabilities').get()
      : db.prepare('SELECT COUNT(*) AS count FROM vulnerabilities WHERE realm = ?').get(realm)
  return row && Number.isFinite(Number(row.count)) ? Number(row.count) : 0
}

function listAssetsForGraph(db, limit) {
  const bounded = clampLimit(limit, GRAPH_MAX_HOSTS)
  const rows = db
    .prepare('SELECT * FROM assets ORDER BY last_seen DESC, host_port ASC LIMIT ?')
    .all(bounded)
  return rows.map(mapAssetRow)
}

function countAssets(db) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM assets').get()
  return row && Number.isFinite(Number(row.count)) ? Number(row.count) : 0
}

function listGraphSnapshots(db, limit, parentSessionId) {
  const bounded = clampLimit(limit, GRAPH_MAX_SNAPSHOTS)
  const where = parentSessionId === undefined ? '' : 'WHERE s.parent_session_id = @parentSessionId'
  const params = { limit: bounded }
  if (parentSessionId !== undefined) params.parentSessionId = parentSessionId
  const rows = db
    .prepare(
      `SELECT ${SNAPSHOT_SELECT_COLUMNS}
       FROM snapshot_sessions s
       ${where}
       ORDER BY s.updated_at DESC, s.session_id DESC
       LIMIT @limit`,
    )
    .all(params)
  return rows.map(mapSnapshotRow)
}

function countSnapshotSessions(db) {
  const row = db.prepare('SELECT COUNT(*) AS total FROM snapshot_sessions').get()
  return row && Number.isFinite(Number(row.total)) ? Number(row.total) : 0
}

function getAssetDetail(db, hostPort) {
  const key = normalizeAssetIdentifier(hostPort)
  const row = db.prepare('SELECT * FROM assets WHERE host_port = ?').get(key)
  return row ? mapAssetRow(row) : null
}

function getSnapshotSession(db, sessionId) {
  const row = db
    .prepare(`SELECT ${SNAPSHOT_SELECT_COLUMNS} FROM snapshot_sessions s WHERE s.session_id = ?`)
    .get(sessionId)
  return row ? mapSnapshotRow(row) : null
}

function listGraphInternalFootholds(db, limit) {
  const bounded = clampLimit(limit, GRAPH_MAX_FOOTHOLDS)
  const rows = db
    .prepare(`SELECT ${FOOTHOLD_SELECT} FROM footholds ORDER BY updated_at DESC, id ASC LIMIT ?`)
    .all(bounded)
  const hostIds = loadFootholdHostIds(
    db,
    rows.map((row) => row.id),
  )
  return rows.map((row) => mapFootholdRow(row, hostIds.get(row.id) ?? []))
}

function countTableRows(db, tableName) {
  // The table name is never user input: the only callers pass a literal below.
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()
  return row && Number.isFinite(Number(row.count)) ? Number(row.count) : 0
}

const countFootholds = (db) => countTableRows(db, 'footholds')
const countInternalHosts = (db) => countTableRows(db, 'internal_hosts')
const countInternalServices = (db) => countTableRows(db, 'internal_services')

function listGraphInternalHosts(db, limit) {
  const bounded = clampLimit(limit, GRAPH_MAX_INTERNAL_HOSTS)
  const rows = db
    .prepare(
      `SELECT ${INTERNAL_HOST_SELECT} FROM internal_hosts h
       ORDER BY h.last_seen DESC, h.ip ASC LIMIT ?`,
    )
    .all(bounded)
  return rows.map(mapInternalHostRow)
}

function listGraphInternalServices(db, limit) {
  const bounded = clampLimit(limit, GRAPH_MAX_INTERNAL_SERVICES)
  const rows = db
    .prepare(
      `SELECT ${INTERNAL_SERVICE_SELECT} FROM internal_services s
       JOIN internal_hosts h ON h.id = s.host_id
       ORDER BY h.ip ASC, s.port ASC LIMIT ?`,
    )
    .all(bounded)
  return rows.map(mapInternalServiceRow)
}

function listGraphInternalPivots(db, limit) {
  const bounded = clampLimit(limit, GRAPH_MAX_INTERNAL_PIVOTS)
  const rows = db
    .prepare(`SELECT ${PIVOT_SELECT} FROM pivots ORDER BY updated_at DESC, id ASC LIMIT ?`)
    .all(bounded)
  const ids = rows.map((row) => row.id)
  const hops = loadPivotHops(db, ids)
  const subnets = loadPivotReachability(db, ids)
  return rows.map((row) => mapPivotRow(row, hops.get(row.id) ?? [], subnets.get(row.id) ?? []))
}

/** Web assets referenced by at least one foothold (internal graph attribution). */
function listGraphInternalEntryAssets(db, limit) {
  const bounded = clampLimit(limit, GRAPH_MAX_HOSTS)
  const rows = db
    .prepare(
      `SELECT * FROM assets
       WHERE host_port IN (SELECT entry_host_port FROM footholds)
       ORDER BY last_seen DESC, host_port ASC LIMIT ?`,
    )
    .all(bounded)
  return rows.map(mapAssetRow)
}

/* -------------------------------------- Internal operations read models -- */

function listInternalProjects(db) {
  const rows = db
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
      `,
    )
    .all()
  return rows.map((row) => ({
    project_name: row.project_name,
    counts: countInternalScope(db, row.project_name),
  }))
}

function countInternalScope(db, project) {
  const row = db
    .prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM footholds WHERE project_name = @project) AS footholds,
        (SELECT COUNT(*) FROM internal_hosts WHERE project_name = @project) AS hosts,
        (SELECT COUNT(*) FROM internal_services WHERE project_name = @project) AS services,
        (SELECT COUNT(*) FROM credentials WHERE project_name = @project) AS credentials,
        (SELECT COUNT(*) FROM pivots WHERE project_name = @project) AS pivots
      `,
    )
    .get({ project })
  return {
    footholds: row?.footholds ?? 0,
    hosts: row?.hosts ?? 0,
    services: row?.services ?? 0,
    credentials: row?.credentials ?? 0,
    pivots: row?.pivots ?? 0,
  }
}

function listFootholds(db, project, limit = INTERNAL_LIMITS.footholds) {
  const bounded = clampLimit(limit, GRAPH_MAX_FOOTHOLDS)
  const rows = db
    .prepare(
      `SELECT ${FOOTHOLD_SELECT} FROM footholds WHERE project_name = ?
       ORDER BY updated_at DESC, id ASC LIMIT ?`,
    )
    .all(project, bounded)
  const hostIds = loadFootholdHostIds(
    db,
    rows.map((row) => row.id),
  )
  return rows.map((row) => mapFootholdRow(row, hostIds.get(row.id) ?? []))
}

function listInternalHosts(db, project, limit = INTERNAL_LIMITS.hosts) {
  const bounded = clampLimit(limit, GRAPH_MAX_INTERNAL_HOSTS)
  const rows = db
    .prepare(
      `SELECT ${INTERNAL_HOST_SELECT} FROM internal_hosts h WHERE h.project_name = ?
       ORDER BY h.last_seen DESC, h.ip ASC LIMIT ?`,
    )
    .all(project, bounded)
  return rows.map(mapInternalHostRow)
}

function listInternalServices(db, project, limit = INTERNAL_LIMITS.services) {
  const bounded = clampLimit(limit, GRAPH_MAX_INTERNAL_SERVICES)
  const rows = db
    .prepare(
      `SELECT ${INTERNAL_SERVICE_SELECT} FROM internal_services s
       JOIN internal_hosts h ON h.id = s.host_id
       WHERE s.project_name = ? ORDER BY h.ip ASC, s.port ASC LIMIT ?`,
    )
    .all(project, bounded)
  return rows.map(mapInternalServiceRow)
}

/** Masked credential projection: the raw secret never leaves this module. */
function listCredentials(db, project, limit = INTERNAL_LIMITS.credentials) {
  const bounded = clampLimit(limit, GRAPH_MAX_INTERNAL_SERVICES)
  const rows = db
    .prepare(
      `SELECT ${CREDENTIAL_SELECT} FROM credentials WHERE project_name = ?
       ORDER BY updated_at DESC, id ASC LIMIT ?`,
    )
    .all(project, bounded)
  return rows.map(mapCredentialRow)
}

function listPivots(db, project, limit = INTERNAL_LIMITS.pivots) {
  const bounded = clampLimit(limit, GRAPH_MAX_INTERNAL_PIVOTS)
  const rows = db
    .prepare(
      `SELECT ${PIVOT_SELECT} FROM pivots WHERE project_name = ?
       ORDER BY updated_at DESC, id ASC LIMIT ?`,
    )
    .all(project, bounded)
  const ids = rows.map((row) => row.id)
  const hops = loadPivotHops(db, ids)
  const subnets = loadPivotReachability(db, ids)
  return rows.map((row) => mapPivotRow(row, hops.get(row.id) ?? [], subnets.get(row.id) ?? []))
}

function listCredentialTrials(db, project, limit = INTERNAL_TRIALS_LIMIT) {
  const bounded = clampLimit(limit, 500)
  const rows = db
    .prepare(
      `SELECT t.id, t.credential_id, t.service_id, t.action, t.status, t.notes, t.attempted_at
       FROM credential_trials t
       JOIN credentials c ON c.id = t.credential_id
       WHERE c.project_name = ?
       ORDER BY t.attempted_at DESC, t.id ASC LIMIT ?`,
    )
    .all(project, bounded)
  return rows.map(mapCredentialTrialRow)
}

/** Internal vulnerability rows for one project (or every project when null). */
function internalVulnerabilityFilter(project) {
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
    params: { project },
  }
}

function listInternalVulnerabilities(db, project, limit = INTERNAL_LIMITS.internalVulns) {
  const bounded = clampLimit(limit, GRAPH_MAX_VULNERABILITIES)
  const filter = internalVulnerabilityFilter(project)
  const statement = db.prepare(
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
     LIMIT @limit`,
  )
  const rows =
    Object.keys(filter.params).length > 0
      ? statement.all({ ...filter.params, limit: bounded })
      : statement.all({ limit: bounded })
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
    created_at: row.created_at,
  }))
}

function countInternalVulnerabilities(db, project) {
  const filter = internalVulnerabilityFilter(project)
  const statement = db.prepare(
    `SELECT COUNT(*) AS count FROM vulnerabilities WHERE ${filter.clause}`,
  )
  const row =
    Object.keys(filter.params).length > 0 ? statement.get(filter.params) : statement.get()
  return row && Number.isFinite(Number(row.count)) ? Number(row.count) : 0
}

/** Legacy internal vulnerabilities that still lack an internal service link. */
function countUnnormalizedInternalVulnerabilities(db, project) {
  const filter = internalVulnerabilityFilter(project)
  const statement = db.prepare(
    `SELECT COUNT(*) AS count FROM vulnerabilities
     WHERE ${filter.clause} AND internal_service_id = ''`,
  )
  const row =
    Object.keys(filter.params).length > 0 ? statement.get(filter.params) : statement.get()
  return row && Number.isFinite(Number(row.count)) ? Number(row.count) : 0
}

function countLootImports(db, project) {
  const trimmed = (project ?? '').trim()
  const row =
    trimmed.length === 0
      ? db.prepare('SELECT COUNT(*) AS count FROM loot_imports').get()
      : db.prepare('SELECT COUNT(*) AS count FROM loot_imports WHERE project_name = ?').get(trimmed)
  return row && Number.isFinite(Number(row.count)) ? Number(row.count) : 0
}

function listLootImports(db, projectName) {
  const trimmed = (projectName ?? '').trim()
  const limit = INTERNAL_LIMITS.lootImports
  const rows =
    trimmed.length === 0
      ? db
          .prepare(
            `SELECT id, project_name, entry_host_port, filename, sha256, format, parser,
               status, summary_json, error, created_at
             FROM loot_imports ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(limit)
      : db
          .prepare(
            `SELECT id, project_name, entry_host_port, filename, sha256, format, parser,
               status, summary_json, error, created_at
             FROM loot_imports WHERE project_name = ?
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(trimmed, limit)
  return rows.map(mapLootImportRow)
}

function getInternalOverview(db, projectName) {
  const projects = listInternalProjects(db)
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
      projects,
    }
  }

  const scopeCounts = countInternalScope(db, project)
  const counts = {
    ...scopeCounts,
    internal_vulns: countInternalVulnerabilities(db, project),
    loot_imports: countLootImports(db, project),
  }
  const warnings = []
  const footholds = listFootholds(db, project, INTERNAL_OVERVIEW_LIST_LIMIT)
  const hosts = listInternalHosts(db, project, INTERNAL_OVERVIEW_LIST_LIMIT)
  const services = listInternalServices(db, project, INTERNAL_OVERVIEW_LIST_LIMIT)
  const credentials = listCredentials(db, project, INTERNAL_OVERVIEW_LIST_LIMIT)
  const pivots = listPivots(db, project, INTERNAL_OVERVIEW_LIST_LIMIT)
  const trials = listCredentialTrials(db, project)
  const internalVulns = listInternalVulnerabilities(db, project, INTERNAL_OVERVIEW_LIST_LIMIT)
  const lootImports = listLootImports(db, project)

  if (scopeCounts.hosts > hosts.length) {
    warnings.push(
      `内网主机共 ${scopeCounts.hosts} 台，概览仅展示最近 ${hosts.length} 台；完整视图见内网作战页`,
    )
  }
  if (scopeCounts.services > services.length) {
    warnings.push(`内网服务共 ${scopeCounts.services} 个，概览仅展示前 ${services.length} 个`)
  }
  if (scopeCounts.footholds > footholds.length) {
    warnings.push(`foothold 共 ${scopeCounts.footholds} 条，概览仅展示前 ${footholds.length} 条`)
  }
  const unnormalized = countUnnormalizedInternalVulnerabilities(db, project)
  if (unnormalized > 0) {
    warnings.push(
      `存在 ${unnormalized} 条内网漏洞只有 service_host、缺少 internal_service_id（待归一化）：请在下一次上报时用 sync_internal_scope 登记内网服务，并在 save_vulnerability 中补 internal_service_id`,
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
    projects,
  }
}

function getInternalGraph(db, projectName) {
  const project = (projectName ?? '').trim()
  if (project.length === 0) throw badRequest('project_name 不能为空', { field: 'project_name' })
  const scopeCounts = countInternalScope(db, project)
  const counts = {
    ...scopeCounts,
    internal_vulns: countInternalVulnerabilities(db, project),
    loot_imports: countLootImports(db, project),
  }
  const warnings = []
  const footholds = listFootholds(db, project, INTERNAL_LIMITS.footholds)
  const hosts = listInternalHosts(db, project, INTERNAL_LIMITS.hosts)
  const services = listInternalServices(db, project, INTERNAL_LIMITS.services)
  const credentials = listCredentials(db, project, INTERNAL_LIMITS.credentials)
  const pivots = listPivots(db, project, INTERNAL_LIMITS.pivots)
  const trials = listCredentialTrials(db, project)
  const truncated =
    scopeCounts.hosts > hosts.length ||
    scopeCounts.services > services.length ||
    scopeCounts.credentials > credentials.length ||
    scopeCounts.pivots > pivots.length ||
    scopeCounts.footholds > footholds.length
  if (truncated) {
    warnings.push(
      '内网作战视图已按性能上限截断（主机 ≤300 / 服务 ≤1000 / 凭据 ≤500 / pivot ≤100），请按网段或项目缩小范围',
    )
  }
  const unnormalized = countUnnormalizedInternalVulnerabilities(db, project)
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
    warnings,
  }
}

/* --------------------------------------------------------- write (trial) -- */

/**
 * Record one observed credential trial. This is the only write in this module:
 * it appends a `credential_trials` row (the desktop UI never auto-attempts a
 * credential; the human records what happened elsewhere). Validation mirrors
 * the shared `RecordCredentialTrialInputSchema`, and the credential / service
 * references must exist and belong to the same project.
 */
function insertCredentialTrial(db, input) {
  const parsed = RecordCredentialTrialInputSchema.safeParse(input)
  if (!parsed.success) {
    throw badRequest(
      `凭据尝试记录参数校验失败: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      { field: 'credential_id' },
    )
  }
  const trial = parsed.data
  const credential = db
    .prepare('SELECT id, project_name FROM credentials WHERE id = ?')
    .get(trial.credential_id)
  if (credential === undefined) {
    throw notFound(`未找到凭据 ${trial.credential_id}`)
  }
  if (trial.service_id !== undefined && trial.service_id.length > 0) {
    const service = db
      .prepare('SELECT id, project_name FROM internal_services WHERE id = ?')
      .get(trial.service_id)
    if (service === undefined || service.project_name !== credential.project_name) {
      throw badRequest(
        `service_id ${trial.service_id} 不存在于凭据所属项目「${credential.project_name}」`,
        { field: 'service_id' },
      )
    }
  }
  const id = generateInternalId('TR-')
  const attemptedAt = new Date().toISOString()
  const serviceId =
    trial.service_id !== undefined && trial.service_id.length > 0 ? trial.service_id : null
  db.prepare(
    `INSERT INTO credential_trials (
       id, credential_id, service_id, action, status, notes, attempted_at
     ) VALUES (@id, @credential_id, @service_id, @action, @status, @notes, @attempted_at)`,
  ).run({
    id,
    credential_id: trial.credential_id,
    service_id: serviceId,
    action: trial.action,
    status: trial.status,
    notes: trial.notes,
    attempted_at: attemptedAt,
  })
  return mapCredentialTrialRow({
    id,
    credential_id: trial.credential_id,
    service_id: serviceId,
    action: trial.action,
    status: trial.status,
    notes: trial.notes,
    attempted_at: attemptedAt,
  })
}

/* ----------------------------------------------------------------- API -- */

/**
 * Create the adapter the graph builder + internal endpoints need.
 *
 * @param {{db?: import('node:sqlite').DatabaseSync,
 *          withWriteTransaction?: (fn: (db: any) => any) => Promise<any>,
 *          assertWritable?: () => void}} holder
 *   The plugin `DatabaseHolder` (connection + write transaction helpers). A plain
 *   `{ db }` object also works for tests / ad-hoc read-only projections.
 */
export function createGraphDatabaseAdapter(holder) {
  const connection = () => {
    const db = holder && holder.db
    if (!db) throw new Error('Cortex database connection is not available')
    return db
  }
  const runWrite = async (fn) => {
    if (holder && typeof holder.withWriteTransaction === 'function') {
      return holder.withWriteTransaction(fn)
    }
    return fn(connection())
  }

  return {
    /* -- methods called by the vendored buildMemoryGraph.ts builder (sync) -- */
    listGraphVulnerabilities: (limit, host, realm) =>
      listGraphVulnerabilities(connection(), limit, host, realm),
    countVulnerabilities: (realm) => countVulnerabilities(connection(), realm),
    listAssetsForGraph: (limit) => listAssetsForGraph(connection(), limit),
    countAssets: () => countAssets(connection()),
    listGraphSnapshots: (limit, parentSessionId) =>
      listGraphSnapshots(connection(), limit, parentSessionId),
    countSnapshotSessions: () => countSnapshotSessions(connection()),
    getAssetDetail: (hostPort) => getAssetDetail(connection(), hostPort),
    getSnapshotSession: (sessionId) => getSnapshotSession(connection(), sessionId),
    listGraphInternalFootholds: (limit) => listGraphInternalFootholds(connection(), limit),
    countFootholds: () => countFootholds(connection()),
    listGraphInternalHosts: (limit) => listGraphInternalHosts(connection(), limit),
    countInternalHosts: () => countInternalHosts(connection()),
    listGraphInternalServices: (limit) => listGraphInternalServices(connection(), limit),
    countInternalServices: () => countInternalServices(connection()),
    listGraphInternalPivots: (limit) => listGraphInternalPivots(connection(), limit),
    /** Referenced by the builder's internal layer; missing from the task list but required. */
    listGraphInternalEntryAssets: (limit) => listGraphInternalEntryAssets(connection(), limit),

    /* ----------------------- internal operations read projections -------- */
    listInternalProjects: () => listInternalProjects(connection()),
    countInternalScope: (project) => countInternalScope(connection(), project),
    listFootholds: (project, limit) => listFootholds(connection(), project, limit),
    listInternalHosts: (project, limit) => listInternalHosts(connection(), project, limit),
    listInternalServices: (project, limit) => listInternalServices(connection(), project, limit),
    listCredentials: (project, limit) => listCredentials(connection(), project, limit),
    listPivots: (project, limit) => listPivots(connection(), project, limit),
    listCredentialTrials: (project, limit) => listCredentialTrials(connection(), project, limit),
    listInternalVulnerabilities: (project, limit) =>
      listInternalVulnerabilities(connection(), project, limit),
    countInternalVulnerabilities: (project) =>
      countInternalVulnerabilities(connection(), project),
    countUnnormalizedInternalVulnerabilities: (project) =>
      countUnnormalizedInternalVulnerabilities(connection(), project),
    countLootImports: (project) => countLootImports(connection(), project),
    listLootImports: (projectName) => listLootImports(connection(), projectName),
    getInternalOverview: (projectName) => getInternalOverview(connection(), projectName),
    getInternalGraph: (projectName) => getInternalGraph(connection(), projectName),

    /* ----------------------------- explicit append-only write ------------ */
    recordCredentialTrial: (input) =>
      runWrite((db) => insertCredentialTrial(db, input)),
  }
}
