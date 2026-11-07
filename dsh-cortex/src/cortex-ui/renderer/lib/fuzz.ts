/**
 * Pure helpers for the retest Fuzzer.
 *
 * Everything here is network-free and framework-free so the marker/count rules
 * can be unit-tested and must stay byte-for-byte compatible with the Host's
 * `repeater-fuzz.js` case expansion:
 *   sniper        = positions * set1.length
 *   battering_ram = set1.length
 *   pitchfork     = min(set lengths), needs >= positions sets
 *   cluster_bomb  = product of set lengths, needs >= positions sets
 */
import { resolveRepeaterUrl } from './retestRequest'

/** Inline injection-point marker. A position is the text between two markers. */
export const FUZZ_MARKER = '\u00a7'

export const FUZZ_MODES = ['sniper', 'battering_ram', 'pitchfork', 'cluster_bomb'] as const
export type FuzzMode = (typeof FUZZ_MODES)[number]

export const FUZZ_JOB_STATUSES = ['running', 'completed', 'cancelled', 'interrupted', 'failed'] as const
export type FuzzJobStatus = (typeof FUZZ_JOB_STATUSES)[number]

export const MAX_FUZZ_CASES = 2000
export const MAX_FUZZ_POSITIONS = 100
export const MIN_FUZZ_CONCURRENCY = 1
export const MAX_FUZZ_CONCURRENCY = 10
export const MIN_FUZZ_DELAY_MS = 0
export const MAX_FUZZ_DELAY_MS = 2000
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
export const MAX_TEMPLATE_BODY_BYTES = 256 * 1024
export const MAX_TEMPLATE_URL_LENGTH = 8000
export const MAX_TEMPLATE_HEADERS = 100
/** Stored response bodies are capped by the Host at 256 KiB. */
export const MAX_RESULT_BODY_BYTES = 256 * 1024

/* -------------------------------------------------------------------------- */
/* Markers                                                                     */
/* -------------------------------------------------------------------------- */

export interface MarkerScan {
  /** Number of complete `§...§` pairs. */
  pairs: number
  /** Total markdown marker characters (always 2 * pairs when balanced). */
  markerChars: number
  /** True when a marker has no partner; submit must be rejected. */
  open: boolean
}

export function scanMarkers(text: string): MarkerScan {
  const markerChars = text.split(FUZZ_MARKER).length - 1
  const pairs = Math.floor(markerChars / 2)
  return { pairs, markerChars, open: markerChars % 2 === 1 }
}

export type MarkSelectionResult =
  | { ok: true; text: string; selectionStart: number; selectionEnd: number }
  | { ok: false; reason: 'empty_selection' }

/**
 * Wrap `[start, end)` from the raw editor in a marker pair. An empty/absent
 * selection is rejected so the toolbar can show an inline hint instead of
 * silently inserting two adjacent markers.
 */
export function markSelection(text: string, start: number, end: number): MarkSelectionResult {
  const length = text.length
  const from = Math.max(0, Math.min(Math.trunc(start), length))
  const to = Math.max(0, Math.min(Math.trunc(end), length))
  if (to <= from) return { ok: false, reason: 'empty_selection' }
  const selected = text.slice(from, to)
  const next = `${text.slice(0, from)}${FUZZ_MARKER}${selected}${FUZZ_MARKER}${text.slice(to)}`
  const caret = from + selected.length + 2
  return { ok: true, text: next, selectionStart: caret, selectionEnd: caret }
}

/** Remove every marker character from the raw editor. */
export function clearMarkers(text: string): string {
  return text.split(FUZZ_MARKER).join('')
}

/* -------------------------------------------------------------------------- */
/* Payload sets                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Payload editor lines: one payload per line, CRLF tolerated, a single trailing
 * newline is ignored. Interior blank lines are kept as empty payloads so a
 * "remove the value" case can be expressed explicitly.
 */
export function parsePayloadLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Number of payload sets the attack mode consumes. */
export function usedPayloadSetCount(mode: FuzzMode, positions: number): number {
  if (mode === 'sniper' || mode === 'battering_ram') return 1
  return Math.max(1, positions)
}

/** Payload sets to submit: sniper/battering ram only use the first set. */
export function usedPayloadSets(mode: FuzzMode, payloadSets: string[][]): string[][] {
  const count = usedPayloadSetCount(mode, payloadSets.length)
  return payloadSets.slice(0, count)
}

export type ExpectedCasesError =
  | 'no_markers'
  | 'unclosed_markers'
  | 'too_many_positions'
  | 'empty_payload_set'
  | 'not_enough_sets'
  | 'too_many_cases'

export interface ExpectedCases {
  positions: number
  total: number
  usedSets: number
  ok: boolean
  error: ExpectedCasesError | null
}

function failedCases(
  error: ExpectedCasesError,
  positions: number,
  usedSets: number,
  total = 0
): ExpectedCases {
  return { positions, total, usedSets, ok: false, error }
}

/**
 * Client-side mirror of the Host case expansion. `payloadSets` are the parsed
 * arrays in marker order (set 1 belongs to position 1).
 */
