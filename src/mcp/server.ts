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
export const MCP_SERVER_INSTRUCTIONS = `Cortex is a local pentest intelligence memory shared by the agent, the GUI and the CLI. You MUST call the tools at the right steps instead of only describing results in chat. (1) Before testing an asset, call query_asset_context({ host_port } or { project_name }) to reuse existing recon. (2) After JS auditing / fingerprinting / endpoint capture, call sync_asset_info to persist fingerprints, structured interfaces, leaked information, test parameters and related vulnerabilities (mode "replace" for a full snapshot, "merge" for increments). (3) Before saving a vulnerability, call query_vulnerabilities({ host } or { search } or ...) to deduplicate, then call save_vulnerability; retests must use update_vulnerability({ vuln_id, retest: { time_range, conclusion } }) and status transitions update_vulnerability({ vuln_id, status }) — never rewrite the original evidence. (4) Resume tasks with manage_snapshot list → load, save at phase end / context full / session end (project session → one level of child sessions; attach_assets for new targets). The MCP server is launched by the agent over stdio (no desktop app required); the database is shared with the GUI. Field rules and exact call examples live in the vuln-db, asset-context and snapshot skills.`

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
