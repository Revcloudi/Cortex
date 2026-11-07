/**
 * Local Repeater state: single-send history + named request collections.
 *
 * Contract (`.cache/fuzzer-contract.md`):
 *  - root = `process.env.CORTEX_REPEATER_DIR || ~/.cortex/repeater`, resolved
 *    lazily (never at import time, so tests can point it at a temp dir)
 *  - `history.json` / `collections.json`: plain JSON arrays, newest first,
 *    max 50 entries each, every write atomic (`.tmp` + rename)
 *  - response bodies are stored capped at 256 KiB with a `truncated` flag
 *  - no SQLite tables, no user-dir writes outside the resolved root
 *
 * Nothing in this module logs request/response content, cookies or auth
 * headers. Only request/response *shapes* are validated here; the actual
 * outbound path stays `src/host/retest.js`.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  badRequest,
  queryInt,
  readJsonBody,
  requireBodyString,
  safeDecode,
  sendJson,
} from '../http.js'
import {
  ALLOWED_METHODS,
  MAX_HEADERS,
  MAX_HEADER_VALUE,
  MAX_SEND_BODY_BYTES,
  normalizeHeaders,
} from '../retest.js'

/** Max history / collection entries kept on disk (contract). */
export const MAX_REPEATER_ITEMS = 50

/** Response bodies are stored/returned at most 256 KiB (contract). */
export const MAX_STORED_BODY_BYTES = 256 * 1024

const MAX_HISTORY_LIMIT = MAX_REPEATER_ITEMS
const DEFAULT_HISTORY_LIMIT = 20
const MAX_URL_LENGTH = 8000
const MAX_NAME_LENGTH = 80
const MAX_RESPONSE_HEADERS = MAX_HEADERS * 2
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/* ------------------------------------------------------------------------- */
/* Paths / atomic JSON                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Resolve the repeater state root lazily: the environment is read on every
 * call so a test (or an operator) can redirect it before the first write.
 * @returns {string} absolute path
 */
export function repeaterRoot() {
  const configured = process.env.CORTEX_REPEATER_DIR
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(configured.trim())
  }
  return join(homedir(), '.cortex', 'repeater')
}

/** @returns {string} */
export function historyFilePath() {
  return join(repeaterRoot(), 'history.json')
}

/** @returns {string} */
export function collectionsFilePath() {
  return join(repeaterRoot(), 'collections.json')
}

/**
 * Read a JSON document defensively: missing/corrupt files degrade to `null`.
 * @param {string} filePath
 * @returns {any}
 */
