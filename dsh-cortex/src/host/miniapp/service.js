/**
 * Shared mini-program service layer.
 *
 * Both the HTTP routes and the `cortex_*_miniapp*` agent tools call these
 * functions, so status reporting, locking, workspace paths and asset import
 * behave identically on both transports. The service is transport-agnostic:
 * it returns plain JSON and throws the host `ApiError` type for 4xx cases.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { badRequest, notFound } from '../http.js'
import { importMiniappAssets } from './assets-import.js'
import { analyzeUnpacked, buildOverviewText, deriveAppNameFromUnpacked, extractAppNameFromPackage, loadOverview, saveOverview } from './analyze.js'
import { scanMiniapps } from './detect.js'
import { miniAppWorkspaceRoot } from './roots.js'
import { getMiniappStore } from './store.js'
import { listTree, readManifest, readTextFile, searchFiles, unpackSource } from './unpack.js'

/** Running unpack operations, keyed by source id (prevents double work). */
const unpackLocks = new Set()

export function isUnpacking(sourceId) {
  return unpackLocks.has(String(sourceId))
}

/** Deterministic newest-first version order (numeric last segment wins). */
export function compareVersionsDesc(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  const aNum = /^\d+$/.test(a) ? Number(a) : null
  const bNum = /^\d+$/.test(b) ? Number(b) : null
  if (aNum !== null && bNum !== null && aNum !== bNum) return bNum - aNum
  if (aNum !== null && bNum === null) return -1
  if (aNum === null && bNum !== null) return 1
  return b.localeCompare(a)
}

export function sortSourcesNewest(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
    const byVersion = compareVersionsDesc(left.version, right.version)
    if (byVersion !== 0) return byVersion
    return String(right.updated_at || '').localeCompare(String(left.updated_at || ''))
  })
}

/** Strip heavy internals from a source row for list/detail responses. */
export function toMiniappSummary(row, { versionCount = 1, isLatest = true, hasAnalysis = false } = {}) {
  if (!row) return null
  return {
    id: row.id,
    appid: row.appid,
    app_name: row.app_name || '',
    version: row.version || '',
    root_kind: row.root_kind,
    package_dir: row.package_dir,
    size_bytes: Number(row.size_bytes) || 0,
    file_count: Number(row.file_count) || 0,
    package_hash: row.package_hash || '',
    format: row.format || 'unknown',
    status: row.status || 'detected',
    unpacked_path: row.unpacked_path || '',
    error: row.error || '',
    detected_at: row.detected_at,
    updated_at: row.updated_at,
    version_count: versionCount,
    is_latest: isLatest,
    has_analysis: hasAnalysis,
  }
}

/**
 * Flat list with per-app version counts + latest flags (the UI groups by appid).
 * @param {import('./store.js').MiniappStore} store
 * @param {{search?:string, status?:string}} [filters]
 */
export function listMiniapps(store, filters = {}) {
  const rows = store.listSources({
    search: filters.search || '',
    status: filters.status || '',
  })
  const versionsByApp = new Map()
  for (const row of rows) {
    if (!versionsByApp.has(row.appid)) versionsByApp.set(row.appid, new Set())
    versionsByApp.get(row.appid).add(String(row.version || ''))
  }
  const latestVersion = new Map()
  for (const [appid, versions] of versionsByApp) {
    const newest = sortSourcesNewest(rows.filter((row) => row.appid === appid))[0]
    if (newest) latestVersion.set(appid, String(newest.version || ''))
  }
  const miniapps = rows.map((row) => {
    let hasAnalysis = false
    try {
      hasAnalysis = Boolean(store.getAnalysis(row.id))
    } catch {
      hasAnalysis = false
    }
    return toMiniappSummary(row, {
      versionCount: versionsByApp.get(row.appid)?.size || 1,
      isLatest: latestVersion.get(row.appid) === String(row.version || ''),
      hasAnalysis,
    })
  })
  const appCount = new Set(rows.map((row) => row.appid)).size
  return {
    miniapps,
    total: miniapps.length,
    appCount,
    customRoots: store.customRoots(),
    workspaceRoot: miniAppWorkspaceRoot(),
    lastScanAt: store.getSetting('lastScanAt'),
  }
}

/** Resolve a source by appid (+ optional version). `version` omitted -> newest. */
export function resolveSource(store, appid, version = '') {
  const targetApp = String(appid || '').trim()
  if (targetApp.length === 0) throw badRequest('appid is required', { field: 'appid' })
  const rows = store.findSources({ appid: targetApp, version: String(version || '').trim() })
  if (!rows || rows.length === 0) return null
  return sortSourcesNewest(rows)[0]
}

export function requireSource(store, appid, version = '') {
  const source = resolveSource(store, appid, version)
  if (!source) {
    const label = version ? `${appid}@${version}` : String(appid)
    throw notFound(`miniapp source not found: ${label}`)
  }
  return source
}

export function requireSourceById(store, id) {
  const source = store.getSource(String(id || ''))
  if (!source) throw notFound('miniapp source not found')
  return source
}

