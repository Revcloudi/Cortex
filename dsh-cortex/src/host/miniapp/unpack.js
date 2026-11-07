/**
 * Mini-program workspace unpacking + safe text browsing.
 *
 * `unpackSource` turns one detected source row (a directory of `*.wxapkg`
 * files) into a workspace tree under
 * `<workspace>/<appid>/<version>/unpacked/`, writing `manifest.json` inside the
 * unpacked directory (matching `roots.packageWorkspace`).
 *
 * Security posture:
 *   - everything is written inside the configured workspace (path jail +
 *     `lstat` symlink rejection before the first `mkdir`/`write`);
 *   - package names are never trusted: `..`, drive letters, UNC paths, NULs and
 *     Windows reserved names are rejected;
 *   - per-file / total / file-count / wall-clock limits are enforced;
 *   - extracted bytes are treated as opaque text and never executed;
 *   - decryption failures degrade the source to `unsupported`, never throw.
 *
 * The browsing helpers (`listTree`/`readTextFile`/`searchFiles`) are read-only
 * and share the same path jail, so an HTTP `?path=../../secret` cannot escape.
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { miniAppWorkspaceRoot, sanitizeSegment } from './roots.js'
import { MAX_FORMAT_INPUT_BYTES, formatContent } from './format.js'
import { ERROR_CODES, WxapkgError, readPackageBuffer } from './wxapkg.js'

/** Hard output budget for one unpack operation. */
export const UNPACK_LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFiles: 20000,
  timeoutMs: 60000,
}

const MAX_MANIFEST_CONFLICTS = 100
const MAX_TREE_ENTRIES = 500
const MAX_TEXT_READ_BYTES = 5 * 1024 * 1024
const MAX_TEXT_LINES = 5000
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024
const SEARCH_MAX_RESULTS = 500
const SEARCH_SNIPPET_CHARS = 240
const BINARY_PROBE_BYTES = 8 * 1024

/** Small cache for formatted previews (paging a 2 MB bundle stays cheap). */
const FORMAT_CACHE = new Map()
const FORMAT_CACHE_LIMIT = 8

function cachedFormat(target, stats, relativePath) {
  if (stats.size > MAX_FORMAT_INPUT_BYTES) return null
  const key = `${target}\u0000${stats.size}\u0000${stats.mtimeMs}`
  const cached = FORMAT_CACHE.get(key)
  if (cached) return cached
  let raw
  try {
    raw = readFileSync(target, 'utf8')
  } catch {
    return null
  }
  if (raw.length > MAX_FORMAT_INPUT_BYTES) return null
  const result = formatContent({ path: relativePath, content: raw })
  if (!result.formatted) return null
  FORMAT_CACHE.set(key, result)
  while (FORMAT_CACHE.size > FORMAT_CACHE_LIMIT) {
    const oldest = FORMAT_CACHE.keys().next().value
    FORMAT_CACHE.delete(oldest)
  }
  return result
}

function capContentBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, capped: false }
  const lines = text.split('\n')
  const kept = []
  let bytes = 0
  for (const line of lines) {
    const next = bytes === 0 ? Buffer.byteLength(line, 'utf8') : bytes + 1 + Buffer.byteLength(line, 'utf8')
    if (next > maxBytes) break
    kept.push(line)
    bytes = next
  }
  return { text: kept.join('\n'), capped: true }
}
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const INVALID_SEGMENT_RE = /[\u0000-\u001f<>:"|?*]/

const toPosix = (value) => String(value).split(sep).join('/')

/**
 * Normalize one package entry name into a safe relative path.
 *
 * `'/pages/a.js'` -> `'pages/a.js'`; backslashes are accepted as separators.
 * Throws `WxapkgError(INVALID_PACKAGE)` for traversal, absolute, drive-letter,
 * UNC, NUL, control-character or Windows-reserved names. Returns `''` when the
 * name collapses to nothing (callers skip those entries).
 *
 * @param {string} name
 * @returns {string}
 */
export function safeRelativePath(name) {
  if (typeof name !== 'string') {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, 'wxapkg entry name must be a string')
  }
  if (name.includes('\u0000')) {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, 'wxapkg entry name contains a NUL byte')
  }
  const normalized = name.replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `wxapkg entry name is a drive path: ${name}`)
  }
  if (normalized.startsWith('//')) {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `wxapkg entry name is a UNC path: ${name}`)
  }
  const segments = []
  for (const segment of normalized.replace(/^\/+/, '').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `wxapkg entry name escapes the package root: ${name}`)
    }
    if (INVALID_SEGMENT_RE.test(segment)) {
      throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `wxapkg entry name contains invalid characters: ${name}`)
    }
    if (/[. ]$/.test(segment)) {
      throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `wxapkg entry name has a trailing dot/space: ${name}`)
    }
    if (WINDOWS_RESERVED_RE.test(segment)) {
      throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `wxapkg entry name is a reserved device name: ${name}`)
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * Case-aware containment check (Windows paths compare case-insensitively).
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInsideRoot(root, target) {
  if (typeof root !== 'string' || root.length === 0) return false
  if (typeof target !== 'string' || target.length === 0) return false
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const caseInsensitive = process.platform === 'win32'
  const left = caseInsensitive ? rootPath.toLowerCase() : rootPath
  const right = caseInsensitive ? targetPath.toLowerCase() : targetPath
  if (left === right) return true
  const prefix = left.endsWith(sep) ? left : left + sep
  return right.startsWith(prefix)
}

function requireRoot(root) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'workspace root is required')
  }
  return resolve(root)
}

