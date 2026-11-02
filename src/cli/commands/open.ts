import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions
} from 'node:child_process'
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

/* ------------------------------------------------ GPU-safe desktop launch -- */

/**
 * Windows VMs / remote desktops / RDP sessions frequently fail to start
 * Chromium's GPU process:
 *
 *   GPU process launch failed: error_code=18
 *   FATAL: GPU process isn't usable. Goodbye.
 *
 * Electron dies before the window appears, which looks like "`ctx open` 打不开".
 * To make the desktop app startable there, `ctx open` probes the spawned app and
 * retries with software rendering when it exits early with a failure code.
 */
const LAUNCH_PROBE_MS = 5_000
const SOFTWARE_WEBGL_FLAG = '--enable-unsafe-swiftshader'
/** SwiftShader WebGL + CPU compositing. */
const SOFTWARE_RENDER_FLAGS = [SOFTWARE_WEBGL_FLAG, '--disable-gpu']
/** Last resort: keep GPU disabled but skip Chromium's GPU sandbox startup. */
const GPU_SANDBOX_OFF_FLAGS = [SOFTWARE_WEBGL_FLAG, '--disable-gpu-sandbox']
/**
 * Elevated (Administrator) sessions cannot launch Chromium's GPU process
 * (`GPU process launch failed: error_code=18` → FATAL) unless Chromium's
 * sandbox is disabled for the app (`--no-sandbox`). See electron#49167.
 */
const NO_SANDBOX_FLAGS = [SOFTWARE_WEBGL_FLAG, '--no-sandbox', '--disable-gpu-sandbox']
const NO_SANDBOX_SOFTWARE_FLAGS = [
  SOFTWARE_WEBGL_FLAG,
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-gpu'
]
/** Consumed by the main process: calls `app.disableHardwareAcceleration()` early. */
const SOFTWARE_RENDER_ENV = { CORTEX_DISABLE_GPU: '1' } as const

export type DesktopLaunchMode =
  | 'normal'
  | 'software'
  | 'software-sandbox-off'
  | 'no-sandbox'
  | 'no-sandbox-software'

export interface DesktopLaunchResult {
  ok: boolean
  mode: DesktopLaunchMode
  /** 1-based attempt number that succeeded (or the count when everything failed). */
  attempts: number
  /** Whether the CLI ran with an Administrator token (Windows only). */
  elevated: boolean
}

export type TrackedSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess

export interface TrackedLaunchDeps {
  /** Injectable spawn for tests. */
  spawnTracked?: TrackedSpawn
  /** How long to watch a freshly spawned app before assuming it started. */
  probeMs?: number
  /** Override the Administrator-token detection (tests / non-Windows). */
  elevated?: boolean
}

/**
 * Elevated Windows sessions are the documented cause of `GPU process launch
 * failed: error_code=18`: Chromium's GPU process cannot start under an
 * Administrator token with the normal sandbox, and Electron exits before any
 * window exists (electron#49167). `--no-sandbox` is the practical workaround.
 *
 * `whoami /groups` reports the token integrity level for any user
 * (`S-1-16-12288` = High/Admin, `S-1-16-16384` = System). `net session` is kept
 * as a fallback because it also requires admin, but it fails when the Server
 * service is stopped, so it is only a secondary signal.
 */
export function detectWindowsElevation(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const groups = spawnSync('whoami', ['/groups'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3_000
    })
    if (typeof groups.stdout === 'string' && groups.stdout.length > 0) {
      return /S-1-16-12288|S-1-16-16384/i.test(groups.stdout)
    }
  } catch {
    // fall through to net session
  }
  try {
    const result = spawnSync('net', ['session'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 3_000
    })
    return result.status === 0
  } catch {
    return false
  }
}

function spawnTracked(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: TrackedLaunchDeps
): ChildProcess {
  const options: SpawnOptions = {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: { ...uiLaunchEnvironment(), ...env }
  }
  const runner: TrackedSpawn =
    deps.spawnTracked ??
    ((target: string, targetArgs: string[], spawnOptions: SpawnOptions) =>
      spawn(target, targetArgs, spawnOptions))
  return runner(command, args, options)
}

/** Resolves with the exit code, or `null` when the app is still running. */
export function waitForEarlyExit(child: ChildProcess, probeMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }
    const timer = setTimeout(() => finish(null), probeMs)
    child.once('exit', (code) => finish(code ?? -1))
    child.once('error', () => finish(-1))
  })
}

