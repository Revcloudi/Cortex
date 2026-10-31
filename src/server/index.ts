import { closeSync, existsSync, openSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename } from 'node:path'
import { DatabaseService } from '../core/db/DatabaseService'
import { seedDemoData } from '../core/db/seed'
import { consoleLogger, type HubLogger } from '../core/logging'
import { ensureDbDirectory, hardenDatabasePermissions } from '../core/paths'
import { CORTEX_VERSION } from '../core/version'
import { CORTEX_APP_NAME } from '../shared/ipc'
import type { AppInfo } from '../shared/types'
import {
  WEB_API_PATHS,
  WEB_CHANGED_EVENT,
  WEB_TOKEN_QUERY_PARAM,
  isAllInterfacesHost,
  isLoopbackHost,
  type WebConfigInfo
} from '../shared/web'
import { createDatabaseWatcher } from '../main/watcher'
import { unauthorizedPageHtml, WebAuth } from './auth'
import { toHttpError } from './errors'
import { createRoutes } from './routes'
import {
  applySecurityHeaders,
  buildAccessUrls,
  collectAllowedHostnames,
  createRateLimiter,
  formatHostForUrl,
  isApiPath,
  isMutatingMethod,
  readJsonBody,
  sendHtml,
  sendJson,
  sendText
} from './security'
import { getWebSetupInfo, runWebSetup } from './setup'
import { createStaticServer } from './static'
import type {
  RouteDefinition,
  RouteRequest,
  WebServerDeps,
  WebServerOptions,
  WebServerHandle
} from './types'

/**
 * `ctx web` HTTP server.
 *
 * Design constraints (see docs/WEB_SUPPORT_DEVELOPMENT_GUIDE.md):
 * - loopback-only by default; non-loopback binding requires explicit opt-in;
 * - every API call authenticated with the run-scoped token (cookie or Bearer);
 * - strict same-origin policy, no CORS headers, Origin/Referer/Sec-Fetch-Site
 *   gating for writes, Host validation against DNS rebinding;
 * - strict security headers, bounded request bodies, per-IP rate limiting;
 * - one shared `DatabaseService`; the existing chokidar watcher drives SSE;
 * - errors are mapped to user-safe JSON, logs stay local and never include
 *   tokens, cookies or request bodies.
 */

const LOG_PREFIX = '[web]'
const SSE_HEARTBEAT_MS = 25_000
const MAX_SSE_CLIENTS = 20

/** Bind policy: loopback is always fine; anything else needs `--allow-intranet`. */
function assertBindingAllowed(host: string, allowIntranet: boolean): void {
  const trimmed = host.trim()
  if (trimmed.length === 0) {
    throw new Error('缺少监听地址（--host）。默认请使用 127.0.0.1。')
  }
  if (isLoopbackHost(trimmed)) return
  if (!allowIntranet) {
    throw new Error(
      [
        `拒绝绑定非回环地址 ${trimmed}：Web 端默认只允许本机访问。`,
        '如确需在受信任的内网中访问，请同时传入 --allow-intranet，',
        '并用防火墙/安全组仅放行私网 CIDR；绝不要把该端口映射或反向代理到公网。'
      ].join('')
    )
  }
  if (isAllInterfacesHost(trimmed)) {
    // Explicitly allowed, but this is the riskiest mode: every interface is exposed.
    return
  }
}

/** Cheap write-permission probe: `r+` on an existing DB file. */
function canWriteDatabaseFile(dbPath: string): boolean {
  if (dbPath === ':memory:') return true
  if (!existsSync(dbPath)) return true
  try {
    closeSync(openSync(dbPath, 'r+'))
    return true
  } catch {
    return false
  }
}

interface OpenDatabaseResult {
  db: DatabaseService
  readOnly: boolean
}

