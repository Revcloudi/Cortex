import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Camera,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  Minimize2
} from 'lucide-react'
import { toast } from 'sonner'
import {
  MEMORY_GRAPH_DEFAULT_LIMITS,
  collectNeighborhoodIds,
  collectNeighbors,
  filterGraph,
  graphHasAggregates,
  nodeMatchesQuery,
  type GraphFilters,
  type GraphRouteOverlay,
  type MemoryGraphData,
  type MemoryGraphScope
} from '@shared/graph'
import type { RealmFilter } from '@shared/types'
import {
  GraphControlPanel,
  type GraphRouteOption,
  type GraphScopeOption,
  type GraphScopeTargetOption,
  type FilterKey
} from '@renderer/components/nebula/GraphControlPanel'
import { GraphLegend } from '@renderer/components/nebula/GraphLegend'
import {
  HudBackdrop,
  HudButton,
  HudDivider,
  HudPanel,
  HudSectionTitle,
  HudStat,
  HudStatusDot
} from '@renderer/components/nebula/HudChrome'
import { NebulaGraph, type NebulaGraphHandle } from '@renderer/components/nebula/NebulaGraph'
import { NodeInspector } from '@renderer/components/nebula/NodeInspector'
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import {
  NEBULA_BACKGROUND,
  NEBULA_UI,
  PERFORMANCE_MODE_ELEMENT_LIMIT
} from '@renderer/lib/graphTheme'
import type { AppDetailTarget } from '@renderer/lib/navigation'
import { cn } from '@renderer/lib/utils'
import { useI18n } from '@renderer/i18n'

