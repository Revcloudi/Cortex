/**
 * Typed client for the mini-program reverse-engineering routes.
 *
 * Contract: `.tmp/miniapp-contract.md` §3.7 — every route lives under
 * `/cortex-api/cortex`, talks JSON and uses the host `{error, code}` envelope
 * for non-2xx responses. The page calls these wrappers directly (instead of
 * `CortexApi`) because the miniapp feature is plugin-host-only and does not
 * exist in the upstream Cortex IPC surface.
 */

const BASE = '/cortex-api/cortex'

export class MiniappApiError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'MiniappApiError'
    this.code = code
  }
}

export type MiniappStatus = 'detected' | 'decrypting' | 'unpacked' | 'unsupported' | 'failed'

export const MINIAPP_STATUSES: readonly MiniappStatus[] = [
  'detected',
  'decrypting',
  'unpacked',
  'unsupported',
  'failed'
]

export type MiniappFormat = 'plain' | 'v1mmwx' | 'unknown'

export type MiniappKind = 'app' | 'plugin' | 'library' | 'unknown'

/** One detected package group (all packages of one appid+version). */
export interface MiniappRow {
  id: string
  appid: string
  app_name: string
  kind?: MiniappKind
  version: string
  root_kind: string
  package_dir: string
  size_bytes: number
  file_count: number
  format: MiniappFormat | string
  status: MiniappStatus
  unpacked_path: string
  error: string
  detected_at: string
  updated_at: string
  version_count?: number
  is_latest?: boolean
  has_analysis?: boolean
  /** Number of WeChat user-cache copies collapsed into this row. */
  source_count?: number
}

export interface MiniappListResponse {
  miniapps: MiniappRow[]
  total: number
  appCount: number
  customRoots: string[]
  workspaceRoot: string
  lastScanAt: string | null
}

export interface MiniappScanError {
  root?: string
  path?: string
  message: string
}

export interface MiniappScanResponse {
  ok: boolean
  scannedAt: string
  totalSources: number
  totalPackages: number
  added: number
  updated: number
  unchanged: number
  errors: MiniappScanError[]
  miniapps: MiniappRow[]
}

export interface MiniappRoot {
  kind: string
  path: string
  label: string
  exists: boolean
}

export interface MiniappRootsResponse {
  roots: MiniappRoot[]
  customRoots: string[]
}

export interface MiniappVersion {
  id: string
  version: string
  status: MiniappStatus
  format: string
  size_bytes: number
  file_count: number
  updated_at: string
  unpacked_path: string
  source_count?: number
}

export interface MiniappManifestTotals {
  packages?: number
  files?: number
  bytes?: number
  skipped?: number
  conflicts?: number
  unsupportedPackages?: number
}

export interface MiniappManifest {
  appid?: string
  version?: string
  generatedAt?: string
  packages?: Array<{ file: string; size: number; format: string; entries: number; bytes: number }>
  totals?: MiniappManifestTotals
  files?: Array<{ path: string; size: number }>
  conflicts?: Array<{ path: string; keptFrom: string; ignoredFrom: string }>
  error?: string
}

export interface MiniappFileStats {
  total: number
  text: number
  binary: number
  bytes: number
}

export interface MiniappAnalysis {
  appid: string
  version: string
  generatedAt: string
  files: MiniappFileStats
  byExtension: Array<{ ext: string; count: number; bytes: number }>
  pages: string[]
  subPackages: Array<{ root: string; pages: string[] }>
  domains: Array<{ host: string; count: number; examples: string[]; files: string[] }>
  endpoints: Array<{ path: string; method?: string; count: number; files: string[] }>
  secrets: Array<{
    info_type: string
    name: string
    value_masked: string
    value?: string
    source: string
    line: number
    potential_impact?: string
  }>
  parameters: Array<{
    name: string
    endpoint: string
    location: string
    values: string[]
    pattern?: string
    source: string
  }>
  largestFiles: Array<{ path: string; size: number }>
  warnings: string[]
}

export interface MiniappExtractedCounts {
  domains: number
  endpoints: number
  secrets: number
  parameters: number
}

export interface MiniappDetailResponse {
  miniapp: MiniappRow & { versions: MiniappVersion[] }
  manifest: MiniappManifest | null
  analysis: MiniappAnalysis | null
  overviewText: string
  extractedCounts: MiniappExtractedCounts
}

export interface MiniappUnpackTotals {
  packages?: number
  files?: number
  bytes?: number
  skipped?: number
  conflicts?: number
}

export interface MiniappUnpackResponse {
  ok: boolean
  status: MiniappStatus
  miniapp: MiniappRow
  manifest: MiniappManifest | null
  totals: MiniappUnpackTotals
  error: string
}

export interface MiniappAnalyzeResponse {
  ok: boolean
  analysis: MiniappAnalysis | null
  overviewText: string
  counts: MiniappExtractedCounts
}

export interface MiniappTreeEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number
}

export interface MiniappTreeResponse {
  path: string
  entries: MiniappTreeEntry[]
}

export interface MiniappFileResponse {
  path: string
  content: string
  offset: number
  limit: number
  totalLines: number
  truncated: boolean
  size: number
  binary: boolean
  formatted?: boolean
  language?: string
}

