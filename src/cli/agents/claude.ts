import { join } from 'node:path'
import { quoteShellArg } from '../../shared/mcpConfig'
import type { CliRuntime } from '../runtime'
import {
  claudeFixLines,
  describeClaudeProbe,
  type ClaudeCliRunner,
  type ClaudeProbeResult
} from './claudeCommand'
import type { AgentPlan, FilePlan, InitAction } from './index'
import { planRuleFile } from './rules'

/**
 * Claude Code integration.
 *
 * Claude Code keeps MCP registrations inside its own CLI, so there is no file to
 * edit: `ctx init` runs `claude mcp add` through a runner bound to the launcher
 * that `probeClaudeCommand` resolved and proved to be Claude Code (`.exe`
 * directly, `.cmd`/`.bat` through cmd.exe). Previous registrations — including
 * the pre-rename `pentest-data-hub` server — are removed first so an SSE-era
 * entry is upgraded instead of duplicated. A failed probe (Bun shim, wrong CLI,
 * not installed) never reaches the runner: the action degrades to
 * `manual-required` with actionable repair steps instead.
 *
 * Claude Desktop is intentionally **hint only**: its config is JSON, but it is a
 * separate product, so writing it silently would surprise the user.
 */

export const CLAUDE_SERVER_NAME = 'cortex'
/** Pre-rename registration, removed so the agent never sees two servers. */
export const LEGACY_CLAUDE_SERVER_NAME = 'pentest-data-hub'

export function claudeGetArgs(): string[] {
  return ['mcp', 'get', CLAUDE_SERVER_NAME]
}

export function claudeRemoveArgs(name: string = CLAUDE_SERVER_NAME): string[] {
  return ['mcp', 'remove', name]
}

export function claudeRemoveLegacyArgs(): string[] {
  return claudeRemoveArgs(LEGACY_CLAUDE_SERVER_NAME)
}

export function claudeAddArgs(runtime: CliRuntime): string[] {
  return [
    'mcp',
    'add',
    '--transport',
    'stdio',
    CLAUDE_SERVER_NAME,
    '--',
    runtime.nodeExecutable,
    runtime.mcpEntry
  ]
}

/**
 * Copy-paste command shown when the CLI is missing or refuses to register.
 *
 * `commandName` is the launcher the probe actually resolved (`claude.exe`,
 * `claude.cmd`, a custom `CORTEX_CLAUDE_BIN`, …): the manual fix must name the
 * real launcher instead of assuming a bare `claude` on PATH. It defaults to
 * `claude` so existing callers keep the old behavior.
 */
export function claudeAddCommand(runtime: CliRuntime, commandName: string = 'claude'): string {
  return [commandName, ...claudeAddArgs(runtime)].map(quoteShellArg).join(' ')
}

export function claudeDesktopConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const appData = env['APPDATA']?.trim()
  if (appData === undefined || appData.length === 0) return undefined
  return join(appData, 'Claude', 'claude_desktop_config.json')
}

export interface ClaudePlanOptions {
  claudeHome: string
  env: NodeJS.ProcessEnv
  exists: (filePath: string) => boolean
  readFile: (filePath: string) => string
}

/**
 * Claude Code file targets (rules and the Claude Desktop hint). The MCP
 * registration is applied separately, after confirmation.
 */
export function planClaude(options: ClaudePlanOptions): AgentPlan {
  const files: FilePlan[] = [
    planRuleFile({
      agent: 'claude',
      path: join(options.claudeHome, 'CLAUDE.md'),
      exists: options.exists,
      readFile: options.readFile
    })
  ]
  const warnings: string[] = []

  const desktopConfig = claudeDesktopConfigPath(options.env)
  if (desktopConfig !== undefined && options.exists(desktopConfig)) {
    warnings.push(
      `检测到 Claude Desktop 配置：${desktopConfig}（本次不改写；如需在 Claude Desktop 使用，请手动把 stdio MCP 配置加入该文件的 mcpServers）`
    )
  }

  return { files, warnings }
}

/**
 * Dry-run preview of the registration action.
 *
 * A failed probe (Bun shim / wrong CLI / not installed / …) must not advertise
 * `claude mcp add`: the preview degrades to `manual-required` and carries the
 * same diagnosis + repair steps the real run would return.
 */
