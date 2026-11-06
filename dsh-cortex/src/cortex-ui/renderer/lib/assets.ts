import type { AssetInterface, AssetStatus, HttpMethod, LeakedInfoType } from '@shared/types'

export const ASSET_STATUS_STYLES: Record<AssetStatus, { badge: string; dot: string }> = {
  Alive: {
    badge: 'border-emerald-200/70 bg-emerald-50 text-emerald-700',
    dot: 'bg-emerald-500'
  },
  Dead: {
    badge: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground'
  },
  WAF_Blocked: {
    badge: 'border-amber-200/70 bg-amber-50 text-amber-800',
    dot: 'bg-amber-500'
  }
}

/** Functional method colours: quiet tinted chips matching the severity badges. */
export const INTERFACE_METHOD_STYLES: Record<HttpMethod, string> = {
  GET: 'border-emerald-200/70 bg-emerald-50 text-emerald-700',
  POST: 'border-amber-200/70 bg-amber-50 text-amber-800',
  PUT: 'border-sky-200/70 bg-sky-50 text-sky-700',
  PATCH: 'border-violet-200/70 bg-violet-50 text-violet-700',
  DELETE: 'border-red-200/70 bg-red-50 text-red-700',
  OPTIONS: 'border-border bg-muted text-muted-foreground',
  HEAD: 'border-border bg-muted text-muted-foreground'
}

export const LEAK_TYPE_STYLES: Record<LeakedInfoType, string> = {
  Credential: 'border-red-200/70 bg-red-50 text-red-700',
  API_Key: 'border-orange-200/70 bg-orange-50 text-orange-700',
  Token: 'border-amber-200/70 bg-amber-50 text-amber-800',
  PII: 'border-violet-200/70 bg-violet-50 text-violet-700',
  Internal_IP: 'border-sky-200/70 bg-sky-50 text-sky-700',
  Other: 'border-border bg-muted text-muted-foreground'
}

/**
 * Fingerprint strings are written by agents, so separators are inconsistent:
 * English/Chinese commas and semicolons, ideographic commas (、) and line
 * breaks all appear in the wild. Spaces, parentheses and plus signs are part of
 * technology names (`Spring Boot 3`, `Vue 2 + ElementUI`, `Tomcat (9.0)`).
 *
 * Separators inside a balanced bracket pair belong to a descriptive technology
 * name (for example `Docker Ubuntu 26.04.1 (hostname x, kernel y)`) and must
 * not be treated as delimiters either.
 */
const TECH_STACK_SEPARATORS = new Set([',', '，', ';', '；', '、', '\r', '\n'])
const OPEN_BRACKETS = new Set(['(', '（', '[', '【'])
const CLOSE_BRACKETS = new Set([')', '）', ']', '】'])

/** Split a free-form fingerprint string into one tag per technology. */
export function techStackTags(techStack: string | undefined): string[] {
  if (!techStack) return []

  const tags: string[] = []
  const seen = new Set<string>()
  let current = ''
  let depth = 0

  const push = (): void => {
    const tag = current.trim()
    current = ''
    if (tag.length === 0 || seen.has(tag)) return
    seen.add(tag)
    tags.push(tag)
  }

  for (const char of techStack) {
    if (OPEN_BRACKETS.has(char)) {
      depth += 1
      current += char
      continue
    }
    if (CLOSE_BRACKETS.has(char)) {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }
    if (depth === 0 && TECH_STACK_SEPARATORS.has(char)) {
      push()
      continue
    }
    current += char
  }
  push()

  return tags
}

export interface AssetInterfaceGroup {
  /** Visual grouping key, e.g. `/api/v1`, `/api/admin`. Read-only heading. */
  prefix: string
  interfaces: AssetInterface[]
}

/** Strip query string / fragment before computing the visual group prefix. */
function interfacePathname(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  const [pathname] = normalized.split(/[?#]/, 1)
  return pathname && pathname.length > 0 ? pathname : normalized
}

/**
 * Group structured interfaces by the first two path segments (`/api/v1`,
 * `/api/admin`, `/download`). Purely presentational: entries keep their
 * original order and their original `path` string.
 */
export function groupAssetInterfaces(
  interfaces: readonly AssetInterface[]
): AssetInterfaceGroup[] {
  const groups = new Map<string, AssetInterface[]>()
  for (const iface of interfaces) {
    const path = iface.path.trim()
    if (path.length === 0) continue
    const pathname = interfacePathname(path)
    const segments = pathname.split('/').filter(Boolean)
    const prefix =
      segments.length <= 1 ? pathname : `/${segments.slice(0, 2).join('/')}`
    const group = groups.get(prefix)
    if (group) group.push(iface)
    else groups.set(prefix, [iface])
  }
  return [...groups.entries()].map(([prefix, groupInterfaces]) => ({
    prefix,
    interfaces: groupInterfaces
  }))
}

const DEFAULT_INTERFACE_METHOD = 'GET'

/** Append a query fragment without producing `??` or picking the wrong separator. */
function appendQueryFragment(path: string, fragment: string): string {
  if (fragment.length === 0) return path
  if (!path.includes('?')) return `${path}?${fragment}`
  if (path.endsWith('?') || path.endsWith('&')) return `${path}${fragment}`
  return `${path}&${fragment}`
}

/** Params that look like a request body: contains whitespace or curly braces. */
function looksLikeRequestBody(params: string): boolean {
  return /[\s{}]/.test(params)
}

/** Pick the minimal Content-Type header the synthesised body needs. */
function bodyContentType(params: string): string {
  const trimmed = params.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
    ? 'application/json'
    : 'application/x-www-form-urlencoded'
}

/**
 * Build the complete HTTP request shown (and copied) for one interface.
 *
 * The captured raw request always wins and is returned verbatim — it already
 * carries the real request line, headers and body. Otherwise a minimal but
 * usable request is synthesised from `method` / `path` / `params`: request line,
 * `Host`, the required `Content-Type` for a body, then the body itself. Legacy
 * path-only entries still produce a valid `GET <path> HTTP/1.1` request.
 */
export function buildInterfaceRequest(host: string, iface: AssetInterface): string {
  const rawRequest = iface.request
  if (rawRequest !== undefined && rawRequest.trim().length > 0) return rawRequest

  const method = iface.method ?? DEFAULT_INTERFACE_METHOD
  const path = iface.path.trim() || '/'
  const hostHeader = `Host: ${host.trim()}`
  const params = iface.params?.trim() ?? ''

  if (params.length === 0) return `${method} ${path} HTTP/1.1\n${hostHeader}`

  if (params.startsWith('?')) {
    const query = params.slice(1)
    return `${method} ${appendQueryFragment(path, query)} HTTP/1.1\n${hostHeader}`
  }

  if (looksLikeRequestBody(params)) {
    return `${method} ${path} HTTP/1.1\n${hostHeader}\nContent-Type: ${bodyContentType(params)}\n\n${params}`
  }

  return `${method} ${appendQueryFragment(path, params)} HTTP/1.1\n${hostHeader}`
}

/**
 * Clipboard text for a candidate-value sample: one value per line, blanks
 * dropped, order preserved. Values are never secrets, so no masking here.
 */
export function testParameterValuesText(values: readonly string[]): string {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join('\n')
}
