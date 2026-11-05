import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { envOverride } from '../env'

/**
 * Resolve the real `claude` launcher and prove that it is Claude Code.
 *
 * The CLI must not assume the launcher is `claude.cmd`: the official native
 * install ships `claude.exe`, an npm global install ships `claude.cmd`, and a
 * Bun global install ships a shim that also answers `--version` with exit code 0
 * (while printing Bun's help). This module therefore:
 *
 * 1. resolves candidates with `where.exe claude` (Windows, no shell) or
 *    `which -a claude` (POSIX), falling back to a PATH scan; `CORTEX_CLAUDE_BIN`
 *    overrides the lookup for tests / exotic installs;
 * 2. probes every candidate with `--version` and, when that output is
 *    inconclusive, with the non-interactive `mcp list` sub-command;
 * 3. classifies the output by signature (`Bun …` is never Claude Code), never
 *    only by exit code, and never starts an interactive REPL/TUI;
 * 4. exposes a runner that spawns the resolved command with the right strategy:
 *    `.exe` directly with `shell: false`, `.cmd`/`.bat` through
 *    `cmd.exe /d /s /c call <path> <args…>` (argument array, no shell string).
 *
 * Everything external (`spawn`, `exists`, `platform`, `env`) is injectable so the
 * unit tests never need a real Claude Code installation.
 */

export type ClaudeCommandKind = 'exe' | 'cmd' | 'bat' | 'ps1' | 'shell'

/** Where the resolved candidate list came from. */
export type ClaudeCommandSource = 'env' | 'where' | 'which' | 'path' | 'none'

/** Why a probe did not produce a usable Claude Code command. */
export type ClaudeProbeReason =
  | 'not-found'
  | 'bun-shim'
  | 'wrong-cli'
  | 'timeout'
  | 'error'
  | 'unsupported-shell'

/** Which non-interactive command proved the CLI is Claude Code. */
export type ClaudeProbeMethod = 'version' | 'mcp-list'

/** Optional launcher override (tests / custom installations). */
export const CLAUDE_BIN_ENV = 'CORTEX_CLAUDE_BIN'
/** `--version` / `mcp list` timeout: a hanging REPL must never block `ctx`. */
export const CLAUDE_PROBE_TIMEOUT_MS = 10_000
/** `mcp get/remove/add` timeout: registration is slower than a probe. */
export const CLAUDE_RUN_TIMEOUT_MS = 20_000
const CLAUDE_LOOKUP_TIMEOUT_MS = 5_000

/** Bun prints this banner/help when a `claude` shim points at Bun. */
const BUN_SIGNATURE = /Bun is a fast JavaScript runtime|Bun\.js|\bbun v?\d/i
/** Claude Code always mentions its product name in `--version` / `mcp list`. */
const CLAUDE_SIGNATURE = /Claude Code/i
const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/
const WINDOWS_LAUNCHER_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1', '.com', ''] as const

export interface ClaudeSpawnOptions {
  encoding: 'utf8'
  windowsHide: boolean
  timeout: number
  shell: boolean
}

/** Mirrors `spawnSync`: a missing/policy-blocked CLI yields `status: null`. */
export interface ClaudeSpawnResult {
  status: number | null
  stdout?: string
  stderr?: string
  error?: unknown
}

export type ClaudeSpawn = (
  file: string,
  args: string[],
  options: ClaudeSpawnOptions
) => ClaudeSpawnResult

/** Injectable `claude` CLI runner bound to an already probed command. */
export type ClaudeCliRunner = (args: string[]) => ClaudeSpawnResult

export interface ClaudeCommandResolution {
  path: string | null
  kind: ClaudeCommandKind | null
  candidates: string[]
  source: ClaudeCommandSource
}

export interface ClaudeProbeResult {
  ok: boolean
  command: string | null
  kind: ClaudeCommandKind | null
  version: string | null
  reason?: ClaudeProbeReason
  detail?: string
  method?: ClaudeProbeMethod
  resolution: ClaudeCommandResolution
}

