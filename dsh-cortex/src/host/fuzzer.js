/**
 * Independent outbound HTTP for the standalone Web Fuzzer
 * (`POST /cortex-api/cortex/repeater/send`).
 *
 * Unlike `src/host/retest.js`, this path is NOT tied to a vulnerability row and
 * has no vulnerability-origin allowlist: any public http(s) target is allowed.
 * Requests therefore never need a `vulnId` (the optional value is only carried
 * as history metadata by the caller).
 *
 * Safety properties (SSRF policy):
 *  - http(s) only; URLs with userinfo rejected
 *  - localhost / loopback / private / link-local / multicast / reserved IPv4
 *    and IPv6 targets and cloud metadata endpoints are rejected
 *  - the decision is made on literals before any socket is opened; hostnames
 *    are resolved with dns.promises.lookup({all:true}) and rejected when ANY
 *    resolved address is non-public (resolver injectable for tests)
 *  - every redirect hop revalidates the same policy; at most 5 redirects
 *  - 15 s timeout per hop, 2 MiB response cap (truncated flag), 256 KiB request
 *    body, <= 100 headers, protocol-level headers forbidden, `Host` ignored,
 *    CR/LF injection rejected
 *  - request headers/bodies are never logged
 *
 * Error contract: malformed input is 400 BAD_REQUEST, a rejected target is
 * 403 TARGET_NOT_ALLOWED with a stable `details.reason`, and resolver/upstream
 * failures are 502 UPSTREAM_ERROR (timeouts: 502 UPSTREAM_TIMEOUT).
 */

import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'
import { ApiError, badRequest, upstreamError, upstreamTimeout } from './http.js'

export const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

export const MAX_REDIRECTS = 5
export const TIMEOUT_MS = 15000
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_SEND_BODY_BYTES = 256 * 1024
export const MAX_HEADERS = 100
export const MAX_HEADER_VALUE = 8000
export const MAX_URL_LENGTH = 8000
export const MAX_VULN_ID_LENGTH = 200

/**
 * Stable `details.reason` values for a 403 TARGET_NOT_ALLOWED. Keep these
 * strings stable: the tests and the UI may branch on them.
 */
export const TARGET_REASONS = Object.freeze({
  PROTOCOL: 'protocol',
  USERINFO: 'userinfo',
  LOOPBACK: 'loopback',
  PRIVATE: 'private',
  LINK_LOCAL: 'link-local',
  MULTICAST: 'multicast',
  RESERVED: 'reserved',
  METADATA: 'metadata',
  INVALID_HOST: 'invalid-host',
})

/** Headers a fuzzer caller may never set (protocol-level, derived by fetch). */
const FORBIDDEN_HEADERS = new Set([
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'proxy-connection',
])

/**
 * `Host` is derived from the already-validated request URL. A raw request pasted
 * from a report carries its own `Host` line; ignoring it keeps the URL
 * authoritative without rejecting an otherwise valid raw request.
 */
const IGNORED_HEADERS = new Set(['host'])

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Well-known cloud metadata endpoints. Matched before the generic range rules
 * so the stable reason is `metadata`, not `link-local` / `private`.
 */
const METADATA_IPS = new Set([
  '169.254.169.254', // AWS / GCP / Azure / Oracle IMDS
  '169.254.170.2', // AWS ECS task metadata
  '169.254.0.23', // Tencent Cloud metadata
  '100.100.100.200', // Alibaba Cloud metadata
  '::ffff:169.254.169.254',
  '::ffff:100.100.100.200',
  'fd00:ec2::254', // AWS IMDS over IPv6
])

/**
 * Hostnames that point at loopback or a cloud metadata service. Static names
 * are rejected without a DNS query so a metadata probe never leaves the host.
 */
const FORBIDDEN_HOSTNAMES = new Map([
  ['localhost', TARGET_REASONS.LOOPBACK],
  ['localhost.localdomain', TARGET_REASONS.LOOPBACK],
  ['ip6-localhost', TARGET_REASONS.LOOPBACK],
  ['ip6-loopback', TARGET_REASONS.LOOPBACK],
  ['metadata', TARGET_REASONS.METADATA],
  ['metadata.google.internal', TARGET_REASONS.METADATA],
  ['metadata.goog', TARGET_REASONS.METADATA],
  ['metadata.azure.internal', TARGET_REASONS.METADATA],
  ['instance-data', TARGET_REASONS.METADATA],
  ['instance-data.ec2.internal', TARGET_REASONS.METADATA],
])

/* ------------------------------------------------------------------------- */
/* Address classification                                                    */
/* ------------------------------------------------------------------------- */

/** Strip IPv6 brackets / a trailing dot and lower-case a hostname for checks. */
function normalizeHostname(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '')
}

