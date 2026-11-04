import { Boxes, Brain, Network, Orbit, Plug, ShieldAlert, type LucideIcon } from 'lucide-react'

export type AppPage = 'dashboard' | 'internal' | 'nebula' | 'assets' | 'snapshots' | 'mcp'

/** Cross-page deep link used by the nebula inspector ("view full details"). */
export type AppDetailKind = 'vuln' | 'asset' | 'snapshot'

export interface AppDetailTarget {
  page: AppPage
  kind: AppDetailKind
  /** Vulnerability id, asset host_port or snapshot session_id. */
  id: string
}

/**
 * Navigation exposes message keys instead of literals so the sidebar (and any
 * future shell chrome) renders labels in the active language via `t(...)`.
 */
export interface NavItem {
  page: AppPage
  labelKey: string
  icon: LucideIcon
}

export const NAV_ITEMS: readonly NavItem[] = [
  { page: 'dashboard', labelKey: 'nav.dashboard', icon: ShieldAlert },
  { page: 'internal', labelKey: 'nav.internal', icon: Network },
  { page: 'nebula', labelKey: 'nav.nebula', icon: Orbit },
  { page: 'assets', labelKey: 'nav.assets', icon: Boxes },
  { page: 'snapshots', labelKey: 'nav.snapshots', icon: Brain },
  { page: 'mcp', labelKey: 'nav.mcp', icon: Plug }
]

export const PAGE_META: Record<AppPage, { titleKey: string; descriptionKey: string }> = {
  dashboard: {
    titleKey: 'nav.dashboard',
    descriptionKey: 'ui.pageMeta.dashboard.description'
  },
  internal: {
    titleKey: 'nav.internal',
    descriptionKey: 'internal.page.description'
  },
  nebula: {
    titleKey: 'nav.nebula',
    descriptionKey: 'ui.pageMeta.nebula.description'
  },
  assets: {
    titleKey: 'nav.assets',
    descriptionKey: 'ui.pageMeta.assets.description'
  },
  snapshots: {
    titleKey: 'nav.snapshots',
    descriptionKey: 'ui.pageMeta.snapshots.description'
  },
  mcp: {
    titleKey: 'nav.mcp',
    descriptionKey: 'ui.pageMeta.mcp.description'
  }
}