/** True when a matching Electron/Cortex process is still alive (Windows). */
function hasRunningAppProcess(command: string, appArgs: readonly string[]): boolean {
  if (process.platform !== 'win32') return true
  try {
    const exeName = command.split(/[\\/]/).pop() ?? 'electron.exe'
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Select-Object -ExpandProperty CommandLine`
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 6_000 }
    )
    const needles = [command, ...appArgs]
      .map((value) => value.toLowerCase().replace(/\//g, '\\'))
      .filter((value) => value.length > 0)
    return output
      .split(/\r?\n/)
      .some((line) => {
        const lower = line.trim().toLowerCase()
        if (lower.length === 0) return false
        return needles.some((needle) => lower.includes(needle))
      })
  } catch {
    // Enumeration failed: keep the old behaviour rather than flagging a false crash.
    return true
  }
}

/** Launch with a GPU fallback chain; a running app is detected by process liveness. */
export async function launchDesktop(
  command: string,
  appArgs: readonly string[],
  deps: TrackedLaunchDeps = {}
): Promise<DesktopLaunchResult> {
  const probeMs = deps.probeMs ?? LAUNCH_PROBE_MS
  const elevated = deps.elevated ?? detectWindowsElevation()
  const standardAttempts: Array<{
    mode: DesktopLaunchMode
    flags: readonly string[]
    env: NodeJS.ProcessEnv
  }> = [
    { mode: 'normal', flags: [SOFTWARE_WEBGL_FLAG], env: {} },
    { mode: 'software', flags: SOFTWARE_RENDER_FLAGS, env: { ...SOFTWARE_RENDER_ENV } },
    {
      mode: 'software-sandbox-off',
      flags: GPU_SANDBOX_OFF_FLAGS,
      env: { ...SOFTWARE_RENDER_ENV }
    }
  ]
  const sandboxAttempts: Array<{
    mode: DesktopLaunchMode
    flags: readonly string[]
    env: NodeJS.ProcessEnv
  }> = [
    { mode: 'no-sandbox', flags: NO_SANDBOX_FLAGS, env: {} },
    {
      mode: 'no-sandbox-software',
      flags: NO_SANDBOX_SOFTWARE_FLAGS,
      env: { ...SOFTWARE_RENDER_ENV }
    }
  ]
  // Under an Administrator token the normal GPU startup is expected to fail, so
  // try the sandbox-free launch first; otherwise keep it as a last resort.
  const attempts = elevated
    ? [...sandboxAttempts, ...standardAttempts]
    : [...standardAttempts, ...sandboxAttempts]

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    const child = spawnTracked(command, [...appArgs, ...attempt.flags], attempt.env, deps)
    const code = await waitForEarlyExit(child, probeMs)
    // Still running after the probe → the window is up; detach and stop watching.
    if (code === null) {
      child.unref()
      return { ok: true, mode: attempt.mode, attempts: index + 1, elevated }
    }
    // Exit 0 right away is Electron's single-instance lock forwarding to the
    // already-running window, not a crash.
    // Exit 0 is usually Electron's single-instance lock forwarding to the live
    // window. But a silent quit (e.g. userData/instance lock not writable in a
    // sandboxed shell) also exits 0 with no window — verify a matching process
    // is still alive before claiming success.
    if (code === 0) {
      if (hasRunningAppProcess(command, appArgs)) {
        return { ok: true, mode: attempt.mode, attempts: index + 1, elevated }
      }
      continue
    }
    // Non-zero early exit: retry with stronger software-rendering settings.
  }

  return { ok: false, mode: 'normal', attempts: attempts.length, elevated }
}

function launchModeMessage(mode: DesktopLaunchMode): string {
  switch (mode) {
    case 'software':
      return '（检测到 GPU 不可用，已改用软件渲染）'
    case 'software-sandbox-off':
      return '（GPU 沙箱不可用，已改用软件渲染并跳过 GPU 沙箱）'
    case 'no-sandbox':
      return '（已附加 --no-sandbox 绕过 GPU 进程启动限制）'
    case 'no-sandbox-software':
      return '（已改用软件渲染并附加 --no-sandbox）'
    default:
      return ''
  }
}

function gpuTroubleshootingHint(exePath: string): string {
  return [
    `无法启动桌面端：${exePath}`,
    '启动探测发现进程启动后立即退出（常见于 GPU 进程无法创建：`GPU process isn\'t usable`）。',
    '可尝试：',
    '  1. ctx open --software        # 强制软件渲染（SwiftShader，3D 星云仍可用）',
    '  2. 关闭已运行的 Cortex/Electron 实例后重试',
    '  3. 若每次都提示“已启动”却没有窗口：单实例锁/用户数据目录可能不可写（沙箱或受限权限），',
    '     请改用普通 PowerShell 重试；新版在锁不可写时会允许应用继续启动',
    '  4. 删除 %APPDATA%\\Cortex\\GPUPersistentCache 后重试',
    '  4. 管理员权限终端是已知诱因：Electron GPU 进程在提权会话中无法启动（electron#49167），',
    '     建议改用普通 PowerShell；ctx open 检测到提权时会自动附加 --no-sandbox 兜底',
    '  5. ctx open --dev             # 用开发模式启动（electron-vite dev）',
    '  6. 安装版仍失败时用 --path 指向 Cortex.exe 排查是否为该构建问题'
  ].join('\n')
}

