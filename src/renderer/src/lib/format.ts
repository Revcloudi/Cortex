/** Date / number formatting helpers shared across the renderer. */

import type { Translate } from './api'

const pad = (value: number): string => String(value).padStart(2, '0')

/** Human-readable timestamp used in tables: `10-27 14:32`. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Full timestamp used for audit-style fields: `2026-10-27 14:32:05`. */
export function formatDateTimeFull(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Clock only: `14:32:05`. */
export function formatClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** File sizes for the database card: `840 B` / `12.4 KB` / `3.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

/**
 * Human-readable localized uptime for the MCP server.
 *
 * The number stays locale-neutral; only the unit words come from i18n, so the
 * caller passes the active `t` (from `useI18n()`).
 */
export function formatUptime(
  startedAt: string | null,
  t: Translate,
  now: Date = new Date()
): string {
  if (!startedAt) return '—'
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return '—'
  const seconds = Math.max(0, Math.floor((now.getTime() - started) / 1000))
  if (seconds < 60) return t('ui.uptime.lessThanMinute')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} ${t('ui.uptime.minutes')}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hoursLabel = `${hours} ${t('ui.uptime.hours')}`
  return rest === 0 ? hoursLabel : `${hoursLabel} ${pad(rest)} ${t('ui.uptime.minutes')}`
}

/** Safe integer percentage for metric context lines. */
export function percentage(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 100)
}

/** Reports may omit a vuln_type; the schema stores the `Unclassified` sentinel. */
export function formatVulnType(vulnType: string, t?: Translate): string {
  if (vulnType !== 'Unclassified') return vulnType
  return t ? t('ui.vulnType.unclassified') : 'Unclassified'
}
