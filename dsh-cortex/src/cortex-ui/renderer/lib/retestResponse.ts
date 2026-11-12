/**
 * Response formatting helpers shared by the manual Repeater and the standalone
 * Web Fuzzer: the raw/JSON text blocks, the status/header line and the hardened
 * HTML preview used by the 渲染 tab.
 *
 * Kept away from the TSX components so they are unit-testable. Nothing in this
 * module performs network requests: the HTML preview is built as an inert
 * string that the caller assigns to a `sandbox=""` iframe `srcDoc`.
 */

/**
 * Hardened CSP for the rendered-HTML iframe. It is injected as the first meta
 * of the preview document and is defense in depth on top of `sandbox=""`:
 * no scripts, no remote fetches, only inline styles, data: images/fonts, and
 * neither <base> nor form submissions are allowed to escape the sandbox.
 */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"

/** Readability-only styles; assets still cannot load because of the CSP. */
const HTML_PREVIEW_STYLE = [
  'html{color-scheme:light}',
  'body{margin:0;padding:12px;font:12px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;background:#fff;word-break:break-word;overflow-wrap:anywhere}',
  'img{max-width:100%;height:auto}',
  'a{color:#0b63bd;text-decoration:underline}',
  'table{border-collapse:collapse}',
  'td,th{border:1px solid #d8dee6;padding:3px 6px;vertical-align:top}',
  'pre{white-space:pre-wrap;word-break:break-word}'
].join('')

/** Elements that could execute code, load remote content or redirect the frame. */
const DANGEROUS_SELECTORS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'link'
] as const

/** Attributes whose value the browser may treat as a URL. */
const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'data',
  'background',
  'xlink:href',
  'srcset'
])

/** Content types that are binary/unsupported even if the bytes look printable. */
const BINARY_IMAGE_AUDIO_VIDEO_FONT = /^(?:image|audio|video|font)\//i
const BINARY_APPLICATION =
  /^application\/(?:octet-stream|pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|wasm|x-protobuf|protobuf|java-archive|epub\+zip|vnd\.)/i

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

/**
 * True when a response should not be rendered as text: declared binary content
 * types, NUL bytes, or a high ratio of control characters in the first 4 KiB.
 */
export function isBinaryResponse(body: string, headers: Record<string, string>): boolean {
  const contentType = headerValue(headers, 'content-type').trim()
  if (BINARY_IMAGE_AUDIO_VIDEO_FONT.test(contentType)) return true
  if (BINARY_APPLICATION.test(contentType)) return true
  const sample = body.slice(0, 4_096)
  if (sample === '') return false
  if (sample.includes('\u0000')) return true
  let control = 0
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index)
    if (code < 9 || (code > 13 && code < 32)) control += 1
  }
  return control / sample.length > 0.1
}

/** Status line + response headers, shared by the raw/JSON/render views. */
export function responseHead(status: number, headers: Record<string, string>): string {
  const lines = [`HTTP/1.1 ${status}`]
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  return lines.join('\n')
}

function htmlEscapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function resolveBaseHref(targetUrl: string): string {
  try {
    const target = new URL(targetUrl)
    if (target.protocol === 'http:' || target.protocol === 'https:') return `${target.origin}/`
  } catch {
    /* not a valid absolute target */
  }
  return ''
}

/** True when a URL-bearing attribute would execute code or leave the preview. */
function isDangerousUrl(value: string, attributeName: string): boolean {
  // Entities were already decoded by the HTML parser; strip separators the URL
  // parser would also ignore before checking the scheme.
  const compact = value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase()
  if (compact.startsWith('javascript:') || compact.startsWith('vbscript:')) return true
  if (compact.startsWith('file:') || compact.startsWith('blob:')) return true
  if (compact.startsWith('data:')) {
    // Only raster data images may stay; data:text/html, SVG and everything else
    // can carry active content and is rewritten to an inert fragment.
    return !(
      attributeName === 'src' &&
      /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif)/.test(compact)
    )
  }
  return false
}

