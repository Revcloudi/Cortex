/**
 * PocHttpBridge — the only network path available to a retest script.
 *
 * This module is deliberately free of `electron` imports so it can be unit
 * tested with plain Node (`node --test`). It owns everything a compromised
 * artifact must not be able to influence:
 *
 * - the target allowlist: only the vulnerability target origin (and links the
 *   user explicitly approved) is reachable; relative URLs resolve against the
 *   accepted base origin, absolute URLs must be same-origin, redirects are
 *   followed manually and every hop is re-validated (cross-origin => blocked);
 * - proxy handling (HTTP absolute-form for http targets, CONNECT + TLS for
 *   https targets), proxy Basic auth, CA bundles and the explicit
 *   `allowInsecureTls` escape hatch (never a process-wide env var);
 * - resource limits: per-request timeout, hard request cap, response byte cap
 *   with truncation;
 * - DNS rebinding defence: when the allowed origin host is a DNS name, its
 *   resolved addresses may not be loopback / private / link-local (cloud
 *   metadata) ranges. Literal-IP targets (the user's actual vulnerability
 *   target) are allowed as-is.
 *
 * SECURITY: header values, bodies and proxy credentials are never logged. The
 * log line contains method + pathname (query stripped) + status + duration.
 */
import { readFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { isIP } from 'node:net'
import { POC_ERROR_CODES, createPocError } from '../../shared/poc'
import type { HubLogger } from '../../core/logging'
import type {
  PocHttpBridge,
  PocHttpBridgeOptions,
  PocHttpMethod,
  PocHttpRequest,
  PocHttpResponse,
  PocProxyRuntimeConfig
} from './pocContracts'

/** HTTP methods a retest script may use. */
const ALLOWED_METHODS: readonly PocHttpMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS'
]

/** Maximum redirect hops per `request()` call (each hop counts as a request). */
const MAX_REDIRECTS = 5

/** Redirect status codes followed by the bridge. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/**
 * Hop-by-hop headers that must never be forwarded to the target. Proxy
 * credentials are added by the bridge only on the proxy connection itself.
 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'proxy-connection',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Re-computed by the HTTP client from the body / target URL:
  'content-length',
  'host'
])

const MAX_HEADER_COUNT = 100
const MAX_HEADER_NAME_LENGTH = 200
const MAX_HEADER_VALUE_LENGTH = 16_384

export interface OriginCheckResult {
  ok: boolean
  /** Machine readable reason when `ok` is false (never contains secrets). */
  reason?: string
}

/** IPv4 ranges that must never be reached through a DNS-name allowlist entry. */
function isBlockedIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }
  const [a = 0, b = 0] = parts
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

/** IPv6 ranges that must never be reached through a DNS-name allowlist entry. */
function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? address.toLowerCase()
  if (normalized === '::1' || normalized === '::') return true
  // IPv4-mapped addresses (::ffff:127.0.0.1) reuse the IPv4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (mapped?.[1] !== undefined) return isBlockedIPv4(mapped[1])
  const firstGroup = normalized.startsWith('::') ? '0' : (normalized.split(':')[0] ?? '')
  let first = Number.parseInt(firstGroup, 16)
  if (!Number.isFinite(first)) first = 0
  if ((first & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true // multicast
  return false
}

/** True when a resolved IP is in a range a DNS-name target must not reach. */
function isBlockedResolvedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isBlockedIPv4(address)
  if (family === 6) return isBlockedIPv6(address)
  return true
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** `http(s)://origin` normalized, or `null` when the value is not an origin. */
function normalizeAllowedOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Absolute http(s) URL allowed by the (already normalized) origin allowlist.
 * Strings are resolved against the first allowed origin, which is exactly the
 * vulnerability target origin supplied by `PocService`.
 */
export function isOriginAllowed(
  url: string | URL,
  allowedOrigins: readonly string[]
): OriginCheckResult {
  const normalized = allowedOrigins
    .map((origin) => normalizeAllowedOrigin(origin))
    .filter((origin): origin is string => origin !== null)
  if (normalized.length === 0) return { ok: false, reason: 'no-allowed-origin' }

  let target: URL
  try {
    target = typeof url === 'string' ? new URL(url, normalized[0]) : url
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, reason: `scheme-not-allowed:${target.protocol.replace(':', '')}` }
  }
  if (target.username !== '' || target.password !== '') {
    return { ok: false, reason: 'userinfo-not-allowed' }
  }
  if (!normalized.includes(target.origin)) return { ok: false, reason: `origin-not-allowed:${target.origin}` }
  return { ok: true }
}