export function previewClaudeRegistration(
  runtime: CliRuntime,
  probe: ClaudeProbeResult
): InitAction {
  if (!probe.ok) {
    return {
      agent: 'claude',
      kind: 'mcp',
      path: 'claude mcp add',
      status: 'manual-required',
      detail: claudeFixLines(probe, {
        platform: process.platform,
        // The resolved launcher is the broken one (e.g. the Bun shim path), so
        // the copy-paste command after repair stays a plain `claude`.
        manualCommand: claudeAddCommand(runtime)
      }).join('\n')
    }
  }
  return {
    agent: 'claude',
    kind: 'mcp',
    path: 'claude mcp add',
    status: 'planned',
    detail: `将执行 ${claudeAddCommand(runtime, probe.command ?? undefined)}（先移除旧 cortex / pentest-data-hub 注册）`
  }
}

/**
 * Register (or re-register) the stdio server with Claude Code.
 *
 * When the launcher probe already failed, running `claude mcp get/remove/add`
 * would talk to the wrong CLI (a Bun shim answers with exit code 0 but is not
 * Claude Code), so a failed probe returns `manual-required` **before** touching
 * the runner. Only a probed-ok command is ever used for registration.
 *
 * Every remaining failure mode still degrades to `manual-required` with the
 * exact command: a policy-blocked shell must not abort the file installs.
 */
export function applyClaudeRegistration(
  runtime: CliRuntime,
  probe: ClaudeProbeResult,
  runClaudeCli: ClaudeCliRunner
): InitAction {
  // A failed probe resolved to a launcher that is not Claude Code (for example
  // a Bun shim); the repair instruction must name a plain `claude` instead.
  const command = probe.ok
    ? claudeAddCommand(runtime, probe.command ?? undefined)
    : claudeAddCommand(runtime)

  if (!probe.ok) {
    return {
      agent: 'claude',
      kind: 'mcp',
      path: 'claude mcp add',
      status: 'manual-required',
      detail: claudeFixLines(probe, {
        platform: process.platform,
        manualCommand: command
      }).join('\n')
    }
  }

  const probeSummary = describeClaudeProbe(probe)
  const existing = safeRun(runClaudeCli, claudeGetArgs())

  if (existing.status === null) {
    return {
      agent: 'claude',
      kind: 'mcp',
      path: 'claude mcp add',
      status: 'manual-required',
      detail: `调用 claude CLI 失败（${probeSummary}）：${describeError(existing.error)}；请手动执行：${command}`
    }
  }

  const existed = existing.status === 0
  if (existed) safeRun(runClaudeCli, claudeRemoveArgs())
  // Best effort: a legacy server left behind would keep the old product name
  // visible in `claude mcp list` next to Cortex.
  safeRun(runClaudeCli, claudeRemoveLegacyArgs())

  const added = safeRun(runClaudeCli, claudeAddArgs(runtime))
  if (added.status === null) {
    return {
      agent: 'claude',
      kind: 'mcp',
      path: 'claude mcp add',
      status: 'manual-required',
      detail: `调用 claude CLI 失败（${probeSummary}）：${describeError(added.error)}；请手动执行：${command}`
    }
  }
  if (added.status !== 0) {
    const stderr = (added.stderr ?? '').trim()
    return {
      agent: 'claude',
      kind: 'mcp',
      path: 'claude mcp add',
      status: 'manual-required',
      detail: `${stderr.length > 0 ? stderr : 'claude mcp add 执行失败'}（${probeSummary}）；请手动执行：${command}`
    }
  }

  const resolvedPath = probe.command ?? 'claude'
  return {
    agent: 'claude',
    kind: 'mcp',
    path: 'claude mcp add',
    status: existed ? 'updated' : 'created',
    detail: existed
      ? `已将 Claude Code 重新注册为 cortex（stdio，替换旧注册；解析路径：${resolvedPath}）`
      : `已以 stdio 注册为 cortex 到 Claude Code（解析路径：${resolvedPath}）`
  }
}

function safeRun(runClaudeCli: ClaudeCliRunner, args: string[]): ReturnType<ClaudeCliRunner> {
  try {
    return runClaudeCli(args)
  } catch (error) {
    return { status: null, error }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error === undefined) return 'claude 命令未返回结果'
  return String(error)
}
