/**
 * curl import/export helpers for the single Repeater.
 *
 * Everything here is pure (no network, no DOM); the dialog only calls
 * `parseCurlCommand` and `buildCurlCommand`. The parser is intentionally
 * "best effort": it covers the common bash/zsh and Windows cmd forms without
 * pretending to be a shell. Options that cannot be represented in a raw HTTP
 * request (proxies, certificates, output files, multipart uploads...) are
 * ignored and reported via `ignored`.
 */
import {
  serializeRawRequest,
  type ParsedRawRequest
} from './repeaterRaw'

export type CurlParseErrorCode = 'empty' | 'no-url' | 'unterminated-quote'

export interface CurlParseFailure {
  ok: false
  code: CurlParseErrorCode
  /** Raw token/option that triggered the failure, never sent to a toast. */
  detail?: string
}

export interface CurlParseSuccess {
  ok: true
  request: ParsedRawRequest
  /** Raw editor text derived from the parsed request. */
  raw: string
  /** Recognized but unsupported options; kept for debugging/reporting only. */
  ignored: string[]
}

export type CurlParseResult = CurlParseSuccess | CurlParseFailure

type TokenizeResult =
  | { ok: true; tokens: string[] }
  | { ok: false; code: 'unterminated-quote' }

/** Options that take a separate value and are not part of the request we keep. */
const DISCARDED_VALUE_OPTIONS = new Set([
  '-x',
  '--proxy',
  '--proxy-user',
  '-m',
  '--max-time',
  '--connect-timeout',
  '--retry',
  '--retry-delay',
  '-o',
  '--output',
  '--cacert',
  '--capath',
  '--cert',
  '--key',
  '--cert-type',
  '--key-type',
  '--pass',
  '--resolve',
  '--interface',
  '--dns-servers',
  '--limit-rate',
  '--max-filesize',
  '--range',
  '-r',
  '--write-out',
  '-w',
  '--upload-file',
  '-T',
  '--form',
  '-F',
  '--form-string',
  '--dump-header',
  '-D',
  '--cookie-jar',
  '-c',
  '--oauth2-bearer',
  '--connect-to',
  '--local-port',
  '--keepalive-time',
  '--max-redirs',
  '--proto',
  '--proto-redir',
  '--http-version',
  '--tls-max'
])

/** Short options that consume a value: the attached form (`-XPOST`) is common. */
const SHORT_VALUE_OPTIONS = new Set([
  '-X',
  '-H',
  '-d',
  '-b',
  '-A',
  '-e',
  '-u',
  '-x',
  '-m',
  '-o',
  '-w',
  '-r',
  '-T',
  '-F',
  '-D',
  '-c'
])

/** Boolean short flags we can safely ignore (combined forms like `-sS` too). */
const SHORT_BOOLEAN_FLAGS = new Set('sSkLifgvNIqO462J1'.split(''))

/** Boolean long flags we can safely ignore. */
const LONG_BOOLEAN_FLAGS = new Set([
  '--silent',
  '--show-error',
  '--insecure',
  '--location',
  '--location-trusted',
  '--include',
  '--verbose',
  '--fail',
  '--fail-with-body',
  '--globoff',
  '--compressed',
  '--no-buffer',
  '--ipv4',
  '--ipv6',
  '--http1.0',
  '--http1.1',
  '--http2',
  '--http2-prior-knowledge',
  '--http3',
  '--tlsv1.0',
  '--tlsv1.1',
  '--tlsv1.2',
  '--tlsv1.3',
  '--disable',
  '--path-as-is',
  '--raw',
  '--remote-name',
  '--remote-header-name',
  '--create-dirs',
  '--no-keepalive',
  '--no-progress-meter',
  '--progress-bar',
  '--trace-ascii',
  '--trace-time',
  '--ignore-content-length'
])

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Strip bash (`\`), Windows cmd (`^`) and PowerShell (`` ` ``) line continuations. */
function stripLineContinuations(text: string): string {
  return text
    .replace(/\\\r?\n/g, ' ')
    .replace(/\^\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char)
}

