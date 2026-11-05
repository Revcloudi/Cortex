import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import type { DatabaseService } from '../core/db/DatabaseService'
import { consoleLogger, type HubLogger } from '../core/logging'
import { CORTEX_VERSION } from '../core/version'
import { registerAssetTools } from './tools/asset'
import { registerInternalTools } from './tools/internal'
import { registerSnapshotTools } from './tools/snapshot'
import { registerVulnerabilityTools } from './tools/vulnerability'
import type { ToolRegistrar } from './tools/registrar'
import { sanitizeMcpResult } from './pocSanitize'

export const MCP_SERVER_NAME = 'cortex'

/**
 * Agent-facing instructions shipped with every stdio MCP handshake. Kept in
 * sync with the globally installed `vuln-db` / `asset-context` / `snapshot` /
 * `internal-ops` skills; the tool definitions themselves live in `./tools`.
 */
export const MCP_SERVER_INSTRUCTIONS = `Cortex is a local pentest intelligence memory shared by the agent, the GUI and the CLI. You MUST call the tools at the right steps instead of only describing results in chat. (1) Before testing an asset, call query_asset_context({ host_port } or { project_name }) to reuse existing recon. (2) After JS auditing / fingerprinting / endpoint capture, call sync_asset_info to persist fingerprints, structured interfaces, leaked information, test parameters and related vulnerabilities (mode "replace" for a full snapshot, "merge" for increments). (3) Before saving a vulnerability, call query_vulnerabilities({ host } or { search } or ...) to deduplicate, then call save_vulnerability; retests must use update_vulnerability({ vuln_id, retest: { time_range, conclusion } }) and status transitions update_vulnerability({ vuln_id, status }) — never rewrite the original evidence. (4) Resume tasks with manage_snapshot list → load, save at phase end / context full / session end (project session → one level of child sessions; attach_assets for new targets). (5) Internal operations: after an entry RCE / initial access is saved with save_vulnerability, call sync_internal_scope to register the foothold → reachable internal hosts/services → pivots (project-scoped; mode "merge" keeps incremental writes idempotent, explicit removals only via "removed"). Internal-realm findings still use save_vulnerability with realm="internal" plus service_host and/or internal_service_id (validated against the registered service); read the scope back with query_asset_context include_internal / include_credentials and filter findings with query_vulnerabilities({ realm: "internal" }). The MCP server is launched by the agent over stdio (no desktop app required); the database is shared with the GUI. Field rules and exact call examples live in the vuln-db, asset-context, snapshot and internal-ops skills.`

export interface CortexServerOptions {
  db: DatabaseService
  logger?: HubLogger
  /** Server version reported in `initialize`; defaults to the Cortex version. */
  version?: string
  /**
   * Called after a successful MCP write. The stdio server runs in its own
   * process, so this is only used by in-process consumers (GUI, tests).
   */
  onDataChanged?: () => void
}

interface RegisteredTool {
  name: string
  title?: string
  description?: string
  inputSchema: unknown
  annotations?: Record<string, boolean>
  handler: (args: unknown) => Promise<CallToolResult>
}

class Registrar implements ToolRegistrar {
  readonly tools: RegisteredTool[] = []

  registerTool(
    name: string,
    config: {
      title?: string
      description?: string
      inputSchema: unknown
      annotations?: Record<string, boolean>
    },
    handler: (args: unknown) => Promise<CallToolResult>
  ): void {
    this.tools.push({ name, ...config, handler })
  }
}

/** zod v4 → strict JSON Schema for `tools/list` (input side). */
function toolJsonSchema(schema: unknown): Record<string, unknown> {
  let json: Record<string, unknown>
  try {
    json = z.toJSONSchema(schema as z.ZodType, { io: 'input' }) as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法生成 MCP 工具 JSON Schema: ${message}`)
  }
  // `$schema` is not part of the MCP tool schema contract.
  delete json['$schema']
  return json
}

function toToolDefinitions(registrar: Registrar): Tool[] {
  return registrar.tools.map((tool) => ({
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: toolJsonSchema(tool.inputSchema) as Tool['inputSchema'],
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {})
  }))
}

/**
 * Build a fresh MCP server with the seven approved tools registered.
 *
 * One server instance per stdio connection; handlers are stateless and share
 * the injected `DatabaseService`. Adding, removing or merging tools here would
 * break the published MCP contract - keep exactly seven.
 */
export function createCortexServer(options: CortexServerOptions): Server {
  const logger = options.logger ?? consoleLogger
  const version = options.version ?? CORTEX_VERSION

  const registrar = new Registrar()
  const deps = {
    db: options.db,
    logger,
    ...(options.onDataChanged ? { onDataChanged: options.onDataChanged } : {})
  }
  registerVulnerabilityTools(registrar, deps)
  registerAssetTools(registrar, deps)
  registerSnapshotTools(registrar, deps)
  registerInternalTools(registrar, deps)

  const server = new Server(
    { name: MCP_SERVER_NAME, version },
    {
      capabilities: { tools: {} },
      instructions: MCP_SERVER_INSTRUCTIONS
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toToolDefinitions(registrar)
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = registrar.tools.find((entry) => entry.name === request.params.name)
    if (tool === undefined) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `未知工具: ${request.params.name}（可用: ${registrar.tools
              .map((entry) => entry.name)
              .join(' | ')}）`
          }
        ]
      } satisfies CallToolResult
    }
    return sanitizeMcpResult(await tool.handler(request.params.arguments ?? {}), logger)
  })

  return server
}
