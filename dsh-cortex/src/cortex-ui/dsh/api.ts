// CortexApi implementation for the DSH plugin.
//
// The vendored Cortex renderer expects the full `CortexApi` surface (formerly
// Electron preload IPC / `ctx web` HTTP). Every method here maps 1:1 onto the
// plugin Host's `/cortex-api/cortex/...` routes, which return the exact shapes
// declared in `src/cortex-ui/shared/*.ts`.
//
// This file is the only data-layer change of the port: the original renderer
// and pages stay untouched.
import type { CortexApi, DashboardStatsQuery } from '@shared/ipc'

const BASE = '/cortex-api/cortex'

class PluginApiError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'PluginApiError'
    this.code = code
  }
}

function toQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const key of Object.keys(query)) {
    const value = query[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.set(key, String(value))
    }
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

async function request(path: string, init?: RequestInit & { json?: unknown }): Promise<any> {
  const options: RequestInit = {
    method: (init && init.method) || 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  }
  if (init && init.json !== undefined) {
    options.body = JSON.stringify(init.json)
    ;(options.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  if (init && init.headers) options.headers = { ...(options.headers as object), ...(init.headers as object) }
  const response = await fetch(BASE + path, options)
  if (!response.ok) {
    let payload: any = null
    try {
      payload = await response.json()
    } catch {
      /* non-JSON error */
    }
    const message =
      (payload && (payload.error || payload.message)) ||
      (response.status === 401 ? 'database session invalid' : `HTTP ${response.status}`)
    throw new PluginApiError(String(message), (payload && payload.code) || `HTTP_${response.status}`)
  }
  if (response.status === 204) return undefined
  const text = await response.text()
  if (!text) return undefined
  return JSON.parse(text)
}

const get = (path: string, query?: Record<string, unknown>) => request(path + toQuery(query))
const post = (path: string, json: unknown) => request(path, { method: 'POST', json })
const patch = (path: string, json: unknown) => request(path, { method: 'PATCH', json })
const del = (path: string) => request(path, { method: 'DELETE' })

/** Poll interval for the renderer's `onDataChanged` subscription. */
const REVISION_POLL_MS = 1500

export function createCortexApi(): CortexApi {
  const changeListeners = new Set<() => void>()
  let revisionTimer: number | undefined
  let lastRevision: number | null = null
  let polling = false

  const pollRevision = async (): Promise<void> => {
    if (!polling) return
    try {
      const payload = await get('/rev')
      const revision = payload && typeof payload.rev === 'number' ? payload.rev : 0
      if (lastRevision !== null && revision !== lastRevision) {
        for (const listener of changeListeners) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-cortex] data-change listener failed', error)
          }
        }
      }
      lastRevision = revision
    } catch {
      /* host not ready yet */
    }
    if (polling) revisionTimer = window.setTimeout(pollRevision, REVISION_POLL_MS)
  }

  const api: CortexApi = {
    // ---------------------------------------------------------- vulnerabilities
    listVulnerabilities: (filters) => get('/vulns', filters as Record<string, unknown>),
    getVulnerability: (id) => get(`/vulns/${encodeURIComponent(id)}`),
    getStats: (query?: DashboardStatsQuery) => get('/stats', query as Record<string, unknown>),
    updateVulnerabilityStatus: (input) =>
      patch(`/vulns/${encodeURIComponent(input.id)}/status`, { status: input.status }),
    deleteVulnerability: (id) => del(`/vulns/${encodeURIComponent(id)}`),
    deleteVulnerabilities: (ids) => post('/vulns/delete-many', { ids }),
    exportVulnerabilities: async (ids, options) => {
      const outputDir = options?.outputDir?.trim()
      const format = options?.format
      const response = await post('/vulns/export', {
        ids,
        ...(outputDir ? { outputDir } : {}),
        ...(format ? { format } : {}),
      })
      const files = Array.isArray(response?.files) ? response.files : []
      const savedPaths = Array.isArray(response?.savedPaths) ? response.savedPaths : []
      return {
        cancelled: response?.cancelled === true || files.length === 0,
        files: files.map((file) => (file && typeof file.filename === 'string' ? file.filename : String(file))),
        savedPaths: savedPaths.filter((path) => typeof path === 'string'),
      }
    },

    // ---------------------------------------------------------------- assets
    listAssets: (filters) => get('/assets', filters as Record<string, unknown>),
    getAssetDetail: (hostPort) => get(`/assets/${encodeURIComponent(hostPort)}`),
    getAssetRelatedVulnerabilities: (hostPort) =>
      get(`/assets/${encodeURIComponent(hostPort)}/related-vulns`),
    deleteAsset: (hostPort) => del(`/assets/${encodeURIComponent(hostPort)}`),

    // ------------------------------------------------------------- snapshots
    listSnapshots: (filters) => get('/snapshots', filters as Record<string, unknown>),
    getSnapshot: (sessionId) => get(`/snapshots/${encodeURIComponent(sessionId)}`),
    archiveSnapshot: (sessionId, archived) =>
      post(`/snapshots/${encodeURIComponent(sessionId)}/archive`, { archived }),
    deleteSnapshot: (sessionId) => del(`/snapshots/${encodeURIComponent(sessionId)}`),
    restoreSnapshotPrevious: (sessionId) =>
      post(`/snapshots/${encodeURIComponent(sessionId)}/restore-previous`, {}),

    // -------------------------------------------------------------- internal
    getInternalOverview: (input) => get('/internal/overview', input as Record<string, unknown>),
    getInternalGraph: (input) => get('/internal/graph', input as Record<string, unknown>),
    getInternalProjects: () => get('/internal/projects'),
    recordCredentialTrial: (input) => post('/internal/credential-trial', input),
    listLootImports: (input) => get('/loot', input as Record<string, unknown>),
    importLoot: (input) => post('/loot/import', input),

    // ------------------------------------------------------------- nebula
    getMemoryGraph: (query) => post('/graph', query),

    // ---------------------------------------------------------------- misc
    getDatabaseInfo: () => get('/db/info'),
    chooseDatabase: () => Promise.reject(new PluginApiError('数据库由 DSH 插件 Host 固定为本机 ~/.cortex/data.db', 'UNSUPPORTED')),
    resetDatabase: () => Promise.reject(new PluginApiError('数据库由 DSH 插件 Host 固定为本机 ~/.cortex/data.db', 'UNSUPPORTED')),
    getAppInfo: () => get('/app/info'),
    getSetupInfo: () => get('/setup/info'),
    runSetup: (input) => post('/setup/run', input),
    seedDemoData: () => post('/seed-demo', {}),
    writeClipboard: async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        throw new PluginApiError('无法写入剪贴板', 'CLIPBOARD')
      }
    },
    minimizeWindow: async () => {},
    toggleMaximizeWindow: async () => false,
    closeWindow: async () => {},
    isWindowMaximized: async () => false,
    onWindowMaximizedChanged: () => () => {},
    onDataChanged: (callback: () => void) => {
      changeListeners.add(callback)
      if (!polling) {
        polling = true
        void pollRevision()
      }
      return () => {
        changeListeners.delete(callback)
        if (changeListeners.size === 0) {
          polling = false
          if (revisionTimer !== undefined) {
            window.clearTimeout(revisionTimer)
            revisionTimer = undefined
          }
        }
      }
    },

    // ---------------------------------------------------------------- poc
    getPocConfig: () => get('/poc/config'),
    savePocConfig: (input) => post('/poc/config', input),
    reloadPocConfig: () => post('/poc/reload', {}),
    upsertPocProvider: (input) => post('/poc/providers', input),
    removePocProvider: (id) => del(`/poc/providers/${encodeURIComponent(id)}`),
    listPocModels: (input) => post('/poc/models', input),
    testPocProvider: (input) => post('/poc/provider-test', input),
    sendRepeaterRequest: async (input) => {
      const response = await post('/repeater/send', input)
      return response
    },
  }
  return api
}