/** @param {string} address */
function ipv4Reason(address) {
  if (METADATA_IPS.has(address)) return TARGET_REASONS.METADATA
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return 'invalid-address'
  }
  const [a, b, c] = parts
  if (a === 0) return TARGET_REASONS.RESERVED // 0.0.0.0/8 "this network"
  if (a === 10) return TARGET_REASONS.PRIVATE // RFC 1918
  if (a === 127) return TARGET_REASONS.LOOPBACK // 127.0.0.0/8
  if (a === 169 && b === 254) return TARGET_REASONS.LINK_LOCAL // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return TARGET_REASONS.PRIVATE // RFC 1918
  if (a === 192 && b === 168) return TARGET_REASONS.PRIVATE // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return TARGET_REASONS.PRIVATE // RFC 6598 CGNAT
  if (a === 192 && b === 0 && c === 0) return TARGET_REASONS.RESERVED // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return TARGET_REASONS.RESERVED // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return TARGET_REASONS.RESERVED // benchmarking
  if (a === 198 && b === 51 && c === 100) return TARGET_REASONS.RESERVED // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return TARGET_REASONS.RESERVED // TEST-NET-3
  if (a >= 224 && a <= 239) return TARGET_REASONS.MULTICAST // 224.0.0.0/4
  if (a >= 240) return TARGET_REASONS.RESERVED // 240.0.0.0/4 + broadcast
  return null
}

/**
 * Parse one IPv6 literal into eight 16-bit groups (null when malformed).
 * Supports `::` compression and a trailing dotted-quad IPv4 part.
 * @param {string} text
 * @returns {number[]|null}
 */
function parseIpv6(text) {
  let source = String(text || '').toLowerCase()
  if (source.startsWith('[') && source.endsWith(']')) source = source.slice(1, -1)
  if (source.length === 0 || source.includes('%')) return null
  const pieces = source.split('::')
  if (pieces.length > 2) return null
  const left = tokensToHextets(pieces[0] === '' ? [] : pieces[0].split(':'))
  const right = tokensToHextets(pieces.length === 2 && pieces[1] !== '' ? pieces[1].split(':') : [])
  if (left === null || right === null) return null
  if (pieces.length === 1) return left.length === 8 ? left : null
  const zeroGroups = 8 - left.length - right.length
  if (zeroGroups < 1) return null
  return [...left, ...new Array(zeroGroups).fill(0), ...right]
}

/** @param {string[]} tokens @returns {number[]|null} */
function tokensToHextets(tokens) {
  /** @type {number[]} */
  const out = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.length === 0) return null
    if (token.includes('.')) {
      if (index !== tokens.length - 1) return null
      const octets = token.split('.').map(Number)
      if (
        octets.length !== 4 ||
        octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
      ) {
        return null
      }
      out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(token)) return null
    out.push(parseInt(token, 16))
  }
  return out
}

/** @param {number[]} groups @returns {string} */
function groupsToIpv4(groups) {
  const bytes = [
    (groups[0] >> 8) & 0xff,
    groups[0] & 0xff,
    (groups[1] >> 8) & 0xff,
    groups[1] & 0xff,
  ]
  return bytes.join('.')
}

/** @param {string} address */
function ipv6Reason(address) {
  if (METADATA_IPS.has(address)) return TARGET_REASONS.METADATA
  const groups = parseIpv6(address)
  if (!groups) return 'invalid-address'
  const leadingZero = (count) => groups.slice(0, count).every((group) => group === 0)

  if (groups.every((group) => group === 0)) return TARGET_REASONS.RESERVED // ::
  if (leadingZero(7) && groups[7] === 1) return TARGET_REASONS.LOOPBACK // ::1
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (leadingZero(5) && groups[5] === 0xffff) {
    return ipv4Reason(groupsToIpv4(groups.slice(6)))
  }
  // ::a.b.c.d (deprecated IPv4-compatible, other than ::/::1)
  if (leadingZero(6)) return ipv4Reason(groupsToIpv4(groups.slice(6)))
  // 64:ff9b::/96 (well-known NAT64 prefix) wraps an IPv4 target.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return ipv4Reason(groupsToIpv4(groups.slice(6)))
  }
  if (groups[0] === 0xfd00 && groups[1] === 0x0ec2) return TARGET_REASONS.METADATA // AWS IMDS IPv6
  if ((groups[0] & 0xfe00) === 0xfc00) return TARGET_REASONS.PRIVATE // fc00::/7 ULA
  if ((groups[0] & 0xffc0) === 0xfec0) return TARGET_REASONS.PRIVATE // fec0::/10 site-local
  if ((groups[0] & 0xffc0) === 0xfe80) return TARGET_REASONS.LINK_LOCAL // fe80::/10
  if ((groups[0] & 0xff00) === 0xff00) return TARGET_REASONS.MULTICAST // ff00::/8
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return TARGET_REASONS.RESERVED // doc
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return TARGET_REASONS.RESERVED // Teredo
  if (groups[0] === 0x2002) return TARGET_REASONS.RESERVED // 6to4
  if (groups[0] === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) {
    return TARGET_REASONS.RESERVED // 100::/64 discard-only
  }
  if (groups[0] === 0x2001 && (groups[1] & 0xfff0) === 0x0010) {
    return TARGET_REASONS.RESERVED // ORCHID
  }
  if (groups[0] === 0x2001 && (groups[1] & 0xfff0) === 0x0020) {
    return TARGET_REASONS.RESERVED // ORCHIDv2
  }
  return null
}

