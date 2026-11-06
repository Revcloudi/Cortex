import { useId } from 'react'
import { AlertTriangle, RefreshCw, RotateCcw, Search, X, Zap } from 'lucide-react'
import type { AppliedMemoryGraphLimits, GraphFilters, GraphTypeCounts } from '@shared/graph'
import type { RealmFilter } from '@shared/types'
import {
  HudButton,
  HudDivider,
  HudPanel,
  HudPanelHeader,
  HudSectionTitle,
  HudStat,
  HudStatusDot
} from '@renderer/components/nebula/HudChrome'
import { ScopeSelect } from '@renderer/components/nebula/ScopeSelect'
import { useI18n } from '@renderer/i18n'
import {
  ATTACK_PATH_COLOR,
  NEBULA_UI,
  NODE_TYPE_COLORS,
  SEVERITY_NODE_COLORS,
  rgba
} from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'

/** One Scope tab in the control panel. Labels are resolved inside the panel. */
export interface GraphScopeOption {
  kind: 'all' | 'asset' | 'task'
  /** Node count for this scope; `null` while that scope has not been loaded. */
  count: number | null
  /** Optional hint shown under the tabs. */
  hint?: string
}

/** One selectable scope target (asset `host_port` or snapshot `session_id`). */
export interface GraphScopeTargetOption {
  value: string
  label: string
}

/** One selectable pivot route in the attack-path section. */
export interface GraphRouteOption {
  value: string
  label: string
}

export interface GraphControlPanelProps {
  scopes: GraphScopeOption[]
  activeScopeKind: 'all' | 'asset' | 'task'
  onScopeChange: (kind: 'all' | 'asset' | 'task') => void
  /** Real asset targets, derived from the all-scope graph. */
  hostOptions: GraphScopeTargetOption[]
  /** Real snapshot targets, derived from the all-scope graph. */
  sessionOptions: GraphScopeTargetOption[]
  activeHostPort: string | null
  activeSessionId: string | null
  onSelectHost: (hostPort: string) => void
  onSelectSession: (sessionId: string) => void
  includeChildren: boolean
  onToggleIncludeChildren: () => void
  /** Logical realm switch (plan §7.4): Web (default) / internal / all. */
  realm: RealmFilter
  onRealmChange: (realm: RealmFilter) => void
  search: string
  onSearchChange: (value: string) => void
  onSearchClear: () => void
  filters: GraphFilters
  onToggleFilter: (key: FilterKey) => void
  /** Attack-path (pivot route) overlay: toggle + route picker (plan §7.3). */
  attackPathEnabled: boolean
  onToggleAttackPath: () => void
  routeCount: number
  routeOptions: GraphRouteOption[]
  selectedRouteId: string | null
  onSelectRoute: (routeId: string) => void
  onClearRoute: () => void
  /** Node counts after the type filters. */
  counts: GraphTypeCounts
  visibleNodes: number
  visibleLinks: number
  /** Search match count; `null` when the search box is empty. */
  matchCount: number | null
  onResetView: () => void
  /** Re-fetch the current scope from the database. */
  onRefresh: () => void
  loading: boolean
  truncated: boolean
  /** Limits that produced this graph (for the truncation copy). */
  limits: AppliedMemoryGraphLimits
  /** P3: dim everything outside the selected node's N-hop neighbourhood. */
  focusMode: boolean
  focusDepth: 1 | 2
  /** Nodes inside the current neighbourhood; `null` while nothing is selected. */
  focusCount: number | null
  onToggleFocusMode: () => void
  onChangeFocusDepth: (depth: 1 | 2) => void
  /** P3: large-graph mode (idle labels + halos disabled). */
  performanceMode: boolean
  className?: string
}

/** Web layer filter keys (always present in `GraphFilters`). */
type WebFilterKey = 'vulns' | 'leaks' | 'snapshots'
/** Internal layer filter keys (optional in `GraphFilters`; visible = default). */
type InternalFilterKey = 'footholds' | 'internalHosts' | 'internalServices'
export type FilterKey = WebFilterKey | InternalFilterKey

