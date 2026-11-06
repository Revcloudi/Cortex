/**
 * Read/write queries against the Cortex schema v5 database (contract §2.3/§2.5).
 *
 * Every statement is parameterized. The only writes allowed are:
 *   - vulnerabilities.status updates
 *   - append-only `retest_results` entries (existing entries are preserved)
 * Both run inside `BEGIN IMMEDIATE` with SQLITE_BUSY retries via the
 * DatabaseHolder.
 */

import { ApiError, badRequest, notFound, schemaIncompatible } from './http.js'
import * as dto from './dto.js'

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']
const STATUSES = ['Confirmed', 'Inconclusive', 'Retest_Passed']
const REALMS = ['web', 'internal']
const ASSET_STATUSES = ['Alive', 'Dead', 'WAF_Blocked']
const RETEST_HISTORY_LIMIT = 100

const VULN_ORDER = 'ORDER BY created_at DESC, rowid DESC'
const ASSET_ORDER = 'ORDER BY last_seen DESC, host_port ASC'
const SNAPSHOT_ORDER = 'ORDER BY updated_at DESC, session_id ASC'

/** Escape `%`, `_` and `\` for a SQL LIKE pattern (ESCAPE '\'). */
function likePattern(search) {
  const escaped = search.replace(/[\\%_]/g, (match) => `\\${match}`)
  return `%${escaped}%`
}

