/**
 * Repeater Fuzzer — host-side engine (contract: `.cache/fuzzer-contract.md`).
 *
 * Responsibilities:
 *  - `expandFuzzCases()`: pure Burp-style case expansion (sniper / battering
 *    ram / pitchfork / cluster bomb) with the exact contract ordering/counts
 *  - template + job input validation that delegates to the tested single-send
 *    rules (`validateSendRequest`, `normalizeHeaders`) instead of duplicating them
 *  - a background job manager: baseline + bounded worker pool, per-result JSONL
 *    persistence, cancel / time-limit / consecutive-network-error stops, lazy
 *    "host restart" recovery for jobs left `running` on disk
 *  - the six `/repeater/fuzz` route handlers
 *
 * Hard security rules:
 *  - outbound traffic only through `sendRetest()` (the SSRF-safe allowlisted
 *    path); no parallel fetch implementation exists here
 *  - per-case URL/header/body validation failures become that row's `error`;
 *    they never abort the job
 *  - request/response bodies are never logged (no console output at all)
 *  - JSON state lives under `CORTEX_REPEATER_DIR || ~/.cortex/repeater`, root
 *    resolved lazily per operation; no SQLite schema changes
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  ApiError,
  badRequest,
  notFound,
  queryEnum,
  queryInt,
  readJsonBody,
  requireBodyString,
  safeDecode,
  sendJson,
} from '../http.js'
import {
  ALLOWED_METHODS,
  isMetadataHost,
  normalizeHeaders,
  sendRetest,
  validateSendRequest,
} from '../retest.js'
import {
  capStoredBody,
  readJsonFile,
  repeaterRoot,
  writeJsonAtomic,
} from './repeater-store.js'

/* ------------------------------------------------------------------------- */
/* Public constants                                                          */
/* ------------------------------------------------------------------------- */

/** Supported Burp attack modes (contract). */
export const FUZZ_MODES = ['sniper', 'battering_ram', 'pitchfork', 'cluster_bomb']

/** Hard case cap (contract). */
export const MAX_FUZZ_CASES = 2000

/** Hard marker-position cap (contract). */
export const MAX_FUZZ_POSITIONS = 100

/** Payload strings total UTF-8 byte cap (contract). */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

/** Template URL/body caps, mirroring the single-send validator. */
export const MAX_FUZZ_URL_LENGTH = 8000
export const MAX_FUZZ_BODY_BYTES = 256 * 1024

/** Per-request concurrency / delay bounds (contract). */
export const MAX_CONCURRENCY = 10
export const MIN_CONCURRENCY = 1
export const MAX_DELAY_MS = 2000

/** Total job runtime cap (contract): 10 minutes. */
export const MAX_JOB_DURATION_MS = 10 * 60 * 1000

/** Stop after this many consecutive network errors (contract: 5). */
export const MAX_CONSECUTIVE_NETWORK_ERRORS = 5

/**
 * Max POST /repeater/fuzz body. Payload strings are capped at 2 MiB by UTF-8
 * byte length, but JSON escaping (quotes / backslashes / control characters)
 * can inflate that several times; 8 MiB keeps every valid 2 MiB payload list
 * acceptable while still bounding the request.
 */
export const MAX_FUZZ_REQUEST_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------------------- */
/* Internal constants                                                        */
/* ------------------------------------------------------------------------- */

const MARKER = '\u00a7'
const MAX_BRIEF_LENGTH = 500
const MAX_BRIEF_VALUE_LENGTH = 60
const RESULTS_DEFAULT_LIMIT = 200
const RESULTS_MAX_LIMIT = 1000
const JOBS_DEFAULT_LIMIT = 20
const JOBS_MAX_LIMIT = 100
const CSV_HEADER = 'index,payload,status,length,duration_ms,error'
const EXPORT_FORMATS = ['csv', 'json']
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NETWORK_ERROR_CODES = new Set(['UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT'])
const JSONL_CHUNK_BYTES = 64 * 1024
/** Persist live counters every N results; the finalize/stop writes are exact. */
const META_PERSIST_EVERY = 10

/** In-process jobs (running only). Finished jobs are read back from disk. */
/** @type {Map<string, Record<string, any>>} */
const activeJobs = new Map()

/* ------------------------------------------------------------------------- */
/* Template / marker scanning                                                */
/* ------------------------------------------------------------------------- */

/**
 * Split one marked text field into literal parts and marker tokens.
 * Throws on an unclosed `§`.
 * @param {string} text
 * @param {string} label
 * @returns {{parts: (string|{marker:number})[], bases: string[]}}
 */
function scanMarkedText(text, label) {
  const parts = []
  const bases = []
  let segmentStart = 0
  let openAt = -1
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== MARKER) continue
    if (openAt < 0) {
      if (index > segmentStart) parts.push(text.slice(segmentStart, index))
      openAt = index
    } else {
      bases.push(text.slice(openAt + 1, index))
      parts.push({ marker: bases.length - 1 })
      segmentStart = index + 1
      openAt = -1
    }
  }
  if (openAt >= 0) throw badRequest(`${label} contains an unclosed § marker`, { field: label })
  if (segmentStart < text.length) parts.push(text.slice(segmentStart))
  return { parts, bases }
}

/**
 * Build the ordered marker plan for a validated template.
 * Position order: URL pairs, then header values in object insertion order,
 * then body pairs (contract).
 * @param {{method:string,url:string,headers:Record<string,string>,body:string}} template
 */