/* ------------------------------------------------------------------------- */
/* Header helpers                                                            */
/* ------------------------------------------------------------------------- */

function hasInvalidHeaderName(name: string): boolean {
  return !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || name.length > MAX_HEADER_NAME_LENGTH
}

function hasInvalidHeaderValue(value: string): boolean {
  return /[\r\n\0]/.test(value) || value.length > MAX_HEADER_VALUE_LENGTH
}

/**
 * Sanitize user supplied headers before they are forwarded: reject injection
 * attempts, drop hop-by-hop/proxy headers and collapse duplicate names
 * case-insensitively (last occurrence wins; values are trimmed).
 */
function sanitizeRequestHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> {
  if (headers === undefined) return {}
  const entries = Object.entries(headers)
  if (entries.length > MAX_HEADER_COUNT) {
    throw createPocError(
      POC_ERROR_CODES.INVALID_INPUT,
      `请求头数量超过上限（最多 ${MAX_HEADER_COUNT} 个）`
    )
  }
  const out: Record<string, string> = {}
  const seen = new Map<string, string>()
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    if (hasInvalidHeaderName(name)) {
      throw createPocError(POC_ERROR_CODES.INVALID_INPUT, `请求头名称非法：${name.slice(0, 40)}`)
    }
    if (typeof rawValue !== 'string') {
      throw createPocError(POC_ERROR_CODES.INVALID_INPUT, `请求头 ${name} 的值必须是字符串`)
    }
    const value = rawValue.trim()
    if (hasInvalidHeaderValue(value)) {
      throw createPocError(POC_ERROR_CODES.INVALID_INPUT, `请求头 ${name} 的值包含非法字符`)
    }
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    const previous = seen.get(lower)
    if (previous !== undefined) {
      // Duplicate name (different case): collapse into the first spelling.
      out[previous] = `${out[previous]}, ${value}`
      continue
    }
    seen.set(lower, name)
    out[name] = value
  }
  return out
}

/** Collapse raw response headers (`set-cookie` keeps one value per line). */
function sanitizeResponseHeaders(message: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = message.rawHeaders
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]
    const value = raw[index + 1]
    if (name === undefined || value === undefined) continue
    const lower = name.toLowerCase()
    const current = out[lower]
    if (current === undefined) out[lower] = value
    else if (lower === 'set-cookie') out[lower] = `${current}\n${value}`
    else out[lower] = `${current}, ${value}`
  }
  return out
}

function normalizeMethod(method: string | undefined): PocHttpMethod {
  const candidate = (method ?? 'GET').toUpperCase()
  const match = ALLOWED_METHODS.find((allowed) => allowed === candidate)
  if (match === undefined) {
    throw createPocError(POC_ERROR_CODES.INVALID_INPUT, `不支持的请求方法：${String(method).slice(0, 20)}`)
  }
  return match
}

function abortError(): Error {
  return createPocError(POC_ERROR_CODES.ABORTED, '请求已中止')
}

function targetBlocked(reason: string): Error {
  return createPocError(POC_ERROR_CODES.TARGET_NOT_ALLOWED, `目标地址不被允许：${reason}`)
}

/* ------------------------------------------------------------------------- */
/* Bridge                                                                    */
/* ------------------------------------------------------------------------- */

interface ParsedProxy {
  hostname: string
  port: number
  authHeader: string | null
}

interface SendOptions {
  method: PocHttpMethod
  url: URL
  headers: Record<string, string>
  body: string | undefined
  timeoutMs: number
  signal: AbortSignal
}

interface HopResponse extends PocHttpResponse {
  /** Raw Location header used for redirect handling. */
  location: string | null
}

/**
 * `PocHttpBridge` implementation. One instance per sandbox run: it snapshots
 * the proxy/TLS configuration so a config change mid-run cannot affect it.
 */
