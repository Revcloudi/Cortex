/**
 * Dispatcher for the ported Cortex desktop UI (`/cortex-api/cortex/**`).
 *
 * The vendored Cortex renderer talks to the host through
 * `src/cortex-ui/dsh/api.ts`, which maps every `CortexApi` method onto a route
 * under this prefix. This module owns the prefix end to end:
 *
 *   1. loopback peer + loopback Host fences (contract §2.4)
 *   2. same-origin write fence for POST/PATCH/PUT/DELETE
 *      (DELETE is exempt from the JSON Content-Type check because the client
 *      sends body-less deletes without a Content-Type header)
 *   3. route matching (unknown -> 404, known path / wrong method -> 405)
 *   4. lazy DB open + schema guard (+ read-only guard for writes)
 *   5. handler; every response is the JSON form of the shared TS contract
 *
 * `/graph` (Nebula) and `/internal/**` (+ `GET /loot`) are delegated to the
 * sibling modules `graph.js` / `internal.js`, which are owned by the Nebula
 * teammate. They are imported lazily so a temporarily missing/broken file can
 * never take down the whole host: the fallback answer is a structured 501.
 *
 * Nothing here throws into Node: every failure is mapped onto the shared
 * `{ error, code, details? }` envelope by `sendError`.
 */

import { readFileSync } from 'node:fs'
import {
  assertLoopbackHost,
  assertLoopbackPeer,
  assertSameOriginWrite,
  forbidden,
  isLoopbackOrigin,
  methodNotAllowed,
  notFound,
  parseRequestUrl,
  sendError,
  sendJson,
} from '../http.js'
import * as assets from './assets.js'
import * as exportRoutes from './export.js'
import * as fs from './fs.js'
import * as misc from './misc.js'
import * as settings from './settings.js'
import * as repeater from './repeater.js'
import * as repeaterStore from './repeater-store.js'
import * as snapshots from './snapshots.js'
import * as vulns from './vulns.js'

export const CORTEX_PREFIX = '/cortex-api/cortex'

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/** In-process write counter appended to the DB-derived revision. */
let writeEpoch = 0

/** Read the plugin version once (no absolute path is ever returned). */
let cachedVersion = null
function pluginVersion() {
  if (cachedVersion !== null) return cachedVersion
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    cachedVersion = pkg && typeof pkg.version === 'string' ? pkg.version : '0.1.0'
  } catch {
    cachedVersion = '0.1.0'
  }
  return cachedVersion
}

/* ------------------------------------------------------------------------- */
/* Route table                                                               */
/* ------------------------------------------------------------------------- */

/**
 * `methods` maps uppercase HTTP verbs to handlers. `db: false` marks routes
 * that must answer even when no compatible database is available.
 */