function buildTemplatePlan(template) {
  /** @type {{index:number, field:string, name?:string, baseText:string}[]} */
  const positions = []
  /** @type {{kind:string, name?:string, parts:(string|{position:number})[]}[]} */
  const fields = []

  /** @param {'url'|'header'|'body'} kind @param {string|undefined} name @param {string} text */
  const addField = (kind, name, text) => {
    const label = kind === 'header' ? `header ${name}` : kind
    const scan = scanMarkedText(text, label)
    const start = positions.length
    for (let offset = 0; offset < scan.bases.length; offset += 1) {
      positions.push({
        index: start + offset,
        field: kind,
        ...(name ? { name } : {}),
        baseText: scan.bases[offset],
      })
    }
    fields.push({
      kind,
      ...(name ? { name } : {}),
      parts: scan.parts.map((part) =>
        typeof part === 'string' ? part : { position: start + part.marker },
      ),
    })
  }

  addField('url', undefined, template.url)
  for (const [name, value] of Object.entries(template.headers)) addField('header', name, value)
  addField('body', undefined, template.body)
  return { method: template.method, positions, fields }
}

/**
 * Render one template field with the payload value for each position.
 * @param {(string|{position:number})[]} parts
 * @param {string[]} values
 */
function renderParts(parts, values) {
  let out = ''
  for (const part of parts) out += typeof part === 'string' ? part : values[part.position]
  return out
}

/**
 * Render a full request for one case.
 * @param {ReturnType<typeof buildTemplatePlan>} plan
 * @param {string[]} values
 */
function renderRequest(plan, values) {
  let url = ''
  let body = ''
  /** @type {Record<string,string>} */
  const headers = {}
  for (const field of plan.fields) {
    if (field.kind === 'url') url = renderParts(field.parts, values)
    else if (field.kind === 'header') headers[field.name] = renderParts(field.parts, values)
    else body = renderParts(field.parts, values)
  }
  return { method: plan.method, url, headers, body }
}

/* ------------------------------------------------------------------------- */
/* Payload / template / job input validation                                 */
/* ------------------------------------------------------------------------- */

/**
 * Normalize and byte-count the payload sets.
 * @param {unknown} value
 * @returns {{payloadSets: string[][], payloadBytes: number}}
 */
function normalizePayloadSets(value) {
  if (!Array.isArray(value)) {
    throw badRequest('attack.payloadSets must be an array', { field: 'attack.payloadSets' })
  }
  const payloadSets = []
  let payloadBytes = 0
  for (let setIndex = 0; setIndex < value.length; setIndex += 1) {
    const set = value[setIndex]
    if (!Array.isArray(set)) {
      throw badRequest(`payload set ${setIndex + 1} must be an array`, {
        field: `attack.payloadSets[${setIndex}]`,
      })
    }
    const normalized = []
    for (const payload of set) {
      if (typeof payload !== 'string') {
        throw badRequest(`payload set ${setIndex + 1} entries must be strings`, {
          field: `attack.payloadSets[${setIndex}]`,
        })
      }
      payloadBytes += Buffer.byteLength(payload, 'utf8')
      normalized.push(payload)
    }
    payloadSets.push(normalized)
  }
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw badRequest('payload total is too large', {
      field: 'attack.payloadSets',
      maxBytes: MAX_PAYLOAD_BYTES,
    })
  }
  return { payloadSets, payloadBytes }
}

/**
 * Validate/normalize a fuzz request template.
 *
 * Delegates method/URL/header/body rules to `validateSendRequest`, so the
 * fuzzer and the single-send repeater can never drift apart. The template URL
 * is kept verbatim (its `§` markers survive); only the shape is validated.
 * @param {unknown} template
 * @returns {{method:string, url:string, headers:Record<string,string>, body:string}}
 */
export function validateFuzzTemplate(template) {
  if (template === null || typeof template !== 'object' || Array.isArray(template)) {
    throw badRequest('request template must be an object', { field: 'request' })
  }
  const source = /** @type {Record<string, unknown>} */ (template)
  const normalized = validateSendRequest({
    vulnId: 'VULN-FUZZ-TEMPLATE',
    method: source.method,
    url: source.url,
    headers: source.headers,
    body: source.body,
    followRedirects: false,
  })
  return {
    method: normalized.method,
    url: String(source.url),
    headers: normalized.headers,
    body: normalized.body === undefined || normalized.body === null ? '' : normalized.body,
  }
}

/**
 * Validate the fully expanded request for one case. Failures are recorded on
 * that row (never thrown out of the job loop).
 * @param {Record<string, any>} source
 * @param {boolean} followRedirects
 */
function validateCaseRequest(source, followRedirects) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw badRequest('invalid fuzz case request')
  }
  const method = source.method
  if (typeof method !== 'string' || !ALLOWED_METHODS.includes(method)) {
    throw badRequest('invalid fuzz case method')
  }
  const urlText = source.url
  if (typeof urlText !== 'string' || urlText.length === 0) {
    throw badRequest('invalid fuzz case url')
  }
  if (urlText.length > MAX_FUZZ_URL_LENGTH) {
    throw badRequest('expanded url is too long', { max: MAX_FUZZ_URL_LENGTH })
  }
  let url
  try {
    url = new URL(urlText)
  } catch {
    throw badRequest('expanded url is not a valid absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('expanded url must use http or https')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw badRequest('expanded url must not contain userinfo')
  }
  if (isMetadataHost(url.hostname)) {
    throw badRequest('metadata addresses are not allowed')
  }
  const headers = normalizeHeaders(source.headers)
  let body
  if (source.body !== undefined && source.body !== null && source.body !== '') {
    if (typeof source.body !== 'string') throw badRequest('fuzz case body must be a string')
    if (method === 'GET' || method === 'HEAD') {
      throw badRequest('request body is not allowed for GET/HEAD')
    }
    if (Buffer.byteLength(source.body, 'utf8') > MAX_FUZZ_BODY_BYTES) {
      throw badRequest('fuzz case body is too large', { maxBytes: MAX_FUZZ_BODY_BYTES })
    }
    body = source.body
  }
  return { method, url: urlText, headers, body, followRedirects }
}

