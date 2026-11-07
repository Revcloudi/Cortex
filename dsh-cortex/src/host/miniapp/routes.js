/**
 * HTTP surface for the mini-program (wxapkg) reverse-engineering feature.
 *
 * Mounted under `/cortex-api/cortex/miniapps/**`. The parent dispatcher
 * (`src/host/cortex/index.js`) already applied the loopback peer/Host fences and
 * the same-origin write fence, so this module only routes, validates input and
 * maps the shared service layer onto JSON responses.
 *
 * The parent imports this file lazily: a failure in the miniapp modules must
 * never take down the rest of the Cortex UI/API.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  badRequest,
  methodNotAllowed,
  queryBool01,
  queryInt,
  queryString,
  readJsonBody,
  safeDecode,
  sendJson,
} from '../http.js'
import { defaultRoots, expandRoots } from './roots.js'
import {
  analyzeSourceRecord,
  detailPayload,
  fileForSource,
  importAssetsForSource,
  listMiniapps,
  miniappStore,
  openSourceDirectory,
  requireSourceById,
  scan,
  searchSource,
  treeForSource,
  unpackSourceRecord,
} from './service.js'

const MAX_ID = 200
const MAX_PATH = 4000
const MAX_CUSTOM_ROOTS = 20

function sourceId(ctx) {
  const raw = Array.isArray(ctx.params) ? ctx.params[0] : ''
  const id = safeDecode(raw, 'miniapp id')
  if (id.length === 0) throw badRequest('miniapp id is required')
  if (id.length > MAX_ID) throw badRequest('miniapp id is too long', { max: MAX_ID })
  return id
}

/** Read a JSON body when present; empty POSTs are treated as `{}`. */
async function bodyOrEmpty(req) {
  const headers = (req && req.headers) || {}
  const length = Number(headers['content-length'] || 0)
  if (length === 0 && headers['transfer-encoding'] === undefined) return {}
  return readJsonBody(req)
}

export async function handleList({ res, searchParams }) {
  const search = queryString(searchParams, 'search', { max: 400 }) ?? ''
  const status = queryString(searchParams, 'status', { max: 40 }) ?? ''
  sendJson(res, 200, listMiniapps(miniappStore(), { search, status }))
}

export async function handleScan({ req, res }) {
  const body = await bodyOrEmpty(req)
  let customRoots
  // An empty array from the UI means "scan with the saved roots"; only a
  // non-empty array replaces them. Clearing is done through POST /miniapps/roots.
  if (Array.isArray(body.customRoots) && body.customRoots.length > 0) {
    customRoots = normalizeRoots(body.customRoots)
  }
  const result = await scan(miniappStore(), { customRoots })
  sendJson(res, 200, result)
}

function rootsPayload(customRoots) {
  const all = expandRoots({ customRoots, includeMissing: true }).map((root) => ({
    kind: root.kind,
    path: root.path,
    label: root.label,
    mode: root.mode,
    exists: existsSync(root.path),
  }))
  return { roots: all, customRoots }
}

export function handleRootsGet({ res }) {
  const store = miniappStore()
  sendJson(res, 200, rootsPayload(store.customRoots()))
}

export async function handleRootsSet({ req, res }) {
  const body = await readJsonBody(req)
  const roots = normalizeRoots(body.roots)
  const mode = body.mode === 'append' ? 'append' : 'replace'
  const store = miniappStore()
  const next = mode === 'append' ? [...new Set([...store.customRoots(), ...roots])] : roots
  store.setCustomRoots(next)
  sendJson(res, 200, rootsPayload(next))
}

export async function handleDetailRoute(ctx) {
  const store = miniappStore()
  const source = requireSourceById(store, sourceId(ctx))
  sendJson(ctx.res, 200, detailPayload(store, source))
}

export async function handleUnpack(ctx) {
  const store = miniappStore()
  const source = requireSourceById(store, sourceId(ctx))
  let force = false
  try {
    const body = await bodyOrEmpty(ctx.req)
    force = body.force === true
  } catch {
    force = false
  }
  const result = await unpackSourceRecord({ store, source, force })
  const row = store.getSource(source.id) || source
  sendJson(ctx.res, 200, {
    ok: result.ok === true,
    status: result.status,
    cached: result.cached === true,
    error: result.error || '',
    totals: result.totals || null,
    unpackedPath: result.unpackedPath || '',
    manifest: result.manifest || null,
    miniapp: detailPayload(store, row).miniapp,
  })
}

