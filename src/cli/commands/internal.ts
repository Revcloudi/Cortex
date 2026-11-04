import type { CAC } from 'cac'
import type {
  Foothold,
  InternalGraphData,
  InternalHost,
  InternalOverview,
  InternalService,
  LootImport
} from '../../shared/internal'
import type { VulnerabilityListItem } from '../../shared/types'
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
 * `ctx internal overview|hosts|routes --project <name>` (Plan B §10).
 *
 * Read-only views over the internal operations domain: footholds, internal
 * hosts/services, credentials (masked), pivots and internal-realm findings.
 * Writing stays with the MCP `sync_internal_scope` tool; the CLI never mutates
 * the internal scope.
 */

export interface InternalCommandOptions {
  project?: string
}

const FOOTHOLD_COLUMNS: TableColumn[] = [
  { title: 'Foothold', maxWidth: 16 },
  { title: '入口资产', maxWidth: 40 },
  { title: '入口漏洞', maxWidth: 22 },
  { title: '访问方式', maxWidth: 12 },
  { title: '权限', maxWidth: 13 },
  { title: '状态', maxWidth: 12 },
  { title: '可达主机', maxWidth: 8 },
  { title: '建立时间', maxWidth: 16 }
]

const HOST_COLUMNS: TableColumn[] = [
  { title: 'IP', maxWidth: 40 },
  { title: '主机名', maxWidth: 24 },
  { title: 'OS', maxWidth: 18 },
  { title: '网段', maxWidth: 20 },
  { title: '状态', maxWidth: 13 },
  { title: '服务数', maxWidth: 6 },
  { title: '置信度', maxWidth: 6 },
  { title: '最后发现', maxWidth: 16 }
]

const SERVICE_COLUMNS: TableColumn[] = [
  { title: 'Service', maxWidth: 16 },
  { title: 'Host', maxWidth: 16 },
  { title: 'IP', maxWidth: 40 },
  { title: '端口', maxWidth: 6 },
  { title: '协议', maxWidth: 8 },
  { title: '服务名', maxWidth: 14 },
  { title: '状态', maxWidth: 10 }
]

const INTERNAL_VULN_COLUMNS: TableColumn[] = [
  { title: 'ID', maxWidth: 22 },
  { title: '严重程度', maxWidth: 10 },
  { title: '漏洞名称', maxWidth: 34 },
  { title: '入口 Host', maxWidth: 26 },
  { title: '内网服务', maxWidth: 26 },
  { title: '状态', maxWidth: 10 }
]

const LOOT_COLUMNS: TableColumn[] = [
  { title: 'ID', maxWidth: 16 },
  { title: '文件', maxWidth: 30 },
  { title: '格式', maxWidth: 16 },
  { title: '状态', maxWidth: 12 },
  { title: '主机', maxWidth: 6 },
  { title: '服务', maxWidth: 6 },
  { title: '凭据', maxWidth: 6 },
  { title: '导入时间', maxWidth: 16 }
]

const PIVOT_COLUMNS: TableColumn[] = [
  { title: 'Pivot', maxWidth: 16 },
  { title: 'Foothold', maxWidth: 16 },
  { title: '类型', maxWidth: 7 },
  { title: '本地端点', maxWidth: 24 },
  { title: '工具', maxWidth: 12 },
  { title: '状态', maxWidth: 11 },
  { title: '跳点', maxWidth: 5 },
  { title: '可达网段', maxWidth: 30 }
]

function writeJson(context: CliContext, value: unknown): void {
  context.stdout(JSON.stringify(value, null, 2))
}

function timeOrDash(value: string): string {
  return value.length > 0 ? formatLocalTime(value) : '—'
}

function resolveProjectOption(value: string | undefined): string {
  const project = value?.trim() ?? ''
  if (project.length === 0) {
    throw new CliError(
      '缺少 --project <name>（用法：ctx internal <overview|hosts|routes> --project <name>）',
      1
    )
  }
  return project
}

/* ------------------------------------------------------------- rendering -- */

function renderCounts(overview: InternalOverview, options: ColorOptions): string[] {
  const { counts } = overview
  return [
    color.bold(`内网作战域概览：${overview.project_name}`, options),
    '',
    `${color.dim('Footholds:', options)} ${counts.footholds}   ` +
      `${color.dim('内网主机:', options)} ${counts.hosts}   ` +
      `${color.dim('服务:', options)} ${counts.services}   ` +
      `${color.dim('凭据:', options)} ${counts.credentials}   ` +
      `${color.dim('Pivots:', options)} ${counts.pivots}   ` +
      `${color.dim('内网漏洞:', options)} ${counts.internal_vulns}   ` +
      `${color.dim('Loot 导入:', options)} ${counts.loot_imports}`,
    color.dim('数据来自 Agent 上报（sync_internal_scope / ctx loot import），不是实时扫描。', options)
  ]
}