/**
 * Normalize fuzz options with the contract bounds.
 * @param {unknown} options
 * @returns {{concurrency:number, delayMs:number, followRedirects:boolean, stopOnConsecutiveErrors:boolean}}
 */
function normalizeFuzzOptions(options) {
  const source =
    options === undefined || options === null
      ? {}
      : /** @type {Record<string, unknown>} */ (options)
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw badRequest('options must be an object', { field: 'options' })
  }
  const concurrency = source.concurrency === undefined ? 5 : source.concurrency
  if (
    !Number.isInteger(concurrency) ||
    concurrency < MIN_CONCURRENCY ||
    concurrency > MAX_CONCURRENCY
  ) {
    throw badRequest(
      `concurrency must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`,
      { field: 'concurrency', min: MIN_CONCURRENCY, max: MAX_CONCURRENCY },
    )
  }
  const delayMs = source.delayMs === undefined ? 0 : source.delayMs
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw badRequest(`delayMs must be an integer between 0 and ${MAX_DELAY_MS}`, {
      field: 'delayMs',
      min: 0,
      max: MAX_DELAY_MS,
    })
  }
  const followRedirects = source.followRedirects === undefined ? false : source.followRedirects
  if (typeof followRedirects !== 'boolean') {
    throw badRequest('followRedirects must be a boolean', { field: 'followRedirects' })
  }
  const stopOnConsecutiveErrors =
    source.stopOnConsecutiveErrors === undefined ? false : source.stopOnConsecutiveErrors
  if (typeof stopOnConsecutiveErrors !== 'boolean') {
    throw badRequest('stopOnConsecutiveErrors must be a boolean', {
      field: 'stopOnConsecutiveErrors',
    })
  }
  return { concurrency, delayMs, followRedirects, stopOnConsecutiveErrors }
}

/**
 * Validate the POST /repeater/fuzz body into a normalized job input.
 * @param {Record<string, unknown>} body
 */
export function validateFuzzJobInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object')
  }
  const vulnId = requireBodyString(body, 'vulnId', { max: 200 })
  const template = validateFuzzTemplate(body.request)
  const attack = body.attack
  if (attack === null || typeof attack !== 'object' || Array.isArray(attack)) {
    throw badRequest('attack is required', { field: 'attack' })
  }
  const attackSource = /** @type {Record<string, unknown>} */ (attack)
  const { payloadSets, payloadBytes } = normalizePayloadSets(attackSource.payloadSets)
  const expansion = expandFuzzCases({
    template,
    attack: { mode: attackSource.mode, payloadSets },
  })
  const options = normalizeFuzzOptions(body.options)
  return {
    vulnId,
    template,
    attack: { mode: expansion.mode, payloadSets },
    options,
    expansion,
    payloadBytes,
  }
}

/* ------------------------------------------------------------------------- */
/* Case expansion (pure)                                                     */
/* ------------------------------------------------------------------------- */

/** @returns {ApiError} 400 with the numeric case bound in `details`. */
function tooManyCasesError() {
  return badRequest(`fuzz job has more than ${MAX_FUZZ_CASES} cases`, {
    maxCases: MAX_FUZZ_CASES,
  })
}

/** @param {number} setNumber */
function emptyPayloadSetError(setNumber) {
  return badRequest(`payload set ${setNumber} must not be empty`, {
    field: `attack.payloadSets[${setNumber - 1}]`,
  })
}

/**
 * Validate that pitchfork/cluster bomb received enough payload sets.
 * @param {string[][]} payloadSets
 * @param {number} positionCount
 * @param {string} mode
 */
function requireEnoughSets(payloadSets, positionCount, mode) {
  if (payloadSets.length >= positionCount) return
  throw badRequest(`${mode} needs at least ${positionCount} payload sets`, {
    field: 'attack.payloadSets',
    minSets: positionCount,
    positions: positionCount,
  })
}

/** @param {string} value */
function briefValue(value) {
  const text = String(value).replace(/[\r\n\t]+/g, ' ').trim()
  return text.length > MAX_BRIEF_VALUE_LENGTH
    ? `${text.slice(0, MAX_BRIEF_VALUE_LENGTH)}…`
    : text
}

/**
 * @param {string[]} payloads
 * @param {number[]} usedPositions
 */
function buildPayloadBrief(payloads, usedPositions) {
  const parts = usedPositions.map((index) => `pos${index + 1}=${briefValue(payloads[index])}`)
  let brief = parts.join('&')
  if (brief.length > MAX_BRIEF_LENGTH) brief = `${brief.slice(0, MAX_BRIEF_LENGTH)}…`
  return brief
}

/**
 * Expand a validated template into all fuzz cases.
 *
 * Ordering (contract):
 *  - sniper: position-major (all payloads for position 0, then position 1, ...)
 *  - battering_ram: set #1 payload order, all positions replaced at once
 *  - pitchfork: index order, stop at the shortest used set
 *  - cluster_bomb: lexicographic, last position varying fastest
 *
 * @param {{template?: any, attack?: any}} input
 * @returns {{mode:string, positions:{index:number,field:string,name?:string}[], total:number, cases:{index:number,payloads:string[],payloadBrief:string,request:{method:string,url:string,headers:Record<string,string>,body:string}}[]}}
 */
