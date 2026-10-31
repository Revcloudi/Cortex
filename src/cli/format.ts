/**
 * Human-readable output helpers for `ctx`: ANSI colors, simple tables and JSON
 * printing.
 *
 * There is no table dependency: the CLI only needs padded columns, and staying
 * dependency-free keeps the future bundled runtime small. Commands with `--json`
 * bypass these helpers and call `printJson`.
 */

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m'
} as const

export interface ColorOptions {
  /** Disable colors (piped output, `NO_COLOR`, `--json`). */
  enabled?: boolean
}

function paint(text: string, code: string, options: ColorOptions = {}): string {
  if (options.enabled === false) return text
  return `${code}${text}${ANSI.reset}`
}

export const color = {
  bold: (text: string, options?: ColorOptions): string => paint(text, ANSI.bold, options),
  dim: (text: string, options?: ColorOptions): string => paint(text, ANSI.dim, options),
  red: (text: string, options?: ColorOptions): string => paint(text, ANSI.red, options),
  green: (text: string, options?: ColorOptions): string => paint(text, ANSI.green, options),
  yellow: (text: string, options?: ColorOptions): string => paint(text, ANSI.yellow, options),
  blue: (text: string, options?: ColorOptions): string => paint(text, ANSI.blue, options),
  cyan: (text: string, options?: ColorOptions): string => paint(text, ANSI.cyan, options)
}

/** Colors are on only for an interactive terminal without `NO_COLOR`. */
export function shouldUseColor(json: boolean, stream: NodeJS.WriteStream = process.stdout): boolean {
  if (json) return false
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false
  return stream.isTTY === true
}

export function printJson(value: unknown, write: (text: string) => void = console.log): void {
  write(JSON.stringify(value, null, 2))
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

/** Display width used for column padding, counting CJK characters as width 2. */
function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    width += codePoint >= 0x1100 && codePoint <= 0x115f ? 2 : codePoint >= 0x2e80 ? 2 : 1
  }
  return width
}

function padCell(text: string, width: number): string {
  const missing = width - displayWidth(text)
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text
}

export interface TableColumn {
  title: string
  /** Hard cap for one cell; longer values are ellipsized. */
  maxWidth?: number
}

/**
 * Left-aligned ASCII table. The caller stringifies values so each command keeps
 * full control over formatting (IDs stay monospaced, severities get colored
 * labels, and so on).
 */
export function renderTable(columns: TableColumn[], rows: string[][]): string {
  if (rows.length === 0) return ''
  const widths = columns.map((column, index) => {
    const maxWidth = column.maxWidth ?? 40
    const cells = rows.map((row) => truncate(row[index] ?? '', maxWidth))
    return Math.min(maxWidth, Math.max(displayWidth(column.title), ...cells.map(displayWidth)))
  })

  const header = columns.map((column, index) => padCell(column.title, widths[index] ?? 0)).join('  ')
  const separator = widths.map((width) => '-'.repeat(width)).join('  ')
  const body = rows.map((row) =>
    columns.map((_, index) => padCell(truncate(row[index] ?? '', columns[index]?.maxWidth ?? 40), widths[index] ?? 0)).join('  ')
  )
  return [header, separator, ...body].join('\n')
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function formatLocalTime(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function statusMark(ok: boolean, options: ColorOptions = {}): string {
  return ok ? color.green('✓', options) : color.red('✗', options)
}

/** Indented bullet list used by doctor / status sections. */
export function bullet(text: string, indent = 2): string {
  return `${' '.repeat(indent)}- ${text}`
}