function sanitizeWithDom(html: string): string | null {
  const scope = typeof window === 'undefined' ? null : window
  const Parser =
    scope !== null && typeof scope.DOMParser !== 'undefined'
      ? scope.DOMParser
      : typeof DOMParser === 'undefined'
        ? null
        : DOMParser
  if (Parser === null) return null
  const doc = new Parser().parseFromString(html, 'text/html')
  for (const selector of DANGEROUS_SELECTORS) {
    const nodes = Array.from(doc.querySelectorAll(selector))
    for (const node of nodes) node.remove()
  }
  const elements = Array.from(doc.querySelectorAll('*'))
  for (const element of elements) {
    const attributes = Array.from(element.attributes)
    for (const attribute of attributes) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
        continue
      }
      if (name === 'srcdoc') {
        element.removeAttribute(attribute.name)
        continue
      }
      if (name === 'style' && /(?:expression\s*\(|javascript:)/i.test(attribute.value)) {
        element.removeAttribute(attribute.name)
        continue
      }
      if (URL_ATTRIBUTES.has(name) && isDangerousUrl(attribute.value, name)) {
        element.setAttribute(attribute.name, '#')
      }
    }
  }
  return doc.documentElement.outerHTML
}

/** Regex fallback for environments without DOMParser (kept intentionally conservative). */
function sanitizeWithRegex(html: string): string {
  let next = html
  // Remove dangerous elements together with their content (closed pairs).
  next = next.replace(
    /<(script|iframe|frame|frameset|object|embed|applet)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ''
  )
  // Remove orphan/self-closing dangerous tags, including unclosed <script>.
  next = next.replace(
    /<\/?(?:script|iframe|frame|frameset|object|embed|applet|base|meta|link)\b[^>]*>/gi,
    ''
  )
  // Inline event handlers and srcdoc.
  next = next.replace(/\son[a-z0-9_:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  next = next.replace(/\ssrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // URL-bearing attributes with dangerous schemes.
  next = next.replace(
    /(\s)(href|src|action|formaction|poster|data|background|xlink:href|srcset)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (whole: string, space: string, name: string, equals: string, rawValue: string) => {
      const quoted = rawValue.startsWith('"') || rawValue.startsWith("'")
      const value = quoted ? rawValue.slice(1, -1) : rawValue
      if (!isDangerousUrl(value, name.toLowerCase())) return whole
      return `${space}${name}${equals}"#"`
    }
  )
  return next
}

/** Remove scripts, inline handlers, embedded frames and active URLs from HTML. */
function sanitizeHtml(html: string): string {
  const withoutNul = html.replace(/\u0000/g, '')
  return sanitizeWithDom(withoutNul) ?? sanitizeWithRegex(withoutNul)
}

/**
 * Build the inert `srcDoc` used by the 渲染 tab: sanitized response HTML with a
 * strict CSP meta first in the document, a no-referrer policy and a <base> tag
 * derived from the request origin so relative (CSP-blocked) URLs stay inert but
 * predictable. No remote renderer, no network access, no script execution.
 */
export function buildSafeHtmlPreview(body: string, targetUrl: string): string {
  const sanitized = sanitizeHtml(body).trim()
  const injection = [
    `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`,
    '<meta name="referrer" content="no-referrer">'
  ]
  const baseHref = resolveBaseHref(targetUrl)
  if (baseHref !== '') injection.push(`<base href="${htmlEscapeAttribute(baseHref)}">`)
  injection.push(`<style>${HTML_PREVIEW_STYLE}</style>`)
  const head = injection.join('')

  if (/<head(?:\s[^>]*)?>/i.test(sanitized)) {
    return sanitized.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${head}`)
  }
  if (/<html(?:\s[^>]*)?>/i.test(sanitized)) {
    return sanitized.replace(/<html(?:\s[^>]*)?>/i, (match) => `${match}<head>${head}</head>`)
  }
  const prefix = /^\s*<!doctype/i.test(sanitized) ? '' : '<!doctype html>'
  return `${prefix}<html><head>${head}</head><body>${sanitized}</body></html>`
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
