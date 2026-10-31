import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import type { CAC } from 'cac'
import { createCliContext, resolveHomeDirectory, type CliContext } from '../context'
import { CliError } from '../errors'
import { color, printJson, shouldUseColor, type ColorOptions } from '../format'
import { mcpEntryExists, resolveCliRuntime, type CliRuntime } from '../runtime'
import {
  AGENT_IDS,
  detectAgents,
  parseAgentSelection,
  resolveAgentHomes,
  type AgentPlan,
  type ClaudeCliRunner,
  type FilePlan,
  type InitAction,
  type InitActionStatus,
  type InitReport,
  type SkillLanguage
} from '../agents'
import {
  applyClaudeRegistration,
  planClaude,
  previewClaudeRegistration
} from '../agents/claude'
import { planCodex } from '../agents/codex'
import { planCursor } from '../agents/cursor'
import { planDsh } from '../agents/dsh'
import { planSkills, resolveSkillLanguage } from '../agents/skills'
import { planWorkBuddy } from '../agents/workbuddy'
import { planZcode } from '../agents/zcode'

export type { InitAction, InitReport } from '../agents'
/** Re-exported for the Electron first-run setup wizard (stable contract). */
export { detectAgents, parseAgentSelection, resolveAgentHomes } from '../agents'

/**
 * `ctx init` — the one-command agent integration.
 *
 * For every detected (or explicitly requested) agent it writes:
 *   1. a stdio MCP registration (DSH YAML / Codex TOML / Cursor JSON /
 *      `claude mcp add`),
 *   2. the `vuln-db` / `asset-context` / `snapshot` skills in the selected
 *      language (`--skill-lang zh|en`, default `zh`),
 *   3. the marker-managed system hard rules.
 *
 * Everything is planned first (candidate contents + compact diff), then the
 * user confirms, then existing files are backed up to `.bak-YYYYMMDD-HHmmss`
 * and rewritten. A second run detects identical content and reports `skipped`.
 */

export const RESTART_HINT = '重启对应 Agent 后生效（无需重启 GUI）。'
export const DOCTOR_HINT = '建议运行 ctx doctor 验证。'

export interface InitOptions {
  dryRun?: boolean
  yes?: boolean
  /** Comma list: `dsh,codex,claude,cursor,workbuddy,zcode`. Omitted = auto-detect. */
  agents?: string
  /** Skill language copied into the agent skill directories. */
  skillLang?: SkillLanguage
}

export interface InitDeps {
  runtime?: CliRuntime
  /** Backup timestamp source; injectable for deterministic tests. */
  now?: () => Date
  runClaudeCli?: ClaudeCliRunner
  exists?: (filePath: string) => boolean
  readFile?: (filePath: string) => string
  writeFile?: (filePath: string, content: string) => void
  copyFile?: (from: string, to: string) => void
}

export async function runInit(
  options: InitOptions,
  context: CliContext,
  deps: InitDeps = {}
): Promise<InitReport> {
  const dryRun = options.dryRun === true
  const skillLanguage = resolveSkillLanguage(options.skillLang, context.env)
  const runtime = deps.runtime ?? resolveCliRuntime({ env: context.env })
  const home = resolveHomeDirectory(context)
  const exists = deps.exists ?? existsSync
  const readFile = deps.readFile ?? ((filePath: string) => readFileSync(filePath, 'utf8'))
  const writeFile =
    deps.writeFile ??
    ((filePath: string, content: string) => writeFileSync(filePath, content, 'utf8'))
  const copyFile = deps.copyFile ?? ((from: string, to: string) => copyFileSync(from, to))
  const runClaudeCli = deps.runClaudeCli ?? defaultRunClaudeCli
  const now = deps.now ?? (() => new Date())

  const warnings: string[] = []
  if (!mcpEntryExists(runtime)) {
    warnings.push(
      `未找到 stdio MCP 入口 ${runtime.mcpEntry}，请先运行 npm run build:mcp（开发）或重新安装（安装版）`
    )
  }

  const homes = resolveAgentHomes(home, context.env)
  const requested = parseAgentSelection(options.agents)
  const selected =
    requested ??
    (() => {
      const detected = detectAgents(homes, exists, runClaudeCli)
      return AGENT_IDS.filter((agent) => detected[agent])
    })()

  const plans: AgentPlan[] = []
  if (selected.includes('dsh')) {
    plans.push(
      planDsh({
        dshHome: homes.dsh,
        env: context.env,
        runtime,
        exists,
        readFile
      })
    )
  }
  if (selected.includes('codex')) {
    plans.push(planCodex({ codexHome: homes.codex, runtime, exists, readFile }))
  }
  if (selected.includes('cursor')) {
    plans.push(planCursor({ home, runtime, exists, readFile }))
  }
  if (selected.includes('claude')) {
    plans.push(planClaude({ claudeHome: homes.claude, env: context.env, exists, readFile }))
  }
  if (selected.includes('workbuddy')) {
    plans.push(
      planWorkBuddy({
        workbuddyHome: homes.workbuddy,
        runtime,
        exists,
        readFile
      })
    )
  }
  if (selected.includes('zcode')) {
    plans.push(planZcode({ zcodeHome: homes.zcode, runtime, exists, readFile }))
  }
  plans.push(
    planSkills({
      runtime,
      home,
      codexHome: homes.codex,
      claudeHome: homes.claude,
      zcodeHome: homes.zcode,
      agents: selected,
      skillLanguage,
      exists,
      readFile
    })
  )
  for (const plan of plans) warnings.push(...plan.warnings)

  const files = plans.flatMap((plan) => plan.files)
  const modifications = files.filter((file) => file.status !== 'skipped')

  if (!dryRun && options.yes !== true) {
    await confirmWrite(modifications.length)
  }

  const actions: InitAction[] = []
  if (dryRun) {
    for (const file of files) actions.push(toAction(file, 'planned'))
    if (selected.includes('claude')) actions.push(previewClaudeRegistration(runtime))
  } else {
    const stamp = formatBackupStamp(now())
    for (const file of files) {
      if (file.status === 'skipped') {
        actions.push(toAction(file))
        continue
      }
      if (file.content === undefined) {
        throw new CliError(`无法写入 ${file.path}：缺少待写入内容`, 1)
      }
      const backupPath = exists(file.path) ? `${file.path}.bak-${stamp}` : undefined
      if (backupPath !== undefined) copyFile(file.path, backupPath)
      mkdirSync(dirname(file.path), { recursive: true })
      writeFile(file.path, file.content)
      actions.push(toAction(file, undefined, backupPath))
    }
    if (selected.includes('claude')) {
      actions.push(applyClaudeRegistration(runtime, runClaudeCli))
    }
  }

  const report: InitReport = { dryRun, skillLanguage, actions, warnings, restartHint: RESTART_HINT }
  printReport(report, context)
  return report
}