function openDatabase(dbPath: string, log: (message: string) => void): OpenDatabaseResult {
  if (canWriteDatabaseFile(dbPath)) {
    ensureDbDirectory(dbPath)
    hardenDatabasePermissions(dbPath)
    return { db: new DatabaseService(dbPath), readOnly: false }
  }

  log(`${LOG_PREFIX} SQLite file is not writable; starting in read-only mode`)
  try {
    return { db: new DatabaseService(dbPath, { readonly: true }), readOnly: true }
  } catch (error) {
    throw new Error(
      `数据库无写权限，且无法以只读方式打开：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** `/api/app` for the Web runtime: no absolute paths or machine details. */
function buildWebAppInfo(db: DatabaseService): AppInfo {
  return {
    name: CORTEX_APP_NAME,
    version: CORTEX_VERSION,
    projectRoot: '',
    dbPath: db.dbPath === ':memory:' ? ':memory:' : basename(db.dbPath),
    schemaVersion: db.getSchemaVersion(),
    platform: process.platform,
    electronVersion: '',
    nodeVersion: process.versions.node,
    chromeVersion: '',
    mcpRuntime: {
      mode: 'installed',
      command: 'ctx',
      entry: '',
      display: 'ctx web'
    }
  }
}

function buildWebConfig(
  options: WebServerOptions,
  db: DatabaseService,
  readOnly: boolean,
  port: number,
  startedAt: string
): WebConfigInfo {
  return {
    appName: CORTEX_APP_NAME,
    version: CORTEX_VERSION,
    runtime: 'web',
    dbFileName: db.dbPath === ':memory:' ? ':memory:' : basename(db.dbPath),
    schemaVersion: db.getSchemaVersion(),
    readOnly,
    host: options.host,
    port,
    loopbackOnly: isLoopbackHost(options.host),
    intranetAllowed: options.allowIntranet === true,
    startedAt
  }
}

/** Friendly message for the common `listen` failures. */
function listenErrorMessage(error: unknown, host: string, port: number): Error {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  if (code === 'EADDRINUSE') {
    return new Error(`端口 ${port} 已被占用：请换一个 --port，或先停止占用该端口的进程。`)
  }
  if (code === 'EACCES') {
    return new Error(`没有权限监听 ${host}:${port}：请换一个大于 1024 的端口。`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Wait for `server.close()` but never hang on lingering keep-alive sockets. */
async function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        server.closeAllConnections()
      } catch {
      }
      finish()
    }, 2_000)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      server.close(() => finish())
      server.closeIdleConnections()
    } catch {
      finish()
    }
  })
}

/**
 * Start the Cortex Web server.
 *
 * Resolves once the socket is listening (the returned handle carries the token
 * URL the CLI prints). `close()` is idempotent and drains SSE clients, the
 * database watcher and the shared `DatabaseService`.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  assertBindingAllowed(options.host, options.allowIntranet === true)

  const log = options.log ?? ((message: string) => consoleLogger.info(message))
  const hubLogger: HubLogger = {
    ...consoleLogger,
    info: (message: string) => log(message),
    warn: (message: string) => log(message),
    error: (message: string) => log(message)
  }

  const startedAt = new Date().toISOString()
  const { db, readOnly } = openDatabase(options.dbPath, log)

  const allowedHostnames = collectAllowedHostnames(
    options.host,
    options.allowIntranet === true,
    options.allowedHosts ?? []
  )
  const auth = new WebAuth({ token: options.token, allowedHostnames })
  const staticServer = createStaticServer(options.webRoot)
  const rateLimiter = createRateLimiter()

  /** Live SSE responses; a change event is a single `data: changed` frame. */
  const sseClients = new Set<ServerResponse>()
  const broadcastDataChanged = (): void => {
    for (const client of sseClients) {
      try {
        if (client.destroyed || client.writableEnded) {
          sseClients.delete(client)
          continue
        }
        client.write(`data: ${WEB_CHANGED_EVENT}\n\n`)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        if (client.destroyed || client.writableEnded) {
          sseClients.delete(client)
          continue
        }
        client.write(': ping\n\n')
      } catch {
        sseClients.delete(client)
      }
    }
  }, SSE_HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  const watcher = createDatabaseWatcher({
    dbPath: options.dbPath,
    onChange: broadcastDataChanged,
    logger: hubLogger
  })

  let deps: WebServerDeps = {
    db,
    notifyDataChanged: broadcastDataChanged,
    seedDemo: () => seedDemoData(db),
    appInfo: buildWebAppInfo(db),
    config: buildWebConfig(options, db, readOnly, options.port, startedAt),
    getSetupInfo: () => getWebSetupInfo(),
    runSetup: (request) => runWebSetup(request)
  }
  let routes: RouteDefinition[] = createRoutes(deps)

  const findRoute = (
    method: string,
    pathname: string
  ): { definition: RouteDefinition; params: string[] } | null => {
    for (const definition of routes) {
      if (definition.method !== method) continue
      const match = definition.pattern.exec(pathname)
      if (match === null) continue
      return { definition, params: match.slice(1) }
    }
    return null
  }

  const openEventStream = (req: IncomingMessage, res: ServerResponse): void => {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      sendJson(res, 503, { error: 'Too many event streams' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write('retry: 3000\n\n')
    sseClients.add(res)
    const cleanup = (): void => {
      sseClients.delete(res)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
  }

  /** API dispatch: body parsing + route match + error mapping. */
  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    pathname: string,
    search: URLSearchParams
  ): Promise<void> => {
    const route = findRoute(method, pathname)
    if (route === null) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }
    const request: RouteRequest = {
      method,
      pathname,
      query: search,
      params: route.params,
      body: undefined
    }
    if (isMutatingMethod(method)) {
      request.body = await readJsonBody(req)
    }
    const result = await route.definition.handler(request, deps)
    sendJson(res, 200, result === undefined ? null : result)
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now()
    let pathname = '/'
    applySecurityHeaders(res)
    try {
      const remoteAddress = req.socket.remoteAddress ?? 'unknown'
      if (!rateLimiter.allow(remoteAddress)) {
        sendJson(res, 429, { error: 'Too many requests' })
        return
      }
      if (!auth.isHostAllowed(req.headers.host)) {
        sendJson(res, 421, { error: 'Misdirected request: unexpected Host header' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      pathname = url.pathname
      const method = (req.method ?? 'GET').toUpperCase()

      // No CORS: reject every preflight/foreign OPTIONS request outright.
      if (method === 'OPTIONS') {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed' })
        return
      }

      // One-shot token bootstrap: exchange `?token=` for the session cookie.
      if ((pathname === '/' || pathname === '/index.html') && (method === 'GET' || method === 'HEAD')) {
        if (url.searchParams.has(WEB_TOKEN_QUERY_PARAM)) {
          if (!auth.hasBootstrapToken(url)) {
            sendHtml(res, 401, unauthorizedPageHtml())
            return
          }
          auth.setSessionCookie(res)
          const remaining = new URLSearchParams(url.searchParams)
          remaining.delete(WEB_TOKEN_QUERY_PARAM)
          const query = remaining.toString()
          res.statusCode = 303
          res.setHeader('Location', query.length > 0 ? `${pathname}?${query}` : pathname)
          res.setHeader('Cache-Control', 'no-store')
          res.end()
          return
        }
      }

      if (!auth.isAuthorized(req)) {
        if (isApiPath(pathname)) sendJson(res, 401, { error: 'Unauthorized' })
        else sendHtml(res, 401, unauthorizedPageHtml())
        return
      }

      // CSRF gate for state-changing verbs.
      if (isMutatingMethod(method)) {
        if (auth.checkRequestOrigin(req) === false) {
          sendJson(res, 403, { error: 'Cross-origin request rejected' })
          return
        }
        if (auth.checkFetchSite(req) === false) {
          sendJson(res, 403, { error: 'Cross-origin request rejected' })
          return
        }
        if (auth.checkRequestOrigin(req) === null && auth.readBearerToken(req) === null) {
          sendJson(res, 403, {
            error:
              'Origin/Referer header required for cookie-authenticated writes; use Authorization: Bearer for non-browser clients'
          })
          return
        }
      }

      if (pathname === WEB_API_PATHS.events) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' })
          return
        }
        openEventStream(req, res)
        return
      }

      if (isApiPath(pathname)) {
        await handleApi(req, res, method, pathname, url.searchParams)
        return
      }

      if (method === 'GET' || method === 'HEAD') {
        if (staticServer.serve(req, res, pathname)) return
        sendText(res, 404, 'Not found')
        return
      }

      sendJson(res, 405, { error: 'Method not allowed' })
    } catch (error) {
      const mapped = toHttpError(error)
      if (!mapped.expose) log(`${LOG_PREFIX} request failed: ${formatError(error)}`)
      if (res.headersSent) {
        res.end()
      } else {
        sendJson(res, mapped.status, { error: mapped.message })
      }
    } finally {
      log(`${LOG_PREFIX} ${req.method ?? 'GET'} ${pathname} ${res.statusCode} ${Date.now() - started}ms`)
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      log(`${LOG_PREFIX} unhandled request error: ${formatError(error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' })
      else res.end()
    })
  })
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(listenErrorMessage(error, options.host, options.port))
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port, options.host)
  })

  server.on('error', (error: Error) => {
    log(`${LOG_PREFIX} server error: ${formatError(error)}`)
  })

  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : options.port

  // The configured port may be 0 (ephemeral): refresh everything that quotes it.
  deps = { ...deps, config: buildWebConfig(options, db, readOnly, port, startedAt) }
  routes = createRoutes(deps)

  const access = buildAccessUrls(options.host, port, options.allowIntranet === true)
  const accessUrls = [...access.loopbackUrls, ...access.networkUrls]
  const tokenQuery = `${WEB_TOKEN_QUERY_PARAM}=${encodeURIComponent(auth.token)}`
  const tokenUrls = accessUrls.map((url) => `${url}/?${tokenQuery}`)
  const origin = accessUrls[0] ?? `http://${formatHostForUrl(options.host)}:${port}`

  log(
    `${LOG_PREFIX} v${CORTEX_VERSION} listening on ${origin} ` +
      `(${readOnly ? 'read-only' : 'read-write'}, db=${basename(db.dbPath)}, schema=${db.getSchemaVersion()}, web=${staticServer.hasIndex ? 'ready' : 'missing'})`
  )
  if (!staticServer.hasIndex) {
    log(`${LOG_PREFIX} warning: Web UI assets not found in ${options.webRoot}; run npm run build:web`)
  }
  if (options.allowIntranet === true) {
    log(`${LOG_PREFIX} 安全警告：已允许非回环地址访问，仅限受信任内网，禁止暴露公网。`)
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    rateLimiter.dispose()
    for (const client of sseClients) {
      try {
        client.end()
      } catch {
      }
    }
    sseClients.clear()
    await closeHttpServer(server)
    try {
      await watcher.stop()
    } catch (error) {
      log(`${LOG_PREFIX} failed to stop database watcher: ${formatError(error)}`)
    }
    try {
      db.close()
    } catch (error) {
      log(`${LOG_PREFIX} failed to close database: ${formatError(error)}`)
    }
  }

  return {
    host: options.host,
    port,
    origin,
    tokenUrl: tokenUrls[0] ?? `${origin}/?${tokenQuery}`,
    tokenUrls,
    accessUrls,
    token: auth.token,
    dbPath: options.dbPath,
    readOnly,
    config: deps.config,
    close
  }
}
