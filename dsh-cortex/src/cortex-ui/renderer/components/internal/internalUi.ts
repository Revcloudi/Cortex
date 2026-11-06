import type {
  ConfidenceLevel,
  CredentialTrialStatus,
  InternalHostState,
  InternalService,
  LootImportStatus,
  PivotStatus,
  VulnerabilityListItem
} from '@shared/types'
import { SEVERITY_RANK } from '@shared/types'

/**
 * Shared visual + sorting helpers for the internal operations views.
 *
 * Class strings are kept as full literals so Tailwind can see them; the only
 * dynamic part is the enum → record lookup.
 */

/** Dense table header cell, matching the vulnerability/asset tables. */
export const INTERNAL_TH =
  'sticky top-0 z-10 border-b border-border bg-background px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground'

/** Dense table body cell. */
export const INTERNAL_TD = 'border-b border-border px-3 py-1.5 align-middle'

export interface HostStateStyle {
  /** Chip (small host square / badge) classes. */
  chip: string
  /** Small functional dot. */
  dot: string
  /** Plain text tone for inline labels. */
  text: string
}

/**
 * Heatmap / host state colors from plan §8.1: compromised red, alive amber,
 * unknown slate, unreachable / firewalled gray. `unknown` is deliberately not
 * rendered as `alive`.
 */
export const HOST_STATE_STYLES: Record<InternalHostState, HostStateStyle> = {
  unknown: {
    chip: 'border-slate-200 bg-slate-50 text-slate-600',
    dot: 'bg-slate-400',
    text: 'text-slate-600'
  },
  alive: {
    chip: 'border-amber-200/70 bg-amber-50 text-amber-800',
    dot: 'bg-amber-500',
    text: 'text-amber-800'
  },
  compromised: {
    chip: 'border-red-200/70 bg-red-50 text-red-700',
    dot: 'bg-red-500',
    text: 'text-red-700'
  },
  unreachable: {
    chip: 'border-gray-200 bg-gray-50 text-gray-500',
    dot: 'bg-gray-400',
    text: 'text-gray-500'
  },
  firewalled: {
    chip: 'border-gray-200 bg-gray-50 text-gray-500',
    dot: 'bg-gray-400',
    text: 'text-gray-500'
  }
}

/** Legend order: risky states first, muted ones last. */
export const HOST_STATE_ORDER: readonly InternalHostState[] = [
  'compromised',
  'alive',
  'unknown',
  'unreachable',
  'firewalled'
]

export const CONFIDENCE_STYLES: Record<ConfidenceLevel, string> = {
  low: 'border-slate-200 bg-slate-50 text-slate-600',
  medium: 'border-amber-200/70 bg-amber-50 text-amber-800',
  high: 'border-emerald-200/70 bg-emerald-50 text-emerald-700'
}

export const CONFIDENCE_DOTS: Record<ConfidenceLevel, string> = {
  low: 'bg-slate-400',
  medium: 'bg-amber-500',
  high: 'bg-emerald-500'
}

export interface PivotStatusStyle {
  badge: string
  dot: string
  /** SVG edge stroke class. */
  edge: string
  /** SVG stroke dash pattern; undefined => solid (established). */
  dash?: string
}

export const PIVOT_STATUS_STYLES: Record<PivotStatus, PivotStatusStyle> = {
  planned: {
    badge: 'border-slate-200 bg-slate-50 text-slate-600',
    dot: 'bg-slate-400',
    edge: 'stroke-muted-foreground',
    dash: '6 5'
  },
  established: {
    badge: 'border-emerald-200/70 bg-emerald-50 text-emerald-700',
    dot: 'bg-emerald-500',
    edge: 'stroke-foreground'
  },
  degraded: {
    badge: 'border-amber-200/70 bg-amber-50 text-amber-800',
    dot: 'bg-amber-500',
    edge: 'stroke-amber-500',
    dash: '3 4'
  },
  lost: {
    badge: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-slate-300',
    edge: 'stroke-slate-300',
    dash: '2 5'
  }
}

export const LOOT_STATUS_STYLES: Record<LootImportStatus, string> = {
  queued: 'border-slate-200 bg-slate-50 text-slate-600',
  parsed: 'border-emerald-200/70 bg-emerald-50 text-emerald-700',
  needs_review: 'border-amber-200/70 bg-amber-50 text-amber-800',
  failed: 'border-red-200/70 bg-red-50 text-red-700'
}

export const TRIAL_STATUS_STYLES: Record<CredentialTrialStatus, string> = {
  attempted: 'border-sky-200/70 bg-sky-50 text-sky-700',
  success: 'border-emerald-200/70 bg-emerald-50 text-emerald-700',
  failed: 'border-red-200/70 bg-red-50 text-red-700',
  blocked: 'border-slate-200 bg-slate-50 text-slate-600'
}

/** Natural sort for IPs, host:port strings and numeric ids. */
export function compareNatural(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** Service columns: sorted by owning host IP, then port, then service name. */
export function sortServicesByEndpoint(
  services: readonly InternalService[]
): InternalService[] {
  return [...services].sort(
    (a, b) =>
      compareNatural(a.host_ip, b.host_ip) ||
      a.port - b.port ||
      compareNatural(a.service, b.service) ||
      compareNatural(a.id, b.id)
  )
}

export interface VulnHostGroup {
  host: string
  items: VulnerabilityListItem[]
}

/**
 * Group internal findings by their entry asset host (plan §7.4). Groups are
 * naturally sorted by host; within a group the most severe finding comes first,
 * then the newest.
 */
export function groupVulnerabilitiesByHost(
  items: readonly VulnerabilityListItem[]
): VulnHostGroup[] {
  const groups = new Map<string, VulnerabilityListItem[]>()
  for (const item of items) {
    const host = item.host.trim().length > 0 ? item.host : '—'
    const bucket = groups.get(host)
    if (bucket === undefined) groups.set(host, [item])
    else bucket.push(item)
  }
  return [...groups.entries()]
    .sort((a, b) => compareNatural(a[0], b[0]))
    .map(([host, groupItems]) => ({
      host,
      items: [...groupItems].sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          b.created_at.localeCompare(a.created_at)
      )
    }))
}

/**
 * Compare a Web asset's `host_port` with a vulnerability `host` or a foothold
 * `entry_host_port`: both sides are reduced to a protocol-agnostic host:port
 * identity so `http://10.0.0.5:8080/` matches `10.0.0.5:8080`.
 */
export function assetIdentity(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (/^https?:\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const port = url.port.length > 0 ? url.port : url.protocol === 'https:' ? '443' : '80'
      return `${url.hostname}:${port}`
    } catch {
      return trimmed.replace(/\/+$/, '')
    }
  }
  return trimmed.replace(/\/+$/, '')
}
