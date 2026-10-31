import { CliError } from '../errors'

/**
 * Marker constants and marker-block editing primitives.
 *
 * Every file that `ctx init` owns is delimited by a begin/end marker pair, so a
 * re-run replaces exactly that block and never touches the user's surrounding
 * config. The current strings use the Cortex naming (`CORTEX`); the pre-rename
 * `PENTEST` pairs are kept as *legacy* markers. When a file still carries a
 * legacy pair, the block is upgraded in place (same position, new markers)
 * instead of being appended again, so already-onboarded machines never end up
 * with two managed blocks.
 */

/** Markdown/YAML/TOML comment block around the MCP server registration. */
export const MCP_BLOCK_BEGIN =
  '# ── CORTEX BEGIN ──────────────────────────────────────────────'
export const MCP_BLOCK_END =
  '# ── CORTEX END ────────────────────────────────────────────────'

/** HTML comments around the vulnerability-enforcement rule block. */
export const RULE_BLOCK_BEGIN = '<!-- CORTEX BEGIN -->'
export const RULE_BLOCK_END = '<!-- CORTEX END -->'

/** HTML comments around the asset-context enforcement rule block. */
export const ASSET_BLOCK_BEGIN = '<!-- CORTEX-ASSET BEGIN -->'
export const ASSET_BLOCK_END = '<!-- CORTEX-ASSET END -->'

export interface MarkerPair {
  readonly begin: string
  readonly end: string
}

export const MCP_MARKERS: MarkerPair = { begin: MCP_BLOCK_BEGIN, end: MCP_BLOCK_END }
export const RULE_MARKERS: MarkerPair = { begin: RULE_BLOCK_BEGIN, end: RULE_BLOCK_END }
export const ASSET_MARKERS: MarkerPair = { begin: ASSET_BLOCK_BEGIN, end: ASSET_BLOCK_END }

/**
 * Pre-rename pairs written by earlier releases and by
 * `scripts/install-agent.mjs`. They are only read, never written.
 */
export const LEGACY_MCP_MARKERS: MarkerPair = {
  begin: '# ── PENTEST-DATA-HUB BEGIN ────────────────────────────────────',
  end: '# ── PENTEST-DATA-HUB END ──────────────────────────────────────'
}
export const LEGACY_RULE_MARKERS: MarkerPair = {
  begin: '<!-- PENTEST-DATA-HUB BEGIN -->',
  end: '<!-- PENTEST-DATA-HUB END -->'
}
export const LEGACY_ASSET_MARKERS: MarkerPair = {
  begin: '<!-- PENTEST-ASSET BEGIN -->',
  end: '<!-- PENTEST-ASSET END -->'
}

/** True when both markers exist and are ordered begin → end. */
export function hasMarkerPair(content: string, markers: MarkerPair): boolean {
  return findMarkerRange(content, markers) !== null
}

/**
 * True when the content carries exactly one half of any of the given pairs
 * (current or legacy). Such a file is corrupted and must not be treated as
 * "no managed block": appending would duplicate it.
 */
export function hasIncompleteMarkerPair(
  content: string,
  ...pairs: readonly MarkerPair[]
): boolean {
  return pairs.some((pair) => content.includes(pair.begin) !== content.includes(pair.end))
}

export interface MarkerRange {
  /** Index of the first character of the begin marker. */
  start: number
  /** Index right after the last character of the end marker. */
  end: number
}

export function findMarkerRange(content: string, markers: MarkerPair): MarkerRange | null {
  const start = content.indexOf(markers.begin)
  if (start === -1) return null
  const finish = content.indexOf(markers.end, start + markers.begin.length)
  if (finish === -1) return null
  return { start, end: finish + markers.end.length }
}

/** Current marker-managed block, including its markers (undefined when absent). */
export function extractMarkerBlock(content: string, markers: MarkerPair): string | undefined {
  const range = findMarkerRange(content, markers)
  return range === null ? undefined : content.slice(range.start, range.end)
}

export interface MarkerReplaceResult {
  content: string
  /** The block that was replaced, markers included. */
  oldBlock: string
}