/** Resolution + probe + a runner bound to the probed command. */
export interface ClaudeInspection {
  probe: ClaudeProbeResult
  run: ClaudeCliRunner
}

export interface ClaudeCommandDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Base directory for relative PATH entries and relative `CORTEX_CLAUDE_BIN`. */
  cwd?: string
  /** Low-level spawn; injectable for tests. Defaults to `spawnSync`. */
  spawn?: ClaudeSpawn
  exists?: (filePath: string) => boolean
  /** Timeout for `--version` / `mcp list`. Defaults to 10s. */
  timeoutMs?: number
  /** Timeout for calls made through `createClaudeCliRunner`. Defaults to 20s. */
  runTimeoutMs?: number
}

export interface ClaudeSpawnInvocation {
  file: string
  args: string[]
  options: ClaudeSpawnOptions
}

export interface ClaudeSpawnInvocationOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** Production spawn: `spawnSync` with the already-built invocation. */
export function defaultClaudeSpawn(
  file: string,
  args: string[],
  options: ClaudeSpawnOptions
): ClaudeSpawnResult {
  try {
    const result = spawnSync(file, args, options)
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error
    }
  } catch (error) {
    return { status: null, error }
  }
}

/** Classify a launcher path so the caller knows how it must be spawned. */
export function claudeCommandKind(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): ClaudeCommandKind {
  if (platform !== 'win32') return 'shell'
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.exe')) return 'exe'
  if (lower.endsWith('.cmd')) return 'cmd'
  if (lower.endsWith('.bat')) return 'bat'
  if (lower.endsWith('.ps1')) return 'ps1'
  return 'shell'
}

/**
 * Resolve every plausible `claude` launcher, in the order the OS would use.
 *
 * `CORTEX_CLAUDE_BIN` (when set) is authoritative: a path is used as-is and a
 * bare name is looked up like `claude` would be, but system candidates are not
 * mixed in. This keeps test/exotic installs deterministic.
 */
export function resolveClaudeCommand(deps: ClaudeCommandDeps = {}): ClaudeCommandResolution {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const cwd = deps.cwd ?? process.cwd()
  const spawn = deps.spawn ?? defaultClaudeSpawn
  const exists = deps.exists ?? existsSync
  const explicit = envOverride(env, CLAUDE_BIN_ENV)

  if (explicit !== undefined) {
    const paths = explicitLooksLikePath(explicit)
      ? [resolve(cwd, explicit)]
      : nativeLookup(explicit, { platform, spawn, timeoutMs: CLAUDE_LOOKUP_TIMEOUT_MS }).paths
    const candidates = dedupePaths(paths, platform)
    return toResolution(candidates, 'env', platform)
  }

  const native = nativeLookup('claude', { platform, spawn, timeoutMs: CLAUDE_LOOKUP_TIMEOUT_MS })
  const nativeCandidates = dedupePaths(native.paths, platform)
  if (nativeCandidates.length > 0) return toResolution(nativeCandidates, native.source, platform)

  // Some stripped-down environments ship neither `where.exe` nor `which -a`, and
  // injected tests rely on this path too: scan PATH directly instead of guessing
  // a single file name.
  const scanned = dedupePaths(scanPathForClaude(env, platform, exists, cwd), platform)
  return toResolution(scanned, scanned.length > 0 ? 'path' : 'none', platform)
}

/** Resolve + probe in one call (the normal entry point for callers). */
export function probeClaudeCommand(deps: ClaudeCommandDeps = {}): ClaudeProbeResult {
  return probeResolvedClaudeCommand(resolveClaudeCommand(deps), deps)
}

/**
 * Probe an already resolved candidate list, in order. The first candidate whose
 * non-interactive output proves it is Claude Code wins.
 */
