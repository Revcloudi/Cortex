import type { Vulnerability } from '@shared/types'

export interface RepeaterRequestCandidate {
  /** Human label for the step selector. */
  label: string
  /** Raw HTTP request block, ready for the editor. */
  raw: string
  method: string
  path: string
}

const REQUEST_LINE = /^([A-Z]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/

/**
 * Raw report requests carry only the origin-form path (`GET /api/x HTTP/1.1`),
 * but the Host send API requires an absolute URL. Resolve against the finding's
 * target so http-only targets stay http and https targets stay https.
 */
export function resolveRepeaterUrl(rawUrl: string, targetUrl: string): string {
  const value = rawUrl.trim()
  if (/^https?:\/\//i.test(value)) return value
  try {
    const target = new URL(targetUrl)
    if (value.startsWith('//')) return `${target.protocol}${value}`
    return new URL(value, target).href
  } catch {
    return value
  }
}

function normalizePath(input: string): string {
  try {
    if (/^https?:\/\//i.test(input)) return new URL(input).pathname
  } catch {
    // fall through to the raw path
  }
  return input.split('?')[0]?.split('#')[0] ?? input
}

function extractCodeBlocks(markdown: string): string[] {
  const blocks: string[] = []
  const regex = /```[^\n`]*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(markdown)) !== null) {
    if (match[1] !== undefined) blocks.push(match[1].replace(/\r\n/g, '\n').trim())
  }
  return blocks
}

/** Turn a fenced raw request block into a candidate; responses and prose are skipped. */
function parseBlock(block: string): Omit<RepeaterRequestCandidate, 'label'> | null {
  const lines = block.split('\n')
  const requestLine = (lines.shift() ?? '').trim()
  const parsed = REQUEST_LINE.exec(requestLine)
  if (parsed === null) return null
  const method = parsed[1] ?? ''
  const path = parsed[2] ?? ''
  if (path === '') return null
  // Drop an empty separator at the top of the block, keep headers/body intact.
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift()
  const raw = `${requestLine}\n${lines.join('\n')}`.trimEnd()
  return { raw, method, path }
}

/** Paths from `affected_interfaces` look like `GET /api/invoices/<id>`; keep the path only. */
function affectedPaths(vuln: Vulnerability): string[] {
  return vuln.affected_interfaces
    .map((value) => /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i.exec(value)?.[1] ?? null)
    .filter((value): value is string => value !== null)
}

function templateToRegex(template: string): RegExp {
  const escaped = normalizePath(template)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/&lt;[^&]+&gt;/g, '[^/?#]+')
    .replace(/<[^>]+>/g, '[^/?#]+')
  return new RegExp(`^${escaped}$`)
}

function isLoginPath(path: string): boolean {
  return /^\/(?:login|logout|signin|signout)(?:\/|$)/i.test(path)
}

function hostHeader(vuln: Vulnerability): string {
  try {
    return new URL(vuln.target_url).host
  } catch {
    return ''
  }
}

function fallbackRaw(vuln: Vulnerability): string {
  try {
    const target = new URL(vuln.target_url)
    return `GET ${target.pathname}${target.search} HTTP/1.1\nHost: ${target.host}\n`
  } catch {
    return `GET / HTTP/1.1\nHost: ${hostHeader(vuln)}\n`
  }
}

/**
 * Extract all raw HTTP request steps from a vulnerability's Markdown report.
 *
 * The default selected step is the one that best matches the finding's target
 * path / affected interfaces and is not a login request. When the report only
 * has step 1 (login), the user can still switch to it in the step selector.
 */
export function extractRepeaterRequests(vuln: Vulnerability): RepeaterRequestCandidate[] {
  const blocks = extractCodeBlocks(vuln.reproduction_steps)
  const parsed = blocks
    .map((block) => parseBlock(block))
    .filter((candidate): candidate is Omit<RepeaterRequestCandidate, 'label'> => candidate !== null)

  let targetPath = ''
  try {
    targetPath = normalizePath(new URL(vuln.target_url).pathname)
  } catch {
    targetPath = ''
  }
  const candidates = parsed.map((candidate, index) => ({
    ...candidate,
    label: `${index + 1}. ${candidate.method} ${candidate.path}`
  }))

  if (candidates.length === 0) {
    return [
      {
        label: `1. GET ${targetPath || '/'}`,
        raw: fallbackRaw(vuln),
        method: 'GET',
        path: targetPath || '/'
      }
    ]
  }

  // Keep report order in the selector; the caller separately chooses the best
  // default step so a login/setup request is not shown as the exploit PoC.
  return candidates.map((candidate) => ({
    label: candidate.label,
    raw: candidate.raw,
    method: candidate.method,
    path: candidate.path
  }))
}

/** Index of the step that should be selected by default. */
export function defaultRequestIndex(
  vuln: Vulnerability,
  requests: RepeaterRequestCandidate[]
): number {
  if (requests.length <= 1) return 0
  let targetPath = ''
  try {
    targetPath = normalizePath(new URL(vuln.target_url).pathname)
  } catch {
    targetPath = ''
  }
  const apiPaths = affectedPaths(vuln)
  const isLoginTarget = isLoginPath(targetPath)

  // A request that exactly matches the finding's URL is the clearest PoC step,
  // but never default to a login request when the finding targets /login.
  if (!isLoginTarget) {
    const exact = requests.findIndex(
      (request) => normalizePath(request.path) === targetPath && !isLoginPath(request.path)
    )
    if (exact !== -1) return exact
    const targetDir = targetPath.replace(/\/[^/]*$/, '')
    if (targetDir !== '' && targetDir !== '/') {
      const sibling = requests.findIndex(
        (request) =>
          !isLoginPath(request.path) &&
          normalizePath(request.path).startsWith(`${targetDir}/`)
      )
      if (sibling !== -1) return sibling
    }
    const affected = requests.findIndex(
      (request) =>
        !isLoginPath(request.path) &&
        apiPaths.some((template) => templateToRegex(template).test(normalizePath(request.path)))
    )
    if (affected !== -1) return affected
  }

  // The report's first non-login request is the most useful fallback: in most
  // reports the login/setup request comes first and the exploit follows it.
  const firstNonLogin = requests.findIndex((request) => !isLoginPath(request.path))
  return firstNonLogin === -1 ? 0 : firstNonLogin
}
