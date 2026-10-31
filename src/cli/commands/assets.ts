import type { CAC } from 'cac'
import {
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  LEAKED_INFO_TYPE_LABELS,
  type AssetContext,
  type AssetListItem,
  type AssetStatus
} from '../../shared/types'
import { createCliContext, openDatabase, type CliContext } from '../context'
import { CliError, notFound } from '../errors'
import {
  color,
  formatLocalTime,
  renderTable,
  shouldUseColor,
  truncate,
  type ColorOptions,
  type TableColumn
} from '../format'

/**
 * `ctx assets list` / `ctx assets get <host_port>`.
 *
 * Read-only views over the asset context library: fingerprints, structured
 * interfaces, leaked information and harvested test parameters.
 */

export interface AssetsListOptions {
  search?: string
  status?: string
}

const LIST_COLUMNS: TableColumn[] = [
  { title: 'Host:Port', maxWidth: 46 },
  { title: '项目', maxWidth: 18 },
  { title: '技术栈', maxWidth: 28 },
  { title: '状态', maxWidth: 10 },
  { title: '接口数', maxWidth: 6 },
  { title: '泄露数', maxWidth: 6 },
  { title: '关联漏洞', maxWidth: 8 },
  { title: '最后发现', maxWidth: 16 }
]

function writeJson(context: CliContext, value: unknown): void {
  context.stdout(JSON.stringify(value, null, 2))
}

/** Validate `--status`: case-insensitive, `all` (or no value) disables the filter. */
export function parseAssetStatusOption(value: string | undefined): AssetStatus | 'all' {
  const original = value?.trim() ?? ''
  const raw = original.toLowerCase()
  if (raw.length === 0 || raw === 'all') return 'all'
  const match = ASSET_STATUSES.find((status) => status.toLowerCase() === raw)
  if (match !== undefined) return match
  throw new CliError(
    `--status 不合法：${original}（可选 Alive|Dead|WAF_Blocked|all）`,
    1
  )
}

function assetStatusColorizer(status: AssetStatus): (text: string) => string {
  if (status === 'Alive') return (text) => color.green(text)
  if (status === 'Dead') return (text) => color.red(text)
  return (text) => color.yellow(text)
}

/** See `colorizeSeverityColumn` in vulns.ts: color after rendering, never before. */
function colorizeStatusColumn(
  table: string,
  statuses: AssetStatus[],
  useColor: boolean
): string {
  if (!useColor) return table
  const lines = table.split('\n')
  const tableHeaderLines = 2
  return lines
    .map((line, index) => {
      const status = statuses[index - tableHeaderLines]
      if (status === undefined) return line
      const label = ASSET_STATUS_LABELS[status]
      const position = line.indexOf(label)
      if (position === -1) return line
      return `${line.slice(0, position)}${assetStatusColorizer(status)(label)}${line.slice(
        position + label.length
      )}`
    })
    .join('\n')
}

function renderListHuman(
  items: AssetListItem[],
  filters: { search: string; status: AssetStatus | 'all' },
  useColor: boolean
): string {
  const options: ColorOptions = { enabled: useColor }
  const parts: string[] = []
  if (filters.search.length > 0) parts.push(`search=${filters.search}`)
  if (filters.status !== 'all') parts.push(`status=${filters.status}`)
  const title =
    parts.length > 0 ? `资产 ${items.length} 条（${parts.join('，')}）` : `资产 ${items.length} 条`

  const lines: string[] = [color.bold(title, options)]
  if (items.length === 0) {
    lines.push('未找到匹配的资产。')
    return lines.join('\n')
  }

  const rows = items.map((item) => [
    item.host_port,
    item.project_name,
    item.tech_stack.length > 0 ? item.tech_stack : '—',
    ASSET_STATUS_LABELS[item.status],
    String(item.interface_count),
    String(item.leak_count),
    String(item.related_vuln_count),
    formatLocalTime(item.last_seen)
  ])
  lines.push(
    colorizeStatusColumn(
      renderTable(LIST_COLUMNS, rows),
      items.map((item) => item.status),
      useColor
    )
  )
  return lines.join('\n')
}

function leakedInfoTypeLabel(infoType: string): string {
  return (LEAKED_INFO_TYPE_LABELS as Record<string, string>)[infoType] ?? infoType
}

