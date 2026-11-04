import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  QueryAssetContextInputSchema,
  SyncAssetInfoInputSchema,
  deriveAssetHost,
  type AssetContext,
  type SyncAssetResult
} from '../../shared/types'
import type { InternalScopeSummary } from '../../shared/internal'
import { formatUnknownError } from '../../shared/validation'
import type { DatabaseService } from '../../core/db/DatabaseService'
import { truncateForLog, type HubLogger } from '../../core/logging'
import { formatMcpInputError } from './inputError'
import type { ToolRegistrar } from './registrar'

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
  args: unknown,
  deps: AssetToolDeps
): CallToolResult {
  const detail = formatMcpInputError(toolName, error, args)
  deps.logger.warn(`[MCP] ${toolName} 参数校验失败: ${truncateForLog(detail)}`)
  return errorResult(detail)
}

function notifyDataChanged(toolName: AssetToolName, deps: AssetToolDeps): void {
  if (!deps.onDataChanged) return
  try {
    deps.onDataChanged()
  } catch (error) {
    deps.logger.error(`[MCP] ${toolName} 数据变更回调失败: ${formatUnknownError(error)}`)
  }
}

/** Strict discovery schemas; the callbacks validate and explain failures. */
const SyncAssetInfoToolInput = SyncAssetInfoInputSchema
const QueryAssetContextToolInput = QueryAssetContextInputSchema

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

function registerSyncAssetInfoTool(server: ToolRegistrar, deps: AssetToolDeps): void {
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
      if (!parsed.success) return validationError('sync_asset_info', parsed.error, args, deps)

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
 *
 * The optional `include_internal` / `include_credentials` flags are additive
 * (Plan B §5.4): they attach an `InternalScopeSummary` for the entry asset or
 * project. Internal data stays opt-in so existing agents do not get a larger
 * context by default; masked credentials imply `include_internal`.
 */
function registerQueryAssetContextTool(server: ToolRegistrar, deps: AssetToolDeps): void {
  server.registerTool(
    'query_asset_context',
    {
      title: '查询资产上下文',
      description:
        '只读查询资产上下文，host_port 与 project_name 二选一：host_port 返回该资产的完整 AssetContext（项目名、技术栈、interfaces[]、interface_dir[]、test_parameters[]、敏感泄露、关联漏洞、last_seen）；传 include_internal=true 时额外返回 internal: InternalScopeSummary（该入口的 footholds、可达内网主机/服务/pivots 与 counts），include_credentials=true 时额外返回脱敏凭据（隐含 include_internal）。project_name 模糊查询默认返回 AssetContext[]（可为空数组）；传 include_internal / include_credentials 时返回 { project_name, assets, internal }。未找到资产时返回 isError 提示先侦察并 sync_asset_info。',
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
      if (!parsed.success) return validationError('query_asset_context', parsed.error, args, deps)

      const {
        host_port: hostPort,
        project_name: projectName,
        include_internal: includeInternalFlag,
        include_credentials: includeCredentialsFlag
      } = parsed.data
      const includeCredentials = includeCredentialsFlag === true
      // Masked credentials imply the internal summary that carries them.
      const includeInternal = includeInternalFlag === true || includeCredentials

      if (hostPort !== undefined) {
        const asset = deps.db.getAssetDetail(hostPort)
        if (asset === null) {
          deps.logger.warn(`[MCP] query_asset_context 未找到: ${hostPort}`)
          return errorResult(
            `未找到资产 ${hostPort} 的上下文；请先完成侦察并调用 sync_asset_info 写入`
          )
        }

        if (includeInternal) {
          const internal: InternalScopeSummary = deps.db.getInternalScopeForAsset(
            asset.host_port,
            { includeCredentials }
          )
          deps.logger.info(
            `[MCP] query_asset_context 结果: host=${asset.host_port} interfaces=${asset.interfaces.length} leaks=${asset.leaked_infos.length} footholds=${internal.counts.footholds} hosts=${internal.counts.hosts} services=${internal.counts.services}`
          )
          return jsonResult({ ...asset, internal })
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
      if (includeInternal) {
        const internal: InternalScopeSummary = deps.db.getInternalScopeForProject(
          projectName,
          { includeCredentials }
        )
        deps.logger.info(
          `[MCP] query_asset_context 结果: project=${projectName} 命中 ${assets.length} 条资产 footholds=${internal.counts.footholds} hosts=${internal.counts.hosts}`
        )
        return jsonResult({ project_name: projectName, assets, internal })
      }

      deps.logger.info(
        `[MCP] query_asset_context 结果: project=${projectName} 命中 ${assets.length} 条`
      )
      return jsonResult(assets)
    })
  )
}

/** Register exactly the two asset-context tools on a fresh McpServer. */
export function registerAssetTools(server: ToolRegistrar, deps: AssetToolDeps): void {
  registerSyncAssetInfoTool(server, deps)
  registerQueryAssetContextTool(server, deps)
  deps.logger.debug(
    `[MCP] 已注册 ${ASSET_TOOL_NAMES.length} 个资产工具: ${ASSET_TOOL_NAMES.join(', ')}`
  )
}
