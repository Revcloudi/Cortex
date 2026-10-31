/**
 * Shared Web-runtime contract.
 *
 * Imported by the browser renderer (through `@shared/web`) and by the local
 * `ctx web` HTTP server. Like `ipc.ts` this module must stay free of runtime
 * imports of third-party packages: the preload bundle only ever requires
 * `electron`, and shared modules are bundled into it.
 */

/** Value injected into the renderer build via `import.meta.env.VITE_CORTEX_RUNTIME`. */
export const WEB_RUNTIME = 'web' as const
export type WebRuntime = typeof WEB_RUNTIME

/** One-shot query parameter that exchanges the printed token for a session cookie. */
export const WEB_TOKEN_QUERY_PARAM = 'token'
/** HttpOnly + SameSite=Strict session cookie name. */
export const WEB_SESSION_COOKIE = 'cortex_web_session'
/** Default bind address: loopback only. */
export const WEB_DEFAULT_HOST = '127.0.0.1'
/** Default port for the local Web UI. */
export const WEB_DEFAULT_PORT = 8787
/** Hard cap for JSON request bodies (2 MB). */
export const WEB_BODY_LIMIT_BYTES = 2 * 1024 * 1024
/** SSE event name emitted whenever the shared SQLite database changes. */
export const WEB_CHANGED_EVENT = 'changed'
/** Session cookie lifetime: 12 hours. */
export const WEB_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60

/**
 * Canonical REST paths. The renderer transport and the server share these so a
 * route rename can never drift between the two halves of the Web feature.
 */
export const WEB_API_PATHS = {
  app: '/api/app',
  config: '/api/config',
  database: '/api/db',
  stats: '/api/stats',
  vulnerabilities: '/api/vulns',
  vulnerabilitiesDelete: '/api/vulns/delete',
  vulnerabilitiesExport: '/api/vulns/export',
  assets: '/api/assets',
  snapshots: '/api/snapshots',
  setup: '/api/setup',
  seedDemoData: '/api/demo/seed',
  events: '/api/events'
} as const

/** One exported Markdown report returned by `POST /api/vulns/export`. */
export interface WebExportFile {
  /** Safe file name derived from the vulnerability title (no path separators). */
  filename: string
  /** Full Markdown report body. */
  content: string
}

/** Response of `POST /api/vulns/export`; the browser downloads these, nothing is written server-side. */
export interface WebExportResponse {
  files: WebExportFile[]
}

/**
 * Non-secret Web runtime facts exposed by `GET /api/config`.
 *
 * Deliberately excludes the absolute database path, tokens, cookies and any
 * machine-specific log location: an authenticated intranet client only needs
 * the file name, schema version and read-only state.
 */
export interface WebConfigInfo {
  appName: string
  version: string
  runtime: WebRuntime
  /** Database file name only — never the absolute path. */
  dbFileName: string
  schemaVersion: number
  /** True when the server opened the database read-only (no write permission). */
  readOnly: boolean
  host: string
  port: number
  /** True when the server only listens on a loopback address. */
  loopbackOnly: boolean
  /** True when the operator explicitly allowed non-loopback binding. */
  intranetAllowed: boolean
  /** ISO-8601 server start time. */
  startedAt: string
}

/** Loopback host spellings accepted by `ctx web` without `--allow-intranet`. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

/** `0.0.0.0` / `::` / empty host: every interface, never allowed silently. */
export function isAllInterfacesHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return (
    normalized === '' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '[::]'
  )
}
