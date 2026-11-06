import type { Severity, VulnStatus } from '@shared/types'

export interface SeverityStyle {
  /** Soft tinted badge: background + foreground + border. */
  badge: string
  /** Small functional dot inside badges / legends. */
  dot: string
  /** Table row spine (the severity-encoded signature detail). */
  spine: string
  /** Plain text tone for functional labels. */
  text: string
}

/**
 * Severity is functional colour, never brand colour: soft backgrounds with
 * darker text only. Keep full literal class strings so Tailwind can see them.
 */
export const SEVERITY_STYLES: Record<Severity, SeverityStyle> = {
  Critical: {
    badge: 'border-red-200/70 bg-red-50 text-red-700',
    dot: 'bg-red-500',
    spine: 'bg-red-400',
    text: 'text-red-700'
  },
  High: {
    badge: 'border-orange-200/70 bg-orange-50 text-orange-700',
    dot: 'bg-orange-500',
    spine: 'bg-orange-400',
    text: 'text-orange-700'
  },
  Medium: {
    badge: 'border-amber-200/70 bg-amber-50 text-amber-800',
    dot: 'bg-amber-500',
    spine: 'bg-amber-400',
    text: 'text-amber-800'
  },
  Low: {
    badge: 'border-sky-200/70 bg-sky-50 text-sky-700',
    dot: 'bg-sky-500',
    spine: 'bg-sky-400',
    text: 'text-sky-700'
  },
  Info: {
    badge: 'border-slate-200 bg-slate-50 text-slate-600',
    dot: 'bg-slate-400',
    spine: 'bg-slate-300',
    text: 'text-slate-600'
  }
}

export interface StatusStyle {
  badge: string
  dot: string
}

export const STATUS_STYLES: Record<VulnStatus, StatusStyle> = {
  Confirmed: {
    badge: 'border-border bg-background text-foreground',
    dot: 'bg-foreground'
  },
  Inconclusive: {
    badge: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground'
  },
  Retest_Passed: {
    badge: 'border-emerald-200/70 bg-emerald-50 text-emerald-700',
    dot: 'bg-emerald-500'
  }
}