function renderDetailHuman(asset: AssetContext, useColor: boolean): string {
  const options: ColorOptions = { enabled: useColor }
  const lines: string[] = [color.bold(asset.host_port, options), '']

  lines.push(`${color.dim('项目:', options)} ${asset.project_name}`)
  lines.push(`${color.dim('Host:', options)} ${asset.host}`)
  lines.push(
    `${color.dim('技术栈:', options)} ${
      asset.tech_stack !== undefined && asset.tech_stack.length > 0 ? asset.tech_stack : '—'
    }`
  )
  lines.push(`${color.dim('需登录:', options)} ${asset.auth_required ? '是' : '否'}`)
  lines.push(`${color.dim('状态:', options)} ${ASSET_STATUS_LABELS[asset.status]}`)
  lines.push(`${color.dim('最后发现:', options)} ${formatLocalTime(asset.last_seen)}`)

  lines.push('', color.bold(`接口（${asset.interfaces.length}）`, options))
  if (asset.interfaces.length === 0) {
    lines.push('  （无）')
  } else {
    for (const item of asset.interfaces) {
      const prefix = item.method !== undefined ? `${item.method} ${item.path}` : item.path
      lines.push(`  - ${prefix}`)
      if (item.params !== undefined && item.params.length > 0) {
        lines.push(`      参数: ${truncate(item.params, 300)}`)
      }
      if (item.request !== undefined && item.request.length > 0) {
        lines.push(`      原始请求: 已记录（${item.request.length} 字符）`)
      }
    }
  }

  lines.push('', color.bold(`泄露信息（${asset.leaked_infos.length}）`, options))
  if (asset.leaked_infos.length === 0) {
    lines.push('  （无）')
  } else {
    for (const info of asset.leaked_infos) {
      lines.push(`  - [${leakedInfoTypeLabel(info.info_type)}] ${truncate(info.source, 160)}`)
      lines.push(`      值: ${truncate(info.value, 200)}`)
      lines.push(`      影响: ${truncate(info.potential_impact, 300)}`)
    }
  }

  lines.push('', color.bold(`测试参数（${asset.test_parameters.length}）`, options))
  if (asset.test_parameters.length === 0) {
    lines.push('  （无）')
  } else {
    for (const parameter of asset.test_parameters) {
      lines.push(`  - ${parameter.name} @ ${parameter.endpoint}（${parameter.location}）`)
      if (parameter.values.length > 0) {
        lines.push(`      样例: ${parameter.values.join(', ')}`)
      }
      if (parameter.pattern !== undefined && parameter.pattern.length > 0) {
        lines.push(`      生成规则: ${parameter.pattern}`)
      }
      lines.push(`      已测试: ${parameter.tested ? '是' : '否'}`)
    }
  }

  lines.push(
    '',
    `${color.dim('关联漏洞:', options)} ${
      asset.related_vuln_ids.length > 0 ? asset.related_vuln_ids.join(', ') : '—'
    }`
  )

  return lines.map((line) => line.replace(/\s+$/, '')).join('\n')
}

export async function runAssetsList(
  options: AssetsListOptions,
  context: CliContext
): Promise<void> {
  const status = parseAssetStatusOption(options.status)
  const search = options.search?.trim() ?? ''

  const database = openDatabase(context)
  try {
    const items = database.listAssets({
      ...(search.length > 0 ? { search } : {}),
      status
    })

    if (context.json) {
      writeJson(context, items)
      return
    }
    context.stdout(renderListHuman(items, { search, status }, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export async function runAssetGet(
  hostPort: string | undefined,
  context: CliContext
): Promise<void> {
  const identifier = hostPort?.trim() ?? ''
  if (identifier.length === 0) {
    throw new CliError('缺少资产标识（host_port / URL），用法：ctx assets get <host_port>', 1)
  }

  const database = openDatabase(context)
  try {
    const asset = database.getAssetDetail(identifier)
    if (asset === null) throw notFound(`未找到资产 ${identifier}`)

    if (context.json) {
      writeJson(context, asset)
      return
    }
    context.stdout(renderDetailHuman(asset, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export function registerAssetCommands(cli: CAC): void {
  cli
    .command('assets <action> [host_port]', '资产查询：list 列表 / get 详情')
    .option('--search <keyword>', '按 Host / 项目名 / 技术栈模糊搜索（list）')
    .option('--status <status>', '资产状态：Alive|Dead|WAF_Blocked|all（list）')
    .action(async (action: string, hostPort: string | undefined, options: AssetsListOptions) => {
      const context = createCliContext()
      if (action === 'list') {
        await runAssetsList(options, context)
        return
      }
      if (action === 'get') {
        await runAssetGet(hostPort, context)
        return
      }
      throw new CliError(`未知 assets 子命令: ${action}（可选 list | get）`, 1)
    })
}