export class HttpBridge implements PocHttpBridge {
  private readonly normalizedOrigins: string[]
  private readonly proxy: ParsedProxy | null
  private readonly proxyConfigError: Error | null
  private readonly ca: Buffer | null
  private readonly allowInsecureTls: boolean
  private readonly limits: PocHttpBridgeOptions['limits']
  private readonly logger: HubLogger
  private readonly activeRequests = new Set<ClientRequest>()
  private requestCounter = 0
  private blockedCounter = 0
  private disposed = false

  constructor(options: PocHttpBridgeOptions) {
    this.logger = options.logger
    this.limits = options.limits
    this.normalizedOrigins = options.allowedOrigins
      .map((origin) => normalizeAllowedOrigin(origin))
      .filter((origin): origin is string => origin !== null)
    this.allowInsecureTls = options.proxy?.allowInsecureTls === true
    this.ca = this.loadCa(options.proxy)
    const parsed = this.parseProxy(options.proxy)
    this.proxy = parsed.proxy
    this.proxyConfigError = parsed.error
    if (this.allowInsecureTls) {
      // Explicit, per-run marker. The bridge never sets NODE_TLS_REJECT_UNAUTHORIZED.
      this.logger.warn('TLS verification disabled (allowInsecureTls=true, per-run only)')
    }
  }

  /** Number of outbound HTTP requests made (redirect hops included). */
  get requestCount(): number {
    return this.requestCounter
  }

  /** Number of target validations rejected by the allowlist / SSRF checks. */
  get blockedCount(): number {
    return this.blockedCounter
  }

