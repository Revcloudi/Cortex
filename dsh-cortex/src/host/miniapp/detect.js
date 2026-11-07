/**
 * Read-only mini-program (wxapkg) discovery.
 *
 * `scanMiniapps` walks each configured root, groups `.wxapkg` files by package
 * directory, infers appid/version, detects the container format from the first
 * bytes and upserts one source row per package directory.
 *
 * Hard rules honoured here:
 *  - never write/move/delete under a scanned root (read-only);
 *  - never follow symlinks or descend into `node_modules`;
 *  - permission errors are counted per root and never abort the scan;
 *  - the event loop is yielded to roughly every 2000 directory entries.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { expandRoots, inferIdentity } from './roots.js'
import { sourceIdFor } from './store.js'

/** Default scan limits (contract §3.3). */
export const SCAN_LIMITS = { maxDepth: 10, maxFiles: 30000, maxPackageFiles: 200 }

/** Package files above this size are reported and skipped. */
export const MAX_PACKAGE_FILE_BYTES = 300 * 1024 * 1024

/** Directory names that are never descended into. */
const SKIP_DIRS = new Set(['node_modules'])

/** Yield to the host event loop after roughly this many directory entries. */
const YIELD_EVERY = 2000

const DEFAULT_IO = { existsSync, statSync, readdirSync }

/** @param {string} filePath */
function isWxapkgName(filePath) {
  return basename(filePath).toLowerCase().endsWith('.wxapkg')
}

/** @param {string} value */
function normalizePathKey(value) {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Sniff a package container from its first bytes:
 * `V1MMWX` -> `v1mmwx`, byte0 `0xBE` -> `plain`, anything else -> `unknown`.
 * Missing/unreadable files are `unknown` (never throws).
 * @param {string} filePath
 * @returns {'plain'|'v1mmwx'|'unknown'}
 */
export function detectFormat(filePath) {
  let fd = null
  try {
    fd = openSync(filePath, 'r')
    const head = Buffer.alloc(6)
    const read = readSync(fd, head, 0, head.length, 0)
    if (read >= 6 && head.toString('latin1', 0, 6) === 'V1MMWX') return 'v1mmwx'
    if (read >= 1 && head[0] === 0xbe) return 'plain'
    return 'unknown'
  } catch {
    return 'unknown'
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** `__APP__.wxapkg` first, then by file name. */
function comparePackageFiles(a, b) {
  const left = basename(a.path).toLowerCase()
  const right = basename(b.path).toLowerCase()
  if (left === '__app__.wxapkg') return -1
  if (right === '__app__.wxapkg') return 1
  return left.localeCompare(right)
}

/** @param {string|{path:string,size?:number}} raw */
function normalizeFileEntry(raw) {
  if (typeof raw === 'string') {
    const path = resolve(raw)
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      /* size stays 0; grouping does not need it */
    }
    return { path, size }
  }
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || !raw.path.trim()) return null
  const path = resolve(raw.path)
  const size = Number(raw.size)
  return { path, size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0 }
}

/**
 * Group package files by containing directory and produce `upsertSource`
 * inputs (one per package directory). Format comes from the largest file.
 *
 * @param {Array<string|{path:string,size?:number}>} files
 * @param {import('./roots.js').Root|string} root
 * @returns {Array<Record<string, any>>}
 */
export function groupPackages(files, root) {
  /** @type {Map<string, {dir:string, files:{path:string,size:number}[]}>} */
  const groups = new Map()
  for (const raw of Array.isArray(files) ? files : []) {
    const file = normalizeFileEntry(raw)
    if (!file || !isWxapkgName(file.path)) continue
    const dir = dirname(file.path)
    const key = normalizePathKey(dir)
    let group = groups.get(key)
    if (!group) {
      group = { dir, files: [] }
      groups.set(key, group)
    }
    if (!group.files.some((entry) => normalizePathKey(entry.path) === normalizePathKey(file.path))) {
      group.files.push(file)
    }
  }

  const out = []
  for (const group of groups.values()) {
    group.files.sort(comparePackageFiles)
    const largest = group.files.reduce((best, file) => (file.size > best.size ? file : best), group.files[0])
    const identity = inferIdentity(largest.path, root)
    out.push({
      id: sourceIdFor(identity.rootPath, identity.packageDir),
      root_path: identity.rootPath,
      root_kind: identity.rootKind,
      appid: identity.appid,
      app_name: '',
      version: identity.version,
      package_dir: identity.packageDir,
      files: group.files.map((file) => ({
        name: basename(file.path),
        path: file.path,
        size: file.size,
      })),
      size_bytes: group.files.reduce((sum, file) => sum + file.size, 0),
      file_count: group.files.length,
      package_hash: '',
      format: detectFormat(largest.path),
      status: 'detected',
      unpacked_path: '',
      error: '',
    })
  }
  out.sort((a, b) => a.package_dir.localeCompare(b.package_dir))
  return out
}

/** @param {any} root @param {{maxDepth:number}} limits */
function normalizeRoot(root, limits) {
  if (typeof root === 'string') {
    const absolute = resolve(root)
    return {
      kind: 'custom',
      path: absolute,
      label: basename(absolute) || absolute,
      mode: 'recursive',
      maxDepth: limits.maxDepth,
    }
  }
  if (!root || typeof root.path !== 'string' || !root.path.trim()) return null
  const maxDepth = Number(root.maxDepth)
  const declaredDepth =
    Number.isFinite(maxDepth) && maxDepth >= 0 ? Math.floor(maxDepth) : limits.maxDepth
  return {
    kind: typeof root.kind === 'string' && root.kind ? root.kind : 'custom',
    path: resolve(root.path),
    label: typeof root.label === 'string' ? root.label : basename(resolve(root.path)),
    mode: root.mode === 'packages' ? 'packages' : 'recursive',
    maxDepth: Math.min(declaredDepth, limits.maxDepth),
  }
}

/** Newest-first source ordering used for the scan result. */
function compareSources(a, b) {
  const byAppid = String(a.appid ?? '').localeCompare(String(b.appid ?? ''))
  if (byAppid !== 0) return byAppid
  const left = String(a.version ?? '')
  const right = String(b.version ?? '')
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric && Number(left) !== Number(right)) return Number(right) - Number(left)
  const byVersion = right.localeCompare(left, undefined, { numeric: true })
  if (byVersion !== 0) return byVersion
  return String(a.package_dir ?? '').localeCompare(String(b.package_dir ?? ''))
}

