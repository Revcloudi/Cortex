import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Camera, Loader2, Maximize2, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  MEMORY_GRAPH_DEFAULT_LIMITS,
  collectNeighborhoodIds,
  collectNeighbors,
  filterGraph,
  graphHasAggregates,
  nodeMatchesQuery,
  type GraphFilters,
  type MemoryGraphData,
  type MemoryGraphScope
} from '@shared/graph'
import {
  GraphControlPanel,
  type GraphScopeOption,
  type GraphScopeTargetOption
} from '@renderer/components/nebula/GraphControlPanel'
import { GraphLegend } from '@renderer/components/nebula/GraphLegend'
import { NebulaGraph, type NebulaGraphHandle } from '@renderer/components/nebula/NebulaGraph'
import { NodeInspector } from '@renderer/components/nebula/NodeInspector'
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import { NEBULA_BACKGROUND, PERFORMANCE_MODE_ELEMENT_LIMIT } from '@renderer/lib/graphTheme'
import type { AppDetailTarget } from '@renderer/lib/navigation'
import { cn } from '@renderer/lib/utils'
import { useI18n } from '@renderer/i18n'

/**
 * Memory Nebula — one full-screen 3D canvas, three scopes (P2 live data).
 *
 * The page owns scope/search/filter/selection state and reads the read-only
 * projection through `getApi().getMemoryGraph(scope)` (Electron IPC or the
 * `ctx web` HTTP transport, same `CortexApi` contract). The all-scope graph is
 * cached so the asset/task pickers can list real hosts and snapshot sessions
 * without a second endpoint.
 */

export interface NebulaPageProps {
  dataVersion: number
  /** Deep link to the full detail page of the selected node. */
  onOpenDetail: (target: AppDetailTarget) => void
}

type ScopeKind = 'all' | 'asset' | 'task'

/** Type filters default to everything on; hosts are never filterable. */
const DEFAULT_FILTERS: GraphFilters = { vulns: true, leaks: true, snapshots: true }
const TARGET_LABEL_MAX_LENGTH = 52

