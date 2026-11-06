/**
 * Memory Nebula graph endpoint for the ported Cortex UI.
 *
 * `POST /cortex-api/cortex/graph` (body: `MemoryGraphQuery` JSON) →
 * `MemoryGraphData`, computed by the vendored Cortex graph builder
 * (`src/cortex-ui/graph/buildMemoryGraph.ts`, compiled by
 * `scripts/build-host-graph.mjs`) against a read-only `node:sqlite` adapter.
 *
 * This route is a pure read projection: it never writes and never mutates the
 * database. It uses POST only because the renderer transport sends the nested
 * `MemoryGraphQuery` as a JSON body (see `src/cortex-ui/dsh/api.ts`).
 *
 * Exports the stable dispatcher contract used by `src/host/cortex/index.js`:
 *
 *   const handled = await handleGraph({ req, res, method, path, searchParams,
 *                                       holder, repository, config })
 *
 * Returns `true` when this module wrote the response (success or error) and
 * `false` when the path is not ours.
 */

import {
  assertLoopbackHost,
  assertLoopbackPeer,
  badRequest,
  methodNotAllowed,
  parseRequestUrl,
  readJsonBody,
  sendError,
  sendJson,
} from '../http.js'
import { buildMemoryGraph } from './graph-builder.js'
import { createGraphDatabaseAdapter } from './graph-adapter.js'
import {
  REALM_FILTERS,
  isValidAssetIdentifier,
} from './shared/types.js'

const PREFIX = '/cortex-api/cortex'

const MAX_HOST_PORT = 4_000
const MAX_SESSION_ID = 100
const MAX_PROJECT_NAME = 120

const MEMORY_GRAPH_LIMIT_BOUNDS = {
  hosts: [1, 500],
  vulnerabilities: [1, 2_000],
  leaks: [1, 1_000],
  snapshots: [1, 200],
  footholds: [1, 300],
  internalHosts: [1, 1_000],
  internalServices: [1, 3_000],
}

/* ------------------------------------------------------------- routing -- */

/** Resolve the cortex-relative path from the dispatcher context (or req.url). */
export function resolveCortexPath(ctx) {
  const raw = typeof ctx?.path === 'string' && ctx.path.length > 0 ? ctx.path : undefined
  if (raw !== undefined) {
    if (raw === PREFIX) return '/'
    if (raw.startsWith(`${PREFIX}/`)) return stripTrailingSlash(raw.slice(PREFIX.length))
    return stripTrailingSlash(raw)
  }
  if (typeof ctx?.req?.url === 'string') {
    const pathname = parseRequestUrl(ctx.req).pathname
    if (pathname === PREFIX) return '/'
    if (pathname.startsWith(`${PREFIX}/`)) return stripTrailingSlash(pathname.slice(PREFIX.length))
    return stripTrailingSlash(pathname)
  }
  return '/'
}

function stripTrailingSlash(path) {
  if (path.length > 1 && path.endsWith('/')) return path.replace(/\/+$/, '') || '/'
  return path
}

function upperMethod(ctx) {
  const method = ctx?.method ?? ctx?.req?.method ?? 'GET'
  return String(method).toUpperCase()
}