export interface OpenOptions {
  dev?: boolean
  path?: string
  /** Force software rendering (SwiftShader) — for VMs / broken GPU drivers. */
  software?: boolean
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

const UI_NOT_FOUND_HELP = [
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
].join('\n')

export async function runOpen(
  options: OpenOptions,
  context: CliContext,
  deps: SpawnDetachedDeps & ResolveUiDeps & TrackedLaunchDeps = {}
): Promise<void> {
  const runtime = resolveCliRuntime({ env: context.env })

  if (options.dev === true) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    launchDetached(npmCommand, ['run', 'dev'], deps)
    context.stdout(`已在开发模式启动桌面端：${runtime.root}（npm run dev）`)
    return
  }

  const resolved = resolveUiExecutable({ ...deps, explicitPath: options.path ?? deps.explicitPath })
  const sourceBuild = options.path === undefined ? findSourceBuildRuntime(runtime.root) : null
  const target =
    resolved !== null
      ? {
          command: resolved.exePath,
          appArgs: [] as string[],
          label: resolved.exePath,
          source: resolved.source as string
        }
      : sourceBuild !== null
        ? {
            command: sourceBuild.electronExecutable,
            appArgs: [sourceBuild.appDir],
            label: `${sourceBuild.electronExecutable} ${sourceBuild.appDir}`,
            source: 'source-build'
          }
        : null

  if (target === null) {
    throw new CliError(UI_NOT_FOUND_HELP, 1)
  }

  // Explicit `--software`: skip probing, launch straight into SwiftShader mode.
  if (options.software === true) {
    const elevated = deps.elevated ?? detectWindowsElevation()
    // Under an Administrator token the sandboxed GPU process cannot start, so
    // software mode still needs `--no-sandbox` to get a window at all.
    const flags = elevated
      ? [...SOFTWARE_RENDER_FLAGS, '--no-sandbox', '--disable-gpu-sandbox']
      : [...SOFTWARE_RENDER_FLAGS]
    const child = spawnTracked(
      target.command,
      [...target.appArgs, ...flags],
      { ...SOFTWARE_RENDER_ENV },
      deps
    )
    child.unref()
    const suffix = elevated ? '（管理员权限，已附加 --no-sandbox）' : ''
    context.stdout(`已用软件渲染启动桌面端（SwiftShader）${suffix}：${target.label}`)
    if (context.json) {
      context.stdout(
        JSON.stringify(
          { source: target.source, mode: 'software', elevated, label: target.label },
          null,
          2
        )
      )
    }
    return
  }

  const result = await launchDesktop(target.command, target.appArgs, deps)
  if (!result.ok) {
    throw new CliError(gpuTroubleshootingHint(target.label), 1)
  }
  if (result.elevated) {
    context.stdout(
      '提示：检测到管理员权限。Electron 的 GPU 进程在提权会话中通常无法启动（error_code=18），已自动附加 --no-sandbox 兜底；如需硬件加速，请改用普通权限终端运行 ctx open。'
    )
  }
  context.stdout(`已启动 Cortex（${target.source}）${launchModeMessage(result.mode)}：${target.label}`)
  if (context.json) {
    context.stdout(
      JSON.stringify(
        {
          source: target.source,
          mode: result.mode,
          attempts: result.attempts,
          elevated: result.elevated,
          label: target.label
        },
        null,
        2
      )
    )
  }
}

export function registerOpenCommand(cli: CAC): void {
  cli
    .command('open', '启动或聚焦 Cortex 桌面端（安装版）')
    .option('--dev', '在源码目录执行 npm run dev')
    .option('--path <exe>', '直接指定 Cortex 可执行文件路径')
    .option('--software', '强制软件渲染（GPU 不可用 / 虚拟机 / 远程桌面）')
    .action(async (options: OpenOptions) => {
      await runOpen(options, createCliContext())
    })
}
