/**
 * Route table + dispatch for the `/cortex-api` prefix (contract §2.4/§2.5).
 *
 * Dispatch order:
 *   0. `/cortex-api/cortex/**` -> `handleCortex` (ported Cortex UI; fences and
 *      DB guards handled there, before the legacy table below)
 *   1. parse URL
 *   2. loopback peer fence
 *   3. loopback Host fence
 *   4. route match (unknown path -> 404 NOT_FOUND, known path/wrong method -> 405)
 *   5. same-origin write fence for PATCH/POST routes
 *   6. lazy DB open + schema/write guards
 *   7. handler
 *
 * Errors propagate to `createCortexHost().handler`, which maps them onto the
 * shared `{error, code, details?}` envelope. Nothing here throws into Node.
 */

import {
  ApiError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_VALUE,
  assertLoopbackHost,
  assertLoopbackPeer,
  assertSameOriginWrite,
  badRequest,
  describeError,
  methodNotAllowed,
  notFound,
  parseRequestUrl,
  queryBool01,
  queryEnum,
  queryInt,
  queryString,
  readJsonBody,
  requireBodyEnum,
  requireBodyString,
  safeDecode,
  sendError,
  sendJson,
  sendMarkdown,
} from './http.js'
import * as dto from './dto.js'
import { CORTEX_PREFIX, handleCortex } from './cortex/index.js'
import { buildVulnReport, reportFilename } from './reports.js'
import { sendRetest, validateSendRequest, ALLOWED_METHODS as RETEST_METHODS } from './retest.js'
import { SEVERITIES, STATUSES, ASSET_STATUSES } from './repository.js'

const PREFIX = '/cortex-api'

const REALM_FILTERS = ['web', 'internal', 'all']

const MAX_VULN_ID = 200
const MAX_SESSION_ID = 200
const MAX_HOST_PORT = 4000

/**
 * Strip the registered route prefix. Returns the raw remainder starting with
 * '/', or null when the path is outside the prefix.
 * @param {string} pathname
 */
function stripPrefix(pathname) {
  if (pathname === PREFIX || pathname === `${PREFIX}/`) return '/'
  if (!pathname.startsWith(`${PREFIX}/`)) return null
  return pathname.slice(PREFIX.length)
}

/** @param {unknown} value @param {number} max @param {string} label */
function pathParam(value, max, label) {
  const decoded = safeDecode(value, label)
  if (decoded.length === 0) throw notFound(`${label} is required`)
  if (decoded.length > max) throw badRequest(`${label} is too long`, { max })
  return decoded
}

/**
 * @param {{req: import('node:http').IncomingMessage,
 *          res: import('node:http').ServerResponse,
 *          holder: import('./db.js').DatabaseHolder,
 *          repository: import('./repository.js').Repository,
 *          config: {allowNetwork?: boolean},
 *          version: string,
 *          dshVersion: string}} deps
 */