export function expandFuzzCases(input) {
  const { template, attack } = input && typeof input === 'object' ? input : {}
  const normalizedTemplate = validateFuzzTemplate(template)
  const mode = attack && attack.mode
  if (typeof mode !== 'string' || !FUZZ_MODES.includes(mode)) {
    throw badRequest(`attack.mode must be one of ${FUZZ_MODES.join(', ')}`, {
      field: 'attack.mode',
      allowed: FUZZ_MODES,
    })
  }
  const { payloadSets } = normalizePayloadSets(attack.payloadSets)
  const plan = buildTemplatePlan(normalizedTemplate)
  const positionCount = plan.positions.length
  if (positionCount === 0) {
    throw badRequest('template must contain at least one § position', { field: 'request' })
  }
  if (positionCount > MAX_FUZZ_POSITIONS) {
    throw badRequest('template has too many § positions', {
      field: 'request',
      maxPositions: MAX_FUZZ_POSITIONS,
    })
  }

  const baseValues = plan.positions.map((position) => position.baseText)
  const allPositions = plan.positions.map((position) => position.index)
  /** @type {any[]} */
  const cases = []

  /** @param {string[]} values @param {number[]} usedPositions */
  const pushCase = (values, usedPositions) => {
    cases.push({
      index: cases.length,
      payloads: [...values],
      payloadBrief: buildPayloadBrief(values, usedPositions),
      request: renderRequest(plan, values),
    })
  }

  const firstSet = payloadSets[0] || []

  if (mode === 'sniper') {
    if (firstSet.length === 0) throw emptyPayloadSetError(1)
    if (firstSet.length * positionCount > MAX_FUZZ_CASES) throw tooManyCasesError()
    for (let position = 0; position < positionCount; position += 1) {
      for (const payload of firstSet) {
        const values = [...baseValues]
        values[position] = payload
        pushCase(values, [position])
      }
    }
  } else if (mode === 'battering_ram') {
    if (firstSet.length === 0) throw emptyPayloadSetError(1)
    if (firstSet.length > MAX_FUZZ_CASES) throw tooManyCasesError()
    for (const payload of firstSet) {
      const values = [...baseValues]
      for (let position = 0; position < positionCount; position += 1) values[position] = payload
      pushCase(values, allPositions)
    }
  } else if (mode === 'pitchfork') {
    requireEnoughSets(payloadSets, positionCount, mode)
    const usedSets = payloadSets.slice(0, positionCount)
    for (let setIndex = 0; setIndex < usedSets.length; setIndex += 1) {
      if (usedSets[setIndex].length === 0) throw emptyPayloadSetError(setIndex + 1)
    }
    const total = Math.min(...usedSets.map((set) => set.length))
    if (total > MAX_FUZZ_CASES) throw tooManyCasesError()
    for (let caseIndex = 0; caseIndex < total; caseIndex += 1) {
      const values = [...baseValues]
      for (let position = 0; position < positionCount; position += 1) {
        values[position] = usedSets[position][caseIndex]
      }
      pushCase(values, allPositions)
    }
  } else {
    // cluster_bomb: cartesian product, last position varies fastest.
    requireEnoughSets(payloadSets, positionCount, mode)
    const usedSets = payloadSets.slice(0, positionCount)
    let total = 1
    for (let setIndex = 0; setIndex < usedSets.length; setIndex += 1) {
      if (usedSets[setIndex].length === 0) throw emptyPayloadSetError(setIndex + 1)
      total *= usedSets[setIndex].length
      if (total > MAX_FUZZ_CASES) throw tooManyCasesError()
    }
    for (let caseIndex = 0; caseIndex < total; caseIndex += 1) {
      const values = [...baseValues]
      let remainder = caseIndex
      for (let position = positionCount - 1; position >= 0; position -= 1) {
        const set = usedSets[position]
        values[position] = set[remainder % set.length]
        remainder = Math.floor(remainder / set.length)
      }
      pushCase(values, allPositions)
    }
  }

  if (cases.length === 0) {
    throw badRequest('fuzz job has no cases', { field: 'attack.payloadSets' })
  }
  return {
    mode,
    positions: plan.positions.map((position) => ({
      index: position.index,
      field: position.field,
      ...(position.name ? { name: position.name } : {}),
    })),
    total: cases.length,
    cases,
  }
}

/* ------------------------------------------------------------------------- */
/* Disk helpers                                                              */
/* ------------------------------------------------------------------------- */

/** @returns {string} */
function fuzzStateDir() {
  return join(repeaterRoot(), 'fuzz')
}

/** @param {string} jobId */
function jobDirFor(jobId) {
  return join(fuzzStateDir(), jobId)
}

/** @param {string} jobId */
function metaPathFor(jobId) {
  return join(jobDirFor(jobId), 'meta.json')
}

/** @param {string} jobId */
function resultsPathFor(jobId) {
  return join(jobDirFor(jobId), 'results.jsonl')
}

/** @param {string} jobId */
function baselinePathFor(jobId) {
  return join(jobDirFor(jobId), 'baseline.json')
}

/** @returns {string} */
function exportsDir() {
  return join(repeaterRoot(), 'exports')
}

/**
 * Persist the job meta atomically. Best-effort: an unwritable disk must not
 * abort an in-flight job (results already produced stay readable in memory and
 * the responses to cancel/get stay correct for this process).
 * @param {Record<string, any>} job
 */
function persistMeta(job) {
  try {
    writeJsonAtomic(metaPathFor(job.meta.jobId), job.meta)
  } catch {
    /* best-effort persistence */
  }
}

/**
 * Load a job meta from disk and lazily mark jobs left `running` by a previous
 * host process as `interrupted` (contract).
 * @param {string} jobId
 */
function loadJobMeta(jobId) {
  const meta = readJsonFile(metaPathFor(jobId))
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null
  if (typeof meta.jobId !== 'string' || meta.jobId !== jobId) return null
  if (meta.status === 'running') {
    meta.status = 'interrupted'
    meta.finishedAt = new Date().toISOString()
    meta.stoppedReason = 'host_restart'
    try {
      writeJsonAtomic(metaPathFor(jobId), meta)
    } catch {
      /* read-only disk: still report the interrupted state */
    }
  }
  return meta
}