function toAction(
  file: FilePlan,
  statusOverride?: InitActionStatus,
  backupPath?: string
): InitAction {
  const details = [file.detail, backupPath === undefined ? undefined : `已备份到 ${backupPath}`]
    .filter((detail): detail is string => detail !== undefined && detail.length > 0)
  return {
    agent: file.agent,
    kind: file.kind,
    path: file.path,
    status: statusOverride ?? file.status,
    detail: details.length > 0 ? details.join('；') : undefined,
    diff: file.diff
  }
}

function formatBackupStamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** TTY confirmation; without one, refuse instead of silently writing. */
async function confirmWrite(fileCount: number): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new CliError('非交互环境请使用 --yes 执行写入（--dry-run 可预览）', 1)
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => {
      readline.question(`将修改 ${fileCount} 个文件，继续？[y/N] `, resolve)
    })
    if (!/^y(es)?$/i.test(answer.trim())) throw new CliError('已取消', 1)
  } finally {
    readline.close()
  }
}

const STATUS_LABELS: Record<InitActionStatus, string> = {
  created: '创建',
  updated: '更新',
  skipped: '跳过',
  'manual-required': '需手动处理',
  planned: '计划写入',
  failed: '失败'
}

function printReport(report: InitReport, context: CliContext): void {
  if (context.json) {
    printJson(report, context.stdout)
    return
  }

  const colors: ColorOptions = { enabled: shouldUseColor(context.json) }
  for (const action of report.actions) {
    const tag = action.agent === undefined ? 'shared' : action.agent
    context.stdout(
      `${color.dim(`[${tag}]`, colors)} ${paintStatus(action.status, colors)} ${action.path}`
    )
    if (action.detail !== undefined) context.stdout(`  ${action.detail}`)
    if (action.diff !== undefined && action.diff.length > 0) {
      for (const line of action.diff.split('\n')) context.stdout(`  ${line}`)
    }
  }

  if (report.warnings.length > 0) {
    context.stdout('')
    for (const warning of report.warnings) {
      context.stdout(`${color.yellow('警告', colors)}: ${warning}`)
    }
  }
  context.stdout('')
  context.stdout(`${color.dim('技能语言:', colors)} ${report.skillLanguage}`)
  context.stdout(report.restartHint)
  context.stdout(DOCTOR_HINT)
}

function paintStatus(status: InitActionStatus, colors: ColorOptions): string {
  const label = STATUS_LABELS[status]
  switch (status) {
    case 'created':
      return color.green(label, colors)
    case 'updated':
      return color.cyan(label, colors)
    case 'manual-required':
      return color.yellow(label, colors)
    case 'failed':
      return color.red(label, colors)
    case 'planned':
      return color.blue(label, colors)
    case 'skipped':
      return color.dim(label, colors)
    default:
      return label
  }
}

/** Production `claude` probe/spawn: shell on Windows resolves `claude.cmd`. */
function defaultRunClaudeCli(args: string[]): ReturnType<ClaudeCliRunner> {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'claude.cmd' : 'claude', args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32',
      timeout: 20_000
    })
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

export function registerInitCommand(cli: CAC, context?: CliContext): void {
  cli
    .command('init', '一键接入 Agent：stdio MCP 配置 + 三个 Skill + 系统级强制规则')
    .option('--dry-run', '只展示将修改的文件与 diff，不写任何文件')
    .option('--yes', '跳过交互确认，直接写入')
    .option('--agents <agents>', '限定 Agent，逗号分隔：dsh,codex,claude,cursor,workbuddy,zcode（默认自动检测）')
    .option('--skill-lang <lang>', 'Skill 语言：zh | en（默认 zh，可用 CTX_SKILL_LANG 覆盖）')
    .action(async (options: InitOptions) => {
      await runInit(options, context ?? createCliContext())
    })
}
