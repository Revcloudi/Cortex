import { join } from 'node:path'
import { CliError } from '../errors'
import { toPosixPath, type CliRuntime } from '../runtime'
import type { AgentPlan } from './index'
import { capDiffLines } from './markers'

/**
 * Cursor integration: `~/.cursor/mcp.json`.
 *
 * JSON has no comments, so there are no markers here: `ctx init` merges the
 * `mcpServers['cortex']` key and preserves every other key in the file. A
 * pre-rename `pentest-data-hub` key is dropped so Cursor never lists two
 * servers for the same product. The result is re-parsed before writing to
 * guarantee valid JSON.
 */

export const CURSOR_SERVER_KEY = 'cortex'
/** Pre-rename key removed during the Cortex upgrade. */
export const LEGACY_CURSOR_SERVER_KEY = 'pentest-data-hub'

export function cursorConfigPath(home: string): string {
  return join(home, '.cursor', 'mcp.json')
}

export interface CursorServerEntry {
  command: string
  args: string[]
}

export function buildCursorServer(runtime: CliRuntime): CursorServerEntry {
  return {
    command: toPosixPath(runtime.nodeExecutable),
    args: [toPosixPath(runtime.mcpEntry)]
  }
}

export interface CursorPlanOptions {
  home: string
  runtime: CliRuntime
  exists: (filePath: string) => boolean
  readFile: (filePath: string) => string
}

export function planCursor(options: CursorPlanOptions): AgentPlan {
  const configPath = cursorConfigPath(options.home)
  const server = buildCursorServer(options.runtime)
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
  const oldValue = servers[CURSOR_SERVER_KEY]
  const { [LEGACY_CURSOR_SERVER_KEY]: legacyValue, ...remainingServers } = servers
  const nextServers: Record<string, unknown> = {
    ...remainingServers,
    [CURSOR_SERVER_KEY]: server
  }

  const candidate = `${JSON.stringify({ ...root, mcpServers: nextServers }, null, 2)}\n`
  validateJson(candidate, configPath)

  if (existed && candidate === current) {
    return {
      files: [
        {
          agent: 'cursor',
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
  if (legacyValue !== undefined) {
    diffLines.push(`- "${LEGACY_CURSOR_SERVER_KEY}": ${JSON.stringify(legacyValue)}`)
  }
  if (oldValue !== undefined) {
    diffLines.push(`- "${CURSOR_SERVER_KEY}": ${JSON.stringify(oldValue)}`)
  }
  diffLines.push(`+ "${CURSOR_SERVER_KEY}": ${JSON.stringify(server)}`)

  return {
    files: [
      {
        agent: 'cursor',
        kind: 'mcp',
        path: configPath,
        status: existed ? 'updated' : 'created',
        detail:
          legacyValue === undefined
            ? undefined
            : `已移除旧 ${LEGACY_CURSOR_SERVER_KEY} 键并写入 cortex`,
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