/**
 * Decode and validate a job id path segment (uuid only; blocks `..` traversal).
 * @param {unknown} raw
 */
function decodeJobId(raw) {
  const jobId = safeDecode(raw, 'fuzz job id')
  if (!JOB_ID_RE.test(jobId)) throw notFound('fuzz job not found')
  return jobId
}

/**
 * Active in-memory job wins over disk; otherwise load (and maybe recover) meta.
 * @param {string} jobId
 */
function requireJob(jobId) {
  const active = activeJobs.get(jobId)
  if (active) return { active: true, job: active, meta: active.meta }
  const meta = loadJobMeta(jobId)
  if (!meta) throw notFound('fuzz job not found')
  return { active: false, job: null, meta }
}

/* ------------------------------------------------------------------------- */
/* Result summaries / JSONL reading                                          */
/* ------------------------------------------------------------------------- */

/**
 * Compact summary row for GET /repeater/fuzz/:id (contract shape).
 * @param {Record<string, any>} result
 */
function resultSummary(result) {
  const response =
    result && result.response !== null && typeof result.response === 'object'
      ? result.response
      : null
  return {
    index: Number(result.index),
    payloadBrief: typeof result.payloadBrief === 'string' ? result.payloadBrief : '',
    status: response ? Number(response.status) : null,
    length: response ? Number(response.bodyBytes) : null,
    durationMs: response ? Number(response.durationMs) : null,
    error: result.error === undefined ? null : result.error,
    errorCode: result.errorCode === undefined ? null : result.errorCode,
    contentType: response && response.contentType ? String(response.contentType) : '',
    truncated: response ? response.truncated === true : false,
  }
}

/**
 * Baseline summary stored in meta (no index / payload fields).
 * @param {Record<string, any>} result
 */
function baselineSummary(result) {
  const summary = resultSummary(result)
  return {
    status: summary.status,
    length: summary.length,
    durationMs: summary.durationMs,
    error: summary.error,
    errorCode: summary.errorCode,
    contentType: summary.contentType,
    truncated: summary.truncated,
  }
}

