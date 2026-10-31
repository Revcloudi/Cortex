import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  ManageSnapshotInputSchema,
  SnapshotPayloadSchema,
  type ManageSnapshotResult,
  type SnapshotChoiceResult,
  type SnapshotSavePayload
} from '../../shared/types'
import { formatUnknownError, formatZodError } from '../../shared/validation'
import { DatabaseError, type DatabaseService } from '../../core/db/DatabaseService'
import { truncateForLog, type HubLogger } from '../../core/logging'

/** Cognitive-snapshot tools exposed over MCP, in registration order. */
export const SNAPSHOT_TOOL_NAMES = ['manage_snapshot'] as const

export type SnapshotToolName = (typeof SNAPSHOT_TOOL_NAMES)[number]

export interface SnapshotToolDeps {
  db: DatabaseService
  logger: HubLogger
  onDataChanged?: () => void
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value))
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function validationError(
  toolName: SnapshotToolName,
  error: z.ZodError,
  deps: SnapshotToolDeps
): CallToolResult {
  const detail = formatZodError(error)
  deps.logger.warn(`[MCP] ${toolName} 参数校验失败: ${truncateForLog(detail)}`)
  return errorResult(`参数校验失败: ${detail}`)
}

/** Never let a broken UI listener turn a successful database write into an MCP error. */
function notifyDataChanged(toolName: SnapshotToolName, deps: SnapshotToolDeps): void {
  if (!deps.onDataChanged) return
  try {
    deps.onDataChanged()
  } catch (error) {
    deps.logger.error(`[MCP] ${toolName} 数据变更回调失败: ${formatUnknownError(error)}`)
  }
}

/**
 * Same discovery-schema pattern as the other tools: advertise real field types
 * in `tools/list` while the callback owns strict validation and Chinese errors.
 */
function permissiveFields<S extends Record<string, z.ZodType>>(shape: S): Record<string, z.ZodType> {
  const fields: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(shape)) {
    const permissive = z.union([field, z.unknown()])
    fields[key] = field.safeParse(undefined).success ? permissive.optional() : permissive
  }
  return fields
}

const ManageSnapshotToolInput = z.looseObject(
  permissiveFields(ManageSnapshotInputSchema.shape)
)

type ToolHandler = (args: unknown) => Promise<CallToolResult>

function safeTool(toolName: SnapshotToolName, deps: SnapshotToolDeps, handler: ToolHandler): ToolHandler {
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      return await handler(args)
    } catch (error) {
      const message = `工具 ${toolName} 执行失败: ${formatUnknownError(error)}`
      deps.logger.error(`[MCP] ${message}`)
      return errorResult(message)
    }
  }
}

/** Translate database failures into agent-readable Chinese errors. */
function snapshotDatabaseError(error: unknown): CallToolResult {
  if (error instanceof DatabaseError) {
    if (error.code === 'STALE') {
      return errorResult(
        `保存被拒绝：会话已被其他操作更新，请先 load 最新会话，再带上最新的 base_updated_at 重试（${error.message}）`
      )
    }
    return errorResult(error.message)
  }
  throw error
}

function saveSnapshot(
  input: z.output<typeof ManageSnapshotInputSchema>,
  deps: SnapshotToolDeps
): CallToolResult {
  const { payload, session_id: sessionId } = input
  if (payload === undefined) {
    return errorResult(
      '参数校验失败: save 需要提供 payload（project_name、target_hosts、current_phase、unfinished_tasks、failed_paths、tested_interfaces、notes、related_vuln_ids、next_steps）'
    )
  }

  if (sessionId !== undefined) {
    if (input.parent_session_id !== undefined) {
      return errorResult('参数校验失败: parent_session_id 只能在创建时指定，更新时不能修改父子关系')
    }
    const hasField = (Object.keys(payload) as Array<keyof SnapshotSavePayload>).some(
      (key) => payload[key] !== undefined
    )
    if (!hasField) {
      return errorResult('参数校验失败: save 更新已有会话时 payload 至少需要提供一个字段（未传字段保持原值）')
    }
    try {
      const session = deps.db.updateSnapshotSession(sessionId, payload, {
        baseUpdatedAt: input.base_updated_at
      })
      notifyDataChanged('manage_snapshot', deps)
      const result: ManageSnapshotResult = {
        success: true,
        action: 'save',
        created: false,
        session
      }
      deps.logger.info(
        `[MCP] manage_snapshot save(update) 结果: session=${session.session_id} updated_at=${session.updated_at}`
      )
      return jsonResult(result)
    } catch (error) {
      return snapshotDatabaseError(error)
    }
  }

  const full = SnapshotPayloadSchema.safeParse(payload)
  if (!full.success) {
    return validationError('manage_snapshot', full.error, deps)
  }

  const parentSessionId = input.parent_session_id
  if (parentSessionId === undefined) {
    const candidates = deps.db.findSnapshotSessionsByProject(full.data.project_name)
    if (candidates.length > 0 && input.force_new !== true) {
      const choice: SnapshotChoiceResult = {
        success: false,
        action: 'save',
        requires_choice: true,
        code: 'SESSION_EXISTS',
        candidates
      }
      deps.logger.info(
        `[MCP] manage_snapshot save 需要选择: project=${full.data.project_name} 已有 ${candidates.length} 个会话`
      )
      return jsonResult(choice)
    }
  }

  try {
    const session = deps.db.createSnapshotSession(full.data, new Date(), parentSessionId)
    notifyDataChanged('manage_snapshot', deps)
    const result: ManageSnapshotResult = {
      success: true,
      action: 'save',
      created: true,
      session
    }
    deps.logger.info(
      `[MCP] manage_snapshot save(create) 结果: session=${session.session_id} parent=${session.parent_session_id ?? 'root'}`
    )
    return jsonResult(result)
  } catch (error) {
    return snapshotDatabaseError(error)
  }
}

