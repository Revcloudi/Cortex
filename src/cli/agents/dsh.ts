import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
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
 * DeepSeek Harness integration: `~/.dsh/profiles/<profile>/cordis.patch.yml`.
 *
 * The MCP server lives in an `insert:` list (a top-level `- id/name/config`
 * entry only overrides an existing loader entry). Our block is marker-managed;
 * old installs that hand-edited the SSE bridge entry without markers (or still
 * carry the pre-rename `mcp-pentest-data-hub` entry) are upgraded by replacing
 * that entry region in place, so the file never ends up with two Cortex entries
 * after the rename.
 */

export interface DshPaths {
  dshHome: string
  profilesRoot: string
  profile: string
  patchPath: string
  rulePath: string
}

export function resolveDshPaths(
  dshHome: string,
  env: NodeJS.ProcessEnv,
  exists: (filePath: string) => boolean
): DshPaths {
  const profilesRoot = join(dshHome, 'profiles')
  const requested = env['DSH_PROFILE']?.trim()
  let profile = requested !== undefined && requested.length > 0 ? requested : 'desktop'
  if (!exists(join(profilesRoot, profile))) {
    const first = firstProfile(profilesRoot)
    if (first !== undefined) profile = first
  }
  return {
    dshHome,
    profilesRoot,
    profile,
    patchPath: join(profilesRoot, profile, 'cordis.patch.yml'),
    rulePath: join(dshHome, 'AGENTS.md')
  }
}

function firstProfile(profilesRoot: string): string | undefined {
  try {
    const entry = readdirSync(profilesRoot, { withFileTypes: true }).find((item) =>
      item.isDirectory()
    )
    return entry?.name
  } catch {
    return undefined
  }
}

export function buildDshMcpBlock(runtime: CliRuntime): string {
  const command = yamlDoubleQuote(toPosixPath(runtime.nodeExecutable))
  const entry = yamlDoubleQuote(toPosixPath(runtime.mcpEntry))
  return [
    MCP_MARKERS.begin,
    '# Cortex 2.0：纯 stdio MCP，由 DSH 直接拉起（无端口、无桥接）。',
    '- insert:',
    '    - id: mcp-cortex',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: cortex',
    '        transport: stdio',
    `        command: "${command}"`,
    '        args:',
    `          - "${entry}"`,
    '        toolCallTimeoutMs: 120000',
    '        reconnect:',
    '          enabled: true',
    '          initialDelayMs: 500',
    '          maxDelayMs: 30000',
    '          maxAttempts: 60',
    MCP_MARKERS.end
  ].join('\n')
}

function yamlDoubleQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export interface DshPlanOptions {
  dshHome: string
  env: NodeJS.ProcessEnv
  runtime: CliRuntime
  exists: (filePath: string) => boolean
  readFile: (filePath: string) => string
}

export function planDsh(options: DshPlanOptions): AgentPlan {
  const paths = resolveDshPaths(options.dshHome, options.env, options.exists)
  const files: FilePlan[] = []
  const warnings: string[] = []

  files.push(planDshMcp(paths.patchPath, options, warnings))
  files.push(
    planRuleFile({
      agent: 'dsh',
      path: paths.rulePath,
      exists: options.exists,
      readFile: options.readFile
    })
  )

  return { files, warnings }
}

function planDshMcp(patchPath: string, options: DshPlanOptions, warnings: string[]): FilePlan {
  const block = buildDshMcpBlock(options.runtime)
  const existed = options.exists(patchPath)
  const current = existed ? options.readFile(patchPath) : ''

  let candidate: string
  let diff: string
  let detail: string | undefined
  const oldBlock =
    extractMarkerBlock(current, MCP_MARKERS) ??
    extractMarkerBlock(current, LEGACY_MCP_MARKERS)
  const legacy =
    oldBlock === undefined && !hasIncompleteMarkerPair(current, MCP_MARKERS, LEGACY_MCP_MARKERS)
      ? findLegacyEntry(current)
      : null

  if (oldBlock !== undefined) {
    candidate = upsertMarkerBlock(current, block, MCP_MARKERS, {
      legacyMarkers: LEGACY_MCP_MARKERS
    }).content
    diff = diffBlockText(oldBlock, block)
  } else if (legacy !== null) {
    candidate = replaceLegacyEntry(current, legacy, block)
    diff = diffBlockText(legacy.block, block)
    detail = '已将未带标记的旧 MCP 条目替换为 Cortex stdio 条目'
  } else {
    candidate = upsertMarkerBlock(current, block, MCP_MARKERS, {
      legacyMarkers: LEGACY_MCP_MARKERS
    }).content
    diff = diffBlockText(undefined, block)
  }

  warnings.push(...validateCordisYaml(candidate, patchPath))

  if (existed && candidate === current) {
    return { agent: 'dsh', kind: 'mcp', path: patchPath, status: 'skipped', detail: '内容已最新' }
  }
  return {
    agent: 'dsh',
    kind: 'mcp',
    path: patchPath,
    status: existed ? 'updated' : 'created',
    detail,
    diff,
    content: candidate
  }
}

interface LegacyEntry {
  start: number
  end: number
  block: string
}

/**
 * Locate an unmarked `- id: mcp-cortex` / `- id: mcp-pentest-data-hub` entry.
 * The region runs until the next line indented at or below the entry (or EOF),
 * i.e. exactly the entry's own nested `name:` / `config:` lines.
 */
function findLegacyEntry(content: string): LegacyEntry | null {
  const lines = content.split('\n')
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!/^\s*-\s+id:\s*(?:mcp-cortex|mcp-pentest-data-hub)\s*$/.test(line)) {
      offset += line.length + 1
      continue
    }

    const indent = leadingSpaces(line)
    let endLine = lines.length
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next] ?? ''
      if (candidate.trim().length === 0 || leadingSpaces(candidate) <= indent) {
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

function leadingSpaces(line: string): number {
  return (line.match(/^[ \t]*/) ?? [''])[0].length
}

/** Replace the legacy entry with our top-level marker block. */
function replaceLegacyEntry(content: string, legacy: LegacyEntry, block: string): string {
  const before = content.slice(0, legacy.start)
  const restStart = content[legacy.end] === '\n' ? legacy.end + 1 : legacy.end
  const after = content.slice(restStart)
  const prefix = before.length === 0 ? '' : before.endsWith('\n') ? before : `${before}\n`
  return `${prefix}${block}\n${after}`
}

/**
 * `parse()` the whole candidate so a broken file is never written.
 *
 * Cordis patches may use `!!js` expressions; the `yaml` package reports those
 * as unresolved-tag warnings (or, depending on version and options, throws).
 * That is expected in DSH configs and downgraded to a warning; any other parse
 * error aborts the file.
 */
export function validateCordisYaml(content: string, filePath: string): string[] {
  try {
    parseYaml(content)
    return []
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unresolved tag|!!js/i.test(message)) {
      return [`${filePath} 含 !!js 表达式，已跳过严格 YAML 校验`]
    }
    throw new CliError(
      `无法写入 ${filePath}：YAML 校验失败（${message.split('\n')[0] ?? message}）`,
      1
    )
  }
}