export async function handleAnalyze(ctx) {
  const store = miniappStore()
  const source = requireSourceById(store, sourceId(ctx))
  let force = false
  try {
    const body = await bodyOrEmpty(ctx.req)
    force = body.force === true
  } catch {
    force = false
  }
  const result = analyzeSourceRecord({ store, source, force })
  const row = store.getSource(source.id) || source
  sendJson(ctx.res, 200, {
    ok: result.ok,
    cached: result.cached === true,
    analysis: result.analysis,
    overviewText: result.overviewText,
    counts: result.counts,
    miniapp: detailPayload(store, row).miniapp,
  })
}

export function handleTreeRoute(ctx) {
  const source = requireSourceById(miniappStore(), sourceId(ctx))
  const path = queryString(ctx.searchParams, 'path', { max: MAX_PATH }) ?? ''
  sendJson(ctx.res, 200, treeForSource(source, path))
}

export function handleFileRoute(ctx) {
  const source = requireSourceById(miniappStore(), sourceId(ctx))
  const path = queryString(ctx.searchParams, 'path', { max: MAX_PATH })
  if (!path) throw badRequest('path is required', { field: 'path' })
  const offset = queryInt(ctx.searchParams, 'offset', { min: 0, max: 10_000_000 }) ?? 0
  const limit = queryInt(ctx.searchParams, 'limit', { min: 1, max: 5000 }) ?? 200
  const maxBytes = queryInt(ctx.searchParams, 'maxBytes', { min: 1024, max: 5 * 1024 * 1024 }) ?? 1024 * 1024
  const rawFormat = queryBool01(ctx.searchParams, 'format')
  const find = queryString(ctx.searchParams, 'find', { max: 400 }) ?? ''
  const findRegex = queryBool01(ctx.searchParams, 'findRegex') === true
  const findMax = queryInt(ctx.searchParams, 'findMax', { min: 1, max: 1000 }) ?? 200
  const result = fileForSource(source, path, {
    offset,
    limit,
    format: rawFormat === false ? false : 'auto',
    maxBytes,
    find,
    findRegex,
    findMax,
  })
  if (result.binary) {
    throw badRequest('binary files cannot be previewed as text', {
      code: 'BINARY_FILE',
      path: result.path,
      size: result.size,
    })
  }
  sendJson(ctx.res, 200, result)
}

export function handleSearchRoute(ctx) {
  const source = requireSourceById(miniappStore(), sourceId(ctx))
  const query = queryString(ctx.searchParams, 'query', { max: 400 })
  if (!query) throw badRequest('query is required', { field: 'query' })
  const regex = queryBool01(ctx.searchParams, 'regex') === true
  const glob = queryString(ctx.searchParams, 'glob', { max: 300 }) ?? ''
  const maxResults = queryInt(ctx.searchParams, 'maxResults', { min: 1, max: 200 }) ?? 50
  sendJson(ctx.res, 200, searchSource(source, { query, regex, glob, maxResults }))
}

export async function handleImportAssets(ctx) {
  const store = miniappStore()
  const source = requireSourceById(store, sourceId(ctx))
  const body = await bodyOrEmpty(ctx.req)
  const projectName =
    typeof body.project_name === 'string' && body.project_name.trim().length > 0
      ? body.project_name.trim().slice(0, 120)
      : undefined
  const hostPort =
    typeof body.host_port === 'string' && body.host_port.trim().length > 0
      ? body.host_port.trim().slice(0, 4000)
      : undefined
  const result = await importAssetsForSource({
    holder: ctx.holder,
    store,
    source,
    projectName,
    hostPort,
  })
  sendJson(ctx.res, 200, result)
}

export async function handleOpen(ctx) {
  const store = miniappStore()
  const source = requireSourceById(store, sourceId(ctx))
  sendJson(ctx.res, 200, openSourceDirectory(source))
}

