import { Boxes, Brain, Plug, ShieldAlert, type LucideIcon } from 'lucide-react'

export type AppPage = 'dashboard' | 'assets' | 'snapshots' | 'mcp'

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
  { page: 'assets', labelKey: 'nav.assets', icon: Boxes },
  { page: 'snapshots', labelKey: 'nav.snapshots', icon: Brain },
  { page: 'mcp', labelKey: 'nav.mcp', icon: Plug }
]

export const PAGE_META: Record<AppPage, { titleKey: string; descriptionKey: string }> = {
  dashboard: {
    titleKey: 'nav.dashboard',
    descriptionKey: 'ui.pageMeta.dashboard.description'
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
