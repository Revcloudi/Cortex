/**
 * Host handlers for the ported Cortex UI: cognitive snapshot sessions.
 *
 * Shared contract (`src/cortex-ui/shared/types.ts`):
 *   - GET    /snapshots                     -> SnapshotListResult
 *   - GET    /snapshots/:id                 -> SnapshotSession | null
 *   - POST   /snapshots/:id/archive         -> SnapshotSession
 *   - POST   /snapshots/:id/restore-previous-> SnapshotSession
 *   - DELETE /snapshots/:id                 -> DeleteSnapshotResult
 *
 * The list endpoint returns compact `SnapshotSummary` rows (never the full
 * task arrays). `archive` cascades to direct children for project sessions.
 * `restore-previous` is a one-step rollback: it copies the columns captured in
 * `previous_state` back and then clears that column. All writes run inside
 * `DatabaseHolder.withWriteTransaction`.
 */

import {
  badRequest,
  notFound,
  queryBool01,
  queryInt,
  queryString,
  readJsonBody,
  safeDecode,
  sendJson,
} from '../http.js'
import { jsonArray, jsonObject, likePattern, text } from './vulns.js'

const MAX_SESSION_ID = 200
const MAX_KEYWORD = 200
const MAX_PROJECT = 120
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const SNAPSHOT_ORDER = 'ORDER BY updated_at DESC, session_id ASC'

const CHILD_COUNT_SQL =
  '(SELECT COUNT(*) FROM snapshot_sessions c WHERE c.parent_session_id = s.session_id) AS child_count'

/** @param {unknown} value @returns {string|null} */
function nullableText(value) {
  return value === null || value === undefined ? null : String(value)
}