/**
 * Classify one IP address. Returns a stable TARGET_REASONS value when the
 * address is not a publicly routable unicast target, or `null` when it is safe.
 * Pure and synchronous; exported for tests / documentation.
 * @param {string} address
 * @returns {string|null}
 */
export function classifyAddress(address) {
  const text = normalizeHostname(address)
  if (text.length === 0) return 'invalid-address'
  const version = isIP(text)
  if (version === 4) return ipv4Reason(text)
  if (version === 6) return ipv6Reason(text)
  return 'invalid-address'
}

/**
 * Synchronous part of the target policy: scheme, userinfo and literal/static
 * hostname checks. Returns a stable reason, or `null` when the URL is either a
 * public IP literal or a hostname that still needs DNS resolution.
 * @param {URL|string} rawUrl
 * @returns {string|null}
 */
export function staticTargetReason(rawUrl) {
  const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return TARGET_REASONS.PROTOCOL
  if (url.username.length > 0 || url.password.length > 0) return TARGET_REASONS.USERINFO
  const hostname = normalizeHostname(url.hostname)
  if (hostname.length === 0) return TARGET_REASONS.INVALID_HOST
  const forbidden = FORBIDDEN_HOSTNAMES.get(hostname)
  if (forbidden) return forbidden
  if (hostname.endsWith('.localhost')) return TARGET_REASONS.LOOPBACK
  if (isIP(hostname) !== 0) return classifyAddress(hostname)
  return null
}

/** True when the hostname is an IPv4/IPv6 literal (no DNS needed). */
function isIpLiteral(hostname) {
  return isIP(normalizeHostname(hostname)) !== 0
}

/** Build the stable 403 error for a rejected target. */
function targetNotAllowed(reason, host, address) {
  /** @type {{reason: string, host?: string, address?: string}} */
  const details = { reason }
  if (typeof host === 'string' && host.length > 0) details.host = host.slice(0, 300)
  if (typeof address === 'string' && address.length > 0) details.address = address.slice(0, 100)
  return new ApiError(403, 'TARGET_NOT_ALLOWED', 'target address is not allowed', details)
}

/** Keep a resolver error code (never a stack / message) in the 502 details. */
function dnsErrorDetails(err) {
  const code = err && typeof err.code === 'string' && /^[A-Z0-9_]+$/.test(err.code) ? err.code : undefined
  return code ? { cause: code } : undefined
}

/** Default resolver: every A/AAAA answer, never just the first. */
function defaultResolveHost(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true })
}

/**
 * Enforce the public-target policy for one URL. For hostnames the resolver is
 * consulted and ANY non-public answer rejects the request (fail closed).
 * @param {URL|string} rawUrl
 * @param {{resolveHost?: (hostname: string) => Promise<any>}} [options]
 * @returns {Promise<URL>}
 */
export async function assertTargetAllowed(rawUrl, options = {}) {
  let url
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))
  } catch {
    throw badRequest('url must be an absolute http(s) URL', { field: 'url' })
  }
  const reason = staticTargetReason(url)
  if (reason) throw targetNotAllowed(reason, url.hostname)
  const hostname = normalizeHostname(url.hostname)
  if (isIpLiteral(hostname)) return url

  const resolveHost = typeof options.resolveHost === 'function' ? options.resolveHost : defaultResolveHost
  let resolved
  try {
    resolved = await resolveHost(hostname)
  } catch (err) {
    throw upstreamError('failed to resolve target host', dnsErrorDetails(err))
  }
  const records = Array.isArray(resolved) ? resolved : resolved ? [resolved] : []
  if (records.length === 0) {
    throw upstreamError('target host did not resolve', { host: hostname })
  }
  for (const record of records) {
    const address =
      typeof record === 'string'
        ? record
        : record && typeof record.address === 'string'
          ? record.address
          : ''
    const bareAddress = normalizeHostname(address)
    if (isIP(bareAddress) === 0) {
      throw upstreamError('target resolution returned an invalid address', { host: hostname })
    }
    const addressReason = classifyAddress(bareAddress)
    if (addressReason) throw targetNotAllowed(addressReason, hostname, bareAddress)
  }
  return url
}

