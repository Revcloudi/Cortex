import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { CliError } from '../errors'
import { toPosixPath, type CliRuntime } from '../runtime'
import type { AgentPlan, FilePlan } from './index'
import {
  LEGACY_MCP_MARKERS,
  MCP_MARKERS,
  diffBlockText,
  extractMarkerBlock,
  hasIncompleteMarkerPair,
  upsertMarkerBlock
} from './markers'
import { planRuleFile } from './rules'

/**
 * Codex CLI integration: `~/.codex/config.toml`.
 *
 * Marker-managed like the DSH patch. Codex configs are plain TOML, so the whole
 * candidate is validated with `smol-toml` before writing; a hand-edited old
 * `[mcp_servers.cortex]` table without markers — or the pre-rename
 * `[mcp_servers.pentest_data_hub]` table — is upgraded in place (appending it
 * again would make the file invalid TOML).
 */

export function buildCodexMcpBlock(runtime: CliRuntime): string {
  const command = JSON.stringify(toPosixPath(runtime.nodeExecutable))
  const entry = JSON.stringify(toPosixPath(runtime.mcpEntry))
  return [
    MCP_MARKERS.begin,
    '[mcp_servers.cortex]',
    `command = ${command}`,
    `args = [${entry}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120',
    MCP_MARKERS.end
  ].join('\n')
}

export interface CodexPlanOptions {
  codexHome: string
  runtime: CliRuntime
  exists: (filePath: string) => boolean
  readFile: (filePath: string) => string
}

export function planCodex(options: CodexPlanOptions): AgentPlan {
  const files: FilePlan[] = []
  const warnings: string[] = []

  files.push(
    planCodexMcp(join(options.codexHome, 'config.toml'), options.runtime, options)
  )
  files.push(
    planRuleFile({
      agent: 'codex',
      path: join(options.codexHome, 'AGENTS.md'),
      exists: options.exists,
      readFile: options.readFile
    })
  )

  return { files, warnings }
}

function planCodexMcp(
  configPath: string,
  runtime: CliRuntime,
  options: Pick<CodexPlanOptions, 'exists' | 'readFile'>
): FilePlan {
  const block = buildCodexMcpBlock(runtime)
  const existed = options.exists(configPath)
  const current = existed ? options.readFile(configPath) : ''

  let candidate: string
  let diff: string
  let detail: string | undefined
  const oldBlock =
    extractMarkerBlock(current, MCP_MARKERS) ??
    extractMarkerBlock(current, LEGACY_MCP_MARKERS)

  if (oldBlock !== undefined) {
    candidate = upsertMarkerBlock(current, block, MCP_MARKERS, {
      legacyMarkers: LEGACY_MCP_MARKERS
    }).content
    diff = diffBlockText(oldBlock, block)
  } else {
    const legacy =
      hasIncompleteMarkerPair(current, MCP_MARKERS, LEGACY_MCP_MARKERS)
        ? null
        : findUnmarkedTable(current)
    if (legacy !== null) {
      candidate = replaceLegacyTable(current, legacy, block)
      diff = diffBlockText(legacy.block, block)
      detail = '已将未带标记的旧 [mcp_servers.*] 表替换为 Cortex stdio 表'
    } else {
      candidate = upsertMarkerBlock(current, block, MCP_MARKERS, {
        legacyMarkers: LEGACY_MCP_MARKERS
      }).content
      diff = diffBlockText(undefined, block)
    }
  }

  validateCodexToml(candidate, configPath)

  if (existed && candidate === current) {
    return {
      agent: 'codex',
      kind: 'mcp',
      path: configPath,
      status: 'skipped',
      detail: '内容已最新'
    }
  }
  return {
    agent: 'codex',
    kind: 'mcp',
    path: configPath,
    status: existed ? 'updated' : 'created',
    detail,
    diff,
    content: candidate
  }
}

interface LegacyTable {
  start: number
  end: number
  block: string
}

/** Find a marker-less `[mcp_servers.cortex]` / legacy table region. */
function findUnmarkedTable(content: string): LegacyTable | null {
  const lines = content.split('\n')
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmedLine = line.trim()
    if (
      trimmedLine !== '[mcp_servers.cortex]' &&
      trimmedLine !== '[mcp_servers.pentest_data_hub]'
    ) {
      offset += line.length + 1
      continue
    }

    let endLine = lines.length
    for (let next = index + 1; next < lines.length; next += 1) {
      const trimmed = (lines[next] ?? '').trim()
      if (trimmed.length === 0 || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        endLine = next
        break
      }
    }

    let end = offset + line.length
    for (let next = index + 1; next < endLine; next += 1) {
      end += 1 + (lines[next] ?? '').length
    }
    return { start: offset, end, block: content.slice(offset, end) }
  }
  return null
}

function replaceLegacyTable(content: string, legacy: LegacyTable, block: string): string {
  const before = content.slice(0, legacy.start)
  const restStart = content[legacy.end] === '\n' ? legacy.end + 1 : legacy.end
  const after = content.slice(restStart)
  const prefix = before.length === 0 ? '' : before.endsWith('\n') ? before : `${before}\n`
  return `${prefix}${block}\n${after}`
}

/** Validate the whole candidate before writing so a bad merge never lands. */
export function validateCodexToml(content: string, configPath: string): void {
  try {
    parseToml(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliError(
      `无法写入 ${configPath}：TOML 校验失败（${message.split('\n')[0] ?? message}）`,
      1
    )
  }
}