export async function handleRename(ctx) {
  const store = miniappStore()
  const source = requireSourceById(store, sourceId(ctx))
  const body = await bodyOrEmpty(ctx.req)
  const raw = typeof body.app_name === 'string' ? body.app_name : ''
  if (raw.length > 120) throw badRequest('app_name is too long', { field: 'app_name', max: 120 })
  const appName = raw.replace(/\s+/g, ' ').trim().slice(0, 60)
  const row = store.updateSource(source.id, { app_name: appName })
  sendJson(ctx.res, 200, { ok: true, miniapp: detailPayload(store, row || source).miniapp })
}

function normalizeRoots(raw) {
  if (!Array.isArray(raw)) throw badRequest('roots must be an array', { field: 'roots' })
  if (raw.length > MAX_CUSTOM_ROOTS) throw badRequest(`at most ${MAX_CUSTOM_ROOTS} custom roots`, { max: MAX_CUSTOM_ROOTS })
  const result = []
  for (const value of raw) {
    if (typeof value !== 'string') throw badRequest('each root must be a string', { field: 'roots' })
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    if (trimmed.length > 2000) throw badRequest('root path is too long', { field: 'roots', max: 2000 })
    if (!isAbsolute(trimmed)) throw badRequest('root path must be absolute', { field: 'roots' })
    const resolved = resolve(trimmed)
    if (!result.includes(resolved)) result.push(resolved)
  }
  return result
}

/* -------------------------------- routing -------------------------------- */

const ROUTES = [
  { method: 'GET', pattern: /^\/miniapps$/, handler: handleList },
  { method: 'POST', pattern: /^\/miniapps\/scan$/, handler: handleScan },
  { method: 'GET', pattern: /^\/miniapps\/roots$/, handler: handleRootsGet },
  { method: 'POST', pattern: /^\/miniapps\/roots$/, handler: handleRootsSet },
  { method: 'POST', pattern: /^\/miniapps\/([^/]+)\/unpack$/, handler: handleUnpack },
  { method: 'POST', pattern: /^\/miniapps\/([^/]+)\/analyze$/, handler: handleAnalyze },
  { method: 'POST', pattern: /^\/miniapps\/([^/]+)\/import-assets$/, handler: handleImportAssets },
  { method: 'POST', pattern: /^\/miniapps\/([^/]+)\/open$/, handler: handleOpen },
  { method: 'POST', pattern: /^\/miniapps\/([^/]+)\/name$/, handler: handleRename },
  { method: 'GET', pattern: /^\/miniapps\/([^/]+)\/tree$/, handler: handleTreeRoute },
  { method: 'GET', pattern: /^\/miniapps\/([^/]+)\/file$/, handler: handleFileRoute },
  { method: 'GET', pattern: /^\/miniapps\/([^/]+)\/search$/, handler: handleSearchRoute },
  { method: 'GET', pattern: /^\/miniapps\/([^/]+)$/, handler: handleDetailRoute },
]

/**
 * Handle one `/miniapps/**` request. Returns false when the path is not ours
 * (the parent dispatcher then falls through to its own route table).
 * @param {Record<string, any>} ctx
 */
export async function handleMiniapps(ctx) {
  const path = String(ctx.path || '')
  const method = String(ctx.method || 'GET').toUpperCase()
  if (path !== '/miniapps' && !path.startsWith('/miniapps/')) return false
  const matched = ROUTES.filter((route) => route.pattern.test(path))
  if (matched.length === 0) return false
  const route = matched.find((candidate) => candidate.method === method)
  if (!route) throw methodNotAllowed()
  const match = route.pattern.exec(path)
  ctx.params = match.slice(1)
  try {
    await route.handler(ctx)
  } catch (error) {
    // Workspace/container errors are client-visible 4xx, never opaque 500s.
    if (error && error.name === 'WxapkgError') {
      throw badRequest(error.message || 'mini-program operation failed', { code: error.code })
    }
    throw error
  }
  return true
}

/** Exposed for diagnostics/tests (not part of the public HTTP contract). */
export { ROUTES as MINIAPP_ROUTES, defaultRoots }
