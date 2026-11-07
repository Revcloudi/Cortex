import { Bot, Boxes, Brain, FlaskConical, Network, Orbit, PackageSearch, ShieldAlert, Zap, type LucideIcon } from 'lucide-react'

export type AppPage =
  | 'dashboard'
  | 'internal'
  | 'nebula'
  | 'assets'
  | 'snapshots'
  | 'mcp'
  | 'retest'
  | 'fuzzer'
  | 'miniapps'
  | 'ai-config'

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
  { page: 'retest', labelKey: 'nav.retest', icon: FlaskConical },
  { page: 'fuzzer', labelKey: 'nav.fuzzer', icon: Zap },
  { page: 'miniapps', labelKey: 'nav.miniapps', icon: PackageSearch },
  { page: 'ai-config', labelKey: 'retest.aiConfig.nav', icon: Bot }
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
  retest: {
    titleKey: 'nav.retest',
    descriptionKey: 'retest.page.repeaterSubtitle'
  },
  fuzzer: {
    titleKey: 'nav.fuzzer',
    descriptionKey: 'fuzzer.page.description'
  },
  miniapps: {
    titleKey: 'nav.miniapps',
    descriptionKey: 'miniapp.page.description'
  },
  'ai-config': {
    titleKey: 'retest.aiConfig.nav',
    descriptionKey: 'retest.aiConfig.description'
  }
}
