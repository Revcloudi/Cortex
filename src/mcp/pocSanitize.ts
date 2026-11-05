import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { HubLogger } from '../core/logging'

/**
 * Runtime backstop for the MCP "no PoC data" invariant (design doc §11.5.3).
 *
 * The type layer (`viewTypes.ts`), the explicit SQL column lists and the fact
 * that MCP tools never query `poc_artifacts` / `poc_runs` are the primary
 * boundaries. This sanitizer is defense in depth: if a future query/join/helper
 * ever leaks a PoC field, the value is removed before it reaches the agent.
 *
 * Keys are matched case-insensitively and removed from nested objects/arrays.
 * For `text` content that carries JSON, the JSON is parsed, stripped and
 * re-serialized so handlers that JSON.stringify their own payload are covered
 * even if they bypass this helper.
 */
export const FORBIDDEN_MCP_KEY_PATTERN =
  /^(poc_|poc$|js_code$|ui_schema$|ui_schema_json$|code_hash$|poc_artifact|poc_run)/i

export interface SanitizeStats {
  removed: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursively remove forbidden keys. Returns the same instance when nothing was
 * removed so callers can cheaply detect changes (`===`).
 */
export function stripPocFields(value: unknown, stats: SanitizeStats = { removed: 0 }): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const stripped = stripPocFields(item, stats)
      if (stripped !== item) changed = true
      return stripped
    })
    return changed ? next : value
  }
  if (!isPlainObject(value)) return value
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_MCP_KEY_PATTERN.test(key)) {
      stats.removed += 1
      changed = true
      continue
    }
    const stripped = stripPocFields(child, stats)
    if (stripped !== child) changed = true
    next[key] = stripped
  }
  return changed ? next : value
}

function sanitizeTextPayload(text: string, stats: SanitizeStats): string {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return text
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const stripped = stripPocFields(parsed, stats)
    if (stripped === parsed) return text
    return JSON.stringify(stripped)
  } catch {
    // Not JSON: leave human-readable text untouched (descriptions may mention
    // words like "js_code" legitimately; only structured payloads are stripped).
    return text
  }
}

/**
 * Sanitize one MCP tool result right before it is returned to the agent.
 * Logs only the number of removed keys — never their values.
 */
export function sanitizeMcpResult(result: CallToolResult, logger?: HubLogger): CallToolResult {
  const stats: SanitizeStats = { removed: 0 }
  const content = result.content.map((item) => {
    if (item.type !== 'text') return item
    const text = sanitizeTextPayload(item.text, stats)
    return text === item.text ? item : { ...item, text }
  })
  if (stats.removed > 0) {
    logger?.warn(`[MCP] 已从工具结果中移除 ${stats.removed} 个 PoC 字段（MCP 隔离兜底触发）`)
  }
  const structured = stripPocFields(result.structuredContent, stats)
  return {
    ...result,
    content,
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: structured as CallToolResult['structuredContent'] })
  }
}

/** Test helper: true when a serialized payload contains a forbidden key. */
export function containsForbiddenPocKey(value: unknown): boolean {
  const stats: SanitizeStats = { removed: 0 }
  const stripped = stripPocFields(value, stats)
  return stripped !== value || stats.removed > 0
}
