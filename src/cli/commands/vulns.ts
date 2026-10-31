import type { CAC } from 'cac'
import {
  SEVERITIES,
  SEVERITY_LABELS,
  STATUS_LABELS,
  type PaginatedVulnerabilities,
  type Severity,
  type VulnHostQueryResult,
  type Vulnerability
} from '../../shared/types'
import { createCliContext, openDatabase, type CliContext } from '../context'
import { CliError, notFound } from '../errors'
import {
  bullet,
  color,
  formatLocalTime,
  renderTable,
  shouldUseColor,
  type ColorOptions,
  type TableColumn
} from '../format'

/**
 * `ctx vulns list` / `ctx vulns get <id>`.
 *
 * Both helpers are exported and receive an explicit `CliContext`, so tests drive
 * them in-process (no child process) and the CLI entry only wires `cac` to them.
 * All errors are thrown as `CliError`; the top-level CLI handler maps `exitCode`
 * and prints the message.
 */

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 200

export interface VulnsListOptions {
  severity?: string
  host?: string
  limit?: string | number
}

const LIST_COLUMNS: TableColumn[] = [
  { title: 'ID', maxWidth: 28 },
  { title: '严重程度', maxWidth: 10 },
  { title: '状态', maxWidth: 10 },
  { title: '漏洞名称', maxWidth: 30 },
  { title: 'Host', maxWidth: 22 },
  { title: '目标 URL', maxWidth: 44 }
]

const HOST_COLUMNS: TableColumn[] = [
  { title: 'ID', maxWidth: 28 },
  { title: '严重程度', maxWidth: 10 },
  { title: '漏洞名称', maxWidth: 34 },
  { title: '目标 URL', maxWidth: 56 }
]

function writeJson(context: CliContext, value: unknown): void {
  context.stdout(JSON.stringify(value, null, 2))
}

/**
 * Validate `--severity`: case-insensitive, where `all` (or no value) disables
 * the filter. An unknown value is a parameter error (exit 1), not an empty
 * result.
 */
export function parseSeverityOption(value: string | undefined): Severity | 'all' {
  const raw = value?.trim().toLowerCase() ?? ''
  if (raw.length === 0 || raw === 'all') return 'all'
  const match = SEVERITIES.find((severity) => severity.toLowerCase() === raw)
  if (match !== undefined) return match
  throw new CliError(
    `--severity 不合法：${value?.trim() ?? ''}（可选 Critical|High|Medium|Low|Info|all）`,
    1
  )
}

/** Validate `--limit`: default 20, clamped to 1..200, invalid input exits 1. */
export function parseLimitOption(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT
  const text = typeof value === 'number' ? String(value) : value.trim()
  const parsed = Number(text)
  if (text.length === 0 || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new CliError(`--limit 必须是 ${1}-${MAX_LIST_LIMIT} 之间的整数，收到：${text}`, 1)
  }
  return Math.min(MAX_LIST_LIMIT, Math.max(1, parsed))
}

function severityColorizer(
  severity: Severity
): (text: string, options?: ColorOptions) => string {
  if (severity === 'Critical' || severity === 'High') return (text, options) => color.red(text, options)
  if (severity === 'Medium') return (text, options) => color.yellow(text, options)
  return (text, options) => color.dim(text, options)
}

/**
 * Colorize severity cells *after* `renderTable`.
 *
 * `renderTable` measures display width on the raw strings, so ANSI codes inside
 * a cell would break the padding (escape bytes count as width). The severity
 * column is the first text column, and its labels never occur in the ID or
 * number columns, so replacing the first occurrence on each body line keeps
 * every column aligned while painting only the severity label.
 */
function colorizeSeverityColumn(
  table: string,
  severities: Severity[],
  useColor: boolean
): string {
  if (!useColor) return table
  const lines = table.split('\n')
  const tableHeaderLines = 2
  return lines
    .map((line, index) => {
      const severity = severities[index - tableHeaderLines]
      if (severity === undefined) return line
      const label = SEVERITY_LABELS[severity]
      const position = line.indexOf(label)
      if (position === -1) return line
      return `${line.slice(0, position)}${severityColorizer(severity)(label)}${line.slice(
        position + label.length
      )}`
    })
    .join('\n')
}

