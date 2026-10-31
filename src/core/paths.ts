import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Directory (relative to the OS home) that owns Cortex's local database. */
export const HUB_DIR_NAME = '.cortex'
/** Default SQLite file name inside the data directory. */
export const HUB_DB_FILENAME = 'data.db'
/** Environment override so tests and multi-library setups can pick a DB file. */
export const DB_PATH_ENV = 'CTX_DB_PATH'
/** Pre-rename environment variable, still honoured for existing setups. */
export const LEGACY_DB_PATH_ENV = 'PDH_DB_PATH'

export interface ResolveDbPathOptions {
  env?: NodeJS.ProcessEnv
  /** Overridable for tests; defaults to the OS home directory. */
  homeDir?: string
}

/**
 * Single source of truth for the database location.
 *
 * `CTX_DB_PATH` (or the legacy `PDH_DB_PATH`) wins for tests and isolated
 * libraries; otherwise every entry point (Electron, stdio MCP, CLI) shares
 * `~/.cortex/data.db`.
 */
export function resolveDbPath(options: ResolveDbPathOptions = {}): string {
  const env = options.env ?? process.env
  const override =
    env[DB_PATH_ENV]?.trim() || env[LEGACY_DB_PATH_ENV]?.trim()
  if (override !== undefined && override.length > 0) return resolve(override)
  const home = options.homeDir ?? homedir()
  return join(home, HUB_DIR_NAME, HUB_DB_FILENAME)
}

/** Create the database directory (no-op for in-memory databases). */
export function ensureDbDirectory(dbPath: string): string | null {
  if (dbPath === ':memory:') return null
  const directory = dirname(dbPath)
  mkdirSync(directory, { recursive: true })
  if (process.platform !== 'win32') {
    try {
      chmodSync(directory, 0o700)
    } catch {
    }
  }
  return directory
}

/** The files SQLite may create next to the main database (WAL mode). */
export function databaseSidecarPaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
}

/**
 * Best-effort permission hardening for the database files.
 *
 * POSIX: chmod 600. Windows: try `icacls` (inheritance removed, current user
 * full control). Any failure is swallowed: the product deliberately keeps the
 * database plaintext, so permission hardening must never block startup.
 */
export function hardenDatabasePermissions(dbPath: string): void {
  if (dbPath === ':memory:') return
  try {
    if (process.platform === 'win32') {
      hardenWindowsAcl(dbPath)
      return
    }
    for (const file of databaseSidecarPaths(dbPath)) {
      if (!existsSync(file)) continue
      try {
        chmodSync(file, 0o600)
      } catch {
      }
    }
  } catch {
  }
}

function hardenWindowsAcl(dbPath: string): void {
  const files = databaseSidecarPaths(dbPath).filter((file) => existsSync(file))
  if (files.length === 0) return
  let account: string
  try {
    account = userInfo().username
  } catch {
    account = process.env['USERNAME'] ?? ''
  }
  if (account.length === 0) return
  try {
    spawnSync('icacls', [...files, '/inheritance:r', '/grant:r', `${account}:F`], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000
    })
  } catch {
  }
}
