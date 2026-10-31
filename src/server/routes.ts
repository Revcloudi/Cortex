import { basename } from 'node:path'
import {
  AssetHostPortIpcSchema,
  DeleteVulnerabilityIpcSchema,
  GetVulnerabilityIpcSchema,
  ListAssetsIpcSchema,
  ListSnapshotsIpcSchema,
  ListVulnerabilitiesIpcSchema,
  SetupRunRequestIpcSchema,
  SnapshotArchiveIpcSchema,
  SnapshotSessionIdIpcSchema,
  UpdateStatusIpcSchema,
  VulnerabilityIdsIpcSchema
} from '../main/ipc/schemas'
import {
  buildReportFilename,
  buildVulnerabilityReportMarkdown
} from '../shared/markdownReport'
import type {
  AppInfo,
  AssetContext,
  AssetListItem,
  DashboardStats,
  DatabaseInfo,
  DeleteAssetResult,
  DeleteSnapshotResult,
  DeleteVulnResult,
  DeleteVulnsResult,
  PaginatedVulnerabilities,
  SeedDemoResult,
  SetupInfo,
  SetupRunResult,
  SnapshotListResult,
  SnapshotSession,
  Vulnerability,
  VulnerabilityListItem
} from '../shared/types'
import type { WebConfigInfo, WebExportResponse } from '../shared/web'
import { WEB_API_PATHS } from '../shared/web'
import { WebApiError, invalidInput, notFound } from './errors'
import type { RouteDefinition, RouteRequest, WebServerDeps } from './types'

/**
 * REST route table for the local `ctx web` server.
 *
 * Every handler is a thin HTTP adapter over the same `DatabaseService` calls
 * the Electron IPC bridge makes (`src/main/ipc/handlers.ts`): identical zod
 * schemas, identical validation wording, identical `notifyDataChanged`
 * semantics and identical response shapes, so the renderer keeps a single
 * `CortexApi` contract in both runtimes.
 *
 * Patterns are anchored (`^...$`) and matched in declaration order against the
 * still percent-encoded pathname; capture groups reach the handler through
 * `RouteRequest.params` and are decoded before validation. Handlers return
 * plain data (serialized as JSON 200); thrown `WebApiError` / `DatabaseError`
 * values are mapped to safe HTTP responses by the server entry.
 */

/** Escape the characters that are significant inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the anchored pattern for one canonical API path. `segments` are raw
 * regex fragments (`([^/]+)`, `(.+)`, ...) appended in order, so their capture
 * groups stay available through `RouteRequest.params`.
 */
function createPattern(path: string, ...segments: string[]): RegExp {
  const tail = segments.map((segment) => `/${segment}`).join('')
  return new RegExp(`^${escapeRegExp(path)}${tail}$`)
}

/** Percent-decode one captured path segment; a malformed escape is a 400. */
function decodeParam(rawParam: string, scope: string): string {
  try {
    return decodeURIComponent(rawParam)
  } catch {
    throw new WebApiError(400, `${scope}: malformed percent-encoding`)
  }
}

/** Read one field from a parsed JSON body whose shape is still untrusted. */
function bodyField(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  return (body as Record<string, unknown>)[key]
}

/** Present string query value; an absent key stays `undefined`, never `''`. */
function stringQuery(query: URLSearchParams, key: string): string | undefined {
  return query.get(key) ?? undefined
}

/** `Number()`-coerced query value; unparsable input is a 400. */
function numberQuery(
  query: URLSearchParams,
  key: string,
  scope: string
): number | undefined {
  const raw = query.get(key)
  if (raw === null) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new WebApiError(400, `${scope}: ${key} must be a number`)
  }
  return value
}

/** Boolean query flag accepting `true`/`false`/`1`/`0`; anything else is a 400. */
function booleanQuery(
  query: URLSearchParams,
  key: string,
  scope: string
): boolean | undefined {
  const raw = query.get(key)
  if (raw === null) return undefined
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new WebApiError(400, `${scope}: ${key} must be a boolean (true/false)`)
}