export function probeResolvedClaudeCommand(
  resolution: ClaudeCommandResolution,
  deps: ClaudeCommandDeps = {}
): ClaudeProbeResult {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const spawn = deps.spawn ?? defaultClaudeSpawn
  const timeoutMs = deps.timeoutMs ?? CLAUDE_PROBE_TIMEOUT_MS
  const explicit = envOverride(env, CLAUDE_BIN_ENV)
  const seconds = Math.round(timeoutMs / 1000)

  if (resolution.candidates.length === 0) {
    return {
      ok: false,
      command: null,
      kind: null,
      version: null,
      reason: 'not-found',
      detail:
        explicit !== undefined
          ? `CORTEX_CLAUDE_BIN=${explicit} 未找到可执行文件（where.exe / which 均无结果）`
          : '未找到 claude 命令（where.exe claude / which -a claude 均无结果）',
      resolution
    }
  }

  const attempts: ClaudeProbeAttempt[] = []
  for (const candidate of resolution.candidates) {
    const kind = claudeCommandKind(candidate, platform)
    const context: RunContext = { spawn, platform, env, timeoutMs }

    if (kind === 'ps1') {
      // Deliberately unsupported in this version: running PowerShell scripts is
      // a different execution model; tell the user instead of guessing.
      attempts.push({
        path: candidate,
        kind,
        reason: 'unsupported-shell',
        detail: '当前版本不支持自动调用 .ps1 脚本'
      })
      continue
    }

    // Probe 1: `--version` (never the bare command: that would start the REPL).
    const versionResult = runClaudeCommand(candidate, kind, ['--version'], context)
    const versionText = commandOutput(versionResult)
    if (BUN_SIGNATURE.test(versionText)) {
      attempts.push({ path: candidate, kind, reason: 'bun-shim', detail: firstLine(versionText) })
      continue
    }
    if (isTimeout(versionResult)) {
      attempts.push({
        path: candidate,
        kind,
        reason: 'timeout',
        detail: `claude --version 超过 ${seconds}s 未返回`
      })
      continue
    }
    if (versionResult.status === 0 && CLAUDE_SIGNATURE.test(versionText)) {
      return okProbe(resolution, candidate, kind, extractVersion(versionText), 'version')
    }

    // Probe 2: `mcp list` is non-interactive and older builds may not print the
    // product name in `--version`. It must still not match the Bun signature.
    const listResult = runClaudeCommand(candidate, kind, ['mcp', 'list'], context)
    const listText = commandOutput(listResult)
    if (BUN_SIGNATURE.test(listText)) {
      attempts.push({ path: candidate, kind, reason: 'bun-shim', detail: firstLine(listText) })
      continue
    }
    if (isTimeout(listResult)) {
      attempts.push({
        path: candidate,
        kind,
        reason: 'timeout',
        detail: `claude mcp list 超过 ${seconds}s 未返回`
      })
      continue
    }
    if (listResult.status === 0) {
      const combined = `${versionText}\n${listText}`
      const version = extractVersion(CLAUDE_SIGNATURE.test(combined) ? combined : versionText)
      return okProbe(resolution, candidate, kind, version, 'mcp-list')
    }

    const spawnFailed = versionResult.error !== undefined || listResult.error !== undefined
    attempts.push({
      path: candidate,
      kind,
      reason: spawnFailed ? 'error' : 'wrong-cli',
      detail: describeAttempt(versionResult, listResult)
    })
  }

  return aggregateProbeFailure(attempts, resolution, timeoutMs)
}

/** Build the inspection bundle (`ctx init` / `ctx doctor` / GUI setup). */
export function inspectClaudeCommand(deps: ClaudeCommandDeps = {}): ClaudeInspection {
  const probe = probeClaudeCommand(deps)
  return { probe, run: createClaudeCliRunner(probe, deps) }
}