/** Skip huge shared libraries during name enrichment (keeps scan fast). */
const APP_NAME_ENRICH_MAX_BYTES = 80 * 1024 * 1024

/**
 * Fill `app_name` for newly detected sources by reading one package per app.
 * Best-effort: decryption failures (e.g. publicLib) simply leave the appid.
 */
async function enrichAppNames(store, sources) {
  for (const row of Array.isArray(sources) ? sources : []) {
    if (row.app_name) continue
    const files = Array.isArray(row.files) ? row.files : []
    if (files.length === 0) continue
    const preferred =
      files.find((file) => /(?:^|[\\/])__APP__\.wxapkg$/i.test(String(file.name || file.path))) ||
      [...files].sort((left, right) => Number(right.size) - Number(left.size))[0]
    if (!preferred || !preferred.path || Number(preferred.size) > APP_NAME_ENRICH_MAX_BYTES) continue
    try {
      const { appName } = extractAppNameFromPackage(preferred.path, row.appid)
      if (appName) {
        store.updateSource(row.id, { app_name: appName })
        row.app_name = appName
      }
    } catch {
      /* name extraction is best effort and must never fail the scan */
    }
    await new Promise((resolveTick) => setImmediate(resolveTick))
  }
}

/** Scan custom roots (persisting them) and return the summary + current rows. */
export async function scan(store, { customRoots } = {}) {
  if (Array.isArray(customRoots)) store.setCustomRoots(customRoots)
  const roots = store.customRoots()
  const summary = await scanMiniapps({ store, customRoots: roots })
  await enrichAppNames(store, summary.sources)
  store.setSetting('lastScanAt', summary.scannedAt)
  const listing = listMiniapps(store)
  return {
    ok: true,
    scannedAt: summary.scannedAt,
    totalSources: summary.totalSources,
    totalPackages: summary.totalPackages,
    added: summary.added,
    updated: summary.updated,
    unchanged: summary.unchanged,
    errors: summary.errors,
    roots: summary.roots,
    miniapps: listing.miniapps,
    appCount: listing.appCount,
    customRoots: listing.customRoots,
    workspaceRoot: listing.workspaceRoot,
  }
}

function packageHashOf(source) {
  try {
    const hash = createHash('sha1')
    for (const file of source.files || []) {
      hash.update(readFileSync(file.path))
    }
    return hash.digest('hex')
  } catch {
    return ''
  }
}

/**
 * Unpack one source (idempotent unless `force`). Always reports the true
 * status; a decryption failure degrades to `unsupported` and never throws.
 */
export async function unpackSourceRecord({ store, source, force = false } = {}) {
  if (!source) throw badRequest('source is required')
  if (isUnpacking(source.id)) {
    throw badRequest('this mini-program is already being unpacked', { code: 'UNPACK_IN_PROGRESS' })
  }
  const manifestPath = source.unpacked_path ? resolve(source.unpacked_path, 'manifest.json') : ''
  if (
    force !== true &&
    source.status === 'unpacked' &&
    source.unpacked_path &&
    existsSync(source.unpacked_path) &&
    (!manifestPath || existsSync(manifestPath))
  ) {
    return {
      ok: true,
      status: 'unpacked',
      unpackedPath: source.unpacked_path,
      manifestPath,
      manifest: readManifest(source.unpacked_path),
      error: '',
      totals: null,
      cached: true,
    }
  }

  unpackLocks.add(source.id)
  let job = null
  try {
    job = store.createJob({ source_id: source.id, kind: 'unpack', status: 'running', message: 'running' })
  } catch {
    job = null
  }
  try {
    store.updateSource(source.id, { status: 'decrypting', error: '' })
    const result = await unpackSource({ source, workspaceRoot: miniAppWorkspaceRoot() })
    const packageHash = result.ok ? packageHashOf(source) : ''
    store.updateSource(source.id, {
      status: result.status,
      unpacked_path: result.unpackedPath || '',
      error: result.error || '',
      ...(packageHash ? { package_hash: packageHash } : {}),
    })
    if (result.ok) {
      try {
        const { appName } = deriveAppNameFromUnpacked(result.unpackedPath)
        if (appName) store.updateSource(source.id, { app_name: appName })
      } catch {
        /* display-name extraction is best effort */
      }
    }
    if (job) {
      try {
        store.updateJob(job.id, {
          status: result.ok ? 'done' : 'failed',
          progress: 100,
          message: String(result.error || result.status || '').slice(0, 500),
        })
      } catch {
        /* job bookkeeping is best effort */
      }
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.updateSource(source.id, { status: 'failed', error: message.slice(0, 1000) })
    if (job) {
      try {
        store.updateJob(job.id, { status: 'failed', progress: 100, message: message.slice(0, 500) })
      } catch {
        /* ignore */
      }
    }
    throw error
  } finally {
    unpackLocks.delete(source.id)
  }
}

export function extractedCounts(overview) {
  return {
    domains: Array.isArray(overview && overview.domains) ? overview.domains.length : 0,
    endpoints: Array.isArray(overview && overview.endpoints) ? overview.endpoints.length : 0,
    secrets: Array.isArray(overview && overview.secrets) ? overview.secrets.length : 0,
    parameters: Array.isArray(overview && overview.parameters) ? overview.parameters.length : 0,
  }
}

function requireUnpacked(source) {
  if (!source || source.status !== 'unpacked' || !source.unpacked_path) {
    throw badRequest('mini-program is not unpacked yet; call unpack first', {
      status: source ? source.status : 'missing',
    })
  }
  if (!existsSync(source.unpacked_path)) {
    throw badRequest('unpacked workspace is missing; unpack again', { status: source.status })
  }
  return source.unpacked_path
}

/** Analyze (or reuse) one unpacked source and persist the overview. */
export function analyzeSourceRecord({ store, source, force = false } = {}) {
  const unpackedPath = requireUnpacked(source)
  if (force !== true) {
    const cached = store.getAnalysis(source.id)
    if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
      if (cached.appName && cached.appName !== source.app_name) {
        try {
          store.updateSource(source.id, { app_name: cached.appName })
        } catch {
          /* best effort */
        }
      }
      return {
        ok: true,
        analysis: cached,
        overviewText: buildOverviewText(cached),
        counts: extractedCounts(cached),
        cached: true,
      }
    }
    const fromDisk = loadOverview(unpackedPath)
    if (fromDisk) {
      store.saveAnalysis(source.id, fromDisk)
      return {
        ok: true,
        analysis: fromDisk,
        overviewText: buildOverviewText(fromDisk),
        counts: extractedCounts(fromDisk),
        cached: true,
      }
    }
  }
  const manifest = readManifest(unpackedPath)
  const overview = analyzeUnpacked({
    unpackedPath,
    appid: source.appid,
    version: source.version,
    manifest,
  })
  saveOverview(unpackedPath, overview)
  store.saveAnalysis(source.id, overview)
  if (overview.appName) {
    try {
      store.updateSource(source.id, { app_name: overview.appName })
    } catch {
      /* display-name persistence is best effort */
    }
  }
  return {
    ok: true,
    analysis: overview,
    overviewText: buildOverviewText(overview),
    counts: extractedCounts(overview),
    cached: false,
  }
}

