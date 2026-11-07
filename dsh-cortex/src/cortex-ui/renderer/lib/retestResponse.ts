/**
 * Response formatting helpers for the retest repeater (Yakit/Burp-style JSON
 * view) and the Fuzzer result detail. Kept away from the TSX components so
 * they are unit-testable.
 */

/** Pretty-print JSON bodies; null when the body is not JSON. */
export function prettyJsonBody(body: string, contentType: string): string | null {
  const trimmed = body.trim()
  if (trimmed.length === 0) return null
  if (!/json/i.test(contentType) && !/^[{[]/.test(trimmed)) return null
  if (trimmed.length > 2_000_000) return null
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return null
  }
}

/** Case-insensitive response/request header lookup. */
export function headerValue(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase()
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lower)
  return entry?.[1] ?? ''
}

/** True when a response declares (or visibly contains) HTML. */
export function isHtmlResponse(body: string, headers: Record<string, string>): boolean {
  const contentType = headerValue(headers, 'content-type')
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) return true
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body.slice(0, 300))
}

/** Rendered HTML needs a base URL so relative CSS/images resolve against the target. */
export function buildHtmlPreview(body: string, targetUrl: string): string {
  let base = ''
  try {
    base = `${new URL(targetUrl).origin}/`
  } catch {
    base = ''
  }
  if (base === '') return body
  const tag = `<base href="${base.replace(/"/g, '&quot;')}">`
  if (/<head(?:\s[^>]*)?>/i.test(body)) {
    return body.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${tag}`)
  }
  return `${tag}${body}`
}

/** Tailwind tone for a response status chip. */
export function statusTone(status: number): string {
  if (status >= 500) return 'border-red-300 bg-red-50 text-red-800'
  if (status >= 400) return 'border-amber-300 bg-amber-50 text-amber-900'
  if (status >= 300) return 'border-sky-300 bg-sky-50 text-sky-900'
  return 'border-emerald-300 bg-emerald-50 text-emerald-900'
}

/** True when a response status redirects and carries a Location header. */
export function isRedirectResponse(
  status: number,
  headers: Record<string, string>
): boolean {
  return status >= 300 && status < 400 && headerValue(headers, 'location') !== ''
}
