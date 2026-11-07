/**
 * Mini-program (wxapkg) root discovery and identity inference.
 *
 * All functions are pure path math over the environment (plus `existsSync`
 * checks in `expandRoots`) so they are trivially testable with fake envs and
 * temp trees. Nothing here writes to disk or touches WeChat's cache.
 *
 * Layouts handled:
 *   WeChat 4.x (xwechat)  <appdata>/Tencent/xwechat/radium/users/<hash>/applet/packages/<appid>/<version>/*.wxapkg
 *   public library        <users>/<hash>/applet/publicLib/<version>/publicLib.wxapkg
 *   WeChat 3.x            <home>/Documents/WeChat Files/.../packages/<appid>/<version>/*.wxapkg
 *   devtools              <localappdata>/微信web开发者工具/User Data/...
 *   custom/env roots      arbitrary depth (`CORTEX_MINIAPP_ROOTS`)
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'

/** @typedef {{kind:'xwechat'|'wechat3'|'devtools'|'custom', path:string, label:string, mode:'packages'|'recursive', maxDepth:number}} Root */

/** Default recursive scan depth used by discovery and detection. */
export const DEFAULT_MAX_DEPTH = 10

/** Appid directory segment, e.g. `wxdabf06925a55f410`. */
const APPID_RE = /^wx[0-9a-f]{16}$/i

/** Directory names that are never descended into. */
const SKIP_DIR_NAMES = new Set(['node_modules'])

/** @param {NodeJS.ProcessEnv} env */
function homeDir(env) {
  if (env && typeof env.HOME === 'string' && env.HOME.trim()) return env.HOME.trim()
  if (env && typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim()) return env.USERPROFILE.trim()
  return homedir()
}

/** @param {NodeJS.ProcessEnv} env */
function appDataDir(env) {
  if (env && typeof env.APPDATA === 'string' && env.APPDATA.trim()) return env.APPDATA.trim()
  return join(homeDir(env), 'AppData', 'Roaming')
}

/** @param {NodeJS.ProcessEnv} env */
function localAppDataDir(env) {
  if (env && typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()) return env.LOCALAPPDATA.trim()
  return join(homeDir(env), 'AppData', 'Local')
}

/**
 * Candidate roots (existing or not; `expandRoots` applies the existence filter).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Root[]}
 */
export function defaultRoots(env = process.env) {
  return [
    {
      kind: 'xwechat',
      path: resolve(join(appDataDir(env), 'Tencent', 'xwechat', 'radium', 'users')),
      label: 'WeChat 4.x (xwechat)',
      mode: 'recursive',
      maxDepth: DEFAULT_MAX_DEPTH,
    },
    {
      kind: 'wechat3',
      path: resolve(join(homeDir(env), 'Documents', 'WeChat Files')),
      label: 'WeChat Files (3.x)',
      mode: 'recursive',
      maxDepth: DEFAULT_MAX_DEPTH,
    },
    {
      kind: 'devtools',
      path: resolve(join(localAppDataDir(env), '微信web开发者工具', 'User Data')),
      label: 'WeChat DevTools',
      mode: 'recursive',
      maxDepth: DEFAULT_MAX_DEPTH,
    },
  ]
}

/**
 * Extra roots from `CORTEX_MINIAPP_ROOTS` (split on `path.delimiter`).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} absolute paths
 */
export function envRoots(env = process.env) {
  const raw = env && typeof env.CORTEX_MINIAPP_ROOTS === 'string' ? env.CORTEX_MINIAPP_ROOTS : ''
  if (!raw.trim()) return []
  const out = []
  for (const part of raw.split(delimiter)) {
    let value = part.trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim()
    if (!value) continue
    out.push(resolve(value))
  }
  return out
}