/** Bind a runner to the command that actually passed the probe. */
export function createClaudeCliRunner(
  probe: ClaudeProbeResult,
  deps: ClaudeCommandDeps = {}
): ClaudeCliRunner {
  const spawn = deps.spawn ?? defaultClaudeSpawn
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const timeoutMs = deps.runTimeoutMs ?? CLAUDE_RUN_TIMEOUT_MS
  return (args: string[]): ClaudeSpawnResult => {
    if (!probe.ok || probe.command === null) {
      return { status: null, error: new Error(probe.detail ?? 'Claude Code CLI 不可用') }
    }
    const kind = probe.kind ?? claudeCommandKind(probe.command, platform)
    return runClaudeCommand(probe.command, kind, args, { spawn, platform, env, timeoutMs })
  }
}

/**
 * Turn a resolved command + argument array into a spawn invocation.
 *
 * - `.exe`: spawned directly, `shell: false`.
 * - `.cmd` / `.bat` / extensionless Windows shims: `cmd.exe /d /s /c call …`
 *   with the argument array; `call` prevents cmd from stripping the quotes
 *   around a path that contains spaces. No shell string is assembled here.
 */
export function claudeSpawnInvocation(
  commandPath: string,
  kind: ClaudeCommandKind,
  args: string[],
  options: ClaudeSpawnInvocationOptions = {}
): ClaudeSpawnInvocation {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const spawnOptions: ClaudeSpawnOptions = {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs ?? CLAUDE_RUN_TIMEOUT_MS,
    shell: false
  }
  if (platform === 'win32' && kind !== 'exe') {
    const comspec = envValue(env, 'ComSpec') ?? envValue(env, 'COMSPEC') ?? 'cmd.exe'
    return {
      file: comspec,
      args: ['/d', '/s', '/c', 'call', commandPath, ...args],
      options: spawnOptions
    }
  }
  return { file: commandPath, args, options: spawnOptions }
}

/** Short one-line probe summary for tables / action details. */
export function describeClaudeProbe(probe: ClaudeProbeResult): string {
  if (probe.ok) {
    const version = probe.version ?? 'unknown'
    return `Claude Code ${version}（${probe.kind ?? 'unknown'}）· ${probe.command ?? 'claude'}`
  }
  const command = probe.command ?? 'claude'
  switch (probe.reason) {
    case 'bun-shim':
      return `claude → Bun（${command}），不是 Claude Code`
    case 'not-found':
      return '未找到 claude 命令'
    case 'wrong-cli':
      return `claude（${command}）不是 Claude Code`
    case 'timeout':
      return `探测 claude 超时（${command}）`
    case 'unsupported-shell':
      return `claude 是 .ps1 脚本（${command}），暂不支持自动调用`
    default:
      return `调用 claude 失败（${command}）`
  }
}

export function claudeKindLabel(kind: ClaudeCommandKind): string {
  return kind
}

export function claudeProbeReasonLabel(reason: ClaudeProbeReason | undefined): string {
  switch (reason) {
    case 'not-found':
      return '未找到命令'
    case 'bun-shim':
      return 'Bun shim'
    case 'wrong-cli':
      return '不是 Claude Code'
    case 'timeout':
      return '超时'
    case 'unsupported-shell':
      return '不支持 .ps1'
    default:
      return '执行失败'
  }
}

export interface ClaudeInstallCommands {
  /** Official native installer for the current platform. */
  official: string
  npm: string
}

export function claudeInstallCommands(
  platform: NodeJS.Platform = process.platform
): ClaudeInstallCommands {
  return platform === 'win32'
    ? {
        official: 'irm https://claude.ai/install.ps1 | iex',
        npm: 'npm install -g @anthropic-ai/claude-code'
      }
    : {
        official: 'curl -fsSL https://claude.ai/install.sh | bash',
        npm: 'npm install -g @anthropic-ai/claude-code'
      }
}

export interface ClaudeFixOptions {
  platform?: NodeJS.Platform
  /** `claude mcp add …` copy-paste command shown after the repair steps. */
  manualCommand?: string
}

/**
 * Human-readable diagnosis + repair steps. Used as the `ctx init` action detail
 * (multi-line) so a failed Claude integration never degrades to "not detected".
 */
