import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CAC } from 'cac'
import { createCliContext, type CliContext } from '../context'
import { envOverride } from '../env'
import { CliError } from '../errors'
import { resolveCliRuntime } from '../runtime'

/**
 * `ctx open` — launch or focus the Cortex desktop UI.
 *
 * Resolution order (the first existing executable wins):
 * 1. `--path <exe>`
 * 2. `CTX_UI_EXE` environment variable (legacy `PHUB_UI_EXE`)
 * 3. macOS: `/Applications/Cortex.app/Contents/MacOS/Cortex`
 * 4. macOS: `~/Applications/Cortex.app/Contents/MacOS/Cortex`
 * 5. Windows: registry `HKCU\Software\Cortex` → `InstallLocation`
 * 6. Windows: NSIS uninstall entry `...\Uninstall\<app>` → `InstallLocation`
 * 7. Windows: `%LOCALAPPDATA%\Programs\Cortex\Cortex.exe` (the installer default)
 * 8. Windows: `C:\Program Files\Cortex\Cortex.exe`
 * 9. `--dev` → run the repo dev server instead of an installed executable.
 * 10. source build fallback: launch the compiled app with the local Electron.
 *
 * The executable is started detached; Electron's single-instance lock focuses
 * the already-running window when the app is open, on Windows and macOS alike.
 */
export const UI_EXE_NAME = 'Cortex.exe'
export const REGISTRY_APP_KEY = 'HKCU\\Software\\Cortex'
export const REGISTRY_UNINSTALL_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'

/** macOS app bundle: executable lives at `Cortex.app/Contents/MacOS/Cortex`. */
export const MACOS_APP_BUNDLE_NAME = 'Cortex.app'
export const MACOS_APP_EXECUTABLE_NAME = 'Cortex'

export type UiResolutionSource =
  | 'path'
  | 'env'
  | 'applications'
  | 'user-applications'
  | 'registry'
  | 'uninstall'
  | 'localappdata'
  | 'programfiles'

export interface UiResolution {
  source: UiResolutionSource
  exePath: string
}

export interface ResolveUiDeps {
  env?: NodeJS.ProcessEnv
  exists?: (filePath: string) => boolean
  /** Explicit `--path` value; skipped when undefined. */
  explicitPath?: string
  localAppData?: string
  programFiles?: string
  /** Home directory used for the per-user macOS bundle. */
  homeDir?: string
  /** Overridable registry probes (tests / non-Windows). */
  queryRegistryInstallLocation?: () => string | null
  queryUninstallInstallLocation?: () => string | null
}

function joinExe(installLocation: string): string {
  return installLocation.toLowerCase().endsWith('.exe')
    ? installLocation
    : join(installLocation, UI_EXE_NAME)
}

/** Parse `reg query ... /v InstallLocation` output. */
export function parseRegistryInstallLocation(stdout: string): string | null {
  const match = /InstallLocation\s+REG_\w+\s+(.+)\r?$/m.exec(stdout)
  return match?.[1]?.trim() ?? null
}

/**
 * Parse `reg query <uninstall root> /s /f <name>` output and return the
 * InstallLocation of the first application block whose key mentions our name.
 */
export function parseUninstallInstallLocation(stdout: string, appName = 'Cortex'): string | null {
  const blocks = stdout.split(/\r?\n(?=HKEY_)/)
  for (const block of blocks) {
    if (!block.includes(appName)) continue
    const installLocation = parseRegistryInstallLocation(block)
    if (installLocation !== null && installLocation.length > 0) return installLocation
  }
  return null
}

function queryRegistry(key: string, valueName: string): string | null {
  if (process.platform !== 'win32') return null
  try {
    const result = spawnSync('reg', ['query', key, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') return null
    return parseRegistryInstallLocation(result.stdout)
  } catch {
    return null
  }
}

function queryUninstallRegistry(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const result = spawnSync(
      'reg',
      ['query', REGISTRY_UNINSTALL_KEY, '/s', '/f', 'Cortex'],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000
      }
    )
    if (typeof result.stdout !== 'string') return null
    return parseUninstallInstallLocation(result.stdout)
  } catch {
    return null
  }
}

export function resolveUiExecutable(deps: ResolveUiDeps = {}): UiResolution | null {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync

  const explicit = deps.explicitPath?.trim()
  if (explicit !== undefined && explicit.length > 0) {
    return exists(explicit) ? { source: 'path', exePath: explicit } : null
  }

  const fromEnv = envOverride(env, 'CTX_UI_EXE', 'PHUB_UI_EXE')
  if (fromEnv !== undefined && exists(fromEnv)) {
    return { source: 'env', exePath: fromEnv }
  }

  const home = deps.homeDir ?? homedir()
  const macBundle = join(MACOS_APP_BUNDLE_NAME, 'Contents', 'MacOS', MACOS_APP_EXECUTABLE_NAME)
  const applications = join('/Applications', macBundle)
  if (exists(applications)) {
    return { source: 'applications', exePath: applications }
  }
  const userApplications = join(home, 'Applications', macBundle)
  if (exists(userApplications)) {
    return { source: 'user-applications', exePath: userApplications }
  }

  const registry = (deps.queryRegistryInstallLocation ?? (() => queryRegistry(REGISTRY_APP_KEY, 'InstallLocation')))()
  if (registry !== null && registry.length > 0) {
    const candidate = joinExe(registry)
    if (exists(candidate)) return { source: 'registry', exePath: candidate }
  }

  const uninstall = (deps.queryUninstallInstallLocation ?? queryUninstallRegistry)()
  if (uninstall !== null && uninstall.length > 0) {
    const candidate = joinExe(uninstall)
    if (exists(candidate)) return { source: 'uninstall', exePath: candidate }
  }

  const localAppData = deps.localAppData ?? env['LOCALAPPDATA']
  if (localAppData !== undefined && localAppData.length > 0) {
    const candidate = join(localAppData, 'Programs', 'Cortex', UI_EXE_NAME)
    if (exists(candidate)) return { source: 'localappdata', exePath: candidate }
  }

  const programFiles = deps.programFiles ?? env['ProgramFiles']
  if (programFiles !== undefined && programFiles.length > 0) {
    const candidate = join(programFiles, 'Cortex', UI_EXE_NAME)
    if (exists(candidate)) return { source: 'programfiles', exePath: candidate }
  }

  return null
}

