import type { CAC } from 'cac'
import {
  ASSET_STATUS_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  type AssetListItem,
  type PaginatedVulnerabilities,
  type SnapshotListResult
} from '../../shared/types'
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
 * `ctx search <keyword>`.
 *
 * One read-only sweep over the three memory libraries (vulnerabilities, assets,
 * cognitive snapshots). Each section is capped for display; a keyword with no
 * match is still a successful command (exit 0).
 */

const SEARCH_LIMIT = 20

const VULN_COLUMNS: TableColumn[] = [
  { title: 'ID', maxWidth: 28 },
  { title: '严重程度', maxWidth: 10 },
  { title: '状态', maxWidth: 10 },
  { title: '漏洞名称', maxWidth: 30 },
  { title: 'Host', maxWidth: 22 }
]

const ASSET_COLUMNS: TableColumn[] = [
  { title: 'Host:Port', maxWidth: 46 },
  { title: '项目', maxWidth: 18 },
  { title: '状态', maxWidth: 10 },
  { title: '接口数', maxWidth: 6 }
]

const SNAPSHOT_COLUMNS: TableColumn[] = [
  { title: 'session_id', maxWidth: 20 },
  { title: '项目', maxWidth: 16 },
  { title: '阶段', maxWidth: 30 },
  { title: '更新于', maxWidth: 16 }
]

interface SearchResult {
  query: string
  vulnerabilities: PaginatedVulnerabilities
  assets: AssetListItem[]
  snapshots: SnapshotListResult
}

function writeJson(context: CliContext, value: unknown): void {
  context.stdout(JSON.stringify(value, null, 2))
}

function renderSearchHuman(
  result: SearchResult,
  assetMatchCount: number,
  useColor: boolean
): string {
  const options: ColorOptions = { enabled: useColor }
  const lines: string[] = [color.bold(`搜索“${result.query}”的结果`, options), '']

  lines.push(color.bold(`漏洞（${result.vulnerabilities.total}）`, options))
  if (result.vulnerabilities.items.length === 0) {
    lines.push('（无匹配）')
  } else {
    lines.push(
      renderTable(
        VULN_COLUMNS,
        result.vulnerabilities.items.map((item) => [
          item.id,
          SEVERITY_LABELS[item.severity],
          STATUS_LABELS[item.status],
          item.vuln_name,
          item.host
        ])
      )
    )
    if (result.vulnerabilities.items.length < result.vulnerabilities.total) {
      lines.push(
        color.dim(
          `仅显示前 ${result.vulnerabilities.items.length} 条（共 ${result.vulnerabilities.total} 条）。`,
          options
        )
      )
    }
  }

  lines.push('', color.bold(`资产（${result.assets.length}）`, options))
  if (result.assets.length === 0) {
    lines.push('（无匹配）')
  } else {
    lines.push(
      renderTable(
        ASSET_COLUMNS,
        result.assets.map((item) => [
          item.host_port,
          item.project_name,
          ASSET_STATUS_LABELS[item.status],
          String(item.interface_count)
        ])
      )
    )
    if (assetMatchCount > result.assets.length) {
      lines.push(
        color.dim(`共 ${assetMatchCount} 条，最多显示 ${result.assets.length} 条。`, options)
      )
    }
  }

  lines.push('', color.bold(`会话（${result.snapshots.total}）`, options))
  if (result.snapshots.items.length === 0) {
    lines.push('（无匹配）')
  } else {
    lines.push(
      renderTable(
        SNAPSHOT_COLUMNS,
        result.snapshots.items.map((item) => [
          item.session_id,
          item.project_name,
          item.current_phase.length > 0 ? item.current_phase : '—',
          formatLocalTime(item.updated_at)
        ])
      )
    )
    if (result.snapshots.items.length < result.snapshots.total) {
      lines.push(
        color.dim(
          `仅显示前 ${result.snapshots.items.length} 条（共 ${result.snapshots.total} 条）。`,
          options
        )
      )
    }
  }

  return lines.join('\n')
}

export async function runSearch(
  keyword: string | undefined,
  context: CliContext
): Promise<void> {
  const query = keyword?.trim() ?? ''
  if (query.length === 0) {
    throw new CliError('缺少搜索关键词，用法：ctx search <keyword>', 1)
  }

  const database = openDatabase(context)
  try {
    const vulnerabilities = database.list({ search: query, pageSize: SEARCH_LIMIT })
    const assetMatches = database.listAssets({ search: query })
    const assets = assetMatches.slice(0, SEARCH_LIMIT)
    const snapshots = database.listSnapshotSessions({ keyword: query, limit: SEARCH_LIMIT })

    const result: SearchResult = { query, vulnerabilities, assets, snapshots }

    if (context.json) {
      writeJson(context, result)
      return
    }
    context.stdout(renderSearchHuman(result, assetMatches.length, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export function registerSearchCommand(cli: CAC): void {
  cli.command('search <keyword>', '同时搜索漏洞 / 资产 / 认知快照').action(
    async (keyword: string) => {
      await runSearch(keyword, createCliContext())
    }
  )
}