/** @param {string} value */
function rootKey(value) {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Resolve the effective root list: existing defaults first, then custom and
 * env roots. Non-existent roots are dropped unless `includeMissing`.
 * @param {{customRoots?:string[], env?:NodeJS.ProcessEnv, includeMissing?:boolean}} [options]
 * @returns {Root[]}
 */
export function expandRoots({ customRoots = [], env = process.env, includeMissing = false } = {}) {
  /** @type {Root[]} */
  const roots = []
  const seen = new Set()
  const push = (root) => {
    const key = rootKey(root.path)
    if (seen.has(key)) return
    seen.add(key)
    roots.push(root)
  }

  for (const root of defaultRoots(env)) {
    const exists = existsSync(root.path)
    if (exists || includeMissing) push({ ...root, path: resolve(root.path) })
  }

  const extra = []
  for (const entry of Array.isArray(customRoots) ? customRoots : []) {
    if (typeof entry === 'string' && entry.trim()) extra.push(entry.trim())
  }
  extra.push(...envRoots(env))

  for (const entry of extra) {
    const absolute = resolve(entry)
    const exists = existsSync(absolute)
    if (!exists && !includeMissing) continue
    push({
      kind: 'custom',
      path: absolute,
      label: basename(absolute) || absolute,
      mode: 'recursive',
      maxDepth: DEFAULT_MAX_DEPTH,
    })
  }

  return roots
}

/**
 * Sanitize one path segment for use below the miniapp workspace.
 * @param {string} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitizeSegment(value, fallback = '_') {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  let out = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (!out) return fallback
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = `_${out}`
  return out.slice(0, 120)
}

/** @param {string} value */
function isInsideRoot(rootPath, target) {
  const root = resolve(rootPath)
  const path = resolve(target)
  if (process.platform === 'win32') {
    const lowerRoot = root.toLowerCase()
    const lowerPath = path.toLowerCase()
    return lowerPath === lowerRoot || lowerPath.startsWith(lowerRoot + sep)
  }
  return path === root || path.startsWith(root + sep)
}

/** @param {string} segment */
function isVersionSegment(segment) {
  if (!segment || segment.length > 32) return false
  if (/^\d+$/.test(segment)) return true
  if (/^\d+(?:\.\d+){1,3}$/.test(segment)) return true
  if (/^\d{4}[-_.]\d{2}[-_.]\d{2}(?:[T _.-].*)?$/.test(segment)) return true
  return false
}

/**
 * Strip `_packages_` prefixes and app bookkeeping names, then accept only a
 * canonical wx appid segment.
 * @param {string} segment
 * @returns {string}
 */
function appidFromSegment(segment) {
  let value = String(segment ?? '').trim()
  if (!value || SKIP_DIR_NAMES.has(value.toLowerCase())) return ''
  const lower = value.toLowerCase()
  const marker = lower.indexOf('_packages_')
  if (marker >= 0) value = value.slice(marker + '_packages_'.length)
  if (/^_?(?:__app__|publiclib)$/i.test(value)) return ''
  if (APPID_RE.test(value)) return value
  return ''
}

/**
 * Derive `{appid, version, packageDir, packageName, rootPath, rootKind}` from
 * one package file and the scan root that produced it.
 *
 * @param {string} filePath
 * @param {Root|{kind?:string, path:string}|string} root
 */
export function inferIdentity(filePath, root) {
  const rootPath = resolve(typeof root === 'string' ? root : root && root.path ? root.path : process.cwd())
  const rootKind = typeof root === 'object' && root && typeof root.kind === 'string' && root.kind ? root.kind : 'custom'
  const fileAbs = resolve(filePath)
  const inside = isInsideRoot(rootPath, fileAbs)
  const packageDir = inside ? dirname(fileAbs) : rootPath

  const base = basename(fileAbs)
  const packageName = base.toLowerCase().endsWith('.wxapkg') ? base.slice(0, -'.wxapkg'.length) : base

  /** @type {string} */
  let appid = ''
  /** @type {string} */
  let version = ''

  if (inside) {
    const segments = relative(rootPath, packageDir)
      .split(/[\\/]+/)
      .filter(Boolean)

    // 1. publicLib layout: .../applet/publicLib/<version>/publicLib.wxapkg
    let publicLibIndex = -1
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (segments[index].toLowerCase() === 'publiclib') {
        publicLibIndex = index
        break
      }
    }
    if (publicLibIndex >= 0) {
      const candidate = segments[publicLibIndex + 1] || ''
      return {
        appid: 'publicLib',
        version: isVersionSegment(candidate) ? candidate : '',
        packageDir,
        packageName,
        rootPath,
        rootKind,
      }
    }

    // 2. canonical wx appid directory, nearest the file first.
    let appidIndex = -1
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const candidate = appidFromSegment(segments[index])
      if (candidate) {
        appid = candidate
        appidIndex = index
        break
      }
    }

    if (appidIndex >= 0) {
      for (let index = appidIndex + 1; index < segments.length; index += 1) {
        if (isVersionSegment(segments[index])) {
          version = segments[index]
          break
        }
      }
    }
  }

  return { appid, version, packageDir, packageName, rootPath, rootKind }
}

/**
 * Absolute miniapp workspace root (`CORTEX_MINIAPP_WORKSPACE` or
 * `~/.cortex/miniapps`).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function miniAppWorkspaceRoot(env = process.env) {
  const override =
    env && typeof env.CORTEX_MINIAPP_WORKSPACE === 'string' ? env.CORTEX_MINIAPP_WORKSPACE.trim() : ''
  return resolve(override || join(homeDir(env), '.cortex', 'miniapps'))
}

/**
 * Per-package workspace layout:
 *   <root>/<appid>/<version>/
 *     unpacked/            extracted app files + manifest.json + overview.json
 *
 * `manifestPath` / `extractedPath` live inside `unpacked` so the unpack and
 * analyze helpers can address them from `unpacked_path` alone.
 *
 * @param {string} appid
 * @param {string} version
 * @param {NodeJS.ProcessEnv} [env]
 */
export function packageWorkspace(appid, version, env = process.env) {
  const root = join(
    miniAppWorkspaceRoot(env),
    sanitizeSegment(appid, 'unknown'),
    sanitizeSegment(version, 'unknown'),
  )
  const unpacked = join(root, 'unpacked')
  return {
    root,
    unpacked,
    manifestPath: join(unpacked, 'manifest.json'),
    extractedPath: join(unpacked, 'extracted.json'),
  }
}