function decodeAnsiEscape(
  text: string,
  slashIndex: number
): { value: string; index: number } {
  const next = text[slashIndex + 1]
  if (next === undefined) return { value: '\\', index: slashIndex }
  switch (next) {
    case 'n':
      return { value: '\n', index: slashIndex + 1 }
    case 'r':
      return { value: '\r', index: slashIndex + 1 }
    case 't':
      return { value: '\t', index: slashIndex + 1 }
    case '\\':
      return { value: '\\', index: slashIndex + 1 }
    case "'":
      return { value: "'", index: slashIndex + 1 }
    case '"':
      return { value: '"', index: slashIndex + 1 }
    default:
      return { value: next, index: slashIndex + 1 }
  }
}

/**
 * Split a curl command line into argv-like tokens.
 *
 * Supports POSIX single/double quotes, `$'...'` ANSI-C strings, backslash
 * escapes and Windows cmd caret escapes. Backslashes inside paths (`C:\tmp`)
 * stay literal unless they escape whitespace, quotes or another backslash.
 */
export function tokenizeCurl(input: string): TokenizeResult {
  const text = stripLineContinuations(input)
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let ansiC = false
  let started = false

  const flush = (): void => {
    if (!started) return
    tokens.push(current)
    current = ''
    started = false
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''

    if (ansiC) {
      if (char === "'") {
        ansiC = false
      } else if (char === '\\') {
        const decoded = decodeAnsiEscape(text, index)
        current += decoded.value
        index = decoded.index
      } else {
        current += char
      }
      continue
    }

    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === '\\') {
        const next = text[index + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next
          index += 1
        } else {
          current += '\\'
        }
      } else {
        current += char
      }
      continue
    }

    if (char === "'") {
      quote = "'"
      started = true
      continue
    }
    if (char === '"') {
      quote = '"'
      started = true
      continue
    }
    if (char === '$' && (text[index + 1] === "'" || text[index + 1] === '"')) {
      if (text[index + 1] === "'") ansiC = true
      else quote = '"'
      started = true
      index += 1
      continue
    }
    if (char === '\\') {
      const next = text[index + 1]
      if (next === undefined) {
        current += '\\'
        started = true
        continue
      }
      if (next === ' ' || next === '\t' || next === '"' || next === "'" || next === '\\') {
        current += next
        index += 1
        started = true
        continue
      }
      // Windows paths keep their literal backslash.
      current += '\\'
      started = true
      continue
    }
    if (char === '^') {
      const next = text[index + 1]
      if (next !== undefined && !isWhitespace(next)) {
        current += next
        index += 1
        started = true
        continue
      }
      current += '^'
      started = true
      continue
    }
    if (isWhitespace(char)) {
      flush()
      continue
    }
    current += char
    started = true
  }

  if (quote !== null || ansiC) return { ok: false, code: 'unterminated-quote' }
  flush()
  return { ok: true, tokens }
}

function baseName(token: string): string {
  return token.replace(/^.*[\\/]/, '').toLowerCase()
}

function isCurlExecutable(token: string): boolean {
  return /^curl(?:\.exe)?$/.test(baseName(token))
}

function looksLikeUrl(token: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|\/)/i.test(token) || token.includes('.') || token.includes(':')
}

function shortValueOption(token: string): string | null {
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) return null
  const short = token.slice(0, 2)
  return SHORT_VALUE_OPTIONS.has(short) ? short : null
}

function isCombinedBooleanShortFlags(token: string): boolean {
  if (!token.startsWith('-') || token.startsWith('--') || token.length <= 2) return false
  return token
    .slice(1)
    .split('')
    .every((flag) => SHORT_BOOLEAN_FLAGS.has(flag))
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const trimmedName = name.trim()
  if (trimmedName === '') return
  const existing = Object.keys(headers).find(
    (key) => key.toLowerCase() === trimmedName.toLowerCase()
  )
  if (existing === undefined) headers[trimmedName] = value.trim()
  else headers[existing] = value.trim()
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())
}

