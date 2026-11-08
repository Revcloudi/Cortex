/**
 * Host handlers for the ported Cortex UI: Web asset context library.
 *
 * Shared contract (`src/cortex-ui/shared/types.ts`):
 *   - GET    /assets                        -> AssetListItem[]
 *   - GET    /assets/:hostPort              -> AssetContext | null
 *   - GET    /assets/:hostPort/related-vulns-> VulnerabilityListItem[]
 *   - DELETE /assets/:hostPort              -> DeleteAssetResult
 *
 * Response shapes are the JSON form of the shared interfaces (snake_case).
 * Reads only; the single write is the explicit asset-row delete the UI asks
 * for, and vulnerability records are never touched by it.
 */

import {
  MAX_SEARCH_VALUE,
  badRequest,
  queryEnum,
  queryString,
  safeDecode,
  sendJson,
} from '../http.js'
import { jsonArray, text, vulnListItem } from './vulns.js'
import {
  deleteAssetIdentity,
  getAssetMeta,
  isMiniappAssetKey,
  listAssetDomainCounts,
  listAssetDomains,
  listAssetMeta,
  listLinkedVulnIds,
  listMiniappVersions,
} from './asset-identity.js'
import {
  normalizeInterfaces,
  normalizeLeaks,
  normalizeProjectName,
  normalizeTestParameters,
} from './normalize-asset.js'

const ASSET_STATUSES = ['Alive', 'Dead', 'WAF_Blocked']
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']
const LEAKED_INFO_TYPES = ['Credential', 'API_Key', 'Token', 'PII', 'Internal_IP', 'Other']
const TEST_PARAMETER_LOCATIONS = ['path', 'query', 'body', 'header', 'cookie']

const MAX_HOST_PORT = 4_000
const MAX_PROJECT = 120
const ASSET_ORDER = 'ORDER BY last_seen DESC, host_port ASC'
/** The asset page loads the full (small) library; this is a sanity ceiling. */
const MAX_LIST_ROWS = 500

/**
 * A stored `host_port` identifier is an opaque primary key: the renderer hands
 * it back exactly as listed, so the lookup stays byte-exact.
 * @param {unknown} value
 */
function hostPortParam(value) {
  const decoded = safeDecode(value, 'hostPort')
  if (decoded.length === 0) throw badRequest('hostPort is required', { field: 'hostPort' })
  if (decoded.length > MAX_HOST_PORT) throw badRequest('hostPort is too long', { max: MAX_HOST_PORT })
  return decoded
}

/** @param {unknown} value @returns {boolean} */
function bool01(value) {
  return value === 1 || value === true || value === '1'
}

/**
 * Normalize stored asset JSON to the canonical shared shapes. Agent-written
 * records may use aliases (raw/request, type/file, param/where/example); the
 * shared normalizers keep the drawer and the memory graph crash-free.
 */
function interfaceList(raw) {
  return normalizeInterfaces(raw)
}

/** @param {unknown} raw */
function leakedInfoList(raw) {
  return normalizeLeaks(raw)
}

/** @param {unknown} raw */
function testParameterList(raw) {
  return normalizeTestParameters(raw)
}

/**
 * Number of distinct interfaces: structured entries plus legacy
 * `interface_dir` paths that are not already covered by one of them (the
 * writer stores both, so a naive length would double-count).
 * @param {unknown} interfaces
 * @param {unknown} interfaceDir
 */
function interfaceCount(interfaces, interfaceDir) {
  const structured = interfaceList(interfaces)
  const paths = new Set(structured.map((item) => item.path))
  let extra = 0
  for (const value of jsonArray(interfaceDir)) {
    if (typeof value !== 'string') continue
    const path = value.trim()
    if (path.length === 0 || paths.has(path)) continue
    paths.add(path)
    extra += 1
  }
  return structured.length + extra
}

/** @param {unknown} raw @returns {string[]} */
function stringArray(raw) {
  return jsonArray(raw).filter((value) => typeof value === 'string')
}

/**
 * AssetListItem row for the asset table.
 * @param {Record<string, any>} row
 * @param {Record<string, any>|null} [meta]
 * @param {number} [domainCount]
 */
