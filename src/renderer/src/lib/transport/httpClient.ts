import type { CortexApi } from '@shared/ipc'
import type {
  AppInfo,
  AssetContext,
  AssetFilters,
  AssetListItem,
  DashboardStats,
  DatabaseInfo,
  DeleteAssetResult,
  DeleteSnapshotResult,
  DeleteVulnResult,
  DeleteVulnsResult,
  ExportReportsResult,
  PaginatedVulnerabilities,
  SeedDemoResult,
  SetupInfo,
  SetupRunRequest,
  SetupRunResult,
  SnapshotListFilters,
  SnapshotListResult,
  SnapshotSession,
  UpdateVulnStatusRequest,
  Vulnerability,
  VulnerabilityListItem,
  VulnListQuery
} from '@shared/types'
import {
  WEB_API_PATHS,
  WEB_CHANGED_EVENT,
  type WebExportFile,
  type WebExportResponse
} from '@shared/web'

/**
 * Browser transport for `CortexApi`.
 *
 * Used only by the `ctx web` bundle (`VITE_CORTEX_RUNTIME === 'web'`); the
 * Electron renderer keeps talking to the main process through `window.api`.
 * Every call is same-origin and carries the session cookie
 * (`credentials: 'include'`), while the shared `WEB_API_PATHS` constants keep
 * the route names in sync with `src/server/routes.ts`.
 *
 * Desktop-only capabilities degrade here instead of failing at random call
 * sites: report export becomes a browser Blob download (the server writes
 * nothing), clipboard uses the browser API, window controls are no-ops and the
 * database picker rejects (the Web UI hides it; `ctx web --db` fixes the file).
 */

/** Shown when the session cookie is missing/expired (every route answers 401). */
const LOGIN_EXPIRED_MESSAGE = '登录已失效：请用 `ctx web` 打印的 token 链接重新打开页面。'

/** Desktop-only database actions; the Web UI never offers them. */
const WEB_DATABASE_LOCKED_MESSAGE =
  'Web 模式不支持切换数据库：数据库由运行 `ctx web` 的服务端通过 --db 指定。'

/** Clipboard fallback failure; `lib/clipboard.ts` turns this into a toast. */
const CLIPBOARD_WRITE_FAILED_MESSAGE = '无法写入剪贴板：浏览器拒绝了复制请求'

/** Markdown MIME type used for the browser-generated report downloads. */
const MARKDOWN_MIME_TYPE = 'text/markdown;charset=utf-8'

/** Delay between two programmatic downloads; browsers drop bursts of saves. */
const DOWNLOAD_STAGGER_MS = 200

/** Delay before releasing a Blob URL so the save is not cancelled. */
const DOWNLOAD_REVOKE_DELAY_MS = 1000

type QueryValue = string | number | boolean | undefined

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  query?: URLSearchParams
  /** Serialized as JSON with `Content-Type: application/json` when present. */
  body?: unknown
}

/** Query string from the defined entries only (`all` filters are sent as-is). */
function toQuery(entries: ReadonlyArray<readonly [string, QueryValue]>): URLSearchParams | undefined {
  const params = new URLSearchParams()
  let hasValue = false
  for (const [key, value] of entries) {
    if (value === undefined) continue
    params.set(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value))
    hasValue = true
  }
  return hasValue ? params : undefined
}

/** `{ error: string }` from the server when possible, otherwise `HTTP <status>`. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (text.trim() !== '') {
      const payload = JSON.parse(text) as { error?: unknown } | null
      const message = typeof payload?.error === 'string' ? payload.error.trim() : ''
      if (message !== '') return message
    }
  } catch {
    // Non-JSON error body: fall through to the generic status message.
  }
  return `HTTP ${response.status}`
}

/**
 * One JSON request against the local Web server.
 *
 * 401 is always the expired/missing session cookie; other failures surface the
 * server's user-safe `{ error }` text so the existing toasts stay meaningful.
 * 204 and empty bodies resolve `undefined`, matching void IPC handlers.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body } = options
  const search = query === undefined ? '' : query.toString()
  const headers: Record<string, string> = { Accept: 'application/json' }
  const init: RequestInit = { method, credentials: 'include', headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const response = await fetch(search === '' ? path : `${path}?${search}`, init)
  if (response.status === 401) throw new Error(LOGIN_EXPIRED_MESSAGE)
  if (!response.ok) throw new Error(await readErrorMessage(response))
  if (response.status === 204) return undefined as T

  const text = await response.text()
  if (text === '') return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

/** Save one report as a Markdown file (server-side disk stays untouched). */
function saveMarkdownFile(file: WebExportFile): void {
  const blob = new Blob([file.content], { type: MARKDOWN_MIME_TYPE })
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = file.filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), DOWNLOAD_REVOKE_DELAY_MS)
}

/** Sequential downloads: browsers silently drop a burst of `a.click()` saves. */
async function saveMarkdownFiles(files: readonly WebExportFile[]): Promise<void> {
  for (let index = 0; index < files.length; index += 1) {
    if (index > 0) await delay(DOWNLOAD_STAGGER_MS)
    saveMarkdownFile(files[index])
  }
}

/** `document.execCommand('copy')` fallback for insecure contexts (plain HTTP). */
function copyWithTextarea(text: string): boolean {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-9999px'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator.clipboard !== 'undefined' && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to the legacy copy path.
    }
  }
  if (!copyWithTextarea(text)) throw new Error(CLIPBOARD_WRITE_FAILED_MESSAGE)
}

/** SSE subscription; `EventSource` sends the same-origin session cookie itself. */
function onDataChanged(callback: () => void): () => void {
  const source = new EventSource(WEB_API_PATHS.events)
  const notify = (): void => callback()
  source.onmessage = notify
  source.addEventListener(WEB_CHANGED_EVENT, notify)
  return () => {
    source.close()
  }
}

