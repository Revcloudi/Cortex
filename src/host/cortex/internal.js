/**
 * Cortex internal-operations endpoints for the ported Cortex UI.
 *
 * Served under `/cortex-api/cortex` (cortex-relative paths below), read-only
 * except the append-only credential-trial record:
 *
 *   GET  /internal/overview?project_name=   -> InternalOverview
 *   GET  /internal/graph?project_name=      -> InternalGraphData
 *   GET  /internal/projects                 -> InternalProjectSummary[]
 *   POST /internal/credential-trial         -> CredentialTrial   (appends one row)
 *   GET  /loot?project_name=                -> LootImport[]
 *
 * Shapes come from the vendored `src/cortex-ui/shared/internal.ts` and match the
 * original `DatabaseService.getInternalOverview/getInternalGraph/...`
 * projections 1:1, reimplemented over `node:sqlite` in `graph-adapter.js`
 * (schema v5). Query parameter name follows the ported renderer contract
 * (`src/cortex-ui/dsh/api.ts`): `project_name`; the legacy `project` spelling is
 * accepted as an alias for the original `ctx web` transport.
 *
 * Dispatcher contract (same as `graph.js`):
 *
 *   const handled = await handleInternal({ req, res, method, path, searchParams,
 *                                          holder, repository, config })
 *
 * Returns `true` when this module wrote the response and `false` otherwise.
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
import { createGraphDatabaseAdapter } from './graph-adapter.js'
import { getProjectNameFromQuery, resolveCortexPath } from './graph.js'

const PATHS = {
  overview: '/internal/overview',
  graph: '/internal/graph',
  projects: '/internal/projects',
  credentialTrial: '/internal/credential-trial',
  loot: '/loot',
}

/** route path -> required HTTP method. */
const ROUTES = new Map([
  [PATHS.overview, 'GET'],
  [PATHS.graph, 'GET'],
  [PATHS.projects, 'GET'],
  [PATHS.credentialTrial, 'POST'],
  [PATHS.loot, 'GET'],
])

function upperMethod(ctx) {
  const method = ctx?.method ?? ctx?.req?.method ?? 'GET'
  return String(method).toUpperCase()
}

function searchParamsOf(ctx) {
  if (ctx && ctx.searchParams && typeof ctx.searchParams.get === 'function') {
    return ctx.searchParams
  }
  return parseRequestUrl(ctx?.req).searchParams
}

/**
 * Handle one internal-operations request.
 * @param {{req: import('node:http').IncomingMessage,
 *          res: import('node:http').ServerResponse,
 *          method?: string, path?: string, searchParams?: URLSearchParams,
 *          holder: any}} ctx
 * @returns {Promise<boolean>} true when the response was written by this module
 */
export async function handleInternal(ctx) {
  if (!ctx || typeof ctx !== 'object') return false
  const path = resolveCortexPath(ctx)
  const expectedMethod = ROUTES.get(path)
  if (expectedMethod === undefined) return false

  const { req, res, holder } = ctx
  try {
    // The central router already fences /cortex-api, but a directly mounted
    // handler must never weaken the loopback fence (reuse http.js — no copy).
    assertLoopbackPeer(req)
    assertLoopbackHost(req)

    if (upperMethod(ctx) !== expectedMethod) throw methodNotAllowed()

    holder.ensure()
    holder.assertUsable()

    const adapter = createGraphDatabaseAdapter(holder)
    const searchParams = searchParamsOf(ctx)
    let payload

    switch (path) {
      case PATHS.overview: {
        const projectName = getProjectNameFromQuery(searchParams)
        payload = adapter.getInternalOverview(projectName)
        break
      }
      case PATHS.graph: {
        const projectName = getProjectNameFromQuery(searchParams)
        if (projectName === undefined) {
          throw badRequest('project_name is required', { field: 'project_name' })
        }
        payload = adapter.getInternalGraph(projectName)
        break
      }
      case PATHS.projects: {
        payload = adapter.listInternalProjects()
        break
      }
      case PATHS.loot: {
        const projectName = getProjectNameFromQuery(searchParams)
        payload = adapter.listLootImports(projectName)
        break
      }
      case PATHS.credentialTrial: {
        // Write route: `holder.withWriteTransaction()` inside the adapter raises
        // 403 READ_ONLY when the database is opened read-only (contract §2.3).
        const body = await readJsonBody(req)
        payload = await adapter.recordCredentialTrial(body)
        break
      }
      /* c8 ignore next -- exhaustive switch, kept for future routes */
      default:
        return false
    }

    sendJson(res, 200, payload)
  } catch (err) {
    sendError(res, err)
  }
  return true
}

/** Re-exported for tests / integration wiring. */
export { PATHS as INTERNAL_PATHS }