export interface MiniappSearchMatch {
  file: string
  line: number
  text: string
}

export interface MiniappSearchResponse {
  matches: MiniappSearchMatch[]
  scanned: number
  truncated: boolean
  query: string
}

export interface MiniappImportAsset {
  host_port: string
  created: boolean
  interfaces: number
  leaks: number
  parameters: number
}

export interface MiniappImportResponse {
  ok: boolean
  project: string
  assets: MiniappImportAsset[]
  totals: { assets: number; interfaces: number; leaks: number; parameters: number }
  warnings: string[]
}

export interface MiniappOpenResponse {
  ok: boolean
  path: string
}

export interface MiniappListParams {
  search?: string
  status?: MiniappStatus | ''
}

function toQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const key of Object.keys(query)) {
    const value = query[key]
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

async function request<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const method = (init && init.method) || 'GET'
  const options: RequestInit = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  }
  if (init && init.json !== undefined) {
    options.body = JSON.stringify(init.json)
    ;(options.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  const response = await fetch(BASE + path, options)
  if (!response.ok) {
    let payload: {
      error?: string
      message?: string
      code?: string
      details?: { code?: string }
    } | null = null
    try {
      payload = await response.json()
    } catch {
      /* non-JSON error */
    }
    // The host envelope uses a generic `BAD_REQUEST` code and puts the specific
    // reason (e.g. `BINARY_FILE`) in `details.code`; prefer the specific one so
    // callers can branch on it without parsing messages.
    const specific = payload?.details?.code
    throw new MiniappApiError(
      String(payload?.error || payload?.message || `HTTP ${response.status}`),
      String(specific || payload?.code || `HTTP_${response.status}`)
    )
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

const encodeId = (id: string): string => encodeURIComponent(id)

export function listMiniapps(params: MiniappListParams = {}): Promise<MiniappListResponse> {
  return request<MiniappListResponse>(`/miniapps${toQuery({ search: params.search, status: params.status })}`)
}

export function scanMiniapps(customRoots: string[] = []): Promise<MiniappScanResponse> {
  return request<MiniappScanResponse>('/miniapps/scan', { method: 'POST', json: { customRoots } })
}

export function listMiniappRoots(): Promise<MiniappRootsResponse> {
  return request<MiniappRootsResponse>('/miniapps/roots')
}

export function setMiniappRoots(
  roots: string[],
  mode: 'replace' | 'append' = 'append'
): Promise<MiniappRootsResponse> {
  return request<MiniappRootsResponse>('/miniapps/roots', { method: 'POST', json: { roots, mode } })
}

export function getMiniapp(id: string): Promise<MiniappDetailResponse> {
  return request<MiniappDetailResponse>(`/miniapps/${encodeId(id)}`)
}

export function unpackMiniapp(id: string): Promise<MiniappUnpackResponse> {
  return request<MiniappUnpackResponse>(`/miniapps/${encodeId(id)}/unpack`, {
    method: 'POST',
    json: {}
  })
}

export function analyzeMiniapp(id: string): Promise<MiniappAnalyzeResponse> {
  return request<MiniappAnalyzeResponse>(`/miniapps/${encodeId(id)}/analyze`, {
    method: 'POST',
    json: {}
  })
}

export function getMiniappTree(id: string, path = ''): Promise<MiniappTreeResponse> {
  return request<MiniappTreeResponse>(`/miniapps/${encodeId(id)}/tree${toQuery({ path })}`)
}

export function readMiniappFile(
  id: string,
  path: string,
  offset = 0,
  limit = 200
): Promise<MiniappFileResponse> {
  return request<MiniappFileResponse>(
    `/miniapps/${encodeId(id)}/file${toQuery({ path, offset, limit })}`
  )
}

export interface MiniappSearchParams {
  query: string
  regex?: boolean
  glob?: string
  maxResults?: number
}

export function searchMiniappFiles(
  id: string,
  params: MiniappSearchParams
): Promise<MiniappSearchResponse> {
  return request<MiniappSearchResponse>(
    `/miniapps/${encodeId(id)}/search${toQuery({
      query: params.query,
      regex: params.regex ? 1 : 0,
      glob: params.glob,
      maxResults: params.maxResults
    })}`
  )
}

export function importMiniappAssets(
  id: string,
  input: { project_name?: string; host_port?: string } = {}
): Promise<MiniappImportResponse> {
  return request<MiniappImportResponse>(`/miniapps/${encodeId(id)}/import-assets`, {
    method: 'POST',
    json: input
  })
}

export function openMiniappDir(id: string): Promise<MiniappOpenResponse> {
  return request<MiniappOpenResponse>(`/miniapps/${encodeId(id)}/open`, {
    method: 'POST',
    json: {}
  })
}

export function renameMiniapp(id: string, appName: string): Promise<{ ok: boolean; miniapp: MiniappRow }> {
  return request<{ ok: boolean; miniapp: MiniappRow }>(`/miniapps/${encodeId(id)}/name`, {
    method: 'POST',
    json: { app_name: appName }
  })
}

export function toMiniappErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
