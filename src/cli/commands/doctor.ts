import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CAC } from 'cac'
import { readSchemaVersion } from '../../core/db/DatabaseService'
import { CORTEX_VERSION } from '../../core/version'
import { DATABASE_SCHEMA_VERSION } from '../../shared/types'
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
  /** Overridable for tests: default probes the real `claude` CLI. */
  probeClaude?: () => boolean
}

function probeClaudeCli(): boolean {
  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'claude.cmd' : 'claude',
      ['mcp', 'get', 'cortex'],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000
      }
    )
    return result.status === 0
  } catch {
    return false
  }
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

function agentChecks(deps: DoctorDeps, context: CliContext, runtime: CliRuntime): DoctorCheck[] {
  const home = resolveHomeDirectory(context)
  const exists = deps.exists ?? existsSync
  const readText = deps.readText ?? ((filePath: string) => readFileSync(filePath, 'utf8'))
  const checks: DoctorCheck[] = []
  const expectedEntry = runtime.mcpEntry.replace(/\\/g, '/')

  const dshHome = context.env['DSH_HOME'] || join(home, '.dsh')
  const profilesRoot = join(dshHome, 'profiles')
  const profile = context.env['DSH_PROFILE'] || 'desktop'
  const dshFile = [
    join(profilesRoot, profile, 'cordis.patch.yml'),
    join(profilesRoot, 'desktop', 'cordis.patch.yml')
  ].find((filePath) => exists(filePath))
  if (dshFile === undefined) {
    checks.push({
      category: 'agent',
      label: 'DeepSeek Harness',
      value: '未检测到 cordis.patch.yml',
      ok: false,
      hint: '运行 ctx init --agents dsh 接入'
    })
  } else {
    const content = readIfExists(readText, dshFile)
    const hasEntry = content.includes('mcp-cortex')
    const pointsAtEntry = content.includes(expectedEntry) || content.includes(runtime.mcpEntry)
    checks.push({
      category: 'agent',
      label: 'DeepSeek Harness',
      value: !hasEntry
        ? `${dshFile}（缺少 mcp-cortex 条目）`
        : pointsAtEntry
          ? dshFile
          : `${dshFile}（不是当前 stdio 入口）`,
      ok: hasEntry && pointsAtEntry,
      hint: hasEntry && pointsAtEntry ? undefined : '运行 ctx init --agents dsh 重写 MCP 条目'
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

  const probe = deps.probeClaude ?? probeClaudeCli
  let claudeOk = false
  try {
    claudeOk = probe()
  } catch {
    claudeOk = false
  }
  checks.push({
    category: 'agent',
    label: 'Claude Code',
    value: claudeOk ? '已注册 cortex（stdio）' : '未检测到 Claude Code 注册',
    ok: claudeOk,
    hint: claudeOk ? undefined : '运行 ctx init --agents claude 接入（需已安装 claude CLI）'
  })

  return checks
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
