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
  findMarkerRange,
  hasIncompleteMarkerPair,
  upsertMarkerBlock
} from './markers'
import { planRuleFile } from './rules'

/**
 * DeepSeek Harness integration.
 *
 * DSH composes its plugin tree from several patch layers (docs: "The tree
 * composes over an empty root: each bundle's patch, then the profile's
 * `cordis.patch.yml`, then the home-level `$DSH_HOME/cordis.patch.yml`, then
 * `--patch` overlays"). The **home-level layer** is the DSH root directory's
 * user patch file, applies to every profile/boot (desktop, web, headless, sdk,
 * acp, custom) and survives DSH's native profile recovery, which renames the
 * per-profile patch away. Cortex therefore registers its stdio MCP server in
 * `$DSH_HOME/cordis.patch.yml` (`~/.dsh/cordis.patch.yml`).
 *
 * Older Cortex releases wrote the same marker-managed block into
 * `profiles/<profile>/cordis.patch.yml`. That layer is now only *read*: on the
 * next `ctx init`, the legacy block is stripped from every profile patch so DSH
 * does not see the same `serverName: cortex` twice (the home layer is applied
 * after the profile layer, and duplicate server names fail the load). The
 * marker comments let this cleanup touch only Cortex-owned lines.
 *
 * The block itself lives in an `insert:` list (a top-level `- id/name/config`
 * entry only overrides an existing loader entry).
 */

export interface DshPaths {
  dshHome: string
  /**
   * DSH home-level user patch layer (`$DSH_HOME/cordis.patch.yml`). Applies to
   * every profile and is not removed by DSH profile recovery.
   */
  homePatchPath: string
  profilesRoot: string
  /** Profile name DSH runs by default (used for legacy-layer diagnostics). */
  profile: string
  /**
   * Legacy per-profile patch layer (`profiles/<profile>/cordis.patch.yml`).
   * Read only: Cortex migrates its block from here to {@link homePatchPath}.
   */
  legacyPatchPath: string
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
    homePatchPath: join(dshHome, 'cordis.patch.yml'),
    profilesRoot,
    profile,
    legacyPatchPath: join(profilesRoot, profile, 'cordis.patch.yml'),
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
    '# 本块位于 DSH 根目录 patch 层（$DSH_HOME/cordis.patch.yml），对所有 profile 生效。',
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

