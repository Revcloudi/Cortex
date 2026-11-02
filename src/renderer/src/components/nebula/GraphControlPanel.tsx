import { useId } from 'react'
import { RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import type { AppliedMemoryGraphLimits, GraphFilters, GraphTypeCounts } from '@shared/graph'
import { ScopeSelect } from '@renderer/components/nebula/ScopeSelect'
import { useI18n } from '@renderer/i18n'
import {
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
  search: string
  onSearchChange: (value: string) => void
  onSearchClear: () => void
  filters: GraphFilters
  onToggleFilter: (key: 'vulns' | 'leaks' | 'snapshots') => void
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

type FilterKey = 'vulns' | 'leaks' | 'snapshots'

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

/** Shared look for the small icon/text buttons that live in the glass panel. */
const BUTTON_CLASS = cn(
  'inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04]',
  'px-2 py-1 text-[11px] text-white/60 transition-colors duration-150',
  'hover:border-white/20 hover:bg-white/[0.08] hover:text-white/85',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c10]',
  'disabled:cursor-not-allowed disabled:opacity-50'
)

/**
 * Left-hand glass control surface for the Nebula canvas: scope tabs + real
 * target pickers, search, node-type filters, live stats and database actions.
 * Positioning and size belong to the page — this component only renders content
 * that fills its wrapper.
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
  search,
  onSearchChange,
  onSearchClear,
  filters,
  onToggleFilter,
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
    <section
      aria-label={t('nebula.title')}
      className={cn(
        NEBULA_UI.glass,
        NEBULA_UI.panelRadius,
        'scrollbar-thin flex max-h-full w-full flex-col overflow-y-auto p-3.5 text-white/80',
        className
      )}
    >
      {/* ------------------------------------------------------------ header -- */}
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-medium leading-snug tracking-tight text-white/90">
            {t('nebula.title')}
          </h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-white/40">
            {t('nebula.subtitle')}
          </p>
        </div>
        <span className="mt-0.5 shrink-0 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-200/90">
          {t('nebula.badge.live')}
        </span>
      </header>

      {/* ------------------------------------------------------- scope tabs -- */}
      <div
        role="tablist"
        aria-label={t('nebula.scope.switchAria')}
        className="mt-3 grid grid-cols-3 gap-1"
      >
        {scopes.map((scope) => {
          const active = scope.kind === activeScopeKind
          return (
            <button
              key={scope.kind}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onScopeChange(scope.kind)}
              className={cn(
                'flex min-w-0 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
                'focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c10]',
                active
                  ? 'bg-white/[0.08] text-white ring-1 ring-inset ring-white/15'
                  : 'text-white/45 hover:bg-white/[0.04] hover:text-white/75'
              )}
            >
              <span className="w-full truncate text-[11.5px] leading-tight">
                {t(`nebula.scope.${scope.kind}`)}
              </span>
              <span className="font-mono text-[10.5px] tabular-nums text-white/35">
                {scope.count ?? '—'}
              </span>
            </button>
          )
        })}
      </div>
      {activeHint ? (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-white/30">{activeHint}</p>
      ) : null}

      {/* ---------------------------------------------------- scope targets -- */}
      {activeScopeKind === 'asset' ? (
        <div className="mt-2.5">
          <label
            htmlFor={hostSelectId}
            className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-white/30"
          >
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
            <p className="mt-1 text-[10.5px] leading-relaxed text-white/30">
              {t('nebula.scope.assetEmpty')}
            </p>
          ) : null}
        </div>
      ) : null}

      {activeScopeKind === 'task' ? (
        <div className="mt-2.5">
          <label
            htmlFor={sessionSelectId}
            className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-white/30"
          >
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
            <p className="mt-1 text-[10.5px] leading-relaxed text-white/30">
              {t('nebula.scope.taskEmpty')}
            </p>
          ) : (
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-white/55">
              <input
                type="checkbox"
                checked={includeChildren}
                onChange={onToggleIncludeChildren}
                className="h-3.5 w-3.5 accent-sky-500"
              />
              {t('nebula.scope.includeChildren')}
            </label>
          )}
        </div>
      ) : null}

      <div className={cn('my-3 border-t', NEBULA_UI.divider)} />

      {/* ------------------------------------------------------------ search -- */}
      <div>
        <label htmlFor={searchId} className="sr-only">
          {t('nebula.search.ariaLabel')}
        </label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35"
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
            className={cn(
              'h-8 w-full rounded-md border border-white/10 bg-white/[0.04] pl-8 pr-8',
              'text-[12.5px] text-white/85 outline-none transition-colors duration-150',
              'placeholder:text-white/30',
              'focus:border-sky-400/40 focus:bg-white/[0.06] focus:ring-1 focus:ring-sky-400/40'
            )}
          />
          {search.length > 0 ? (
            <button
              type="button"
              onClick={onSearchClear}
              aria-label={t('nebula.search.clear')}
              title={t('nebula.search.clear')}
              className={cn(
                'absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded',
                'text-white/40 transition-colors duration-150 hover:bg-white/10 hover:text-white/80',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60'
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
              'mt-1.5 text-[10.5px] leading-relaxed',
              matchCount === 0 ? 'text-amber-200/75' : 'text-white/40'
            )}
          >
            {matchCount === 0
              ? t('nebula.search.noMatch')
              : t('nebula.search.matchCount', { count: matchCount })}
          </p>
        ) : null}
      </div>

      {/* ----------------------------------------------------- type filters -- */}
      <div className="mt-4">
        <h3 className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-white/30">
          {t('nebula.filter.label')}
        </h3>
        <div className="mt-1.5 space-y-0.5">
          {FILTER_META.map((meta) => {
            const on = filters[meta.key]
            return (
              <button
                key={meta.key}
                type="button"
                aria-pressed={on}
                onClick={() => onToggleFilter(meta.key)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
                  'focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c10]',
                  on
                    ? 'bg-white/[0.06] text-white/85'
                    : 'text-white/35 hover:bg-white/[0.03] hover:text-white/55'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full transition-opacity duration-150',
                    on ? 'opacity-100' : 'opacity-35'
                  )}
                  style={{
                    backgroundColor: meta.color,
                    boxShadow: on ? `0 0 8px ${rgba(meta.color, 0.55)}` : undefined
                  }}
                />
                <span className="min-w-0 flex-1 truncate text-[11.5px]">{t(meta.labelKey)}</span>
                <span className="font-mono text-[10.5px] tabular-nums text-white/35">
                  {counts[meta.countKey]}
                </span>
              </button>
            )
          })}

          {/* Hosts anchor every scope and can never be filtered out. */}
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{
                backgroundColor: NODE_TYPE_COLORS.host,
                boxShadow: `0 0 8px ${rgba(NODE_TYPE_COLORS.host, 0.45)}`
              }}
            />
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-white/55">
              {t('nebula.type.host')}
            </span>
            <span className="font-mono text-[10.5px] tabular-nums text-white/30">
              {counts.host}
            </span>
          </div>
          <p className="px-2 text-[10.5px] leading-relaxed text-white/25">
            {t('nebula.filter.hostsAlwaysVisible')}
          </p>
        </div>
      </div>

      {/* ------------------------------------------------ focus neighbourhood -- */}
      <div className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-white/30">
            {t('nebula.focus.label')}
          </h3>
          <button
            type="button"
            role="switch"
            aria-checked={focusMode}
            aria-label={t('nebula.focus.toggle')}
            onClick={onToggleFocusMode}
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
              'focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c10]',
              focusMode
                ? 'border-sky-400/40 bg-sky-400/15 text-sky-200'
                : 'border-white/10 bg-white/[0.04] text-white/45 hover:text-white/70'
            )}
          >
            {focusMode ? 'ON' : 'OFF'}
          </button>
        </div>
        {focusMode ? (
          <>
            <div className="mt-1.5 grid grid-cols-2 gap-1">
              {([1, 2] as const).map((depth) => {
                const active = focusDepth === depth
                return (
                  <button
                    key={depth}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onChangeFocusDepth(depth)}
                    className={cn(
                      'rounded-md px-2 py-1 text-[11px] transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
                      'focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c10]',
                      active
                        ? 'bg-white/[0.08] text-white/85 ring-1 ring-inset ring-white/15'
                        : 'text-white/45 hover:bg-white/[0.03] hover:text-white/70'
                    )}
                  >
                    {t(`nebula.focus.depth${depth}`)}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-white/30">
              {focusCount === null
                ? t('nebula.focus.hintSelect')
                : t('nebula.focus.active', { count: focusCount })}
            </p>
          </>
        ) : null}
      </div>

      {/* ------------------------------------------------------------ footer -- */}
      <footer className={cn('mt-4 border-t pt-3', NEBULA_UI.divider)}>
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 font-mono text-[10.5px] leading-relaxed tabular-nums text-white/40">
            <span>{t('nebula.stats.nodes', { count: visibleNodes })}</span>
            <span aria-hidden="true" className="px-1.5 text-white/20">
              /
            </span>
            <span>{t('nebula.stats.links', { count: visibleLinks })}</span>
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              aria-label={t('nebula.refreshAria')}
              title={t('nebula.refreshAria')}
              className={BUTTON_CLASS}
            >
              <RefreshCw
                aria-hidden="true"
                className={cn('h-3 w-3', loading && 'animate-spin')}
              />
              {t('nebula.refresh')}
            </button>
            <button
              type="button"
              onClick={onResetView}
              aria-label={t('nebula.resetViewAria')}
              title={t('nebula.resetViewAria')}
              className={BUTTON_CLASS}
            >
              <RotateCcw aria-hidden="true" className="h-3 w-3" />
              {t('nebula.resetView')}
            </button>
          </div>
        </div>
        {truncated ? (
          <p className="mt-2 text-[10.5px] leading-relaxed text-amber-200/75">
            {t('nebula.truncated.banner', {
              hosts: limits.hosts,
              vulns: limits.vulnerabilities,
              leaks: limits.leaks,
              snapshots: limits.snapshots
            })}
          </p>
        ) : null}
        {performanceMode ? (
          <p className="mt-2 text-[10.5px] leading-relaxed text-sky-200/70">
            {t('nebula.performance.mode')}
          </p>
        ) : null}
        <p className="mt-2 text-[10.5px] leading-relaxed text-white/25">
          {t('nebula.limits.hint', {
            hosts: limits.hosts,
            vulns: limits.vulnerabilities,
            leaks: limits.leaks,
            snapshots: limits.snapshots
          })}
        </p>
      </footer>
    </section>
  )
}
