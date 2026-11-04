import type { CAC } from 'cac'
import {
  LOOT_IMPORT_FORMAT_HINTS,
  type LootImport,
  type LootImportFormatHint
} from '../../shared/internal'
import { createCliContext, openDatabase, type CliContext } from '../context'
import { CliError } from '../errors'
import {
  color,
  formatLocalTime,
  renderTable,
  shouldUseColor,
  type ColorOptions,
  type TableColumn
} from '../format'

/**
 * `ctx loot import <file> --project <name> [--entry <host_port>] [--format auto]`
 * and `ctx loot list --project <name>` (Plan B §8.4 / §10).
 *
 * Parsing happens locally in `core/loot` (no network, no code execution, size /
 * entry / zip-slip caps). The raw file is never stored in SQLite — only its
 * sha256, format, parser and summary. Unknown formats are recorded as
 * `needs_review` for the GUI review queue, not silently dropped.
 */

export interface LootImportOptions {
  project?: string
  entry?: string
  format?: string
}

export interface LootListOptions {
  project?: string
}

const LOOT_LIST_COLUMNS: TableColumn[] = [
  { title: 'ID', maxWidth: 16 },
  { title: '文件', maxWidth: 32 },
  { title: '格式', maxWidth: 16 },
  { title: '解析器', maxWidth: 22 },
  { title: '状态', maxWidth: 12 },
  { title: '主机', maxWidth: 6 },
  { title: '服务', maxWidth: 6 },
  { title: '凭据', maxWidth: 6 },
  { title: '待复核', maxWidth: 8 },
  { title: '导入时间', maxWidth: 16 }
]

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  parsed: '已解析',
  needs_review: '需复核',
  failed: '失败'
}

