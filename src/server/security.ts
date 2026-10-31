import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { WEB_BODY_LIMIT_BYTES } from '../shared/web'
import { WebApiError } from './errors'

/**
 * HTTP hardening helpers for the `ctx web` server: security headers, Host /
 * Origin validation (DNS-rebinding and CSRF defence), per-IP rate limiting,
 * bounded JSON body reading and JSON/HTML response writers.
 *
 * Nothing here writes a log line or echoes request headers/body, so tokens and
 * cookies cannot leak through error paths.
 */

/**
 * Strict, same-origin CSP. Inline *styles* are allowed because Tailwind's
 * runtime style attributes need them; scripts stay `'self'` only.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ')

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

/** Apply the security header set to every response (API, static and errors). */
export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
}

/** True for verbs that must pass the Origin / CSRF gate. */
export function isMutatingMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

/** `/api` and `/api/...` (never `/apiary`). */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/** `Host: localhost:8787` -> `localhost`; `[::1]:8787` -> `::1`. */
export function normalizeHostHeader(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(1, end)
  }
  const first = value.indexOf(':')
  const last = value.lastIndexOf(':')
  return first !== -1 && first === last ? value.slice(0, first) : value
}

/**
 * Hostnames the server answers to. DNS rebinding defence: a hostile page can
 * make its own hostname resolve to 127.0.0.1, but it cannot change the `Host`
 * header it sends, so only names this machine actually owns are accepted.
 *
 * `extraHosts` comes from `CTX_WEB_ALLOWED_HOSTS` for operators fronting the
 * port with an internal TLS reverse proxy (opt-in, comma separated).
 */
export function collectAllowedHostnames(
  bindHost: string,
  allowIntranet: boolean,
  extraHosts: readonly string[] = []
): Set<string> {
  const hosts = new Set<string>(['127.0.0.1', 'localhost', '::1'])
  const normalizedBind = bindHost.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (
    normalizedBind.length > 0 &&
    normalizedBind !== '0.0.0.0' &&
    normalizedBind !== '::'
  ) {
    hosts.add(normalizedBind)
  }
  if (allowIntranet) {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) continue
        hosts.add(entry.address.toLowerCase())
      }
    }
  }
  for (const host of extraHosts) {
    const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (normalized.length > 0) hosts.add(normalized)
  }
  return hosts
}

/** Host header check used for every request (HTTP/1.0 without Host is rejected). */
export function isHostHeaderAllowed(
  hostHeader: string | undefined,
  allowedHostnames: ReadonlySet<string>
): boolean {
  if (typeof hostHeader !== 'string' || hostHeader.trim().length === 0) return false
  return allowedHostnames.has(normalizeHostHeader(hostHeader))
}

/** Read one cookie value without decoding (tokens are base64url already). */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (typeof cookieHeader !== 'string') return null
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    const value = part.slice(index + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

export interface RateLimiterOptions {
  windowMs?: number
  maxRequests?: number
}

export interface RateLimiter {
  allow(key: string): boolean
  dispose(): void
}

/**
 * Fixed-window per-client limiter. Deliberately tiny (no dependency) and
 * local-only: the Web UI is a single-user tool, this only blunts runaway loops
 * and casual token guessing.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const windowMs = options.windowMs ?? 10_000
  const maxRequests = options.maxRequests ?? 300
  const buckets = new Map<string, { count: number; resetAt: number }>()
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key)
    }
  }, windowMs)
  if (typeof sweep.unref === 'function') sweep.unref()

  return {
    allow(key: string): boolean {
      const now = Date.now()
      const bucket = buckets.get(key)
      if (bucket === undefined || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs })
        return true
      }
      bucket.count += 1
      return bucket.count <= maxRequests
    },
    dispose(): void {
      clearInterval(sweep)
      buckets.clear()
    }
  }
}

interface BodyReaderState {
  settled: boolean
}

/** Read + JSON-parse a request body, enforcing the 2 MB cap. */
export function readJsonBody(
  req: IncomingMessage,
  limit = WEB_BODY_LIMIT_BYTES
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const state: BodyReaderState = { settled: false }
    const fail = (error: WebApiError): void => {
      if (state.settled) return
      state.settled = true
      reject(error)
    }
    const declared = Number(req.headers['content-length'] ?? '')
    if (Number.isFinite(declared) && declared > limit) {
      fail(new WebApiError(413, 'Request body too large'))
      req.resume()
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        fail(new WebApiError(413, 'Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (state.settled) return
      state.settled = true
      if (size === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        reject(new WebApiError(400, 'Invalid JSON body'))
      }
    })
    req.on('error', (error: unknown) => {
      if (state.settled) return
      state.settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  extraHeaders: Readonly<Record<string, string>> = {}
): void {
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value)
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(html))
  res.setHeader('Cache-Control', 'no-store')
  res.end(html)
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(text))
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

/** `[::1]` for IPv6 literals, plain value otherwise. */
export function formatHostForUrl(host: string): string {
  const trimmed = host.trim()
  const bare = trimmed.replace(/^\[|\]$/g, '')
  return bare.includes(':') ? `[${bare}]` : bare
}

export interface AccessUrls {
  loopbackUrls: string[]
  networkUrls: string[]
  wildcard: boolean
}

/**
 * URLs a human can actually open. A wildcard bind reports loopback plus every
 * non-internal interface address; a specific bind only reports itself.
 */
export function buildAccessUrls(host: string, port: number, allowIntranet: boolean): AccessUrls {
  const normalized = host.trim().toLowerCase()
  const wildcard = normalized === '0.0.0.0' || normalized === '::' || normalized === ''
  const loopbackUrls: string[] = []
  const networkUrls: string[] = []

  if (!wildcard && (normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1')) {
    loopbackUrls.push(`http://${formatHostForUrl(host)}:${port}`)
    return { loopbackUrls, networkUrls, wildcard }
  }
  if (wildcard) {
    loopbackUrls.push(`http://127.0.0.1:${port}`)
    if (!allowIntranet) return { loopbackUrls, networkUrls, wildcard }
    const seen = new Set<string>()
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) continue
        const address = entry.address.toLowerCase()
        // Link-local addresses need a scope id in the URL and are not useful for
        // a printed login link; skip them (they stay accepted as Host headers).
        if (address.startsWith('fe80:') || address.startsWith('169.254.')) continue
        if (seen.has(address)) continue
        seen.add(address)
        networkUrls.push(`http://${formatHostForUrl(address)}:${port}`)
      }
    }
    return { loopbackUrls, networkUrls, wildcard }
  }

  // Specific non-loopback address (e.g. --host 192.168.1.20).
  const specific = `http://${formatHostForUrl(host)}:${port}`
  if (allowIntranet) networkUrls.push(specific)
  else loopbackUrls.push(specific)
  return { loopbackUrls, networkUrls, wildcard }
}
