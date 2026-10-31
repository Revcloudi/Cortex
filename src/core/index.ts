/**
 * `@core` — Electron-free runtime shared by the desktop GUI, the stdio MCP
 * server and the `ctx` CLI.
 *
 * Nothing under `src/core` may import `electron` (or anything that does), so the
 * bundled MCP/CLI entries can run in a plain Node.js process.
 */
export { DatabaseError, DatabaseService, readSchemaVersion } from './db/DatabaseService'
export { seedDemoData } from './db/seed'
export {
  DB_PATH_ENV,
  LEGACY_DB_PATH_ENV,
  HUB_DB_FILENAME,
  HUB_DIR_NAME,
  databaseSidecarPaths,
  ensureDbDirectory,
  hardenDatabasePermissions,
  resolveDbPath,
  type ResolveDbPathOptions
} from './paths'
export {
  consoleLogger,
  silentLogger,
  truncateForLog,
  type HubLogger
} from './logging'
export { CORTEX_VERSION, PDH_VERSION } from './version'