export function expectedCaseCount(
  mode: FuzzMode,
  positions: number,
  payloadSets: string[][]
): ExpectedCases {
  const usedSets = usedPayloadSetCount(mode, positions)
  if (positions < 1) return failedCases('no_markers', positions, usedSets)
  if (positions > MAX_FUZZ_POSITIONS) return failedCases('too_many_positions', positions, usedSets)

  if (mode === 'pitchfork' || mode === 'cluster_bomb') {
    if (payloadSets.length < positions) return failedCases('not_enough_sets', positions, usedSets)
    for (let index = 0; index < positions; index += 1) {
      if ((payloadSets[index] ?? []).length === 0) {
        return failedCases('empty_payload_set', positions, usedSets)
      }
    }
  } else if ((payloadSets[0] ?? []).length === 0) {
    return failedCases('empty_payload_set', positions, usedSets)
  }

  let total = 0
  if (mode === 'sniper') {
    total = positions * (payloadSets[0]?.length ?? 0)
  } else if (mode === 'battering_ram') {
    total = payloadSets[0]?.length ?? 0
  } else if (mode === 'pitchfork') {
    total = Math.min(...payloadSets.slice(0, positions).map((set) => set.length))
  } else {
    total = 1
    for (const set of payloadSets.slice(0, positions)) total *= set.length
    if (!Number.isSafeInteger(total)) total = Number.MAX_SAFE_INTEGER
  }

  if (total < 1) return failedCases('empty_payload_set', positions, usedSets)
  if (total > MAX_FUZZ_CASES) return failedCases('too_many_cases', positions, usedSets, total)
  return { positions, total, usedSets, ok: true, error: null }
}

/** UTF-8 byte length without relying on TextEncoder being present. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** Total UTF-8 payload bytes across the given sets. */
export function payloadBytes(payloadSets: string[][]): number {
  let bytes = 0
  for (const set of payloadSets) {
    for (const payload of set) bytes += utf8ByteLength(payload)
  }
  return bytes
}

export interface PayloadPreset {
  id: string
  labelKey: string
  payloads: readonly string[]
}

/**
 * Built-in payload presets. Values are data (never localised), labels live in
 * `fuzzer.preset.*` i18n keys.
 */
export const PAYLOAD_PRESETS: readonly PayloadPreset[] = [
  {
    id: 'numeric',
    labelKey: 'fuzzer.preset.numeric',
    payloads: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
  },
  {
    id: 'xss',
    labelKey: 'fuzzer.preset.xss',
    payloads: [
      '<script>alert(1)</script>',
      '"><svg onload=alert(1)>',
      "'><img src=x onerror=alert(1)>",
      'javascript:alert(1)'
    ]
  },
  {
    id: 'sqli',
    labelKey: 'fuzzer.preset.sqli',
    payloads: ["'", "' OR '1'='1", "1' AND SLEEP(3)-- -", '1 UNION SELECT NULL-- -']
  },
  {
    id: 'traversal',
    labelKey: 'fuzzer.preset.traversal',
    payloads: ['../../../../etc/passwd', '..\\..\\..\\..\\windows\\win.ini', '%2e%2e%2f%2e%2e%2fetc%2fpasswd']
  },
  {
    id: 'command',
    labelKey: 'fuzzer.preset.command',
    payloads: [';id', '|id', '$(id)', '`id`', '&&id']
  }
]

/** Newline-joined preset text for the payload textareas, null for unknown ids. */
export function presetPayloadText(id: string): string | null {
  const preset = PAYLOAD_PRESETS.find((entry) => entry.id === id)
  return preset === undefined ? null : preset.payloads.join('\n')
}

/* -------------------------------------------------------------------------- */
/* Request helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The marker token must survive relative-URL resolution: `new URL()` would
 * percent-encode a literal `§` and the Host would then see zero positions.
 */
const URL_MARKER_TOKEN = '__CORTEX_FUZZ_MARKER__'

/** Resolve the raw request target while preserving `§` marker characters. */
export function resolveFuzzUrl(rawUrl: string, targetUrl: string): string {
  const guarded = rawUrl.split(FUZZ_MARKER).join(URL_MARKER_TOKEN)
  return resolveRepeaterUrl(guarded, targetUrl).split(URL_MARKER_TOKEN).join(FUZZ_MARKER)
}

/** Target origin for the confirmation dialog (absolute request URL first). */
export function fuzzTargetOrigin(targetUrl: string, requestUrl: string): string {
  if (/^https?:\/\//i.test(requestUrl.trim())) {
    try {
      return new URL(requestUrl.trim()).origin
    } catch {
      /* fall back to the finding target */
    }
  }
  try {
    return new URL(targetUrl).origin
  } catch {
    return targetUrl
  }
}

/* -------------------------------------------------------------------------- */
/* Results table helpers                                                       */
/* -------------------------------------------------------------------------- */

export type FuzzSortKey = 'status' | 'length' | 'duration'
export type FuzzSortDir = 'asc' | 'desc'