/** Reject any symlink in the existing components of `target` below `root`. */
function assertNoSymlinkAncestors(rootPath, target) {
  const rel = relative(rootPath, target)
  if (rel === '') return
  const parts = rel.split(sep)
  let cursor = rootPath
  for (const part of parts) {
    cursor = join(cursor, part)
    let stats
    try {
      stats = lstatSync(cursor)
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw new WxapkgError(
        ERROR_CODES.INVALID_PATH,
        `cannot inspect workspace path: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (stats.isSymbolicLink()) {
      throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'symbolic links are not allowed in workspace paths')
    }
  }
}

/**
 * Resolve `relPath` below `root`, rejecting path-jail escapes and symlinks.
 *
 * @param {string} root
 * @param {string} relPath
 * @param {{mustExist?:boolean}} [options]
 * @returns {string} absolute path
 */
export function resolveInside(root, relPath, { mustExist = false } = {}) {
  const rootPath = requireRoot(root)
  const raw = relPath === undefined || relPath === null ? '' : String(relPath)
  if (raw.includes('\u0000')) {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'path contains a NUL byte')
  }
  // User-supplied paths must be relative: an absolute name is an escape attempt.
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || /^[\\/]{2}/.test(raw)) {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, `path must be relative to the workspace: ${raw}`)
  }
  let target = rootPath
  const trimmed = raw.trim()
  if (trimmed.length > 0 && trimmed !== '.') {
    let normalized
    try {
      normalized = safeRelativePath(raw)
    } catch (error) {
      throw new WxapkgError(ERROR_CODES.INVALID_PATH, error instanceof Error ? error.message : 'invalid path')
    }
    if (normalized.length > 0) target = resolve(rootPath, ...normalized.split('/'))
  }
  if (!isInsideRoot(rootPath, target)) {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'path escapes the workspace root')
  }
  assertNoSymlinkAncestors(rootPath, target)
  if (mustExist) {
    let stats
    try {
      stats = lstatSync(target)
    } catch {
      throw new WxapkgError(ERROR_CODES.INVALID_PATH, `path does not exist: ${raw}`)
    }
    if (stats.isSymbolicLink()) {
      throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'symbolic links are not allowed')
    }
  }
  return target
}

/* ------------------------------ unpacking ------------------------------ */

function packageFilesOf(source) {
  let raw = source && Array.isArray(source.files) ? source.files : []
  if (raw.length === 0 && source && typeof source.files_json === 'string') {
    try {
      const parsed = JSON.parse(source.files_json)
      if (Array.isArray(parsed)) raw = parsed
    } catch {
      raw = []
    }
  }
  const files = []
  const seen = new Set()
  for (const item of raw) {
    if (!item) continue
    const filePath = typeof item === 'string' ? item : item.path
    if (typeof filePath !== 'string' || filePath.trim().length === 0) continue
    const absolute = resolve(filePath)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    files.push({
      path: absolute,
      name: basename(absolute),
      size: Number(item && item.size) || 0,
    })
  }
  // `__APP__.wxapkg` is the main package: unpack it first so conflicts keep
  // the main-package copy and page files exist before subpackage merges.
  files.sort((left, right) => {
    const leftApp = /^__app__\.wxapkg$/i.test(left.name) ? 0 : 1
    const rightApp = /^__app__\.wxapkg$/i.test(right.name) ? 0 : 1
    if (leftApp !== rightApp) return leftApp - rightApp
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })
  return files
}

function effectiveLimits(rawLimits) {
  const limits = { ...UNPACK_LIMITS }
  if (!rawLimits || typeof rawLimits !== 'object') return limits
  for (const key of Object.keys(limits)) {
    const value = Number(rawLimits[key])
    if (Number.isFinite(value)) limits[key] = value
  }
  return limits
}

/** Ensure `rel` below `unpackedRoot` has no symlink component, then mkdir -p. */
function writableTarget(unpackedRoot, rel) {
  const target = resolve(unpackedRoot, ...rel.split('/'))
  const rootPath = resolve(unpackedRoot)
  if (!isInsideRoot(rootPath, target) || target === rootPath) {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `refusing to write outside the unpack directory: ${rel}`)
  }
  const parts = relative(rootPath, target).split(sep)
  let cursor = rootPath
  for (const part of parts) {
    cursor = join(cursor, part)
    let stats
    try {
      stats = lstatSync(cursor)
    } catch (error) {
      if (error && error.code === 'ENOENT') break
      throw new WxapkgError(ERROR_CODES.INVALID_PATH, `cannot inspect output path: ${rel}`)
    }
    if (stats.isSymbolicLink()) {
      throw new WxapkgError(ERROR_CODES.INVALID_PATH, `symbolic links are not allowed in the unpack output: ${rel}`)
    }
    if (cursor !== target && !stats.isDirectory()) {
      throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `output path component is not a directory: ${rel}`)
    }
  }
  mkdirSync(dirname(target), { recursive: true })
  return target
}

function removeQuietly(target) {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    /* best effort cleanup */
  }
}

/**
 * Unpack every package of one source into its workspace.
 *
 * Never rejects for package-level problems: decryption failures become
 * `status:'unsupported'`, limit/IO problems become `status:'failed'`.
 *
 * @param {{
 *   source: object,
 *   workspaceRoot?: string,
 *   limits?: Partial<typeof UNPACK_LIMITS>,
 *   onProgress?: (progress:object)=>void,
 *   now?: ()=>string
 * }} options
 * @returns {Promise<{ok:boolean, status:'unpacked'|'unsupported'|'failed', unpackedPath:string, manifestPath:string, manifest:object|null, error:string, totals:{packages:number,files:number,bytes:number,skipped:number,conflicts:number}}>}
 */
export async function unpackSource(options = {}) {
  const {
    source,
    workspaceRoot,
    limits: rawLimits,
    onProgress,
    now = () => new Date().toISOString(),
  } = options || {}

  const startedAt = Date.now()
  const limits = effectiveLimits(rawLimits)
  const progress =
    typeof onProgress === 'function'
      ? (payload) => {
          try {
            onProgress(payload)
          } catch {
            /* progress callbacks must never break unpacking */
          }
        }
      : () => {}

  const appid = source && typeof source.appid === 'string' ? source.appid : ''
  const version = source && typeof source.version === 'string' ? source.version : ''
  const totals = { packages: 0, files: 0, bytes: 0, skipped: 0, conflicts: 0 }
  let workspace = ''
  let packageRoot = ''
  let unpackedPath = ''
  let manifestPath = ''

  const checkDeadline = () => {
    if (Date.now() - startedAt > limits.timeoutMs) {
      throw new WxapkgError(ERROR_CODES.LIMIT_EXCEEDED, `unpack exceeded the ${limits.timeoutMs} ms deadline`)
    }
  }

  const cleanup = () => {
    if (!workspace || !unpackedPath) return
    try {
      if (basename(unpackedPath) !== 'unpacked') return
      if (!packageRoot || !isInsideRoot(packageRoot, unpackedPath)) return
      if (!isInsideRoot(workspace, unpackedPath)) return
      // Never delete through a symlinked ancestor: re-check right before rm.
      assertNoSymlinkAncestors(workspace, unpackedPath)
      let stats
      try {
        stats = lstatSync(unpackedPath)
      } catch {
        return
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) return
      removeQuietly(unpackedPath)
    } catch {
      /* best effort cleanup, never delete through symlinks */
    }
  }

  try {
    workspace = resolve(typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : miniAppWorkspaceRoot())
    if (typeof source !== 'object' || source === null) {
      throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, 'source row is required')
    }
    const packages = packageFilesOf(source)
    if (packages.length === 0) {
      throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, 'source has no wxapkg packages to unpack')
    }

    const appSegment = sanitizeSegment(appid, 'unknown')
    const versionSegment = sanitizeSegment(version, 'unknown')
    packageRoot = resolve(join(workspace, appSegment, versionSegment))
    if (!isInsideRoot(workspace, packageRoot) || packageRoot === workspace) {
      throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'workspace package directory escapes the workspace root')
    }
    // Reject symlinked ancestors before any mkdir/rm touches the filesystem.
    assertNoSymlinkAncestors(workspace, packageRoot)

    unpackedPath = resolve(join(packageRoot, 'unpacked'))
    manifestPath = resolve(join(unpackedPath, 'manifest.json'))
    if (basename(unpackedPath) !== 'unpacked' || !isInsideRoot(packageRoot, unpackedPath)) {
      throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'refusing to use an unexpected unpack directory')
    }
    if (existsSync(unpackedPath)) {
      const stats = lstatSync(unpackedPath)
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'unpack directory is not a plain directory')
      }
    }
    cleanup()
    mkdirSync(unpackedPath, { recursive: true })

    progress({ phase: 'start', appid, version, packages: packages.length })
    const conflictRecords = []
    const writtenFiles = []
    const writtenIndex = new Map() // relative path -> { hash, from }
    const manifestPackages = []
    const payloadHash = createHash('sha1')

    for (let packageIndex = 0; packageIndex < packages.length; packageIndex += 1) {
      checkDeadline()
      const file = packages[packageIndex]
      progress({
        phase: 'package',
        file: file.name,
        index: packageIndex,
        packages: packages.length,
      })

      let raw
      try {
        raw = readFileSync(file.path)
      } catch (error) {
        throw new WxapkgError(
          ERROR_CODES.INVALID_PACKAGE,
          `cannot read wxapkg ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      payloadHash.update(raw)

      const parsed = readPackageBuffer(raw, { appid, filePath: file.path })
      let packageBytes = 0
      for (const entry of parsed.files) {
        checkDeadline()
        if (!entry.name || entry.name.trim().length === 0) continue
        const rel = safeRelativePath(entry.name)
        if (rel.length === 0) continue

        totals.files += 1
        if (totals.files > limits.maxFiles) {
          throw new WxapkgError(
            ERROR_CODES.LIMIT_EXCEEDED,
            `unpack file count exceeded the limit (${limits.maxFiles})`,
            { maxFiles: limits.maxFiles },
          )
        }
        if (entry.size > limits.maxFileBytes) {
          throw new WxapkgError(
            ERROR_CODES.LIMIT_EXCEEDED,
            `file ${rel} exceeds the per-file limit (${entry.size} > ${limits.maxFileBytes} bytes)`,
            { path: rel, size: entry.size, maxFileBytes: limits.maxFileBytes },
          )
        }
        const data = parsed.buffer.subarray(entry.offset, entry.offset + entry.size)
        const hash = createHash('sha1').update(data).digest('hex')
        const previous = writtenIndex.get(rel)
        if (previous) {
          if (previous.hash === hash) {
            totals.skipped += 1
          } else {
            totals.conflicts += 1
            if (conflictRecords.length < MAX_MANIFEST_CONFLICTS) {
              conflictRecords.push({ path: rel, keptFrom: previous.from, ignoredFrom: file.name })
            }
          }
          continue
        }
        if (totals.bytes + entry.size > limits.maxTotalBytes) {
          throw new WxapkgError(
            ERROR_CODES.LIMIT_EXCEEDED,
            `unpack total size exceeded the limit (${limits.maxTotalBytes} bytes)`,
            { maxTotalBytes: limits.maxTotalBytes },
          )
        }

        const target = writableTarget(unpackedPath, rel)
        writeFileSync(target, data)
        writtenIndex.set(rel, { hash, from: file.name })
        writtenFiles.push({ path: rel, size: entry.size })
        totals.bytes += entry.size
        packageBytes += entry.size
      }

      manifestPackages.push({
        file: file.name,
        size: raw.length,
        format: parsed.format,
        entries: parsed.files.length,
        bytes: packageBytes,
      })
      totals.packages += 1
    }

    const sortedFiles = writtenFiles
      .slice()
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    const manifest = {
      appid,
      version,
      generatedAt: typeof now === 'function' ? now() : new Date().toISOString(),
      source: {
        root_kind: typeof source.root_kind === 'string' ? source.root_kind : '',
        package_dir: typeof source.package_dir === 'string' ? source.package_dir : '',
        package_hash: payloadHash.digest('hex'),
      },
      packages: manifestPackages,
      totals: {
        packages: manifestPackages.length,
        files: sortedFiles.length,
        bytes: totals.bytes,
        skipped: totals.skipped,
        conflicts: totals.conflicts,
        unsupportedPackages: 0,
      },
      files: sortedFiles,
      conflicts: conflictRecords,
      error: '',
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    progress({ phase: 'done', totals: manifest.totals })

    return {
      ok: true,
      status: 'unpacked',
      unpackedPath,
      manifestPath,
      manifest,
      error: '',
      totals: manifest.totals,
    }
  } catch (error) {
    const code = error && error.code
    const unsupported = code === ERROR_CODES.DECRYPT_FAILED || code === ERROR_CODES.UNSUPPORTED_FORMAT
    const detail = error instanceof Error ? error.message : String(error)
    cleanup()
    progress({
      phase: 'error',
      status: unsupported ? 'unsupported' : 'failed',
      error: detail,
    })
    const label = appid || '(unknown)'
    const message = unsupported
      ? `encrypted wxapkg (V1MMWX) could not be decrypted for appid ${label}; client version may be unsupported`
      : detail
    return {
      ok: false,
      status: unsupported ? 'unsupported' : 'failed',
      unpackedPath: '',
      manifestPath: '',
      manifest: null,
      error: message,
      totals: { ...totals },
    }
  }
}

/* ---------------------------- browser helpers ---------------------------- */

/**
 * Read `<unpackedPath>/manifest.json` (fallback: sibling of the directory).
 * @param {string} unpackedPath
 * @returns {object|null}
 */
export function readManifest(unpackedPath) {
  if (typeof unpackedPath !== 'string' || unpackedPath.trim().length === 0) return null
  const root = resolve(unpackedPath)
  const candidates = [join(root, 'manifest.json')]
  if (basename(root) === 'unpacked') candidates.push(join(dirname(root), 'manifest.json'))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* try the next location */
    }
  }
  return null
}

