/**
 * Client for the single-Repeater history / favorites Host routes.
 *
 * The routes live under the same `/cortex-api/cortex` surface but are not part
 * of `CortexApi`; the dialogs use these plain same-origin fetches.
 */
import type { RepeaterSendResult } from '@shared/repeater'

const API_BASE = '/cortex-api/cortex'

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

interface ApiErrorPayload {
  error?: unknown
  message?: unknown
  code?: unknown
  details?: unknown
}

/** Stable client error: `code` mirrors the Host error envelope when present. */
export class RepeaterStoreApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'RepeaterStoreApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof RepeaterStoreApiError) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return typeof error === 'string' && error !== '' ? error : 'Unknown error'
}

export { errorMessage as repeaterStoreErrorMessage }

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
    throw new RepeaterStoreApiError('NETWORK_ERROR', detail, 0)
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
    throw new RepeaterStoreApiError(code, message, response.status, envelope.details)
  }

  return payload as T
}

const encodeId = (value: string): string => encodeURIComponent(value)

function unwrapItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (payload !== null && typeof payload === 'object') {
    const items = (payload as { items?: unknown }).items
    if (Array.isArray(items)) return items as T[]
  }
  return []
}

export function listRepeaterHistory(limit = 20): Promise<RepeaterHistoryEntry[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)))
  return requestJson<unknown>(`/repeater/history?limit=${safeLimit}`).then((payload) =>
    unwrapItems<RepeaterHistoryEntry>(payload)
  )
}

export function clearRepeaterHistory(): Promise<boolean> {
  return requestJson<{ cleared?: boolean }>('/repeater/history', { method: 'DELETE' }).then(
    (payload) => payload.cleared === true
  )
}

export function listRepeaterCollections(): Promise<RepeaterCollectionEntry[]> {
  return requestJson<unknown>('/repeater/collections').then((payload) =>
    unwrapItems<RepeaterCollectionEntry>(payload)
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
