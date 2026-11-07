/**
 * SSRF-safe outbound HTTP for POST /retest/send (contract §2.5).
 *
 * Safety properties:
 *  - origin allowlist derived only from the vulnerability + its asset
 *    (`target_url` origin, `host` asset origins, `service_host` origin)
 *  - http(s) only; URLs with userinfo rejected; cloud metadata addresses rejected
 *  - redirects disabled by default; when enabled at most 5 hops, each hop
 *    re-validated against the allowlist
 *  - 15 s timeout per hop, 2 MiB response cap (truncated flag), 256 KiB request body
 *  - request headers/bodies are never logged
 */

import {
  ApiError,
  badRequest,
  upstreamError,
  upstreamTimeout,
} from './http.js'

export const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

export const MAX_REDIRECTS = 5
export const TIMEOUT_MS = 15000
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_SEND_BODY_BYTES = 256 * 1024
export const MAX_HEADERS = 100
export const MAX_HEADER_VALUE = 8000

/** Headers a retest caller may never set (they are protocol-level). */
const FORBIDDEN_HEADERS = new Set([
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'proxy-connection',
])

/**
 * Headers that are silently ignored instead of rejected: `Host` is derived
 * from the already-validated request URL, so a raw request copied from a report
 * (`Host: target`) must not fail validation. Letting callers override Host
 * would allow vhost tricks outside the origin allowlist.
 */
const IGNORED_HEADERS = new Set(['host'])

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Build the ordered/uniqued list of allowed origins for one vulnerability. */
function originCandidates(value, out) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      if (url.protocol === 'http:' || url.protocol === 'https:') out.add(url.origin)
    } catch {
      /* ignore unparsable value */
    }
    return
  }
  // Schemeless host[:port] (Cortex stores `host` / `service_host` verbatim).
  const hostPart = text.split(/[/?#]/)[0]
  if (hostPart.length === 0) return
  for (const scheme of ['http', 'https']) {
    try {
      out.add(new URL(`${scheme}://${hostPart}`).origin)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Allowed origin set for a retest target.
 * @param {{vuln: Record<string, any>, assets?: {host_port?: string, host?: string}[]}} context
 * @returns {string[]}
 */
export function collectAllowedOrigins(context) {
  const out = new Set()
  const vuln = (context && context.vuln) || {}
  originCandidates(vuln.target_url, out)
  originCandidates(vuln.host, out)
  originCandidates(vuln.service_host, out)
  for (const asset of (context && context.assets) || []) {
    originCandidates(asset.host_port, out)
    originCandidates(asset.host, out)
  }
  return [...out].sort()
}

/** True when a hostname points at a cloud metadata / link-local address. */
export function isMetadataHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
  if (host.length === 0) return false
  if (
    host === 'metadata' ||
    host === 'instance-data' ||
    host === 'metadata.google.internal' ||
    host === 'fd00:ec2::254' ||
    host === '::ffff:169.254.169.254' ||
    host === '100.100.100.200' ||
    host === '169.254.169.254' ||
    host === '169.254.170.2'
  ) {
    return true
  }
  // Link-local IPv4 range (cloud metadata services live in 169.254.0.0/16).
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

/** Validate an outbound URL against the allowlist; throws ApiError. */
export function assertUrlAllowed(rawUrl, allowedOrigins) {
  let url
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))
  } catch {
    throw badRequest('url must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'only http(s) urls are allowed', {
      allowed: allowedOrigins,
    })
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw badRequest('url must not contain userinfo')
  }
  if (isMetadataHost(url.hostname)) {
    throw badRequest('metadata addresses are not allowed')
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'url origin is not allowed', {
      allowed: allowedOrigins,
    })
  }
  return url
}

/** Validate/normalize the request headers object from the caller. */
export function normalizeHeaders(headers) {
  if (headers === null || headers === undefined) return {}
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw badRequest('headers must be an object')
  }
  const entries = Object.entries(headers)
  if (entries.length > MAX_HEADERS) throw badRequest(`at most ${MAX_HEADERS} headers are allowed`)
  /** @type {Record<string,string>} */
  const out = {}
  for (const [name, value] of entries) {
    if (typeof value !== 'string') throw badRequest(`header ${name} must be a string value`)
    if (!HEADER_NAME_RE.test(name)) throw badRequest('invalid header name')
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw badRequest(`header ${name} is not allowed`)
    }
    if (IGNORED_HEADERS.has(name.toLowerCase())) continue
    if (/[\r\n]/.test(value)) throw badRequest(`header ${name} has an invalid value`)
    if (value.length > MAX_HEADER_VALUE) throw badRequest(`header ${name} is too long`)
    out[name] = value
  }
  return out
}

/**
 * Validate the POST /retest/send request body.
 * @param {Record<string, unknown>} body
 */