/* --------------------------------------------------------- validation -- */

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw badRequest(`${label} has an unknown field: ${key}`, { field: `${label}.${key}` })
    }
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${label} must be an object`, { field: label })
  }
  return value
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw badRequest(`${label} must be a boolean`, { field: label })
  return value
}

function boundedInt(value, label, [min, max]) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest(`${label} must be an integer`, { field: label })
  }
  if (value < min || value > max) {
    throw badRequest(`${label} must be between ${min} and ${max}`, { field: label, min, max })
  }
  return value
}

function nonEmptyString(value, label, maxLength) {
  if (typeof value !== 'string') throw badRequest(`${label} must be a string`, { field: label })
  const trimmed = value.trim()
  if (trimmed.length === 0) throw badRequest(`${label} must not be empty`, { field: label })
  if (trimmed.length > maxLength) {
    throw badRequest(`${label} is too long`, { field: label, max: maxLength })
  }
  return trimmed
}

/**
 * Strict `MemoryGraphQuery` validation, mirroring `MemoryGraphQueryIpcSchema`
 * from the original desktop bridge (`src/main/ipc/schemas.ts`) without needing
 * zod at Host runtime: unknown fields fail loudly instead of being ignored.
 */
export function validateMemoryGraphQuery(input) {
  const query = requireObject(input, 'query')
  rejectUnknownKeys(query, ['scope', 'realm', 'depth', 'filters', 'limits'], 'query')
  return {
    scope: validateScope(query.scope),
    ...(query.realm !== undefined ? { realm: validateRealm(query.realm) } : {}),
    ...(query.depth !== undefined ? { depth: validateDepth(query.depth) } : {}),
    ...(query.filters !== undefined ? { filters: validateFilters(query.filters) } : {}),
    ...(query.limits !== undefined ? { limits: validateLimits(query.limits) } : {}),
  }
}

function validateScope(scopeInput) {
  const scope = requireObject(scopeInput, 'scope')
  if (scope.kind === 'all') {
    rejectUnknownKeys(scope, ['kind'], 'scope')
    return { kind: 'all' }
  }
  if (scope.kind === 'asset') {
    rejectUnknownKeys(scope, ['kind', 'hostPort'], 'scope')
    const hostPort = nonEmptyString(scope.hostPort, 'scope.hostPort', MAX_HOST_PORT)
    if (!isValidAssetIdentifier(hostPort)) {
      throw badRequest('scope.hostPort must be a URL, host or host:port without whitespace', {
        field: 'scope.hostPort',
      })
    }
    return { kind: 'asset', hostPort }
  }
  if (scope.kind === 'task') {
    rejectUnknownKeys(scope, ['kind', 'sessionId', 'includeChildren'], 'scope')
    const sessionId = nonEmptyString(scope.sessionId, 'scope.sessionId', MAX_SESSION_ID)
    const includeChildren = optionalBoolean(scope.includeChildren, 'scope.includeChildren')
    return {
      kind: 'task',
      sessionId,
      ...(includeChildren !== undefined ? { includeChildren } : {}),
    }
  }
  throw badRequest('scope.kind must be one of all, asset, task', { field: 'scope.kind' })
}

function validateRealm(value) {
  if (typeof value !== 'string' || !REALM_FILTERS.includes(value)) {
    throw badRequest(`realm must be one of ${REALM_FILTERS.join(', ')}`, {
      field: 'realm',
      allowed: REALM_FILTERS,
    })
  }
  return value
}

function validateDepth(value) {
  if (value !== 1 && value !== 2) {
    throw badRequest('depth must be 1 or 2', { field: 'depth', allowed: [1, 2] })
  }
  return value
}

function validateFilters(value) {
  const filters = requireObject(value, 'filters')
  rejectUnknownKeys(filters, ['vulnerabilities', 'leaks', 'snapshots', 'internal'], 'filters')
  const result = {}
  for (const key of ['vulnerabilities', 'leaks', 'snapshots', 'internal']) {
    const parsed = optionalBoolean(filters[key], `filters.${key}`)
    if (parsed !== undefined) result[key] = parsed
  }
  return result
}

function validateLimits(value) {
  const limits = requireObject(value, 'limits')
  rejectUnknownKeys(limits, Object.keys(MEMORY_GRAPH_LIMIT_BOUNDS), 'limits')
  const result = {}
  for (const [key, bounds] of Object.entries(MEMORY_GRAPH_LIMIT_BOUNDS)) {
    if (limits[key] === undefined) continue
    result[key] = boundedInt(limits[key], `limits.${key}`, bounds)
  }
  return result
}

/* ----------------------------------------------------------- handlers -- */

/**
 * Handle `POST /graph`.
 * @param {{req: import('node:http').IncomingMessage,
 *          res: import('node:http').ServerResponse,
 *          method?: string, path?: string, holder: any}} ctx
 * @returns {Promise<boolean>} true when the response was written by this module
 */
export async function handleGraph(ctx) {
  if (!ctx || typeof ctx !== 'object') return false
  const path = resolveCortexPath(ctx)
  if (path !== '/graph') return false

  const { req, res, holder } = ctx
  try {
    // Belt and braces: the central router already fences every /cortex-api
    // request, but a directly mounted handler must never weaken the fence.
    assertLoopbackPeer(req)
    assertLoopbackHost(req)

    if (upperMethod(ctx) !== 'POST') throw methodNotAllowed()

    const body = await readJsonBody(req)
    const query = validateMemoryGraphQuery(body)

    holder.ensure()
    holder.assertUsable()

    const adapter = createGraphDatabaseAdapter(holder)
    const graph = buildMemoryGraph(adapter, query)
    sendJson(res, 200, graph)
  } catch (err) {
    sendError(res, err)
  }
  return true
}

/**
 * Query helpers shared with `internal.js` (which imports the same context
 * contract). Kept here so both modules strip the prefix identically.
 */
export function getProjectNameFromQuery(searchParams) {
  if (!searchParams || typeof searchParams.get !== 'function') return undefined
  const raw = searchParams.get('project_name') ?? searchParams.get('project')
  if (raw === null || raw === undefined) return undefined
  const trimmed = String(raw).trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > MAX_PROJECT_NAME) {
    throw badRequest('project_name is too long', { field: 'project_name', max: MAX_PROJECT_NAME })
  }
  return trimmed
}

/** Re-exported for tests/integration: the route prefix this module serves. */
export { PREFIX as CORTEX_PREFIX }