export interface SpawnDetachedDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => void
}

/** Environment for launching Electron: never inherit "run as Node" switches. */
function uiLaunchEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_NO_ATTACH_CONSOLE']
  return env
}

/** Start the UI without blocking the terminal. */
export function launchDetached(command: string, args: string[], deps: SpawnDetachedDeps = {}): void {
  const options: SpawnOptions = {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: uiLaunchEnvironment()
  }
  const runner =
    deps.spawn ??
    ((target: string, targetArgs: string[], spawnOptions: SpawnOptions) => {
      const child = spawn(target, targetArgs, spawnOptions)
      child.unref()
    })
  runner(command, args, options)
}

export interface OpenOptions {
  dev?: boolean
  path?: string
}

interface SourceBuildRuntime {
  electronExecutable: string
  appDir: string
}

/**
 * A source checkout has no installed exe, but after `npm run build` it does have
 * a compiled Electron app plus the local Electron binary. `ctx open` can launch
 * that configuration directly (single-instance lock still applies).
 */
function findSourceBuildRuntime(root: string): SourceBuildRuntime | null {
  const mainEntry = join(root, 'out', 'main', 'index.js')
  if (!existsSync(mainEntry)) return null
  const distDir = join(root, 'node_modules', 'electron', 'dist')
  const candidates =
    process.platform === 'win32'
      ? [join(distDir, 'electron.exe')]
      : [join(distDir, 'electron'), join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron')]
  const electronExecutable = candidates.find((candidate) => existsSync(candidate))
  if (electronExecutable === undefined) return null
  return { electronExecutable, appDir: root }
}

export async function runOpen(
  options: OpenOptions,
  context: CliContext,
  deps: SpawnDetachedDeps & ResolveUiDeps = {}
): Promise<void> {
  const runtime = resolveCliRuntime({ env: context.env })

  if (options.dev === true) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    launchDetached(npmCommand, ['run', 'dev'], deps)
    context.stdout(`已在开发模式启动桌面端：${runtime.root}（npm run dev）`)
    return
  }

  const resolved = resolveUiExecutable({ ...deps, explicitPath: options.path ?? deps.explicitPath })
  if (resolved !== null) {
    launchDetached(resolved.exePath, [], deps)
    context.stdout(`已启动 Cortex（${resolved.source}）：${resolved.exePath}`)
    if (context.json) {
      context.stdout(
        JSON.stringify({ source: resolved.source, exePath: resolved.exePath }, null, 2)
      )
    }
    return
  }

  if (options.path === undefined) {
    const sourceBuild = findSourceBuildRuntime(runtime.root)
    if (sourceBuild !== null) {
      launchDetached(sourceBuild.electronExecutable, [sourceBuild.appDir], deps)
      context.stdout(
        `已用源码构建启动桌面端（Electron 单实例）：${sourceBuild.electronExecutable} ${sourceBuild.appDir}`
      )
      if (context.json) {
        context.stdout(
          JSON.stringify(
            {
              source: 'source-build',
              electronExecutable: sourceBuild.electronExecutable,
              appDir: sourceBuild.appDir
            },
            null,
            2
          )
        )
      }
      return
    }
  }

  throw new CliError(
    [
      '未找到 Cortex 可执行文件。已尝试：',
      '  1. --path <exe>',
      '  2. 环境变量 CTX_UI_EXE（兼容旧 PHUB_UI_EXE）',
      '  3. /Applications/Cortex.app/Contents/MacOS/Cortex',
      '  4. ~/Applications/Cortex.app/Contents/MacOS/Cortex',
      `  5. 注册表 ${REGISTRY_APP_KEY}\\InstallLocation`,
      '  6. 注册表卸载项 InstallLocation',
      '  7. %LOCALAPPDATA%\\Programs\\Cortex\\Cortex.exe',
      '  8. C:\\Program Files\\Cortex\\Cortex.exe',
      '  9. 源码构建（out/main/index.js + node_modules/electron）',
      '请先 npm run build（源码启动），或安装 Cortex 桌面端；开发模式可用 ctx open --dev。'
    ].join('\n'),
    1
  )
}

export function registerOpenCommand(cli: CAC): void {
  cli
    .command('open', '启动或聚焦 Cortex 桌面端（安装版）')
    .option('--dev', '在源码目录执行 npm run dev')
    .option('--path <exe>', '直接指定 Cortex 可执行文件路径')
    .action(async (options: OpenOptions) => {
      await runOpen(options, createCliContext())
    })
}
