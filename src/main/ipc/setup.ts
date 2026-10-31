import { join } from 'node:path'
import { app } from 'electron'
import { buildSetupInfo as buildSetupInfoCore, defaultUiLanguageFromLocale, runSetupCore } from '../../cli/setupInfo'
import type { CliRuntime } from '../../cli/runtime'
import type { SetupInfo, SetupRunRequest, SetupRunResult } from '../../shared/types'
import { logger } from '../logger'
import { developmentNodeCommand, installedRoot, nodeExecutableName } from '../runtimePaths'

/**
 * First-run setup bridge (Electron side).
 *
 * The behaviour lives in `src/cli/setupInfo.ts` so the `ctx web` server can
 * reuse exactly the same detection and `ctx init` flow. This wrapper only adds
 * the Electron-specific runtime (asar/app-path) and OS locale.
 */

/** Renderer-facing detection; `defaultUiLanguage` follows the OS locale. */
export function buildSetupInfo(env: NodeJS.ProcessEnv = process.env): SetupInfo {
  let locale = 'en'
  try {
    locale = app.getLocale()
  } catch {
    // Electron app not ready yet (tests / headless import): fall back to English.
  }
  return buildSetupInfoCore(env, {
    defaultUiLanguage: defaultUiLanguageFromLocale(locale)
  })
}

/** Run `ctx init` in-process with the packaged/source runtime of this build. */
export async function runSetup(
  request: SetupRunRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<SetupRunResult> {
  const result = await runSetupCore(request, env, {
    runtime: buildSetupRuntime(env),
    log: (message: string) => logger.info(message)
  })
  if (!result.success) logger.warn('[setup] ctx init failed')
  return result
}

/**
 * Explicit CLI runtime for the running app.
 *
 * `runInit` cannot auto-detect this one: inside Electron the "script path" is
 * the asar bundle, so the GUI must state where the MCP/CLI bundles and the
 * language-scoped skill sources live.
 */
export function buildSetupRuntime(env: NodeJS.ProcessEnv = process.env): CliRuntime {
  if (app.isPackaged) {
    const root = installedRoot()
    const binDir = join(root, 'bin')
    return {
      mode: 'installed',
      nodeExecutable: join(binDir, nodeExecutableName()),
      mcpEntry: join(binDir, 'mcp-stdio.cjs'),
      cliEntry: join(binDir, 'ctx.cjs'),
      root,
      skillSourceDir: join(binDir, 'skills')
    }
  }

  const projectRoot = app.getAppPath()
  return {
    mode: 'development',
    nodeExecutable: developmentNodeCommand(env),
    mcpEntry: join(projectRoot, 'out', 'mcp', 'stdio.cjs'),
    cliEntry: join(projectRoot, 'out', 'cli', 'ctx.cjs'),
    root: projectRoot,
    skillSourceDir: join(projectRoot, 'skills')
  }
}