/** Same-origin fetch + SSE implementation of the shared `CortexApi` contract. */
export function createHttpApi(): CortexApi {
  return {
    listVulnerabilities: (filters: VulnListQuery = {}) =>
      request<PaginatedVulnerabilities>(WEB_API_PATHS.vulnerabilities, {
        query: toQuery([
          ['search', filters.search],
          ['severity', filters.severity],
          ['status', filters.status],
          ['page', filters.page],
          ['pageSize', filters.pageSize]
        ])
      }),

    getVulnerability: (id: string) =>
      request<Vulnerability | null>(
        `${WEB_API_PATHS.vulnerabilities}/${encodeURIComponent(id)}`
      ),

    getStats: () => request<DashboardStats>(WEB_API_PATHS.stats),

    updateVulnerabilityStatus: (input: UpdateVulnStatusRequest) =>
      request<Vulnerability>(`${WEB_API_PATHS.vulnerabilities}/${encodeURIComponent(input.id)}/status`, {
        method: 'PATCH',
        body: { status: input.status }
      }),

    deleteVulnerability: (id: string) =>
      request<DeleteVulnResult>(`${WEB_API_PATHS.vulnerabilities}/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      }),

    deleteVulnerabilities: (ids: string[]) =>
      request<DeleteVulnsResult>(WEB_API_PATHS.vulnerabilitiesDelete, {
        method: 'POST',
        body: ids
      }),

    /**
     * Browser-side export: the server returns the Markdown bodies, the browser
     * saves them. Resolves the downloaded file names, or `cancelled` when there
     * was nothing to export (`files: []`).
     */
    exportVulnerabilities: async (ids: string[]): Promise<ExportReportsResult> => {
      const response = await request<WebExportResponse>(WEB_API_PATHS.vulnerabilitiesExport, {
        method: 'POST',
        body: ids
      })
      const files = Array.isArray(response?.files) ? response.files : []
      if (files.length === 0) return { cancelled: true, files: [] }
      await saveMarkdownFiles(files)
      return { cancelled: false, files: files.map((file) => file.filename) }
    },

    listAssets: (filters: AssetFilters = {}) =>
      request<AssetListItem[]>(WEB_API_PATHS.assets, {
        query: toQuery([
          ['search', filters.search],
          ['status', filters.status]
        ])
      }),

    getAssetDetail: (hostPort: string) =>
      request<AssetContext | null>(`${WEB_API_PATHS.assets}/${encodeURIComponent(hostPort)}`),

    getAssetRelatedVulnerabilities: (hostPort: string) =>
      request<VulnerabilityListItem[]>(
        `${WEB_API_PATHS.assets}/${encodeURIComponent(hostPort)}/related`
      ),

    deleteAsset: (hostPort: string) =>
      request<DeleteAssetResult>(`${WEB_API_PATHS.assets}/${encodeURIComponent(hostPort)}`, {
        method: 'DELETE'
      }),

    listSnapshots: (filters: SnapshotListFilters = {}) =>
      request<SnapshotListResult>(WEB_API_PATHS.snapshots, {
        query: toQuery([
          ['keyword', filters.keyword],
          ['rootsOnly', filters.rootsOnly],
          ['parentSessionId', filters.parentSessionId],
          ['includeArchived', filters.includeArchived],
          ['limit', filters.limit]
        ])
      }),

    getSnapshot: (sessionId: string) =>
      request<SnapshotSession | null>(`${WEB_API_PATHS.snapshots}/${encodeURIComponent(sessionId)}`),

    restoreSnapshotPrevious: (sessionId: string) =>
      request<SnapshotSession>(
        `${WEB_API_PATHS.snapshots}/${encodeURIComponent(sessionId)}/restore`,
        { method: 'POST' }
      ),

    archiveSnapshot: (sessionId: string, archived: boolean) =>
      request<SnapshotSession>(
        `${WEB_API_PATHS.snapshots}/${encodeURIComponent(sessionId)}/archive`,
        { method: 'POST', body: { archived } }
      ),

    deleteSnapshot: (sessionId: string) =>
      request<DeleteSnapshotResult>(`${WEB_API_PATHS.snapshots}/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE'
      }),

    getDatabaseInfo: () => request<DatabaseInfo>(WEB_API_PATHS.database),

    /** Desktop-only: the attached file is fixed by the server's `--db`. */
    chooseDatabase: () => Promise.reject(new Error(WEB_DATABASE_LOCKED_MESSAGE)),

    /** Desktop-only: restart `ctx web --db <path>` instead. */
    resetDatabase: () => Promise.reject(new Error(WEB_DATABASE_LOCKED_MESSAGE)),

    getAppInfo: () => request<AppInfo>(WEB_API_PATHS.app),

    getSetupInfo: () => request<SetupInfo>(WEB_API_PATHS.setup),

    runSetup: (setupRequest: SetupRunRequest) =>
      request<SetupRunResult>(WEB_API_PATHS.setup, { method: 'POST', body: setupRequest }),

    seedDemoData: () => request<SeedDemoResult>(WEB_API_PATHS.seedDemoData, { method: 'POST' }),

    writeClipboard,

    /** The browser has no frameless window: window chrome is hidden in Web mode. */
    minimizeWindow: () => Promise.resolve(),
    toggleMaximizeWindow: () => Promise.resolve(false),
    closeWindow: () => Promise.resolve(),
    isWindowMaximized: () => Promise.resolve(false),
    onWindowMaximizedChanged: () => () => {},

    onDataChanged
  }
}
