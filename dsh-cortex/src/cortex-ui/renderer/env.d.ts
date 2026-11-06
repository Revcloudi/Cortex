/// <reference types="vite/client" />

import type { PentestDataHubApi } from '@shared/ipc'

declare global {
  interface Window {
    api: PentestDataHubApi
  }

  interface ImportMetaEnv {
    /** `web` in the `ctx web` browser bundle; unset for the Electron renderer. */
    readonly VITE_CORTEX_RUNTIME?: string
  }
}

export {}
