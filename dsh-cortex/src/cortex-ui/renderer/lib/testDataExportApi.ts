/**
 * Same-origin client for the Host project-export and bulk-delete routes.
 *
 * These routes are plugin additions and not part of the vendored `CortexApi`
 * interface, so the asset page uses this small typed client instead of
 * widening the shared IPC surface.
 */

const API_BASE = '/cortex-api/cortex'

export type TestDataExportFormat = 'json' | 'csv' | 'defectdojo'

export interface TestDataExportInput {
  project_name?: string
  format: TestDataExportFormat
  asset_ids?: string[]
  vuln_ids?: string[]
  include_evidence?: boolean
  include_secrets?: boolean
  output_dir?: string
}

export interface TestDataExportResult {
  ok: true
  format: TestDataExportFormat
  files: Array<{ name: string; format: string; bytes: number }>
  savedPaths: string[]
  counts: {
    assets: number
    vulnerabilities: number
    evidence: number
    relationships: number
    missing_assets?: number
  }
  warnings: string[]
  directory?: string
}

export interface BulkDeleteAssetsResult {
  deleted: number
  missing: string[]
}

interface ApiErrorPayload {
  error?: unknown
  message?: unknown
  code?: unknown
  details?: unknown
}

export class TestDataExportError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'TestDataExportError'
    this.code = code
    this.status = status
    this.details = details
  }
}

async function requestJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (cause) {
    throw new TestDataExportError(
      'NETWORK_ERROR',
      cause instanceof Error ? cause.message : String(cause),
      0
    )
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
    throw new TestDataExportError(code, message, response.status, envelope.details)
  }
  return payload as T
}

/** POST /export/project: export all data owned by one project. */
export function exportProjectData(input: TestDataExportInput): Promise<TestDataExportResult> {
  return requestJson<TestDataExportResult>('/export/project', input)
}

/** POST /export/assets: export an explicit asset/finding selection. */
export function exportSelectedAssets(input: TestDataExportInput): Promise<TestDataExportResult> {
  return requestJson<TestDataExportResult>('/export/assets', input)
}

/** POST /assets/bulk-delete: delete only selected asset rows + sidecars. */
export function deleteSelectedAssets(assetIds: string[]): Promise<BulkDeleteAssetsResult> {
  return requestJson<BulkDeleteAssetsResult>('/assets/bulk-delete', { asset_ids: assetIds })
}

/** Read the Host-remembered export directory (best effort, never throws). */
export async function readRememberedExportDir(): Promise<string> {
  try {
    const response = await fetch(`${API_BASE}/export/settings`, {
      credentials: 'same-origin',
      cache: 'no-store'
    })
    if (!response.ok) return ''
    const payload = (await response.json().catch(() => null)) as { outputDir?: unknown } | null
    return payload && typeof payload.outputDir === 'string' ? payload.outputDir.trim() : ''
  } catch {
    return ''
  }
}

export function testDataExportErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  return 'Unknown error'
}
