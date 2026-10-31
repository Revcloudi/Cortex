import { join } from 'node:path'
import { CliError } from '../errors'
import { toPosixPath, type CliRuntime } from '../runtime'
import type { AgentPlan } from './index'
import { capDiffLines } from './markers'

/**
 * WorkBuddy integration: `~/.workbuddy/mcp.json` (user scope; the same JSON
 * shape also works in `<project>/.workbuddy/mcp.json` for project scope).
 *
 * WorkBuddy uses the common `{"mcpServers": {"<name>": {command, args}}}`
 * convention, so this module mirrors the Cursor merge logic: parse the existing
 * JSON, replace only the `cortex` entry, keep every other server and top-level
 * key, then re-parse before writing.
 *
 * WorkBuddy skills are installed through its own Skill UI; `ctx init` already
 * writes the shared `~/.agents/skills/<name>/SKILL.md` copies that WorkBuddy
 * can import from.
 */

export const WORKBUDDY_SERVER_KEY = 'cortex'

export function workbuddyConfigPath(workbuddyHome: string): string {
  return join(workbuddyHome, 'mcp.json')
}

export function buildWorkBuddyServer(
  runtime: CliRuntime
): { command: string; args: string[] } {
  return {
    command: toPosixPath(runtime.nodeExecutable),
    args: [toPosixPath(runtime.mcpEntry)]
  }
}

export interface WorkBuddyPlanOptions {
  workbuddyHome: string
  runtime: CliRuntime
  exists: (filePath: string) => boolean
  readFile: (filePath: string) => string
}

export function planWorkBuddy(options: WorkBuddyPlanOptions): AgentPlan {
  const configPath = workbuddyConfigPath(options.workbuddyHome)
  const server = buildWorkBuddyServer(options.runtime)
  const existed = options.exists(configPath)
  const current = existed ? options.readFile(configPath) : ''

  const root = current.trim().length === 0 ? {} : parseJsonObject(current, configPath)
  const existingServers = root['mcpServers']
  if (existingServers !== undefined && existingServers !== null && !isJsonObject(existingServers)) {
    throw new CliError(`无法写入 ${configPath}：mcpServers 必须是 JSON 对象`, 1)
  }
  const servers: Record<string, unknown> = isJsonObject(existingServers)
    ? { ...existingServers }
    : {}
  const oldValue = servers[WORKBUDDY_SERVER_KEY]
  const candidate = `${JSON.stringify(
    {
      ...root,
      mcpServers: {
        ...servers,
        [WORKBUDDY_SERVER_KEY]: server
      }
    },
    null,
    2
  )}\n`
  validateJson(candidate, configPath)

  if (existed && candidate === current) {
    return {
      files: [
        {
          agent: 'workbuddy',
          kind: 'mcp',
          path: configPath,
          status: 'skipped',
          detail: '内容已最新'
        }
      ],
      warnings: []
    }
  }

  const diffLines: string[] = []
  if (oldValue !== undefined) {
    diffLines.push(`- "${WORKBUDDY_SERVER_KEY}": ${JSON.stringify(oldValue)}`)
  }
  diffLines.push(`+ "${WORKBUDDY_SERVER_KEY}": ${JSON.stringify(server)}`)

  return {
    files: [
      {
        agent: 'workbuddy',
        kind: 'mcp',
        path: configPath,
        status: existed ? 'updated' : 'created',
        detail: 'Skill 需在 WorkBuddy 设置 → 技能 中从 ~/.agents/skills 导入',
        diff: capDiffLines(diffLines, 20),
        content: candidate
      }
    ],
    warnings: []
  }
}

function parseJsonObject(text: string, configPath: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliError(`无法解析 ${configPath}：${message}`, 1)
  }
  if (!isJsonObject(parsed)) {
    throw new CliError(`无法解析 ${configPath}：顶层必须是 JSON 对象`, 1)
  }
  return parsed
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateJson(content: string, configPath: string): void {
  try {
    JSON.parse(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliError(`无法写入 ${configPath}：JSON 校验失败（${message}）`, 1)
  }
}
