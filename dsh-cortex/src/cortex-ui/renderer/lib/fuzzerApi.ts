/**
 * Client for the retest Fuzzer host routes.
 *
 * The Fuzzer routes live under the same `/cortex-api/cortex` surface as the
 * rest of the web runtime but are intentionally NOT part of `CortexApi`: they
 * are plain same-origin fetches so the renderer works in both the DSH WebView
 * and the browser build without touching the preload bridge.
 */
import type { RepeaterSendResult } from '@shared/repeater'
import { FUZZ_MODES, FUZZ_JOB_STATUSES, type FuzzJobStatus, type FuzzMode } from './fuzz'

const API_BASE = '/cortex-api/cortex'

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

export interface FuzzHttpRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

export interface FuzzResponseSummary {
  status: number | null
  length: number | null
  durationMs: number | null
  error: string | null
  errorCode: string | null
  contentType: string
  truncated: boolean
}

export interface FuzzResultSummary extends FuzzResponseSummary {
  index: number
  payloadBrief: string
}

export interface FuzzJobTarget {
  method: string
  url: string
  origin: string
}

export interface FuzzJob {
  jobId: string
  vulnId: string
  mode: FuzzMode
  status: FuzzJobStatus
  total: number
  completed: number
  failed: number
  concurrency: number
  delayMs: number
  followRedirects: boolean
  stopOnConsecutiveErrors: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  stoppedReason: string | null
  target: FuzzJobTarget
  baseline: FuzzResponseSummary | null
  positions: number
  payloadBytes: number
}

export interface FuzzJobPage {
  job: FuzzJob
  offset: number
  limit: number
  /** Total stored results for the job (the page itself holds `results`). */
  count: number
  results: FuzzResultSummary[]
}

export interface FuzzHttpResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  bodyBytes: number
  truncated: boolean
  durationMs: number
  contentType: string
}

export interface FuzzResultDetail {
  index: number
  payloadBrief: string
  payloads: string[]
  request: FuzzHttpRequest
  /** Null for validation / network errors. */
  response: FuzzHttpResponse | null
  error: string | null
  errorCode: string | null
}

export interface FuzzCreateInput {
  vulnId: string
  request: FuzzHttpRequest
  attack: {
    mode: FuzzMode
    payloadSets: string[][]
  }
  options: {
    concurrency: number
    delayMs: number
    followRedirects: boolean
    stopOnConsecutiveErrors: boolean
  }
}

export interface FuzzCreateResult {
  jobId: string
  total: number
  mode: FuzzMode
  status: FuzzJobStatus
  baseline: FuzzResponseSummary | null
}

export interface FuzzHistoryItem {
  jobId: string
  vulnId: string
  mode: FuzzMode
  status: FuzzJobStatus
  total: number
  completed: number
  failed: number
  createdAt: string
  finishedAt: string | null
  stoppedReason: string | null
  targetUrl: string
}

export type FuzzExportFormat = 'csv' | 'json'

export interface FuzzExportResult {
  savedPaths: string[]
  format: FuzzExportFormat
  count: number
}

export interface FuzzCancelResult {
  jobId: string
  status: FuzzJobStatus
}

/* Single-Repeater history / collections (same routes, shared shapes). */

export type RepeaterStoredRequest = RepeaterSendResult['request']
export type RepeaterStoredResponse = RepeaterSendResult['response']

export interface RepeaterHistoryEntry {
  id: string
  createdAt: string
  vulnId: string
  raw: string
  request: RepeaterStoredRequest
  response: RepeaterStoredResponse | null
}

export interface RepeaterCollectionEntry {
  id: string
  name: string
  createdAt: string
  vulnId: string
  raw: string
  request: RepeaterStoredRequest
  response: RepeaterStoredResponse | null
}

export interface SaveRepeaterCollectionInput {
  name: string
  vulnId: string
  raw: string
  request: RepeaterStoredRequest
  response?: RepeaterStoredResponse | null
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

interface ApiErrorPayload {
  error?: unknown
  message?: unknown
  code?: unknown
  details?: unknown
}

/** Stable client error: `code` mirrors the Host error envelope when present. */
export class FuzzerApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'FuzzerApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Readable message for toasts / inline errors. */
export function fuzzerErrorMessage(error: unknown): string {
  if (error instanceof FuzzerApiError) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return typeof error === 'string' && error !== '' ? error : 'Unknown error'
}

/* -------------------------------------------------------------------------- */
/* Fetch plumbing                                                              */
/* -------------------------------------------------------------------------- */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? 'GET' }
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(options.body)
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, init)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new FuzzerApiError('NETWORK_ERROR', detail, 0)
  }

  const text = await response.text().catch(() => '')
  let payload: unknown = null
  if (text !== '') {
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as ApiErrorPayload
    const message =
      typeof envelope.error === 'string' && envelope.error !== ''
        ? envelope.error
        : typeof envelope.message === 'string' && envelope.message !== ''
          ? envelope.message
          : `HTTP ${response.status}`
    const code =
      typeof envelope.code === 'string' && envelope.code !== ''
        ? envelope.code
        : `HTTP_${response.status}`
    throw new FuzzerApiError(code, message, response.status, envelope.details)
  }

  return payload as T
}