function truncateLabel(value: string): string {
  const trimmed = value.trim()
  return trimmed.length <= TARGET_LABEL_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, TARGET_LABEL_MAX_LENGTH - 1)}…`
}

interface StatusCard {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  tone: 'neutral' | 'danger'
}

export function NebulaPage({ dataVersion, onOpenDetail }: NebulaPageProps) {
  const { t } = useI18n()
  const graphRef = useRef<NebulaGraphHandle>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  /** Last loaded all-scope graph: powers the asset/task pickers. */
  const allGraphRef = useRef<MemoryGraphData | null>(null)

  const [scopeKind, setScopeKind] = useState<ScopeKind>('all')
  const [activeHostPort, setActiveHostPort] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [includeChildren, setIncludeChildren] = useState(false)
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [graph, setGraph] = useState<MemoryGraphData | null>(null)
  const [allGraph, setAllGraph] = useState<MemoryGraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshSeq, setRefreshSeq] = useState(0)
  // P3 experience state.
  const [focusMode, setFocusMode] = useState(false)
  const [focusDepth, setFocusDepth] = useState<1 | 2>(1)
  const [isFullscreen, setIsFullscreen] = useState(false)
  /** Legend starts collapsed; when opened the page moves it beside the panel. */
  const [legendOpen, setLegendOpen] = useState(false)

  // Keep the camera from auto-rotating for users who asked for less motion.
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (): void => setReducedMotion(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  const pendingTarget =
    (scopeKind === 'asset' && activeHostPort === null) ||
    (scopeKind === 'task' && activeSessionId === null)

  const scope = useMemo<MemoryGraphScope>(() => {
    if (scopeKind === 'asset' && activeHostPort !== null) {
      return { kind: 'asset', hostPort: activeHostPort }
    }
    if (scopeKind === 'task' && activeSessionId !== null) {
      return includeChildren
        ? { kind: 'task', sessionId: activeSessionId, includeChildren: true }
        : { kind: 'task', sessionId: activeSessionId }
    }
    return { kind: 'all' }
  }, [scopeKind, activeHostPort, activeSessionId, includeChildren])

  /* ------------------------------------------------------------------ data -- */

  useEffect(() => {
    const client = getApi()
    if (client === null) {
      setLoading(false)
      setError(apiUnavailableMessage(t))
      return
    }
    if (pendingTarget) {
      setGraph(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const current = await client.getMemoryGraph({ scope })
        if (cancelled) return
        setGraph(current)
        if (scope.kind === 'all') {
          allGraphRef.current = current
          setAllGraph(current)
        } else if (allGraphRef.current === null) {
          const all = await client.getMemoryGraph({ scope: { kind: 'all' } })
          if (cancelled) return
          allGraphRef.current = all
          setAllGraph(all)
        }
      } catch (cause) {
        if (!cancelled) setError(toErrorMessage(cause, t))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scope, pendingTarget, dataVersion, refreshSeq, t])

  const hostOptions = useMemo<GraphScopeTargetOption[]>(() => {
    const nodes = allGraph?.nodes ?? []
    return nodes
      .filter((node) => node.type === 'host')
      .map((node) => ({
        value: node.data.host_port,
        label: node.project === '' ? node.data.host_port : `${node.data.host_port} · ${node.project}`
      }))
      .sort((left, right) => left.value.localeCompare(right.value))
  }, [allGraph])

  const sessionOptions = useMemo<GraphScopeTargetOption[]>(() => {
    const nodes = allGraph?.nodes ?? []
    return nodes
      .filter((node) => node.type === 'snapshot')
      .map((node) => ({
        value: node.data.session_id,
        label: truncateLabel(
          `${node.data.project_name} / ${node.data.current_phase.trim() === '' ? node.data.session_id : node.data.current_phase}`
        ),
        isRoot: node.data.parent_session_id === null,
        updatedAt: node.data.updated_at
      }))
      .sort((left, right) => {
        // Root/project sessions first, then newest activity — a task scope is
        // usually opened for the campaign, not for one of its archived children.
        if (left.isRoot !== right.isRoot) return left.isRoot ? -1 : 1
        return right.updatedAt.localeCompare(left.updatedAt)
      })
      .map(({ value, label }) => ({ value, label }))
  }, [allGraph])

  // Entering an asset/task scope picks the first real target automatically.
  useEffect(() => {
    if (scopeKind === 'asset' && activeHostPort === null && hostOptions.length > 0) {
      setActiveHostPort(hostOptions[0].value)
    }
    if (scopeKind === 'task' && activeSessionId === null && sessionOptions.length > 0) {
      setActiveSessionId(sessionOptions[0].value)
    }
  }, [scopeKind, activeHostPort, activeSessionId, hostOptions, sessionOptions])

  /* ------------------------------------------------------- derived graph data -- */

  const visibleGraph = useMemo(
    () => (graph === null ? null : filterGraph(graph, filters)),
    [graph, filters]
  )

  const debouncedSearch = useDebouncedValue(search, 160)
  const query = debouncedSearch.trim()
  const matchIds = useMemo(() => {
    if (visibleGraph === null || query.length === 0) return []
    return visibleGraph.nodes
      .filter((node) => nodeMatchesQuery(node, query))
      .map((node) => node.id)
  }, [visibleGraph, query])
  const matchCount = query.length === 0 ? null : matchIds.length
  const highlightIds = query.length === 0 ? null : matchIds

  const selectedNode = useMemo(
    () =>
      visibleGraph === null || selectedId === null
        ? null
        : (visibleGraph.nodes.find((node) => node.id === selectedId) ?? null),
    [selectedId, visibleGraph]
  )
  const neighbors = useMemo(
    () =>
      selectedNode === null || visibleGraph === null
        ? []
        : collectNeighbors(selectedNode.id, visibleGraph),
    [selectedNode, visibleGraph]
  )

  // P3: large graphs drop idle labels/halos (see NebulaGraph performance mode).
  const performanceMode = useMemo(
    () =>
      visibleGraph !== null &&
      visibleGraph.nodes.length + visibleGraph.links.length > PERFORMANCE_MODE_ELEMENT_LIMIT,
    [visibleGraph]
  )

  // P3: focus neighbourhood around the selected node (1/2 hops).
  const focusIds = useMemo<string[] | null>(() => {
    if (!focusMode || visibleGraph === null || selectedNode === null) return null
    return [...collectNeighborhoodIds(visibleGraph, selectedNode.id, focusDepth)]
  }, [focusMode, visibleGraph, selectedNode, focusDepth])
  const focusCount = focusIds === null ? null : focusIds.length

  // Cross-page "view full details" link for the selected node. Leaks have no
  // dedicated page, so they keep the drawer-only summary.
  const detailTarget = useMemo<AppDetailTarget | null>(() => {
    if (selectedNode === null) return null
    if (selectedNode.type === 'vuln') {
      return { page: 'dashboard', kind: 'vuln', id: selectedNode.data.vuln_id }
    }
    if (selectedNode.type === 'host') {
      return { page: 'assets', kind: 'asset', id: selectedNode.data.host_port }
    }
    if (selectedNode.type === 'snapshot') {
      return { page: 'snapshots', kind: 'snapshot', id: selectedNode.data.session_id }
    }
    return null
  }, [selectedNode])
  const detailLabel =
    detailTarget === null
      ? null
      : detailTarget.kind === 'vuln'
        ? t('nebula.detail.openVuln')
        : detailTarget.kind === 'asset'
          ? t('nebula.detail.openAsset')
          : t('nebula.detail.openSnapshot')

  // A type filter can hide the selected node: close the inspector instead of
  // keeping a stale drawer on screen.
  useEffect(() => {
    if (selectedId !== null && selectedNode === null) setSelectedId(null)
  }, [selectedId, selectedNode])

  // Focusing the first match makes search behave like "spotlight" navigation.
  useEffect(() => {
    if (query.length === 0) return
    const firstMatch = matchIds[0]
    if (firstMatch !== undefined) graphRef.current?.focusNode(firstMatch)
  }, [query, matchIds])

  // Esc closes the inspector; the canvas keeps the selection in sync itself.
  useEffect(() => {
    if (selectedId === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedId])

  /* --------------------------------------------------------------- actions -- */

  const handleScopeChange = useCallback((kind: ScopeKind) => {
    setScopeKind(kind)
    setSelectedId(null)
    graphRef.current?.resetView()
  }, [])

  const handleSelectHost = useCallback((hostPort: string) => {
    setActiveHostPort(hostPort)
    setSelectedId(null)
    graphRef.current?.resetView()
  }, [])

  const handleSelectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    setSelectedId(null)
    graphRef.current?.resetView()
  }, [])

  const handleToggleIncludeChildren = useCallback(() => {
    setIncludeChildren((value) => !value)
    setSelectedId(null)
  }, [])

  const handleToggleFilter = useCallback((key: 'vulns' | 'leaks' | 'snapshots') => {
    setFilters((current) => ({ ...current, [key]: !current[key] }))
  }, [])

  const handleSelectNode = useCallback((nodeId: string | null) => {
    setSelectedId(nodeId)
  }, [])

  const handleInspectorSelect = useCallback((nodeId: string) => {
    setSelectedId(nodeId)
    graphRef.current?.focusNode(nodeId)
  }, [])

  const handleResetView = useCallback(() => {
    graphRef.current?.resetView()
  }, [])

  const handleRefresh = useCallback(() => {
    setRefreshSeq((value) => value + 1)
  }, [])

  const handleResetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS)
  }, [])

  const handleClearSearch = useCallback(() => {
    setSearch('')
  }, [])

  // Keep the fullscreen button in sync with browser-initiated exits (Esc).
  useEffect(() => {
    const onChange = (): void => setIsFullscreen(document.fullscreenElement === sectionRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const handleToggleFullscreen = useCallback(() => {
    const element = sectionRef.current
    if (element === null) return
    if (document.fullscreenElement === element) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    void element.requestFullscreen().catch(() => undefined)
  }, [])

  const handleExportPng = useCallback(() => {
    const dataUrl = graphRef.current?.captureImage() ?? null
    if (dataUrl === null) {
      toast.error(t('nebula.export.failed'))
      return
    }
    try {
      const anchor = document.createElement('a')
      anchor.href = dataUrl
      anchor.download = `cortex-nebula-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      toast.success(t('nebula.export.success'))
    } catch {
      toast.error(t('nebula.export.failed'))
    }
  }, [t])

  const handleToggleFocusMode = useCallback(() => {
    setFocusMode((value) => !value)
  }, [])

  const handleChangeFocusDepth = useCallback((depth: 1 | 2) => {
    setFocusDepth(depth)
  }, [])

  /* ------------------------------------------------------------ status card -- */

  const totalNodes = graph?.nodes.length ?? 0
  const databaseEmpty = (allGraph?.nodes.length ?? 0) === 0

  let statusCard: StatusCard | null = null
  if (error !== null && graph === null) {
    statusCard = {
      title: t('nebula.error.title'),
      description: error,
      actionLabel: t('nebula.error.retry'),
      onAction: handleRefresh,
      tone: 'danger'
    }
  } else if (loading && graph === null) {
    statusCard = {
      title: t('nebula.loading.graph'),
      description: t('nebula.subtitle'),
      tone: 'neutral'
    }
  } else if (pendingTarget) {
    const targetEmpty =
      (scopeKind === 'asset' && hostOptions.length === 0) ||
      (scopeKind === 'task' && sessionOptions.length === 0)
    statusCard = targetEmpty
      ? {
          title:
            scopeKind === 'asset' ? t('nebula.scope.assetEmpty') : t('nebula.scope.taskEmpty'),
          description: t('nebula.empty.databaseDescription'),
          tone: 'neutral'
        }
      : scopeKind === 'asset'
        ? {
            title: t('nebula.empty.assetTargetTitle'),
            description: t('nebula.empty.assetTargetDescription'),
            tone: 'neutral'
          }
        : {
            title: t('nebula.empty.taskTargetTitle'),
            description: t('nebula.empty.taskTargetDescription'),
            tone: 'neutral'
          }
  } else if (graph !== null && totalNodes === 0) {
    statusCard =
      scope.kind === 'all' && databaseEmpty
        ? {
            title: t('nebula.empty.databaseTitle'),
            description: t('nebula.empty.databaseDescription'),
            actionLabel: t('nebula.refresh'),
            onAction: handleRefresh,
            tone: 'neutral'
          }
        : {
            title: t('nebula.empty.title'),
            description: t('nebula.empty.description'),
            actionLabel: scope.kind === 'all' ? t('nebula.refresh') : t('nebula.empty.resetFilters'),
            onAction: scope.kind === 'all' ? handleRefresh : handleResetFilters,
            tone: 'neutral'
          }
  } else if (query.length > 0 && matchIds.length === 0) {
    statusCard = {
      title: t('nebula.empty.noMatchTitle'),
      description: t('nebula.empty.noMatchDescription'),
      actionLabel: t('nebula.empty.clearSearch'),
      onAction: handleClearSearch,
      tone: 'neutral'
    }
  } else if (visibleGraph !== null && visibleGraph.nodes.length === 0) {
    statusCard = {
      title: t('nebula.empty.filteredTitle'),
      description: t('nebula.empty.filteredDescription'),
      actionLabel: t('nebula.empty.resetFilters'),
      onAction: handleResetFilters,
      tone: 'neutral'
    }
  }

  const scopeOptions = useMemo<GraphScopeOption[]>(
    () => [
      { kind: 'all', count: allGraph === null ? null : allGraph.nodes.length },
      { kind: 'asset', count: scopeKind === 'asset' ? totalNodes : null },
      { kind: 'task', count: scopeKind === 'task' ? totalNodes : null }
    ],
    [allGraph, scopeKind, totalNodes]
  )

  /* ----------------------------------------------------------------- render -- */

  const showGraph = visibleGraph !== null && !pendingTarget

  return (
    <section
      ref={sectionRef}
      aria-label={t('nebula.title')}
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundColor: NEBULA_BACKGROUND }}
    >
      {showGraph ? (
        <NebulaGraph
          ref={graphRef}
          nodes={visibleGraph.nodes}
          links={visibleGraph.links}
          selectedId={selectedId}
          highlightIds={highlightIds}
          focusIds={focusIds}
          performanceMode={performanceMode}
          autoRotate={!reducedMotion}
          onSelect={handleSelectNode}
          className="absolute inset-0"
        />
      ) : null}

      {/* P3 canvas toolbar: fullscreen + PNG export. */}
      <div
        className={cn(
          'absolute top-4 z-20 flex items-center gap-1.5',
          selectedNode !== null ? 'right-[416px]' : 'right-4'
        )}
      >
        <button
          type="button"
          onClick={handleToggleFullscreen}
          aria-label={
            isFullscreen ? t('nebula.fullscreen.exit') : t('nebula.fullscreen.enter')
          }
          title={isFullscreen ? t('nebula.fullscreen.exit') : t('nebula.fullscreen.enter')}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#0b0c10]/[0.72] text-white/60 backdrop-blur-xl transition-colors hover:bg-white/[0.08] hover:text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#050505]"
        >
          {isFullscreen ? (
            <Minimize2 aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={handleExportPng}
          disabled={!showGraph}
          aria-label={t('nebula.export.png')}
          title={t('nebula.export.png')}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#0b0c10]/[0.72] text-white/60 backdrop-blur-xl transition-colors hover:bg-white/[0.08] hover:text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#050505] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Camera aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>

      {loading && graph !== null ? (
        <div className="pointer-events-none absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-[#0b0c10]/[0.82] px-3 py-1.5 text-[11px] text-white/60 backdrop-blur-xl">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          {t('nebula.loading.graph')}
        </div>
      ) : null}

      {statusCard !== null ? (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center px-6">
          <div className="pointer-events-auto max-w-[380px] rounded-xl border border-white/10 bg-[#0b0c10]/[0.82] px-6 py-5 text-center shadow-[0_24px_60px_-24px_rgba(0,0,0,0.85)] backdrop-blur-xl">
            {statusCard.tone === 'danger' ? (
              <AlertTriangle
                aria-hidden="true"
                className="mx-auto mb-2 h-4 w-4 text-amber-300/80"
              />
            ) : null}
            <p className="text-[13px] font-medium text-white/85">{statusCard.title}</p>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/45">
              {statusCard.description}
            </p>
            {statusCard.actionLabel !== undefined && statusCard.onAction !== undefined ? (
              <button
                type="button"
                onClick={statusCard.onAction}
                className="mt-4 inline-flex h-8 items-center rounded-md border border-white/[0.12] bg-white/[0.06] px-3 text-[12px] text-white/75 transition-colors hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#050505]"
              >
                {statusCard.actionLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="absolute left-4 top-4 z-20 w-[304px] max-w-[calc(100%-2rem)]">
        <GraphControlPanel
          scopes={scopeOptions}
          activeScopeKind={scopeKind}
          onScopeChange={handleScopeChange}
          hostOptions={hostOptions}
          sessionOptions={sessionOptions}
          activeHostPort={activeHostPort}
          activeSessionId={activeSessionId}
          onSelectHost={handleSelectHost}
          onSelectSession={handleSelectSession}
          includeChildren={includeChildren}
          onToggleIncludeChildren={handleToggleIncludeChildren}
          search={search}
          onSearchChange={setSearch}
          onSearchClear={handleClearSearch}
          filters={filters}
          onToggleFilter={handleToggleFilter}
          counts={
            visibleGraph?.meta.counts ?? {
              project: 0,
              target: 0,
              host: 0,
              vuln: 0,
              leak: 0,
              snapshot: 0
            }
          }
          visibleNodes={visibleGraph?.nodes.length ?? 0}
          visibleLinks={visibleGraph?.links.length ?? 0}
          matchCount={matchCount}
          onResetView={handleResetView}
          onRefresh={handleRefresh}
          loading={loading}
          truncated={graph?.meta.truncated ?? false}
          limits={graph?.meta.limits ?? MEMORY_GRAPH_DEFAULT_LIMITS}
          focusMode={focusMode}
          focusDepth={focusDepth}
          focusCount={focusCount}
          onToggleFocusMode={handleToggleFocusMode}
          onChangeFocusDepth={handleChangeFocusDepth}
          performanceMode={performanceMode}
        />
      </div>

      <div
        className={cn(
          'absolute bottom-4 z-20 hidden max-w-[calc(100%-2rem)] md:block',
          legendOpen ? 'left-[332px]' : 'left-4'
        )}
      >
        <GraphLegend
          expanded={legendOpen}
          onToggle={() => setLegendOpen((value) => !value)}
          hasAggregates={visibleGraph !== null && graphHasAggregates(visibleGraph.nodes)}
        />
      </div>

      <p className="pointer-events-none absolute bottom-5 right-4 z-20 hidden font-mono text-[10.5px] text-white/25 lg:block">
        {t('nebula.helper.hint')}
      </p>

      {selectedNode ? (
        <div className="absolute inset-y-0 right-0 z-30 w-[400px] max-w-[92vw]">
          <NodeInspector
            node={selectedNode}
            neighbors={neighbors}
            onClose={() => setSelectedId(null)}
            onSelectNode={handleInspectorSelect}
            detailLabel={detailLabel}
            onOpenDetail={() => {
              if (detailTarget !== null) onOpenDetail(detailTarget)
            }}
          />
        </div>
      ) : null}
    </section>
  )
}
