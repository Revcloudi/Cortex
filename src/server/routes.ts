import { basename } from 'node:path'
import { buildMemoryGraph } from '../core/graph/buildMemoryGraph'
import {
  AssetHostPortIpcSchema,
  DeleteVulnerabilityIpcSchema,
  GetVulnerabilityIpcSchema,
  ImportLootIpcSchema,
  InternalGraphQueryIpcSchema,
  InternalOverviewIpcSchema,
  ListAssetsIpcSchema,
  ListLootImportsIpcSchema,
  ListSnapshotsIpcSchema,
  DashboardStatsIpcSchema,
  ListVulnerabilitiesIpcSchema,
  MemoryGraphQueryIpcSchema,
  RecordCredentialTrialIpcSchema,
  SetupRunRequestIpcSchema,
  SnapshotArchiveIpcSchema,
  SnapshotSessionIdIpcSchema,
  UpdateStatusIpcSchema,
  VulnerabilityIdsIpcSchema,
  SavePocConfigIpcSchema,
  RepeaterSendIpcSchema
} from '../main/ipc/schemas'
import {
  buildReportFilename,
  buildVulnerabilityReportMarkdown
} from '../shared/markdownReport'
import type { MemoryGraphData } from '../shared/graph'
import type {
  AppInfo,
  AssetContext,
  AssetListItem,
  CredentialTrial,
  DashboardStats,
  DatabaseInfo,
  DeleteAssetResult,
  DeleteSnapshotResult,
  DeleteVulnResult,
  DeleteVulnsResult,
  InternalGraphData,
  InternalOverview,
  InternalProjectSummary,
  LootImport,
  PaginatedVulnerabilities,
  SeedDemoResult,
  SetupInfo,
  SetupRunResult,
  SnapshotListResult,
  SnapshotSession,
  Vulnerability,
  VulnerabilityListItem
} from '../shared/types'
import type { PocConfigView } from '../shared/poc'
import { parsePocError } from '../shared/poc'
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

/**
 * 403 when `ctx web` opened the SQLite file read-only (plan §9.2): every write
 * route answers with the same user-safe message instead of relying on a raw
 * `SQLITE_READONLY` error mapping. Reads keep working in that mode.
 */