/** @param {unknown} value @returns {number} */
function asCount(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function pagesOf(total, pageSize) {
  if (total <= 0) return 0
  return Math.ceil(total / pageSize)
}

/** Filter enum validation that mirrors the SQL CHECK constraints. */
function checkEnum(value, allowed, name) {
  if (value === undefined) return undefined
  if (!allowed.includes(value)) {
    throw badRequest(`${name} must be one of ${allowed.join(', ')}`, { param: name, allowed })
  }
  return value
}

export class Repository {
  /** @param {import('./db.js').DatabaseHolder} holder */
  constructor(holder) {
    this.holder = holder
  }

  /** Current connection; routes call `holder.assertUsable()` first. */
  get db() {
    if (!this.holder.db) {
      throw schemaIncompatible('Cortex database is unavailable', { reason: 'UNAVAILABLE' })
    }
    return this.holder.db
  }

  /* --------------------------------------------------------------------- */
  /* Vulnerabilities                                                       */
  /* --------------------------------------------------------------------- */

  /**
   * @param {{realm?:string, search?:string, severity?:string, status?:string,
   *          page?:number, pageSize?:number}} query
   */
  listVulnerabilities(query = {}) {
    const realm = checkEnum(query.realm ?? 'all', [...REALMS, 'all'], 'realm')
    const severity = checkEnum(query.severity, SEVERITIES, 'severity')
    const status = checkEnum(query.status, STATUSES, 'status')
    const search = typeof query.search === 'string' ? query.search.trim() : ''
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 20

    const where = []
    const params = []
    if (realm !== 'all') {
      where.push('realm = ?')
      params.push(realm)
    }
    if (severity !== undefined) {
      where.push('severity = ?')
      params.push(severity)
    }
    if (status !== undefined) {
      where.push('status = ?')
      params.push(status)
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
    const total = asCount(this.db.prepare(`SELECT COUNT(*) AS c FROM vulnerabilities${whereSql}`).get(...params).c)
    const rows = this.db
      .prepare(`SELECT * FROM vulnerabilities${whereSql} ${VULN_ORDER} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize)

    return {
      items: rows.map(dto.vulnSummary),
      total,
      page,
      pageSize,
      pages: pagesOf(total, pageSize),
      filters: {
        severities: [...SEVERITIES],
        statuses: [...STATUSES],
        realms: [...REALMS],
      },
    }
  }

  /** @param {string} id @returns {Record<string, any>|null} */
  getVulnerability(id) {
    const row = this.db.prepare('SELECT * FROM vulnerabilities WHERE id = ?').get(id)
    return row || null
  }

  /**
   * Related vulnerability summaries for a vulnerability row, in the order of
   * `related_vuln_ids`.
   * @param {Record<string, any>} row
   */
  relatedVulnerabilities(row) {
    const ids = []
    for (const value of dto.parseJsonArray(row && row.related_vuln_ids)) {
      if (typeof value === 'string' && value.length > 0 && !ids.includes(value)) ids.push(value)
    }
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(`SELECT * FROM vulnerabilities WHERE id IN (${placeholders})`).all(...ids)
    const byId = new Map(rows.map((item) => [String(item.id), item]))
    const out = []
    for (const id of ids) {
      const found = byId.get(id)
      if (found) out.push(dto.vulnSummary(found))
    }
    return out
  }

  /**
   * Update only the `status` column. Returns the fresh row or null when the id
   * does not exist.
   * @param {string} id
   * @param {string} status
   */
  async updateVulnerabilityStatus(id, status) {
    if (!STATUSES.includes(status)) throw badRequest('invalid status', { allowed: STATUSES })
    const changes = await this.holder.withWriteTransaction((db) => {
      const result = db.prepare('UPDATE vulnerabilities SET status = ? WHERE id = ?').run(status, id)
      return asCount(result.changes)
    })
    if (changes === 0) return null
    return this.getVulnerability(id)
  }

  /**
   * Append one retest result, preserving every existing entry byte-for-byte at
   * the value level. Returns the fresh row or null when the id does not exist.
   * @param {string} id
   * @param {{timeRange:string, conclusion:string}} entry
   */
  async appendRetestResult(id, entry) {
    const changes = await this.holder.withWriteTransaction((db) => {
      const row = db.prepare('SELECT retest_results FROM vulnerabilities WHERE id = ?').get(id)
      if (!row) return 0
      const existing = dto.parseJsonArray(row.retest_results)
      if (existing.length >= RETEST_HISTORY_LIMIT) {
        throw badRequest('retest history limit reached', { limit: RETEST_HISTORY_LIMIT })
      }
      const next = [...existing, { time_range: entry.timeRange, conclusion: entry.conclusion }]
      db.prepare('UPDATE vulnerabilities SET retest_results = ? WHERE id = ?').run(
        JSON.stringify(next),
        id,
      )
      return 1
    })
    if (changes === 0) return null
    return this.getVulnerability(id)
  }

  /* --------------------------------------------------------------------- */
  /* Stats                                                                 */
  /* --------------------------------------------------------------------- */

  /**
   * Overview stats. `realm` narrows the distributions + recent list; the
   * `counts` block always carries web/internal/total for the overview banner.
   * @param {{realm?:string}} query
   */
  stats(query = {}) {
    const realm = checkEnum(query.realm ?? 'all', [...REALMS, 'all'], 'realm')
    const db = this.db

    const realmRows = db.prepare('SELECT realm, COUNT(*) AS c FROM vulnerabilities GROUP BY realm').all()
    let web = 0
    let internal = 0
    for (const row of realmRows) {
      if (row.realm === 'web') web = asCount(row.c)
      else if (row.realm === 'internal') internal = asCount(row.c)
    }
    const total = asCount(db.prepare('SELECT COUNT(*) AS c FROM vulnerabilities').get().c)

    const realmWhere = realm === 'all' ? '' : ' WHERE realm = ?'
    const realmParams = realm === 'all' ? [] : [realm]

    const bySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
    for (const row of db
      .prepare(`SELECT severity, COUNT(*) AS c FROM vulnerabilities${realmWhere} GROUP BY severity`)
      .all(...realmParams)) {
      if (Object.prototype.hasOwnProperty.call(bySeverity, row.severity)) {
        bySeverity[row.severity] = asCount(row.c)
      }
    }

    const byStatus = { Confirmed: 0, Inconclusive: 0, Retest_Passed: 0 }
    for (const row of db
      .prepare(`SELECT status, COUNT(*) AS c FROM vulnerabilities${realmWhere} GROUP BY status`)
      .all(...realmParams)) {
      if (Object.prototype.hasOwnProperty.call(byStatus, row.status)) {
        byStatus[row.status] = asCount(row.c)
      }
    }

    const hosts = asCount(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM (
             SELECT host AS value FROM vulnerabilities WHERE host <> ''
             UNION
             SELECT host_port AS value FROM assets WHERE host_port <> ''
           )`,
        )
        .get().c,
    )

    const assets = asCount(db.prepare('SELECT COUNT(*) AS c FROM assets').get().c)

    const projects = db
      .prepare(
        `SELECT project_name AS value FROM assets WHERE project_name <> ''
         UNION SELECT project_name FROM snapshot_sessions WHERE project_name <> ''
         UNION SELECT project_name FROM footholds WHERE project_name <> ''
         UNION SELECT project_name FROM credentials WHERE project_name <> ''
         ORDER BY value`,
      )
      .all()
      .map((row) => String(row.value))

    const recent = db
      .prepare(`SELECT * FROM vulnerabilities${realmWhere} ${VULN_ORDER} LIMIT 8`)
      .all(...realmParams)
      .map(dto.vulnSummary)

    return {
      counts: { web, internal, total },
      bySeverity,
      byStatus,
      hosts,
      assets,
      projects,
      recent,
    }
  }

  /* --------------------------------------------------------------------- */
  /* Assets                                                                */
  /* --------------------------------------------------------------------- */

  /**
   * @param {{search?:string, status?:string, page?:number, pageSize?:number}} query
   */
  listAssets(query = {}) {
    const status = checkEnum(query.status, ASSET_STATUSES, 'status')
    const search = typeof query.search === 'string' ? query.search.trim() : ''
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 20

    const where = []
    const params = []
    if (status !== undefined) {
      where.push('status = ?')
      params.push(status)
    }
    if (search.length > 0) {
      const pattern = likePattern(search)
      where.push(
        "(host_port LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\' OR project_name LIKE ? ESCAPE '\\' OR tech_stack LIKE ? ESCAPE '\\')",
      )
      for (let i = 0; i < 4; i += 1) params.push(pattern)
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

    const total = asCount(this.db.prepare(`SELECT COUNT(*) AS c FROM assets${whereSql}`).get(...params).c)
    const rows = this.db
      .prepare(`SELECT * FROM assets${whereSql} ${ASSET_ORDER} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize)

    const projects = this.db
      .prepare("SELECT DISTINCT project_name AS value FROM assets WHERE project_name <> '' ORDER BY value")
      .all()
      .map((row) => String(row.value))

    return {
      items: rows.map(dto.assetSummary),
      total,
      page,
      pageSize,
      pages: pagesOf(total, pageSize),
      projects,
    }
  }

  /** @param {string} hostPort @returns {Record<string, any>|null} */
  getAsset(hostPort) {
    const row = this.db.prepare('SELECT * FROM assets WHERE host_port = ?').get(hostPort)
    return row || null
  }

  /* --------------------------------------------------------------------- */
  /* Internal operations                                                   */
  /* --------------------------------------------------------------------- */

  /** Project list with per-entity counts (contract: GET /internal/projects). */
  internalProjects() {
    const db = this.db
    const names = db
      .prepare(
        `SELECT project_name AS value FROM footholds WHERE project_name <> ''
         UNION SELECT project_name FROM internal_hosts WHERE project_name <> ''
         UNION SELECT project_name FROM internal_services WHERE project_name <> ''
         UNION SELECT project_name FROM credentials WHERE project_name <> ''
         UNION SELECT project_name FROM pivots WHERE project_name <> ''
         ORDER BY value`,
      )
      .all()
      .map((row) => String(row.value))

    /** @param {string} table */
    const countMap = (table) => {
      const map = new Map()
      for (const row of db
        .prepare(`SELECT project_name AS value, COUNT(*) AS c FROM ${table} GROUP BY project_name`)
        .all()) {
        map.set(String(row.value), asCount(row.c))
      }
      return map
    }

    const footholds = countMap('footholds')
    const hosts = countMap('internal_hosts')
    const services = countMap('internal_services')
    const credentials = countMap('credentials')
    const pivots = countMap('pivots')

    return names.map((projectName) => ({
      projectName,
      footholds: footholds.get(projectName) ?? 0,
      hosts: hosts.get(projectName) ?? 0,
      services: services.get(projectName) ?? 0,
      credentials: credentials.get(projectName) ?? 0,
      pivots: pivots.get(projectName) ?? 0,
    }))
  }

  /** @param {string} projectName @param {string[]} ids @param {string} table @param {string} column */
  _byIds(table, column, ids) {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    return this.db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${placeholders})`).all(...ids)
  }

  /**
   * Full internal overview for one project.
   * @param {string|undefined} project
   */
  internalOverview(project) {
    const projects = this.internalProjects()
    let projectName = project
    if (projectName === undefined || projectName === null || projectName.length === 0) {
      projectName = projects.length > 0 ? projects[0].projectName : null
    } else if (!projects.some((item) => item.projectName === projectName)) {
      throw notFound('project not found', { project: projectName })
    }

    const empty = {
      project: projectName,
      footholds: [],
      hosts: [],
      services: [],
      credentials: [],
      pivots: [],
      stats: { footholds: 0, hosts: 0, services: 0, credentials: 0, pivots: 0 },
    }
    if (!projectName) return empty

    const db = this.db
    const footholdRows = db
      .prepare('SELECT * FROM footholds WHERE project_name = ? ORDER BY created_at ASC, id ASC')
      .all(projectName)
    const footholdIds = footholdRows.map((row) => String(row.id))
    const joinRows = this._byIds('foothold_hosts', 'foothold_id', footholdIds)
    const hostIdsByFoothold = new Map()
    for (const row of joinRows) {
      const key = String(row.foothold_id)
      const list = hostIdsByFoothold.get(key)
      if (list) list.push(String(row.internal_host_id))
      else hostIdsByFoothold.set(key, [String(row.internal_host_id)])
    }
    const footholds = footholdRows.map((row) =>
      dto.foothold(row, hostIdsByFoothold.get(String(row.id)) ?? []),
    )

    const hosts = db
      .prepare('SELECT * FROM internal_hosts WHERE project_name = ? ORDER BY ip ASC, id ASC')
      .all(projectName)
      .map(dto.internalHost)
    const services = db
      .prepare('SELECT * FROM internal_services WHERE project_name = ? ORDER BY host_id ASC, port ASC')
      .all(projectName)
      .map(dto.internalService)
    const credentials = db
      .prepare('SELECT * FROM credentials WHERE project_name = ? ORDER BY created_at ASC, id ASC')
      .all(projectName)
      .map(dto.credentialMasked)

    const pivotRows = db
      .prepare('SELECT * FROM pivots WHERE project_name = ? ORDER BY created_at ASC, id ASC')
      .all(projectName)
    const pivotIds = pivotRows.map((row) => String(row.id))
    const hopRows = this._byIds('pivot_hops', 'pivot_id', pivotIds)
    const hopsByPivot = new Map()
    for (const row of hopRows) {
      const key = String(row.pivot_id)
      const list = hopsByPivot.get(key)
      const hop = {
        seq: asCount(row.seq),
        refKind: String(row.ref_kind),
        refId: String(row.ref_id),
        label: String(row.label ?? ''),
        via: String(row.via ?? ''),
      }
      if (list) list.push(hop)
      else hopsByPivot.set(key, [hop])
    }
    for (const list of hopsByPivot.values()) list.sort((a, b) => a.seq - b.seq)
    const reachRows = this._byIds('pivot_reachability', 'pivot_id', pivotIds)
    const reachByPivot = new Map()
    for (const row of reachRows) {
      const key = String(row.pivot_id)
      const list = reachByPivot.get(key)
      if (list) list.push(String(row.cidr))
      else reachByPivot.set(key, [String(row.cidr)])
    }
    const pivots = pivotRows.map((row) =>
      dto.pivot(row, hopsByPivot.get(String(row.id)) ?? [], reachByPivot.get(String(row.id)) ?? []),
    )

    return {
      project: projectName,
      footholds,
      hosts,
      services,
      credentials,
      pivots,
      stats: {
        footholds: footholds.length,
        hosts: hosts.length,
        services: services.length,
        credentials: credentials.length,
        pivots: pivots.length,
      },
    }
  }

  /**
   * Relation graph for one project (footholds / hosts / services / credentials /
   * pivots), derived from the same overview data.
   * @param {string|undefined} project
   */
  internalGraph(project) {
    const overview = this.internalOverview(project)
    /** @type {{id:string,kind:string,label:string,sub?:string}[]} */
    const nodes = []
    /** @type {{from:string,to:string,kind:string}[]} */
    const edges = []
    const seen = new Set()

    /** @param {{id:string,kind:string,label:string,sub?:string}} node */
    const addNode = (node) => {
      if (!node.id || seen.has(node.id)) return
      seen.add(node.id)
      nodes.push(node)
    }
    /** @param {string} from @param {string} to @param {string} kind */
    const addEdge = (from, to, kind) => {
      if (!from || !to) return
      edges.push({ from, to, kind })
    }

    for (const item of overview.footholds) {
      addNode({
        id: item.id,
        kind: 'foothold',
        label: `${item.accessType || 'foothold'} · ${item.entryHostPort || item.id}`,
        ...(item.status ? { sub: item.status } : {}),
      })
    }
    for (const item of overview.hosts) {
      addNode({
        id: item.id,
        kind: 'host',
        label: item.hostname || item.ip || item.id,
        ...(item.ip || item.state ? { sub: item.ip || item.state } : {}),
      })
    }
    for (const item of overview.services) {
      const label = `${item.protocol || 'tcp'}/${item.port}${item.service ? ` ${item.service}` : ''}`
      addNode({
        id: item.id,
        kind: 'service',
        label,
        ...(item.state ? { sub: item.state } : {}),
      })
    }
    for (const item of overview.credentials) {
      const label = `${item.type}${item.username ? ` · ${item.username}` : ''}`
      addNode({
        id: item.id,
        kind: 'credential',
        label,
        ...(item.status ? { sub: item.status } : {}),
      })
    }
    for (const item of overview.pivots) {
      addNode({
        id: item.id,
        kind: 'pivot',
        label: `${item.kind || 'pivot'} ${item.localHost || ''}:${item.localPort || 0}`,
        ...(item.status ? { sub: item.status } : {}),
      })
    }

    const hostById = new Map(overview.hosts.map((item) => [item.id, item]))
    const serviceById = new Map(overview.services.map((item) => [item.id, item]))

    for (const item of overview.footholds) {
      for (const hostId of item.hostIds) {
        const host = hostById.get(hostId)
        if (host) {
          addNode({
            id: host.id,
            kind: 'host',
            label: host.hostname || host.ip || host.id,
            ...(host.ip || host.state ? { sub: host.ip || host.state } : {}),
          })
          addEdge(item.id, host.id, 'foothold_host')
        }
      }
    }
    for (const item of overview.services) {
      addNode({
        id: item.id,
        kind: 'service',
        label: `${item.protocol || 'tcp'}/${item.port}${item.service ? ` ${item.service}` : ''}`,
        ...(item.state ? { sub: item.state } : {}),
      })
      addEdge(item.hostId, item.id, 'host_service')
    }
    for (const item of overview.pivots) addEdge(item.footholdId, item.id, 'foothold_pivot')
    for (const item of overview.credentials) {
      addNode({
        id: item.id,
        kind: 'credential',
        label: `${item.type}${item.username ? ` · ${item.username}` : ''}`,
        ...(item.status ? { sub: item.status } : {}),
      })
      if (item.serviceId && serviceById.has(item.serviceId)) addEdge(item.serviceId, item.id, 'service_credential')
      else if (item.hostId && hostById.has(item.hostId)) addEdge(item.hostId, item.id, 'host_credential')
    }
    for (const item of overview.pivots) {
      let previous = item.id
      for (const hop of item.hops) {
        const target = hop.refId
        if (!target) continue
        if (!seen.has(target)) {
          const kind = hop.refKind === 'internal_service' ? 'service' : 'host'
          addNode({ id: target, kind, label: hop.label || target })
        }
        addEdge(previous, target, 'hop')
        previous = target
      }
    }

    return { nodes, edges }
  }

  /** Retest origin/allowlist context for POST /retest/send. */
  getRetestContext(vulnId) {
    const vuln = this.getVulnerability(vulnId)
    if (!vuln) throw notFound('vulnerability not found')
    const assets = this.db
      .prepare('SELECT host_port, host FROM assets WHERE host = ? OR host_port = ? OR host_port = ?')
      .all(String(vuln.host ?? ''), String(vuln.host ?? ''), String(vuln.target_url ?? ''))
    return { vuln, assets }
  }

  /* --------------------------------------------------------------------- */
  /* Snapshots                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * @param {{project?:string, includeArchived?:boolean, page?:number, pageSize?:number}} query
   */
  listSnapshots(query = {}) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 20

    const projects = this.db
      .prepare(
        "SELECT DISTINCT project_name AS value FROM snapshot_sessions WHERE project_name <> '' ORDER BY value",
      )
      .all()
      .map((row) => String(row.value))

    const where = []
    const params = []
    const project = typeof query.project === 'string' ? query.project.trim() : ''
    if (project.length > 0) {
      where.push('s.project_name = ?')
      params.push(project)
    }
    if (query.includeArchived !== true) where.push('s.archived_at IS NULL')
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM snapshot_sessions c WHERE c.parent_session_id = s.session_id) AS child_count
         FROM snapshot_sessions s${whereSql} ${SNAPSHOT_ORDER} LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize)

    return { projects, sessions: rows.map(dto.snapshotSummary) }
  }

  /** @param {string} sessionId */
  getSnapshot(sessionId) {
    const row = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM snapshot_sessions c WHERE c.parent_session_id = s.session_id) AS child_count
         FROM snapshot_sessions s WHERE s.session_id = ?`,
      )
      .get(sessionId)
    if (!row) throw notFound('snapshot session not found')

    const children = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM snapshot_sessions c WHERE c.parent_session_id = s.session_id) AS child_count
         FROM snapshot_sessions s WHERE s.parent_session_id = ? ${SNAPSHOT_ORDER}`,
      )
      .all(sessionId)
      .map(dto.snapshotSummary)

    const relatedVulns = this._vulnerabilitySummariesByIds(dto.parseJsonArray(row.related_vuln_ids))
    return {
      session: dto.snapshotDetail(row),
      children,
      relatedVulns,
    }
  }

  /** @param {unknown} rawIds */
  _vulnerabilitySummariesByIds(rawIds) {
    const ids = []
    for (const value of Array.isArray(rawIds) ? rawIds : []) {
      if (typeof value === 'string' && value.length > 0 && !ids.includes(value)) ids.push(value)
    }
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(`SELECT * FROM vulnerabilities WHERE id IN (${placeholders})`).all(...ids)
    const byId = new Map(rows.map((item) => [String(item.id), item]))
    const out = []
    for (const id of ids) {
      const found = byId.get(id)
      if (found) out.push(dto.vulnSummary(found))
    }
    return out
  }

  /** Report data: vulnerability row + related summaries. */
  getReportData(vulnId) {
    const row = this.getVulnerability(vulnId)
    if (!row) throw notFound('vulnerability not found')
    return { vuln: dto.vulnDetail(row), related: this.relatedVulnerabilities(row) }
  }

  /** Asset detail data: asset row + related vulnerability summaries. */
  getAssetDetail(hostPort) {
    const row = this.getAsset(hostPort)
    if (!row) throw notFound('asset not found')
    return {
      asset: dto.assetDetail(row),
      related: this._vulnerabilitySummariesByIds(dto.parseJsonArray(row.related_vuln_ids)),
    }
  }
}

// Re-export so callers/tests can assert on the accepted enums without imports
// from multiple modules.
export { SEVERITIES, STATUSES, REALMS, ASSET_STATUSES, RETEST_HISTORY_LIMIT }