interface FilterMeta {
  key: FilterKey
  /** Dot colour; vulns borrow the Critical severity hue per the visual spec. */
  color: string
  labelKey: string
  countKey: keyof GraphTypeCounts
}

const FILTER_META: readonly FilterMeta[] = [
  {
    key: 'vulns',
    color: SEVERITY_NODE_COLORS.Critical,
    labelKey: 'nebula.filter.vulns',
    countKey: 'vuln'
  },
  { key: 'leaks', color: NODE_TYPE_COLORS.leak, labelKey: 'nebula.filter.leaks', countKey: 'leak' },
  {
    key: 'snapshots',
    color: NODE_TYPE_COLORS.snapshot,
    labelKey: 'nebula.filter.snapshots',
    countKey: 'snapshot'
  }
]

/** Internal layer chips: hidden in the Web realm, where those nodes never exist. */
const INTERNAL_FILTER_META: readonly FilterMeta[] = [
  {
    key: 'footholds',
    color: NODE_TYPE_COLORS.foothold,
    labelKey: 'nebula.filter.footholds',
    countKey: 'foothold'
  },
  {
    key: 'internalHosts',
    color: NODE_TYPE_COLORS.internal_host,
    labelKey: 'nebula.filter.internalHosts',
    countKey: 'internal_host'
  },
  {
    key: 'internalServices',
    color: NODE_TYPE_COLORS.internal_service,
    labelKey: 'nebula.filter.internalServices',
    countKey: 'internal_service'
  }
]

const REALM_OPTIONS: readonly RealmFilter[] = ['web', 'internal', 'all']

/** Shared look for the tiny scope-hint / empty-state notes. */
const NOTE_CLASS = 'mt-1 font-mono text-[11px] leading-relaxed text-[#7FA9BE]'

/** Compact HUD micro-label used above the scope target selectors. */
const FIELD_LABEL_CLASS = cn(NEBULA_UI.label, 'block')

/** One type-filter chip (dot + label + count), toggled by the page. */
function FilterChip({
  meta,
  on,
  count,
  onToggle
}: {
  meta: FilterMeta
  on: boolean
  count: number
  onToggle: () => void
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid={`filter-${meta.key}`}
      onClick={onToggle}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-[2px] border px-1.5 py-1',
        'font-mono text-[11px] uppercase tracking-[0.04em] transition-colors duration-150',
        on
          ? 'border-[#00E5FF]/45 bg-[#00E5FF]/[0.1] text-[#C7E9F5]'
          : 'border-[#00E5FF]/15 bg-[#01060D]/60 text-[#7FA9BE] hover:border-[#00E5FF]/35 hover:text-[#C7E9F5]',
        NEBULA_UI.focusRing
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full transition-opacity duration-150',
          on ? 'opacity-100' : 'opacity-40'
        )}
        style={{
          backgroundColor: meta.color,
          boxShadow: on ? `0 0 6px ${rgba(meta.color, 0.55)}` : undefined
        }}
      />
      <span className="min-w-0 truncate">{t(meta.labelKey)}</span>
      <span
        className={cn(
          'shrink-0 text-[12.5px] tabular-nums',
          on ? 'text-[#00E5FF]' : 'text-[#7FA9BE]'
        )}
      >
        {count}
      </span>
    </button>
  )
}

/**
 * Left-hand J.A.R.V.I.S. HUD console for the Nebula canvas: scope tabs + real
 * target pickers, search, node-type chips, focus neighbourhood and database
 * actions. The component fills its wrapper (the page owns positioning and the
 * height budget); its own body scrolls with `scrollbar-thin` so the console
 * always fits a 1280×800 window without pushing the footer off-screen.
 */