/** @param {string} line */
function parseJsonLine(line) {
  try {
    const parsed = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Stream one results.jsonl file without loading the whole file into memory.
 * `visit` may return false to stop early.
 * @param {string} jobId
 * @param {(result: Record<string, any>) => boolean|void} visit
 */
function forEachResultLine(jobId, visit) {
  const filePath = resultsPathFor(jobId)
  if (!existsSync(filePath)) return
  let fd
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return
  }
  const chunk = Buffer.allocUnsafe(JSONL_CHUNK_BYTES)
  const decoder = new StringDecoder('utf8')
  let carry = ''
  try {
    for (;;) {
      let bytes
      try {
        bytes = readSync(fd, chunk, 0, chunk.length, null)
      } catch {
        return
      }
      if (bytes <= 0) break
      carry += decoder.write(chunk.subarray(0, bytes))
      let newline = carry.indexOf('\n')
      while (newline >= 0) {
        const line = carry.slice(0, newline)
        carry = carry.slice(newline + 1)
        if (line.trim().length > 0) {
          const parsed = parseJsonLine(line)
          if (parsed && visit(parsed) === false) return
        }
        newline = carry.indexOf('\n')
      }
    }
    carry += decoder.end()
    if (carry.trim().length > 0) {
      const parsed = parseJsonLine(carry)
      if (parsed) visit(parsed)
    }
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
  }
}

/**
 * All produced result summaries (index order) for a terminal job.
 * @param {string} jobId
 */
function collectResultSummaries(jobId) {
  /** @type {{index:number, summary:Record<string,any>}[]} */
  const rows = []
  forEachResultLine(jobId, (result) => {
    const index = Number(result.index)
    if (!Number.isInteger(index) || index < 0) return true
    rows.push({ index, summary: resultSummary(result) })
    return true
  })
  rows.sort((left, right) => left.index - right.index)
  return rows.map((row) => row.summary)
}

/** @param {Record<string, any>} result */
function requestForStorage(result) {
  return {
    method: String(result.method),
    url: String(result.url),
    headers: { ...(result.headers || {}) },
    body: typeof result.body === 'string' ? result.body : '',
  }
}

/**
 * Normalize a `sendRetest` result to the stored fuzz-response shape, applying
 * the 256 KiB body cap (contract). `bodyBytes` stays the real upstream length
 * (sendRetest's read count, itself capped at 2 MiB) so result rows and the
 * length-change column keep reflecting the true response size.
 * @param {Record<string, any>} result
 */
function normalizeResponse(result) {
  const capped = capStoredBody(result.body)
  const reportedBytes = Number(result.bodyBytes)
  return {
    status: Number(result.status),
    statusText: result.statusText ? String(result.statusText) : '',
    headers: result.headers || {},
    body: capped.body,
    bodyBytes:
      Number.isFinite(reportedBytes) && reportedBytes >= 0
        ? reportedBytes
        : Buffer.byteLength(capped.body, 'utf8'),
    truncated: result.bodyTruncated === true || capped.truncated,
    durationMs: Number(result.durationMs) || 0,
    contentType: result.contentType ? String(result.contentType) : '',
  }
}

/**
 * Cap a stored full result again on the detail response path (contract: cap on
 * disk AND in the detail response). The stored `bodyBytes` / `truncated` flags
 * are preserved — they describe the real upstream response, not the stored cut.
 * @param {Record<string, any>} result
 */
function capResultForResponse(result) {
  const response =
    result.response !== null && typeof result.response === 'object'
      ? { ...result.response }
      : null
  if (response) {
    const capped = capStoredBody(response.body)
    response.body = capped.body
    response.truncated = response.truncated === true || capped.truncated
    const reportedBytes = Number(response.bodyBytes)
    if (!Number.isFinite(reportedBytes) || reportedBytes < 0) {
      response.bodyBytes = Buffer.byteLength(capped.body, 'utf8')
    }
  }
  return {
    index: result.index === 'baseline' ? 'baseline' : Number(result.index),
    payloadBrief: typeof result.payloadBrief === 'string' ? result.payloadBrief : '',
    payloads: Array.isArray(result.payloads) ? result.payloads : [],
    request: result.request && typeof result.request === 'object' ? result.request : null,
    response,
    error: result.error === undefined ? null : result.error,
    errorCode: result.errorCode === undefined ? null : result.errorCode,
  }
}

/**
 * Find one stored full result by its 0-based case index.
 * @param {string} jobId
 * @param {number} targetIndex
 */
function findResultByIndex(jobId, targetIndex) {
  let found = null
  forEachResultLine(jobId, (result) => {
    if (Number(result.index) === targetIndex) {
      found = result
      return false
    }
    return true
  })
  return found
}

/* ------------------------------------------------------------------------- */
/* Job execution                                                             */
/* ------------------------------------------------------------------------- */

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {unknown} err */
function errorCodeOf(err) {
  if (err instanceof ApiError) return err.code
  return 'INTERNAL'
}

/** @param {unknown} err */
function errorMessageOf(err) {
  if (err instanceof ApiError) return err.message
  return 'fuzz request failed'
}

/**
 * Execute one case (or the baseline) through the SSRF-safe send path.
 * Validation failures are converted into a result row with `response: null`.
 * @param {Record<string, any>} job
 * @param {{index:number|string, payloadBrief:string, payloads:string[], request:Record<string,any>}} spec
 */
async function executeRequest(job, spec) {
  const base = {
    index: spec.index,
    payloadBrief: spec.payloadBrief,
    payloads: spec.payloads,
    request: spec.request,
  }
  let request
  try {
    request = validateCaseRequest(spec.request, job.meta.followRedirects === true)
  } catch (err) {
    return {
      ...base,
      response: null,
      error: errorMessageOf(err),
      errorCode: errorCodeOf(err),
    }
  }
  try {
    const result = await sendRetest({ request, context: job.context })
    return {
      ...base,
      request: requestForStorage(request),
      response: normalizeResponse(result),
      error: null,
      errorCode: null,
    }
  } catch (err) {
    return {
      ...base,
      request: requestForStorage(request),
      response: null,
      error: errorMessageOf(err),
      errorCode: errorCodeOf(err),
    }
  }
}

/**
 * Record one produced result: JSONL append + in-memory counters/summaries.
 * @param {Record<string, any>} job
 * @param {Record<string, any>} result
 */
function recordResult(job, result) {
  try {
    appendFileSync(resultsPathFor(job.meta.jobId), `${JSON.stringify(result)}\n`, 'utf8')
  } catch {
    /* disk failure must not abort the job */
  }
  job.produced += 1
  if (result.error === null || result.error === undefined) job.meta.completed += 1
  else job.meta.failed += 1
  job.summaries.set(Number(result.index), resultSummary(result))
  // The live counters are authoritative in memory; the on-disk copy only needs
  // to be close (a crash marks the job interrupted anyway) and every result
  // line is already durable, so avoid rewriting a potentially large meta.json
  // for every single case.
  if (job.produced % META_PERSIST_EVERY === 0) persistMeta(job)
}

/**
 * Ask a running job to stop scheduling. In-flight requests are still awaited
 * and recorded by the worker that owns them.
 * @param {Record<string, any>} job
 * @param {'cancelled'|'failed'} status
 * @param {string} reason
 */
function requestStop(job, status, reason) {
  job.cancelRequested = true
  if (job.meta.status === 'running') {
    job.meta.status = status
    job.meta.stoppedReason = reason
    job.meta.finishedAt = new Date().toISOString()
  }
  persistMeta(job)
}

/**
 * One pool worker: pulls case indexes until the pool is exhausted or stopped.
 * @param {Record<string, any>} job
 */
async function runWorker(job) {
  for (;;) {
    if (job.cancelRequested || job.meta.status !== 'running') return
    if (Date.now() - job.startedAtMs >= MAX_JOB_DURATION_MS) {
      requestStop(job, 'cancelled', 'time_limit')
      return
    }
    const caseIndex = job.nextIndex
    if (caseIndex >= job.cases.length) return
    job.nextIndex += 1
    if (job.meta.delayMs > 0) {
      await sleep(job.meta.delayMs)
      if (job.cancelRequested || job.meta.status !== 'running') return
    }
    const result = await executeRequest(job, job.cases[caseIndex])
    recordResult(job, result)
    if (job.meta.stopOnConsecutiveErrors === true) {
      job.consecutiveNetworkErrors = NETWORK_ERROR_CODES.has(result.errorCode)
        ? job.consecutiveNetworkErrors + 1
        : 0
      if (job.consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
        requestStop(job, 'cancelled', 'network_errors')
        return
      }
    } else {
      job.consecutiveNetworkErrors = 0
    }
  }
}

/**
 * Background job body: started async from the create handler so POST returns
 * immediately with `{jobId,total,mode,status:'running',baseline:null}`.
 * @param {Record<string, any>} job
 */
async function runFuzzJob(job) {
  const meta = job.meta
  try {
    job.startedAtMs = Date.now()
    meta.startedAt = new Date(job.startedAtMs).toISOString()
    persistMeta(job)

    // Baseline is always the first outbound action.
    const baselineRequest = renderRequest(job.plan, job.baseValues)
    const baselineResult = await executeRequest(job, {
      index: 'baseline',
      payloadBrief: 'baseline',
      payloads: [],
      request: baselineRequest,
    })
    job.baseline = baselineResult
    meta.baseline = baselineSummary(baselineResult)
    try {
      writeJsonAtomic(baselinePathFor(meta.jobId), baselineResult)
    } catch {
      /* baseline is optional on disk; the summary in meta still exists */
    }
    persistMeta(job)

    const workerCount = Math.max(1, Math.min(Number(meta.concurrency) || 1, job.cases.length))
    /** @type {Promise<void>[]} */
    const workers = []
    for (let worker = 0; worker < workerCount; worker += 1) workers.push(runWorker(job))
    await Promise.all(workers)
  } catch {
    if (meta.status === 'running') {
      meta.status = 'failed'
      meta.stoppedReason = 'internal_error'
      meta.finishedAt = new Date().toISOString()
    }
    persistMeta(job)
  } finally {
    if (meta.status === 'running') {
      meta.status = 'completed'
      meta.stoppedReason = null
      meta.finishedAt = new Date().toISOString()
    } else if (!meta.finishedAt) {
      meta.finishedAt = new Date().toISOString()
    }
    persistMeta(job)
    activeJobs.delete(meta.jobId)
  }
}

/* ------------------------------------------------------------------------- */
/* Handlers — /repeater/fuzz                                                 */
/* ------------------------------------------------------------------------- */

/**
 * POST /repeater/fuzz -> { jobId, total, mode, status:'running', baseline:null }
 * The job runs in the background; requests are not awaited here.
 */
export async function handleFuzzCreate({ req, res, config, holder, repository }) {
  if (config && config.allowNetwork === false) {
    throw new ApiError(403, 'FORBIDDEN', 'outbound network is disabled')
  }
  holder.ensure()
  holder.assertUsable()
  const body = await readJsonBody(req, { maxBytes: MAX_FUZZ_REQUEST_BYTES })
  const input = validateFuzzJobInput(body)
  // 404s unknown vuln ids; the context carries the origin allowlist.
  const context = repository.getRetestContext(input.vulnId)

  const jobId = randomUUID()
  let origin = ''
  try {
    origin = new URL(input.template.url).origin
  } catch {
    /* validateFuzzTemplate already accepted the URL */
  }
  const meta = {
    jobId,
    vulnId: input.vulnId,
    mode: input.expansion.mode,
    status: 'running',
    total: input.expansion.total,
    completed: 0,
    failed: 0,
    concurrency: input.options.concurrency,
    delayMs: input.options.delayMs,
    followRedirects: input.options.followRedirects,
    stopOnConsecutiveErrors: input.options.stopOnConsecutiveErrors,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    stoppedReason: null,
    target: { method: input.template.method, url: input.template.url, origin },
    baseline: null,
    positions: input.expansion.positions.length,
    payloadBytes: input.payloadBytes,
    template: input.template,
  }
  mkdirSync(jobDirFor(jobId), { recursive: true })
  writeJsonAtomic(metaPathFor(jobId), meta)

  const plan = buildTemplatePlan(input.template)
  /** @type {Record<string, any>} */
  const job = {
    meta,
    context,
    plan,
    baseValues: plan.positions.map((position) => position.baseText),
    cases: input.expansion.cases,
    startedAtMs: 0,
    nextIndex: 0,
    produced: 0,
    summaries: new Map(),
    baseline: null,
    cancelRequested: false,
    consecutiveNetworkErrors: 0,
  }
  activeJobs.set(jobId, job)
  void runFuzzJob(job).catch(() => {
    /* runFuzzJob never rejects; keep the promise handled regardless */
  })

  sendJson(res, 200, {
    jobId,
    total: meta.total,
    mode: meta.mode,
    status: 'running',
    baseline: null,
  })
}

/**
 * GET /repeater/fuzz/:id?offset=0&limit=200
 * Paginated result summaries; running jobs read live in-memory summaries.
 */
export function handleFuzzGet({ res, searchParams, params }) {
  const jobId = decodeJobId(params[0])
  const offset = queryInt(searchParams, 'offset', { min: 0 }) ?? 0
  const limit =
    queryInt(searchParams, 'limit', { min: 1, max: RESULTS_MAX_LIMIT }) ?? RESULTS_DEFAULT_LIMIT
  const { active, job, meta } = requireJob(jobId)

  let results
  let count
  if (active) {
    const all = [...job.summaries.values()].sort((left, right) => left.index - right.index)
    count = all.length
    results = all.slice(offset, offset + limit)
  } else {
    // The JSONL append is the durable record; the last persisted meta counters
    // may be stale (e.g. a host restart mid-job), so the file is authoritative.
    const all = collectResultSummaries(jobId)
    count = all.length
    results = all.slice(offset, offset + limit)
  }

  sendJson(res, 200, {
    job: jobSummary(meta),
    offset,
    limit,
    count,
    results,
  })
}

/** GET /repeater/fuzz/:id/results/:index (0-based index or literal `baseline`) */
export function handleFuzzResult({ res, params }) {
  const jobId = decodeJobId(params[0])
  const rawIndex = safeDecode(params[1], 'result index')
  const { meta } = requireJob(jobId)

  if (rawIndex === 'baseline') {
    const stored = readJsonFile(baselinePathFor(jobId))
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      throw notFound('baseline not found')
    }
    sendJson(res, 200, { result: capResultForResponse({ ...stored, index: 'baseline' }) })
    return
  }
  if (!/^\d{1,7}$/.test(rawIndex)) throw notFound('result not found')
  const index = Number(rawIndex)
  if (index >= (Number(meta.total) || 0)) throw notFound('result not found')
  const result = findResultByIndex(jobId, index)
  if (!result) throw notFound('result not found')
  sendJson(res, 200, { result: capResultForResponse(result) })
}