export function createRoutes(deps: WebServerDeps): RouteDefinition[] {
  const { db } = deps

  return [
    // GET /api/vulns — mirror `listVulnerabilities`.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.vulnerabilities),
      handler: (request: RouteRequest): PaginatedVulnerabilities => {
        const search = stringQuery(request.query, 'search')
        const severity = stringQuery(request.query, 'severity')
        const status = stringQuery(request.query, 'status')
        const page = numberQuery(request.query, 'page', 'Invalid vulnerability filter')
        const pageSize = numberQuery(request.query, 'pageSize', 'Invalid vulnerability filter')
        const parsed = ListVulnerabilitiesIpcSchema.safeParse({
          ...(search !== undefined ? { search } : {}),
          ...(severity !== undefined ? { severity } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(page !== undefined ? { page } : {}),
          ...(pageSize !== undefined ? { pageSize } : {})
        })
        if (!parsed.success) {
          throw invalidInput('Invalid vulnerability filter', parsed.error)
        }
        return db.list(parsed.data ?? {})
      }
    },

    // GET /api/vulns/:id — mirror `getVulnerability` (a missing row is `null`).
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.vulnerabilities, '([^/]+)'),
      handler: (request: RouteRequest): Vulnerability | null => {
        const id = decodeParam(request.params[0], 'Invalid vulnerability id')
        const parsed = GetVulnerabilityIpcSchema.safeParse(id)
        if (!parsed.success) {
          throw invalidInput('Invalid vulnerability id', parsed.error)
        }
        return db.getById(parsed.data)
      }
    },

    // PATCH /api/vulns/:id/status — mirror `updateVulnerabilityStatus`.
    {
      method: 'PATCH',
      pattern: createPattern(WEB_API_PATHS.vulnerabilities, '([^/]+)', 'status'),
      handler: (request: RouteRequest): Vulnerability => {
        const id = decodeParam(request.params[0], 'Invalid vulnerability id')
        const parsed = UpdateStatusIpcSchema.safeParse({
          id,
          status: bodyField(request.body, 'status')
        })
        if (!parsed.success) {
          throw invalidInput('Invalid status update payload', parsed.error)
        }
        const updated = db.updateStatus(parsed.data.id, parsed.data.status)
        deps.notifyDataChanged()
        return updated
      }
    },

    // DELETE /api/vulns/:id — mirror `deleteVulnerability`.
    {
      method: 'DELETE',
      pattern: createPattern(WEB_API_PATHS.vulnerabilities, '([^/]+)'),
      handler: (request: RouteRequest): DeleteVulnResult => {
        const id = decodeParam(request.params[0], 'Invalid vulnerability id')
        const parsed = DeleteVulnerabilityIpcSchema.safeParse(id)
        if (!parsed.success) {
          throw invalidInput('Invalid vulnerability id', parsed.error)
        }
        const deleted = db.delete(parsed.data)
        if (deleted) deps.notifyDataChanged()
        return { deleted }
      }
    },

    // POST /api/vulns/delete — mirror `deleteVulnerabilities`.
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.vulnerabilitiesDelete),
      handler: (request: RouteRequest): DeleteVulnsResult => {
        const parsed = VulnerabilityIdsIpcSchema.safeParse(request.body)
        if (!parsed.success) {
          throw invalidInput('Invalid bulk delete payload', parsed.error)
        }
        const deleted = db.deleteMany(parsed.data)
        if (deleted > 0) deps.notifyDataChanged()
        return { deleted }
      }
    },

    // POST /api/vulns/export — mirror `exportVulnerabilities`, but return the
    // Markdown bodies instead of writing files: the browser downloads them and
    // the server never touches disk.
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.vulnerabilitiesExport),
      handler: (request: RouteRequest): WebExportResponse => {
        const parsed = VulnerabilityIdsIpcSchema.safeParse(request.body)
        if (!parsed.success) {
          throw invalidInput('Invalid export payload', parsed.error)
        }
        const vulns = parsed.data
          .map((id) => db.getById(id))
          .filter((vuln): vuln is Vulnerability => vuln !== null)
        if (vulns.length === 0) {
          throw notFound('No vulnerability records found to export')
        }
        return {
          files: vulns.map((vuln) => ({
            filename: buildReportFilename(vuln),
            content: buildVulnerabilityReportMarkdown(vuln)
          }))
        }
      }
    },

    // GET /api/assets — mirror `listAssets`.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.assets),
      handler: (request: RouteRequest): AssetListItem[] => {
        const search = stringQuery(request.query, 'search')
        const status = stringQuery(request.query, 'status')
        const parsed = ListAssetsIpcSchema.safeParse({
          ...(search !== undefined ? { search } : {}),
          ...(status !== undefined ? { status } : {})
        })
        if (!parsed.success) {
          throw invalidInput('Invalid asset filter', parsed.error)
        }
        return db.listAssets(parsed.data ?? {})
      }
    },

    // GET /api/assets/:hostPort/related — declared BEFORE the detail route so a
    // full-URL hostPort containing slashes never swallows the `/related` tail.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.assets, '(.+)', 'related'),
      handler: (request: RouteRequest): VulnerabilityListItem[] => {
        const hostPort = decodeParam(request.params[0], 'Invalid asset host_port')
        const parsed = AssetHostPortIpcSchema.safeParse(hostPort)
        if (!parsed.success) {
          throw invalidInput('Invalid asset host_port', parsed.error)
        }
        return db.getAssetRelatedVulnerabilities(parsed.data)
      }
    },

    // GET /api/assets/:hostPort — mirror `getAssetDetail`; `(.+)` keeps full
    // URLs (percent-encoded slashes) addressable.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.assets, '(.+)'),
      handler: (request: RouteRequest): AssetContext | null => {
        const hostPort = decodeParam(request.params[0], 'Invalid asset host_port')
        const parsed = AssetHostPortIpcSchema.safeParse(hostPort)
        if (!parsed.success) {
          throw invalidInput('Invalid asset host_port', parsed.error)
        }
        return db.getAssetDetail(parsed.data)
      }
    },

    // DELETE /api/assets/:hostPort — mirror `deleteAsset`.
    {
      method: 'DELETE',
      pattern: createPattern(WEB_API_PATHS.assets, '(.+)'),
      handler: (request: RouteRequest): DeleteAssetResult => {
        const hostPort = decodeParam(request.params[0], 'Invalid asset host_port')
        const parsed = AssetHostPortIpcSchema.safeParse(hostPort)
        if (!parsed.success) {
          throw invalidInput('Invalid asset host_port', parsed.error)
        }
        const deleted = db.deleteAsset(parsed.data)
        if (deleted) deps.notifyDataChanged()
        return { deleted }
      }
    },

    // GET /api/snapshots — mirror `listSnapshots`.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.snapshots),
      handler: (request: RouteRequest): SnapshotListResult => {
        const keyword = stringQuery(request.query, 'keyword')
        const rootsOnly = booleanQuery(request.query, 'rootsOnly', 'Invalid snapshot filter')
        const parentSessionId = stringQuery(request.query, 'parentSessionId')
        const includeArchived = booleanQuery(
          request.query,
          'includeArchived',
          'Invalid snapshot filter'
        )
        const limit = numberQuery(request.query, 'limit', 'Invalid snapshot filter')
        const parsed = ListSnapshotsIpcSchema.safeParse({
          ...(keyword !== undefined ? { keyword } : {}),
          ...(rootsOnly !== undefined ? { rootsOnly } : {}),
          ...(parentSessionId !== undefined ? { parentSessionId } : {}),
          ...(includeArchived !== undefined ? { includeArchived } : {}),
          ...(limit !== undefined ? { limit } : {})
        })
        if (!parsed.success) {
          throw invalidInput('Invalid snapshot filter', parsed.error)
        }
        return db.listSnapshotSessions(parsed.data ?? {})
      }
    },

    // GET /api/snapshots/:id — mirror `getSnapshot`.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.snapshots, '([^/]+)'),
      handler: (request: RouteRequest): SnapshotSession | null => {
        const sessionId = decodeParam(request.params[0], 'Invalid snapshot session_id')
        const parsed = SnapshotSessionIdIpcSchema.safeParse(sessionId)
        if (!parsed.success) {
          throw invalidInput('Invalid snapshot session_id', parsed.error)
        }
        return db.getSnapshotSession(parsed.data)
      }
    },

    // POST /api/snapshots/:id/restore — mirror `restoreSnapshotPrevious`.
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.snapshots, '([^/]+)', 'restore'),
      handler: (request: RouteRequest): SnapshotSession => {
        const sessionId = decodeParam(request.params[0], 'Invalid snapshot session_id')
        const parsed = SnapshotSessionIdIpcSchema.safeParse(sessionId)
        if (!parsed.success) {
          throw invalidInput('Invalid snapshot session_id', parsed.error)
        }
        const session = db.restoreSnapshotPrevious(parsed.data)
        deps.notifyDataChanged()
        return session
      }
    },

    // POST /api/snapshots/:id/archive — mirror `archiveSnapshot`.
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.snapshots, '([^/]+)', 'archive'),
      handler: (request: RouteRequest): SnapshotSession => {
        const sessionId = decodeParam(request.params[0], 'Invalid snapshot session_id')
        const parsed = SnapshotArchiveIpcSchema.safeParse({
          sessionId,
          archived: bodyField(request.body, 'archived')
        })
        if (!parsed.success) {
          throw invalidInput('Invalid snapshot archive payload', parsed.error)
        }
        const session = db.setSnapshotArchived(parsed.data.sessionId, parsed.data.archived)
        deps.notifyDataChanged()
        return session
      }
    },

    // DELETE /api/snapshots/:id — mirror `deleteSnapshot` (cascade included).
    {
      method: 'DELETE',
      pattern: createPattern(WEB_API_PATHS.snapshots, '([^/]+)'),
      handler: (request: RouteRequest): DeleteSnapshotResult => {
        const sessionId = decodeParam(request.params[0], 'Invalid snapshot session_id')
        const parsed = SnapshotSessionIdIpcSchema.safeParse(sessionId)
        if (!parsed.success) {
          throw invalidInput('Invalid snapshot session_id', parsed.error)
        }
        const deleted = db.deleteSnapshotSession(parsed.data)
        if (deleted > 0) deps.notifyDataChanged()
        return { deleted }
      }
    },

    // GET /api/stats — mirror `getStats`.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.stats),
      handler: (): DashboardStats => db.getStats()
    },

    // GET /api/db — mirror `getDatabaseInfo`, but reduce the absolute path to
    // its file name (`:memory:` stays `:memory:`).
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.database),
      handler: (): DatabaseInfo => {
        const info = db.getDatabaseInfo()
        return {
          ...info,
          dbPath: info.dbPath === ':memory:' ? info.dbPath : basename(info.dbPath)
        }
      }
    },

    // GET /api/app — mirror `getAppInfo`; the entry already sanitized it.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.app),
      handler: (): AppInfo => deps.appInfo
    },

    // GET /api/config — Web-only runtime facts (no absolute paths or secrets).
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.config),
      handler: (): WebConfigInfo => deps.config
    },

    // GET /api/setup — mirror `getSetupInfo`.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.setup),
      handler: (): SetupInfo => deps.getSetupInfo()
    },

    // POST /api/setup — mirror `runSetup` (same schema, awaited in-process).
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.setup),
      handler: async (request: RouteRequest): Promise<SetupRunResult> => {
        const parsed = SetupRunRequestIpcSchema.safeParse(request.body)
        if (!parsed.success) {
          throw invalidInput('Invalid setup request', parsed.error)
        }
        return await deps.runSetup(parsed.data)
      }
    },

    // POST /api/demo/seed — mirror `seedDemoData`.
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.seedDemoData),
      handler: (): SeedDemoResult => {
        const inserted = deps.seedDemo()
        if (inserted > 0) deps.notifyDataChanged()
        return { inserted }
      }
    }
  ]
}