const ROUTES = [
  { pattern: /^\/rev$/, methods: { GET: handleRev } },

  { pattern: /^\/vulns$/, methods: { GET: vulns.handleList } },
  { pattern: /^\/vulns\/delete-many$/, methods: { POST: vulns.handleDeleteMany } },
  { pattern: /^\/vulns\/export$/, methods: { POST: vulns.handleExport } },
  { pattern: /^\/vulns\/([^/]+)\/status$/, methods: { PATCH: vulns.handleUpdateStatus } },
  { pattern: /^\/vulns\/([^/]+)$/, methods: { GET: vulns.handleGet, DELETE: vulns.handleDelete } },
  { pattern: /^\/stats$/, methods: { GET: vulns.handleStats } },

  { pattern: /^\/assets$/, methods: { GET: assets.handleList } },
  // Must be matched before the generic `/assets/:hostPort` route. The handler
  // removes only asset rows + identity sidecars; vulnerabilities stay intact.
  { pattern: /^\/assets\/bulk-delete$/, methods: { POST: assets.handleBulkDelete } },
  { pattern: /^\/assets\/(.+)\/related-vulns$/, methods: { GET: assets.handleRelatedVulns } },
  { pattern: /^\/assets\/(.+)$/, methods: { GET: assets.handleDetail, DELETE: assets.handleDelete } },

  { pattern: /^\/snapshots$/, methods: { GET: snapshots.handleList } },
  { pattern: /^\/snapshots\/([^/]+)\/archive$/, methods: { POST: snapshots.handleArchive } },
  // Both spellings exist: the vendored renderer's original Web API uses
  // `/restore`, while the desktop contract names it `restore-previous`.
  { pattern: /^\/snapshots\/([^/]+)\/restore$/, methods: { POST: snapshots.handleRestorePrevious } },
  {
    pattern: /^\/snapshots\/([^/]+)\/restore-previous$/,
    methods: { POST: snapshots.handleRestorePrevious },
  },
  {
    pattern: /^\/snapshots\/([^/]+)$/,
    methods: { GET: snapshots.handleDetail, DELETE: snapshots.handleDelete },
  },

  // `POST /loot/import` is desktop-only; `GET /loot` is delegated below.
  { pattern: /^\/loot\/import$/, methods: { POST: misc.unsupportedHandler }, db: false },

  { pattern: /^\/db\/info$/, methods: { GET: misc.handleDbInfo }, db: false },
  { pattern: /^\/db\/candidates$/, methods: { GET: misc.handleDbCandidates }, db: false },
  { pattern: /^\/db\/configure$/, methods: { POST: misc.handleDbConfigure }, db: false },
  { pattern: /^\/app\/info$/, methods: { GET: misc.handleAppInfo }, db: false },
  { pattern: /^\/setup\/info$/, methods: { GET: misc.handleSetupInfo }, db: false },
  { pattern: /^\/setup\/run$/, methods: { POST: misc.unsupportedHandler }, db: false },
  { pattern: /^\/seed-demo$/, methods: { POST: misc.unsupportedHandler }, db: false },

  { pattern: /^\/poc\/config$/, methods: { GET: misc.handlePocConfig, POST: misc.unsupportedHandler }, db: false },
  { pattern: /^\/poc\/reload$/, methods: { POST: misc.unsupportedHandler }, db: false },
  { pattern: /^\/poc\/providers$/, methods: { POST: misc.unsupportedHandler }, db: false },
  { pattern: /^\/poc\/providers\/([^/]+)$/, methods: { DELETE: misc.unsupportedHandler }, db: false },
  { pattern: /^\/poc\/models$/, methods: { POST: misc.unsupportedHandler }, db: false },
  { pattern: /^\/poc\/provider-test$/, methods: { POST: misc.unsupportedHandler }, db: false },

  { pattern: /^\/repeater\/send$/, methods: { POST: repeater.handleSend } },

  // Single-send history/collections. All state is local JSON under
  // CORTEX_REPEATER_DIR / ~/.cortex/repeater, so these routes must answer even
  // when no compatible database is open (`db: false`).
  {
    pattern: /^\/repeater\/history$/,
    methods: { GET: repeaterStore.handleHistoryList, DELETE: repeaterStore.handleHistoryClear },
    db: false,
  },
  {
    pattern: /^\/repeater\/collections$/,
    methods: {
      GET: repeaterStore.handleCollectionsList,
      POST: repeaterStore.handleCollectionsCreate,
    },
    db: false,
  },
  {
    pattern: /^\/repeater\/collections\/([^/]+)$/,
    methods: { DELETE: repeaterStore.handleCollectionsDelete },
    db: false,
  },

  // Directory browser for the export-path picker (read-only).
  { pattern: /^\/fs\/list$/, methods: { GET: fs.handleList }, db: false },
  // Remembered export defaults for the export dialog (plugin-local settings).
  { pattern: /^\/export\/settings$/, methods: { GET: settings.handleGetExportSettings }, db: false },
  // Project / selected-asset export to JSON, CSV or DefectDojo Generic Findings.
  { pattern: /^\/export\/project$/, methods: { POST: exportRoutes.handleProjectExport } },
  { pattern: /^\/export\/assets$/, methods: { POST: exportRoutes.handleAssetsExport } },
]

/* ------------------------------------------------------------------------- */
/* Fences                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Same-origin write fence, reusing `http.js`. DELETE requests from the renderer
 * carry no body and therefore no `Content-Type: application/json`, so they only
 * need the Origin / Sec-Fetch-Site checks (contract §2.4 defines the JSON
 * Content-Type requirement for POST/PATCH bodies).
 * @param {import('node:http').IncomingMessage} req
 * @param {string} method
 */
function assertWriteFence(req, method) {
  if (method !== 'DELETE') {
    assertSameOriginWrite(req)
    return
  }
  const headers = (req && req.headers) || {}
  const origin = headers.origin
  const fetchSite = String(headers['sec-fetch-site'] || '').trim().toLowerCase()
  if (origin !== undefined && origin !== null && String(origin).trim().length > 0) {
    if (!isLoopbackOrigin(String(origin))) {
      // DSH renders the plugin from the custom `dsh-app://app` origin; its
      // same-origin DELETE carries `Sec-Fetch-Site: same-origin`, which is the
      // signal we trust (a cross-site page would report cross-site).
      if (fetchSite !== 'same-origin' && fetchSite !== 'none') {
        throw forbidden('FORBIDDEN_ORIGIN', 'write request origin is not allowed')
      }
    }
  }
  if (fetchSite.length > 0 && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw forbidden('FORBIDDEN_ORIGIN', 'cross-site write requests are not allowed', {
      header: 'Sec-Fetch-Site',
    })
  }
}