function assetListItem(row, meta = null, domainCount = 0) {
  const source = row || {}
  const hostPort = text(source.host_port)
  return {
    asset_id: meta ? text(meta.asset_key) : hostPort,
    kind: meta ? text(meta.kind) || 'web' : isMiniappAssetKey(hostPort) ? 'miniapp' : 'web',
    external_id: meta ? text(meta.external_id) : hostPort,
    display_name: meta ? text(meta.display_name) : '',
    appid: meta ? text(meta.appid) : '',
    platform: meta ? text(meta.platform) : '',
    primary_domain: meta ? text(meta.primary_domain) : '',
    domain_count: domainCount,
    host_port: hostPort,
    host: text(source.host),
    project_name: normalizeProjectName(text(source.project_name)),
    tech_stack: text(source.tech_stack),
    auth_required: bool01(source.auth_required),
    status: ASSET_STATUSES.includes(text(source.status)) ? text(source.status) : 'Alive',
    interface_count: interfaceCount(source.interfaces, source.interface_dir),
    leak_count: jsonArray(source.leaked_infos).length,
    related_vuln_count: stringArray(source.related_vuln_ids).length,
    last_seen: text(source.last_seen),
  }
}

/**
 * Full AssetContext row for the asset drawer.
 * @param {Record<string, any>} row
 * @param {Record<string, any>|null} [meta]
 * @param {Record<string, any>[]} [domains]
 * @param {Record<string, any>[]} [versions]
 * @param {string[]} [linkedVulnIds]
 */
function assetContext(row, meta = null, domains = [], versions = [], linkedVulnIds = []) {
  const source = row || {}
  const hostPort = text(source.host_port)
  const related = stringArray(source.related_vuln_ids)
  for (const id of linkedVulnIds) if (!related.includes(id)) related.push(id)
  return {
    asset_id: meta ? text(meta.asset_key) : hostPort,
    kind: meta ? text(meta.kind) || 'web' : isMiniappAssetKey(hostPort) ? 'miniapp' : 'web',
    external_id: meta ? text(meta.external_id) : hostPort,
    display_name: meta ? text(meta.display_name) : '',
    appid: meta ? text(meta.appid) : '',
    platform: meta ? text(meta.platform) : '',
    identity_confidence: meta ? text(meta.identity_confidence) || 'high' : 'high',
    primary_domain: meta ? text(meta.primary_domain) : '',
    domains,
    versions,
    linked_vuln_ids: linkedVulnIds,
    host_port: hostPort,
    host: text(source.host),
    project_name: normalizeProjectName(text(source.project_name)),
    tech_stack: text(source.tech_stack),
    auth_required: bool01(source.auth_required),
    status: ASSET_STATUSES.includes(text(source.status)) ? text(source.status) : 'Alive',
    interfaces: interfaceList(source.interfaces),
    interface_dir: stringArray(source.interface_dir),
    leaked_infos: leakedInfoList(source.leaked_infos),
    test_parameters: testParameterList(source.test_parameters),
    related_vuln_ids: related,
    last_seen: text(source.last_seen),
  }
}