export function createRouter(deps) {
  const { holder, repository, config } = deps
  const version = deps.version
  const dshVersion = deps.dshVersion

  /* --------------------------- route table ------------------------------ */

  const ROUTES = [
    {
      name: 'health',
      pattern: /^\/health$/,
      needsDb: false,
      methods: { GET: handleHealth },
    },
    {
      name: 'stats',
      pattern: /^\/stats$/,
      methods: { GET: handleStats },
    },
    {
      name: 'vulns.list',
      pattern: /^\/vulns$/,
      methods: { GET: handleListVulns },
    },
    {
      name: 'vulns.detail',
      pattern: /^\/vulns\/([^/]+)$/,
      methods: { GET: handleVulnDetail },
    },
    {
      name: 'vulns.status',
      pattern: /^\/vulns\/([^/]+)\/status$/,
      write: true,
      methods: { PATCH: handleVulnStatus },
    },
    {
      name: 'vulns.retest',
      pattern: /^\/vulns\/([^/]+)\/retest$/,
      write: true,
      methods: { POST: handleVulnRetest },
    },
    {
      name: 'assets.list',
      pattern: /^\/assets$/,
      methods: { GET: handleListAssets },
    },
    {
      name: 'assets.detail',
      pattern: /^\/assets\/(.+)$/,
      raw: true,
      methods: { GET: handleAssetDetail },
    },
    {
      name: 'internal.projects',
      pattern: /^\/internal\/projects$/,
      methods: { GET: handleInternalProjects },
    },
    {
      name: 'internal.overview',
      pattern: /^\/internal\/overview$/,
      methods: { GET: handleInternalOverview },
    },
    {
      name: 'internal.graph',
      pattern: /^\/internal\/graph$/,
      methods: { GET: handleInternalGraph },
    },
    {
      name: 'snapshots.list',
      pattern: /^\/snapshots$/,
      methods: { GET: handleListSnapshots },
    },
    {
      name: 'snapshots.detail',
      pattern: /^\/snapshots\/([^/]+)$/,
      methods: { GET: handleSnapshotDetail },
    },
    {
      name: 'reports.detail',
      pattern: /^\/reports\/([^/]+)$/,
      methods: { GET: handleReport },
    },
    {
      name: 'retest.send',
      pattern: /^\/retest\/send$/,
      write: true,
      methods: { POST: handleRetestSend },
    },
  ]

  /* ----------------------------- handlers ------------------------------- */

  /** @param {{req:any,res:any}} ctx */
  function handleHealth({ res }) {
    const status = holder.status()
    sendJson(res, 200, {
      ok: Boolean(status.available && status.compatible),
      plugin: 'dsh-cortex',
      version,
      dsh: { version: dshVersion },
      sqlite: true,
      db: status,
      server: { loopbackOnly: true, time: new Date().toISOString() },
    })
  }

  function handleStats({ res, searchParams }) {
    const realm = queryEnum(searchParams, 'realm', REALM_FILTERS) ?? 'all'
    sendJson(res, 200, repository.stats({ realm }))
  }

  function handleListVulns({ res, searchParams }) {
    const realm = queryEnum(searchParams, 'realm', REALM_FILTERS) ?? 'all'
    const severity = queryEnum(searchParams, 'severity', SEVERITIES)
    const status = queryEnum(searchParams, 'status', STATUSES)
    const search = queryString(searchParams, 'search', { max: MAX_SEARCH_VALUE }) ?? ''
    const page = queryInt(searchParams, 'page', { min: 1 }) ?? 1
    const pageSize = queryInt(searchParams, 'pageSize', { min: 1, max: MAX_PAGE_SIZE }) ?? DEFAULT_PAGE_SIZE
    sendJson(res, 200, repository.listVulnerabilities({ realm, severity, status, search, page, pageSize }))
  }

  function handleVulnDetail({ res, params }) {
    const id = pathParam(params[0], MAX_VULN_ID, 'vulnerability id')
    const row = repository.getVulnerability(id)
    if (!row) throw notFound('vulnerability not found')
    sendJson(res, 200, {
      vuln: dto.vulnDetail(row),
      related: repository.relatedVulnerabilities(row),
    })
  }

  async function handleVulnStatus({ req, res, params }) {
    const id = pathParam(params[0], MAX_VULN_ID, 'vulnerability id')
    const body = await readJsonBody(req)
    const status = requireBodyEnum(body, 'status', STATUSES)
    const row = await repository.updateVulnerabilityStatus(id, status)
    if (!row) throw notFound('vulnerability not found')
    sendJson(res, 200, { ok: true, vuln: dto.vulnDetail(row) })
  }

  async function handleVulnRetest({ req, res, params }) {
    const id = pathParam(params[0], MAX_VULN_ID, 'vulnerability id')
    const body = await readJsonBody(req)
    const timeRange = requireBodyString(body, 'timeRange', { max: 200 })
    const conclusion = requireBodyString(body, 'conclusion', { max: 50000 })
    const row = await repository.appendRetestResult(id, { timeRange, conclusion })
    if (!row) throw notFound('vulnerability not found')
    sendJson(res, 200, { ok: true, vuln: dto.vulnDetail(row) })
  }

  function handleListAssets({ res, searchParams }) {
    const status = queryEnum(searchParams, 'status', ASSET_STATUSES)
    const search = queryString(searchParams, 'search', { max: MAX_SEARCH_VALUE }) ?? ''
    const page = queryInt(searchParams, 'page', { min: 1 }) ?? 1
    const pageSize = queryInt(searchParams, 'pageSize', { min: 1, max: MAX_PAGE_SIZE }) ?? DEFAULT_PAGE_SIZE
    sendJson(res, 200, repository.listAssets({ search, status, page, pageSize }))
  }

  function handleAssetDetail({ res, params }) {
    const hostPort = pathParam(params[0], MAX_HOST_PORT, 'hostPort')
    sendJson(res, 200, repository.getAssetDetail(hostPort))
  }

  function handleInternalProjects({ res }) {
    sendJson(res, 200, { projects: repository.internalProjects() })
  }

  function handleInternalOverview({ res, searchParams }) {
    const project = queryString(searchParams, 'project')
    sendJson(res, 200, repository.internalOverview(project))
  }

  function handleInternalGraph({ res, searchParams }) {
    const project = queryString(searchParams, 'project')
    sendJson(res, 200, repository.internalGraph(project))
  }

  function handleListSnapshots({ res, searchParams }) {
    const project = queryString(searchParams, 'project')
    const includeArchived = queryBool01(searchParams, 'includeArchived') ?? false
    const page = queryInt(searchParams, 'page', { min: 1 }) ?? 1
    const pageSize = queryInt(searchParams, 'pageSize', { min: 1, max: MAX_PAGE_SIZE }) ?? DEFAULT_PAGE_SIZE
    sendJson(res, 200, repository.listSnapshots({ project, includeArchived, page, pageSize }))
  }

  function handleSnapshotDetail({ res, params }) {
    const sessionId = pathParam(params[0], MAX_SESSION_ID, 'sessionId')
    sendJson(res, 200, repository.getSnapshot(sessionId))
  }

  function handleReport({ res, params }) {
    const id = pathParam(params[0], MAX_VULN_ID, 'vulnerability id')
    const data = repository.getReportData(id)
    const markdown = buildVulnReport(data.vuln, data.related)
    sendMarkdown(res, 200, markdown, reportFilename(data.vuln.id || id))
  }

  async function handleRetestSend({ req, res }) {
    if (config && config.allowNetwork === false) {
      throw new ApiError(403, 'FORBIDDEN', 'outbound network is disabled')
    }
    const body = await readJsonBody(req)
    const request = validateSendRequest(body)
    const context = repository.getRetestContext(request.vulnId)
    const result = await sendRetest({ request, context })
    sendJson(res, 200, result)
  }

  /* ----------------------------- dispatch ------------------------------- */

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  return async function route(req, res) {
    try {
      const { pathname, searchParams } = parseRequestUrl(req)
      const method = String((req && req.method) || 'GET').toUpperCase()

      // Ported Cortex desktop UI API. Delegated before the legacy route table
      // (and before `stripPrefix`); `handleCortex` runs the loopback peer/Host
      // fences, the same-origin write fence, DB guards and error envelope
      // itself, so the old `/cortex-api` routes stay byte-for-byte unchanged.
      if (pathname === CORTEX_PREFIX || pathname.startsWith(`${CORTEX_PREFIX}/`)) {
        const cortexPath = pathname === CORTEX_PREFIX ? '/' : pathname.slice(CORTEX_PREFIX.length)
        await handleCortex({
          req,
          res,
          path: cortexPath,
          method,
          url: req.url,
          holder,
          repository,
          config,
        })
        return
      }

      assertLoopbackPeer(req)
      assertLoopbackHost(req)

      const raw = stripPrefix(pathname)
      if (raw === null) throw notFound('route not found')

      if (method === 'OPTIONS') throw methodNotAllowed()

      const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw

      for (const entry of ROUTES) {
        const target = entry.raw ? raw : path
        const match = entry.pattern.exec(target)
        if (!match) continue
        const handler = entry.methods[method]
        if (!handler) throw methodNotAllowed()
        if (entry.write) assertSameOriginWrite(req)

        holder.ensure()
        if (entry.needsDb !== false) holder.assertUsable()
        if (entry.write) holder.assertWritable()

        await handler({ req, res, params: match.slice(1), searchParams, method })
        return
      }
      throw notFound('route not found')
    } catch (err) {
      sendError(res, err)
    }
  }
}

// Exported for tests / documentation parity: the outbound method allowlist is
// owned by retest.js.
export { RETEST_METHODS }
