/**
 * Host handlers for the ported Cortex UI: diagnostic / setup / PoC endpoints
 * that have no desktop equivalent inside the DSH plugin Host.
 *
 * The shared contract still exports real types for all of them, so this module
 * either returns a **safe minimal value** (no secrets, no absolute paths) or a
 * structured `501 {error, code:'UNSUPPORTED'}` when the feature is
 * desktop-only. The renderer tolerates all of these:
 *
 *   GET  /db/info        -> DatabaseInfo      (file basename only)
 *   GET  /app/info       -> AppInfo           (version + db + platform facts)
 *   GET  /setup/info     -> SetupInfo         (stub: setup owned by DSH)
 *   POST /setup/run      -> 501
 *   POST /seed-demo      -> 501
 *   GET  /poc/config     -> PocConfigView     (empty, no providers / secrets)
 *   POST /poc/**         -> 501
 *   DELETE /poc/providers/:id -> 501
 *   POST /loot/import    -> 501 (desktop-only file parsing)
 *
 * `GET /loot` is NOT handled here: the internal-operations module owns it and
 * `index.js` delegates the whole `/internal/**` + `/loot` surface to it.
 */

import { statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { badRequest, readJsonBody, sendJson } from '../http.js'
import { rememberDbPath } from './settings.js'
import { DEFAULT_DB_LABEL, candidateDatabasePaths, expandHome } from './db-paths.js'

/** Execution limits mirroring `POC_LIMITS` in shared/poc.ts. */
const POC_LIMITS = {
  totalTimeoutMs: 10_000,
  requestTimeoutMs: 8_000,
  maxRequests: 50,
  maxResponseBytes: 2_000_000,
  maxCodeBytes: 64_000,
}

/**
 * Standard "desktop-only in this host" response.
 * @param {import('node:http').ServerResponse} res
 * @param {string} [message]
 */
export function sendUnsupported(
  res,
  message = 'this desktop-only feature is not available in the DSH plugin host',
) {
  sendJson(res, 501, { error: message, code: 'UNSUPPORTED' })
}

/**
 * Route handler for every desktop-only POST/DELETE stub. The (optional) JSON
 * body is read purely to drain the socket so a keep-alive connection stays
 * usable; the content is never used or logged.
 */
export async function unsupportedHandler({ res, req }) {
  try {
    await readJsonBody(req)
  } catch {
    /* no/invalid body: the 501 is still the documented answer */
  }
  sendUnsupported(res)
}

/* ------------------------------------------------------------------------- */
/* Database / app / setup metadata                                           */
/* ------------------------------------------------------------------------- */

/** @param {string} filePath */
function fileStat(filePath) {
  try {
    const stat = statSync(filePath)
    return { exists: true, size: Number(stat.size) || 0, mtimeMs: Number(stat.mtimeMs) || 0 }
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 }
  }
}

/** GET /db/info -> DatabaseInfo (never the absolute path) */
export function handleDbInfo({ res, holder }) {
  holder.ensure()
  sendJson(res, 200, databaseInfo(holder))
}

/** Shared shape for GET /db/info and POST /db/configure. */
function databaseInfo(holder) {
  const dbPath = typeof holder.dbPath === 'string' ? holder.dbPath : ''
  const main = fileStat(dbPath)
  const wal = fileStat(`${dbPath}-wal`)
  const lastModifiedMs = Math.max(main.mtimeMs, wal.mtimeMs)
  return {
    dbPath: dbPath.length > 0 ? basename(dbPath) : '',
    schemaVersion: holder.schemaVersion === null ? 0 : Number(holder.schemaVersion),
    compatible: holder.compatible === true,
    exists: main.exists,
    sizeBytes: main.size,
    walSizeBytes: wal.size,
    lastModifiedAt: lastModifiedMs > 0 ? new Date(lastModifiedMs).toISOString() : null,
    readOnly: holder.readOnly === true || holder.readOnlyFallback === true,
    readOnlyFallback: holder.readOnlyFallback === true,
    openError: typeof holder.openError === 'string' ? holder.openError : null,
  }
}

