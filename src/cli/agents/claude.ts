import { join } from 'node:path'
import { quoteShellArg } from '../../shared/mcpConfig'
import type { CliRuntime } from '../runtime'
import type { AgentPlan, ClaudeCliRunner, FilePlan, InitAction } from './index'
import { planRuleFile } from './rules'

/**
 * Claude Code integration.
 *
 * Claude Code keeps MCP registrations inside its own CLI, so there is no file to
 * edit: `ctx init` runs `claude mcp add` (spawned through an injectable runner,
 * or through the OS shell in production). Previous registrations — including the
 * pre-rename `pentest-data-hub` server — are removed first so an SSE-era entry
 * is upgraded instead of duplicated.
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

/** Copy-paste command shown when the CLI is missing or refuses to register. */
export function claudeAddCommand(runtime: CliRuntime): string {
  return ['claude', ...claudeAddArgs(runtime)].map(quoteShellArg).join(' ')
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

/** Dry-run preview of the registration action. */
export function previewClaudeRegistration(runtime: CliRuntime): InitAction {
  return {
    agent: 'claude',
    kind: 'mcp',
    path: 'claude mcp add',
    status: 'planned',
    detail: `将执行 ${claudeAddCommand(runtime)}（先移除旧 cortex / pentest-data-hub 注册）`
  }
}

/**
 * Register (or re-register) the stdio server with Claude Code.
 *
 * Every failure mode degrades to `manual-required` with the exact command: a
 * missing CLI or a policy-blocked shell must not abort the file installs.
 */
export function applyClaudeRegistration(
  runtime: CliRuntime,
  runClaudeCli: ClaudeCliRunner
): InitAction {
  const command = claudeAddCommand(runtime)
  const existing = safeRun(runClaudeCli, claudeGetArgs())

  if (existing.status === null) {
    return {
      agent: 'claude',
      kind: 'mcp',
      path: 'claude mcp add',
      status: 'manual-required',
      detail: `未检测到 Claude Code CLI：请先安装（npm install -g @anthropic-ai/claude-code），然后执行：${command}`
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
      detail: `调用 claude CLI 失败：${describeError(added.error)}；请手动执行：${command}`
    }
  }
  if (added.status !== 0) {
    const stderr = (added.stderr ?? '').trim()
    return {
      agent: 'claude',
      kind: 'mcp',
      path: 'claude mcp add',
      status: 'manual-required',
      detail: `${stderr.length > 0 ? stderr : 'claude mcp add 执行失败'}；请手动执行：${command}`
    }
  }

  return {
    agent: 'claude',
    kind: 'mcp',
    path: 'claude mcp add',
    status: existed ? 'updated' : 'created',
    detail: existed
      ? '已将 Claude Code 重新注册为 cortex（stdio，替换旧注册）'
      : '已以 stdio 注册为 cortex 到 Claude Code'
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
  return String(error)
}
