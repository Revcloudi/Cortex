import { buildSetupInfo, defaultUiLanguageFromEnv, resolveSetupRuntime, runSetupCore } from '../cli/setupInfo'
import type { SetupInfo, SetupRunRequest, SetupRunResult } from '../shared/types'

/**
 * First-run setup for the Web server.
 *
 * `ctx web` runs in a plain Node process, so it reuses the same electron-free
 * implementation as the desktop wizard (`src/cli/setupInfo.ts`). The runtime is
 * resolved from the running `ctx` bundle (source checkout or installed layout),
 * which is exactly what `ctx init` would use when launched from the same build.
 *
 * POST /api/setup writes agent config files on the machine that runs the
 * server; the Web UI asks the operator to confirm before calling it.
 */

export function getWebSetupInfo(env: NodeJS.ProcessEnv = process.env): SetupInfo {
  return buildSetupInfo(env, { defaultUiLanguage: defaultUiLanguageFromEnv(env) })
}

export async function runWebSetup(
  request: SetupRunRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<SetupRunResult> {
  return runSetupCore(request, env, { runtime: resolveSetupRuntime(env) })
}
