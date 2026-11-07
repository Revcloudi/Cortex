/**
 * HTTP helpers for the dsh-cortex host half.
 *
 * Responsibilities:
 *  - loopback peer / Host / same-origin write fences (contract §2.4)
 *  - request body reading with a hard 1 MiB cap and JSON parsing
 *  - query-string validation helpers (strict: invalid values are 400)
 *  - JSON / Markdown responses and the shared error envelope
 *
 * No CORS headers are ever emitted. Nothing in this module logs SQL, request
 * bodies, credentials or absolute database paths.
 */

export const MAX_BODY_BYTES = 1024 * 1024

/** Max length for generic query-string values (contract §2.4). */
export const MAX_QUERY_VALUE = 200

/** Max length for the `search` query value (contract §2.4). */
export const MAX_SEARCH_VALUE = 400

/** Hard page-size ceiling (contract §2.3). */
export const MAX_PAGE_SIZE = 100

export const DEFAULT_PAGE_SIZE = 20

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** Error carrying an HTTP status, a stable machine code and optional details. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export const badRequest = (message, details) => new ApiError(400, 'BAD_REQUEST', message, details)
export const forbidden = (code, message, details) => new ApiError(403, code, message, details)
export const notFound = (message = 'not found', details) => new ApiError(404, 'NOT_FOUND', message, details)
export const methodNotAllowed = (message = 'method not allowed') =>
  new ApiError(405, 'METHOD_NOT_ALLOWED', message)
export const schemaIncompatible = (message, details) =>
  new ApiError(409, 'SCHEMA_INCOMPATIBLE', message, details)
export const upstreamError = (message = 'upstream request failed', details) =>
  new ApiError(502, 'UPSTREAM_ERROR', message, details)
export const upstreamTimeout = (message = 'upstream request timed out', details) =>
  new ApiError(502, 'UPSTREAM_TIMEOUT', message, details)

/* ------------------------------------------------------------------------- */
/* Security fences                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Normalize a Host header value to a bare host (no port, no IPv6 brackets).
 * @param {unknown} hostHeader
 * @returns {string}
 */
export function normalizeHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string') return ''
  let host = hostHeader.trim().toLowerCase()
  if (host.length === 0) return ''
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end) : ''
  }
  // Exactly one colon means "host:port" (IPv4 / hostname). Multiple colons is a
  // bare IPv6 literal such as `::1` and carries no port in practice.
  const firstColon = host.indexOf(':')
  if (firstColon >= 0 && firstColon === host.lastIndexOf(':')) host = host.slice(0, firstColon)
  return host
}

/** Strip brackets from an IPv6 hostname so `[::1]` and `::1` compare equal. */
function bareHostname(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
}

/**
 * Loopback peer fence: `req.socket.remoteAddress` must be loopback.
 * @param {import('node:http').IncomingMessage} req
 */
export function assertLoopbackPeer(req) {
  const remote = req && req.socket ? req.socket.remoteAddress : undefined
  if (typeof remote !== 'string' || !LOOPBACK_PEERS.has(remote)) {
    throw forbidden('FORBIDDEN_PEER', 'request peer is not loopback')
  }
}

/**
 * Loopback Host fence: the Host header must address a loopback name.
 * @param {import('node:http').IncomingMessage} req
 */
export function assertLoopbackHost(req) {
  const headers = (req && req.headers) || {}
  const host = normalizeHostHeader(headers.host)
  if (!LOOPBACK_HOSTS.has(host)) {
    throw forbidden('FORBIDDEN_HOST', 'request Host is not loopback')
  }
}

/** True when the given value parses as a loopback origin (http/https). */
export function isLoopbackOrigin(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return LOOPBACK_HOSTS.has(bareHostname(url.hostname))
}

/**
 * Write fence (PATCH/POST): Origin absent or loopback, Sec-Fetch-Site absent /
 * `none` / `same-origin`, and an `application/json` Content-Type.
 * @param {import('node:http').IncomingMessage} req
 */