/**
 * List one directory below the unpacked root (dirs first, max 500 entries).
 * @param {{root:string, path?:string}} options
 * @returns {{path:string, entries:Array<{name:string,path:string,type:'file'|'dir',size:number}>}}
 */
export function listTree({ root, path: relPath = '' } = {}) {
  const rootPath = requireRoot(root)
  let rootStats
  try {
    rootStats = lstatSync(rootPath)
  } catch {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'workspace root does not exist')
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'workspace root is not a directory')
  }

  const target = resolveInside(rootPath, relPath, { mustExist: true })
  let stats
  try {
    stats = lstatSync(target)
  } catch {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'path does not exist')
  }
  if (!stats.isDirectory()) {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'path is not a directory')
  }

  let dirents
  try {
    dirents = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    throw new WxapkgError(
      ERROR_CODES.INVALID_PATH,
      `cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const entries = []
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue // never expose symlink targets
    const absolute = join(target, dirent.name)
    let type
    let size = 0
    if (dirent.isDirectory()) {
      type = 'dir'
    } else if (dirent.isFile()) {
      type = 'file'
      try {
        size = statSync(absolute).size
      } catch {
        size = 0
      }
    } else {
      continue
    }
    entries.push({
      name: dirent.name,
      path: toPosix(relative(rootPath, absolute)),
      type,
      size,
    })
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })

  return {
    path: toPosix(relative(rootPath, target)),
    entries: entries.slice(0, MAX_TREE_ENTRIES),
  }
}

function readPrefix(filePath, bytes) {
  if (bytes <= 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(bytes)
  const fd = openSync(filePath, 'r')
  try {
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function splitLines(text) {
  if (text.length === 0) return []
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Read a slice of one text file (bytes/lines capped, binary-safe).
 *
 * JSON / JS files are pretty-printed for the viewer by default (the raw file on
 * disk is never modified). Pass `format: false` to receive the raw text.
 *
 * @param {{root:string, path:string, offset?:number, limit?:number, maxBytes?:number, format?:boolean|'auto'|'raw'}} options
 * @returns {{path:string, content:string, offset:number, limit:number, totalLines:number, truncated:boolean, size:number, binary:boolean, formatted:boolean, language:string}}
 */
export function readTextFile({
  root,
  path: relPath = '',
  offset = 0,
  limit = 200,
  maxBytes = 100 * 1024,
  format = 'auto',
} = {}) {
  const rootPath = requireRoot(root)
  const target = resolveInside(rootPath, relPath, { mustExist: true })
  let stats
  try {
    stats = lstatSync(target)
  } catch {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'path does not exist')
  }
  if (!stats.isFile()) {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'path is not a file')
  }
  const size = stats.size
  const relativePath = toPosix(relative(rootPath, target))

  let probe
  try {
    probe = readPrefix(target, Math.min(size, BINARY_PROBE_BYTES))
  } catch (error) {
    throw new WxapkgError(
      ERROR_CODES.INVALID_PATH,
      `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (probe.includes(0)) {
    return {
      path: relativePath,
      content: '',
      offset: 0,
      limit: 0,
      totalLines: 0,
      truncated: false,
      size,
      binary: true,
      formatted: false,
      language: 'binary',
    }
  }

  const numericMaxBytes = Number.isFinite(Number(maxBytes)) ? Math.trunc(Number(maxBytes)) : 100 * 1024
  const wantsFormat = format !== false && format !== 'raw' && format !== 'off' && format !== 0
  let text = ''
  let formatted = false
  let language = 'text'

  const formattedResult = wantsFormat ? cachedFormat(target, stats, relativePath) : null
  if (formattedResult) {
    text = formattedResult.text
    formatted = true
    language = formattedResult.language
  } else {
    const readBytes = Math.min(size, Math.max(0, Math.min(MAX_TEXT_READ_BYTES)))
    let head
    try {
      head = readPrefix(target, readBytes)
    } catch (error) {
      throw new WxapkgError(
        ERROR_CODES.INVALID_PATH,
        `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    text = head.toString('utf8')
  }

  const lines = splitLines(text)
  const requestedOffset = Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0
  const requestedLimit = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 200
  const start = Math.max(0, Math.min(requestedOffset, lines.length))
  const take = Math.max(0, Math.min(requestedLimit, MAX_TEXT_LINES))
  const page = lines.slice(start, start + take)
  const capped = capContentBytes(page.join('\n'), Math.max(1, numericMaxBytes))
  const fileCapped = size > MAX_TEXT_READ_BYTES && !formatted
  return {
    path: relativePath,
    content: capped.text,
    offset: start,
    limit: take,
    totalLines: lines.length,
    truncated: capped.capped || start + page.length < lines.length || fileCapped,
    size,
    binary: false,
    formatted,
    language,
  }
}

function globToRegExp(pattern) {
  const normalized = String(pattern || '').replace(/\\/g, '/')
  let source = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1
        // `**/` also matches zero directories.
        if (normalized[index + 1] === '/') index += 1
        source += '.*'
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  source += '$'
  return new RegExp(source)
}

function lineMatches(line, matcher, needle) {
  if (!matcher) return line.includes(needle)
  matcher.lastIndex = 0
  return matcher.test(line)
}

/**
 * Search text files below the unpacked root (read-only, never executes code).
 *
 * @param {{root:string, query:string, regex?:boolean, glob?:string, maxResults?:number, timeoutMs?:number}} options
 * @returns {{matches:Array<{file:string,line:number,text:string}>, scanned:number, truncated:boolean}}
 */
export function searchFiles({
  root,
  query,
  regex = false,
  glob = '',
  maxResults = 50,
  timeoutMs = 5000,
} = {}) {
  const rootPath = requireRoot(root)
  if (typeof query !== 'string' || query.length === 0) {
    throw new WxapkgError(ERROR_CODES.INVALID_QUERY, 'query must be a non-empty string')
  }
  let matcher = null
  if (regex) {
    try {
      matcher = new RegExp(query)
    } catch (error) {
      throw new WxapkgError(
        ERROR_CODES.INVALID_QUERY,
        `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const globMatcher = glob ? globToRegExp(glob) : null
  const resultCap = Math.max(1, Math.min(Number.isFinite(Number(maxResults)) ? Math.trunc(Number(maxResults)) : 50, SEARCH_MAX_RESULTS))
  const budgetMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 5000
  const startedAt = Date.now()

  let rootStats
  try {
    rootStats = lstatSync(rootPath)
  } catch {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'workspace root does not exist')
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'workspace root is not a directory')
  }

  const matches = []
  let scanned = 0
  let truncated = false
  const expired = () => Date.now() - startedAt > budgetMs

  const visitDirectory = (directory) => {
    if (truncated || expired()) {
      truncated = true
      return
    }
    let dirents
    try {
      dirents = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const dirent of dirents) {
      if (truncated) return
      if (expired()) {
        truncated = true
        return
      }
      if (dirent.isSymbolicLink()) continue
      const absolute = join(directory, dirent.name)
      if (dirent.isDirectory()) {
        if (dirent.name === 'node_modules') continue
        visitDirectory(absolute)
        continue
      }
      if (!dirent.isFile()) continue
      const rel = toPosix(relative(rootPath, absolute))
      if (globMatcher && !globMatcher.test(rel)) continue
      let fileStats
      try {
        fileStats = statSync(absolute)
      } catch {
        continue
      }
      if (fileStats.size > SEARCH_MAX_FILE_BYTES) continue
      let buffer
      try {
        buffer = readFileSync(absolute)
      } catch {
        continue
      }
      scanned += 1
      if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue
      const lines = splitLines(buffer.toString('utf8'))
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (!lineMatches(line, matcher, query)) continue
        let snippet = line
        if (line.length > SEARCH_SNIPPET_CHARS) {
          let hit = -1
          if (matcher) {
            matcher.lastIndex = 0
            const match = matcher.exec(line)
            hit = match ? match.index : -1
          } else {
            hit = line.indexOf(query)
          }
          if (hit < 0) hit = 0
          const windowStart = Math.max(0, hit - Math.floor(SEARCH_SNIPPET_CHARS / 3))
          const windowEnd = Math.min(line.length, windowStart + SEARCH_SNIPPET_CHARS)
          snippet = `${windowStart > 0 ? '…' : ''}${line.slice(windowStart, windowEnd)}${
            windowEnd < line.length ? '…' : ''
          }`
        }
        matches.push({ file: rel, line: index + 1, text: snippet })
        if (matches.length >= resultCap) {
          truncated = true
          return
        }
      }
    }
  }

  visitDirectory(rootPath)
  if (expired()) truncated = true
  return { matches, scanned, truncated }
}