/** @param {string} message @param {string} root @param {string} path */
function scanError(message, root, path) {
  return { root, path, message }
}

/**
 * Scan every root and persist the detected packages.
 *
 * @param {{
 *   store: import('./store.js').MiniappStore,
 *   roots?: Array<any>,
 *   customRoots?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   limits?: {maxDepth?:number, maxFiles?:number, maxPackageFiles?:number},
 *   now?: () => string,
 *   io?: {existsSync:Function, statSync:Function, readdirSync:Function}
 * }} [options]
 */
export async function scanMiniapps({
  store,
  roots = [],
  customRoots = [],
  env = process.env,
  limits = {},
  now = () => new Date().toISOString(),
  io = DEFAULT_IO,
} = {}) {
  if (!store || typeof store.upsertSource !== 'function') {
    throw new TypeError('scanMiniapps: a MiniappStore instance is required')
  }
  store.ensure?.()

  const effectiveLimits = {
    maxDepth: Number.isFinite(Number(limits.maxDepth)) ? Number(limits.maxDepth) : SCAN_LIMITS.maxDepth,
    maxFiles: Number.isFinite(Number(limits.maxFiles)) ? Number(limits.maxFiles) : SCAN_LIMITS.maxFiles,
    maxPackageFiles: Number.isFinite(Number(limits.maxPackageFiles))
      ? Number(limits.maxPackageFiles)
      : SCAN_LIMITS.maxPackageFiles,
  }

  const explicitRoots = Array.isArray(roots) && roots.length > 0 ? roots : null
  const rootInputs = explicitRoots ?? expandRoots({ customRoots, env })
  const rootList = []
  const seenRoots = new Set()
  for (const rawRoot of rootInputs) {
    const root = normalizeRoot(rawRoot, effectiveLimits)
    if (!root) continue
    const key = normalizePathKey(root.path)
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    rootList.push(root)
  }

  const scannedAt = now()
  /** @type {Array<{root:string,path:string,message:string}>} */
  const errors = []
  /** @type {Array<{kind:string,path:string,exists:boolean,filesFound:number,errors:number}>} */
  const rootStats = []
  /** @type {Map<string, {root:any, files:{path:string,size:number}[]}>} */
  const byPackageDir = new Map()

  let totalFiles = 0
  let maxFilesReached = false
  let entriesSinceYield = 0

  const tick = async () => {
    entriesSinceYield += 1
    if (entriesSinceYield >= YIELD_EVERY) {
      entriesSinceYield = 0
      await new Promise((resolveTick) => setImmediate(resolveTick))
    }
  }

  for (const root of rootList) {
    const stat = { kind: root.kind, path: root.path, exists: false, filesFound: 0, errors: 0 }
    rootStats.push(stat)

    let rootExists = false
    try {
      rootExists = Boolean(io.existsSync(root.path))
    } catch {
      rootExists = false
    }
    if (!rootExists) continue
    stat.exists = true

    let directory = false
    try {
      directory = Boolean(io.statSync(root.path).isDirectory())
    } catch (err) {
      stat.errors += 1
      errors.push(scanError(String(err && err.code ? err.code : err), root.path, root.path))
      continue
    }
    if (!directory) {
      stat.errors += 1
      errors.push(scanError('not a directory', root.path, root.path))
      continue
    }

    const rootFiles = []
    const stack = [{ dir: root.path, depth: 0 }]
    while (stack.length > 0 && !maxFilesReached) {
      const current = stack.pop()
      let entries
      try {
        entries = io.readdirSync(current.dir, { withFileTypes: true })
      } catch (err) {
        stat.errors += 1
        errors.push(
          scanError(
            String(err && err.code ? err.code : (err && err.message) || 'readdir failed'),
            root.path,
            current.dir,
          ),
        )
        await tick()
        continue
      }

      for (const entry of entries) {
        await tick()
        const entryName = String(entry && entry.name ? entry.name : '')
        if (!entryName) continue
        const entryPath = resolve(current.dir, entryName)

        // Never follow symlinks (files or directories), never walk node_modules.
        if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue

        if (typeof entry.isDirectory === 'function' && entry.isDirectory()) {
          if (SKIP_DIRS.has(entryName.toLowerCase())) continue
          if (current.depth + 1 > effectiveLimits.maxDepth) continue
          stack.push({ dir: entryPath, depth: current.depth + 1 })
          continue
        }

        if (typeof entry.isFile !== 'function' || !entry.isFile()) continue
        if (!entryName.toLowerCase().endsWith('.wxapkg')) continue

        if (totalFiles >= effectiveLimits.maxFiles) {
          maxFilesReached = true
          errors.push(
            scanError(`maxFiles limit (${effectiveLimits.maxFiles}) reached`, root.path, entryPath),
          )
          break
        }

        let size = 0
        try {
          size = io.statSync(entryPath).size
        } catch (err) {
          stat.errors += 1
          errors.push(
            scanError(String(err && err.code ? err.code : 'stat failed'), root.path, entryPath),
          )
          continue
        }

        totalFiles += 1
        stat.filesFound += 1
        if (size > MAX_PACKAGE_FILE_BYTES) {
          stat.errors += 1
          errors.push(scanError('package file exceeds 300 MB limit', root.path, entryPath))
          continue
        }
        rootFiles.push({ path: entryPath, size })
      }
    }

    // One package directory can be reachable from overlapping roots; keep the
    // first root that found it so ids stay stable.
    for (const file of rootFiles) {
      const key = normalizePathKey(dirname(file.path))
      const existing = byPackageDir.get(key)
      if (!existing) {
        byPackageDir.set(key, { root, files: [file] })
        continue
      }
      const fileKey = normalizePathKey(file.path)
      if (!existing.files.some((entry) => normalizePathKey(entry.path) === fileKey)) {
        existing.files.push(file)
      }
    }
  }

  let totalPackages = 0
  const grouped = []
  for (const { root, files } of byPackageDir.values()) {
    const sorted = files.slice().sort(comparePackageFiles)
    let kept = sorted
    if (sorted.length > effectiveLimits.maxPackageFiles) {
      kept = sorted.slice(0, Math.max(0, effectiveLimits.maxPackageFiles))
      errors.push(
        scanError(
          `maxPackageFiles limit (${effectiveLimits.maxPackageFiles}) reached`,
          root.path,
          dirname(sorted[0].path),
        ),
      )
    }
    totalPackages += kept.length
    if (kept.length > 0) grouped.push(...groupPackages(kept, root))
  }

  let added = 0
  let updated = 0
  let unchanged = 0
  const sources = []
  for (const input of grouped) {
    const result = store.upsertSource({ ...input, detected_at: scannedAt, updated_at: scannedAt })
    if (result.created) added += 1
    else if (result.changed) updated += 1
    else unchanged += 1
    sources.push(result.row)
  }
  sources.sort(compareSources)

  return {
    ok: true,
    scannedAt,
    totalSources: sources.length,
    totalPackages,
    added,
    updated,
    unchanged,
    roots: rootStats,
    errors,
    sources,
  }
}
