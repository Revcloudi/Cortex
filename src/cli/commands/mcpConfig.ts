import type { CAC } from 'cac'
import { createCliContext, type CliContext } from '../context'
import { CliError } from '../errors'
import { color, shouldUseColor } from '../format'
import { buildAgentMcpSnippets, type AgentMcpSnippet } from '../../shared/mcpConfig'
import { resolveCliRuntime } from '../runtime'

/**
 * `ctx mcp print-config [agent]` — print the exact stdio MCP config fragment
 * for one agent (or all four). Same generator as the GUI MCP page
 * (`@shared/mcpConfig`), so the two surfaces cannot drift.
 */
const AGENT_ALIASES: Record<string, AgentMcpSnippet['id']> = {
  dsh: 'dsh',
  'deepseek-harness': 'dsh',
  codex: 'codex',
  'codex-cli': 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  cursor: 'cursor'
}

export interface McpConfigOptions {
  agent?: string
}

export interface McpConfigResult {
  agent: AgentMcpSnippet['id'] | 'all'
  target: string
  format: AgentMcpSnippet['format']
  value: string
  snippets: AgentMcpSnippet[]
}

export function buildMcpConfigResult(
  agent?: string,
  env: NodeJS.ProcessEnv = process.env
): McpConfigResult {
  const runtime = resolveCliRuntime({ env })
  const snippets = buildAgentMcpSnippets({
    command: runtime.nodeExecutable,
    entry: runtime.mcpEntry
  })

  const requested = agent?.trim()
  if (requested === undefined || requested.length === 0) {
    return {
      agent: 'all',
      target: snippets.map((snippet) => `${snippet.name}: ${snippet.target}`).join('\n'),
      format: 'shell',
      value: snippets.map((snippet) => `# ${snippet.name} · ${snippet.target}\n${snippet.value}`).join('\n\n'),
      snippets
    }
  }

  const id = AGENT_ALIASES[requested.toLowerCase()]
  if (id === undefined) {
    throw new CliError(`未知 Agent: ${requested}（可选: dsh | codex | claude | cursor）`, 1)
  }
  const snippet = snippets.find((item) => item.id === id)
  if (snippet === undefined) {
    throw new CliError(`未找到 ${id} 的 MCP 配置模板`, 1)
  }
  return {
    agent: snippet.id,
    target: snippet.target,
    format: snippet.format,
    value: snippet.value,
    snippets: [snippet]
  }
}

export async function runMcpPrintConfig(options: McpConfigOptions, context: CliContext): Promise<void> {
  const result = buildMcpConfigResult(options.agent, context.env)
  if (context.json) {
    context.stdout(
      JSON.stringify(
        {
          agent: result.agent,
          snippets: result.snippets.map((snippet) => ({
            id: snippet.id,
            name: snippet.name,
            target: snippet.target,
            format: snippet.format,
            value: snippet.value
          }))
        },
        null,
        2
      )
    )
    return
  }

  const colors = { enabled: shouldUseColor(false) }
  if (result.agent === 'all') {
    for (const snippet of result.snippets) {
      context.stdout(color.bold(`# ${snippet.name} · ${snippet.target}`, colors))
      context.stdout(snippet.value)
      context.stdout('')
    }
    return
  }
  context.stdout(color.dim(`# ${result.target}`, colors))
  context.stdout(result.value)
}

export function registerMcpConfigCommands(cli: CAC): void {
  cli
    .command('mcp <action> [agent]', 'MCP 工具：print-config [agent] 打印 stdio 配置片段')
    .action(async (action: string, agent: string | undefined) => {
      if (action !== 'print-config') {
        throw new CliError(`未知 mcp 子命令: ${action}（可用：print-config）`, 1)
      }
      await runMcpPrintConfig({ agent }, createCliContext())
    })
}