function renderFootholds(footholds: Foothold[], options: ColorOptions): string[] {
  const lines: string[] = ['', color.bold(`Footholds（${footholds.length}）`, options)]
  if (footholds.length === 0) {
    lines.push('  （无）先通过 MCP sync_internal_scope 登记入口 foothold。')
    return lines
  }
  const rows = footholds.map((foothold) => [
    foothold.id,
    foothold.entry_host_port,
    foothold.entry_vuln_id.length > 0 ? foothold.entry_vuln_id : '—',
    foothold.access_type,
    foothold.privilege_level,
    foothold.status,
    String(foothold.host_ids.length),
    timeOrDash(foothold.established_at)
  ])
  lines.push(renderTable(FOOTHOLD_COLUMNS, rows))
  return lines
}

function renderInternalVulns(
  vulns: VulnerabilityListItem[],
  options: ColorOptions
): string[] {
  const lines: string[] = ['', color.bold(`内网漏洞（${vulns.length}）`, options)]
  if (vulns.length === 0) {
    lines.push('  （无）内网漏洞用 save_vulnerability 保存：realm="internal" + service_host/internal_service_id。')
    return lines
  }
  const rows = vulns.map((vuln) => [
    vuln.id,
    vuln.severity,
    vuln.vuln_name,
    vuln.host,
    vuln.service_host.length > 0 ? vuln.service_host : '—',
    vuln.status
  ])
  lines.push(renderTable(INTERNAL_VULN_COLUMNS, rows))
  return lines
}

function renderLootImports(imports: LootImport[], options: ColorOptions): string[] {
  if (imports.length === 0) return []
  const lines: string[] = ['', color.bold(`Loot 导入（${imports.length}）`, options)]
  const rows = imports.map((item) => [
    item.id,
    item.filename,
    item.format,
    item.status,
    String(item.summary.hosts),
    String(item.summary.services),
    String(item.summary.credentials),
    timeOrDash(item.created_at)
  ])
  lines.push(renderTable(LOOT_COLUMNS, rows))
  return lines
}

function renderWarnings(warnings: readonly string[], options: ColorOptions): string[] {
  if (warnings.length === 0) return []
  return ['', ...warnings.map((warning) => `${color.yellow('警告:', options)} ${warning}`)]
}

function renderOverviewHuman(overview: InternalOverview, useColor: boolean): string {
  const options: ColorOptions = { enabled: useColor }
  const lines: string[] = [
    ...renderCounts(overview, options),
    ...renderFootholds(overview.footholds, options),
    ...renderInternalVulns(overview.internal_vulns, options),
    ...renderLootImports(overview.loot_imports, options),
    ...renderWarnings(overview.warnings, options)
  ]
  return lines.join('\n')
}

function renderHostsHuman(overview: InternalOverview, useColor: boolean): string {
  const options: ColorOptions = { enabled: useColor }
  const { hosts, services } = overview
  const lines: string[] = [
    color.bold(`内网主机 ${hosts.length} 台（项目：${overview.project_name}）`, options)
  ]

  if (hosts.length === 0) {
    lines.push('未登记内网主机。先通过 MCP sync_internal_scope 写入，或用 ctx loot import 导入。')
  } else {
    const rows = hosts.map((host: InternalHost) => [
      host.ip,
      host.hostname.length > 0 ? host.hostname : '—',
      host.os.length > 0 ? host.os : '—',
      host.subnet.length > 0 ? host.subnet : '—',
      host.state,
      String(host.service_count),
      host.confidence,
      timeOrDash(host.last_seen)
    ])
    lines.push('', renderTable(HOST_COLUMNS, rows))
  }

  lines.push('', color.bold(`内网服务（${services.length}）`, options))
  if (services.length === 0) {
    lines.push('  （无）')
  } else {
    const rows = services.map((service: InternalService) => [
      service.id,
      service.host_id,
      service.host_ip.length > 0 ? service.host_ip : '—',
      String(service.port),
      service.protocol.length > 0 ? service.protocol : '—',
      service.service.length > 0 ? service.service : '—',
      service.state
    ])
    lines.push(renderTable(SERVICE_COLUMNS, rows))
  }

  lines.push(...renderWarnings(overview.warnings, options))
  return lines.join('\n')
}

