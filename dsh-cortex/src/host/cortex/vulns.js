/**
 * Host handlers for the ported Cortex UI: vulnerabilities + dashboard stats.
 *
 * Every response is the **JSON form of the shared TypeScript contract** in
 * `src/cortex-ui/shared/types.ts` (snake_case field names):
 *   - GET    /vulns                -> PaginatedVulnerabilities
 *   - GET    /vulns/:id            -> Vulnerability | null
 *   - GET    /stats?realm=         -> DashboardStats
 *   - PATCH  /vulns/:id/status     -> Vulnerability
 *   - DELETE /vulns/:id            -> DeleteVulnResult
 *   - POST   /vulns/delete-many    -> DeleteVulnsResult
 *   - POST   /vulns/export         -> ExportReportsResult
 *
 * This module also exports the small row -> shared-shape mappers that the
 * sibling handler modules reuse (assets / snapshots), so the mapping logic is
 * defined once.
 *
 * Rules: parameterized SQL only, `status` is the only column mutated here, all
 * deletes run inside `DatabaseHolder.withWriteTransaction`, and no response
 * ever contains a credential secret (this module never reads that table).
 */

import {
  MAX_SEARCH_VALUE,
  badRequest,
  notFound,
  queryEnum,
  queryInt,
  queryString,
  readJsonBody,
  requireBodyEnum,
  safeDecode,
  sendJson,
} from '../http.js'
import * as dto from '../dto.js'
import { buildVulnReport, reportFilename } from '../reports.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']
const STATUSES = ['Confirmed', 'Inconclusive', 'Retest_Passed']
const REALM_FILTERS = ['web', 'internal', 'all']

const DEFAULT_PAGE_SIZE = 10
/** The Cortex renderer itself asks for pageSize=200 on the retest page. */
const CORTEX_MAX_PAGE_SIZE = 500
const MAX_ID_LENGTH = 100
const MAX_BULK_IDS = 500
const MAX_HOST_FILTER = 255
const MAX_EXPORT_IDS = 200

const VULN_ORDER = 'ORDER BY created_at DESC, rowid DESC'

/** INSERT/UPDATE never touch created_at in this module (status only). */
const SEVERITY_RANK_SQL =
  "CASE severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 WHEN 'Info' THEN 4 ELSE 5 END"

/* ------------------------------------------------------------------------- */
/* Row -> shared-shape mappers                                               */
/* ------------------------------------------------------------------------- */

/** @param {unknown} value */
export function text(value) {
  return value === null || value === undefined ? '' : String(value)
}

