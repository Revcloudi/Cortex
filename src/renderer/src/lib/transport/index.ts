import type { CortexApi } from '@shared/ipc'
import { createHttpApi } from './httpClient'

/**
 * Renderer transport selection.
 *
 * The Electron renderer receives `window.api` from the preload bridge; the
 * `ctx web` build has no preload, so it talks to the same-origin HTTP server
 * instead. `VITE_CORTEX_RUNTIME` is injected at build time by
 * `vite.web.config.ts`, so the desktop bundle keeps its previous behavior.
 */

/** True when this bundle was built for the browser (`ctx web`) runtime. */
export const IS_WEB_RUNTIME: boolean = import.meta.env.VITE_CORTEX_RUNTIME === 'web'

/** Cookies still apply after a reload, so one client instance is enough. */
let httpApi: CortexApi | null = null

function getHttpApi(): CortexApi {
  if (httpApi === null) httpApi = createHttpApi()
  return httpApi
}

/**
 * The API used by every hook/page: the Electron preload bridge wins whenever it
 * exists (desktop, including `electron-vite dev`), otherwise the Web build gets
 * the HTTP transport. `null` means "no backend in this environment" and call
 * sites render their existing error state.
 */
export function getApi(): CortexApi | null {
  if (typeof window !== 'undefined') {
    const embedded = (window as unknown as { api?: CortexApi }).api
    if (embedded !== undefined) return embedded
  }
  return IS_WEB_RUNTIME ? getHttpApi() : null
}
