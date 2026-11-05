import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CAC } from 'cac'
import { readSchemaVersion } from '../../core/db/DatabaseService'
import { CORTEX_VERSION } from '../../core/version'
import { DATABASE_SCHEMA_VERSION } from '../../shared/types'
import {
  claudeFixHint,
  describeClaudeProbe,
  inspectClaudeCommand,
  type ClaudeInspection
} from '../agents/claudeCommand'
import {
  cliDatabasePath,
  createCliContext,
  resolveHomeDirectory,
  type CliContext
} from '../context'
import {
  formatBytes,
  formatLocalTime,
  renderTable,
  shouldUseColor,
  statusMark,
  type ColorOptions
} from '../format'
import { mcpEntryExists, resolveCliRuntime, type CliRuntime } from '../runtime'
import { resolveUiExecutable, type UiResolution } from './open'

/**
 * `ctx doctor` — one table that answers "why don't my tools work?".
 *
 * It never writes and never migrates: every probe is read-only, so it is safe
 * to run while the GUI and several agents have the database open.
 */
export interface DoctorCheck {
  category: 'database' | 'runtime' | 'agent' | 'gui' | 'version'
  label: string
  value: string
  ok: boolean
  hint?: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
}

export interface DoctorDeps {
  runtime?: CliRuntime
  exists?: (filePath: string) => boolean
  readText?: (filePath: string) => string
  resolveUi?: () => UiResolution | null
  /**
   * Overridable for tests: default resolves the real launcher (`where.exe` /
   * `which`, never a hardcoded `claude.cmd`) and proves it is Claude Code.
   */
  inspectClaude?: () => ClaudeInspection
}

function readIfExists(readText: (filePath: string) => string, filePath: string): string {
  try {
    return readText(filePath)
  } catch {
    return ''
  }
}

