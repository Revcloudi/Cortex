import type { CAC } from 'cac'
import type {
  SnapshotListResult,
  SnapshotSession,
  SnapshotSummary
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
 * `ctx snapshots list` / `ctx snapshots get <session_id>`.
 *
 * Read-only views over cognitive snapshot sessions (project session → system
 * sub-sessions). Archived sessions are hidden by the database default; the
 * desktop UI is the only place that toggles archive state.
 */

export interface SnapshotsListOptions {
  keyword?: string
}

const LIST_COLUMNS: TableColumn[] = [
  { title: 'session_id', maxWidth: 20 },
  { title: '项目', maxWidth: 16 },
  { title: '阶段', maxWidth: 30 },
  { title: '目标数', maxWidth: 6 },
  { title: '更新于', maxWidth: 16 },
  { title: '父会话', maxWidth: 20 },
  { title: '已归档', maxWidth: 6 },
  { title: '子会话数', maxWidth: 8 },
  { title: '未完成数', maxWidth: 8 }
]

function writeJson(context: CliContext, value: unknown): void {
  context.stdout(JSON.stringify(value, null, 2))
}

function renderListHuman(
  result: SnapshotListResult,
  keyword: string,
  useColor: boolean
): string {
  const options: ColorOptions = { enabled: useColor }
  const title =
    keyword.length > 0 ? `会话 ${result.total} 个（keyword=${keyword}）` : `会话 ${result.total} 个`
  const lines: string[] = [color.bold(title, options)]
  if (result.items.length === 0) {
    lines.push('未找到会话。')
    return lines.join('\n')
  }

  const rows = result.items.map((item: SnapshotSummary) => [
    item.session_id,
    item.project_name,
    item.current_phase.length > 0 ? item.current_phase : '—',
    String(item.target_hosts.length),
    formatLocalTime(item.updated_at),
    item.parent_session_id ?? '—',
    item.archived_at !== null ? '是' : '否',
    String(item.child_count),
    String(item.unfinished_count)
  ])
  lines.push(renderTable(LIST_COLUMNS, rows))
  return lines.join('\n')
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

function appendNumbered(lines: string[], heading: string, values: readonly string[], options: ColorOptions): void {
  lines.push('', color.bold(`${heading}（${values.length}）`, options))
  if (values.length === 0) {
    lines.push('  （无）')
    return
  }
  values.forEach((value, index) => lines.push(`  ${index + 1}. ${value}`))
}

function appendBullets(lines: string[], heading: string, values: readonly string[], options: ColorOptions): void {
  lines.push('', color.bold(`${heading}（${values.length}）`, options))
  if (values.length === 0) {
    lines.push('  （无）')
    return
  }
  for (const value of values) lines.push(bullet(value))
}

/** Render one full session: metadata, the nine payload fields and rollback state. */
export function renderSnapshotDetail(session: SnapshotSession, useColor: boolean): string {
  const options: ColorOptions = { enabled: useColor }
  const lines: string[] = [color.bold(session.session_id, options), '']

  lines.push(`${color.dim('父会话:', options)} ${session.parent_session_id ?? '—'}`)
  lines.push(`${color.dim('已归档:', options)} ${session.archived_at !== null ? '是' : '否'}`)
  lines.push(`${color.dim('创建:', options)} ${formatLocalTime(session.created_at)}`)
  lines.push(`${color.dim('更新:', options)} ${formatLocalTime(session.updated_at)}`)
  lines.push(`${color.dim('子会话数:', options)} ${session.child_count}`)
  lines.push('')
  lines.push(`${color.dim('项目:', options)} ${session.project_name}`)

  appendParagraph(lines, '当前阶段', session.current_phase, options)

  lines.push(
    '',
    `${color.bold('目标 Host', options)}（${session.target_hosts.length}）: ${
      session.target_hosts.length > 0 ? session.target_hosts.join(', ') : '（无）'
    }`
  )

  appendNumbered(lines, '未完成任务', session.unfinished_tasks, options)
  appendBullets(lines, '失败路径', session.failed_paths, options)

  lines.push('', color.bold(`接口测试（${session.tested_interfaces.length}）`, options))
  if (session.tested_interfaces.length === 0) {
    lines.push('  （无）')
  } else {
    for (const item of session.tested_interfaces) {
      lines.push(`  - ${item.target}`)
      lines.push(`      方法: ${item.method.length > 0 ? item.method : '—'}`)
      lines.push(`      结果: ${item.result.length > 0 ? item.result : '—'}`)
    }
  }

  appendParagraph(lines, '备注', session.notes, options)

  lines.push(
    '',
    `${color.dim('关联漏洞:', options)} ${
      session.related_vuln_ids.length > 0 ? session.related_vuln_ids.join(', ') : '—'
    }`
  )

  appendParagraph(lines, '下一步', session.next_steps, options)

  lines.push(
    '',
    `${color.dim('可回滚上一版:', options)} ${session.has_previous_state ? '是' : '否'}`
  )

  return lines.map((line) => line.replace(/\s+$/, '')).join('\n')
}

export async function runSnapshotsList(
  options: SnapshotsListOptions,
  context: CliContext
): Promise<void> {
  const keyword = options.keyword?.trim() ?? ''

  const database = openDatabase(context)
  try {
    const result = database.listSnapshotSessions(keyword.length > 0 ? { keyword } : {})
    if (context.json) {
      writeJson(context, result)
      return
    }
    context.stdout(renderListHuman(result, keyword, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export async function runSnapshotGet(
  sessionId: string | undefined,
  context: CliContext
): Promise<void> {
  const id = sessionId?.trim() ?? ''
  if (id.length === 0) {
    throw new CliError('缺少会话 ID，用法：ctx snapshots get <session_id>', 1)
  }

  const database = openDatabase(context)
  try {
    const session = database.getSnapshotSession(id)
    if (session === null) throw notFound(`未找到会话 ${id}`)

    if (context.json) {
      writeJson(context, session)
      return
    }
    context.stdout(renderSnapshotDetail(session, shouldUseColor(context.json)))
  } finally {
    database.close()
  }
}

export function registerSnapshotCommands(cli: CAC): void {
  cli
    .command('snapshots <action> [session_id]', '认知快照查询：list 列表 / get 详情')
    .option('--keyword <keyword>', '按项目名 / 阶段 / 目标 / 备注 / 下一步模糊搜索（list）')
    .action(
      async (action: string, sessionId: string | undefined, options: SnapshotsListOptions) => {
        const context = createCliContext()
        if (action === 'list') {
          await runSnapshotsList(options, context)
          return
        }
        if (action === 'get') {
          await runSnapshotGet(sessionId, context)
          return
        }
        throw new CliError(`未知 snapshots 子命令: ${action}（可选 list | get）`, 1)
      }
    )
}
