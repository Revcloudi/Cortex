import type { DatabaseService } from '../core/db/DatabaseService'
import type {
  AppInfo,
  SetupInfo,
  SetupRunRequest,
  SetupRunResult
} from '../shared/types'
import type { WebConfigInfo } from '../shared/web'

/**
 * Contracts between the Web server entry (`index.ts`), the REST router
 * (`routes.ts`) and the CLI (`src/cli/commands/web.ts`).
 *
 * The server reuses the desktop `DatabaseService` and the shared zod schemas —
 * route handlers are a thin HTTP adapter over the same operations the Electron
 * IPC handlers expose, with identical response shapes for the renderer.
 */

/** Everything a route handler may use; one instance shared by every request. */
export interface WebServerDeps {
  /** The single `DatabaseService` instance opened at startup (dashboard/CLI/MCP share the file). */
  db: DatabaseService
  /** Broadcast an SSE `changed` event (mirrors the desktop `data:changed` IPC push). */
  notifyDataChanged: () => void
  /** Insert demo rows and return the number of inserted vulnerabilities. */
  seedDemo: () => number
  /** Sanitized `AppInfo` (database path reduced to its file name). */
  appInfo: AppInfo
  /** Sanitized Web runtime facts for `GET /api/config`. */
  config: WebConfigInfo
  /** Agent detection + first-run setup state for the MCP page. */
  getSetupInfo: () => SetupInfo
  /** Reuse `ctx init` in-process (writes the server machine's agent configs). */
  runSetup: (request: SetupRunRequest) => Promise<SetupRunResult>
}

/** Normalized HTTP request handed to a route handler. */
export interface RouteRequest {
  method: string
  /** Path without query string, still percent-encoded. */
  pathname: string
  query: URLSearchParams
  /** Regex capture groups from the matched `RouteDefinition.pattern` (raw, not decoded). */
  params: string[]
  /** Parsed JSON body; `undefined` when the request has no body. */
  body: unknown
}

/**
 * Handler result. Returning a value serializes it as JSON with status 200;
 * throwing `WebApiError` / `DatabaseError` is mapped by the server entry.
 */
export type RouteHandler = (
  request: RouteRequest,
  deps: WebServerDeps
) => unknown | Promise<unknown>

/** One method + path pattern; patterns are matched in declaration order. */
export interface RouteDefinition {
  /** `GET` / `POST` / `PATCH` / `DELETE`. */
  method: string
  pattern: RegExp
  handler: RouteHandler
}

/** `createRoutes()` builds the ordered table consumed by the HTTP entry. */
export type RouteFactory = (deps: WebServerDeps) => RouteDefinition[]

export interface WebServerOptions {
  /** Bind address. Loopback by default; anything else requires `allowIntranet`. */
  host: string
  port: number
  /** SQLite file to attach (already resolved by the CLI). */
  dbPath: string
  /** Directory containing the built SPA (`out/web`, installed: `<bin>/web`). */
  webRoot: string
  /** Explicit opt-in for non-loopback binding (`--allow-intranet`). */
  allowIntranet?: boolean
  /**
   * Extra hostnames accepted in the `Host`/`Origin` headers (for example the
   * internal TLS reverse-proxy name from `CTX_WEB_ALLOWED_HOSTS`). Opt-in only.
   */
  allowedHosts?: readonly string[]
  /** Fixed token override; used by verification scripts only. */
  token?: string
  /** Local-only logger; never receives tokens, cookies or request bodies. */
  log?: (message: string) => void
}

export interface WebServerHandle {
  readonly host: string
  readonly port: number
  /** e.g. `http://127.0.0.1:8787` */
  readonly origin: string
  /** One-time bootstrap URL: `origin/?token=...` (printed by `ctx web`). */
  readonly tokenUrl: string
  /** Every URL a human can open (loopback first, then intranet addresses). */
  readonly tokenUrls: readonly string[]
  /** URLs without the token, for the startup banner. */
  readonly accessUrls: readonly string[]
  readonly token: string
  readonly dbPath: string
  readonly readOnly: boolean
  readonly config: WebConfigInfo
  /** Stop accepting requests, drop SSE clients, close the watcher and the database. */
  close(): Promise<void>
}
