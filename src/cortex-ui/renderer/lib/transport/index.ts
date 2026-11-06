import type { CortexApi } from '@shared/ipc'
import { createCortexApi } from '../../../dsh/api'

/**
 * Transport selection for the DSH plugin port.
 *
 * The original Cortex renderer picks the Electron preload bridge when present
 * and the `ctx web` HTTP transport otherwise. In DeepSeek Harness there is no
 * preload bridge: the plugin Host exposes the same data through
 * `/cortex-api/cortex/...`, so this module always returns that transport and
 * reports the Web-runtime behavior (no window chrome, read-only DB picker).
 */
export const IS_WEB_RUNTIME = true

let pluginApi: CortexApi | null = null

export function getApi(): CortexApi | null {
  if (pluginApi === null) pluginApi = createCortexApi()
  return pluginApi
}