function applyHeaderLine(headers: Record<string, string>, line: string): void {
  const colon = line.indexOf(':')
  if (colon <= 0) return
  setHeader(headers, line.slice(0, colon), line.slice(colon + 1))
}

/** UTF-8 safe standard base64 (used for `-u user:pass`). */
export function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    output += BASE64_ALPHABET[first >> 2]
    output += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]
    output += second === undefined ? '=' : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]
    output += third === undefined ? '=' : BASE64_ALPHABET[third & 0x3f]
  }
  return output
}

/**
 * Best-effort conversion of a pasted curl command into a raw HTTP request.
 *
 * The returned `raw` text is what the Repeater editor should show; sending it
 * still goes through `parseRawRequest` + `stripDerivedHeaders` + the retest
 * proxy. No network access happens here.
 */
export function parseCurlCommand(input: string): CurlParseResult {
  const tokenized = tokenizeCurl(input)
  if (!tokenized.ok) return { ok: false, code: 'unterminated-quote' }
  let tokens = tokenized.tokens.filter((token) => token !== '')
  if (tokens.length === 0) return { ok: false, code: 'empty' }

  let index = 0
  const first = tokens[0] ?? ''
  if (isCurlExecutable(first)) {
    index = 1
  } else if (!first.startsWith('-') && !looksLikeUrl(first)) {
    // e.g. `proxychains curl ...`: drop a leading wrapper command.
    index = 1
  }
  tokens = tokens.slice(index)
  index = 0

  const headers: Record<string, string> = {}
  const specialHeaders: Record<string, string> = {}
  const dataParts: string[] = []
  const ignored: string[] = []
  let method = ''
  let url = ''
  let headOnly = false
  let getData = false
  let basicAuth: string | null = null
  let cookie: string | null = null
  let jsonBody = false
  let endOfOptions = false

  const assignPositional = (token: string): void => {
    if (url === '') {
      url = token
      return
    }
    ignored.push(token)
  }

  for (; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token === '') continue
    if (endOfOptions) {
      assignPositional(token)
      continue
    }
    if (token === '--') {
      endOfOptions = true
      continue
    }
    if (!token.startsWith('-') || token === '-') {
      assignPositional(token)
      continue
    }

    let option = token
    let inlineValue: string | null = null
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      if (equals !== -1) {
        option = token.slice(0, equals)
        inlineValue = token.slice(equals + 1)
      }
    } else {
      const valueOption = shortValueOption(token)
      if (valueOption !== null) {
        option = valueOption
        if (token.length > 2) inlineValue = token.slice(2)
      }
    }

    const takeValue = (): string | null => {
      if (inlineValue !== null) {
        const value = inlineValue
        inlineValue = null
        return value
      }
      const next = tokens[index + 1]
      if (next === undefined) return null
      index += 1
      return next
    }

    switch (option) {
      case '-X':
      case '--request': {
        const value = takeValue()
        if (value !== null && /^[A-Za-z]+$/.test(value.trim())) {
          method = value.trim().toUpperCase()
        } else if (value !== null) {
          ignored.push(option)
        }
        break
      }
      case '-H':
      case '--header': {
        const value = takeValue()
        if (value !== null) applyHeaderLine(headers, value)
        break
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-ascii':
      case '--data-binary': {
        const value = takeValue()
        if (value === null) break
        if (value.startsWith('@')) {
          // File-backed bodies cannot be resolved from the renderer.
          ignored.push(option)
          break
        }
        dataParts.push(value)
        break
      }
      case '--json': {
        const value = takeValue()
        if (value === null) break
        dataParts.push(value)
        jsonBody = true
        break
      }
      case '-b':
      case '--cookie': {
        const value = takeValue()
        if (value === null) break
        if (value.startsWith('@')) {
          ignored.push(option)
          break
        }
        cookie = cookie === null ? value : `${cookie}; ${value}`
        break
      }
      case '-A':
      case '--user-agent': {
        const value = takeValue()
        if (value !== null) specialHeaders['User-Agent'] = value
        break
      }
      case '-e':
      case '--referer': {
        const value = takeValue()
        if (value !== null) specialHeaders.Referer = value
        break
      }
      case '-u':
      case '--user': {
        const value = takeValue()
        if (value !== null) basicAuth = value
        break
      }
      case '--url': {
        const value = takeValue()
        if (value !== null && value.trim() !== '') url = value.trim()
        break
      }
      case '-I':
      case '--head':
        headOnly = true
        break
      case '-G':
      case '--get':
        // `-G` moves -d payloads into the query string.
        getData = true
        break
      default: {
        if (isCombinedBooleanShortFlags(option)) {
          if (option.includes('I')) headOnly = true
          break
        }
        if (!option.startsWith('--') && option.length === 2 && SHORT_BOOLEAN_FLAGS.has(option[1] ?? '')) {
          break
        }
        if (DISCARDED_VALUE_OPTIONS.has(option)) {
          takeValue()
          ignored.push(option)
          break
        }
        if (LONG_BOOLEAN_FLAGS.has(option)) break
        if (option.startsWith('--')) {
          // Unknown long option: most curl long options take a value.
          if (inlineValue === null) {
            const next = tokens[index + 1]
            if (next !== undefined && !next.startsWith('-')) index += 1
          }
        }
        ignored.push(option)
        break
      }
    }
  }

  if (url.trim() === '') return { ok: false, code: 'no-url' }
  let normalizedUrl = url.trim().replace(/\s+/g, '%20')
  let body = dataParts.join('&')
  if (getData && body !== '') {
    normalizedUrl = `${normalizedUrl}${normalizedUrl.includes('?') ? '&' : '?'}${body}`
    body = ''
  }
  const finalMethod =
    method !== ''
      ? method
      : headOnly
        ? 'HEAD'
        : body !== ''
          ? 'POST'
          : 'GET'

  if (jsonBody && !hasHeader(headers, 'content-type')) {
    setHeader(headers, 'Content-Type', 'application/json')
  }
  if (basicAuth !== null && !hasHeader(headers, 'authorization')) {
    setHeader(headers, 'Authorization', `Basic ${toBase64(basicAuth)}`)
  }
  if (cookie !== null && !hasHeader(headers, 'cookie')) {
    setHeader(headers, 'Cookie', cookie)
  }
  for (const [name, value] of Object.entries(specialHeaders)) {
    if (!hasHeader(headers, name)) setHeader(headers, name, value)
  }

  const request: ParsedRawRequest = {
    method: finalMethod,
    url: normalizedUrl,
    headers,
    body
  }
  return {
    ok: true,
    request,
    raw: serializeRawRequest(request),
    ignored
  }
}

/** POSIX-shell single-quote escaping; safe for URLs, headers and bodies. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Build a copyable curl command equivalent to the parsed request.
 *
 * GET without a body stays implicit (`curl <url>`); every other method (and a
 * GET that carries a body) gets an explicit `-X` so the command stays exact.
 */
export function buildCurlCommand(request: ParsedRawRequest): string {
  const method = request.method.trim().toUpperCase() || 'GET'
  const body = request.body ?? ''
  const parts: string[] = ['curl']
  if (method !== 'GET' || body !== '') parts.push('-X', method)
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.trim() === '') continue
    parts.push('-H', shellQuote(`${name}: ${value}`))
  }
  if (body !== '') parts.push('--data-raw', shellQuote(body))
  parts.push(shellQuote(request.url))
  return parts.join(' ')
}