/** Same whitelist-style ORDER BY builder as the vulnerability list. */
function orderClause(sort) {
  if (sort === undefined || String(sort).trim().length === 0) return ASSET_ORDER
  const raw = String(sort).trim()
  const desc = raw.startsWith('-')
  const field = (desc ? raw.slice(1) : raw).trim().toLowerCase()
  const dir = desc ? 'DESC' : 'ASC'
  switch (field) {
    case 'last_seen':
      return `ORDER BY last_seen ${dir}, host_port ASC`
    case 'host_port':
      return `ORDER BY host_port ${dir}`
    case 'host':
      return `ORDER BY host ${dir}, host_port ASC`
    case 'project_name':
    case 'project':
      return `ORDER BY project_name ${dir}, host_port ASC`
    case 'status':
      return `ORDER BY status ${dir}, last_seen DESC`
    default:
      throw badRequest('sort is not supported', {
        param: 'sort',
        allowed: [
          'last_seen',
          '-last_seen',
          'host_port',
          '-host_port',
          'host',
          '-host',
          'project_name',
          '-project_name',
          'status',
          '-status',
        ],
      })
  }
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

/** GET /assets?search=&status=&project=&sort= -> AssetListItem[] */
export function handleList({ res, searchParams, holder }) {
  const search = queryString(searchParams, 'search', { max: MAX_SEARCH_VALUE }) ?? ''
  // The renderer's status select uses `all` for "no filter"; accept it as absence.
  const rawStatus = queryEnum(searchParams, 'status', [...ASSET_STATUSES, 'all'])
  const status = rawStatus === 'all' ? undefined : rawStatus
  const project = queryString(searchParams, 'project', { max: MAX_PROJECT }) ?? ''
  const sort = queryString(searchParams, 'sort', { max: 100 })
  const order = orderClause(sort)

  const where = []
  /** @type {any[]} */
  const params = []
  if (status !== undefined) {
    where.push('status = ?')
    params.push(status)
  }
  if (project.length > 0) {
    where.push('project_name = ?')
    params.push(project)
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const rows = holder.db
    .prepare(`SELECT * FROM assets${whereSql} ${order} LIMIT ?`)
    .all(...params, MAX_LIST_ROWS)
  const metaByKey = listAssetMeta(holder.db)
  const domainCounts = listAssetDomainCounts(holder.db)
  const needle = search.trim().toLowerCase()
  const filtered =
    needle.length === 0
      ? rows
      : rows.filter((row) => {
          const meta = metaByKey.get(String(row.host_port)) ?? null
          const haystack = [
            row.host_port,
            row.host,
            row.project_name,
            row.tech_stack,
            meta?.display_name,
            meta?.appid,
            meta?.platform,
            meta?.external_id,
            meta?.primary_domain,
          ]
            .filter(Boolean)
            .join('\n')
            .toLowerCase()
          return haystack.includes(needle)
        })
  sendJson(
    res,
    200,
    filtered.map((row) =>
      assetListItem(
        row,
        metaByKey.get(String(row.host_port)) ?? null,
        domainCounts.get(String(row.host_port)) ?? 0,
      ),
    ),
  )
}

/** GET /assets/:hostPort -> AssetContext | null */
export function handleDetail({ res, params, holder }) {
  const hostPort = hostPortParam(params[0])
  const row = holder.db.prepare('SELECT * FROM assets WHERE host_port = ?').get(hostPort)
  if (!row) {
    sendJson(res, 200, null)
    return
  }
  const meta = getAssetMeta(holder.db, hostPort)
  sendJson(
    res,
    200,
    assetContext(
      row,
      meta,
      listAssetDomains(holder.db, hostPort),
      listMiniappVersions(holder.db, hostPort),
      listLinkedVulnIds(holder.db, hostPort),
    ),
  )
}

/** GET /assets/:hostPort/related-vulns -> VulnerabilityListItem[] */
export function handleRelatedVulns({ res, params, holder }) {
  const hostPort = hostPortParam(params[0])
  const row = holder.db.prepare('SELECT * FROM assets WHERE host_port = ?').get(hostPort)
  if (!row) {
    sendJson(res, 200, [])
    return
  }
  const ids = stringArray(row.related_vuln_ids)
  for (const id of listLinkedVulnIds(holder.db, hostPort)) {
    if (!ids.includes(id)) ids.push(id)
  }
  sendJson(res, 200, relatedByIds(holder.db, ids))
}

/** DELETE /assets/:hostPort -> DeleteAssetResult */
export async function handleDelete({ res, params, holder, bumpRev }) {
  const hostPort = hostPortParam(params[0])
  const changes = await holder.withWriteTransaction((db) => {
    deleteAssetIdentity(db, hostPort)
    return Number(db.prepare('DELETE FROM assets WHERE host_port = ?').run(hostPort).changes) || 0
  })
  bumpRev()
  sendJson(res, 200, { deleted: changes > 0 })
}

export { ASSET_STATUSES }