function listHeading(total: number, severity: Severity | 'all'): string {
  const filters: string[] = []
  if (severity !== 'all') filters.push(`severity=${severity}`)
  return filters.length > 0 ? `漏洞 ${total} 条（${filters.join('，')}）` : `漏洞 ${total} 条`
}

function truncationHint(shown: number, total: number): string {
  return `仅显示前 ${shown} 条（共 ${total} 条），可用 --limit 调整。`
}

function renderListHuman(
  result: PaginatedVulnerabilities,
  severity: Severity | 'all',
  useColor: boolean
): string {
  const options: ColorOptions = { enabled: useColor }
  const lines: string[] = [color.bold(listHeading(result.total, severity), options)]
  if (result.items.length === 0) {
    lines.push('未找到匹配的漏洞。')
    return lines.join('\n')
  }

  const rows = result.items.map((item) => [
    item.id,
    SEVERITY_LABELS[item.severity],
    STATUS_LABELS[item.status],
    item.vuln_name,
    item.host,
    item.target_url
  ])
  lines.push(
    colorizeSeverityColumn(
      renderTable(LIST_COLUMNS, rows),
      result.items.map((item) => item.severity),
      useColor
    )
  )
  if (result.items.length < result.total) {
    lines.push(color.dim(truncationHint(result.items.length, result.total), options))
  }
  return lines.join('\n')
}

function renderHostHuman(
  result: VulnHostQueryResult,
  severity: Severity | 'all',
  useColor: boolean
): string {
  const options: ColorOptions = { enabled: useColor }
  const filters = [`host=${result.host}`]
  if (severity !== 'all') filters.push(`severity=${severity}`)
  const lines: string[] = [color.bold(`漏洞 ${result.total} 条（${filters.join('，')}）`, options)]
  if (result.items.length === 0) {
    lines.push('未找到匹配的漏洞。')
    return lines.join('\n')
  }

  const rows = result.items.map((item) => [
    item.vuln_id,
    SEVERITY_LABELS[item.severity],
    item.vuln_name,
    item.target_url
  ])
  lines.push(
    colorizeSeverityColumn(
      renderTable(HOST_COLUMNS, rows),
      result.items.map((item) => item.severity),
      useColor
    )
  )
  if (result.items.length < result.total) {
    lines.push(color.dim(truncationHint(result.items.length, result.total), options))
  }
  return lines.join('\n')
}