/** @param {unknown} value @returns {number} */
function int(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** @param {unknown} raw @returns {string[]} */
function stringArray(raw) {
  return jsonArray(raw).filter((value) => typeof value === 'string')
}

/** @param {unknown} raw */
function testedInterfaceList(raw) {
  const out = []
  for (const item of jsonArray(raw)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    out.push({
      target: text(item.target),
      method: text(item.method),
      result: text(item.result),
    })
  }
  return out
}

/** @param {unknown} raw */
function hasPreviousState(raw) {
  return jsonObject(raw) !== null
}

/**
 * Compact `SnapshotSummary` (list rows).
 * @param {Record<string, any>} row
 */
function snapshotSummary(row) {
  const source = row || {}
  return {
    session_id: text(source.session_id),
    project_name: text(source.project_name),
    current_phase: text(source.current_phase),
    target_hosts: stringArray(source.target_hosts),
    parent_session_id: nullableText(source.parent_session_id),
    archived_at: nullableText(source.archived_at),
    child_count: int(source.child_count),
    created_at: text(source.created_at),
    updated_at: text(source.updated_at),
    unfinished_count: stringArray(source.unfinished_tasks).length,
    failed_count: stringArray(source.failed_paths).length,
    tested_interface_count: jsonArray(source.tested_interfaces).filter(
      (item) => item !== null && typeof item === 'object',
    ).length,
    next_steps_excerpt: text(source.next_steps).slice(0, 300),
    has_previous_state: hasPreviousState(source.previous_state),
  }
}

/**
 * Full `SnapshotSession` row.
 * @param {Record<string, any>} row
 */
function snapshotDetail(row) {
  const source = row || {}
  return {
    project_name: text(source.project_name),
    target_hosts: stringArray(source.target_hosts),
    current_phase: text(source.current_phase),
    unfinished_tasks: stringArray(source.unfinished_tasks),
    failed_paths: stringArray(source.failed_paths),
    tested_interfaces: testedInterfaceList(source.tested_interfaces),
    notes: text(source.notes),
    related_vuln_ids: stringArray(source.related_vuln_ids),
    next_steps: text(source.next_steps),
    session_id: text(source.session_id),
    parent_session_id: nullableText(source.parent_session_id),
    archived_at: nullableText(source.archived_at),
    child_count: int(source.child_count),
    created_at: text(source.created_at),
    updated_at: text(source.updated_at),
    has_previous_state: hasPreviousState(source.previous_state),
  }
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} sessionId */
function readSession(db, sessionId) {
  return db
    .prepare(`SELECT s.*, ${CHILD_COUNT_SQL} FROM snapshot_sessions s WHERE s.session_id = ?`)
    .get(sessionId)
}

/** @param {unknown} value */
function sessionIdParam(value) {
  const decoded = safeDecode(value, 'sessionId')
  if (decoded.length === 0) throw badRequest('sessionId is required', { field: 'sessionId' })
  if (decoded.length > MAX_SESSION_ID) {
    throw badRequest('sessionId is too long', { max: MAX_SESSION_ID })
  }
  return decoded
}

/* ------------------------------------------------------------------------- */
/* Handlers                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * GET /snapshots -> SnapshotListResult
 *
 * The renderer sends `{ rootsOnly, includeArchived, limit }` or
 * `{ parentSessionId, includeArchived: true }`; the older contract table used
 * `project` / `search` / `page` / `pageSize`, all of which stay supported.
 */
export function handleList({ res, searchParams, holder }) {
  const project = queryString(searchParams, 'project', { max: MAX_PROJECT }) ?? ''
  const keyword =
    queryString(searchParams, 'keyword', { max: MAX_KEYWORD }) ??
    queryString(searchParams, 'search', { max: MAX_KEYWORD }) ??
    ''
  const parentSessionId = queryString(searchParams, 'parentSessionId', { max: MAX_SESSION_ID }) ?? ''
  const rootsOnly = queryBool01(searchParams, 'rootsOnly') ?? false
  const includeArchived = queryBool01(searchParams, 'includeArchived') ?? false
  const limit = queryInt(searchParams, 'limit', { min: 1, max: MAX_LIMIT })
  const page = queryInt(searchParams, 'page', { min: 1, max: 100_000 }) ?? 1
  const pageSize = queryInt(searchParams, 'pageSize', { min: 1, max: MAX_LIMIT })
  const effectivePageSize = pageSize ?? limit ?? DEFAULT_LIMIT

  const where = []
  /** @type {any[]} */
  const params = []
  if (project.length > 0) {
    where.push('s.project_name = ?')
    params.push(project)
  }
  if (parentSessionId.length > 0) {
    where.push('s.parent_session_id = ?')
    params.push(parentSessionId)
  } else if (rootsOnly) {
    where.push('s.parent_session_id IS NULL')
  }
  if (!includeArchived) where.push('s.archived_at IS NULL')
  if (keyword.length > 0) {
    const pattern = likePattern(keyword)
    where.push(
      "(s.project_name LIKE ? ESCAPE '\\' OR s.current_phase LIKE ? ESCAPE '\\' OR s.next_steps LIKE ? ESCAPE '\\' OR s.target_hosts LIKE ? ESCAPE '\\')",
    )
    for (let i = 0; i < 4; i += 1) params.push(pattern)
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const db = holder.db

  const total = int(
    db.prepare(`SELECT COUNT(*) AS c FROM snapshot_sessions s${whereSql}`).get(...params).c,
  )
  const pages = total === 0 ? 0 : Math.ceil(total / effectivePageSize)
  const effectivePage = total === 0 ? 1 : Math.min(page, pages)
  const rows = db
    .prepare(
      `SELECT s.*, ${CHILD_COUNT_SQL} FROM snapshot_sessions s${whereSql} ${SNAPSHOT_ORDER} LIMIT ? OFFSET ?`,
    )
    .all(...params, effectivePageSize, (effectivePage - 1) * effectivePageSize)

  sendJson(res, 200, { total, items: rows.map(snapshotSummary) })
}

/** GET /snapshots/:id -> SnapshotSession | null */
export function handleDetail({ res, params, holder }) {
  const sessionId = sessionIdParam(params[0])
  const row = readSession(holder.db, sessionId)
  sendJson(res, 200, row ? snapshotDetail(row) : null)
}

/** POST /snapshots/:id/archive { archived: boolean } -> SnapshotSession */
export async function handleArchive({ req, res, params, holder, bumpRev }) {
  const sessionId = sessionIdParam(params[0])
  const body = await readJsonBody(req)
  if (typeof body.archived !== 'boolean') {
    throw badRequest('archived must be a boolean', { field: 'archived' })
  }
  const archived = body.archived
  const archivedAt = archived ? new Date().toISOString() : null

  const row = await holder.withWriteTransaction((db) => {
    const existing = db.prepare('SELECT session_id FROM snapshot_sessions WHERE session_id = ?').get(sessionId)
    if (!existing) return null
    const now = new Date().toISOString()
    db.prepare('UPDATE snapshot_sessions SET archived_at = ?, updated_at = ? WHERE session_id = ?').run(
      archivedAt,
      now,
      sessionId,
    )
    // Project sessions cascade to their direct child (system) sessions.
    db.prepare(
      'UPDATE snapshot_sessions SET archived_at = ?, updated_at = ? WHERE parent_session_id = ?',
    ).run(archivedAt, now, sessionId)
    return readSession(db, sessionId)
  })
  if (!row) throw notFound('snapshot session not found')
  bumpRev()
  sendJson(res, 200, snapshotDetail(row))
}

/**
 * POST /snapshots/:id/restore-previous -> SnapshotSession
 *
 * One-step rollback: the columns captured in `previous_state` are written back
 * and the backup column is cleared. Unknown keys are ignored so legacy
 * free-form backups never corrupt a session.
 */
export async function handleRestorePrevious({ res, params, holder, bumpRev }) {
  const sessionId = sessionIdParam(params[0])
  const row = await holder.withWriteTransaction((db) => {
    const existing = db.prepare('SELECT * FROM snapshot_sessions WHERE session_id = ?').get(sessionId)
    if (!existing) return { missing: true }
    const previous = jsonObject(existing.previous_state)
    if (!previous) return { noPrevious: true }

    /** @type {string[]} */
    const sets = []
    /** @type {any[]} */
    const values = []
    /** @param {string} column @param {unknown} value */
    const setColumn = (column, value) => {
      sets.push(`${column} = ?`)
      values.push(value)
    }

    if (typeof previous.project_name === 'string' && previous.project_name.trim().length > 0) {
      setColumn('project_name', previous.project_name.trim())
    }
    if (Array.isArray(previous.target_hosts)) {
      setColumn('target_hosts', JSON.stringify(previous.target_hosts.filter((item) => typeof item === 'string')))
    }
    if (typeof previous.current_phase === 'string') setColumn('current_phase', previous.current_phase)
    for (const field of ['unfinished_tasks', 'failed_paths', 'related_vuln_ids']) {
      if (Array.isArray(previous[field])) {
        setColumn(field, JSON.stringify(previous[field].filter((item) => typeof item === 'string')))
      }
    }
    if (Array.isArray(previous.tested_interfaces)) {
      setColumn('tested_interfaces', JSON.stringify(previous.tested_interfaces))
    }
    if (typeof previous.notes === 'string') setColumn('notes', previous.notes)
    if (typeof previous.next_steps === 'string') setColumn('next_steps', previous.next_steps)

    const now = new Date().toISOString()
    sets.push('previous_state = NULL', 'updated_at = ?')
    values.push(now)
    values.push(sessionId)
    db.prepare(`UPDATE snapshot_sessions SET ${sets.join(', ')} WHERE session_id = ?`).run(...values)
    return { row: readSession(db, sessionId) }
  })
  if (row && row.missing) throw notFound('snapshot session not found')
  if (row && row.noPrevious) throw badRequest('snapshot has no previous state to restore')
  bumpRev()
  sendJson(res, 200, snapshotDetail(row.row))
}

/** DELETE /snapshots/:id -> DeleteSnapshotResult (cascade: session + children) */
export async function handleDelete({ res, params, holder, bumpRev }) {
  const sessionId = sessionIdParam(params[0])
  const deleted = await holder.withWriteTransaction((db) => {
    const children = int(
      db.prepare('SELECT COUNT(*) AS c FROM snapshot_sessions WHERE parent_session_id = ?').get(sessionId).c,
    )
    if (children > 0) {
      db.prepare('DELETE FROM snapshot_sessions WHERE parent_session_id = ?').run(sessionId)
    }
    const own = int(db.prepare('DELETE FROM snapshot_sessions WHERE session_id = ?').run(sessionId).changes)
    return children + own
  })
  bumpRev()
  sendJson(res, 200, { deleted })
}

export { SNAPSHOT_ORDER }