export function GraphControlPanel({
  scopes,
  activeScopeKind,
  onScopeChange,
  hostOptions,
  sessionOptions,
  activeHostPort,
  activeSessionId,
  onSelectHost,
  onSelectSession,
  includeChildren,
  onToggleIncludeChildren,
  realm,
  onRealmChange,
  search,
  onSearchChange,
  onSearchClear,
  filters,
  onToggleFilter,
  attackPathEnabled,
  onToggleAttackPath,
  routeCount,
  routeOptions,
  selectedRouteId,
  onSelectRoute,
  onClearRoute,
  counts,
  visibleNodes,
  visibleLinks,
  matchCount,
  onResetView,
  onRefresh,
  loading,
  truncated,
  limits,
  focusMode,
  focusDepth,
  focusCount,
  onToggleFocusMode,
  onChangeFocusDepth,
  performanceMode,
  className
}: GraphControlPanelProps) {
  const { t } = useI18n()
  const searchId = useId()
  const hostSelectId = useId()
  const sessionSelectId = useId()
  const activeScope = scopes.find((scope) => scope.kind === activeScopeKind)
  const activeHint = activeScope?.hint

  return (
    <HudPanel
      role="region"
      aria-label={t('nebula.hud.panelControl')}
      className={cn('pointer-events-auto flex max-h-full min-h-0 w-full flex-col', className)}
    >
      <HudPanelHeader
        title={t('nebula.hud.panelControl')}
        meta={t('nebula.badge.live')}
        actions={<HudStatusDot tone={loading ? 'warning' : 'cyan'} pulse={loading} />}
      />

      {/* Body: the only scroll container, so the header stays pinned. */}
      <div className="scrollbar-thin mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {/* ------------------------------------------------------ scope tabs -- */}
        <div
          role="tablist"
          aria-label={t('nebula.scope.switchAria')}
          className="grid grid-cols-3 gap-px overflow-hidden rounded-[2px] border border-[#00E5FF]/20 bg-[#01060D]/70 p-px"
        >
          {scopes.map((scope) => {
            const active = scope.kind === activeScopeKind
            return (
              <button
                key={scope.kind}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`scope-${scope.kind}`}
                onClick={() => onScopeChange(scope.kind)}
                className={cn(
                  'flex min-w-0 flex-col items-start gap-0.5 px-1.5 py-1 text-left transition-colors duration-150',
                  active
                    ? 'bg-[#00E5FF]/[0.14] text-[#00E5FF]'
                    : 'text-[#7FA9BE] hover:bg-[#00E5FF]/[0.06] hover:text-[#C7E9F5]',
                  NEBULA_UI.focusRing
                )}
              >
                <span className="w-full truncate font-mono text-[11px] uppercase leading-tight tracking-[0.04em]">
                  {t(`nebula.scope.${scope.kind}`)}
                </span>
                <span
                  className={cn(
                    'font-mono text-[12.5px] leading-none tabular-nums',
                    active ? 'text-[#00E5FF]' : 'text-[#7FA9BE]'
                  )}
                >
                  {scope.count ?? '—'}
                </span>
              </button>
            )
          })}
        </div>
        {activeHint ? (
          <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-[#7FA9BE]">
            {activeHint}
          </p>
        ) : null}

        {/* --------------------------------------------------- scope targets -- */}
        {activeScopeKind === 'asset' ? (
          <div className="mt-2.5">
            <label htmlFor={hostSelectId} className={FIELD_LABEL_CLASS}>
              {t('nebula.scope.hostLabel')}
            </label>
            <div className="mt-1">
              <ScopeSelect
                id={hostSelectId}
                ariaLabel={t('nebula.scope.hostLabel')}
                value={activeHostPort}
                options={hostOptions}
                onChange={onSelectHost}
                disabled={hostOptions.length === 0}
              />
            </div>
            {hostOptions.length === 0 ? (
              <p className={NOTE_CLASS}>{t('nebula.scope.assetEmpty')}</p>
            ) : null}
          </div>
        ) : null}

        {activeScopeKind === 'task' ? (
          <div className="mt-2.5">
            <label htmlFor={sessionSelectId} className={FIELD_LABEL_CLASS}>
              {t('nebula.scope.sessionLabel')}
            </label>
            <div className="mt-1">
              <ScopeSelect
                id={sessionSelectId}
                ariaLabel={t('nebula.scope.sessionLabel')}
                value={activeSessionId}
                options={sessionOptions}
                onChange={onSelectSession}
                disabled={sessionOptions.length === 0}
              />
            </div>
            {sessionOptions.length === 0 ? (
              <p className={NOTE_CLASS}>{t('nebula.scope.taskEmpty')}</p>
            ) : (
              <label className="mt-2 flex cursor-pointer items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.04em] text-[#A9D6E5]">
                <input
                  type="checkbox"
                  checked={includeChildren}
                  onChange={onToggleIncludeChildren}
                  className={cn(
                    'h-3 w-3 shrink-0 accent-[#00E5FF]',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#00E5FF]/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#02040A]'
                  )}
                />
                {t('nebula.scope.includeChildren')}
              </label>
            )}
          </div>
        ) : null}

        {/* ------------------------------------------------------ realm tabs -- */}
        <div className="mt-2.5">
          <HudSectionTitle>{t('nebula.realm.label')}</HudSectionTitle>
          <div
            role="tablist"
            aria-label={t('nebula.realm.switchAria')}
            className="mt-1.5 grid grid-cols-3 gap-px overflow-hidden rounded-[2px] border border-[#00E5FF]/20 bg-[#01060D]/70 p-px"
          >
            {REALM_OPTIONS.map((option) => {
              const active = option === realm
              return (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`realm-${option}`}
                  onClick={() => onRealmChange(option)}
                  className={cn(
                    'min-w-0 px-1 py-1 text-center transition-colors duration-150',
                    'font-mono text-[11px] uppercase leading-tight tracking-[0.04em]',
                    active
                      ? option === 'internal'
                        ? 'bg-[#FF7A33]/[0.16] text-[#FFB38A]'
                        : 'bg-[#00E5FF]/[0.14] text-[#00E5FF]'
                      : 'text-[#7FA9BE] hover:bg-[#00E5FF]/[0.06] hover:text-[#C7E9F5]',
                    NEBULA_UI.focusRing
                  )}
                >
                  {t(`nebula.realm.${option}`)}
                </button>
              )
            })}
          </div>
        </div>

        <HudDivider className="my-2.5" />
        <div>
          <label htmlFor={searchId} className="sr-only">
            {t('nebula.search.ariaLabel')}
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#00E5FF]/45"
            />
            <input
              id={searchId}
              type="text"
              inputMode="search"
              autoComplete="off"
              spellCheck={false}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t('nebula.search.placeholder')}
              aria-label={t('nebula.search.ariaLabel')}
              data-testid="search-input"
              className={cn(NEBULA_UI.input, 'h-7 pl-7 pr-7 text-[12.5px] placeholder:text-[#7FA9BE]')}
            />
            {search.length > 0 ? (
              <button
                type="button"
                onClick={onSearchClear}
                aria-label={t('nebula.search.clear')}
                title={t('nebula.search.clear')}
                className={cn(
                  'absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-[2px]',
                  'text-[#7FA9BE] transition-colors duration-150 hover:bg-[#00E5FF]/10 hover:text-[#00E5FF]',
                  NEBULA_UI.focusRing
                )}
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          {matchCount !== null ? (
            <p
              aria-live="polite"
              className={cn(
                'mt-1.5 font-mono text-[11px] leading-relaxed',
                matchCount === 0 ? 'text-[#FFC766]' : 'text-[#7FA9BE]'
              )}
            >
              {matchCount === 0
                ? t('nebula.search.noMatch')
                : t('nebula.search.matchCount', { count: matchCount })}
            </p>
          ) : null}
        </div>

        <HudDivider className="my-2.5" />

        {/* ----------------------------------------------------- type filters -- */}
        <div>
          <HudSectionTitle>{t('nebula.filter.label')}</HudSectionTitle>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {FILTER_META.map((meta) => (
              <FilterChip
                key={meta.key}
                meta={meta}
                on={filters[meta.key] !== false}
                count={counts[meta.countKey]}
                onToggle={() => onToggleFilter(meta.key)}
              />
            ))}
          </div>

          {realm !== 'web' ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {INTERNAL_FILTER_META.map((meta) => (
                <FilterChip
                  key={meta.key}
                  meta={meta}
                  on={filters[meta.key] !== false}
                  count={counts[meta.countKey]}
                  onToggle={() => onToggleFilter(meta.key)}
                />
              ))}
            </div>
          ) : null}

          {/* Hosts anchor every scope and can never be filtered out. */}
          <div className="mt-1 flex items-center gap-1.5 px-1.5 py-1">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{
                backgroundColor: NODE_TYPE_COLORS.host,
                boxShadow: `0 0 6px ${rgba(NODE_TYPE_COLORS.host, 0.45)}`
              }}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.04em] text-[#A9D6E5]">
              {t('nebula.type.host')}
            </span>
            <span className="font-mono text-[12.5px] tabular-nums text-[#7FA9BE]">
              {counts.host}
            </span>
          </div>
        </div>

        <HudDivider className="my-2.5" />

        {/* ------------------------------------------------ focus neighbourhood -- */}
        <div>
          <div className="flex items-center gap-2">
            <HudSectionTitle className="min-w-0 flex-1">{t('nebula.focus.label')}</HudSectionTitle>
            <button
              type="button"
              role="switch"
              aria-checked={focusMode}
              aria-label={t('nebula.focus.toggle')}
              title={t('nebula.focus.toggle')}
              data-testid="focus-toggle"
              onClick={onToggleFocusMode}
              className={cn(
                'inline-flex h-5 shrink-0 items-center rounded-[2px] border px-1.5',
                'font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150',
                focusMode
                  ? 'border-[#00E5FF]/60 bg-[#00E5FF]/15 text-[#00E5FF]'
                  : 'border-[#00E5FF]/20 bg-[#01060D]/60 text-[#7FA9BE] hover:text-[#C7E9F5]',
                NEBULA_UI.focusRing
              )}
            >
              {focusMode ? 'ON' : 'OFF'}
            </button>
          </div>
          {focusMode ? (
            <>
              <div className="mt-1.5 grid grid-cols-2 gap-px overflow-hidden rounded-[2px] border border-[#00E5FF]/20 bg-[#01060D]/70 p-px">
                {([1, 2] as const).map((depth) => {
                  const active = focusDepth === depth
                  return (
                    <button
                      key={depth}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onChangeFocusDepth(depth)}
                      className={cn(
                        'px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.04em] transition-colors duration-150',
                        active
                          ? 'bg-[#00E5FF]/[0.14] text-[#00E5FF]'
                          : 'text-[#7FA9BE] hover:bg-[#00E5FF]/[0.06] hover:text-[#C7E9F5]',
                        NEBULA_UI.focusRing
                      )}
                    >
                      {t(`nebula.focus.depth${depth}`)}
                    </button>
                  )
                })}
              </div>
              <p className={cn(NOTE_CLASS, 'mt-1.5')}>
                {focusCount === null
                  ? t('nebula.focus.hintSelect')
                  : t('nebula.focus.active', { count: focusCount })}
              </p>
            </>
          ) : null}
        </div>

        <HudDivider className="my-2.5" />

        {/* ----------------------------------------------------- attack path -- */}
        <div>
          <div className="flex items-center gap-2">
            <HudSectionTitle className="min-w-0 flex-1">
              {t('nebula.attackPath.label')}
            </HudSectionTitle>
            <button
              type="button"
              role="switch"
              aria-checked={attackPathEnabled}
              aria-label={t('nebula.attackPath.toggle')}
              title={t('nebula.attackPath.toggle')}
              data-testid="attack-path-toggle"
              onClick={onToggleAttackPath}
              className={cn(
                'inline-flex h-5 shrink-0 items-center rounded-[2px] border px-1.5',
                'font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-150',
                attackPathEnabled
                  ? 'border-[#FF7A33]/60 bg-[#FF7A33]/15 text-[#FFB38A]'
                  : 'border-[#00E5FF]/20 bg-[#01060D]/60 text-[#7FA9BE] hover:text-[#C7E9F5]',
                NEBULA_UI.focusRing
              )}
            >
              {attackPathEnabled ? t('nebula.attackPath.on') : t('nebula.attackPath.off')}
            </button>
          </div>
          {routeCount > 0 ? (
            <p className={NOTE_CLASS}>{t('nebula.attackPath.count', { count: routeCount })}</p>
          ) : null}
          {attackPathEnabled && routeCount > 0 ? (
            <>
              <div className="mt-1.5">
                <ScopeSelect
                  ariaLabel={t('nebula.attackPath.selectLabel')}
                  value={selectedRouteId}
                  options={routeOptions}
                  onChange={onSelectRoute}
                  disabled={routeOptions.length === 0}
                />
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: ATTACK_PATH_COLOR,
                    boxShadow: `0 0 6px ${rgba(ATTACK_PATH_COLOR, 0.7)}`
                  }}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-relaxed text-[#7FA9BE]">
                  {t('nebula.attackPath.hint')}
                </span>
                {selectedRouteId !== null ? (
                  <HudButton
                    size="sm"
                    variant="ghost"
                    onClick={onClearRoute}
                    aria-label={t('nebula.attackPath.clear')}
                    title={t('nebula.attackPath.clear')}
                    className="shrink-0 text-[10.5px]"
                  >
                    {t('nebula.attackPath.clear')}
                  </HudButton>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        {/* ------------------------------------------------------------ footer -- */}
        <footer className={cn('mt-3 border-t pt-2.5', NEBULA_UI.divider)}>
          <div className="grid grid-cols-2 gap-x-3">
            <HudStat label={t('nebula.hud.statNodes')} value={visibleNodes} tone="cyan" />
            <HudStat label={t('nebula.hud.statLinks')} value={visibleLinks} />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <HudButton
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              aria-label={t('nebula.refreshAria')}
              title={t('nebula.refreshAria')}
              data-testid="refresh"
              className="w-full text-[11px]"
            >
              <RefreshCw
                aria-hidden="true"
                className={cn('h-3 w-3', loading && 'animate-spin')}
              />
              <span className="min-w-0 truncate">{t('nebula.refresh')}</span>
            </HudButton>
            <HudButton
              size="sm"
              onClick={onResetView}
              aria-label={t('nebula.resetViewAria')}
              title={t('nebula.resetViewAria')}
              data-testid="reset-view"
              className="w-full text-[11px]"
            >
              <RotateCcw aria-hidden="true" className="h-3 w-3" />
              <span className="min-w-0 truncate">{t('nebula.resetView')}</span>
            </HudButton>
          </div>

          {truncated ? (
            <p className="mt-2 flex items-start gap-1.5 rounded-[2px] border border-[#FFAA00]/30 bg-[#FFAA00]/[0.07] px-1.5 py-1 font-mono text-[11px] leading-relaxed text-[#FFC766]">
              <AlertTriangle aria-hidden="true" className="mt-px h-3 w-3 shrink-0" />
              <span className="min-w-0">
                {t('nebula.truncated.banner', {
                  hosts: limits.hosts,
                  vulns: limits.vulnerabilities,
                  leaks: limits.leaks,
                  snapshots: limits.snapshots
                })}
              </span>
            </p>
          ) : null}

          {performanceMode ? (
            <p className="mt-2 flex items-start gap-1.5 font-mono text-[11px] leading-relaxed text-[#7DEBFF]">
              <Zap aria-hidden="true" className="mt-px h-3 w-3 shrink-0" />
              <span className="min-w-0">{t('nebula.performance.mode')}</span>
            </p>
          ) : null}
        </footer>
      </div>
    </HudPanel>
  )
}