export function claudeFixLines(probe: ClaudeProbeResult, options: ClaudeFixOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const install = claudeInstallCommands(platform)
  const command = probe.command
  const lines: string[] = []

  switch (probe.reason) {
    case 'bun-shim':
      lines.push(`检测到 claude 指向 Bun（${command ?? '未知路径'}），Claude Code 未正确安装。`)
      lines.push(
        `请先卸载 Bun 全局包（bun remove -g @anthropic-ai/claude-code），改用官方安装：${install.official}`
      )
      lines.push(`或 npm 全局安装：${install.npm}`)
      lines.push('然后重开终端并重新运行 ctx init --agents claude --yes。')
      lines.push(
        '若 where.exe claude 找不到命令，可能是 PowerShell alias/function（Get-Command claude -All 可确认）：alias 对 Cortex 子进程不可见，请安装真实 CLI 后重开终端。'
      )
      break
    case 'not-found':
      lines.push('未找到 claude 命令（where.exe claude / which -a claude 均无结果）。')
      lines.push(`请安装 Claude Code：官方安装 ${install.official}，或 npm 全局安装：${install.npm}`)
      lines.push('安装后重开终端并重新运行 ctx init --agents claude --yes。')
      break
    case 'wrong-cli':
      lines.push(
        `claude 解析到 ${command ?? '未知路径'}（${probe.kind ?? 'shell'}），但输出不像 Claude Code：${probe.detail ?? '无输出特征'}`
      )
      lines.push(
        '请用 where.exe claude（PowerShell: Get-Command claude -All）确认 PATH 顺序与命令来源；PowerShell alias/function 对 Cortex 子进程不可见，请安装真实 CLI 后重开终端。'
      )
      lines.push(`官方安装：${install.official}；或 npm 全局安装：${install.npm}`)
      break
    case 'timeout':
      lines.push(
        `探测 claude 超时（超过 ${Math.round(CLAUDE_PROBE_TIMEOUT_MS / 1000)}s）：${command ?? 'claude'}。`
      )
      lines.push(
        '该命令可能在等待交互输入；Cortex 只传 --version / mcp list，不会进入 Claude 的 REPL。请确认 claude --version 在终端可直接返回后重试。'
      )
      break
    case 'unsupported-shell':
      lines.push(`claude 解析到 PowerShell 脚本（${command ?? '.ps1'}）：当前版本不支持自动调用 .ps1。`)
      lines.push(`请改用官方安装（${install.official}）或 npm 全局安装（${install.npm}），或手动执行 mcp add。`)
      break
    default:
      lines.push(`调用 claude 失败（${command ?? 'claude'}）：${probe.detail ?? '未知错误'}`)
      lines.push(
        `请确认 claude --version 可正常运行（where.exe claude 查看解析路径）；官方安装：${install.official}；npm 全局安装：${install.npm}`
      )
      break
  }

  if (options.manualCommand !== undefined && options.manualCommand.length > 0) {
    lines.push(`修复后也可在终端手动执行：${options.manualCommand}`)
  }
  return lines
}