/* ------------------------------------------------------------------------- */
/* Request validation                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Validate/normalize the request headers object from the caller. 400 on any
 * malformed name/value, protocol header or CR/LF injection; `Host` is ignored.
 * @param {unknown} headers
 * @returns {Record<string,string>}
 */
export function normalizeFuzzerHeaders(headers) {
  if (headers === null || headers === undefined) return {}
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw badRequest('headers must be an object', { field: 'headers' })
  }
  const entries = Object.entries(headers)
  if (entries.length > MAX_HEADERS) {
    throw badRequest(`at most ${MAX_HEADERS} headers are allowed`, { field: 'headers' })
  }
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
 * Validate the standalone fuzzer send body:
 * `{method, url, headers?, body?, followRedirects?, vulnId?}`.
 *
 * `vulnId` is optional history metadata only — it is never used to look up a
 * vulnerability or to derive the target policy.
 * @param {Record<string, unknown>} body
 */
export function validateFuzzerRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object')
  }

  let vulnId
  if (body.vulnId !== undefined && body.vulnId !== null) {
    if (typeof body.vulnId !== 'string') throw badRequest('vulnId must be a string', { field: 'vulnId' })
    if (body.vulnId.length > MAX_VULN_ID_LENGTH) {
      throw badRequest('vulnId is too long', { field: 'vulnId', max: MAX_VULN_ID_LENGTH })
    }
    const trimmed = body.vulnId.trim()
    if (trimmed.length > 0) vulnId = trimmed
  }

  const method = body.method
  if (typeof method !== 'string' || !ALLOWED_METHODS.includes(method)) {
    throw badRequest('method must be an uppercase HTTP method', { field: 'method' })
  }

  const rawUrl = body.url
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    throw badRequest('url is required', { field: 'url' })
  }
  let url
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw badRequest('url must be an absolute http(s) URL', { field: 'url' })
  }

  const headers = normalizeFuzzerHeaders(body.headers)
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

/* ------------------------------------------------------------------------- */
/* Send                                                                      */
/* ------------------------------------------------------------------------- */

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

function mapFetchError(err, timeoutMs = TIMEOUT_MS) {
  if (err instanceof ApiError) return err
  const name = err && typeof err.name === 'string' ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return upstreamTimeout('upstream request timed out', { timeoutMs })
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

async function doFetch(fetchImpl, url, init, timeoutMs) {
  try {
    return await fetchImpl(url.href, init)
  } catch (err) {
    throw mapFetchError(err, timeoutMs)
  }
}

/**
 * Execute the standalone fuzzer request and return an internal result object
 * (the route maps it onto the unchanged public `RepeaterSendResult` shape).
 *
 * @param {{request: ReturnType<typeof validateFuzzerRequest>}} args
 * @param {{fetchImpl?: Function,
 *          resolveHost?: (hostname: string) => Promise<any>,
 *          now?: () => number,
 *          timeoutMs?: number}} [options]
 */
export async function sendFuzzerRequest({ request }, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw upstreamError('outbound fetch is not available')
  }
  const resolveHost = options.resolveHost || defaultResolveHost
  const now = options.now || (() => Date.now())
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : TIMEOUT_MS

  let currentUrl
  try {
    currentUrl = request.url instanceof URL ? request.url : new URL(String(request.url))
  } catch {
    throw badRequest('url must be an absolute http(s) URL', { field: 'url' })
  }
  // The request was validated before it got here; re-check anyway so callers
  // that build the object by hand cannot skip the target policy.
  await assertTargetAllowed(currentUrl, { resolveHost })

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
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (payload !== undefined && method !== 'GET' && method !== 'HEAD') init.body = payload

    response = await doFetch(fetchImpl, currentUrl, init, timeoutMs)

    const location = (response.headers && response.headers.get('location')) || null
    if (REDIRECT_STATUSES.has(response.status) && location && request.followRedirects) {
      if (redirects.length >= MAX_REDIRECTS) break
      let nextUrl
      try {
        nextUrl = new URL(location, currentUrl)
      } catch {
        throw upstreamError('upstream returned an invalid redirect location')
      }
      // Every hop gets the exact same public-target policy, including DNS.
      await assertTargetAllowed(nextUrl, { resolveHost })
      redirects.push({ url: currentUrl.href, status: response.status, location })
      await discardBody(response)
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
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