/**
 * Memory Nebula — full-bleed J.A.R.V.I.S. tactical HUD over one 3D canvas
 * (three scopes, P2 live data).
 *
 * The page still owns scope/search/filter/selection state and reads the
 * read-only projection through `getApi().getMemoryGraph(scope)` (Electron IPC
 * or the `ctx web` HTTP transport, same `CortexApi` contract). The all-scope
 * graph is cached so the asset/task pickers can list real hosts and snapshot
 * sessions without a second endpoint.
 *
 * Layout contract (reference `1.html`):
 *   canvas (z-0) → <HudBackdrop /> (z-10, pointer-events-none) → HUD chrome
 *   (z-20) → status card / inspector (z-30). The left command column is a
 *   pointer-events-none wrapper so the brand panel never steals canvas drags;
 *   only the interactive console opts back into pointer events.
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

/**
 * The expanded legend only has room between the control column and the
 * inspector on ≥1280px viewports; narrower windows fall back to the collapsed
 * pill while the drawer is open so the two panels never overlap.
 */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1279px)')
    const sync = (): void => setNarrow(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])
  return narrow
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
  /** Last loaded Web all-scope graph: powers the asset/task pickers. */
  const allGraphRef = useRef<MemoryGraphData | null>(null)
  /** Route-id cache: cleared on realm/scope switch, re-armed by choosing a route. */
  const routeClearedRef = useRef(false)
  /**
   * Translator ref for the data effect: the graph payload must NOT be refetched
   * when the UI language switches (that re-ran the force simulation and reset
   * the camera). `t` is only used for error copy, so read it through a ref.
   */
  const tRef = useRef(t)
  tRef.current = t
  const narrowViewport = useNarrowViewport()

  const [scopeKind, setScopeKind] = useState<ScopeKind>('all')
  const [activeHostPort, setActiveHostPort] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [includeChildren, setIncludeChildren] = useState(false)
  /** Logical realm: Web by default (plan §7.2), kept while switching scope. */
  const [realm, setRealm] = useState<RealmFilter>('web')
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS)
  /** Pivot route overlay: toggle + selected route (plan §7.3). */
  const [attackPathEnabled, setAttackPathEnabled] = useState(true)
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
  /** Left command column can slide fully off-canvas for an unobstructed map. */
  const [hudCollapsed, setHudCollapsed] = useState(false)
  /**
   * Motion switch: ON by default (breathing / slow rotation / flow particles)
   * and persisted across reloads. Users who prefer reduced motion can switch it
   * off with the HUD toolbar button; the explicit choice is remembered.
   */
  const [motionEnabled, setMotionEnabled] = useState<boolean>(() => {
    try {
      // v2 key: an older persisted "off" from the previous HUD toggle must not
      // turn the default slow auto-rotation off for new users of the port.
      const stored = window.localStorage.getItem('cortex.nebula.motion.v2')
      return stored === null ? true : stored === '1'
    } catch {
      return true
    }
  })

  const handleToggleHud = useCallback(() => {
    setHudCollapsed((value) => !value)
  }, [])

  const handleToggleMotion = useCallback(() => {
    setMotionEnabled((current) => {
      const next = !current
      try {
        window.localStorage.setItem('cortex.nebula.motion.v2', next ? '1' : '0')
      } catch {
        /* private mode / storage disabled: the toggle still works for this session */
      }
      return next
    })
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
      setError(apiUnavailableMessage(tRef.current))
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
        // The displayed graph follows the realm switch; only the Web realm graph
        // is cached for the asset/task pickers (internal / all add no targets).
        const current = await client.getMemoryGraph({ scope, realm })
        if (cancelled) return
        setGraph(current)
        if (scope.kind === 'all' && realm === 'web') {
          allGraphRef.current = current
          setAllGraph(current)
        } else if (allGraphRef.current === null) {
          const all = await client.getMemoryGraph({ scope: { kind: 'all' }, realm: 'web' })
          if (cancelled) return
          allGraphRef.current = all
          setAllGraph(all)
        }
      } catch (cause) {
        if (!cancelled) setError(toErrorMessage(cause, tRef.current))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scope, realm, pendingTarget, dataVersion, refreshSeq])

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

  /* ---------------------------------------------------- attack path overlay -- */

  /** Pivot routes carried by the current graph (internal / all realms only). */
  const routes = useMemo<readonly GraphRouteOverlay[]>(
    () => visibleGraph?.routes ?? [],
    [visibleGraph]
  )

  // Keep the selection valid: a route can disappear on refresh / realm switch.
  // Clearing the overlay is respected until the realm or scope changes.
  useEffect(() => {
    if (routes.length === 0) {
      if (selectedRouteId !== null) setSelectedRouteId(null)
      return
    }
    if (routeClearedRef.current) return
    if (selectedRouteId === null || !routes.some((route) => route.id === selectedRouteId)) {
      setSelectedRouteId(routes[0]?.id ?? null)
    }
  }, [routes, selectedRouteId])

  const selectedRoute = useMemo<GraphRouteOverlay | null>(
    () =>
      selectedRouteId === null
        ? null
        : (routes.find((route) => route.id === selectedRouteId) ?? null),
    [routes, selectedRouteId]
  )

  /** Ordered route node ids passed to the canvas (only when the overlay is on). */
  const routeNodeIds = useMemo<string[] | null>(
    () => (attackPathEnabled && selectedRoute !== null ? selectedRoute.node_ids : null),
    [attackPathEnabled, selectedRoute]
  )

  /**
   * Link keys (`source|target`, matching the stored link direction) for the
   * route's consecutive node pairs. Resolving against the real links keeps the
   * 3D batched tint and the 2D fallback in sync even if a relation is reversed.
   */
  const routeLinkKeys = useMemo<string[] | null>(() => {
    if (visibleGraph === null || routeNodeIds === null || routeNodeIds.length < 2) return null
    const keys = new Set<string>()
    for (let index = 0; index < routeNodeIds.length - 1; index += 1) {
      const from = routeNodeIds[index]
      const to = routeNodeIds[index + 1]
      const link = visibleGraph.links.find(
        (candidate) =>
          (candidate.source === from && candidate.target === to) ||
          (candidate.source === to && candidate.target === from)
      )
      keys.add(link === undefined ? `${from}|${to}` : `${link.source}|${link.target}`)
    }
    return [...keys]
  }, [visibleGraph, routeNodeIds])

  const routeOptions = useMemo<GraphRouteOption[]>(
    () =>
      routes.map((route) => ({
        value: route.id,
        label: `${route.label} · ${t(`nebula.footholdStatus.${route.status}`)}`
      })),
    [routes, t]
  )

  /* ------------------------------------------------------- tactical HUD data -- */

  /**
   * Critical count comes from the loaded graph, never from a hardcoded number:
   * a `+N` aggregate node carries the highest severity of its bucket, so both
   * granular and aggregated vulnerability nodes count exactly once.
   */
  const criticalCount = useMemo(() => {
    if (graph === null) return 0
    let total = 0
    for (const node of graph.nodes) {
      if (node.type !== 'vuln') continue
      const severity = node.data.aggregate?.severity ?? node.severity
      if (severity === 'Critical') total += 1
    }
    return total
  }, [graph])

  const metaCounts = graph?.meta.counts ?? null
  const statValue = (value: number | null): string | number => (value === null ? '—' : value)
  const statHosts = statValue(metaCounts === null ? null : metaCounts.host)
  const statVulns = statValue(metaCounts === null ? null : metaCounts.vuln)
  const statLeaks = statValue(metaCounts === null ? null : metaCounts.leak)
  const statSnapshots = statValue(metaCounts === null ? null : metaCounts.snapshot)
  const statCritical = statValue(graph === null ? null : criticalCount)

  // Status dot: offline (error) → syncing (loading) → degraded (truncated) →
  // online. A refresh keeps the previous graph on screen, so loading wins.
  const hudStatusTone: 'cyan' | 'warning' | 'danger' =
    error !== null
      ? 'danger'
      : loading
        ? 'warning'
        : graph?.meta.truncated === true
          ? 'warning'
          : 'cyan'
  const hudStatusLabel =
    error !== null
      ? t('nebula.hud.subtitleError')
      : loading
        ? t('nebula.hud.subtitleLoading')
        : graph?.meta.truncated === true
          ? t('nebula.hud.subtitleDegraded')
          : t('nebula.hud.subtitleOnline')

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

  /** A scope/realm change invalidates the selected pivot route. */
  const resetAttackPathSelection = useCallback(() => {
    routeClearedRef.current = false
    setSelectedRouteId(null)
  }, [])

  const handleScopeChange = useCallback(
    (kind: ScopeKind) => {
      setScopeKind(kind)
      setSelectedId(null)
      resetAttackPathSelection()
      graphRef.current?.resetView()
    },
    [resetAttackPathSelection]
  )

  const handleRealmChange = useCallback(
    (next: RealmFilter) => {
      if (next === realm) return
      setRealm(next)
      setSelectedId(null)
      resetAttackPathSelection()
      graphRef.current?.resetView()
    },
    [realm, resetAttackPathSelection]
  )

  const handleToggleAttackPath = useCallback(() => {
    setAttackPathEnabled((value) => !value)
  }, [])

  const handleSelectRoute = useCallback((routeId: string) => {
    routeClearedRef.current = false
    setSelectedRouteId(routeId)
  }, [])

  const handleClearRoute = useCallback(() => {
    // Respect an explicit clear: do not auto-select the first route again.
    routeClearedRef.current = true
    setSelectedRouteId(null)
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

  const handleToggleFilter = useCallback((key: FilterKey) => {
    setFilters((current) => {
      // Optional internal filters are visible by default: a toggle flips that.
      const next = { ...current }
      next[key] = current[key] === false
      return next
    })
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

  // DSH embedded view: the Browser Fullscreen API enters fullscreen but its exit
  // is routed by the host shell, so the page could never restore its layout.
  // Use an in-page full-viewport overlay instead; Escape also restores it.
  useEffect(() => {
    if (!isFullscreen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isFullscreen])

  const handleToggleFullscreen = useCallback(() => {
    setIsFullscreen((value) => !value)
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
      {
        kind: 'all',
        // The active tab shows the true node count of the loaded realm graph;
        // inactive tabs fall back to the cached Web all-scope count.
        count:
          scopeKind === 'all'
            ? totalNodes
            : allGraph === null
              ? null
              : allGraph.nodes.length
      },
      { kind: 'asset', count: scopeKind === 'asset' ? totalNodes : null },
      { kind: 'task', count: scopeKind === 'task' ? totalNodes : null }
    ],
    [allGraph, scopeKind, totalNodes]
  )

  /* ----------------------------------------------------------------- render -- */

  const showGraph = visibleGraph !== null && !pendingTarget
  const legendExpanded = legendOpen && !(selectedNode !== null && narrowViewport)

  return (
    <section
      ref={sectionRef}
      aria-label={t('nebula.title')}
      data-dsh-fullscreen={isFullscreen ? 'true' : undefined}
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundColor: NEBULA_BACKGROUND }}
    >
      {/* ------------------------------------------------------------- scene -- */}
      {showGraph ? (
        <NebulaGraph
          ref={graphRef}
          nodes={visibleGraph.nodes}
          links={visibleGraph.links}
          selectedId={selectedId}
          highlightIds={highlightIds}
          focusIds={focusIds}
          performanceMode={performanceMode}
          routeNodeIds={routeNodeIds}
          routeLinkKeys={routeLinkKeys}
          autoRotate={motionEnabled}
          reducedMotion={!motionEnabled}
          onSelect={handleSelectNode}
          className="absolute inset-0"
        />
      ) : null}

      {/* Decorative grid / scanline / corners sit above the canvas (never below
          the HUD chrome) and never intercept orbit gestures. */}
      <HudBackdrop />

      {/* ------------------------------------------------------- loading pill -- */}
      {/* Centred on the *canvas* area (left/right padding match the command
          column and the drawer), so it never slides under either panel; with
          the drawer open the gap is too narrow below 1280px, so the pill only
          appears there on wide windows. */}
      {loading && graph !== null ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center',
            hudCollapsed ? 'pl-4' : 'pl-[320px]',
            selectedNode === null ? 'flex' : 'hidden pr-[416px] xl:flex'
          )}
        >
          <div
            className={cn(
              'flex items-center gap-2 rounded-[2px] border border-[#00E5FF]/30 bg-[#020A14]/85 px-3 py-1',
              'font-mono text-[11px] uppercase tracking-[0.04em] text-[#00E5FF] backdrop-blur-md'
            )}
          >
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {t('nebula.loading.graph')}
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------- top-right toolbar -- */}
      {/* With the drawer open the toolbar becomes a vertical rail hugging the
          400px inspector edge; that keeps it clear of the command column even
          at 1024px, where the horizontal layout would overhang the panel. */}
      <div
        className={cn(
          'absolute top-4 z-20 flex',
          selectedNode !== null ? 'right-[416px]' : 'right-4'
        )}
      >
        <div
          className={cn(
            'flex gap-1 rounded-[2px] border border-[#00E5FF]/25 bg-[#020A14]/80 p-1 backdrop-blur-md',
            'shadow-[0_0_20px_-8px_rgba(0,229,255,0.5)]',
            selectedNode !== null ? 'flex-col' : 'flex-row'
          )}
        >
          <HudButton
            size="icon"
            onClick={handleToggleMotion}
            aria-pressed={motionEnabled}
            aria-label={motionEnabled ? t('nebula.hud.motionOn') : t('nebula.hud.motionOff')}
            title={motionEnabled ? t('nebula.hud.motionOn') : t('nebula.hud.motionOff')}
            data-testid="motion-toggle"
            className={cn(
              motionEnabled
                ? 'text-[#00E5FF]'
                : 'border-[#FFAA00]/60 text-[#FFAA00] hover:border-[#FFAA00]/80 hover:text-[#FFC766]'
            )}
          >
            <Activity aria-hidden="true" className="h-3.5 w-3.5" />
          </HudButton>
          <HudButton
            size="icon"
            onClick={handleToggleFullscreen}
            aria-label={isFullscreen ? t('nebula.fullscreen.exit') : t('nebula.fullscreen.enter')}
            title={isFullscreen ? t('nebula.fullscreen.exit') : t('nebula.fullscreen.enter')}
            data-testid="fullscreen"
          >
            {isFullscreen ? (
              <Minimize2 aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </HudButton>
          <HudButton
            size="icon"
            onClick={handleExportPng}
            disabled={!showGraph}
            aria-label={t('nebula.export.png')}
            title={t('nebula.export.png')}
            data-testid="export"
          >
            <Camera aria-hidden="true" className="h-3.5 w-3.5" />
          </HudButton>
        </div>
      </div>

      {/* --------------------------------------------------- left command column -- */}
      {/* pointer-events-none wrapper: the tactical header must not swallow canvas
          drags; the console below opts back in with pointer-events-auto. The
          whole column can slide off-canvas so the map gets the full viewport. */}
      <div
        inert={hudCollapsed}
        aria-hidden={hudCollapsed}
        data-testid="hud-column"
        className={cn(
          'pointer-events-none absolute bottom-4 left-4 top-4 z-20 flex w-[304px] max-w-[calc(100%_-_2rem)] flex-col gap-2',
          'transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none',
          hudCollapsed
            ? '-translate-x-[calc(100%_+_1.5rem)] opacity-0'
            : 'translate-x-0 opacity-100'
        )}
      >
        <HudPanel className="pointer-events-none relative shrink-0 px-3 py-2.5">
          <HudButton
            size="icon"
            onClick={handleToggleHud}
            aria-label={t('nebula.hud.collapsePanel')}
            title={t('nebula.hud.collapsePanel')}
            data-testid="hud-collapse"
            className="pointer-events-auto absolute right-2 top-2 h-6 w-6 text-[#7FA9BE]"
          >
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
          </HudButton>
          <h1
            className="truncate pr-8 font-mono text-[22px] font-semibold uppercase leading-none tracking-[0.06em] text-[#00E5FF]"
            style={{ textShadow: '0 0 10px rgba(0, 229, 255, 0.5)' }}
          >
            {t('nebula.hud.brand')}
          </h1>
          <div className="mt-2 flex min-w-0 items-center gap-1.5">
            <HudStatusDot tone={hudStatusTone} />
            <p
              className={cn(
                NEBULA_UI.muted,
                'min-w-0 truncate text-[11.5px] uppercase tracking-[0.03em]'
              )}
            >
              {hudStatusLabel}
            </p>
          </div>

          <HudDivider className="my-2" />
          <HudSectionTitle trailing={<span className="text-[#7FA9BE]">{t('nebula.hud.liveFeed')}</span>}>
            {t('nebula.hud.system')}
          </HudSectionTitle>

          {/* Live stats: every number is derived from graph.meta.counts + the
              Critical severity of the loaded vuln nodes. */}
          <div data-testid="hud-stats" className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
            <HudStat label={t('nebula.hud.statHosts')} value={statHosts} tone="cyan" />
            <HudStat label={t('nebula.hud.statVulns')} value={statVulns} />
            <HudStat label={t('nebula.hud.statLeaks')} value={statLeaks} tone="white" />
            <HudStat label={t('nebula.hud.statSnapshots')} value={statSnapshots} tone="success" />
          </div>
          <HudDivider className="my-1.5" />
          <HudStat
            label={
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 rounded-full bg-[#FF3366] shadow-[0_0_8px_rgba(255,51,102,0.8)]"
                />
                {t('nebula.hud.statCritical')}
              </span>
            }
            value={statCritical}
            tone="danger"
          />
        </HudPanel>

        <div className="pointer-events-none flex min-h-0 flex-1">
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
            realm={realm}
            onRealmChange={handleRealmChange}
            search={search}
            onSearchChange={setSearch}
            onSearchClear={handleClearSearch}
            filters={filters}
            onToggleFilter={handleToggleFilter}
            attackPathEnabled={attackPathEnabled}
            onToggleAttackPath={handleToggleAttackPath}
            routeCount={routes.length}
            routeOptions={routeOptions}
            selectedRouteId={selectedRouteId}
            onSelectRoute={handleSelectRoute}
            onClearRoute={handleClearRoute}
            counts={
              visibleGraph?.meta.counts ?? {
                project: 0,
                target: 0,
                host: 0,
                vuln: 0,
                leak: 0,
                snapshot: 0,
                foothold: 0,
                internal_host: 0,
                internal_service: 0
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
      </div>

      {/* Edge tab that brings the command column back after collapsing it. */}
      {hudCollapsed ? (
        <button
          type="button"
          onClick={handleToggleHud}
          aria-label={t('nebula.hud.expandPanel')}
          title={t('nebula.hud.expandPanel')}
          data-testid="hud-expand"
          className={cn(
            'absolute left-0 top-1/2 z-30 -translate-y-1/2',
            'flex h-16 w-6 items-center justify-center rounded-r-[3px] border border-l-0 border-[#00E5FF]/40',
            'bg-[#020A14]/85 font-mono text-[#00E5FF] shadow-[0_0_18px_-6px_rgba(0,229,255,0.6)] backdrop-blur-md',
            'transition-colors hover:bg-[#00E5FF]/[0.12] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#00E5FF]/70'
          )}
        >
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}

      {/* ------------------------------------------------------------ status card -- */}
      {/* Same canvas-area centring as the loading pill, so the empty/error card
          never sits on top of the command column or the inspector. */}
      {statusCard !== null ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 top-1/2 z-30 flex -translate-y-1/2 justify-center pr-4',
            hudCollapsed ? 'pl-4' : 'pl-[320px]',
            selectedNode === null ? '' : 'pr-[416px]'
          )}
        >
          <HudPanel
            className={cn(
              'pointer-events-auto w-full px-5 py-4 text-center',
              selectedNode === null ? 'max-w-[380px]' : 'max-w-[280px]'
            )}
          >
            {statusCard.tone === 'danger' ? (
              <AlertTriangle
                aria-hidden="true"
                className="mx-auto mb-2 h-4 w-4 text-[#FFAA00]"
              />
            ) : null}
            <p className={cn(NEBULA_UI.heading, 'text-[12.5px] font-semibold tracking-[0.04em]')}>
              {statusCard.title}
            </p>
            <p className={cn(NEBULA_UI.muted, 'mt-1.5 text-[12px] leading-relaxed')}>
              {statusCard.description}
            </p>
            {statusCard.actionLabel !== undefined && statusCard.onAction !== undefined ? (
              <HudButton
                variant="primary"
                size="sm"
                onClick={statusCard.onAction}
                className="mt-3 text-[11px]"
              >
                {statusCard.actionLabel}
              </HudButton>
            ) : null}
          </HudPanel>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- legend -- */}
      {/* Anchored to the bottom-left of the canvas area (right of the command
          column) so the pill and the expanded card never sit on the console.
          While the inspector is open below 1280px the gap is too narrow, so the
          legend stays hidden there instead of overlapping the drawer. */}
      <div
        className={cn(
          'absolute bottom-4 z-20 max-w-[calc(100%_-_2rem)]',
          hudCollapsed ? 'left-4' : 'left-[324px]',
          legendExpanded ? 'w-[300px]' : 'w-auto',
          selectedNode !== null ? 'hidden xl:block' : 'block'
        )}
      >
        <GraphLegend
          expanded={legendExpanded}
          onToggle={() => setLegendOpen((value) => !value)}
          hasAggregates={visibleGraph !== null && graphHasAggregates(visibleGraph.nodes)}
          className={legendExpanded ? 'max-w-full' : undefined}
        />
      </div>

      {/* ------------------------------------------------------------- inspector -- */}
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