  // Primary target: the DSH home/root patch layer, shared by every profile.
  files.push(planDshMcp(paths.homePatchPath, options, warnings))
  files.push(
    planRuleFile({
      agent: 'dsh',
      path: paths.rulePath,
      exists: options.exists,
      readFile: options.readFile
    })
  )
  // Migration: remove the pre-home-layer Cortex block from profile patches.
  files.push(...planLegacyProfileCleanup(paths, options))

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
    detail = '已更新 DSH 根目录 patch 层（$DSH_HOME/cordis.patch.yml，对所有 profile 生效）'
  } else if (legacy !== null) {
    candidate = dropEmptyInsertEntries(replaceLegacyEntry(current, legacy, block))
    diff = diffBlockText(legacy.block, block)
    detail = '已将未带标记的旧 MCP 条目替换为 Cortex stdio 条目（DSH 根目录 patch 层）'
  } else {
    candidate = upsertMarkerBlock(current, block, MCP_MARKERS, {
      legacyMarkers: LEGACY_MCP_MARKERS
    }).content
    diff = diffBlockText(undefined, block)
    detail = '写入 DSH 根目录 patch 层（$DSH_HOME/cordis.patch.yml，对所有 profile 生效）'
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

/**
 * Remove Cortex's legacy block from every profile patch layer under
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml`.
 *
 * The home layer outranks the profile layer, so leaving a second
 * `serverName: cortex` behind would make DSH fail the whole profile load with a
 * duplicate-server error. Only Cortex-owned marker blocks / the old unmarked
 * `- id: mcp-cortex` entry are removed; the rest of the user's patch stays.
 */
function planLegacyProfileCleanup(paths: DshPaths, options: DshPlanOptions): FilePlan[] {
  const plans: FilePlan[] = []
  for (const profile of listProfileDirectories(paths.profilesRoot)) {
    const patchPath = join(paths.profilesRoot, profile, 'cordis.patch.yml')
    if (!options.exists(patchPath)) continue
    const current = options.readFile(patchPath)
    const stripped = stripManagedCortexContent(current)
    if (stripped === null || stripped === current) continue
    plans.push({
      agent: 'dsh',
      kind: 'mcp',
      path: patchPath,
      status: 'updated',
      detail:
        '已从 per-profile patch 层移除旧 Cortex 注册（迁移到 DSH 根目录 cordis.patch.yml，避免 DSH 因重复 serverName 拒绝加载）',
      diff: diffBlockText(managedCortexBlock(current), undefined),
      content: stripped
    })
  }
  return plans
}

function listProfileDirectories(profilesRoot: string): string[] {
  try {
    return readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function managedCortexBlock(content: string): string | undefined {
  const block =
    extractMarkerBlock(content, MCP_MARKERS) ?? extractMarkerBlock(content, LEGACY_MCP_MARKERS)
  if (block !== undefined) return block
  const relaxed = findRelaxedMarkerRange(content)
  if (relaxed !== null) return content.slice(relaxed.start, relaxed.end)
  return findLegacyEntry(content)?.block
}

/**
 * Marker comments written by earlier Cortex releases used a different number of
 * trailing box-drawing dashes (63 vs the current 64 characters). The exact
 * constants therefore miss them, so the migration cleanup also recognizes the
 * comment by its stable prefix.
 */
const RELAXED_CORTEX_BEGIN = /^#\s*─+\s*CORTEX BEGIN\b/
const RELAXED_CORTEX_END = /^#\s*─+\s*CORTEX END\b/
const RELAXED_PENTEST_BEGIN = /^#\s*─+\s*PENTEST-DATA-HUB BEGIN\b/
const RELAXED_PENTEST_END = /^#\s*─+\s*PENTEST-DATA-HUB END\b/

function isAnyCortexMarkerLine(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed === MCP_MARKERS.begin ||
    trimmed === MCP_MARKERS.end ||
    trimmed === LEGACY_MCP_MARKERS.begin ||
    trimmed === LEGACY_MCP_MARKERS.end ||
    RELAXED_CORTEX_BEGIN.test(trimmed) ||
    RELAXED_CORTEX_END.test(trimmed) ||
    RELAXED_PENTEST_BEGIN.test(trimmed) ||
    RELAXED_PENTEST_END.test(trimmed)
  )
}

function isCortexBeginMarker(line: string): boolean {
  const trimmed = line.trim()
  return RELAXED_CORTEX_BEGIN.test(trimmed) || RELAXED_PENTEST_BEGIN.test(trimmed)
}

function isCortexEndMarker(line: string): boolean {
  const trimmed = line.trim()
  return RELAXED_CORTEX_END.test(trimmed) || RELAXED_PENTEST_END.test(trimmed)
}

/**
 * Locate a marker-delimited block whose marker comments were written by an
 * older Cortex build (any dash count). Returns absolute character offsets.
 */
function findRelaxedMarkerRange(content: string): { start: number; end: number } | null {
  const lines = content.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }

  const startIndex = lines.findIndex((line) => isCortexBeginMarker(line))
  if (startIndex === -1) return null
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (!isCortexEndMarker(lines[index] ?? '')) continue
    const start = offsets[startIndex] ?? 0
    const end = (offsets[index] ?? 0) + (lines[index] ?? '').length
    return { start, end }
  }
  return null
}

