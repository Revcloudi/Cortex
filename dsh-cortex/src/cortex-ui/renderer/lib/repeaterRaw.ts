/**
 * Raw HTTP request helpers shared by the single Repeater and the Fuzzer.
 *
 * The request editor uses the Burp-style raw form:
 *
 *   POST /api/login HTTP/1.1
 *   Host: target
 *   Content-Type: application/json
 *
 *   {"user":"demo"}
 *
 * Fuzzer injection points are marked inline with paired `§` characters, e.g.
 * `id=§1§`. Nothing in this module talks to the network.
 */

export interface ParsedRawRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * Protocol-level headers copied from a report are re-derived by the outbound
 * request (Host from the URL, length/connection by the HTTP client). Dropping
 * them here keeps raw requests sendable without a validation error.
 */
export const DERIVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'proxy-connection'
])

/** Parse a Burp-like raw request into the typed repeater payload. */
export function parseRawRequest(text: string): ParsedRawRequest {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const requestLine = (lines.shift() ?? '').trim()
  const match = /^([A-Za-z]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/.exec(requestLine)
  if (match === null) throw new Error('请求行必须形如：GET /path HTTP/1.1')
  const headers: Record<string, string> = {}
  let index = 0
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) break
    if (line.trim() === '') {
      index += 1
      break
    }
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error(`请求头不合法：${line}`)
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name !== '') headers[name] = value
  }
  const body = lines.slice(index).join('\n')
  return { method: match[1].toUpperCase(), url: match[2], headers, body }
}

/** Serialize the typed payload back into the raw editor form. */
export function serializeRawRequest(request: {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}): string {
  const lines = [`${request.method.toUpperCase()} ${request.url} HTTP/1.1`]
  for (const [name, value] of Object.entries(request.headers)) lines.push(`${name}: ${value}`)
  const body = request.body ?? ''
  if (body !== '') lines.push('', body)
  return lines.join('\n')
}

/** Copy a header map without the protocol-level headers the Host re-derives. */
export function stripDerivedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !DERIVED_HEADERS.has(name.toLowerCase()))
  )
}