export interface FuzzSortState {
  key: FuzzSortKey
  dir: FuzzSortDir
}

export type FuzzStatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'error'

/** Minimal summary shape accepted by the table helpers (Host summary is a superset). */
export interface FuzzResultLike {
  index?: number
  payloadBrief?: string
  status: number | null
  length: number | null
  durationMs: number | null
  error: string | null
}

const DEFAULT_SORT_DIR: Record<FuzzSortKey, FuzzSortDir> = {
  status: 'asc',
  length: 'desc',
  duration: 'desc'
}

/** Click on a sortable header: same key flips direction, a new key uses its default. */
export function toggleFuzzSort(current: FuzzSortState, key: FuzzSortKey): FuzzSortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: DEFAULT_SORT_DIR[key] }
}

function sortValue(result: FuzzResultLike, key: FuzzSortKey): number {
  if (key === 'status') return result.status ?? -1
  if (key === 'length') return result.length ?? -1
  return result.durationMs ?? -1
}

/** Stable client-side sort over the loaded result page (null values last). */
export function sortFuzzResults<T extends FuzzResultLike>(
  results: readonly T[],
  sort: FuzzSortState
): T[] {
  const factor = sort.dir === 'asc' ? 1 : -1
  return results
    .map((result, index) => ({ result, index }))
    .sort((left, right) => {
      const a = sortValue(left.result, sort.key)
      const b = sortValue(right.result, sort.key)
      if (a < 0 && b >= 0) return 1
      if (b < 0 && a >= 0) return -1
      if (a === b) return left.index - right.index
      return (a - b) * factor
    })
    .map((entry) => entry.result)
}

export function matchesStatusFilter(result: FuzzResultLike, filter: FuzzStatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'error') return result.error !== null || result.status === null
  if (result.status === null) return false
  if (filter === '2xx') return result.status >= 200 && result.status < 300
  if (filter === '3xx') return result.status >= 300 && result.status < 400
  if (filter === '4xx') return result.status >= 400 && result.status < 500
  return result.status >= 500
}

/** Error / status deviation from the baseline (length changes have their own toggle). */
export function isResultAnomaly(result: FuzzResultLike, baseline: FuzzResultLike | null): boolean {
  if (result.error !== null || result.status === null) return true
  if (baseline === null) return result.status >= 500
  return result.status !== baseline.status
}

/** True when a result's body length differs from the baseline. */
export function isLengthChanged(result: FuzzResultLike, baseline: FuzzResultLike | null): boolean {
  if (baseline === null) return false
  if (result.length === null || baseline.length === null) return false
  return result.length !== baseline.length
}

export interface FuzzResultFilterOptions {
  status: FuzzStatusFilter
  onlyAnomaly: boolean
  onlyLengthChange: boolean
  baseline: FuzzResultLike | null
}

export function filterFuzzResults<T extends FuzzResultLike>(
  results: readonly T[],
  options: FuzzResultFilterOptions
): T[] {
  return results.filter((result) => {
    if (!matchesStatusFilter(result, options.status)) return false
    if (options.onlyAnomaly && !isResultAnomaly(result, options.baseline)) return false
    if (options.onlyLengthChange && !isLengthChanged(result, options.baseline)) return false
    return true
  })
}

export type DeltaDirection = 'up' | 'down' | 'same'

export interface DeltaInfo {
  direction: DeltaDirection
  /** Localized-free display text, e.g. `+12`, `-3`, `+25%`. */
  text: string
  /** Signed percent against the baseline, null when the baseline is zero/absent. */
  percent: number | null
}

/** Length/duration delta against the baseline for the relative-change column. */
export function relativeDelta(
  current: number | null | undefined,
  baseline: number | null | undefined
): DeltaInfo {
  if (typeof current !== 'number' || typeof baseline !== 'number') {
    return { direction: 'same', text: '', percent: null }
  }
  const diff = current - baseline
  if (diff === 0) return { direction: 'same', text: '0', percent: 0 }
  const percent = baseline === 0 ? null : Math.round((diff / baseline) * 100)
  const sign = diff > 0 ? '+' : ''
  return {
    direction: diff > 0 ? 'up' : 'down',
    text: percent === null ? `${sign}${diff}` : `${sign}${percent}%`,
    percent
  }
}

/** Clamp an integer option to the Host range; NaN falls back to `fallback`. */
export function clampInt(value: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** `2026-11-07T12:34:56.000Z` -> `2026-11-07 12:34:56` without locale drift. */
export function formatJobTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return ''
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso.replace('T', ' ').replace(/\.\d+Z$/, '')
  const pad = (value: number): string => String(value).padStart(2, '0')
  const year = parsed.getFullYear()
  const month = pad(parsed.getMonth() + 1)
  const day = pad(parsed.getDate())
  const hours = pad(parsed.getHours())
  const minutes = pad(parsed.getMinutes())
  const seconds = pad(parsed.getSeconds())
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

/** Compact byte count for result rows (`1.2 KB` / `512 B`). */
export function formatByteSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}