/**
 * Strip the Cortex-owned MCP registration from a profile patch layer.
 *
 * Returns `null` when the file holds nothing Cortex-owned (so `ctx init` leaves
 * it untouched). A file that becomes empty is replaced by `[]` because DSH
 * rejects an empty or comments-only patch layer at boot. Backslashes in the
 * file are preserved verbatim — this is a line-level removal, not a YAML
 * re-serialization.
 */
export function stripManagedCortexContent(content: string): string | null {
  let next = content
  let found = false

  // Prefer the relaxed (any dash count) range: an older block may wrap a newer
  // nested one, and the earliest BEGIN must own the whole migrated region.
  const range =
    findRelaxedMarkerRange(next) ??
    findMarkerRange(next, MCP_MARKERS) ??
    findMarkerRange(next, LEGACY_MCP_MARKERS)
  if (range !== null) {
    next = `${next.slice(0, range.start)}${next.slice(range.end)}`
    found = true
  } else {
    const legacyEntry = findLegacyEntry(next)
    if (legacyEntry !== null) {
      next = `${next.slice(0, legacyEntry.start)}${next.slice(legacyEntry.end)}`
      found = true
    }
  }
  if (!found) return null

  // Older builds could leave duplicated/spliced marker comments behind (for
  // example a second END after the managed block); marker lines are ours, so
  // drop every leftover one instead of letting it accumulate per run.
  next = next
    .split('\n')
    .filter((line) => !isAnyCortexMarkerLine(line))
    .join('\n')
  next = dropEmptyInsertEntries(next)
  next = next
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()

  if (next.length === 0) return '[]\n'
  return `${next}\n`
}

/**
 * Drop `- insert:` entries that only held Cortex comments after cleanup. The
 * marker block removal can leave a parent list entry with no children; YAML
 * would parse it as `insert: null`, which is not a useful patch entry.
 */
function dropEmptyInsertEntries(content: string): string {
  const lines = content.split('\n')
  const kept: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!/^-\s+insert:\s*$/.test(line)) {
      kept.push(line)
      index += 1
      continue
    }
    let cursor = index + 1
    let hasChild = false
    while (cursor < lines.length) {
      const candidate = lines[cursor] ?? ''
      const trimmed = candidate.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        cursor += 1
        continue
      }
      // A line at column 0 starts the next top-level entry (or document end).
      hasChild = !/^\S/.test(candidate)
      break
    }
    if (hasChild) {
      kept.push(line)
      index = cursor
    } else {
      // Keep comment lines that lived inside the dropped entry (a nested marker
      // block may have put its BEGIN/header comments there).
      for (let skipped = index + 1; skipped < cursor; skipped += 1) {
        const candidate = lines[skipped] ?? ''
        if (candidate.trim().startsWith('#')) kept.push(candidate)
      }
      index = cursor
    }
  }
  return kept.join('\n')
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
  let start = legacy.start
  let end = legacy.end
  // The old entry usually sits inside a `- insert:` list written by an older
  // Cortex release. Our marker block carries its own `insert:`, so swallow the
  // now-childless parent line as well; leaving it behind yields `insert: null`.
  const beforeCandidate = content.slice(0, start)
  const parentLineStart = beforeCandidate.lastIndexOf('\n') + 1
  const parentLine = beforeCandidate.slice(parentLineStart).trimEnd()
  if (/^-\s+insert:\s*$/.test(parentLine) && !hasInsertSibling(content, end)) {
    start = parentLineStart
  }
  const before = content.slice(0, start)
  const restStart = content[end] === '\n' ? end + 1 : end
  const after = content.slice(restStart)
  const prefix = before.length === 0 ? '' : before.endsWith('\n') ? before : `${before}\n`
  return `${prefix}${block}\n${after}`
}

/** Whether an `insert:` list has another child entry after `end`. */
function hasInsertSibling(content: string, end: number): boolean {
  const rest = content.slice(end)
  for (const line of rest.split('\n')) {
    if (line.trim().length === 0) continue
    return /^\s+-\s/.test(line)
  }
  return false
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