function writeJson(context: CliContext, value: unknown): void {
  context.stdout(JSON.stringify(value, null, 2))
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

function resolveProjectOption(value: string | undefined, usage: string): string {
  const project = value?.trim() ?? ''
  if (project.length === 0) {
    throw new CliError(`缺少 --project <name>（用法：${usage}）`, 1)
  }
  return project
}

function parseFormatOption(value: string | undefined): LootImportFormatHint {
  const raw = value?.trim().toLowerCase() ?? ''
  if (raw.length === 0) return 'auto'
  const match = LOOT_IMPORT_FORMAT_HINTS.find((format) => format === raw)
  if (match === undefined) {
    throw new CliError(
      `--format 不合法：${value?.trim() ?? ''}（可选 ${LOOT_IMPORT_FORMAT_HINTS.join('|')}）`,
      1
    )
  }
  return match
}

function timeOrDash(value: string): string {
  return value.length > 0 ? formatLocalTime(value) : '—'
}

/* ------------------------------------------------------------- rendering -- */

function renderImportHuman(item: LootImport, useColor: boolean): string {
  const options: ColorOptions = { enabled: useColor }
  const lines: string[] = [
    color.bold(`Loot 导入：${item.id}`, options),
    '',
    `${color.dim('项目:', options)} ${item.project_name}`,
    `${color.dim('文件:', options)} ${item.filename}`,
    `${color.dim('入口资产:', options)} ${item.entry_host_port.length > 0 ? item.entry_host_port : '—'}`,
    `${color.dim('格式:', options)} ${item.format}（parser: ${item.parser.length > 0 ? item.parser : '—'}）`,
    `${color.dim('SHA-256:', options)} ${item.sha256.length > 0 ? item.sha256 : '—'}`,
    `${color.dim('状态:', options)} ${statusLabel(item.status)}`,
    `${color.dim('解析结果:', options)} 主机 ${item.summary.hosts} / 服务 ${item.summary.services} / 凭据 ${item.summary.credentials}（待复核 ${item.summary.needs_review}）`,
    `${color.dim('导入时间:', options)} ${timeOrDash(item.created_at)}`
  ]

  if (item.status === 'failed' && item.error.length > 0) {
    lines.push('', `${color.red('错误:', options)} ${item.error}`)
  }
  if (item.status === 'needs_review') {
    lines.push('', color.yellow('该导入需要人工复核（凭据默认 untested / 未识别格式 / 数据被截断）。', options))
  }
  if (item.summary.warnings.length > 0) {
    lines.push('', color.bold('警告:', options))
    for (const warning of item.summary.warnings) lines.push(`  - ${warning}`)
  }
  lines.push('', color.dim('原始 Loot 文件不会写入数据库，只保存路径引用、sha256 与解析摘要。', options))
  return lines.join('\n')
}

function renderListHuman(items: LootImport[], project: string, useColor: boolean): string {
  const options: ColorOptions = { enabled: useColor }
  const lines: string[] = [
    color.bold(`Loot 导入记录 ${items.length} 条（项目：${project}）`, options)
  ]
  if (items.length === 0) {
    lines.push('暂无导入记录。可用 ctx loot import <file> --project <name> 导入本地 Loot。')
    return lines.join('\n')
  }
  const rows = items.map((item) => [
    item.id,
    item.filename,
    item.format,
    item.parser.length > 0 ? item.parser : '—',
    statusLabel(item.status),
    String(item.summary.hosts),
    String(item.summary.services),
    String(item.summary.credentials),
    String(item.summary.needs_review),
    timeOrDash(item.created_at)
  ])
  lines.push(renderTable(LOOT_LIST_COLUMNS, rows))
  return lines.join('\n')
}

/* --------------------------------------------------------------- runners -- */

export async function runLootImport(
  fileArgument: string | undefined,
  options: LootImportOptions,
  context: CliContext
): Promise<void> {
  const fileName = fileArgument?.trim() ?? ''
  if (fileName.length === 0) {
    throw new CliError(
      '缺少 Loot 文件路径（用法：ctx loot import <file> --project <name> [--entry <host_port>] [--format auto]）',
      1
    )
  }
  const project = resolveProjectOption(
    options.project,
    'ctx loot import <file> --project <name> [--entry <host_port>] [--format auto]'
  )
  const format = parseFormatOption(options.format)
  const entry = options.entry?.trim() ?? ''

  const database = openDatabase(context)
  try {
    // The DB layer parses locally, persists in one transaction and records a
    // failed row (instead of throwing) when the file cannot be read/parsed.
    const item = database.importLoot({
      project_name: project,
      entry_host_port: entry,
      file_path: fileName,
      format
    })

    if (context.json) {
      writeJson(context, item)
    } else {
      context.stdout(renderImportHuman(item, shouldUseColor(context.json)))
    }

    if (item.status === 'failed') {
      throw new CliError(
        `Loot 导入失败：${item.error.length > 0 ? item.error : '未知错误'}`,
        1
      )
    }
  } finally {
    database.close()
  }
}

export async function runLootList(
  options: LootListOptions,
  context: CliContext
): Promise<void> {
  const project = resolveProjectOption(options.project, 'ctx loot list --project <name>')

  const database = openDatabase(context)
  try {
    const items = database.listLootImports(project)
    if (context.json) {
      writeJson(context, items)
      return
    }
    context.stdout(renderListHuman(items, project, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export async function runLootCommand(
  action: string,
  fileArgument: string | undefined,
  options: LootImportOptions,
  context: CliContext
): Promise<void> {
  if (action === 'import') {
    await runLootImport(fileArgument, options, context)
    return
  }
  if (action === 'list') {
    await runLootList(options, context)
    return
  }
  throw new CliError(`未知 loot 子命令: ${action}（可选 import | list）`, 1)
}

export function registerLootCommands(cli: CAC): void {
  cli
    .command('loot <action> [file]', 'Loot 本地导入与查询：import <file> / list（纯本地解析，不执行文件内容）')
    .option('--project <name>', '项目名（必填）')
    .option('--entry <host_port>', '入口 Web 资产 host_port（import，可选）')
    .option(
      '--format <format>',
      `解析器：${LOOT_IMPORT_FORMAT_HINTS.join('|')}（默认 auto，按扩展名与内容识别）`
    )
    .action(
      async (action: string, file: string | undefined, options: LootImportOptions) => {
        const context = createCliContext()
        await runLootCommand(action, file, options, context)
      }
    )
}