export async function runVulnsList(
  options: VulnsListOptions,
  context: CliContext
): Promise<void> {
  const severity = parseSeverityOption(options.severity)
  const limit = parseLimitOption(options.limit)
  const host = options.host?.trim() ?? ''

  const database = openDatabase(context)
  try {
    if (host.length > 0) {
      const matched = database
        .queryByHost(host)
        .filter((item) => severity === 'all' || item.severity === severity)
      const result: VulnHostQueryResult = {
        host,
        total: matched.length,
        items: matched.slice(0, limit)
      }
      if (context.json) {
        writeJson(context, result)
        return
      }
      context.stdout(renderHostHuman(result, severity, shouldUseColor(context.json)))
      return
    }

    const result = database.list({ severity, pageSize: limit, page: 1 })
    if (context.json) {
      writeJson(context, result)
      return
    }
    context.stdout(renderListHuman(result, severity, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

function appendParagraph(
  lines: string[],
  heading: string,
  text: string,
  options: ColorOptions
): void {
  if (text.trim().length === 0) return
  lines.push('', color.bold(heading, options), text.trimEnd())
}

function appendList(
  lines: string[],
  heading: string,
  values: readonly string[],
  options: ColorOptions
): void {
  if (values.length === 0) return
  lines.push('', color.bold(`${heading}（${values.length}）`, options))
  for (const value of values) lines.push(bullet(value))
}

/**
 * `crypto_details` is optional data; legacy reports often store a localized
 * none / N/A placeholder instead of leaving it empty. No heading is printed.
 */
function isMeaningfulSection(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (normalized.length === 0) return false
  return !['无', '暂无', 'n/a', 'na', 'none', '-', '—'].includes(normalized)
}

/** Render one full vulnerability record as readable terminal text (raw Markdown kept). */
export function renderVulnerabilityDetail(vulnerability: Vulnerability, useColor: boolean): string {
  const options: ColorOptions = { enabled: useColor }
  const lines: string[] = []

  lines.push(
    `${color.bold(vulnerability.id, options)}  ${severityColorizer(vulnerability.severity)(
      SEVERITY_LABELS[vulnerability.severity],
      options
    )}  ${STATUS_LABELS[vulnerability.status]}  ${color.bold(vulnerability.vuln_name, options)}`
  )
  lines.push('')
  lines.push(
    `${color.dim('类型:', options)} ${vulnerability.vuln_type}    ${color.dim('入口:', options)} ${
      vulnerability.entry_point.length > 0 ? vulnerability.entry_point : '—'
    }`
  )
  lines.push(`${color.dim('Host:', options)} ${vulnerability.host}`)
  lines.push(`${color.dim('目标:', options)} ${vulnerability.target_url}`)
  lines.push(`${color.dim('创建:', options)} ${formatLocalTime(vulnerability.created_at)}`)

  appendParagraph(lines, '描述', vulnerability.description, options)
  appendParagraph(lines, '影响', vulnerability.impact, options)
  appendList(lines, '受影响接口', vulnerability.affected_interfaces, options)
  appendParagraph(lines, '复现步骤', vulnerability.reproduction_steps, options)
  appendList(lines, '修复建议', vulnerability.remediation, options)
  if (isMeaningfulSection(vulnerability.crypto_details)) {
    appendParagraph(lines, '加密 / 签名细节', vulnerability.crypto_details, options)
  }
  appendParagraph(lines, '测试边界', vulnerability.test_boundaries, options)

  if (vulnerability.retest_results.length > 0) {
    lines.push('', color.bold(`复测记录（${vulnerability.retest_results.length}）`, options))
    vulnerability.retest_results.forEach((retest, index) => {
      lines.push(`  ${index + 1}. ${retest.time_range}`)
      for (const conclusionLine of retest.conclusion.split(/\r?\n/)) {
        lines.push(conclusionLine.length > 0 ? `     ${conclusionLine}` : '')
      }
    })
  }

  lines.push(
    '',
    `${color.dim('关联漏洞:', options)} ${
      vulnerability.related_vuln_ids.length > 0
        ? vulnerability.related_vuln_ids.join(', ')
        : '—'
    }`
  )

  return lines.map((line) => line.replace(/\s+$/, '')).join('\n')
}

export async function runVulnGet(
  id: string | undefined,
  context: CliContext
): Promise<void> {
  const vulnId = id?.trim() ?? ''
  if (vulnId.length === 0) {
    throw new CliError('缺少漏洞 ID，用法：ctx vulns get <id>', 1)
  }

  const database = openDatabase(context)
  try {
    const vulnerability = database.getById(vulnId)
    if (vulnerability === null) throw notFound(`未找到 ID 为 ${vulnId} 的漏洞`)

    if (context.json) {
      writeJson(context, vulnerability)
      return
    }
    context.stdout(renderVulnerabilityDetail(vulnerability, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export function registerVulnCommands(cli: CAC): void {
  cli
    .command('vulns <action> [id]', '漏洞查询：list 列表 / get 详情')
    .option('--severity <severity>', '严重程度：Critical|High|Medium|Low|Info|all（list）')
    .option('--host <host>', '按 Host 精确过滤（大小写不敏感，list）')
    .option('--limit <n>', `返回条数，默认 ${DEFAULT_LIST_LIMIT}，范围 1-${MAX_LIST_LIMIT}（list）`)
    .action(async (action: string, id: string | undefined, options: VulnsListOptions) => {
      const context = createCliContext()
      if (action === 'list') {
        await runVulnsList(options, context)
        return
      }
      if (action === 'get') {
        await runVulnGet(id, context)
        return
      }
      throw new CliError(`未知 vulns 子命令: ${action}（可选 list | get）`, 1)
    })
}