  /** Raw proxy config is only read here; credentials never leave this module. */
  private parseProxy(
    proxy: PocProxyRuntimeConfig | null
  ): { proxy: ParsedProxy | null; error: Error | null } {
    if (proxy === null || !proxy.enabled || proxy.url.trim() === '') return { proxy: null, error: null }
    let parsed: URL
    try {
      parsed = new URL(proxy.url.trim())
    } catch {
      return {
        proxy: null,
        error: createPocError(POC_ERROR_CODES.INVALID_CONFIG, '复测代理 URL 无效：无法解析')
      }
    }
    if (parsed.protocol !== 'http:') {
      return {
        proxy: null,
        error: createPocError(
          POC_ERROR_CODES.INVALID_CONFIG,
          `复测代理仅支持 HTTP 代理（当前 ${parsed.protocol.replace(':', '')}）`
        )
      }
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return {
        proxy: null,
        error: createPocError(
          POC_ERROR_CODES.INVALID_CONFIG,
          '复测代理 URL 不能包含用户名/密码，请使用配置中的认证字段'
        )
      }
    }
    const port = parsed.port === '' ? 80 : Number(parsed.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return {
        proxy: null,
        error: createPocError(POC_ERROR_CODES.INVALID_CONFIG, '复测代理端口无效')
      }
    }
    const username = proxy.username
    const password = proxy.password
    const authHeader =
      username === '' && password === ''
        ? null
        : `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
    return { proxy: { hostname: parsed.hostname, port, authHeader }, error: null }
  }

  private loadCa(proxy: PocProxyRuntimeConfig | null): Buffer | null {
    const caPath = proxy?.caPath.trim() ?? ''
    if (caPath === '') return null
    try {
      return readFileSync(caPath)
    } catch {
      throw createPocError(
        POC_ERROR_CODES.INVALID_CONFIG,
        '无法读取复测代理 CA 证书文件（caPath），请检查路径与文件权限'
      )
    }
  }

  dispose(): void {
    this.disposed = true
    for (const request of this.activeRequests) {
      try {
        request.destroy()
      } catch {
        /* best effort */
      }
    }
    this.activeRequests.clear()
  }

  async request(request: PocHttpRequest, signal: AbortSignal): Promise<PocHttpResponse> {
    const startedAt = Date.now()
    if (this.disposed) {
      throw createPocError(POC_ERROR_CODES.ABORTED, '沙箱网络桥已关闭')
    }
    if (this.proxyConfigError !== null) throw this.proxyConfigError
    const baseOrigin = this.normalizedOrigins[0]
    if (baseOrigin === undefined) {
      throw targetBlocked('没有允许的目标 origin')
    }
    if (signal.aborted) throw abortError()

    let url = this.resolveTarget(request.url, baseOrigin)
    let method = normalizeMethod(request.method)
    let headers = sanitizeRequestHeaders(request.headers)
    let body = typeof request.body === 'string' ? request.body : undefined
    const timeoutMs = this.clampTimeout(request.timeoutMs)

    for (let redirect = 0; ; redirect += 1) {
      if (this.disposed) throw createPocError(POC_ERROR_CODES.ABORTED, '沙箱网络桥已关闭')
      if (signal.aborted) throw abortError()
      if (this.requestCounter >= this.limits.maxRequests) {
        throw createPocError(
          POC_ERROR_CODES.INVALID_INPUT,
          `请求次数超过上限（maxRequests=${this.limits.maxRequests}）`
        )
      }
      this.requestCounter += 1
      await this.assertTargetAddress(url)
      const hop = await this.send({
        method,
        url,
        headers,
        body,
        timeoutMs,
        signal
      })
      this.logger.debug(
        `[poc-http] ${method} ${url.pathname} -> ${hop.status} (${Date.now() - startedAt}ms)`
      )
      if (
        request.followRedirects !== false &&
        REDIRECT_STATUSES.has(hop.status) &&
        hop.location !== null
      ) {
        if (redirect >= MAX_REDIRECTS) {
          throw createPocError(
            POC_ERROR_CODES.INVALID_INPUT,
            `重定向次数超过上限（最多 ${MAX_REDIRECTS} 次）`
          )
        }
        url = this.resolveTarget(hop.location, baseOrigin, url)
        const redirected = redirectMethod(method, hop.status)
        if (redirected === 'GET') {
          method = 'GET'
          body = undefined
        }
        continue
      }
      return {
        status: hop.status,
        headers: hop.headers,
        body: hop.body,
        durationMs: Date.now() - startedAt,
        truncated: hop.truncated
      }
    }
  }

  private clampTimeout(requested: number | undefined): number {
    const fallback = this.limits.requestTimeoutMs
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return fallback
    return Math.max(250, Math.min(Math.floor(requested), fallback))
  }

  /** Resolve a relative/absolute URL and validate the allowlist (no I/O). */
  private resolveTarget(rawUrl: string, baseOrigin: string, base?: URL): URL {
    const value = rawUrl.trim()
    if (value === '') throw targetBlocked('URL 为空')
    if (value.length > 8_000) throw targetBlocked('URL 过长')
    let url: URL
    try {
      url = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
        ? new URL(value)
        : new URL(value, base ?? baseOrigin)
    } catch {
      this.recordBlocked('invalid-url')
      throw targetBlocked('URL 无法解析')
    }
    const check = isOriginAllowed(url, this.normalizedOrigins)
    if (!check.ok) {
      this.recordBlocked(check.reason ?? 'origin-not-allowed')
      throw targetBlocked(check.reason ?? '目标 origin 不在允许列表')
    }
    return url
  }

  private recordBlocked(reason: string): void {
    this.blockedCounter += 1
    // Log the origin only (never the full URL; it may contain user inputs).
    this.logger.warn(`[poc-http] blocked outbound target: ${reason}`)
  }

  /**
   * DNS rebinding defence: a target that was allowed *as a DNS name* must not
   * resolve to loopback / private / link-local (cloud metadata) addresses.
   * A literal-IP target is the user's real vulnerability host and is allowed.
   */
  private async assertTargetAddress(url: URL): Promise<void> {
    const host = stripIpv6Brackets(url.hostname)
    if (isIP(host) !== 0) return // literal target IP: allowed by the allowlist
    let addresses: Array<{ address: string; family: number }>
    try {
      addresses = await lookup(host, { all: true, verbatim: true })
    } catch {
      // With an explicit user proxy the target name is resolved by the proxy
      // (internal/Burp-side DNS may not exist locally); without a proxy a local
      // resolution failure simply cannot reach the target, so fail closed.
      if (this.proxy !== null) {
        this.logger.debug('[poc-http] local DNS lookup failed, delegating to configured proxy')
        return
      }
      this.recordBlocked('dns-resolution-failed')
      throw targetBlocked(`无法解析目标域名 ${host}`)
    }
    if (addresses.length === 0) {
      if (this.proxy !== null) return
      this.recordBlocked('dns-empty')
      throw targetBlocked(`目标域名 ${host} 没有解析结果`)
    }
    for (const address of addresses) {
      if (isBlockedResolvedAddress(address.address)) {
        this.recordBlocked('resolved-private-address')
        throw targetBlocked(`目标域名 ${host} 解析到受限地址（回环/私网/云 metadata 拒绝）`)
      }
    }
  }

  /* ------------------------------- transport ------------------------------- */

  private send(options: SendOptions): Promise<HopResponse> {
    if (this.proxy === null) return this.sendDirect(options)
    return options.url.protocol === 'https:'
      ? this.sendViaProxyTunnel(options)
      : this.sendViaProxyAbsoluteForm(options)
  }

  private sendDirect(options: SendOptions): Promise<HopResponse> {
    const isHttps = options.url.protocol === 'https:'
    const hostname = stripIpv6Brackets(options.url.hostname)
    const port = options.url.port === '' ? (isHttps ? 443 : 80) : Number(options.url.port)
    const requestOptions = {
      method: options.method,
      hostname,
      port,
      path: `${options.url.pathname}${options.url.search}`,
      headers: options.headers,
      agent: false,
      ...(isHttps
        ? {
            ca: this.ca ?? undefined,
            rejectUnauthorized: !this.allowInsecureTls
          }
        : {})
    }
    return new Promise<HopResponse>((resolve, reject) => {
      const request = isHttps
        ? httpsRequest(requestOptions, (response) => this.handleResponse(response, options, resolve, reject))
        : httpRequest(requestOptions, (response) => this.handleResponse(response, options, resolve, reject))
      this.wireRequest(request, options, reject)
      this.finishRequest(request, options.body)
    })
  }

  private async sendViaProxyTunnel(options: SendOptions): Promise<HopResponse> {
    const proxy = this.proxy
    if (proxy === null) throw createPocError(POC_ERROR_CODES.INVALID_CONFIG, '未配置代理')
    const targetHost = stripIpv6Brackets(options.url.hostname)
    const targetPort = options.url.port === '' ? 443 : Number(options.url.port)
    const authority = `${options.url.hostname}:${targetPort}`
    const socket = await this.connectTunnel(proxy, authority, options)
    const tlsSocket = await this.upgradeToTls(socket, targetHost, options)
    const requestOptions = {
      method: options.method,
      hostname: targetHost,
      port: targetPort,
      path: `${options.url.pathname}${options.url.search}`,
      headers: options.headers,
      // `createConnection` is only consulted by Node when no agent is supplied;
      // supplying the already-established TLS socket keeps the CONNECT tunnel.
      createConnection: (): TLSSocket => tlsSocket
    }
    return new Promise<HopResponse>((resolve, reject) => {
      const request = httpsRequest(requestOptions, (response) =>
        this.handleResponse(response, options, resolve, reject)
      )
      this.wireRequest(request, options, (error) => {
        tlsSocket.destroy()
        reject(error)
      })
      this.finishRequest(request, options.body)
    })
  }

  private sendViaProxyAbsoluteForm(options: SendOptions): Promise<HopResponse> {
    const proxy = this.proxy
    if (proxy === null) throw createPocError(POC_ERROR_CODES.INVALID_CONFIG, '未配置代理')
    const headers: Record<string, string> = {
      ...options.headers,
      host: options.url.host
    }
    if (proxy.authHeader !== null) headers['proxy-authorization'] = proxy.authHeader
    const absoluteForm = `${options.url.protocol}//${options.url.host}${options.url.pathname}${options.url.search}`
    const requestOptions = {
      method: options.method,
      hostname: proxy.hostname,
      port: proxy.port,
      path: absoluteForm,
      headers,
      agent: false
    }
    return new Promise<HopResponse>((resolve, reject) => {
      const request = httpRequest(requestOptions, (response) =>
        this.handleResponse(response, options, resolve, reject)
      )
      this.wireRequest(request, options, reject)
      this.finishRequest(request, options.body)
    })
  }