/* ------------------------------------------------------------------------- */
/* Revision counter                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Cheap change marker for the renderer's `onDataChanged` polling.
 *
 * Combines the newest `updated_at`/`created_at` marker across the tables with a
 * row-count nibble and an in-process write counter (so status-only updates,
 * which have no dedicated timestamp column, still invalidate the UI).
 * @param {import('../db.js').DatabaseHolder} holder
 */
function computeRevision(holder) {
  try {
    const db = holder.db
    const markers = db
      .prepare(
        `SELECT MAX(ts) AS ts FROM (
           SELECT MAX(updated_at) AS ts FROM snapshot_sessions
           UNION ALL SELECT MAX(updated_at) FROM credentials
           UNION ALL SELECT MAX(updated_at) FROM footholds
           UNION ALL SELECT MAX(updated_at) FROM internal_hosts
           UNION ALL SELECT MAX(updated_at) FROM internal_services
           UNION ALL SELECT MAX(updated_at) FROM pivots
           UNION ALL SELECT MAX(created_at) FROM vulnerabilities
           UNION ALL SELECT MAX(created_at) FROM loot_imports
           UNION ALL SELECT MAX(attempted_at) FROM credential_trials
         )`,
      )
      .get()
    const markerMs = markers && markers.ts ? Date.parse(String(markers.ts)) : NaN
    const markerSeconds = Number.isFinite(markerMs) ? Math.floor(markerMs / 1000) : 0
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM vulnerabilities) AS vulns,
                (SELECT COUNT(*) FROM assets) AS assets,
                (SELECT COUNT(*) FROM snapshot_sessions) AS snapshots`,
      )
      .get()
    const totalRows =
      (Number(counts && counts.vulns) || 0) +
      (Number(counts && counts.assets) || 0) +
      (Number(counts && counts.snapshots) || 0)
    return markerSeconds * 1_000_000 + (totalRows % 1_000_000) + (writeEpoch % 1_000_000)
  } catch {
    return writeEpoch
  }
}

/** GET /rev -> { rev: number } */
function handleRev({ res, holder }) {
  sendJson(res, 200, { rev: computeRevision(holder) })
}

/* ------------------------------------------------------------------------- */
/* Delegation to the Nebula / internal-ops modules                           */
/* ------------------------------------------------------------------------- */

/**
 * Resolve one lazily imported handler. A missing file (still being written),
 * a syntax error or a wrong export all resolve to `null` -> structured 501.
 * @param {'graph'|'internal'} moduleName
 * @param {string} exportName
 * @returns {Promise<((ctx: Record<string, unknown>) => Promise<boolean|void>)|null>}
 */
async function loadDelegatedHandler(moduleName, exportName) {
  try {
    const mod = await import(`./${moduleName}.js`)
    const candidate =
      (mod && (mod[exportName] || mod.handle || mod.default)) || null
    return typeof candidate === 'function' ? candidate : null
  } catch (err) {
    // Coarse diagnostics only: never log request data or file contents.
    const kind = err && typeof err.code === 'string' ? err.code : err && err.name ? err.name : 'error'
    console.warn(`[dsh-cortex] delegated module ${moduleName} is unavailable (${String(kind).slice(0, 80)})`)
    return null
  }
}

/**
 * Run a delegated handler. Returns false when nothing was written, so the
 * caller can emit the documented 501 fallback.
 * @param {((ctx: any) => Promise<boolean|void>)|null} handler
 * @param {Record<string, unknown>} ctx
 */
async function runDelegated(handler, ctx) {
  if (!handler) return false
  let handled
  try {
    handled = await handler(ctx)
  } catch (err) {
    if (ctx.res && (ctx.res.headersSent || ctx.res.writableEnded)) return true
    throw err
  }
  if (ctx.res && (ctx.res.headersSent || ctx.res.writableEnded)) return true
  return handled !== false
}

/* ------------------------------------------------------------------------- */
/* Path / dispatch                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Normalize the request path into the cortex-relative form used by the table.
 * @param {string|undefined} path
 * @param {string} pathname
 */
function resolveRelativePath(path, pathname) {
  let raw = typeof path === 'string' && path.length > 0 ? path : pathname
  if (raw === CORTEX_PREFIX) raw = '/'
  else if (raw.startsWith(`${CORTEX_PREFIX}/`)) raw = raw.slice(CORTEX_PREFIX.length)
  const queryIndex = raw.indexOf('?')
  if (queryIndex >= 0) raw = raw.slice(0, queryIndex)
  let normalized = raw.startsWith('/') ? raw : `/${raw}`
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.replace(/\/+$/, '')
  return normalized.length > 0 ? normalized : '/'
}

/**
 * Match the route table. Specific routes win over generic ones: the first
 * candidate that actually implements the verb is used, so
 * `POST /vulns/export` is never mistaken for `GET /vulns/:id` / 405.
 * @param {string} path
 * @param {string} method
 */
function matchRoute(path, method) {
  const matched = []
  for (const route of ROUTES) {
    const match = route.pattern.exec(path)
    if (match) matched.push({ route, params: match.slice(1) })
  }
  for (const candidate of matched) {
    if (candidate.route.methods[method]) return candidate
  }
  if (matched.length > 0) throw methodNotAllowed()
  throw notFound('route not found')
}

/* ------------------------------------------------------------------------- */
/* Public entry point                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Dispatch one request under `/cortex-api/cortex`.
 *
 * @param {{req: import('node:http').IncomingMessage,
 *          res: import('node:http').ServerResponse,
 *          path?: string,
 *          method?: string,
 *          url?: string,
 *          holder: import('../db.js').DatabaseHolder,
 *          repository: import('../repository.js').Repository,
 *          config?: {readOnly?: boolean, allowNetwork?: boolean, dbPath?: string}}} deps
 */
export async function handleCortex(deps) {
  const { req, res, holder } = deps
  try {
    assertLoopbackPeer(req)
    assertLoopbackHost(req)

    const method = String(deps.method || (req && req.method) || 'GET').toUpperCase()
    if (method === 'OPTIONS') throw methodNotAllowed()

    const parsed = parseRequestUrl(req)
    const path = resolveRelativePath(deps.path, parsed.pathname)
    const searchParams = parsed.searchParams
    const config = deps.config || {}

    /** @type {Record<string, any>} */
    const ctx = {
      req,
      res,
      method,
      path,
      searchParams,
      url: deps.url || (req && req.url) || '',
      holder,
      repository: deps.repository,
      config,
      params: [],
      version: pluginVersion(),
      bumpRev: () => {
        writeEpoch += 1
      },
    }

    if (WRITE_METHODS.has(method)) assertWriteFence(req, method)

    /* ------------------------- delegated surfaces ------------------------ */

    if (path === '/graph') {
      if (method !== 'POST') throw methodNotAllowed()
      holder.ensure()
      holder.assertUsable()
      const handled = await runDelegated(await loadDelegatedHandler('graph', 'handleGraph'), ctx)
      if (!handled) misc.sendUnsupported(res, 'Memory Nebula graph is not available in this host')
      return
    }

    if (path === '/loot') {
      if (method !== 'GET') throw methodNotAllowed()
      holder.ensure()
      holder.assertUsable()
      const handled = await runDelegated(await loadDelegatedHandler('internal', 'handleInternal'), ctx)
      if (!handled) misc.sendUnsupported(res, 'loot history is not available in this host')
      return
    }

    if (path === '/internal' || path.startsWith('/internal/')) {
      holder.ensure()
      holder.assertUsable()
      if (path === '/internal/credential-trial') holder.assertWritable()
      const handled = await runDelegated(await loadDelegatedHandler('internal', 'handleInternal'), ctx)
      if (!handled) misc.sendUnsupported(res, 'internal operations are not available in this host')
      return
    }

    // Mini-program (wxapkg) reverse-engineering workbench. Delegated lazily so a
    // failure in the new modules can never take down the rest of Cortex, and so
    // its routes work even without a compatible Cortex data.db (they use their
    // own ~/.cortex/plugin.db).
    if (path === '/miniapps' || path.startsWith('/miniapps/')) {
      const handler = await loadDelegatedHandler('../miniapp/routes', 'handleMiniapps')
      if (!handler) {
        misc.sendUnsupported(res, 'mini-program workbench is not available in this host')
        return
      }
      const handled = await runDelegated(handler, ctx)
      if (!handled) throw notFound('route not found')
      return
    }

    /* ----------------------------- route table --------------------------- */

    const { route, params } = matchRoute(path, method)
    ctx.params = params

    holder.ensure()
    if (route.db !== false) {
      holder.assertUsable()
      if (WRITE_METHODS.has(method)) holder.assertWritable()
    }

    await route.methods[method](ctx)
  } catch (err) {
    sendError(res, err)
  }
}

export default handleCortex