/** Replace the marker-managed block in place; `null` when no full pair exists. */
export function replaceMarkerBlock(
  content: string,
  block: string,
  markers: MarkerPair
): MarkerReplaceResult | null {
  const range = findMarkerRange(content, markers)
  if (range === null) return null
  return {
    content: `${content.slice(0, range.start)}${normalizeBlock(block)}${content.slice(range.end)}`,
    oldBlock: content.slice(range.start, range.end)
  }
}

/** Append a block at the end of the file, separated by one blank line. */
export function appendMarkerBlock(content: string, block: string): string {
  const base = content.replace(/\s+$/u, '')
  return `${base}${base.length > 0 ? '\n\n' : ''}${normalizeBlock(block)}\n`
}

export interface MarkerUpsertResult {
  content: string
  /** False when the file already held exactly this block. */
  changed: boolean
  /** The replaced block (undefined when the block was appended). */
  oldBlock?: string
}

export interface UpsertMarkerBlockOptions {
  /**
   * Pre-rename pair. A full legacy block is rewritten in place with the new
   * markers, which is how an existing install upgrades instead of growing a
   * second managed block.
   */
  legacyMarkers?: MarkerPair
}

/**
 * Replace an existing marker block, otherwise append it.
 *
 * Lookup order: current markers first, then the optional legacy pair (upgraded
 * in place). A file containing only one half of any pair is corrupted:
 * appending would leave two blocks and editing blindly would consume user
 * content, so the function fails explicitly instead of writing a half-broken
 * file.
 */
export function upsertMarkerBlock(
  content: string,
  block: string,
  markers: MarkerPair,
  options: UpsertMarkerBlockOptions = {}
): MarkerUpsertResult {
  const replaced = replaceMarkerBlock(content, block, markers)
  if (replaced !== null) {
    return {
      content: replaced.content,
      changed: replaced.content !== content,
      oldBlock: replaced.oldBlock
    }
  }

  const legacyMarkers = options.legacyMarkers
  if (legacyMarkers !== undefined) {
    const upgraded = replaceMarkerBlock(content, block, legacyMarkers)
    if (upgraded !== null) {
      return {
        content: upgraded.content,
        changed: upgraded.content !== content,
        oldBlock: upgraded.oldBlock
      }
    }
  }

  const pairs = legacyMarkers === undefined ? [markers] : [markers, legacyMarkers]
  for (const pair of pairs) {
    if (content.includes(pair.begin) || content.includes(pair.end)) {
      throw new CliError(
        `检测到不完整的 Cortex 标记块（${pair.begin}），请先手动修复该文件后重试`,
        1
      )
    }
  }
  const next = appendMarkerBlock(content, block)
  return { content: next, changed: next !== content }
}

function normalizeBlock(block: string): string {
  return block.trim()
}

/**
 * `-` / `+` lines for a marker-block replacement. Appended blocks (no previous
 * content) render as all `+` lines. Returns `[]` when the content is identical.
 */
export function blockDiffLines(before: string | undefined, after: string | undefined): string[] {
  const oldLines = toLines(before)
  const newLines = toLines(after)
  const identical =
    oldLines.length === newLines.length && oldLines.every((line, index) => line === newLines[index])
  if (identical) return []
  return [...oldLines.map((line) => `- ${line}`), ...newLines.map((line) => `+ ${line}`)]
}

/**
 * Compact diff preview: both sides are capped so one huge config cannot flood
 * the terminal. The caller stores the result on the action and prints it
 * verbatim.
 */
export function capDiffLines(lines: string[], maxLines = 80): string {
  if (lines.length === 0) return ''
  if (lines.length <= maxLines) return lines.join('\n')
  return [...lines.slice(0, maxLines), `…（diff 已截断，共 ${lines.length} 行）`].join('\n')
}

export function diffBlockText(
  before: string | undefined,
  after: string | undefined,
  maxLines = 80
): string {
  return capDiffLines(blockDiffLines(before, after), maxLines)
}

function toLines(text: string | undefined): string[] {
  if (text === undefined) return []
  const trimmed = text.replace(/\s+$/u, '')
  return trimmed.length === 0 ? [] : trimmed.split('\n')
}