/**
 * POST /repeater/fuzz/:id/cancel — idempotent; a JSON body is required
 * (`{}` works). In-flight requests may finish and are still recorded.
 */
export async function handleFuzzCancel({ req, res, params }) {
  await readJsonBody(req)
  const jobId = decodeJobId(params[0])
  const active = activeJobs.get(jobId)
  if (active) {
    if (active.meta.status === 'running') requestStop(active, 'cancelled', 'cancelled')
    sendJson(res, 200, { jobId, status: active.meta.status })
    return
  }
  const meta = loadJobMeta(jobId)
  if (!meta) throw notFound('fuzz job not found')
  sendJson(res, 200, { jobId, status: meta.status })
}

/** GET /repeater/fuzz?limit=20 -> newest-first job summaries. */
export function handleFuzzList({ res, searchParams }) {
  const limit = queryInt(searchParams, 'limit', { min: 1, max: JOBS_MAX_LIMIT }) ?? JOBS_DEFAULT_LIMIT
  /** @type {Record<string, any>[]} */
  const metas = []
  let names = []
  try {
    names = readdirSync(fuzzStateDir())
  } catch {
    names = []
  }
  for (const name of names) {
    if (!JOB_ID_RE.test(name)) continue
    const active = activeJobs.get(name)
    if (active) {
      metas.push(active.meta)
      continue
    }
    const meta = loadJobMeta(name)
    if (meta) metas.push(meta)
  }
  metas.sort((left, right) => {
    const byCreated = String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
    return byCreated !== 0 ? byCreated : String(left.jobId).localeCompare(String(right.jobId))
  })
  sendJson(res, 200, { jobs: metas.slice(0, limit).map(jobListSummary) })
}

