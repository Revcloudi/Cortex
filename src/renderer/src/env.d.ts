/// <reference types="vite/client" />

import type { PentestDataHubApi } from '@shared/ipc'

declare global {
  interface Window {
    api: PentestDataHubApi
  }
}

export {}
