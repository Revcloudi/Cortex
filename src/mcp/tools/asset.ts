import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  QueryAssetContextInputSchema,
  SyncAssetInfoInputSchema,
  deriveAssetHost,
  type AssetContext,
  type SyncAssetResult
} from '../../shared/types'
import { formatUnknownError, formatZodError } from '../../shared/validation'
import type { DatabaseService } from '../../core/db/DatabaseService'
import { truncateForLog, type HubLogger } from '../../core/logging'

/** Asset-context tools exposed over MCP, in registration order. */
export const ASSET_TOOL_NAMES = ['sync_asset_info', 'query_asset_context'] as const

export type AssetToolName = (typeof ASSET_TOOL_NAMES)[number]

export interface AssetToolDeps {
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
  toolName: AssetToolName,
  error: z.ZodError,
  deps: AssetToolDeps
): CallToolResult {
  const detail = formatZodError(error)
  deps.logger.warn(`[MCP] ${toolName} 参数校验失败: ${truncateForLog(detail)}`)
  return errorResult(`参数校验失败: ${detail}`)
}

function notifyDataChanged(toolName: AssetToolName, deps: AssetToolDeps): void {
  if (!deps.onDataChanged) return
  try {
    deps.onDataChanged()
  } catch (error) {
    deps.logger.error(`[MCP] ${toolName} 数据变更回调失败: ${formatUnknownError(error)}`)
  }
}

/**
 * Same discovery-schema pattern as the vulnerability tools: advertise useful
 * field types while letting the callback own validation and Chinese errors.
 */
function permissiveFields<S extends Record<string, z.ZodType>>(shape: S): Record<string, z.ZodType> {
  const fields: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(shape)) {
    const permissive = z.union([field, z.unknown()])
    fields[key] = field.safeParse(undefined).success ? permissive.optional() : permissive
  }
  return fields
}

const syncAssetInfoDiscoveryFields = permissiveFields(SyncAssetInfoInputSchema.shape)
syncAssetInfoDiscoveryFields.test_parameters = z
  .array(z.looseObject({ name: z.string(), endpoint: z.string(), location: z.string() }))
  .max(100)
  .optional()
const SyncAssetInfoToolInput = z.looseObject(syncAssetInfoDiscoveryFields)
const QueryAssetContextToolInput = z.looseObject(
  permissiveFields(QueryAssetContextInputSchema.shape)
)

type ToolHandler = (args: unknown) => Promise<CallToolResult>