export function assertSameOriginWrite(req) {
  const headers = (req && req.headers) || {}
  const origin = headers.origin
  if (origin !== undefined && origin !== null && String(origin).trim().length > 0) {
    if (!isLoopbackOrigin(String(origin))) {
      // The DSH page origin is the custom `dsh-app://app` scheme, not a
      // loopback http(s) origin. Its same-origin fetch still carries
      // `Sec-Fetch-Site: same-origin`; trust that rather than the scheme, so
      // UI writes are not rejected while cross-site pages stay blocked.
      const site = String(headers['sec-fetch-site'] || '').trim().toLowerCase()
      if (site !== 'same-origin' && site !== 'none') {
        throw forbidden('FORBIDDEN_ORIGIN', 'write request origin is not allowed')
      }
    }
  }

  const fetchSite = headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== null && String(fetchSite).trim().length > 0) {
    const site = String(fetchSite).trim().toLowerCase()
    if (site !== 'same-origin' && site !== 'none') {
      throw forbidden('FORBIDDEN_ORIGIN', 'cross-site write requests are not allowed', {
        header: 'Sec-Fetch-Site',
      })
    }
  }

  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method === 'PATCH' || method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const contentType = headers['content-type']
    if (typeof contentType !== 'string' || !/^application\/json\b/i.test(contentType.trim())) {
      throw forbidden('FORBIDDEN_CONTENT_TYPE', 'application/json content type is required')
    }
  }
}

/* ------------------------------------------------------------------------- */
/* URL / query parsing                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Parse `req.url` into pathname + search params (never throws to the caller).
 * @param {import('node:http').IncomingMessage} req
 */
export function parseRequestUrl(req) {
  const raw = typeof (req && req.url) === 'string' ? req.url : '/'
  let url
  try {
    url = new URL(raw, 'http://127.0.0.1')
  } catch {
    throw badRequest('invalid request url')
  }
  return { pathname: url.pathname, searchParams: url.searchParams }
}

/** Decode one URL path segment; malformed percent-encoding becomes a 400. */
export function safeDecode(value, label = 'path parameter') {
  try {
    return decodeURIComponent(String(value))
  } catch {
    throw badRequest(`invalid ${label}`)
  }
}

/**
 * Read an optional string query value with a strict length cap.
 * Empty values are treated as absent (clients commonly send `?x=`).
 * @returns {string|undefined}
 */
export function queryString(searchParams, name, { max = MAX_QUERY_VALUE, fallback } = {}) {
  if (!searchParams || !searchParams.has(name)) return fallback
  const raw = searchParams.get(name)
  if (raw === null) return fallback
  if (raw.length > max) throw badRequest(`${name} is too long`, { param: name, max })
  return raw.length === 0 ? fallback : raw
}

/**
 * Optional enum query value.
 * @returns {string|undefined}
 */
export function queryEnum(searchParams, name, allowed) {
  const value = queryString(searchParams, name)
  if (value === undefined) return undefined
  if (!allowed.includes(value)) {
    throw badRequest(`${name} must be one of ${allowed.join(', ')}`, { param: name, allowed })
  }
  return value
}

/**
 * Optional positive integer query value with inclusive bounds.
 * @returns {number|undefined}
 */
