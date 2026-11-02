import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Minimal tool-registration contract shared by the six Cortex tools.
 *
 * Keeping the tools decoupled from the MCP SDK's `McpServer` lets the server
 * advertise a strict JSON Schema in `tools/list` while still running the
 * tool-level zod validation in the callbacks (so validation failures can carry
 * actionable "how to call me" guidance instead of a generic SDK error).
 */
export interface ToolRegistrar {
  registerTool(
    name: string,
    config: {
      title?: string
      description?: string
      /** Zod schema or Zod raw shape; serialized for `tools/list`. */
      inputSchema: unknown
      annotations?: Record<string, boolean>
    },
    handler: (args: unknown) => Promise<CallToolResult>
  ): void
}