const encodeId = (value: string): string => encodeURIComponent(value)

function unwrapArray<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (payload !== null && typeof payload === 'object') {
    const record = payload as { items?: unknown; jobs?: unknown }
    if (Array.isArray(record.jobs)) return record.jobs as T[]
    if (Array.isArray(record.items)) return record.items as T[]
  }
  return []
}

/* -------------------------------------------------------------------------- */
/* Fuzzer API                                                                  */
/* -------------------------------------------------------------------------- */

export function isFuzzMode(value: string): value is FuzzMode {
  return (FUZZ_MODES as readonly string[]).includes(value)
}

export function isFuzzJobStatus(value: string): value is FuzzJobStatus {
  return (FUZZ_JOB_STATUSES as readonly string[]).includes(value)
}

/** POST /repeater/fuzz — starts a background job, returns its id/total. */
export function createFuzzJob(input: FuzzCreateInput): Promise<FuzzCreateResult> {
  return requestJson<FuzzCreateResult>('/repeater/fuzz', { method: 'POST', body: input })
}

/** GET /repeater/fuzz/:id?offset=&limit= — job counters + result page. */
export function getFuzzJob(
  jobId: string,
  options: { offset?: number; limit?: number } = {}
): Promise<FuzzJobPage> {
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 200)))
  return requestJson<FuzzJobPage>(
    `/repeater/fuzz/${encodeId(jobId)}?offset=${offset}&limit=${limit}`
  )
}

/** GET /repeater/fuzz/:id/results/:index — full replaced request/response. */
export function getFuzzResult(
  jobId: string,
  index: number | 'baseline'
): Promise<FuzzResultDetail> {
  return requestJson<{ result: FuzzResultDetail }>(
    `/repeater/fuzz/${encodeId(jobId)}/results/${encodeId(String(index))}`
  ).then((payload) => payload.result)
}

/** POST /repeater/fuzz/:id/cancel — idempotent stop that keeps produced results. */
export function cancelFuzzJob(jobId: string): Promise<FuzzCancelResult> {
  return requestJson<FuzzCancelResult>(`/repeater/fuzz/${encodeId(jobId)}/cancel`, {
    method: 'POST',
    body: {}
  })
}

/** GET /repeater/fuzz?limit=20 — newest-first job history. */
export function listFuzzJobs(limit = 20): Promise<FuzzHistoryItem[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  return requestJson<unknown>(`/repeater/fuzz?limit=${safeLimit}`).then((payload) =>
    unwrapArray<FuzzHistoryItem>(payload)
  )
}

/** GET /repeater/fuzz/:id/export?format= — Host writes the file, returns paths. */
export function exportFuzzJob(
  jobId: string,
  format: FuzzExportFormat
): Promise<FuzzExportResult> {
  return requestJson<FuzzExportResult>(
    `/repeater/fuzz/${encodeId(jobId)}/export?format=${format}`
  )
}

/* -------------------------------------------------------------------------- */
/* Single-Repeater history / collections                                       */
/* -------------------------------------------------------------------------- */

export function listRepeaterHistory(limit = 20): Promise<RepeaterHistoryEntry[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)))
  return requestJson<unknown>(`/repeater/history?limit=${safeLimit}`).then((payload) =>
    unwrapArray<RepeaterHistoryEntry>(payload)
  )
}

export function clearRepeaterHistory(): Promise<boolean> {
  return requestJson<{ cleared?: boolean }>('/repeater/history', { method: 'DELETE' }).then(
    (payload) => payload.cleared === true
  )
}

export function listRepeaterCollections(): Promise<RepeaterCollectionEntry[]> {
  return requestJson<unknown>('/repeater/collections').then((payload) =>
    unwrapArray<RepeaterCollectionEntry>(payload)
  )
}

export function saveRepeaterCollection(
  input: SaveRepeaterCollectionInput
): Promise<RepeaterCollectionEntry> {
  return requestJson<{ item: RepeaterCollectionEntry }>('/repeater/collections', {
    method: 'POST',
    body: input
  }).then((payload) => payload.item)
}

export function deleteRepeaterCollection(id: string): Promise<boolean> {
  return requestJson<{ deleted?: boolean }>(
    `/repeater/collections/${encodeId(id)}`,
    { method: 'DELETE' }
  ).then((payload) => payload.deleted === true)
}