/** GET /repeater/fuzz/:id/export?format=csv|json -> writes a real file. */
export function handleFuzzExport({ res, searchParams, params }) {
  const jobId = decodeJobId(params[0])
  const format = queryEnum(searchParams, 'format', EXPORT_FORMATS)
  if (format === undefined) {
    throw badRequest('format is required', { param: 'format', allowed: EXPORT_FORMATS })
  }
  const { meta } = requireJob(jobId)

  /** @type {Record<string, any>[]} */
  const summaries = []
  /** @type {{index:number, row:string}[]} */
  const csvRows = []
  forEachResultLine(jobId, (result) => {
    const summary = resultSummary(result)
    if (!Number.isInteger(summary.index) || summary.index < 0) return true
    summaries.push(summary)
    if (format === 'csv') csvRows.push({ index: summary.index, row: csvRowForResult(result) })
    return true
  })
  summaries.sort((left, right) => left.index - right.index)
  csvRows.sort((left, right) => left.index - right.index)

  const dir = exportsDir()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\..+$/, '')
  const filePath = join(dir, `${jobId}-${stamp}.${format}`)

  if (format === 'csv') {
    const lines = [CSV_HEADER, ...csvRows.map((entry) => entry.row)]
    writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
  } else {
    const payload = { job: jobSummary(meta), results: summaries }
    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
  }

  sendJson(res, 200, {
    savedPaths: [filePath],
    format,
    count: summaries.length,
  })
}

/* ------------------------------------------------------------------------- */
/* Shared job summary shapes                                                 */
/* ------------------------------------------------------------------------- */

/** Full `job` object of GET /repeater/fuzz/:id (contract shape). */
function jobSummary(meta) {
  return {
    jobId: String(meta.jobId),
    vulnId: String(meta.vulnId || ''),
    mode: String(meta.mode || ''),
    status: String(meta.status || ''),
    total: Number(meta.total) || 0,
    completed: Number(meta.completed) || 0,
    failed: Number(meta.failed) || 0,
    concurrency: Number(meta.concurrency) || 1,
    delayMs: Number(meta.delayMs) || 0,
    followRedirects: meta.followRedirects === true,
    stopOnConsecutiveErrors: meta.stopOnConsecutiveErrors === true,
    createdAt: meta.createdAt ?? null,
    startedAt: meta.startedAt ?? null,
    finishedAt: meta.finishedAt ?? null,
    stoppedReason: meta.stoppedReason ?? null,
    target: meta.target && typeof meta.target === 'object' ? meta.target : { method: '', url: '', origin: '' },
    baseline: meta.baseline ?? null,
    positions: Number(meta.positions) || 0,
    payloadBytes: Number(meta.payloadBytes) || 0,
  }
}

/** Row of GET /repeater/fuzz (contract shape). */
function jobListSummary(meta) {
  return {
    jobId: String(meta.jobId),
    vulnId: String(meta.vulnId || ''),
    mode: String(meta.mode || ''),
    status: String(meta.status || ''),
    total: Number(meta.total) || 0,
    completed: Number(meta.completed) || 0,
    failed: Number(meta.failed) || 0,
    createdAt: meta.createdAt ?? null,
    finishedAt: meta.finishedAt ?? null,
    stoppedReason: meta.stoppedReason ?? null,
    targetUrl: meta.target && typeof meta.target.url === 'string' ? meta.target.url : '',
  }
}

/* ------------------------------------------------------------------------- */
/* CSV export helpers                                                        */
/* ------------------------------------------------------------------------- */

/** @param {unknown} value */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** One CSV data row: index,payload,status,length,duration_ms,error */
function csvRowForResult(result) {
  const summary = resultSummary(result)
  const payload = Array.isArray(result.payloads) ? result.payloads.join(' | ') : ''
  return [
    csvCell(summary.index),
    csvCell(payload),
    summary.status === null || summary.status === undefined ? '' : csvCell(summary.status),
    summary.length === null || summary.length === undefined ? '' : csvCell(summary.length),
    summary.durationMs === null || summary.durationMs === undefined
      ? ''
      : csvCell(summary.durationMs),
    csvCell(summary.error === null || summary.error === undefined ? '' : summary.error),
  ].join(',')
}