function assertWritable(deps: WebServerDeps, action: string): void {
  if (deps.config.readOnly) {
    throw new WebApiError(
      403,
      `${action} is unavailable: the Web server opened the database read-only and this action needs write permission on the SQLite file.`
    )
  }
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

/** Strip server-local paths and AI provider details from the Web retest view. */
function sanitizeRetestConfigForWeb(view: PocConfigView): PocConfigView {
  return {
    ...view,
    path: basename(view.path),
    providers: [],
    activeProviderId: null,
    enabled: false,
    executionEnabled: false,
    overriddenByEnv: [],
    permissionWarning: null
  }
}

/** Map a machine-readable POC error to a safe HTTP response. */
function throwRetestHttpError(error: unknown): never {
  if (error instanceof WebApiError) throw error
  const raw = error instanceof Error ? error.message : String(error)
  const parsed = parsePocError(raw)
  if (parsed.code !== null) {
    const status =
      parsed.code === 'POC_ARTIFACT_NOT_FOUND'
        ? 404
        : parsed.code === 'POC_TARGET_NOT_ALLOWED'
          ? 403
          : 400
    throw new WebApiError(status, parsed.message || raw)
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(raw)) {
    throw new WebApiError(502, '目标不可达或连接被拒绝，请确认目标服务和复测代理设置。')
  }
  throw error
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
        const realm = stringQuery(request.query, 'realm')
        const page = numberQuery(request.query, 'page', 'Invalid vulnerability filter')
        const pageSize = numberQuery(request.query, 'pageSize', 'Invalid vulnerability filter')
        const parsed = ListVulnerabilitiesIpcSchema.safeParse({
          ...(search !== undefined ? { search } : {}),
          ...(severity !== undefined ? { severity } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(realm !== undefined ? { realm } : {}),
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

    // GET /api/retest/config — retest-scoped proxy configuration (sanitized).
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.retestConfig),
      handler: (): PocConfigView => sanitizeRetestConfigForWeb(deps.pocConfig.view())
    },

    // POST /api/retest/config — update only the retest proxy from the Web UI.
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.retestConfig),
      handler: (request: RouteRequest): PocConfigView => {
        const parsed = SavePocConfigIpcSchema.safeParse({
          proxy: bodyField(request.body, 'proxy')
        })
        if (!parsed.success) {
          throw invalidInput('Invalid retest proxy payload', parsed.error)
        }
        try {
          return sanitizeRetestConfigForWeb(deps.pocConfig.save(parsed.data))
        } catch (error) {
          throwRetestHttpError(error)
        }
      }
    },

    // POST /api/retest/repeater — send a raw HTTP request for one Web finding.
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.retestRepeater),
      handler: async (request: RouteRequest) => {
        const parsed = RepeaterSendIpcSchema.safeParse(request.body)
        if (!parsed.success) {
          throw invalidInput('Invalid repeater payload', parsed.error)
        }
        try {
          return await deps.repeater.send(parsed.data)
        } catch (error) {
          throwRetestHttpError(error)
        }
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

    /**
     * GET /api/graph — read-only Memory Nebula projection (guide §9.3).
     *
     * Mirrors `getMemoryGraph`: the query string is flattened into the shared
     * `MemoryGraphQuery` shape and validated with the same strict schema the
     * desktop IPC bridge uses. Unknown query parameters are ignored like every
     * other route, and the builder never writes, so no `changed` event fires.
     */
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.graph),
      handler: (request: RouteRequest): MemoryGraphData => {
        const errorScope = 'Invalid memory graph query'
        const kind = stringQuery(request.query, 'kind') ?? 'all'
        const hostPort = stringQuery(request.query, 'hostPort')
        const sessionId = stringQuery(request.query, 'sessionId')
        const includeChildren = booleanQuery(request.query, 'includeChildren', errorScope)
        const depth = numberQuery(request.query, 'depth', errorScope)
        // Realm filter (plan §7.2): validated by the shared schema below, which
        // only accepts web / internal / all (the builder defaults to `web`).
        const realm = stringQuery(request.query, 'realm')
        // The shared schema is a strict discriminated union: only the fields
        // that belong to the requested kind may reach validation.
        const scope: Record<string, unknown> =
          kind === 'asset'
            ? { kind, ...(hostPort !== undefined ? { hostPort } : {}) }
            : kind === 'task'
              ? {
                  kind,
                  ...(sessionId !== undefined ? { sessionId } : {}),
                  ...(includeChildren !== undefined ? { includeChildren } : {})
                }
              : { kind }
        const vulnerabilities = booleanQuery(request.query, 'vulnerabilities', errorScope)
        const leaks = booleanQuery(request.query, 'leaks', errorScope)
        const snapshots = booleanQuery(request.query, 'snapshots', errorScope)
        const internal = booleanQuery(request.query, 'internal', errorScope)
        const filters =
          vulnerabilities !== undefined ||
          leaks !== undefined ||
          snapshots !== undefined ||
          internal !== undefined
            ? {
                ...(vulnerabilities !== undefined ? { vulnerabilities } : {}),
                ...(leaks !== undefined ? { leaks } : {}),
                ...(snapshots !== undefined ? { snapshots } : {}),
                ...(internal !== undefined ? { internal } : {})
              }
            : undefined
        const hosts = numberQuery(request.query, 'limitHosts', errorScope)
        const vulnerabilityLimit = numberQuery(request.query, 'limitVulnerabilities', errorScope)
        const leakLimit = numberQuery(request.query, 'limitLeaks', errorScope)
        const snapshotLimit = numberQuery(request.query, 'limitSnapshots', errorScope)
        const footholdLimit = numberQuery(request.query, 'limitFootholds', errorScope)
        const internalHostLimit = numberQuery(request.query, 'limitInternalHosts', errorScope)
        const internalServiceLimit = numberQuery(
          request.query,
          'limitInternalServices',
          errorScope
        )
        const limits =
          hosts !== undefined ||
          vulnerabilityLimit !== undefined ||
          leakLimit !== undefined ||
          snapshotLimit !== undefined ||
          footholdLimit !== undefined ||
          internalHostLimit !== undefined ||
          internalServiceLimit !== undefined
            ? {
                ...(hosts !== undefined ? { hosts } : {}),
                ...(vulnerabilityLimit !== undefined
                  ? { vulnerabilities: vulnerabilityLimit }
                  : {}),
                ...(leakLimit !== undefined ? { leaks: leakLimit } : {}),
                ...(snapshotLimit !== undefined ? { snapshots: snapshotLimit } : {}),
                ...(footholdLimit !== undefined ? { footholds: footholdLimit } : {}),
                ...(internalHostLimit !== undefined
                  ? { internalHosts: internalHostLimit }
                  : {}),
                ...(internalServiceLimit !== undefined
                  ? { internalServices: internalServiceLimit }
                  : {})
              }
            : undefined
        const parsed = MemoryGraphQueryIpcSchema.safeParse({
          scope,
          ...(realm !== undefined ? { realm } : {}),
          ...(depth !== undefined ? { depth } : {}),
          ...(filters !== undefined ? { filters } : {}),
          ...(limits !== undefined ? { limits } : {})
        })
        if (!parsed.success) {
          throw invalidInput(errorScope, parsed.error)
        }
        return buildMemoryGraph(deps.db, parsed.data)
      }
    },

    /**
     * Internal operations projections (Plan B). The four reads below never
     * write and so never emit the SSE `changed` event. `project` is optional
     * for overview / loot list (the database falls back to the active project)
     * and required for the graph, which is always scoped to one project.
     */
    // GET /api/internal/overview?project= — mirror `getInternalOverview`.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.internalOverview),
      handler: (request: RouteRequest): InternalOverview => {
        const project = stringQuery(request.query, 'project')
        const parsed = InternalOverviewIpcSchema.safeParse(
          project === undefined ? undefined : { project_name: project }
        )
        if (!parsed.success) {
          throw invalidInput('Invalid internal overview filter', parsed.error)
        }
        return db.getInternalOverview(parsed.data?.project_name)
      }
    },

    // GET /api/internal/graph?project= — mirror `getInternalGraph`.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.internalGraph),
      handler: (request: RouteRequest): InternalGraphData => {
        const parsed = InternalGraphQueryIpcSchema.safeParse({
          project_name: stringQuery(request.query, 'project')
        })
        if (!parsed.success) {
          throw invalidInput('Invalid internal graph query', parsed.error)
        }
        return db.getInternalGraph(parsed.data.project_name)
      }
    },

    // GET /api/internal/projects — mirror `getInternalProjects`.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.internalProjects),
      handler: (): InternalProjectSummary[] => db.getInternalProjects()
    },

    // GET /api/loot?project= — mirror `listLootImports` (newest first).
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.loot),
      handler: (request: RouteRequest): LootImport[] => {
        const project = stringQuery(request.query, 'project')
        const parsed = ListLootImportsIpcSchema.safeParse(
          project === undefined ? undefined : { project_name: project }
        )
        if (!parsed.success) {
          throw invalidInput('Invalid loot import filter', parsed.error)
        }
        return db.listLootImports(parsed.data?.project_name)
      }
    },

    // POST /api/internal/credential-trial — mirror `recordCredentialTrial`.
    // Recording an observed trial is a write; the matrix never attempts one.
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.internalCredentialTrial),
      handler: (request: RouteRequest): CredentialTrial => {
        const parsed = RecordCredentialTrialIpcSchema.safeParse(request.body)
        if (!parsed.success) {
          throw invalidInput('Invalid credential trial payload', parsed.error)
        }
        assertWritable(deps, 'Credential trial recording')
        const trial = db.recordCredentialTrial(parsed.data)
        deps.notifyDataChanged()
        return trial
      }
    },

    /**
     * POST /api/loot — parse ONE local loot file and persist the derived
     * internal entities (§8.4). The path is resolved on the server machine: the
     * parsers only read it (never execute the content) and the database stores
     * a path reference / hash / summary, not the raw file. `ctx web` is
     * token-authenticated, CSRF/Origin-gated and loopback-only unless
     * `--allow-intranet` was passed, so this stays a local / trusted-intranet
     * action; read-only servers answer 403.
     */
    {
      method: 'POST',
      pattern: createPattern(WEB_API_PATHS.loot),
      handler: (request: RouteRequest): LootImport => {
        const parsed = ImportLootIpcSchema.safeParse(request.body)
        if (!parsed.success) {
          throw invalidInput('Invalid loot import payload', parsed.error)
        }
        assertWritable(deps, 'Loot import')
        const imported = db.importLoot(parsed.data)
        deps.notifyDataChanged()
        return imported
      }
    },

    // GET /api/stats — mirror `getStats`; `?realm=web|internal|all` scopes the counters.
    {
      method: 'GET',
      pattern: createPattern(WEB_API_PATHS.stats),
      handler: (request: RouteRequest): DashboardStats => {
        const realm = stringQuery(request.query, 'realm')
        const parsed = DashboardStatsIpcSchema.safeParse({
          ...(realm !== undefined ? { realm } : {})
        })
        if (!parsed.success) {
          throw invalidInput('Invalid stats query', parsed.error)
        }
        return db.getStats(parsed.data ?? {})
      }
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