/** @param {unknown} value @returns {number} */
function int(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/**
 * Defensive JSON array parse: corrupt data degrades to `[]`.
 * @param {unknown} raw
 * @returns {any[]}
 */
export function jsonArray(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Defensive JSON object parse: corrupt data / arrays / primitives -> null.
 * @param {unknown} raw
 * @returns {Record<string, any>|null}
 */
export function jsonObject(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Coerce a JSON column to a string[] (drops non-string entries). */
function stringArray(raw) {
  return jsonArray(raw).filter((item) => typeof item === 'string')
}

/** Escape `%`, `_`, `\` for a SQL `LIKE ? ESCAPE '\'` pattern. */
export function likePattern(search) {
  const escaped = String(search).replace(/[\\%_]/g, (match) => `\\${match}`)
  return `%${escaped}%`
}

/**
 * Normalize the append-only retest history to the shared `RetestResult[]`
 * shape (`time_range` / `conclusion`, older camelCase rows accepted).
 * @param {unknown} raw
 * @returns {{time_range:string, conclusion:string}[]}
 */
function retestList(raw) {
  const out = []
  for (const entry of jsonArray(raw)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    out.push({
      time_range: text(entry.time_range ?? entry.timeRange),
      conclusion: text(entry.conclusion),
    })
  }
  return out
}

/**
 * Compact row for `VulnerabilityListItem` (dashboard table / related lists).
 * @param {Record<string, any>} row
 */
export function vulnListItem(row) {
  const source = row || {}
  return {
    id: text(source.id),
    host: text(source.host),
    service_host: text(source.service_host),
    realm: text(source.realm) || 'web',
    internal_service_id: text(source.internal_service_id),
    entry_point: text(source.entry_point),
    vuln_name: text(source.vuln_name),
    vuln_type: text(source.vuln_type),
    severity: text(source.severity),
    target_url: text(source.target_url),
    status: text(source.status),
    created_at: text(source.created_at),
  }
}

/**
 * Full `Vulnerability` row. Every field of the shared interface is present.
 * @param {Record<string, any>} row
 */
export function vulnDetail(row) {
  const source = row || {}
  return {
    ...vulnListItem(source),
    description: text(source.description),
    impact: text(source.impact),
    affected_interfaces: stringArray(source.affected_interfaces),
    reproduction_steps: text(source.reproduction_steps),
    remediation: stringArray(source.remediation),
    crypto_details: text(source.crypto_details),
    test_boundaries: text(source.test_boundaries),
    retest_results: retestList(source.retest_results),
    related_vuln_ids: stringArray(source.related_vuln_ids),
  }
}

/* ------------------------------------------------------------------------- */
/* Query helpers                                                             */
/* ------------------------------------------------------------------------- */

/** @param {import('node:http').ServerHttp2Stream|URLSearchParams} searchParams */
function realmFilter(searchParams) {
  return queryEnum(searchParams, 'realm', REALM_FILTERS) ?? 'all'
}

/**
 * The Cortex renderer's filter state uses the literal `all` for "no filter"
 * (severity/status selects). Accept it as absence while keeping strict
 * validation for every other value.
 * @param {URLSearchParams} searchParams
 * @param {string} key
 * @param {readonly string[]} allowed
 */
function enumFilter(searchParams, key, allowed) {
  const value = queryEnum(searchParams, key, [...allowed, 'all'])
  return value === 'all' ? undefined : value
}

/**
 * Safe ORDER BY builder for the optional `sort` query parameter.
 * Accepted forms: `field` (ASC) / `-field` (DESC); whitelisted fields only.
 * @param {string|undefined} sort
 */
function orderClause(sort) {
  if (sort === undefined || sort === null || String(sort).trim().length === 0) return VULN_ORDER
  const raw = String(sort).trim()
  const desc = raw.startsWith('-')
  const field = (desc ? raw.slice(1) : raw).trim().toLowerCase().replace(/[\s-]+/g, '_')
  const dir = desc ? 'DESC' : 'ASC'
  switch (field) {
    case 'created_at':
    case 'createdat':
    case 'created':
      return `ORDER BY created_at ${dir}, rowid ${dir}`
    case 'severity':
      return `ORDER BY ${SEVERITY_RANK_SQL} ${dir}, created_at DESC, rowid DESC`
    case 'status':
      return `ORDER BY status ${dir}, created_at DESC, rowid DESC`
    case 'host':
      return `ORDER BY host ${dir}, created_at DESC, rowid DESC`
    case 'vuln_name':
    case 'name':
      return `ORDER BY vuln_name ${dir}, created_at DESC, rowid DESC`
    case 'vuln_type':
    case 'type':
      return `ORDER BY vuln_type ${dir}, created_at DESC, rowid DESC`
    case 'target_url':
      return `ORDER BY target_url ${dir}, created_at DESC, rowid DESC`
    default:
      throw badRequest('sort is not supported', {
        param: 'sort',
        allowed: [
          'created_at',
          '-created_at',
          'severity',
          '-severity',
          'status',
          '-status',
          'host',
          '-host',
          'vuln_name',
          '-vuln_name',
          'vuln_type',
          '-vuln_type',
          'target_url',
          '-target_url',
        ],
      })
  }
}

/** Local `YYYY-MM-DD` day start as a UTC ISO string (for `today`). */
function localDayStartIso() {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return start.toISOString()
}

/** @param {Record<string, any>[]} rows */
function relatedByIds(db, rawIds) {
  const ids = []
  for (const value of jsonArray(rawIds)) {
    if (typeof value === 'string' && value.length > 0 && !ids.includes(value)) ids.push(value)
  }
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db.prepare(`SELECT * FROM vulnerabilities WHERE id IN (${placeholders})`).all(...ids)
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  const out = []
  for (const id of ids) {
    const found = byId.get(id)
    if (found) out.push(vulnListItem(found))
  }
  return out
}

/* ------------------------------------------------------------------------- */
/* Handlers                                                                  */
/* ------------------------------------------------------------------------- */

/** GET /vulns -> PaginatedVulnerabilities */
export function handleList({ res, searchParams, holder }) {
  const realm = realmFilter(searchParams)
  const severity = enumFilter(searchParams, 'severity', SEVERITIES)
  const status = enumFilter(searchParams, 'status', STATUSES)
  const search = queryString(searchParams, 'search', { max: MAX_SEARCH_VALUE }) ?? ''
  const host = queryString(searchParams, 'host', { max: MAX_HOST_FILTER }) ?? ''
  const page = queryInt(searchParams, 'page', { min: 1, max: 100_000 }) ?? 1
  const pageSize =
    queryInt(searchParams, 'pageSize', { min: 1, max: CORTEX_MAX_PAGE_SIZE }) ?? DEFAULT_PAGE_SIZE
  const sort = queryString(searchParams, 'sort', { max: 100 })
  const order = orderClause(sort)

  const where = []
  /** @type {any[]} */
  const params = []
  if (realm !== 'all') {
    where.push('realm = ?')
    params.push(realm)
  }
  for (const [column, value] of [
    ['severity', severity],
    ['status', status],
  ]) {
    if (value !== undefined) {
      where.push(`${column} = ?`)
      params.push(value)
    }
  }
  if (host.length > 0) {
    where.push('host = ?')
    params.push(host)
  }
  if (search.length > 0) {
    const pattern = likePattern(search)
    where.push(
      "(id LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\' OR vuln_name LIKE ? ESCAPE '\\' " +
        "OR vuln_type LIKE ? ESCAPE '\\' OR target_url LIKE ? ESCAPE '\\' OR service_host LIKE ? ESCAPE '\\')",
    )
    for (let i = 0; i < 6; i += 1) params.push(pattern)
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const db = holder.db

  const total = int(db.prepare(`SELECT COUNT(*) AS c FROM vulnerabilities${whereSql}`).get(...params).c)
  const pages = total === 0 ? 0 : Math.ceil(total / pageSize)
  const effectivePage = total === 0 ? 1 : Math.min(page, pages)
  const rows = db
    .prepare(`SELECT * FROM vulnerabilities${whereSql} ${order} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (effectivePage - 1) * pageSize)

  sendJson(res, 200, {
    items: rows.map(vulnListItem),
    total,
    page: effectivePage,
    pageSize,
  })
}

/** GET /vulns/:id -> Vulnerability | null */
export function handleGet({ res, params, holder }) {
  const id = safeDecode(params[0], 'vulnerability id')
  if (id.length === 0) throw badRequest('vulnerability id is required')
  if (id.length > MAX_ID_LENGTH) throw badRequest('vulnerability id is too long', { max: MAX_ID_LENGTH })
  const row = holder.db.prepare('SELECT * FROM vulnerabilities WHERE id = ?').get(id)
  sendJson(res, 200, row ? vulnDetail(row) : null)
}

/** GET /stats?realm= -> DashboardStats */
export function handleStats({ res, searchParams, holder }) {
  const realm = realmFilter(searchParams)
  const db = holder.db

  const realmWhere = realm === 'all' ? '' : ' WHERE realm = ?'
  const realmParams = realm === 'all' ? [] : [realm]

  const scopedCount = int(
    db.prepare(`SELECT COUNT(*) AS c FROM vulnerabilities${realmWhere}`).get(...realmParams).c,
  )

  const bySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const row of db
    .prepare(`SELECT severity, COUNT(*) AS c FROM vulnerabilities${realmWhere} GROUP BY severity`)
    .all(...realmParams)) {
    if (Object.prototype.hasOwnProperty.call(bySeverity, row.severity)) {
      bySeverity[row.severity] = int(row.c)
    }
  }

  const byStatus = { Confirmed: 0, Inconclusive: 0, Retest_Passed: 0 }
  for (const row of db
    .prepare(`SELECT status, COUNT(*) AS c FROM vulnerabilities${realmWhere} GROUP BY status`)
    .all(...realmParams)) {
    if (Object.prototype.hasOwnProperty.call(byStatus, row.status)) {
      byStatus[row.status] = int(row.c)
    }
  }

  const todayWhere = realm === 'all' ? 'created_at >= ?' : 'realm = ? AND created_at >= ?'
  const todayParams = realm === 'all' ? [localDayStartIso()] : [realm, localDayStartIso()]
  const today = int(
    db.prepare(`SELECT COUNT(*) AS c FROM vulnerabilities WHERE ${todayWhere}`).get(...todayParams).c,
  )

  // "Affected hosts": distinct entry hosts of the scoped vulnerabilities (the
  // dashboard shows an average of findings per affected host).
  const hosts = int(
    db
      .prepare(
        `SELECT COUNT(DISTINCT host) AS c FROM vulnerabilities WHERE host <> ''${
          realm === 'all' ? '' : ' AND realm = ?'
        }`,
      )
      .get(...(realm === 'all' ? [] : [realm])).c,
  )

  const internalRow = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN severity = 'Critical' THEN 1 ELSE 0 END), 0) AS critical,
              COALESCE(SUM(CASE WHEN severity = 'High' THEN 1 ELSE 0 END), 0) AS high,
              COUNT(DISTINCT CASE WHEN host <> '' THEN host END) AS hosts
         FROM vulnerabilities WHERE realm = 'internal'`,
    )
    .get()

  sendJson(res, 200, {
    total: scopedCount,
    critical: bySeverity.Critical,
    high: bySeverity.High,
    hosts,
    today,
    bySeverity,
    byStatus,
    internal: {
      total: int(internalRow.total),
      critical: int(internalRow.critical),
      high: int(internalRow.high),
      hosts: int(internalRow.hosts),
    },
  })
}

/** PATCH /vulns/:id/status -> Vulnerability */
export async function handleUpdateStatus({ req, res, params, holder, bumpRev }) {
  const id = safeDecode(params[0], 'vulnerability id')
  if (id.length === 0) throw badRequest('vulnerability id is required')
  if (id.length > MAX_ID_LENGTH) throw badRequest('vulnerability id is too long', { max: MAX_ID_LENGTH })
  const body = await readJsonBody(req)
  const status = requireBodyEnum(body, 'status', STATUSES)

  const changes = await holder.withWriteTransaction((db) =>
    int(db.prepare('UPDATE vulnerabilities SET status = ? WHERE id = ?').run(status, id).changes),
  )
  if (changes === 0) throw notFound('vulnerability not found')
  bumpRev()
  const row = holder.db.prepare('SELECT * FROM vulnerabilities WHERE id = ?').get(id)
  sendJson(res, 200, vulnDetail(row))
}

/** DELETE /vulns/:id -> DeleteVulnResult */
export async function handleDelete({ res, params, holder, bumpRev }) {
  const id = safeDecode(params[0], 'vulnerability id')
  if (id.length === 0) throw badRequest('vulnerability id is required')
  if (id.length > MAX_ID_LENGTH) throw badRequest('vulnerability id is too long', { max: MAX_ID_LENGTH })
  const changes = await holder.withWriteTransaction((db) =>
    int(db.prepare('DELETE FROM vulnerabilities WHERE id = ?').run(id).changes),
  )
  bumpRev()
  sendJson(res, 200, { deleted: changes > 0 })
}

/**
 * Parse a JSON body `{ ids: string[] }` with strict validation.
 * @param {Record<string, unknown>} body
 * @param {string} field
 * @param {number} max
 */
function requireIdList(body, field, max) {
  const value = body[field]
  if (!Array.isArray(value)) throw badRequest(`${field} must be an array`, { field })
  if (value.length > max) throw badRequest(`${field} has too many entries`, { field, max })
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') throw badRequest(`${field} entries must be strings`, { field })
    const id = item.trim()
    if (id.length === 0 || id.length > MAX_ID_LENGTH) {
      throw badRequest(`${field} entries must be 1-${MAX_ID_LENGTH} characters`, { field, max: MAX_ID_LENGTH })
    }
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** POST /vulns/delete-many -> DeleteVulnsResult */
export async function handleDeleteMany({ req, res, holder, bumpRev }) {
  const body = await readJsonBody(req)
  const ids = requireIdList(body, 'ids', MAX_BULK_IDS)
  if (ids.length === 0) {
    sendJson(res, 200, { deleted: 0 })
    return
  }
  const placeholders = ids.map(() => '?').join(', ')
  const changes = await holder.withWriteTransaction((db) =>
    int(db.prepare(`DELETE FROM vulnerabilities WHERE id IN (${placeholders})`).run(...ids).changes),
  )
  bumpRev()
  sendJson(res, 200, { deleted: changes })
}

/**
 * POST /vulns/export -> ExportReportsResult
 *
 * The DSH plugin host has no file picker, so reports are returned inline:
 * `{ cancelled, files: [{ id, filename, content }] }`. The renderer currently
 * only consumes `cancelled` / `files.length`; a web transport can turn the
 * `{ filename, content }` entries into browser downloads.
 */
export async function handleExport({ req, res, holder, bumpRev }) {
  const body = await readJsonBody(req)
  const ids = requireIdList(body, 'ids', MAX_EXPORT_IDS)
  if (ids.length === 0) {
    sendJson(res, 200, { cancelled: true, files: [], savedPaths: [] })
    return
  }
  const db = holder.db
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT * FROM vulnerabilities WHERE id IN (${placeholders})`)
    .all(...ids)
  const byId = new Map(rows.map((row) => [String(row.id), row]))

  const files = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) continue
    const detail = dto.vulnDetail(row)
    const related = relatedByIds(db, row.related_vuln_ids).map((item) => ({
      id: item.id,
      vulnName: item.vuln_name,
      severity: item.severity,
      targetUrl: item.target_url,
      host: item.host,
    }))
    files.push({
      id,
      filename: reportFilename(row.vuln_name && /^[\x20-\x7e]+$/.test(String(row.vuln_name)) ? String(row.vuln_name) : id),
      content: buildVulnReport(detail, related),
    })
  }
  // The DSH desktop WebView may block browser downloads, so the Host also
  // writes the Markdown reports to ~/.cortex/exports/<timestamp>/ and returns
  // the absolute paths. The renderer still attempts a normal download, but the
  // toast can then point at a real file that always exists.
  const savedPaths = []
  if (files.length > 0) {
    try {
      const exportRoot = process.env.CORTEX_EXPORT_DIR || join(homedir(), '.cortex', 'exports')
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\..+$/, '')
        .replace('T', '-')
      const exportDir = join(exportRoot, stamp)
      mkdirSync(exportDir, { recursive: true })
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        const safeName = String(file.filename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || file.id
        const target = join(exportDir, `${String(index + 1).padStart(2, '0')}-${safeName.endsWith('.md') ? safeName : `${safeName}.md`}`)
        writeFileSync(target, file.content, 'utf8')
        savedPaths.push(target)
      }
    } catch {
      // Filesystem failure must not break the export response; the inline
      // files still let the browser download attempt proceed.
    }
  }
  // Export is a read-only projection: no revision bump.
  void bumpRev
  sendJson(res, 200, { cancelled: files.length === 0, files, savedPaths })
}

export { SEVERITIES, STATUSES, REALM_FILTERS, VULN_ORDER }
