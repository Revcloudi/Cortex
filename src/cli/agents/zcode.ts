import { join } from 'node:path'
import { CliError } from '../errors'
import { toPosixPath, type CliRuntime } from '../runtime'
import type { AgentPlan, FilePlan } from './index'
import { capDiffLines } from './markers'
import { planRuleFile } from './rules'

/**
 * ZCode integration (Z.AI / 智谱 ZCode Agentic CLI).
 *
 * MCP config: user scope `~/.zcode/cli/config.json`, key `mcp.servers`; project
 * scope `<project>/.zcode/config.json` uses the same shape (ZCode also accepts
 * the generic `.agents/mcp.json` fallback). Only `mcp.servers.cortex` is
 * replaced; every other key (model settings, other servers…) is preserved and
 * the whole candidate is re-parsed before writing.
 *
 * ZCode reads user-level instructions from `~/.zcode/AGENTS.md`, so the hard
 * rules are merged there with the same marker blocks used for Codex.
 * Skills are copied to `~/.zcode/skills/<name>/SKILL.md` by `planSkills`.
 */

export const ZCODE_SERVER_KEY = 'cortex'

export function zcodeConfigPath(zcodeHome: string): string {
  return join(zcodeHome, 'cli', 'config.json')
}

export function zcodeRulesPath(zcodeHome: string): string {
  return join(zcodeHome, 'AGENTS.md')
}

export function buildZcodeServer(runtime: CliRuntime): { command: string; args: string[] } {
  return {
    command: toPosixPath(runtime.nodeExecutable),
    args: [toPosixPath(runtime.mcpEntry)]
  }
}

export interface ZcodePlanOptions {
  zcodeHome: string
  runtime: CliRuntime
  exists: (filePath: string) => boolean
  readFile: (filePath: string) => string
}

export function planZcode(options: ZcodePlanOptions): AgentPlan {
  const files: FilePlan[] = [
    planZcodeMcp(options),
    planRuleFile({
      agent: 'zcode',
      path: zcodeRulesPath(options.zcodeHome),
      exists: options.exists,
      readFile: options.readFile
    })
  ]
  return { files, warnings: [] }
}

function planZcodeMcp(options: ZcodePlanOptions): FilePlan {
  const configPath = zcodeConfigPath(options.zcodeHome)
  const server = buildZcodeServer(options.runtime)
  const existed = options.exists(configPath)
  const current = existed ? options.readFile(configPath) : ''

  const root = current.trim().length === 0 ? {} : parseJsonObject(current, configPath)
  const existingMcp = root['mcp']
  if (existingMcp !== undefined && existingMcp !== null && !isJsonObject(existingMcp)) {
    throw new CliError(`无法写入 ${configPath}：mcp 必须是 JSON 对象`, 1)
  }
  const mcp: Record<string, unknown> = isJsonObject(existingMcp) ? { ...existingMcp } : {}
  const existingServers = mcp['servers']
  if (
    existingServers !== undefined &&
    existingServers !== null &&
    !isJsonObject(existingServers)
  ) {
    throw new CliError(`无法写入 ${configPath}：mcp.servers 必须是 JSON 对象`, 1)
  }
  const servers: Record<string, unknown> = isJsonObject(existingServers)
    ? { ...existingServers }
    : {}
  const oldValue = servers[ZCODE_SERVER_KEY]
  const candidate = `${JSON.stringify(
    {
      ...root,
      mcp: {
        ...mcp,
        servers: {
          ...servers,
          [ZCODE_SERVER_KEY]: server
        }
      }
    },
    null,
    2
  )}\n`
  validateJson(candidate, configPath)

  if (existed && candidate === current) {
    return {
      agent: 'zcode',
      kind: 'mcp',
      path: configPath,
      status: 'skipped',
      detail: '内容已最新'
    }
  }

  const diffLines: string[] = []
  if (oldValue !== undefined) {
    diffLines.push(`- "mcp.servers.${ZCODE_SERVER_KEY}": ${JSON.stringify(oldValue)}`)
  }
  diffLines.push(`+ "mcp.servers.${ZCODE_SERVER_KEY}": ${JSON.stringify(server)}`)

  return {
    agent: 'zcode',
    kind: 'mcp',
    path: configPath,
    status: existed ? 'updated' : 'created',
    diff: capDiffLines(diffLines, 20),
    content: candidate
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