const MAX_DB_PATH_LENGTH = 2000

/** Expand `~` and resolve a user-entered database path. */
function resolveConfiguredPath(rawPath, defaultPath) {
  const value = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (value.length === 0) return defaultPath
  if (value.length > MAX_DB_PATH_LENGTH) {
    throw badRequest('database path is too long', { field: 'path', max: MAX_DB_PATH_LENGTH })
  }
  // A Windows drive path is never meaningful to a POSIX Host. Give a direct
  // hint instead of the generic "must be absolute" message: the Web DSH host
  // may be a Linux container while the file lives on the user's PC.
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(value)) {
    throw badRequest(
      `this Host is ${process.platform}; a Windows drive path cannot be opened. Copy the database to this Host or use its Linux/macOS path.`,
      { field: 'path', platform: process.platform }
    )
  }
  const expanded = expandHome(value)
  if (!isAbsolute(expanded)) {
    throw badRequest('database path must be absolute or start with ~', {
      field: 'path',
      platform: process.platform,
    })
  }
  return resolve(expanded)
}

/** GET /db/candidates -> existing Cortex DB candidates on this Host. */
export function handleDbCandidates({ res }) {
  sendJson(res, 200, {
    platform: process.platform,
    defaultPath: DEFAULT_DB_LABEL,
    candidates: candidateDatabasePaths(),
  })
}

/**
 * POST /db/configure { path } -> DatabaseInfo
 *
 * Web DSH hosts do not necessarily run with the operator's HOME; this lets the
 * UI point the Host at a Cortex v5 SQLite file on the machine that runs DSH.
 * The path is persisted in the plugin settings for the next host start.
 */
export async function handleDbConfigure({ req, res, holder }) {
  const body = await readJsonBody(req)
  const rawPath = body && typeof body.path === 'string' ? body.path : ''
  const target = resolveConfiguredPath(
    rawPath,
    typeof holder.defaultDbPath === 'string' ? holder.defaultDbPath : ''
  )
  holder.configure(target)
  const status = databaseInfo(holder)
  if (rawPath.trim().length === 0) rememberDbPath(null)
  else if (status.compatible) rememberDbPath(target)
  sendJson(res, 200, status)
}

/** GET /app/info -> AppInfo (no absolute filesystem paths) */
export function handleAppInfo({ res, holder, version }) {
  const dbPath =
    typeof holder.dbPath === 'string' && holder.dbPath.length > 0 ? basename(holder.dbPath) : ''
  sendJson(res, 200, {
    name: 'Cortex',
    version: typeof version === 'string' && version.length > 0 ? version : '0.1.0',
    projectRoot: '',
    dbPath,
    schemaVersion: holder.schemaVersion === null ? 0 : Number(holder.schemaVersion),
    platform: process.platform,
    electronVersion: '',
    nodeVersion: process.version,
    chromeVersion: '',
    mcpRuntime: {
      mode: 'installed',
      command: 'node',
      entry: '',
      display: 'cortex MCP (stdio)',
    },
  })
}

/** GET /setup/info -> SetupInfo (setup is owned by the DSH profile) */
export function handleSetupInfo({ res }) {
  sendJson(res, 200, {
    alreadyConfigured: true,
    agents: [],
    defaultSkillLanguage: 'zh',
    defaultUiLanguage: 'zh',
  })
}

/* ------------------------------------------------------------------------- */
/* PoC / AI model configuration (desktop-only in Cortex)                     */
/* ------------------------------------------------------------------------- */

/** GET /poc/config -> minimal valid PocConfigView with no providers/secrets */
export function handlePocConfig({ res }) {
  sendJson(res, 200, {
    path: 'config.json',
    configFileExists: false,
    enabled: false,
    executionEnabled: false,
    activeProviderId: null,
    providers: [],
    proxy: {
      enabled: false,
      url: '',
      caConfigured: false,
      allowInsecureTls: false,
    },
    limits: { ...POC_LIMITS },
    overriddenByEnv: [],
    permissionWarning: null,
  })
}