/** Single-line variant for table cells (`ctx doctor` hint column). */
export function claudeFixHint(probe: ClaudeProbeResult, options: ClaudeFixOptions = {}): string {
  if (probe.ok) return ''
  const install = claudeInstallCommands(options.platform ?? process.platform)
  switch (probe.reason) {
    case 'bun-shim':
      return `卸载 Bun 全局包后改用官方安装（${install.official}）或 ${install.npm}，然后重开终端`
    case 'not-found':
      return `安装 Claude Code：${install.official} 或 ${install.npm}，然后重开终端`
    case 'wrong-cli':
      return 'where.exe claude / Get-Command claude -All 确认 PATH；PowerShell alias 不可见，安装真实 CLI 后重开终端'
    case 'timeout':
      return 'claude --version 未能及时返回；确认不是交互式命令后重试'
    case 'unsupported-shell':
      return '改用官方 .exe 或 npm 安装的 .cmd，或手动执行 claude mcp add'
    default:
      return '确认 claude --version 可正常运行（where.exe claude 查看路径）'
  }
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

interface ClaudeProbeAttempt {
  path: string
  kind: ClaudeCommandKind
  reason: ClaudeProbeReason
  detail?: string
}

interface RunContext {
  spawn: ClaudeSpawn
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

interface NativeLookupOptions {
  platform: NodeJS.Platform
  spawn: ClaudeSpawn
  timeoutMs: number
}

function okProbe(
  resolution: ClaudeCommandResolution,
  command: string,
  kind: ClaudeCommandKind,
  version: string | null,
  method: ClaudeProbeMethod
): ClaudeProbeResult {
  return { ok: true, command, kind, version, method, resolution }
}

function aggregateProbeFailure(
  attempts: ClaudeProbeAttempt[],
  resolution: ClaudeCommandResolution,
  timeoutMs: number
): ClaudeProbeResult {
  const first = attempts[0]
  const command = first?.path ?? null
  const kind = first?.kind ?? null
  const summary = attempts
    .map((attempt) => {
      const detail = attempt.detail !== undefined ? `：${attempt.detail}` : ''
      return `${attempt.path}（${claudeKindLabel(attempt.kind)}，${claudeProbeReasonLabel(attempt.reason)}${detail}）`
    })
    .join('；')

  const bun = attempts.find((attempt) => attempt.reason === 'bun-shim')
  if (bun !== undefined) {
    const candidates = attempts.length > 1 ? `候选：${summary}` : ''
    return {
      ok: false,
      command: bun.path,
      kind: bun.kind,
      version: null,
      reason: 'bun-shim',
      detail: `检测到 claude 指向 Bun（${bun.path}），Claude Code 未正确安装。${candidates}`,
      resolution
    }
  }

  if (attempts.every((attempt) => attempt.reason === 'unsupported-shell')) {
    return {
      ok: false,
      command,
      kind,
      version: null,
      reason: 'unsupported-shell',
      detail: summary,
      resolution
    }
  }

  if (attempts.every((attempt) => attempt.reason === 'timeout')) {
    return {
      ok: false,
      command,
      kind,
      version: null,
      reason: 'timeout',
      detail: `探测 claude 超时（超过 ${Math.round(timeoutMs / 1000)}s）：${summary}`,
      resolution
    }
  }

  const responded = attempts.filter((attempt) => attempt.reason === 'wrong-cli')
  if (responded.length > 0) {
    const wrong = responded[0] as ClaudeProbeAttempt
    return {
      ok: false,
      command: wrong.path,
      kind: wrong.kind,
      version: null,
      reason: 'wrong-cli',
      detail: `claude 输出不符合 Claude Code 特征：${summary}`,
      resolution
    }
  }

  return {
    ok: false,
    command,
    kind,
    version: null,
    reason: 'error',
    detail: `无法执行 claude 探测命令：${summary}`,
    resolution
  }
}

function describeAttempt(
  versionResult: ClaudeSpawnResult,
  listResult: ClaudeSpawnResult
): string {
  const versionLine = firstLine(commandOutput(versionResult)) ?? '无输出'
  const listLine = firstLine(commandOutput(listResult)) ?? '无输出'
  return `--version 退出码 ${formatStatus(versionResult.status)}（${versionLine}）；mcp list 退出码 ${formatStatus(listResult.status)}（${listLine}）`
}

function formatStatus(status: number | null): string {
  return status === null ? 'null' : String(status)
}

function isTimeout(result: ClaudeSpawnResult): boolean {
  if (result.status !== null) return false
  const error = result.error as { code?: unknown } | undefined
  return error?.code === 'ETIMEDOUT'
}

function commandOutput(result: ClaudeSpawnResult): string {
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return [stdout, stderr].filter((part) => part.length > 0).join('\n')
}

function firstLine(text: string, maxLength = 200): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  if (line === undefined) return undefined
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line
}

function extractVersion(text: string): string | null {
  const match = VERSION_PATTERN.exec(text)
  if (match !== null) return match[1] ?? null
  return firstLine(text) ?? null
}

function explicitLooksLikePath(value: string): boolean {
  return isAbsolute(value) || value.includes('/') || value.includes('\\')
}

function nativeLookup(
  name: string,
  options: NativeLookupOptions
): { paths: string[]; source: 'where' | 'which' | 'none' } {
  const { platform, spawn, timeoutMs } = options
  if (platform === 'win32') {
    // No shell: `where.exe` is an executable and the name never reaches cmd.
    const result = safeSpawn(spawn, 'where.exe', [name], spawnOptions(timeoutMs))
    const paths = parseLookupOutput(result.stdout)
    return paths.length > 0 ? { paths, source: 'where' } : { paths: [], source: 'none' }
  }

  const dashed = safeSpawn(spawn, 'which', ['-a', name], spawnOptions(timeoutMs))
  const dashedPaths = parseLookupOutput(dashed.stdout)
  if (dashedPaths.length > 0) return { paths: dashedPaths, source: 'which' }

  // `which -a` is not portable to every minimal POSIX image.
  const plain = safeSpawn(spawn, 'which', [name], spawnOptions(timeoutMs))
  const plainPaths = parseLookupOutput(plain.stdout)
  return plainPaths.length > 0 ? { paths: plainPaths, source: 'which' } : { paths: [], source: 'none' }
}

function parseLookupOutput(stdout: string | undefined): string[] {
  if (stdout === undefined) return []
  return stdout
    .split(/\r?\n/)
    .map((line) => stripOuterQuotes(line.trim()))
    .filter((line) => line.length > 0)
}

function scanPathForClaude(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (filePath: string) => boolean,
  cwd: string
): string[] {
  const pathValue = envValue(env, 'PATH')
  if (pathValue === undefined) return []
  const names =
    platform === 'win32'
      ? WINDOWS_LAUNCHER_EXTENSIONS.map((extension) => `claude${extension}`)
      : ['claude']
  const candidates: string[] = []
  for (const rawEntry of pathValue.split(platform === 'win32' ? ';' : ':')) {
    const entry = stripOuterQuotes(rawEntry.trim())
    const directory = entry.length === 0 ? cwd : resolve(cwd, entry)
    for (const name of names) {
      const candidate = join(directory, name)
      if (exists(candidate)) candidates.push(candidate)
    }
  }
  return candidates
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name]?.trim()
  if (direct !== undefined && direct.length > 0) return direct
  const lower = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== lower) continue
    const value = env[key]?.trim()
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