function safeTool(toolName: AssetToolName, deps: AssetToolDeps, handler: ToolHandler): ToolHandler {
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

function registerSyncAssetInfoTool(server: McpServer, deps: AssetToolDeps): void {
  server.registerTool(
    'sync_asset_info',
    {
      title: '同步资产上下文',
      description:
        '将侦察所得资产上下文（指纹、接口、敏感泄露、测试参数、关联漏洞）写入本地 SQLite。调用前先用 query_asset_context 读取已有上下文，避免覆盖旧信息。host_port 优先传完整 URL（如 https://example.com/login）；单独的 IP / IP:端口不支持入库，IP 资产请传完整 http(s) URL。接口优先用 interfaces[]：path 必填，method/params/request 可选，request 为完整原始 HTTP 请求；旧版 interface_dir 仍兼容并规范化为 { path }。JS/CSS/图片等静态文件不是接口。test_parameters 记录从响应/URL/JS 收集的非密测试参数种子（id/orderId/tenantId）：values 只放少量样例、pattern 写枚举规则，禁止放密码/Token/PII；tested/notes/related_vuln_ids 记录测试状态。mode=replace（默认，完整快照）或 merge（增量合并）。',
      inputSchema: SyncAssetInfoToolInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    safeTool('sync_asset_info', deps, async (args) => {
      deps.logger.info(`[MCP] sync_asset_info 请求: ${truncateForLog(args)}`)
      const parsed = SyncAssetInfoInputSchema.safeParse(args)
      if (!parsed.success) return validationError('sync_asset_info', parsed.error, deps)

      const { mode, ...payload } = parsed.data
      const rawArgs =
        typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
      const asset: AssetContext = {
        ...payload,
        host: payload.host?.trim() ?? deriveAssetHost(payload.host_port),
        last_seen: payload.last_seen ?? new Date().toISOString()
      }

      if (mode === 'merge') {
        const existing = deps.db.getAssetDetail(asset.host_port)
        if (existing !== null) {
          if (!Object.hasOwn(rawArgs, 'auth_required')) asset.auth_required = existing.auth_required
          if (!Object.hasOwn(rawArgs, 'status')) asset.status = existing.status
        }
      }

      const { created, asset: stored } = deps.db.upsertAssetContext(asset, mode)
      notifyDataChanged('sync_asset_info', deps)

      const result: SyncAssetResult = {
        success: true,
        host_port: stored.host_port,
        host: stored.host,
        created,
        mode,
        message: '资产信息已同步'
      }
      deps.logger.info(`[MCP] sync_asset_info 结果: ${truncateForLog(result)}`)
      return jsonResult(result)
    })
  )
}

/**
 * Unified read tool for the asset library. Exactly one selector chooses the
 * mode: `host_port` returns one full `AssetContext`, `project_name` returns a
 * fuzzy-matched `AssetContext[]` (possibly empty).
 */
function registerQueryAssetContextTool(server: McpServer, deps: AssetToolDeps): void {
  server.registerTool(
    'query_asset_context',
    {
      title: '查询资产上下文',
      description:
        '只读查询资产上下文，host_port 与 project_name 二选一：host_port 返回该资产的完整 AssetContext（项目名、技术栈、interfaces[]、interface_dir[]、test_parameters[]、敏感泄露、关联漏洞、last_seen）；project_name 模糊查询返回 AssetContext[]（可为空数组）。未找到资产时返回 isError 提示先侦察并 sync_asset_info。',
      inputSchema: QueryAssetContextToolInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    safeTool('query_asset_context', deps, async (args) => {
      deps.logger.info(`[MCP] query_asset_context 请求: ${truncateForLog(args)}`)

      const parsed = QueryAssetContextInputSchema.safeParse(args)
      if (!parsed.success) return validationError('query_asset_context', parsed.error, deps)

      const { host_port: hostPort, project_name: projectName } = parsed.data

      if (hostPort !== undefined) {
        const asset = deps.db.getAssetDetail(hostPort)
        if (asset === null) {
          deps.logger.warn(`[MCP] query_asset_context 未找到: ${hostPort}`)
          return errorResult(
            `未找到资产 ${hostPort} 的上下文；请先完成侦察并调用 sync_asset_info 写入`
          )
        }
        deps.logger.info(
          `[MCP] query_asset_context 结果: host=${asset.host_port} interfaces=${asset.interfaces.length} leaks=${asset.leaked_infos.length}`
        )
        return jsonResult(asset)
      }

      if (projectName === undefined) {
        return errorResult('参数校验失败: host_port 与 project_name 必须且只能提供一个')
      }

      const assets = deps.db.queryAssetsByProject(projectName)
      deps.logger.info(
        `[MCP] query_asset_context 结果: project=${projectName} 命中 ${assets.length} 条`
      )
      return jsonResult(assets)
    })
  )
}

/** Register exactly the two asset-context tools on a fresh McpServer. */
export function registerAssetTools(server: McpServer, deps: AssetToolDeps): void {
  registerSyncAssetInfoTool(server, deps)
  registerQueryAssetContextTool(server, deps)
  deps.logger.debug(
    `[MCP] 已注册 ${ASSET_TOOL_NAMES.length} 个资产工具: ${ASSET_TOOL_NAMES.join(', ')}`
  )
}
