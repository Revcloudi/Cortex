import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { DatabaseService } from '../core/db/DatabaseService'
import { consoleLogger, type HubLogger } from '../core/logging'
import { CORTEX_VERSION } from '../core/version'
import { registerAssetTools } from './tools/asset'
import { registerSnapshotTools } from './tools/snapshot'
import { registerVulnerabilityTools } from './tools/vulnerability'

export const MCP_SERVER_NAME = 'cortex'

/**
 * Agent-facing instructions shipped with every stdio MCP handshake. Kept in
 * sync with the globally installed `vuln-db` / `asset-context` / `snapshot`
 * skills; the tool definitions themselves live in `./tools`.
 */
export const MCP_SERVER_INSTRUCTIONS = `Cortex is a local pentest intelligence memory. Before testing an asset, call query_asset_context (host_port or project_name) to reuse existing recon context; after collecting Web asset information, call sync_asset_info to persist fingerprints, structured interfaces, leaked information, test parameters and related vulnerabilities. Before saving a vulnerability, call query_vulnerabilities to deduplicate, then call save_vulnerability; use update_vulnerability's retest parameter to append retest history and never rewrite the original evidence. Use manage_snapshot list/load to resume a task in a new session and save before the session ends. The MCP server is launched by the agent over stdio (no desktop app required); the database is shared with the GUI. Field rules live in the vuln-db and asset-context skills.`

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

/**
 * Build a fresh MCP server with the six approved tools registered.
 *
 * One server instance per stdio connection; handlers are stateless and share
 * the injected `DatabaseService`. Adding, removing or merging tools here would
 * break the published MCP contract - keep exactly six.
 */
export function createCortexServer(options: CortexServerOptions): McpServer {
  const logger = options.logger ?? consoleLogger
  const version = options.version ?? CORTEX_VERSION

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version },
    {
      capabilities: { tools: {} },
      instructions: MCP_SERVER_INSTRUCTIONS
    }
  )

  const deps = {
    db: options.db,
    logger,
    ...(options.onDataChanged ? { onDataChanged: options.onDataChanged } : {})
  }
  registerVulnerabilityTools(server, deps)
  registerAssetTools(server, deps)
  registerSnapshotTools(server, deps)
  return server
}