function dedupePaths(paths: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const path of paths) {
    const key = platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(path)
  }
  return unique
}

function toResolution(
  candidates: string[],
  source: ClaudeCommandSource,
  platform: NodeJS.Platform
): ClaudeCommandResolution {
  const first = candidates[0]
  return {
    path: first ?? null,
    kind: first !== undefined ? claudeCommandKind(first, platform) : null,
    candidates,
    source
  }
}

function spawnOptions(timeout: number): ClaudeSpawnOptions {
  return { encoding: 'utf8', windowsHide: true, timeout, shell: false }
}

function safeSpawn(
  spawn: ClaudeSpawn,
  file: string,
  args: string[],
  options: ClaudeSpawnOptions
): ClaudeSpawnResult {
  try {
    const result = spawn(file, args, options)
    return {
      status: result.status ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error
    }
  } catch (error) {
    return { status: null, error }
  }
}

function runClaudeCommand(
  commandPath: string,
  kind: ClaudeCommandKind,
  args: string[],
  context: RunContext
): ClaudeSpawnResult {
  const invocation = claudeSpawnInvocation(commandPath, kind, args, {
    platform: context.platform,
    env: context.env,
    timeoutMs: context.timeoutMs
  })
  return safeSpawn(context.spawn, invocation.file, invocation.args, invocation.options)
}