function loadSnapshot(
  input: z.output<typeof ManageSnapshotInputSchema>,
  deps: SnapshotToolDeps
): CallToolResult {
  const sessionId = input.session_id
  if (sessionId === undefined) {
    return errorResult('参数校验失败: load 需要提供 session_id')
  }
  const session = deps.db.getSnapshotSession(sessionId)
  if (session === null) {
    return errorResult(`未找到会话 ${sessionId}，请先用 list 确认 session_id`)
  }
  const children =
    session.parent_session_id === null
      ? deps.db.listChildSnapshots(session.session_id, { includeArchived: true, limit: 50 })
      : []
  const result: ManageSnapshotResult = { success: true, action: 'load', session, children }
  deps.logger.info(
    `[MCP] manage_snapshot load 结果: session=${session.session_id} children=${children.length}`
  )
  return jsonResult(result)
}

function listSnapshots(
  input: z.output<typeof ManageSnapshotInputSchema>,
  deps: SnapshotToolDeps
): CallToolResult {
  const { total, items } = deps.db.listSnapshotSessions({
    keyword: input.keyword,
    rootsOnly: input.roots_only,
    parentSessionId: input.parent_session_id,
    includeArchived: input.include_archived,
    limit: input.limit
  })
  const result: ManageSnapshotResult = { success: true, action: 'list', total, items }
  deps.logger.info(`[MCP] manage_snapshot list 结果: total=${total} 返回 ${items.length} 条`)
  return jsonResult(result)
}

function attachSnapshotAssets(
  input: z.output<typeof ManageSnapshotInputSchema>,
  deps: SnapshotToolDeps
): CallToolResult {
  const sessionId = input.session_id
  if (sessionId === undefined) {
    return errorResult('参数校验失败: attach_assets 需要提供 session_id')
  }
  const hosts = input.hosts
  if (hosts === undefined || hosts.length === 0) {
    return errorResult('参数校验失败: attach_assets 需要提供非空的 hosts 数组')
  }
  try {
    const session = deps.db.attachSnapshotAssets(sessionId, hosts)
    notifyDataChanged('manage_snapshot', deps)
    const result: ManageSnapshotResult = { success: true, action: 'attach_assets', session }
    deps.logger.info(
      `[MCP] manage_snapshot attach_assets 结果: session=${session.session_id} hosts=${session.target_hosts.length}`
    )
    return jsonResult(result)
  } catch (error) {
    return snapshotDatabaseError(error)
  }
}

function restorePreviousSnapshot(
  input: z.output<typeof ManageSnapshotInputSchema>,
  deps: SnapshotToolDeps
): CallToolResult {
  const sessionId = input.session_id
  if (sessionId === undefined) {
    return errorResult('参数校验失败: restore_previous 需要提供 session_id')
  }
  try {
    const session = deps.db.restoreSnapshotPrevious(sessionId)
    notifyDataChanged('manage_snapshot', deps)
    const result: ManageSnapshotResult = { success: true, action: 'restore_previous', session }
    deps.logger.info(`[MCP] manage_snapshot restore_previous 结果: session=${session.session_id}`)
    return jsonResult(result)
  } catch (error) {
    return snapshotDatabaseError(error)
  }
}

function registerManageSnapshotTool(server: McpServer, deps: SnapshotToolDeps): void {
  server.registerTool(
    'manage_snapshot',
    {
      title: '管理认知快照会话',
      description:
        '单任务 = 单会话的认知快照。save：无 session_id 时 payload 九字段（project_name/target_hosts/current_phase/unfinished_tasks/failed_paths/tested_interfaces/notes/related_vuln_ids/next_steps）全必填创建；有 session_id 时只更新传入字段，未传不变。tested_interfaces 记录接口测试（target/method/result）；notes 为 Markdown 溢出区，放命令、payload 与观察；完整证据入漏洞库/资产库，related_vuln_ids 引用；payload 序列化上限 32k。层级：项目会话可挂多个系统子会话（仅一层，创建时传 parent_session_id）；load 项目会话附 children；list 支持 roots_only / parent_session_id / include_archived。attach_assets 并入 hosts；restore_previous 单步回滚。归档/删除仅桌面端 UI；归档会话只读，写操作提示先取消归档。同 project 已有会话返回 requires_choice+candidates，新建加 force_new:true。',
      inputSchema: ManageSnapshotToolInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    safeTool('manage_snapshot', deps, async (args) => {
      deps.logger.info(`[MCP] manage_snapshot 请求: ${truncateForLog(args)}`)

      const parsed = ManageSnapshotInputSchema.safeParse(args)
      if (!parsed.success) return validationError('manage_snapshot', parsed.error, deps)

      const input = parsed.data
      switch (input.action) {
        case 'save':
          return saveSnapshot(input, deps)
        case 'load':
          return loadSnapshot(input, deps)
        case 'list':
          return listSnapshots(input, deps)
        case 'attach_assets':
          return attachSnapshotAssets(input, deps)
        case 'restore_previous':
          return restorePreviousSnapshot(input, deps)
        default: {
          const unreachable: never = input.action
          return errorResult(`参数校验失败: 未知 action ${String(unreachable)}`)
        }
      }
    })
  )
}

/** Register the cognitive-snapshot tool on a fresh McpServer. */
export function registerSnapshotTools(server: McpServer, deps: SnapshotToolDeps): void {
  registerManageSnapshotTool(server, deps)
  deps.logger.debug(
    `[MCP] 已注册 ${SNAPSHOT_TOOL_NAMES.length} 个认知快照工具: ${SNAPSHOT_TOOL_NAMES.join(', ')}`
  )
}

