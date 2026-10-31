#!/usr/bin/env node
/**
 * Cortex - pure stdio MCP entry point.
 *
 * Started by the agent itself (`<node> <install>/bin/mcp-stdio.cjs`); exiting
 * the agent destroys the process. The desktop GUI is optional: both ends share
 * the same SQLite file (`~/.cortex/data.db`, override with `CTX_DB_PATH`).
 *
 * stdout is reserved for MCP JSON-RPC frames - all logging goes to stderr (and
 * optionally to `CTX_MCP_LOG`). Ctrl+C / stdin EOF shut the database down
 * gracefully.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { DatabaseService } from '../core/db/DatabaseService'
import { ensureDbDirectory, hardenDatabasePermissions, resolveDbPath } from '../core/paths'
import { CORTEX_VERSION } from '../core/version'
import { createMcpLogger } from './logger'
import { createCortexServer } from './server'

const logger = createMcpLogger()

let database: DatabaseService | null = null
let server: McpServer | null = null
let shuttingDown = false

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await server?.close()
  } catch (error) {
    logger.warn(`[mcp] failed to close MCP server: ${formatError(error)}`)
  }
  server = null
  try {
    database?.close()
  } catch (error) {
    logger.warn(`[mcp] failed to close database: ${formatError(error)}`)
  }
  database = null
  process.exit(code)
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath()
  ensureDbDirectory(dbPath)
  database = new DatabaseService(dbPath)
  hardenDatabasePermissions(dbPath)

  server = createCortexServer({ db: database, logger, version: CORTEX_VERSION })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info(
    `[mcp] stdio ready (version=${CORTEX_VERSION}, db=${dbPath}, schema=${database.getSchemaVersion()})`
  )
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
process.stdin.on('end', () => void shutdown(0))
process.on('uncaughtException', (error) => {
  logger.error(`[mcp] uncaught exception: ${formatError(error)}`)
  void shutdown(1)
})
process.on('unhandledRejection', (reason) => {
  logger.error(`[mcp] unhandled promise rejection: ${formatError(reason)}`)
  void shutdown(1)
})

main().catch((error: unknown) => {
  logger.error(`[mcp] failed to start: ${formatError(error)}`)
  void shutdown(1)
})