export function validateSendRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object')
  }
  const vulnId = body.vulnId
  if (typeof vulnId !== 'string' || vulnId.trim().length === 0 || vulnId.length > 200) {
    throw badRequest('vulnId is required', { field: 'vulnId' })
  }
  const method = body.method
  if (typeof method !== 'string' || !ALLOWED_METHODS.includes(method)) {
    throw badRequest('method must be an uppercase HTTP method', { field: 'method' })
  }
  const rawUrl = body.url
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0 || rawUrl.length > 8000) {
    throw badRequest('url is required', { field: 'url' })
  }
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw badRequest('url must be an absolute http(s) URL', { field: 'url' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('url must use http or https', { field: 'url' })
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw badRequest('url must not contain userinfo', { field: 'url' })
  }
  if (isMetadataHost(url.hostname)) {
    throw badRequest('metadata addresses are not allowed', { field: 'url' })
  }
  const headers = normalizeHeaders(body.headers)
  const followRedirects = body.followRedirects === undefined ? false : body.followRedirects
  if (typeof followRedirects !== 'boolean') {
    throw badRequest('followRedirects must be a boolean', { field: 'followRedirects' })
  }
  let payload
  if (body.body !== undefined && body.body !== null) {
    if (typeof body.body !== 'string') throw badRequest('body must be a string', { field: 'body' })
    if (Buffer.byteLength(body.body, 'utf8') > MAX_SEND_BODY_BYTES) {
      throw badRequest('body is too large', { field: 'body', maxBytes: MAX_SEND_BODY_BYTES })
    }
    if (body.body.length > 0) {
      if (method === 'GET' || method === 'HEAD') {
        throw badRequest('request body is not allowed for GET/HEAD', { field: 'body' })
      }
      payload = body.body
    }
  }
  return { vulnId, method, url, headers, body: payload, followRedirects }
}

function headersToObject(headers) {
  /** @type {Record<string,string>} */
  const out = {}
  if (!headers) return out
  try {
    for (const [name, value] of headers.entries()) out[name] = value
  } catch {
    /* ignore malformed headers */
  }
  return out
}

function mapFetchError(err) {
  if (err instanceof ApiError) return err
  const name = err && typeof err.name === 'string' ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return upstreamTimeout('upstream request timed out', { timeoutMs: TIMEOUT_MS })
  }
  const cause = err && err.cause && typeof err.cause.code === 'string' ? err.cause.code : undefined
  return upstreamError('upstream request failed', cause ? { cause } : undefined)
}

/** @param {Response} response */
async function readBodyCapped(response) {
  const contentType = (response.headers && response.headers.get('content-type')) || ''
  if (!response.body) {
    return { body: '', bodyBytes: 0, bodyTruncated: false, contentType }
  }
  const reader = response.body.getReader()
  /** @type {Uint8Array[]} */
  const chunks = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (total + value.byteLength > MAX_RESPONSE_BYTES) {
        const keep = MAX_RESPONSE_BYTES - total
        if (keep > 0) chunks.push(value.subarray(0, keep))
        total = MAX_RESPONSE_BYTES
        truncated = true
        try {
          await reader.cancel()
        } catch {
          /* stream already closed */
        }
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch (err) {
    if (!truncated) throw mapFetchError(err)
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  return {
    body: buffer.toString('utf8'),
    bodyBytes: buffer.byteLength,
    bodyTruncated: truncated,
    contentType,
  }
}

async function discardBody(response) {
  try {
    if (response && response.body) await response.body.cancel()
  } catch {
    /* already consumed/cancelled */
  }
}

async function doFetch(fetchImpl, url, init) {
  try {
    return await fetchImpl(url.href, init)
  } catch (err) {
    throw mapFetchError(err)
  }
}

/**
 * Execute the outbound request and return the contract result object.
 * @param {{request: ReturnType<typeof validateSendRequest>, context: {vuln: Record<string, any>, assets?: any[]}}} args
 * @param {{fetchImpl?: Function, now?: () => number}} [options]
 */
export async function sendRetest({ request, context }, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const now = options.now || (() => Date.now())
  const allowedOrigins = collectAllowedOrigins(context)
  /** @type {URL} */
  let currentUrl = assertUrlAllowed(request.url, allowedOrigins)

  let method = request.method
  let payload = request.body
  /** @type {{url:string,status:number,location:string}[]} */
  const redirects = []
  const startedAt = now()
  /** @type {Response|null} */
  let response = null

  for (;;) {
    const init = {
      method,
      headers: request.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
    if (payload !== undefined && method !== 'GET' && method !== 'HEAD') init.body = payload

    response = await doFetch(fetchImpl, currentUrl, init)

    const location = (response.headers && response.headers.get('location')) || null
    if (REDIRECT_STATUSES.has(response.status) && location && request.followRedirects) {
      if (redirects.length >= MAX_REDIRECTS) break
      let nextUrl
      try {
        nextUrl = new URL(location, currentUrl)
      } catch {
        throw upstreamError('upstream returned an invalid redirect location')
      }
      assertUrlAllowed(nextUrl, allowedOrigins)
      redirects.push({ url: currentUrl.href, status: response.status, location })
      await discardBody(response)
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        if (method !== 'HEAD') method = 'GET'
        payload = undefined
      }
      currentUrl = nextUrl
      continue
    }
    break
  }

  const bodyInfo = await readBodyCapped(response)
  const durationMs = Math.max(0, now() - startedAt)

  return {
    status: response.status,
    statusText: response.statusText || '',
    url: request.url,
    finalUrl: currentUrl.href,
    headers: headersToObject(response.headers),
    body: bodyInfo.body,
    bodyBytes: bodyInfo.bodyBytes,
    bodyTruncated: bodyInfo.bodyTruncated,
    contentType: bodyInfo.contentType,
    durationMs,
    redirects,
  }
}