function fileSize(filePath: string, exists: (filePath: string) => boolean): number {
  if (!exists(filePath)) return 0
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

function lastModified(filePath: string): string | null {
  try {
    return new Date(statSync(filePath).mtimeMs).toISOString()
  } catch {
    return null
  }
}

function directoryWritable(directory: string): boolean {
  try {
    if (!existsSync(directory)) return false
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Profile patch layers that still carry a Cortex-owned MCP registration.
 *
 * Current Cortex writes the DSH home-level patch layer
 * (`$DSH_HOME/cordis.patch.yml`) only; a leftover registration in a profile
 * patch would make DSH see `serverName: cortex` twice and reject the load, so
 * `ctx doctor` reports it as a migration that `ctx init --agents dsh` performs.
 */
function legacyDshProfilePatches(
  dshHome: string,
  exists: (filePath: string) => boolean,
  readText: (filePath: string) => string
): string[] {
  const profilesRoot = join(dshHome, 'profiles')
  let entries: Dirent[] = []
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const matches: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const patchPath = join(profilesRoot, entry.name, 'cordis.patch.yml')
    if (!exists(patchPath)) continue
    const content = readIfExists(readText, patchPath)
    if (/mcp-cortex|mcp-pentest-data-hub|CORTEX BEGIN|PENTEST-DATA-HUB BEGIN/.test(content)) {
      matches.push(patchPath)
    }
  }
  return matches
}

function agentChecks(deps: DoctorDeps, context: CliContext, runtime: CliRuntime): DoctorCheck[] {
  const home = resolveHomeDirectory(context)
  const exists = deps.exists ?? existsSync
  const readText = deps.readText ?? ((filePath: string) => readFileSync(filePath, 'utf8'))
  const checks: DoctorCheck[] = []
  const expectedEntry = runtime.mcpEntry.replace(/\\/g, '/')

  const dshHome = context.env['DSH_HOME'] || join(home, '.dsh')
  const dshHomePatch = join(dshHome, 'cordis.patch.yml')
  const legacyDshPatches = legacyDshProfilePatches(dshHome, exists, readText)
  if (!exists(dshHomePatch)) {
    checks.push({
      category: 'agent',
      label: 'DeepSeek Harness',
      value:
        legacyDshPatches.length > 0
          ? `未写入 DSH 根目录 patch 层（${dshHomePatch}）；检测到 ${legacyDshPatches.length} 个旧 profile 层注册`
          : `未检测到 DSH 根目录 patch 层（${dshHomePatch}）`,
      ok: false,
      hint:
        legacyDshPatches.length > 0
          ? '运行 ctx init --agents dsh 迁移到 DSH 根目录（清理旧 profile 层）'
          : '运行 ctx init --agents dsh 写入 DSH 根目录 patch 层（对所有 profile 生效）'
    })
  } else if (legacyDshPatches.length > 0) {
    checks.push({
      category: 'agent',
      label: 'DeepSeek Harness',
      value: `${dshHomePatch}（根目录已写入，但 ${legacyDshPatches.length} 个旧 profile 层仍有 Cortex 注册：${legacyDshPatches[0] ?? ''}）`,
      ok: false,
      hint: '运行 ctx init --agents dsh 清理旧 profile 层（重复 serverName 会导致 DSH 加载失败）'
    })
  } else {
    const content = readIfExists(readText, dshHomePatch)
    const hasEntry = content.includes('mcp-cortex')
    const pointsAtEntry = content.includes(expectedEntry) || content.includes(runtime.mcpEntry)
    checks.push({
      category: 'agent',
      label: 'DeepSeek Harness',
      value: !hasEntry
        ? `${dshHomePatch}（缺少 mcp-cortex 条目）`
        : pointsAtEntry
          ? dshHomePatch
          : `${dshHomePatch}（不是当前 stdio 入口）`,
      ok: hasEntry && pointsAtEntry,
      hint: hasEntry && pointsAtEntry ? undefined : '运行 ctx init --agents dsh 重写 DSH 根目录 patch 层'
    })
  }

  const codexHome = context.env['CODEX_HOME'] || join(home, '.codex')
  const codexConfig = join(codexHome, 'config.toml')
  if (!exists(codexConfig)) {
    checks.push({
      category: 'agent',
      label: 'Codex CLI',
      value: '未检测到 config.toml',
      ok: false,
      hint: '运行 ctx init --agents codex 接入'
    })
  } else {
    const hasSection = readIfExists(readText, codexConfig).includes('[mcp_servers.cortex]')
    checks.push({
      category: 'agent',
      label: 'Codex CLI',
      value: hasSection ? codexConfig : `${codexConfig}（缺少 [mcp_servers.cortex]）`,
      ok: hasSection,
      hint: hasSection ? undefined : '运行 ctx init --agents codex 接入'
    })
  }

  const cursorConfig = join(home, '.cursor', 'mcp.json')
  if (!exists(cursorConfig)) {
    checks.push({
      category: 'agent',
      label: 'Cursor',
      value: '未检测到 mcp.json',
      ok: false,
      hint: '运行 ctx init --agents cursor 接入'
    })
  } else {
    let registered = false
    try {
      const parsed = JSON.parse(readIfExists(readText, cursorConfig)) as {
        mcpServers?: Record<string, unknown>
      }
      registered = parsed.mcpServers?.['cortex'] !== undefined
    } catch {
      registered = false
    }
    checks.push({
      category: 'agent',
      label: 'Cursor',
      value: registered ? cursorConfig : `${cursorConfig}（缺少 cortex）`,
      ok: registered,
      hint: registered ? undefined : '运行 ctx init --agents cursor 接入'
    })
  }

  checks.push(...claudeChecks(deps, context))

  return checks
}

/**
 * Claude Code is special: the launcher may be a `.exe` (official native install),
 * a `.cmd` (npm global install) or even a Bun shim that answers `--version` with
 * exit code 0 while printing Bun's help. Show what was resolved, what the probe
 * concluded, and only then the MCP registration state (B.4.5).
 *
 * `inspectClaude` is injectable and may throw (it spawns external processes), so
 * a failure degrades to failed checks instead of crashing `ctx doctor`.
 */
function claudeChecks(deps: DoctorDeps, context: CliContext): DoctorCheck[] {
  const inspect =
    deps.inspectClaude ??
    (() => inspectClaudeCommand({ env: context.env, platform: process.platform }))

  let inspection: ClaudeInspection
  try {
    inspection = inspect()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [
      {
        category: 'agent',
        label: 'Claude Code 命令',
        value: `解析 claude 命令失败：${message}`,
        ok: false,
        hint: '确认 claude --version 可正常运行（where.exe claude / Get-Command claude -All 查看路径）'
      },
      {
        category: 'agent',
        label: 'Claude Code 探测',
        value: `探测失败：${message}`,
        ok: false,
        hint: '重开终端后重试；安装 Claude Code 后运行 ctx init --agents claude 接入'
      }
    ]
  }

  const probe = inspection.probe
  const checks: DoctorCheck[] = [
    {
      category: 'agent',
      label: 'Claude Code 命令',
      value:
        probe.command === null
          ? '未找到 claude 命令（where.exe / which 均无结果）'
          : `${probe.command}（kind: ${probe.kind ?? 'unknown'}，source: ${probe.resolution.source}）`,
      ok: probe.ok,
      hint: probe.ok ? undefined : claudeFixHint(probe, { platform: process.platform })
    },
    {
      category: 'agent',
      label: 'Claude Code 探测',
      value: probe.ok
        ? `ok · ${describeClaudeProbe(probe)}${
            probe.method === undefined ? '' : `（method: ${probe.method}）`
          }`
        : `${probe.reason ?? 'error'} · ${describeClaudeProbe(probe)}`,
      ok: probe.ok,
      hint: probe.ok ? undefined : claudeFixHint(probe, { platform: process.platform })
    }
  ]

  // Only a launcher that actually runs as Claude Code may be asked for its MCP
  // registrations; a Bun shim would just print its own help again.
  if (probe.ok) checks.push(claudeRegistrationCheck(inspection))
  return checks
}

/** `claude mcp get cortex` — registration state, or an explicit "cannot run". */
function claudeRegistrationCheck(inspection: ClaudeInspection): DoctorCheck {
  let status: number | null = null
  try {
    status = inspection.run(['mcp', 'get', 'cortex']).status
  } catch {
    status = null
  }

  if (status === null) {
    return {
      category: 'agent',
      label: 'Claude Code',
      value: '无法执行 claude mcp get cortex（命令未返回状态，可能被安全策略拦截）',
      ok: false,
      hint: '在终端手动运行 claude mcp get cortex 确认；随后运行 ctx init --agents claude 接入'
    }
  }
  if (status === 0) {
    return { category: 'agent', label: 'Claude Code', value: '已注册 cortex（stdio）', ok: true }
  }
  return {
    category: 'agent',
    label: 'Claude Code',
    value: '未注册 cortex（stdio）',
    ok: false,
    hint: '运行 ctx init --agents claude 接入'
  }
}

export function collectDoctorReport(context: CliContext, deps: DoctorDeps = {}): DoctorReport {
  const checks: DoctorCheck[] = []
  const runtime = deps.runtime ?? resolveCliRuntime({ env: context.env })
  const exists = deps.exists ?? existsSync
  const dbPath = cliDatabasePath(context)
  const dbDirectory = dirname(dbPath)
  const schemaVersion = readSchemaVersion(dbPath)
  const dbExists = exists(dbPath)

  checks.push({ category: 'database', label: '数据库路径', value: dbPath, ok: true })
  checks.push({
    category: 'database',
    label: '数据库文件',
    value: dbExists
      ? `${formatBytes(fileSize(dbPath, exists))} · ${formatLocalTime(lastModified(dbPath))}`
      : '尚未创建（启动 GUI 或首次 Agent 写入后生成）',
    ok: dbExists,
    hint: dbExists ? undefined : '启动 GUI 或让 Agent 首次写入'
  })
  checks.push({
    category: 'database',
    label: '目录可写',
    value: dbDirectory,
    ok: directoryWritable(dbDirectory) || !dbExists,
    hint: directoryWritable(dbDirectory) ? undefined : '数据库目录不可写，请检查权限'
  })
  checks.push({
    category: 'database',
    label: 'schema 版本',
    value:
      schemaVersion === null
        ? '—（数据库不存在）'
        : `v${schemaVersion} / 期望 v${DATABASE_SCHEMA_VERSION}`,
    ok: schemaVersion === DATABASE_SCHEMA_VERSION,
    hint:
      schemaVersion !== null && schemaVersion < DATABASE_SCHEMA_VERSION
        ? '启动 GUI 完成迁移，或重新运行 ctx doctor'
        : undefined
  })
  const walSize = fileSize(`${dbPath}-wal`, exists)
  checks.push({
    category: 'database',
    label: 'WAL 文件',
    value:
      walSize > 0
        ? `${formatBytes(walSize)}（WAL 模式生效）`
        : dbExists
          ? '未生成（写入后自动出现）'
          : '—',
    ok: true
  })

  checks.push({
    category: 'runtime',
    label: '运行模式',
    value: runtime.mode === 'installed' ? `安装版（${runtime.root}）` : `开发模式（${runtime.root}）`,
    ok: true
  })
  checks.push({
    category: 'runtime',
    label: 'Node 运行时',
    value: runtime.nodeExecutable,
    ok: exists(runtime.nodeExecutable),
    hint: exists(runtime.nodeExecutable)
      ? undefined
      : '安装版应包含 bin/node.exe；开发模式请确认 node 可用'
  })
  checks.push({
    category: 'runtime',
    label: 'stdio MCP 入口',
    value: runtime.mcpEntry,
    ok: mcpEntryExists(runtime),
    hint: mcpEntryExists(runtime) ? undefined : '开发模式运行 npm run build:mcp；安装版请重新安装'
  })
  checks.push({
    category: 'runtime',
    label: 'CLI 入口',
    value: runtime.cliEntry,
    ok: exists(runtime.cliEntry),
    hint: exists(runtime.cliEntry) ? undefined : 'CLI 入口不存在，请重新构建（npm run build:cli）'
  })
  checks.push({
    category: 'runtime',
    label: 'Skill 源目录',
    value: runtime.skillSourceDir,
    ok: exists(runtime.skillSourceDir),
    hint: exists(runtime.skillSourceDir)
      ? undefined
      : '缺少技能源目录（安装版应为 bin/skills，开发版应为 <repo>/skills）'
  })

  checks.push(...agentChecks(deps, context, runtime))

  const ui = (deps.resolveUi ?? (() => resolveUiExecutable({ env: context.env })))()
  const sourceBuildReady =
    ui === null &&
    runtime.mode === 'development' &&
    exists(join(runtime.root, 'out', 'main', 'index.js'))
  checks.push({
    category: 'gui',
    label: 'GUI 可用性',
    value:
      ui !== null
        ? `${ui.exePath}（${ui.source}）`
        : sourceBuildReady
          ? `源码构建（${join(runtime.root, 'out', 'main', 'index.js')}）；ctx open 或 npm start 启动`
          : '未找到已安装的 Cortex 桌面端，也未检测到 out/main/index.js',
    ok: ui !== null || sourceBuildReady,
    hint:
      ui !== null || sourceBuildReady
        ? undefined
        : '安装 Cortex 桌面端，或先 npm run build 后用 ctx open / npm start 启动'
  })

  checks.push({ category: 'version', label: '版本', value: CORTEX_VERSION, ok: true })

  return { ok: checks.every((check) => check.ok), checks }
}

const CATEGORY_LABELS: Record<DoctorCheck['category'], string> = {
  database: '数据库',
  runtime: '运行时',
  agent: 'Agent',
  gui: 'GUI',
  version: '版本'
}

export function formatDoctorReport(report: DoctorReport): string {
  const colors: ColorOptions = { enabled: shouldUseColor(false) }
  const grouped = new Map<DoctorCheck['category'], DoctorCheck[]>()
  for (const check of report.checks) {
    const list = grouped.get(check.category) ?? []
    list.push(check)
    grouped.set(check.category, list)
  }

  const lines: string[] = []
  for (const [category, checks] of grouped) {
    lines.push(CATEGORY_LABELS[category])
    const rows = checks.map((check) => [
      statusMark(check.ok, colors),
      check.label,
      check.value,
      check.hint ?? ''
    ])
    lines.push(
      renderTable(
        [
          { title: '', maxWidth: 2 },
          { title: '检查项', maxWidth: 18 },
          { title: '结果', maxWidth: 70 },
          { title: '建议', maxWidth: 44 }
        ],
        rows
      )
    )
    lines.push('')
  }
  lines.push(report.ok ? '全部检查通过 ✓' : '存在未通过项，请按「建议」列处理。')
  return lines.join('\n').trimEnd()
}

export async function runDoctor(
  _options: Record<string, unknown>,
  context: CliContext,
  deps: DoctorDeps = {}
): Promise<void> {
  const report = collectDoctorReport(context, deps)
  if (context.json) {
    context.stdout(JSON.stringify(report, null, 2))
    return
  }
  context.stdout(formatDoctorReport(report))
}

export function registerDoctorCommand(cli: CAC): void {
  cli
    .command('doctor', '检查数据库、stdio MCP 运行时、Agent 配置与 GUI 安装状态')
    .action(async (options: Record<string, unknown>) => {
      await runDoctor(options, createCliContext())
    })
}