export function readJsonFile(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8')
    if (text.length === 0) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Write a JSON document atomically: `<file>.tmp` then rename into place.
 * @param {string} filePath
 * @param {unknown} value
 */
export function writeJsonAtomic(filePath, value) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tempPath = `${filePath}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tempPath, filePath)
  } catch (err) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    throw err
  }
}

/**
 * Cut a text value to the stored-body byte cap on a UTF-8 boundary.
 * @param {unknown} value
 * @returns {{body: string, truncated: boolean}}
 */
export function capStoredBody(value) {
  const text = value === null || value === undefined ? '' : String(value)
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= MAX_STORED_BODY_BYTES) return { body: text, truncated: false }
  let end = MAX_STORED_BODY_BYTES
  // Do not cut in the middle of a multi-byte UTF-8 sequence.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return { body: buffer.subarray(0, end).toString('utf8'), truncated: true }
}

/* ------------------------------------------------------------------------- */
/* History                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * @param {unknown} value
 * @returns {Record<string, any>|null}
 */
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * Read the stored history array (newest first). Corrupt/missing files -> [].
 * @returns {Record<string, any>[]}
 */
export function loadHistory() {
  return loadArray(historyFilePath())
}

/** @returns {Record<string, any>[]} */
export function loadCollections() {
  return loadArray(collectionsFilePath())
}

/** @param {string} filePath @returns {Record<string, any>[]} */
function loadArray(filePath) {
  const parsed = readJsonFile(filePath)
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.items)
      ? parsed.items
      : []
  return raw.filter((item) => plainObject(item) !== null)
}

/** @param {string} filePath @param {unknown[]} items */
function saveArray(filePath, items) {
  writeJsonAtomic(filePath, items.slice(0, MAX_REPEATER_ITEMS))
}

/**
 * Normalize one reusable request object (shared `RepeaterSendInput` shape).
 * Header rules are delegated to `normalizeHeaders`, so this never re-implements
 * the protocol-header / value validation from `retest.js`.
 * @param {unknown} value
 * @param {string} field
 */
export function normalizeStoredRequest(value, field = 'request') {
  const source = plainObject(value)
  if (!source) throw badRequest(`${field} must be an object`, { field })
  const method = source.method
  if (typeof method !== 'string' || !ALLOWED_METHODS.includes(method)) {
    throw badRequest(`${field}.method must be an uppercase HTTP method`, { field: `${field}.method` })
  }
  const url = source.url
  if (typeof url !== 'string' || url.length === 0) {
    throw badRequest(`${field}.url is required`, { field: `${field}.url` })
  }
  if (url.length > MAX_URL_LENGTH) {
    throw badRequest(`${field}.url is too long`, { field: `${field}.url`, max: MAX_URL_LENGTH })
  }
  const headers = normalizeHeaders(source.headers)
  let body = ''
  if (source.body !== undefined && source.body !== null) {
    if (typeof source.body !== 'string') {
      throw badRequest(`${field}.body must be a string`, { field: `${field}.body` })
    }
    if (Buffer.byteLength(source.body, 'utf8') > MAX_SEND_BODY_BYTES) {
      throw badRequest(`${field}.body is too large`, {
        field: `${field}.body`,
        maxBytes: MAX_SEND_BODY_BYTES,
      })
    }
    body = source.body
  }
  return { method, url, headers, body }
}

/**
 * Normalize one response object (shared `RepeaterSendResult.response` shape).
 * The body is capped at 256 KiB and the `truncated` flag reflects that cut.
 * @param {unknown} value
 * @param {string} field
 */
export function normalizeStoredResponse(value, field = 'response') {
  const source = plainObject(value)
  if (!source) throw badRequest(`${field} must be an object`, { field })
  const status = source.status
  if (!Number.isInteger(status) || status < 0 || status > 999) {
    throw badRequest(`${field}.status must be an integer status code`, { field: `${field}.status` })
  }
  const headersSource = source.headers === undefined ? {} : source.headers
  const headersObject = plainObject(headersSource)
  if (!headersObject) throw badRequest(`${field}.headers must be an object`, { field: `${field}.headers` })
  const entries = Object.entries(headersObject)
  if (entries.length > MAX_RESPONSE_HEADERS) {
    throw badRequest(`${field}.headers has too many entries`, {
      field: `${field}.headers`,
      max: MAX_RESPONSE_HEADERS,
    })
  }
  /** @type {Record<string, string>} */
  const headers = {}
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME_RE.test(name)) {
      throw badRequest(`${field}.headers has an invalid name`, { field: `${field}.headers` })
    }
    if (typeof headerValue !== 'string' || headerValue.length > MAX_HEADER_VALUE) {
      throw badRequest(`${field}.headers has an invalid value`, { field: `${field}.headers` })
    }
    headers[name] = headerValue
  }
  if (typeof source.body !== 'string') {
    throw badRequest(`${field}.body must be a string`, { field: `${field}.body` })
  }
  const durationMs = source.durationMs
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    throw badRequest(`${field}.durationMs must be a non-negative number`, {
      field: `${field}.durationMs`,
    })
  }
  const declaredTruncated = source.truncated
  if (declaredTruncated !== undefined && typeof declaredTruncated !== 'boolean') {
    throw badRequest(`${field}.truncated must be a boolean`, { field: `${field}.truncated` })
  }
  const capped = capStoredBody(source.body)
  return {
    status,
    headers,
    body: capped.body,
    durationMs,
    truncated: declaredTruncated === true || capped.truncated,
  }
}

/** Build a display-only raw HTTP request text from the request shape. */
function rawRequestText(request) {
  let target = String(request.url || '')
  try {
    const url = new URL(target)
    target = `${url.pathname}${url.search}`
  } catch {
    /* keep the verbatim value */
  }
  const lines = [`${request.method} ${target} HTTP/1.1`]
  for (const [name, value] of Object.entries(request.headers || {})) {
    lines.push(`${name}: ${value}`)
  }
  const body = typeof request.body === 'string' ? request.body : ''
  return `${lines.join('\r\n')}\r\n\r\n${body}`
}

/**
 * Append a history entry after a successful single Repeater send.
 *
 * Best-effort by design: any disk failure returns `null` instead of throwing,
 * so a history write can never fail the actual send. Request/response bodies
 * are stored (capped), but this function never logs them.
 *
 * @param {{vulnId?: string, request: Record<string, any>, result: Record<string, any>}} input
 * @returns {Record<string, any>|null}
 */
export function recordSendHistory(input) {
  try {
    const source = input && typeof input === 'object' ? input : {}
    const request = source.request || {}
    const result = source.result || {}
    const response = normalizeStoredResponse({
      status: Number(result.status) || 0,
      headers: plainObject(result.headers) || {},
      body: typeof result.body === 'string' ? result.body : '',
      durationMs: Number(result.durationMs) || 0,
      truncated: result.bodyTruncated === true,
    })
    const normalizedRequest = {
      method: String(request.method || ''),
      url: request.url instanceof URL ? request.url.href : String(request.url || ''),
      headers: plainObject(request.headers) || {},
      body: request.body === undefined || request.body === null ? '' : String(request.body),
    }
    const entry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      vulnId: typeof source.vulnId === 'string' ? source.vulnId : '',
      raw: rawRequestText(normalizedRequest),
      request: normalizedRequest,
      response,
    }
    const items = loadHistory()
    items.unshift(entry)
    saveArray(historyFilePath(), items)
    return entry
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------- */
/* Handlers — history                                                        */
/* ------------------------------------------------------------------------- */

/** GET /repeater/history?limit=20 -> { items } */
export function handleHistoryList({ res, searchParams }) {
  const limit =
    queryInt(searchParams, 'limit', { min: 1, max: MAX_HISTORY_LIMIT }) ?? DEFAULT_HISTORY_LIMIT
  const items = loadHistory().slice(0, limit)
  sendJson(res, 200, { items })
}

/** DELETE /repeater/history -> { cleared: true } */
export function handleHistoryClear({ res }) {
  saveArray(historyFilePath(), [])
  sendJson(res, 200, { cleared: true })
}

/* ------------------------------------------------------------------------- */
/* Handlers — collections                                                    */
/* ------------------------------------------------------------------------- */

/** GET /repeater/collections -> { items } */
export function handleCollectionsList({ res }) {
  sendJson(res, 200, { items: loadCollections() })
}

/**
 * POST /repeater/collections
 * Body: `{name, vulnId, raw, request, response?}` -> `{ item }`
 */
export async function handleCollectionsCreate({ req, res }) {
  const body = await readJsonBody(req)
  // Contract: the *trimmed* name is 1..80 characters.
  const rawName = requireBodyString(body, 'name', { max: 200 })
  const name = rawName.trim()
  if (name.length === 0) {
    throw badRequest('name must not be empty', { field: 'name' })
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw badRequest('name is too long', { field: 'name', max: MAX_NAME_LENGTH })
  }
  let vulnId = ''
  if (body.vulnId !== undefined && body.vulnId !== null) {
    vulnId = requireBodyString(body, 'vulnId', { max: 200 })
  }
  let raw = ''
  if (body.raw !== undefined && body.raw !== null) {
    if (typeof body.raw !== 'string') throw badRequest('raw must be a string', { field: 'raw' })
    raw = body.raw
  }
  const request = normalizeStoredRequest(body.request, 'request')
  let response = null
  if (body.response !== undefined && body.response !== null) {
    response = normalizeStoredResponse(body.response, 'response')
  }

  const items = loadCollections()
  if (items.length >= MAX_REPEATER_ITEMS) {
    throw badRequest('collection is full', { field: 'name', max: MAX_REPEATER_ITEMS })
  }
  const item = {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    vulnId,
    raw,
    request,
    response,
  }
  items.unshift(item)
  saveArray(collectionsFilePath(), items)
  sendJson(res, 200, { item })
}

/** DELETE /repeater/collections/:id -> { deleted: boolean } */
export function handleCollectionsDelete({ res, params }) {
  const id = safeDecode(params[0], 'collection id')
  if (id.length === 0) throw badRequest('collection id is required')
  const items = loadCollections()
  const next = items.filter((item) => item.id !== id)
  const deleted = next.length !== items.length
  if (deleted) saveArray(collectionsFilePath(), next)
  sendJson(res, 200, { deleted })
}
