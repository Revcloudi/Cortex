import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  SyncInternalScopeInputSchema,
  type SyncInternalScopeResult
} from '../../shared/internal'
import { formatUnknownError } from '../../shared/validation'
import { DatabaseError, type DatabaseService } from '../../core/db/DatabaseService'
import { truncateForLog, type HubLogger } from '../../core/logging'
import { formatMcpInputError } from './inputError'
import type { ToolRegistrar } from './registrar'

/**
 * Internal-operations tool (#7 of the Cortex MCP surface).
 *
 * Plan B deliberately ships exactly one new tool: `sync_internal_scope` writes
 * the whole internal domain (footholds → internal hosts/services → credentials
 * → pivots) in one `BEGIN IMMEDIATE` transaction inside the DatabaseService.
 * Everything else stays additive on the existing six tools.
 */

/** Internal-domain tools exposed over MCP, in registration order. */
export const INTERNAL_TOOL_NAMES = ['sync_internal_scope'] as const

export type InternalToolName = (typeof INTERNAL_TOOL_NAMES)[number]

export interface InternalToolDeps {
  db: DatabaseService
  logger: HubLogger
  /** Called after every successful write so the UI can refresh. */
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
  toolName: InternalToolName,
  error: z.ZodError,
  args: unknown,
  deps: InternalToolDeps
): CallToolResult {
  const detail = formatMcpInputError(toolName, error, args)
  deps.logger.warn(`[MCP] ${toolName} 参数校验失败: ${truncateForLog(detail)}`)
  return errorResult(detail)
}

/** Never let a broken UI listener turn a successful database write into an MCP error. */
function notifyDataChanged(toolName: InternalToolName, deps: InternalToolDeps): void {
  if (!deps.onDataChanged) return
  try {
    deps.onDataChanged()
  } catch (error) {
    deps.logger.error(`[MCP] ${toolName} 数据变更回调失败: ${formatUnknownError(error)}`)
  }
}

/**
 * Request logging must never leak secrets: this tool can carry plaintext
 * passwords / NTLM hashes / SSH keys inside `credentials[].secret`. Log only
 * counts and identifiers, never the raw payload.
 */
function summarizeRequest(args: unknown): string {
  if (typeof args !== 'object' || args === null) return typeof args
  const record = args as Record<string, unknown>
  const parts: string[] = []
  const projectName = record['project_name']
  if (typeof projectName === 'string') parts.push(`project=${projectName}`)
  const mode = record['mode']
  if (typeof mode === 'string') parts.push(`mode=${mode}`)
  for (const key of ['footholds', 'hosts', 'services', 'credentials', 'pivots']) {
    const value = record[key]
    if (Array.isArray(value)) parts.push(`${key}=${value.length}`)
    else if (value !== undefined) parts.push(`${key}=set`)
  }
  const removed = record['removed']
  if (removed !== undefined) parts.push('removed=set')
  return parts.length > 0 ? parts.join(' ') : 'no-entity-arrays'
}

type ToolHandler = (args: unknown) => Promise<CallToolResult>

function safeTool(
  toolName: InternalToolName,
  deps: InternalToolDeps,
  handler: ToolHandler
): ToolHandler {
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

function registerSyncInternalScopeTool(server: ToolRegistrar, deps: InternalToolDeps): void {
  server.registerTool(
    'sync_internal_scope',
    {
      title: '同步内网作战域',
      description:
        '将内网作战域写入本地 SQLite：foothold、internal hosts/services、credentials、pivots。调用前先用 query_asset_context({ host_port }) 查看已有上下文，并用 save_vulnerability 保存入口 RCE/初始访问漏洞。所有实体按 project 归属；mode=merge（默认，按 id/自然键增量 upsert、不删除）或 replace（仅替换本次传入的数组）；删除用 removed 显式指定。实体引用规则：entry_host_port 必须是已登记的 Web 资产 assets.host_port；services[].host_id 必须是 hosts[].id（IH-...）；footholds[].host_ids 记录可达主机；pivots[].foothold_id 必须是 footholds[].id（FH-...）。内网漏洞仍用 save_vulnerability 保存：host=入口资产，realm="internal"，service_host 或 internal_service_id 关联内网服务。凭据是高敏数据：只记录必要字段，不要把 secret 写进 notes/日志。',
      inputSchema: SyncInternalScopeInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    safeTool('sync_internal_scope', deps, async (args) => {
      deps.logger.info(`[MCP] sync_internal_scope 请求: ${summarizeRequest(args)}`)

      const parsed = SyncInternalScopeInputSchema.safeParse(args)
      if (!parsed.success) {
        return validationError('sync_internal_scope', parsed.error, args, deps)
      }

      let result: SyncInternalScopeResult
      try {
        result = deps.db.syncInternalScope(parsed.data)
      } catch (error) {
        if (error instanceof DatabaseError) {
          // Invalid references / unknown project are agent-actionable, not bugs.
          deps.logger.warn(`[MCP] sync_internal_scope 拒绝写入: ${error.message}`)
          return errorResult(error.message)
        }
        throw error
      }

      notifyDataChanged('sync_internal_scope', deps)
      deps.logger.info(`[MCP] sync_internal_scope 结果: ${truncateForLog(result)}`)
      return jsonResult(result)
    })
  )
}

/** Register the internal-operations tool on a fresh McpServer. */
export function registerInternalTools(server: ToolRegistrar, deps: InternalToolDeps): void {
  registerSyncInternalScopeTool(server, deps)
  deps.logger.debug(
    `[MCP] 已注册 ${INTERNAL_TOOL_NAMES.length} 个内网工具: ${INTERNAL_TOOL_NAMES.join(', ')}`
  )
}