  /** CONNECT target:port through the configured HTTP proxy. */
  private connectTunnel(
    proxy: ParsedProxy,
    authority: string,
    options: SendOptions
  ): Promise<import('node:net').Socket> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: authority }
      if (proxy.authHeader !== null) headers['proxy-authorization'] = proxy.authHeader
      const request = httpRequest({
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: authority,
        headers,
        agent: false
      })
      this.activeRequests.add(request)
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        this.activeRequests.delete(request)
        cleanup()
        fn()
      }
      const onAbort = (): void => {
        request.destroy()
        settle(() => reject(abortError()))
      }
      const timer = setTimeout(() => {
        request.destroy()
        settle(() =>
          reject(
            createPocError(
              POC_ERROR_CODES.INVALID_INPUT,
              `代理 CONNECT 超时（>${options.timeoutMs}ms）`
            )
          )
        )
      }, options.timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal.removeEventListener('abort', onAbort)
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
      request.once('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy()
          settle(() =>
            reject(
              createPocError(
                POC_ERROR_CODES.INVALID_INPUT,
                `代理 CONNECT 被拒绝（HTTP ${response.statusCode}）`
              )
            )
          )
          return
        }
        settle(() => resolve(socket))
      })
      request.once('error', (error) => settle(() => reject(error)))
      request.end()
    })
  }

  private upgradeToTls(
    socket: import('node:net').Socket,
    hostname: string,
    options: SendOptions
  ): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const tlsSocket = tlsConnect({
        socket,
        servername: isIP(hostname) === 0 ? hostname : undefined,
        ca: this.ca ?? undefined,
        rejectUnauthorized: !this.allowInsecureTls
      })
      const timer = setTimeout(() => {
        tlsSocket.destroy()
        reject(createPocError(POC_ERROR_CODES.INVALID_INPUT, `代理 TLS 握手超时（>${options.timeoutMs}ms）`))
      }, options.timeoutMs)
      tlsSocket.once('secureConnect', () => {
        clearTimeout(timer)
        resolve(tlsSocket)
      })
      tlsSocket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  /** Attach timeout / abort / size-accounting to one ClientRequest. */
  private wireRequest(request: ClientRequest, options: SendOptions, reject: (error: Error) => void): void {
    this.activeRequests.add(request)
    const onAbort = (): void => {
      request.destroy()
      reject(abortError())
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    request.setTimeout(options.timeoutMs, () => {
      timedOut = true
      request.destroy()
      reject(
        createPocError(
          POC_ERROR_CODES.INVALID_INPUT,
          `请求超时（>${options.timeoutMs}ms）`
        )
      )
    })
    request.once('error', (error: Error) => {
      if (timedOut) return
      reject(error)
    })
    request.once('close', () => {
      this.activeRequests.delete(request)
      options.signal.removeEventListener('abort', onAbort)
    })
  }

  private finishRequest(request: ClientRequest, body: string | undefined): void {
    if (body !== undefined && body !== '') request.end(body)
    else request.end()
  }

  private handleResponse(
    response: IncomingMessage,
    options: SendOptions,
    resolve: (value: HopResponse) => void,
    reject: (error: Error) => void
  ): void {
    const maxBytes = this.limits.maxResponseBytes
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false
    let settled = false
    const headers = sanitizeResponseHeaders(response)
    const settle = (): void => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      response.destroy()
      settle()
      reject(abortError())
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    response.on('data', (chunk: Buffer) => {
      if (settled) return
      const remaining = maxBytes - total
      if (chunk.length >= remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        total = maxBytes
        truncated = true
        settle()
        response.destroy()
        resolve({
          status: response.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
          durationMs: 0,
          truncated: true,
          location: headers['location'] ?? null
        })
        return
      }
      chunks.push(chunk)
      total += chunk.length
    })
    response.on('end', () => {
      if (settled) return
      settle()
      resolve({
        status: response.statusCode ?? 0,
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
        durationMs: 0,
        truncated,
        location: headers['location'] ?? null
      })
    })
    response.on('error', (error: Error) => {
      if (settled) return
      settle()
      reject(error)
    })
  }
}

function redirectMethod(method: PocHttpMethod, status: number): PocHttpMethod {
  if (status === 307 || status === 308) return method
  if (status === 303) return 'GET'
  // 301/302: classic browser behaviour for non-GET/HEAD methods.
  return method === 'HEAD' ? 'HEAD' : 'GET'
}

/** Create a bridge for exactly one sandbox run. */
export function createHttpBridge(options: PocHttpBridgeOptions): PocHttpBridge {
  return new HttpBridge(options)
}
