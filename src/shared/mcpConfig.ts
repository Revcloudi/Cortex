import type { McpRuntimeInfo } from './types'

export interface LocalizedText {
  zh: string
  en: string
}

/**
 * stdio MCP launch configuration and per-agent config snippets.
 *
 * Shared by the Electron MCP page (copy buttons) and the `ctx` CLI
 * (`ctx init`, `ctx mcp print-config`), so both surfaces always show the same
 * command. Pure TypeScript with no Node.js imports: the renderer imports it too.
 */
export interface StdioLaunchTarget {
  /** Executable that starts the server, e.g. `node` or `<install>/bin/node.exe`. */
  command: string
  /** Absolute path of `mcp-stdio.cjs` / the development stdio entry. */
  entry: string
}

export type AgentConfigFormat = 'yaml' | 'toml' | 'json' | 'shell'

export interface AgentMcpSnippet {
  id: 'dsh' | 'codex' | 'claude' | 'cursor'
  name: string
  /** Config file (or command) the snippet belongs to. */
  target: string
  format: AgentConfigFormat
  description: LocalizedText
  /** Full copy-paste-ready snippet. */
  value: string
}

export interface AgentStdioConfig {
  serverName: string
  command: string
  args: string[]
}

/** YAML/TOML/JSON snippets are easier to copy with forward slashes on Windows. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

/** Quote a path for a copy-paste shell command (PowerShell / cmd / POSIX). */
export function quoteShellArg(value: string): string {
  if (value.length === 0) return '""'
  if (!/[\s"'&|<>^()$`]/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

export function stdioLaunchConfig(target: StdioLaunchTarget): AgentStdioConfig {
  return {
    serverName: 'cortex',
    command: target.command,
    args: [target.entry]
  }
}

/** `node <entry>` / `"C:/.../node.exe" "C:/.../mcp-stdio.cjs"` */
export function stdioCommandDisplay(target: StdioLaunchTarget): string {
  return [quoteShellArg(target.command), quoteShellArg(target.entry)].join(' ')
}

export function buildAgentMcpSnippets(target: StdioLaunchTarget): AgentMcpSnippet[] {
  const command = toPosixPath(target.command)
  const entry = toPosixPath(target.entry)
  const launch = stdioLaunchConfig({ command, entry })

  return [
    {
      id: 'dsh',
      name: 'DeepSeek Harness',
      target: '~/.dsh/profiles/<profile>/cordis.patch.yml',
      format: 'yaml',
      description: {
        zh: '把 Cortex MCP 条目追加到 insert: 列表，DSH 重启后自动以 stdio 拉起。',
        en: 'Append the Cortex MCP entry to the insert: list; DSH launches it over stdio after a restart.'
      },
      value: `- insert:
    - id: mcp-cortex
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: cortex
        transport: stdio
        command: ${yamlQuote(command)}
        args:
          - ${yamlQuote(entry)}
        toolCallTimeoutMs: 120000`
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      target: '~/.codex/config.toml',
      format: 'toml',
      description: {
        zh: '写入 [mcp_servers.cortex]，Codex 启动时自动拉起。',
        en: 'Write [mcp_servers.cortex]; Codex starts it automatically.'
      },
      value: `[mcp_servers.cortex]
command = ${JSON.stringify(command)}
args = [${JSON.stringify(entry)}]
startup_timeout_sec = 20
tool_timeout_sec = 120`
    },
    {
      id: 'claude',
      name: 'Claude Code',
      target: 'claude mcp add (CLI command)',
      format: 'shell',
      description: {
        zh: '在终端执行一次，把 stdio MCP server 注册到 Claude Code。',
        en: 'Run once in a terminal to register the stdio MCP server with Claude Code.'
      },
      value: `claude mcp add --transport stdio cortex -- ${launch.command} ${launch.args[0] ?? ''}`
    },
    {
      id: 'cursor',
      name: 'Cursor',
      target: '~/.cursor/mcp.json',
      format: 'json',
      description: {
        zh: '写入 mcpServers；Cursor 重启后自动以 stdio 拉起。',
        en: 'Write the mcpServers entry; Cursor launches it over stdio after a restart.'
      },
      value: JSON.stringify(
        {
          mcpServers: {
            cortex: {
              command: launch.command,
              args: launch.args
            }
          }
        },
        null,
        2
      )
    }
  ]
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Convenience for the GUI: build the runtime description from AppInfo. */
export function runtimeFromInfo(info: McpRuntimeInfo): StdioLaunchTarget {
  return { command: info.command, entry: info.entry }
}