function renderRoutesHuman(graph: InternalGraphData, useColor: boolean): string {
  const options: ColorOptions = { enabled: useColor }
  const lines: string[] = [
    color.bold(`代理路由 ${graph.pivots.length} 条（项目：${graph.project_name}）`, options)
  ]
  if (graph.pivots.length === 0) {
    lines.push('')
    lines.push('暂无 pivot 记录。隧道建立/断开后用 MCP sync_internal_scope 的 pivots 字段上报。')
    lines.push(...renderWarnings(graph.warnings, options))
    return lines.join('\n')
  }

  const footholdById = new Map(graph.footholds.map((foothold) => [foothold.id, foothold]))
  const rows = graph.pivots.map((pivot) => [
    pivot.id,
    pivot.foothold_id,
    pivot.kind,
    `${pivot.local_host}:${pivot.local_port}${pivot.local_protocol.length > 0 ? `/${pivot.local_protocol}` : ''}`,
    pivot.tool.length > 0 ? pivot.tool : '—',
    pivot.status,
    String(pivot.hops.length),
    pivot.reachable_subnets.length > 0 ? pivot.reachable_subnets.join(',') : '—'
  ])
  lines.push('', renderTable(PIVOT_COLUMNS, rows))

  for (const pivot of graph.pivots) {
    const foothold = footholdById.get(pivot.foothold_id)
    lines.push(
      '',
      color.bold(
        `${pivot.id}（${pivot.kind} · ${pivot.status}）`,
        options
      )
    )
    lines.push(
      `  本地端点: ${pivot.local_host}:${pivot.local_port}${
        pivot.local_protocol.length > 0 ? ` (${pivot.local_protocol})` : ''
      }`
    )
    lines.push(
      `  入口: ${foothold !== undefined ? foothold.entry_host_port : pivot.foothold_id}${
        foothold !== undefined ? `（${foothold.access_type} · ${foothold.privilege_level}）` : ''
      }`
    )
    lines.push(`  工具: ${pivot.tool.length > 0 ? pivot.tool : '—'}`)
    if (pivot.hops.length === 0) {
      lines.push('  跳点: （无）')
    } else {
      lines.push('  跳点:')
      for (const hop of pivot.hops) {
        const label = hop.label.length > 0 ? ` ${hop.label}` : ''
        const via = hop.via.length > 0 ? ` via ${hop.via}` : ''
        lines.push(`    ${hop.seq}. [${hop.ref_kind}] ${hop.ref_id}${label}${via}`)
      }
    }
    lines.push(
      `  可达网段: ${
        pivot.reachable_subnets.length > 0 ? pivot.reachable_subnets.join(', ') : '—'
      }`
    )
    if (pivot.notes.length > 0) lines.push(`  备注: ${pivot.notes}`)
  }

  lines.push(...renderWarnings(graph.warnings, options))
  return lines.join('\n')
}

/* --------------------------------------------------------------- runners -- */

export async function runInternalOverview(
  project: string,
  context: CliContext
): Promise<void> {
  const database = openDatabase(context)
  try {
    const overview = database.getInternalOverview(project)
    if (context.json) {
      writeJson(context, overview)
      return
    }
    context.stdout(renderOverviewHuman(overview, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export async function runInternalHosts(project: string, context: CliContext): Promise<void> {
  const database = openDatabase(context)
  try {
    const overview = database.getInternalOverview(project)
    if (context.json) {
      writeJson(context, overview)
      return
    }
    context.stdout(renderHostsHuman(overview, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export async function runInternalRoutes(project: string, context: CliContext): Promise<void> {
  const database = openDatabase(context)
  try {
    const graph = database.getInternalGraph(project)
    if (context.json) {
      writeJson(context, graph)
      return
    }
    context.stdout(renderRoutesHuman(graph, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export async function runInternalCommand(
  action: string,
  projectOption: string | undefined,
  context: CliContext
): Promise<void> {
  const project = resolveProjectOption(projectOption)
  if (action === 'overview') {
    await runInternalOverview(project, context)
    return
  }
  if (action === 'hosts') {
    await runInternalHosts(project, context)
    return
  }
  if (action === 'routes') {
    await runInternalRoutes(project, context)
    return
  }
  throw new CliError(`未知 internal 子命令: ${action}（可选 overview | hosts | routes）`, 1)
}

export function registerInternalCommands(cli: CAC): void {
  cli
    .command(
      'internal <action>',
      '内网作战域只读查询：overview 概览 / hosts 主机与服务 / routes 代理路由'
    )
    .option('--project <name>', '项目名（必填）')
    .action(async (action: string, options: InternalCommandOptions) => {
      const context = createCliContext()
      await runInternalCommand(action, options.project, context)
    })
}