export function queryInt(searchParams, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = queryString(searchParams, name)
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw badRequest(`${name} must be an integer`, { param: name })
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${name} must be between ${min} and ${max}`, { param: name, min, max })
  }
  return parsed
}

/**
 * Optional `0|1` boolean query value.
 * @returns {boolean|undefined}
 */
export function queryBool01(searchParams, name) {
  const value = queryString(searchParams, name)
  if (value === undefined) return undefined
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw badRequest(`${name} must be 0 or 1`, { param: name, allowed: ['0', '1'] })
}

/* ------------------------------------------------------------------------- */
/* Request body                                                              */
/* ------------------------------------------------------------------------- */

function drainAndDiscard(req) {
  try {
    req.resume()
  } catch {
    /* nothing to drain */
  }
}

/**
 * Read and parse a JSON object request body. Enforces the 1 MiB cap.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const headers = (req && req.headers) || {}
    const contentType = headers['content-type']
    if (typeof contentType !== 'string' || !/^application\/json\b/i.test(contentType.trim())) {
      drainAndDiscard(req)
      reject(forbidden('FORBIDDEN_CONTENT_TYPE', 'application/json content type is required'))
      return
    }

    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let settled = false

    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
    }

    const finish = (err, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve(value)
    }

    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        finish(badRequest('request body is too large', { maxBytes: MAX_BODY_BYTES }))
        drainAndDiscard(req)
        return
      }
      chunks.push(buffer)
    }

    const onEnd = () => {
      if (settled) return
      if (size === 0) {
        finish(badRequest('request body is required'))
        return
      }
      const text = Buffer.concat(chunks).toString('utf8')
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        finish(badRequest('request body is not valid JSON'))
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish(badRequest('request body must be a JSON object'))
        return
      }
      finish(null, parsed)
    }

    const onError = () => finish(badRequest('failed to read the request body'))
    const onAborted = () => finish(badRequest('request body was aborted'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/**
 * Require a non-empty string body field.
 * @param {Record<string, unknown>} body
 * @param {string} name
 * @param {{max:number, allowEmpty?:boolean}} options
 */
export function requireBodyString(body, name, { max, allowEmpty = false }) {
  const value = body[name]
  if (typeof value !== 'string') {
    throw badRequest(`${name} must be a string`, { field: name })
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw badRequest(`${name} must not be empty`, { field: name })
  }
  if (value.length > max) {
    throw badRequest(`${name} is too long`, { field: name, max })
  }
  return value
}

/**
 * Require an enum string body field.
 * @param {Record<string, unknown>} body
 * @param {string} name
 * @param {string[]} allowed
 */
export function requireBodyEnum(body, name, allowed) {
  const value = body[name]
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw badRequest(`${name} must be one of ${allowed.join(', ')}`, {
      field: name,
      allowed,
    })
  }
  return value
}

/* ------------------------------------------------------------------------- */
/* Responses                                                                 */
/* ------------------------------------------------------------------------- */

function canWrite(res) {
  return Boolean(res) && !res.writableEnded && !res.headersSent
}

/** Send a JSON response (`application/json; charset=utf-8`, `no-store`). */
export function sendJson(res, status, payload) {
  if (!canWrite(res)) return
  const body = JSON.stringify(payload === undefined ? null : payload)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(body)
  } catch {
    try {
      if (!res.writableEnded) res.end()
    } catch {
      /* response is gone */
    }
  }
}

/** Sanitize a filename for a Content-Disposition header (ASCII-only). */
export function sanitizeFilename(name, fallback = 'report.md') {
  const base = String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return base.length > 0 ? base : fallback
}

/** Send a Markdown attachment response (report download). */
export function sendMarkdown(res, status, text, filename = 'report.md') {
  if (!canWrite(res)) return
  const safeName = sanitizeFilename(filename)
  try {
    res.writeHead(status, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': Buffer.byteLength(text),
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(text)
  } catch {
    try {
      if (!res.writableEnded) res.end()
    } catch {
      /* response is gone */
    }
  }
}

/** Map any thrown value onto the contract error envelope. */
export function describeError(err) {
  if (err instanceof ApiError) {
    const body = { error: err.message || 'request failed', code: err.code }
    if (err.details !== undefined) body.details = err.details
    return { status: err.status, body }
  }
  // SQLite write on a read-only connection/file: surface as READ_ONLY.
  if (err && Number(err.errcode) === 8) {
    return { status: 403, body: { error: 'database is read-only', code: 'READ_ONLY' } }
  }
  return { status: 500, body: { error: 'internal error', code: 'INTERNAL' } }
}

/** Log only a coarse error class — never SQL, bodies, credentials or paths. */
function logInternalError(err) {
  try {
    let kind = 'internal'
    if (err && Number.isInteger(Number(err.errcode))) kind = `sqlite:${Number(err.errcode)}`
    else if (err && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)) kind = err.code
    console.error(`[dsh-cortex] request failed (${kind})`)
  } catch {
    /* logging must never throw */
  }
}

/** Send an error response using the shared envelope. */
export function sendError(res, err) {
  const described = describeError(err)
  if (described.status >= 500) logInternalError(err)
  sendJson(res, described.status, described.body)
}