/** Ensure an analysis exists (used by the overview/import tools and routes). */
export function ensureAnalyzed({ store, source, force = false } = {}) {
  const analysis = store.getAnalysis(source.id)
  if (force !== true && analysis && Object.keys(analysis).length > 0) {
    return { ok: true, analysis, overviewText: buildOverviewText(analysis), counts: extractedCounts(analysis), cached: true }
  }
  return analyzeSourceRecord({ store, source, force })
}

/** Detail payload for `GET /miniapps/:id`. */
export function detailPayload(store, source) {
  const versions = sortSourcesNewest(store.findSources({ appid: source.appid })).map((row) => ({
    id: row.id,
    version: row.version,
    status: row.status,
    format: row.format,
    size_bytes: row.size_bytes,
    file_count: row.file_count,
    updated_at: row.updated_at,
    unpacked_path: row.unpacked_path,
  }))
  const manifest = source.unpacked_path ? readManifest(source.unpacked_path) : null
  let analysis = null
  try {
    analysis = store.getAnalysis(source.id)
  } catch {
    analysis = null
  }
  if (!analysis && source.unpacked_path) analysis = loadOverview(source.unpacked_path)
  const counts = extractedCounts(analysis)
  return {
    miniapp: {
      ...toMiniappSummary(source),
      app_name: source.app_name || (analysis && analysis.appName) || '',
      versions,
    },
    manifest,
    analysis,
    overviewText: analysis ? buildOverviewText(analysis) : '',
    extractedCounts: counts,
  }
}

export async function importAssetsForSource({ holder, store, source, projectName, hostPort } = {}) {
  const unpackedPath = requireUnpacked(source)
  if (!unpackedPath) throw badRequest('mini-program is not unpacked yet')
  const analyzed = ensureAnalyzed({ store, source })
  return importMiniappAssets({
    holder,
    source,
    overview: analyzed.analysis,
    projectName,
    hostPort,
  })
}

/* --------------------------- workspace browsing --------------------------- */

export function treeForSource(source, relativePath = '') {
  const root = requireUnpacked(source)
  return listTree({ root, path: relativePath })
}

export function fileForSource(source, relativePath, { offset = 0, limit = 200, format = 'auto' } = {}) {
  const root = requireUnpacked(source)
  return readTextFile({ root, path: relativePath, offset, limit, format })
}

export function searchSource(source, options = {}) {
  const root = requireUnpacked(source)
  return searchFiles({ root, ...options })
}

/** Open the unpacked workspace in the OS file manager (never the cache dir). */
export function openSourceDirectory(source) {
  const workspaceRoot = resolve(miniAppWorkspaceRoot())
  const target = resolve(requireUnpacked(source))
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${sep}`)) {
    throw badRequest('refusing to open a directory outside the mini-program workspace')
  }
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(command, [target], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    throw badRequest('failed to open the directory')
  }
  return { ok: true, path: target }
}

/** Singleton store bound to the configured plugin DB (test-friendly). */
export function miniappStore() {
  return getMiniappStore()
}
