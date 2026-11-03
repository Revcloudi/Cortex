import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes
} from 'react'
import ForceGraph3DImport from 'react-force-graph-3d'
import * as THREE from 'three'
import { aggregateInfoOf, type GraphRelation, type NebulaLink, type NebulaNode } from '@shared/graph'
import { HudButton } from '@renderer/components/nebula/HudChrome'
import { NebulaGraph2D } from '@renderer/components/nebula/NebulaGraph2D'
import { NebulaLabelLayer, type NebulaLabelDatum } from '@renderer/components/nebula/nebulaLabels'
import { useI18n } from '@renderer/i18n'
import {
  AUTO_ROTATE_RESUME_MS,
  AUTO_ROTATE_SPEED,
  CAMERA_FOCUS_MS,
  CAMERA_FOV,
  CAMERA_LOD_FAR,
  CAMERA_LOD_NEAR,
  CAMERA_RESET_MS,
  DEFAULT_CAMERA_ELEVATION,
  DEFAULT_CAMERA_DISTANCE,
  DIM_OPACITY,
  EMPHASIS_OPACITY,
  FLOW_PARTICLE_COLOR,
  FOCUS_DIM_OPACITY,
  FOG_DENSITY,
  HOVER_CONTEXT_DIM_OPACITY,
  HUD,
  LABEL,
  LINK_COLORS,
  LINK_DIM_OPACITY,
  LINK_HIGHLIGHT_OPACITY,
  NEBULA_BACKGROUND,
  NEBULA_UI,
  NODE_BREATHE_AMPLITUDE,
  NODE_BREATHE_SPEED,
  NODE_HOVER_SCALE,
  NODE_SPIN_SPEED,
  PERFORMANCE_SELECTED_HALO_OPACITY,
  STARFIELD_RADIUS,
  blendOnCanvas,
  labelVariantOf,
  linkOpacity,
  nodeColor,
  nodeCoreRadius,
  nodeGlowScale,
  nodeLabelPriority,
  nodeRadius
} from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'
import {
  FlowParticles,
  GridFloor,
  Starfield,
  coreSphereGeometry,
  glowTexture,
  haloRingGeometry,
  hashUnit,
  shellLineGeometry,
  type FlowRoute,
  type GeometryDetail
} from './nebulaSceneFx'

/**
 * Imperative camera/selection API exposed to `NebulaPage`. All Three.js objects
 * stay inside this component; the page never touches a scene graph.
 */
export interface NebulaGraphHandle {
  /** Fly the camera to a node (800ms); no-op when the node is not rendered. */
  focusNode(nodeId: string): void
  /** Restore the default framing of the whole graph. */
  resetView(): void
  /** Fit all currently rendered nodes into the frustum. */
  zoomToFit(): void
  /** Current WebGL frame as a PNG data URL (null when the canvas is unavailable). */
  captureImage(): string | null
}

export interface NebulaGraphProps {
  /** Already filtered by the page (type filters applied). */
  nodes: NebulaNode[]
  links: NebulaLink[]
  selectedId: string | null
  /** Search matches; `null` means "no active search" (nothing is dimmed). */
  highlightIds: string[] | null
  /** Focus neighbourhood; `null` means "no focus mode" (nothing is dimmed). */
  focusIds: string[] | null
  /** Large-graph mode: no idle labels, halos only for the selected node. */
  performanceMode: boolean
  /** Auto-rotation is already reduced-motion aware upstream. */
  autoRotate: boolean
  /**
   * Page-level motion switch. When provided it overrides the OS
   * `prefers-reduced-motion` preference so the HUD toggle can opt in/out.
   */
  reducedMotion?: boolean
  onSelect: (nodeId: string | null) => void
  /**
   * Optional live label counter for HUD status lines: how many projected DOM
   * labels are currently on screen out of the total label count.
   */
  onLabelStats?: (visible: number, total: number) => void
  className?: string
}

/* ---------------------------------------------------------------- internals -- */

/** Nodes as the force engine sees them: positions are injected at runtime. */
type GraphNode = NebulaNode & { x?: number; y?: number; z?: number }
/** Links carry string ids until the simulation replaces them with node objects. */
type GraphLink = NebulaLink & { source: string | GraphNode; target: string | GraphNode }

interface Coords {
  x: number
  y: number
  z: number
}

const ORIGIN: Coords = { x: 0, y: 0, z: 0 }

interface OrbitControlsLike {
  autoRotate: boolean
  autoRotateSpeed: number
  enableDamping: boolean
  /** Current orbit center; set through `cameraPosition(pos, lookAt)`. */
  target?: { x: number; y: number; z: number }
}

interface ForceLike {
  strength(value: number | ((node: unknown) => number)): unknown
  distance?(value: number | ((link: unknown) => number)): unknown
}

/**
 * Minimal slice of the kapsule instance we drive. The library ships hand-written
 * types that do not cover every accessor consistently across versions, so this
 * is the single documented boundary between our code and `3d-force-graph`.
 */
interface GraphController {
  cameraPosition(): Coords
  cameraPosition(position: Partial<Coords>, lookAt?: Coords, transitionMs?: number): unknown
  /** Live camera (POS, controls target and LOD math), added for the DOM labels. */
  camera(): THREE.Camera
  controls(): OrbitControlsLike
  d3ReheatSimulation(): unknown
  d3Force(name: string): ForceLike | undefined
  scene(): THREE.Scene
}

interface ForceGraphProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] }
  width: number
  height: number
  backgroundColor: string
  showNavInfo: boolean
  nodeId: string
  nodeVal: (node: GraphNode) => number
  /** The library's DOM tooltip is redundant with our projected DOM labels. */
  nodeLabel: () => string
  /** Keep the drawing buffer so PNG export can read the frame. */
  rendererConfig: { preserveDrawingBuffer: boolean; antialias: boolean }
  /**
   * Init prop. The library defaults to TrackballControls, which has no
   * `autoRotate`; the HUD holo-table needs OrbitControls (reference demo) for
   * the slow auto-rotation + damping semantics below.
   */
  controlType: 'orbit'
  enableNodeDrag: boolean
  warmupTicks: number
  cooldownTicks: number
  d3AlphaDecay: number
  nodeThreeObject: (node: GraphNode) => THREE.Object3D
  /**
   * Links are rendered by our own batched `LineSegments` layer (one draw call,
   * per-edge vertex colours); hiding the library's per-link objects avoids
   * duplicate geometry + per-frame work.
   */
  linkVisibility: (link: GraphLink) => boolean
  onNodeClick: (node: GraphNode, event: MouseEvent) => void
  onNodeHover: (node: GraphNode | null, previousNode: GraphNode | null) => void
  onBackgroundClick: () => void
  onEngineStop: () => void
}

const ForceGraph3D = ForceGraph3DImport as unknown as ForwardRefExoticComponent<
  ForceGraphProps & RefAttributes<GraphController>
>

/** Above this many graph elements we surface the heavy-graph HUD banner. */
const HEAVY_GRAPH_ELEMENT_LIMIT = 800
/** Fallback re-frame if the simulation never reports stopping (old behaviour). */
const AUTO_FIT_FALLBACK_MS = 3200
/** LOD is recomputed at ~4 Hz, not every frame (camera damping is smooth). */
const LOD_CHECK_INTERVAL_MS = 240
/** Camera-distance LOD turns the DOM labels / leaves down when far away. */
const LOD_FAR_DISTANCE = DEFAULT_CAMERA_DISTANCE * CAMERA_LOD_FAR
const LOD_NEAR_DISTANCE = DEFAULT_CAMERA_DISTANCE * CAMERA_LOD_NEAR

/** Shared HUD white used to brighten selected/hovered wireframes + rings. */
const EMPHASIS_COLOR = new THREE.Color(HUD.white)

/**
 * `nebulaLabels.ts` makes its overlay `pointer-events: none` so drags/wheel pass
 * through to the canvas, but `pointer-events` is an *inherited* property: the
 * projected label buttons would inherit `none` too and could not be clicked.
 * Re-enable pointer events for the buttons only, keeping the surrounding overlay
 * click-through.
 */
const LABEL_INTERACTION_CSS = '[data-nebula-labels] > button { pointer-events: auto; }'

/** Links are string ids before simulation and node objects during it. */
function linkEndpointId(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    return String((value as { id: unknown }).id)
  }
  return String(value)
}

function linkKey(link: { source: unknown; target: unknown }): string {
  return `${linkEndpointId(link.source)}|${linkEndpointId(link.target)}`
}

/**
 * Relation-aware link lengths: vulnerabilities hang close to their host, while
 * leaks and session links stretch farther out. A single distance for every edge
 * made the graph read as one rigid shell.
 */
const LINK_DISTANCE_BY_RELATION: Record<GraphRelation, readonly [number, number]> = {
  HAS_VULN: [28, 44],
  LEAKED: [66, 96],
  RELATED_VULN: [52, 78],
  SNAPSHOT_VULN: [50, 72],
  SNAPSHOT_TARGETS: [58, 84],
  TARGET_SESSION: [58, 82],
  TARGET_ASSET: [52, 76],
  BELONGS_TO: [48, 72],
  TASK_TOUCHED_HOST: [46, 70]
}

function linkDistance(link: GraphLink): number {
  const [min, max] = LINK_DISTANCE_BY_RELATION[link.relation] ?? [46, 74]
  return min + hashUnit(`${linkKey(link)}|${link.relation}`) * (max - min)
}

/** Adjacency of the undirected graph, used by hover "focus + context" mode. */
function buildNeighborMap(links: readonly GraphLink[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const link of links) {
    const source = linkEndpointId(link.source)
    const target = linkEndpointId(link.target)
    if (source === target) continue
    const sourceBucket = map.get(source)
    if (sourceBucket === undefined) map.set(source, new Set([target]))
    else sourceBucket.add(target)
    const targetBucket = map.get(target)
    if (targetBucket === undefined) map.set(target, new Set([source]))
    else targetBucket.add(source)
  }
  return map
}

function toFlowRoutes(links: readonly GraphLink[]): FlowRoute[] {
  return links.map((link) => ({
    sourceId: linkEndpointId(link.source),
    targetId: linkEndpointId(link.target)
  }))
}

/** Translator signature (matches `useI18n().t`). */
type TranslateFn = (key: string, params?: Record<string, string | number>) => string

/** Single-line ellipsis for label summaries. */
function truncateLabel(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/**
 * Short, localized HUD label text.
 *
 * Long record titles made the projected labels overlap in dense clusters, so the
 * pucks show the *category* instead: vulnerability type, leaked-secret type,
 * snapshot phase, or the host/target/project name (truncated). The full original
 * name stays available as the native tooltip and in the inspector.
 *
 * Built from `t()` so the summaries follow the zh/en language switch — the page
 * re-renders on language change and the label layer re-syncs its text.
 */
function summarizeLabel(node: GraphNode, t: TranslateFn): string {
  const aggregate = aggregateInfoOf(node)
  if (aggregate !== null) {
    return `+${aggregate.count} ${t(`nebula.type.${node.type}`)}`
  }
  switch (node.type) {
    case 'vuln': {
      const type = node.data.vuln_type.trim()
      if (type === '' || type === 'Unclassified') return truncateLabel(node.name, 20)
      return truncateLabel(type, 22)
    }
    case 'leak':
      return t('nebula.label.leakSummary', {
        type: t(`ui.leakType.${node.data.info_type}`)
      })
    case 'snapshot': {
      const phase = truncateLabel(node.data.current_phase, 16)
      const kind = t('nebula.type.snapshot')
      return phase === '' ? kind : `${kind} · ${phase}`
    }
    case 'project':
    case 'target':
    case 'host':
      return truncateLabel(node.name, 24)
  }
}

/** DOM label datum for one live force-graph node (position is mutated in place). */
function buildLabelDatum(
  node: GraphNode,
  selectedId: string | null,
  hoveredId: string | null,
  t: TranslateFn
): NebulaLabelDatum {
  const aggregate = aggregateInfoOf(node) !== null
  return {
    id: node.id,
    name: node.name,
    label: summarizeLabel(node, t),
    kind: node.type,
    variant: labelVariantOf(node),
    priority: nodeLabelPriority(node, node.id === selectedId, node.id === hoveredId),
    danger: node.type === 'vuln' && (node.severity === 'Critical' || node.severity === 'High'),
    aggregate,
    lift: nodeRadius(node) + LABEL.lift,
    // Live object on purpose: the force engine rewrites x/y/z every tick.
    position: node
  }
}

function detectWebGl(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/** `prefers-reduced-motion` as reactive state (canvas motion respects it). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/* ----------------------------------------------------------------- node art -- */

interface NodeVisual {
  group: THREE.Group
  /** Wireframe shell (LineSegments) animated by the HUD frame loop. */
  shell: THREE.LineSegments
  shellMaterial: THREE.LineBasicMaterial
  /** White-hot core sphere; opacity carries search/focus/hover dimming. */
  core: THREE.Mesh
  coreMaterial: THREE.MeshBasicMaterial
  /** Additive radial halo sprite (shared glow texture per colour). */
  glow: THREE.Sprite
  glowMaterial: THREE.SpriteMaterial
  /** Rotating selection ring / snapshot orbit ring, created lazily. */
  ring: THREE.LineLoop | null
  ringMaterial: THREE.LineBasicMaterial | null
  readonly nodeType: NebulaNode['type']
  readonly baseColor: THREE.Color
  readonly radius: number
  /** Deterministic per-node phases so neighbours never pulse/spin in sync. */
  readonly spinDirection: number
  readonly spinSeed: number
  readonly breatheSeed: number
  /** Interaction target scale (hover growth); breathing multiplies it. */
  baseScale: number
}

function disposeVisual(visual: NodeVisual): void {
  visual.shellMaterial.dispose()
  visual.coreMaterial.dispose()
  visual.glowMaterial.dispose()
  visual.ringMaterial?.dispose()
  visual.group.removeFromParent()
  visual.group.clear()
}

/** Lazily add the outer ring (selection halo / snapshot orbit). */
function ensureNodeRing(visual: NodeVisual): void {
  if (visual.ring !== null) return
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(HUD.cyan),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const ring = new THREE.LineLoop(haloRingGeometry(), material)
  ring.scale.setScalar(visual.radius * (visual.nodeType === 'snapshot' ? 1.35 : 1.55))
  // Tilt the circle so it reads as an orbit around the node, not a flat outline.
  ring.rotation.x = 1.15
  ring.renderOrder = 6
  ring.visible = false
  visual.group.add(ring)
  visual.ring = ring
  visual.ringMaterial = material
}

/* ---------------------------------------------------------------- link art -- */

/**
 * All links in one additive `LineSegments` draw call.
 *
 * The old implementation created a `THREE.Line` + material per edge (hundreds of
 * draw calls); the HUD only needs hairlines, so positions live in one buffer and
 * per-edge brightness is encoded in the vertex-colour buffer (pre-blended on the
 * canvas colour, see `blendOnCanvas`). Hover/selection tinting rewrites colours
 * once per state change, never per frame.
 */
interface LinkBatch {
  object: THREE.LineSegments
  geometry: THREE.BufferGeometry
  material: THREE.LineBasicMaterial
  positionAttribute: THREE.BufferAttribute
  colorAttribute: THREE.BufferAttribute
  positions: Float32Array
  colors: Float32Array
  baseColors: THREE.Color[]
  highlightColors: THREE.Color[]
  dimColors: THREE.Color[]
}

/** Pre-blend one HUD link colour at the given alpha (+ deterministic variation). */
function linkTint(link: GraphLink, alpha: number, variation: number): THREE.Color {
  return new THREE.Color(blendOnCanvas(LINK_COLORS[link.relation], Math.min(1, alpha * variation)))
}

function buildLinkBatch(links: readonly GraphLink[]): LinkBatch {
  const count = links.length
  const positions = new Float32Array(count * 6)
  const colors = new Float32Array(count * 6)
  const baseColors: THREE.Color[] = []
  const highlightColors: THREE.Color[] = []
  const dimColors: THREE.Color[] = []

  for (let index = 0; index < count; index += 1) {
    const link = links[index]
    const derived = link.derived === true
    // Slight per-link brightness variation keeps the web organic instead of a
    // uniform wireframe; deterministic so the look is stable across reloads.
    const variation = 0.82 + hashUnit(`${linkKey(link)}|brightness`) * 0.36
    const base = linkTint(link, linkOpacity(link.relation, derived), variation)
    baseColors.push(base)
    highlightColors.push(linkTint(link, LINK_HIGHLIGHT_OPACITY, variation))
    dimColors.push(linkTint(link, LINK_DIM_OPACITY, variation))
    const offset = index * 6
    colors[offset] = base.r
    colors[offset + 1] = base.g
    colors[offset + 2] = base.b
    colors[offset + 3] = base.r
    colors[offset + 4] = base.g
    colors[offset + 5] = base.b
  }

  const geometry = new THREE.BufferGeometry()
  const positionAttribute = new THREE.BufferAttribute(positions, 3)
  const colorAttribute = new THREE.BufferAttribute(colors, 3)
  geometry.setAttribute('position', positionAttribute)
  geometry.setAttribute('color', colorAttribute)

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  const object = new THREE.LineSegments(geometry, material)
  object.frustumCulled = false
  object.renderOrder = 2

  return {
    object,
    geometry,
    material,
    positionAttribute,
    colorAttribute,
    positions,
    colors,
    baseColors,
    highlightColors,
    dimColors
  }
}

/* ------------------------------------------------------------------ component -- */

export const NebulaGraph = forwardRef<NebulaGraphHandle, NebulaGraphProps>(function NebulaGraph(
  {
    nodes,
    links,
    selectedId,
    highlightIds,
    focusIds,
    performanceMode,
    autoRotate,
    reducedMotion: reducedMotionOverride,
    onSelect,
    onLabelStats,
    className
  },
  ref
) {
  const { t } = useI18n()
  const systemReducedMotion = usePrefersReducedMotion()
  const reducedMotion = reducedMotionOverride ?? systemReducedMotion

  const containerRef = useRef<HTMLDivElement | null>(null)
  const graphRef = useRef<GraphController | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [webglSupported] = useState(detectWebGl)
  const [contextLost, setContextLost] = useState(false)
  const [hoverFocusId, setHoverFocusId] = useState<string | null>(null)

  /* ---------------------------------------------------------- live refs -- */
  const sceneRef = useRef<THREE.Scene | null>(null)
  const labelLayerRef = useRef<NebulaLabelLayer | null>(null)
  const visualsRef = useRef<Map<string, NodeVisual>>(new Map())
  const nodeByIdRef = useRef<Map<string, GraphNode>>(new Map())
  const radiusByIdRef = useRef<Map<string, number>>(new Map())
  const linksRef = useRef<GraphLink[]>([])
  const graphDataRef = useRef<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] })
  const linkBatchRef = useRef<LinkBatch | null>(null)
  const gridRef = useRef<GridFloor | null>(null)
  const starfieldRef = useRef<Starfield | null>(null)
  const flowRef = useRef<FlowParticles | null>(null)

  const hoveredIdRef = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(selectedId)
  const highlightSetRef = useRef<ReadonlySet<string> | null>(null)
  const focusSetRef = useRef<ReadonlySet<string> | null>(null)
  const performanceModeRef = useRef(performanceMode)
  const autoRotateRef = useRef(autoRotate)
  const reducedMotionRef = useRef(reducedMotion)
  const hoverFocusIdRef = useRef<string | null>(null)
  const neighborMapRef = useRef<Map<string, Set<string>>>(new Map())
  /** 0 = normal, 1 = far (leaf labels hidden), 2 = very far (leaves dimmed). */
  const lodRef = useRef<0 | 1 | 2>(0)
  const sizeRef = useRef({ width: 0, height: 0 })
  const onSelectRef = useRef(onSelect)
  const onLabelStatsRef = useRef<NebulaGraphProps['onLabelStats']>(onLabelStats)
  /** Forwarders so the label layer survives callback identity changes. */
  const labelSelectRef = useRef<(nodeId: string) => void>(() => undefined)
  const labelHoverRef = useRef<(nodeId: string | null) => void>(() => undefined)
  const applyVisualStateRef = useRef<() => void>(() => undefined)
  /** Fit exactly once per data change, after the layout has actually settled. */
  const fittedRef = useRef(false)
  /** Any pan/zoom/focus/click opts the user out of the automatic re-frame. */
  const interactedRef = useRef(false)
  const autoFitTimerRef = useRef<number | undefined>(undefined)
  /** Bumped on mount so StrictMode's throwaway cleanup cannot free live caches. */
  const mountGenerationRef = useRef(0)
  const lastVisibleLabelsRef = useRef(-1)

  selectedIdRef.current = selectedId
  performanceModeRef.current = performanceMode
  autoRotateRef.current = autoRotate
  reducedMotionRef.current = reducedMotion
  hoverFocusIdRef.current = hoverFocusId
  sizeRef.current = size
  onSelectRef.current = onSelect
  onLabelStatsRef.current = onLabelStats

  /**
   * Cloned payload: the force engine rewrites link source/target into node refs,
   * and the page's own graph objects must stay strings. Cloned *nodes* stay the
   * live objects the sim mutates, which is exactly what the DOM labels project.
   */
  const graphData = useMemo(
    () => ({
      nodes: nodes.map((node) => ({ ...node })) as GraphNode[],
      links: links.map((link) => ({ ...link })) as GraphLink[]
    }),
    [nodes, links]
  )

  const nodeById = useMemo(
    () => new Map(graphData.nodes.map((node) => [node.id, node] as const)),
    [graphData]
  )
  const radiusById = useMemo(
    () => new Map(graphData.nodes.map((node) => [node.id, nodeRadius(node)] as const)),
    [graphData]
  )
  const neighborMap = useMemo(() => buildNeighborMap(graphData.links), [graphData])

  const highlightSet = useMemo(
    () => (highlightIds === null ? null : new Set(highlightIds)),
    [highlightIds]
  )
  const focusSet = useMemo(() => (focusIds === null ? null : new Set(focusIds)), [focusIds])
  /** Hovered node + direct neighbours; `null` when nothing is hovered. */
  const hoverIds = useMemo(() => {
    if (hoverFocusId === null) return null
    const ids = new Set<string>([hoverFocusId])
    const neighbours = neighborMap.get(hoverFocusId)
    if (neighbours !== undefined) for (const id of neighbours) ids.add(id)
    return ids
  }, [hoverFocusId, neighborMap])

  nodeByIdRef.current = nodeById
  radiusByIdRef.current = radiusById
  neighborMapRef.current = neighborMap
  linksRef.current = graphData.links
  graphDataRef.current = graphData
  highlightSetRef.current = highlightSet
  focusSetRef.current = focusSet

  /* ------------------------------------------------------- visual state -- */

  /**
   * Apply search/focus/selection/hover/performance state to one node visual.
   *
   * Called for the whole map whenever a prop changes AND immediately for each
   * node object the force engine creates: on data updates the engine builds its
   * objects after the first React paint, so a map-only pass would leave the
   * freshly created objects in their default (bright) state.
   */
  const applyStateToVisual = useCallback((nodeId: string, visual: NodeVisual) => {
    const selected = nodeId === selectedIdRef.current
    const hovered = nodeId === hoveredIdRef.current
    const hoverFocus = hoverFocusIdRef.current
    const performance = performanceModeRef.current
    const lod = lodRef.current
    const highlightSet = highlightSetRef.current
    const focusSet = focusSetRef.current

    const matched = highlightSet === null || highlightSet.has(nodeId)
    const inFocus = focusSet === null || focusSet.has(nodeId) || selected
    const emphasized = selected || hovered
    const leaf = visual.nodeType === 'vuln' || visual.nodeType === 'leak'
    // Hover: keep the hovered node and its direct neighbours bright, fade the
    // rest hard so the local structure reads immediately.
    const hoverLinked =
      hoverFocus === null ||
      nodeId === hoverFocus ||
      neighborMapRef.current.get(hoverFocus)?.has(nodeId) === true

    // One 0..1 "how alive is this node" level drives every material below.
    let level = 1
    if (!matched) level = DIM_OPACITY
    if (!inFocus) level = Math.min(level, FOCUS_DIM_OPACITY)
    if (hoverFocus !== null) {
      level = hoverLinked || hovered ? Math.max(level, EMPHASIS_OPACITY) : Math.min(level, HOVER_CONTEXT_DIM_OPACITY)
    }
    // LOD level 2: far away, evidence fades to faint dust around the hubs.
    if (lod >= 2 && leaf) level = Math.min(level, 0.22)
    if (emphasized) level = 1

    // Holographic wireframe shell: brighter when selected/hovered.
    visual.shellMaterial.opacity = (emphasized ? 0.95 : 0.55) * level
    visual.shellMaterial.color.copy(visual.baseColor)
    if (emphasized) visual.shellMaterial.color.lerp(EMPHASIS_COLOR, 0.4)

    // White-hot core follows the same dimming curve.
    visual.coreMaterial.opacity = level < 0.05 ? 0 : level

    // Additive halo: performance mode only keeps the selected node's glow.
    let glowOpacity: number
    if (performance) glowOpacity = selected ? PERFORMANCE_SELECTED_HALO_OPACITY : 0
    else if (emphasized) glowOpacity = 0.85
    else if (hoverFocus !== null) glowOpacity = hoverLinked ? 0.3 : 0
    else glowOpacity = 0.5
    if (lod >= 2 && leaf) glowOpacity = Math.min(glowOpacity, 0.2)
    glowOpacity *= level
    visual.glowMaterial.opacity = glowOpacity
    visual.glow.visible = glowOpacity > 0.01

    // Selection / snapshot ring (lazy: only nodes that need one allocate it).
    const snapshot = visual.nodeType === 'snapshot'
    if (selected || hovered || snapshot) ensureNodeRing(visual)
    if (visual.ring !== null && visual.ringMaterial !== null) {
      let ringOpacity = 0
      if (selected) ringOpacity = 0.95
      else if (hovered) ringOpacity = 0.7
      else if (snapshot && matched && inFocus) ringOpacity = 0.4 * level
      visual.ringMaterial.opacity = ringOpacity
      visual.ringMaterial.color.copy(selected || hovered ? EMPHASIS_COLOR : visual.baseColor)
      visual.ring.visible = ringOpacity > 0.01
    }

    // Hover growth is the only scale change here; breathing multiplies it in
    // the animation loop (so prop changes never fight the frame loop).
    visual.baseScale = hovered ? NODE_HOVER_SCALE : selected ? 1.04 : 1
  }, [])

  const applyVisualState = useCallback(() => {
    for (const [nodeId, visual] of visualsRef.current) {
      applyStateToVisual(nodeId, visual)
    }
  }, [applyStateToVisual])

  applyVisualStateRef.current = applyVisualState

  /* ------------------------------------------------------------ hovering -- */

  const setHoveredNode = useCallback(
    (node: GraphNode | null) => {
      const nextId = node?.id ?? null
      if (hoveredIdRef.current === nextId) return
      hoveredIdRef.current = nextId
      hoverFocusIdRef.current = nextId
      setHoverFocusId(nextId)
      applyVisualState()
      const element = containerRef.current
      if (element !== null) element.style.cursor = nextId !== null ? 'pointer' : 'grab'
    },
    [applyVisualState]
  )

  const handleNodeHover = useCallback(
    (node: GraphNode | null, _previousNode: GraphNode | null) => {
      setHoveredNode(node)
    },
    [setHoveredNode]
  )

  /** DOM label hover shares the exact same focus + context state. */
  const handleLabelHover = useCallback(
    (nodeId: string | null) => {
      setHoveredNode(nodeId === null ? null : nodeByIdRef.current.get(nodeId) ?? null)
    },
    [setHoveredNode]
  )

  /* -------------------------------------------------------------- camera -- */

  /**
   * Re-target the orbit center without changing the zoom level: the camera keeps
   * its distance but looks at `center`, so auto-rotation afterwards orbits the
   * clicked node instead of the graph origin (P3 feedback).
   */
  const centerView = useCallback((center: Coords, durationMs = 600): void => {
    const controller = graphRef.current
    if (controller === null) return
    const camera = controller.cameraPosition()
    const target = controller.controls().target ?? ORIGIN
    const distance = new THREE.Vector3(
      camera.x - target.x,
      camera.y - target.y,
      camera.z - target.z
    ).length()
    const offset = new THREE.Vector3(camera.x - center.x, camera.y - center.y, camera.z - center.z)
    if (offset.lengthSq() < 1e-4) offset.set(0, 0, 1)
    offset.normalize().multiplyScalar(Math.max(70, distance))
    controller.cameraPosition(
      { x: center.x + offset.x, y: center.y + offset.y, z: center.z + offset.z },
      center,
      durationMs
    )
  }, [])

  /** Node click / label click: select + re-target the orbit center. */
  const selectAndCenter = useCallback(
    (nodeId: string) => {
      const node = nodeByIdRef.current.get(nodeId)
      if (node === undefined) return
      interactedRef.current = true
      onSelectRef.current(nodeId)
      centerView({ x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 })
    },
    [centerView]
  )

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      selectAndCenter(node.id)
    },
    [selectAndCenter]
  )

  const handleBackgroundClick = useCallback(() => {
    interactedRef.current = true
    onSelectRef.current(null)
    // Empty canvas restores the constellation's own center as the orbit target.
    const box = new THREE.Box3()
    const point = new THREE.Vector3()
    let hasNode = false
    for (const node of nodeByIdRef.current.values()) {
      if (typeof node.x !== 'number' || typeof node.y !== 'number' || typeof node.z !== 'number') {
        continue
      }
      box.expandByPoint(point.set(node.x, node.y, node.z))
      hasNode = true
    }
    if (!hasNode) return
    const center = box.getCenter(new THREE.Vector3())
    centerView({ x: center.x, y: center.y, z: center.z })
  }, [centerView])

  /* --------------------------------------------------------------- links -- */

  /** Rewrite link endpoints into the batched buffer from the live node objects. */
  const updateLinkBatchPositions = useCallback(() => {
    const batch = linkBatchRef.current
    if (batch === null) return
    const links = linksRef.current
    const nodeById = nodeByIdRef.current
    const radiusById = radiusByIdRef.current
    const positions = batch.positions

    for (let index = 0; index < links.length; index += 1) {
      const link = links[index]
      const sourceId = linkEndpointId(link.source)
      const targetId = linkEndpointId(link.target)
      const start = nodeById.get(sourceId)
      const end = nodeById.get(targetId)
      const offset = index * 6
      if (start === undefined || end === undefined) {
        positions[offset] = 0
        positions[offset + 1] = 0
        positions[offset + 2] = 0
        positions[offset + 3] = 0
        positions[offset + 4] = 0
        positions[offset + 5] = 0
        continue
      }
      const startX = start.x ?? 0
      const startY = start.y ?? 0
      const startZ = start.z ?? 0
      const endX = end.x ?? 0
      const endY = end.y ?? 0
      const endZ = end.z ?? 0
      const dx = endX - startX
      const dy = endY - startY
      const dz = endZ - startZ
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (length < 1e-3) {
        positions.fill(0, offset, offset + 6)
        continue
      }
      // Trim both ends to the shell surface so hairlines never pierce the nodes.
      const startTrim = Math.min(
        0.45,
        ((radiusById.get(sourceId) ?? 1.5) + 1.2) / length
      )
      const endTrim = Math.min(0.45, ((radiusById.get(targetId) ?? 1.5) + 1.2) / length)
      positions[offset] = startX + dx * startTrim
      positions[offset + 1] = startY + dy * startTrim
      positions[offset + 2] = startZ + dz * startTrim
      positions[offset + 3] = endX - dx * endTrim
      positions[offset + 4] = endY - dy * endTrim
      positions[offset + 5] = endZ - dz * endTrim
    }
    batch.positionAttribute.needsUpdate = true
  }, [])

  /**
   * Hover/selection edge emphasis: connected edges brighten to
   * `LINK_HIGHLIGHT_OPACITY`, everything else fades to `LINK_DIM_OPACITY`.
   */
  const applyLinkTint = useCallback(() => {
    const batch = linkBatchRef.current
    if (batch === null) return
    const links = linksRef.current
    const focusId = hoveredIdRef.current ?? selectedIdRef.current
    const colors = batch.colors
    for (let index = 0; index < links.length; index += 1) {
      const link = links[index]
      let color = batch.baseColors[index]
      if (focusId !== null) {
        const connected =
          linkEndpointId(link.source) === focusId || linkEndpointId(link.target) === focusId
        color = connected ? batch.highlightColors[index] : batch.dimColors[index]
      }
      const offset = index * 6
      colors[offset] = color.r
      colors[offset + 1] = color.g
      colors[offset + 2] = color.b
      colors[offset + 3] = color.r
      colors[offset + 4] = color.g
      colors[offset + 5] = color.b
    }
    batch.colorAttribute.needsUpdate = true
  }, [])

  const rebuildLinkBatch = useCallback(() => {
    const scene = sceneRef.current
    if (scene === null) return
    const previous = linkBatchRef.current
    if (previous !== null) {
      scene.remove(previous.object)
      previous.geometry.dispose()
      previous.material.dispose()
    }
    const batch = buildLinkBatch(linksRef.current)
    linkBatchRef.current = batch
    scene.add(batch.object)
    updateLinkBatchPositions()
    applyLinkTint()
  }, [applyLinkTint, updateLinkBatchPositions])

  const syncGrid = useCallback(() => {
    const grid = gridRef.current
    if (grid === null) return
    const box = new THREE.Box3()
    const point = new THREE.Vector3()
    let hasNode = false
    for (const node of nodeByIdRef.current.values()) {
      if (typeof node.x !== 'number' || typeof node.y !== 'number' || typeof node.z !== 'number') {
        continue
      }
      box.expandByPoint(point.set(node.x, node.y, node.z))
      hasNode = true
    }
    grid.sync(hasNode ? box : null)
  }, [])

  /* --------------------------------------------------------------- labels -- */

  /** Push the live node objects into the projected DOM label layer. */
  const pushLabelData = useCallback(() => {
    const layer = labelLayerRef.current
    if (layer === null) return
    const selected = selectedIdRef.current
    const hovered = hoverFocusIdRef.current
    layer.setData(
      graphDataRef.current.nodes.map((node) => buildLabelDatum(node, selected, hovered, t))
    )
    // `t` is a dependency: switching zh/en rebuilds the localized summaries.
  }, [t])

  /* --------------------------------------------------------------- nodes -- */

  const buildNodeObject = useCallback(
    (node: GraphNode): THREE.Object3D => {
      // Scope switches and data refreshes recreate objects for the same id: free
      // the previous visual before replacing it so nothing leaks.
      const previous = visualsRef.current.get(node.id)
      if (previous !== undefined) disposeVisual(previous)

      const detail: GeometryDetail = performanceModeRef.current ? 0 : 1
      const colorHex = nodeColor(node)
      const radius = nodeRadius(node)
      const baseColor = new THREE.Color(colorHex)
      const group = new THREE.Group()
      group.userData = { nodeId: node.id, nodeType: node.type }

      // 1) Holographic wireframe shell (shared unit geometry, scaled per node).
      const shellMaterial = new THREE.LineBasicMaterial({
        color: baseColor.clone(),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
      const shell = new THREE.LineSegments(shellLineGeometry(node.type, detail), shellMaterial)
      shell.scale.setScalar(radius)
      shell.renderOrder = 4
      group.add(shell)

      // 2) White-hot emissive core so the node never disappears against the fog.
      const coreMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(HUD.white),
        transparent: true,
        opacity: 1,
        depthWrite: false
      })
      const core = new THREE.Mesh(coreSphereGeometry(detail), coreMaterial)
      core.scale.setScalar(nodeCoreRadius(node))
      core.renderOrder = 5
      group.add(core)

      // 3) Additive radial halo from the cached per-colour glow texture.
      const glowMaterial = new THREE.SpriteMaterial({
        map: glowTexture(colorHex),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
      const glow = new THREE.Sprite(glowMaterial)
      glow.scale.setScalar(nodeGlowScale(node))
      glow.renderOrder = 3
      group.add(glow)

      const visual: NodeVisual = {
        group,
        shell,
        shellMaterial,
        core,
        coreMaterial,
        glow,
        glowMaterial,
        ring: null,
        ringMaterial: null,
        nodeType: node.type,
        baseColor,
        radius,
        spinDirection: hashUnit(`${node.id}|spin-direction`) > 0.5 ? 1 : -1,
        spinSeed: hashUnit(`${node.id}|spin-phase`) * Math.PI * 2,
        breatheSeed: hashUnit(`${node.id}|breathe-phase`) * Math.PI * 2,
        baseScale: 1
      }
      visualsRef.current.set(node.id, visual)
      // Snapshot evidence permanently carries an outer orbit ring.
      if (node.type === 'snapshot') ensureNodeRing(visual)
      // The engine creates objects after the first paint; apply the current
      // selection/search/focus state immediately so nothing flashes bright.
      applyStateToVisual(node.id, visual)
      return group
    },
    [applyStateToVisual]
  )

  /* ------------------------------------------------------------- animation -- */

  /** Wireframe spin + breathing scale for every live node visual. */
  const animateNodeVisuals = useCallback((nowMs: number, deltaSeconds: number) => {
    const reduced = reducedMotionRef.current
    const performance = performanceModeRef.current
    for (const visual of visualsRef.current.values()) {
      let scale = visual.baseScale
      if (!reduced && !performance) {
        scale *= 1 + NODE_BREATHE_AMPLITUDE * Math.sin(
          nowMs * 0.001 * NODE_BREATHE_SPEED + visual.breatheSeed
        )
      }
      visual.group.scale.setScalar(scale)
      if (reduced) continue
      visual.shell.rotation.y += NODE_SPIN_SPEED * deltaSeconds * visual.spinDirection
      visual.shell.rotation.x += NODE_SPIN_SPEED * 0.35 * deltaSeconds * visual.spinDirection
      if (visual.ring !== null) {
        visual.ring.rotation.y = nowMs * 0.001 * 1.2 + visual.spinSeed
      }
    }
  }, [])

  /** Camera-distance LOD (0 near / 1 far / 2 very far) for leaves + labels. */
  const updateLod = useCallback((controller: GraphController) => {
    const camera = controller.camera()
    const target = controller.controls().target ?? ORIGIN
    const distance = Math.hypot(
      camera.position.x - target.x,
      camera.position.y - target.y,
      camera.position.z - target.z
    )
    const next: 0 | 1 | 2 =
      distance > LOD_FAR_DISTANCE ? 2 : distance > LOD_NEAR_DISTANCE ? 1 : 0
    if (next === lodRef.current) return
    lodRef.current = next
    applyVisualStateRef.current()
  }, [])

  /* ------------------------------------------------------------- framing -- */

  /**
   * Frame every rendered node deterministically.
   *
   * The library's `zoomToFit` fits the bounding *sphere*, which leaves a lot of
   * dead space with a spread-out 3D layout; computing the distance from the box
   * + the HUD camera FOV keeps the constellation filling the canvas.
   */
  const fitView = useCallback(
    (durationMs = CAMERA_RESET_MS) => {
      const controller = graphRef.current
      if (controller === null) return
      const box = new THREE.Box3()
      const point = new THREE.Vector3()
      let hasNode = false
      for (const node of nodeByIdRef.current.values()) {
        if (typeof node.x !== 'number' || typeof node.y !== 'number' || typeof node.z !== 'number') {
          continue
        }
        box.expandByPoint(point.set(node.x, node.y, node.z))
        hasNode = true
      }
      if (!hasNode) return
      const center = box.getCenter(new THREE.Vector3())
      const extent = box.getSize(new THREE.Vector3())
      const viewportAspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1.6
      const halfTanFov = Math.tan((CAMERA_FOV * Math.PI) / 180 / 2)
      const spanHeight = Math.max(extent.y, 48)
      // Auto-rotation sweeps the horizontal axis, so the worst-case horizontal
      // extent is the XZ-plane diameter, not just the current X span.
      const spanHorizontal = Math.max(Math.hypot(extent.x, extent.z), 48)
      const distance =
        Math.max(
          spanHeight / 2 / halfTanFov,
          spanHorizontal / 2 / (halfTanFov * viewportAspect)
        ) *
          1.15 +
        18
      const current = controller.cameraPosition()
      const direction = new THREE.Vector3(
        current.x - center.x,
        current.y - center.y,
        current.z - center.z
      )
      if (direction.lengthSq() < 1e-4) direction.set(0, 0, 1)
      direction.normalize().multiplyScalar(distance)
      controller.cameraPosition(
        { x: center.x + direction.x, y: center.y + direction.y, z: center.z + direction.z },
        { x: center.x, y: center.y, z: center.z },
        durationMs
      )
    },
    [size.width, size.height]
  )

  const handleEngineStop = useCallback(() => {
    // The simulation settled: this is the reliable moment to re-place the floor.
    syncGrid()
    if (fittedRef.current || interactedRef.current) return
    fittedRef.current = true
    window.clearTimeout(autoFitTimerRef.current)
    fitView()
  }, [fitView, syncGrid])

  /* ------------------------------------------------------------- imperative -- */

  const focusNode = useCallback((nodeId: string) => {
    const controller = graphRef.current
    const node = nodeByIdRef.current.get(nodeId)
    if (controller === null || node === undefined) return
    // A deliberate focus must win over a pending automatic re-frame.
    interactedRef.current = true
    fittedRef.current = true
    window.clearTimeout(autoFitTimerRef.current)
    const targetX = node.x ?? 0
    const targetY = node.y ?? 0
    const targetZ = node.z ?? 0
    const current = controller.cameraPosition()
    const offset = new THREE.Vector3(current.x - targetX, current.y - targetY, current.z - targetZ)
    if (offset.lengthSq() < 1e-4) offset.set(0, 0, 1)
    offset.setLength(nodeRadius(node) * 7 + 55)
    controller.cameraPosition(
      { x: targetX + offset.x, y: targetY + offset.y, z: targetZ + offset.z },
      { x: targetX, y: targetY, z: targetZ },
      CAMERA_FOCUS_MS
    )
  }, [])

  const resetView = useCallback(() => {
    fitView()
  }, [fitView])

  const zoomToFit = useCallback(() => {
    fitView(CAMERA_RESET_MS)
  }, [fitView])

  /** Read the current WebGL frame; requires `preserveDrawingBuffer`. */
  const captureImage = useCallback((): string | null => {
    const container = containerRef.current
    if (container === null) return null
    const canvas = container.querySelector('canvas')
    if (!(canvas instanceof HTMLCanvasElement)) return null
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }, [])

  useImperativeHandle(ref, () => ({ focusNode, resetView, zoomToFit, captureImage }), [
    focusNode,
    resetView,
    zoomToFit,
    captureImage
  ])

  /* -------------------------------------------------------- resize observer -- */

  // The canvas sits inside a flex shell, so it must track its own box instead of
  // the window (the library defaults to full-window sizing).
  useEffect(() => {
    const element = containerRef.current
    if (element === null) return
    const apply = (rect: DOMRectReadOnly): void => {
      const width = Math.max(0, Math.round(rect.width))
      const height = Math.max(0, Math.round(rect.height))
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height }
      )
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) apply(entry.contentRect)
    })
    observer.observe(element)
    apply(element.getBoundingClientRect())
    return () => observer.disconnect()
  }, [])

  /* ----------------------------------------------------------- label layer -- */

  // Own the single DOM label layer for this canvas. Callbacks are forwarded
  // through refs so their identity never forces a teardown of the DOM buttons.
  useEffect(() => {
    if (!webglSupported) return
    const container = containerRef.current
    if (container === null) return
    const layer = new NebulaLabelLayer({
      container,
      onSelect: (nodeId) => labelSelectRef.current(nodeId),
      onHover: (nodeId) => labelHoverRef.current(nodeId)
    })
    labelLayerRef.current = layer
    return () => {
      layer.dispose()
      if (labelLayerRef.current === layer) labelLayerRef.current = null
    }
  }, [webglSupported])

  useEffect(() => {
    labelSelectRef.current = selectAndCenter
  }, [selectAndCenter])

  useEffect(() => {
    labelHoverRef.current = handleLabelHover
  }, [handleLabelHover])

  // Data (live node objects) changes with the graph payload / selection (priority).
  useEffect(() => {
    pushLabelData()
  }, [pushLabelData, graphData, selectedId, hoverFocusId])

  // Filter/focus/performance state changes.
  useEffect(() => {
    const layer = labelLayerRef.current
    if (layer === null) return
    layer.setState({
      selectedId,
      hoveredId: hoverFocusId,
      hoverIds,
      highlightIds: highlightSet,
      focusIds: focusSet,
      performanceMode
    })
  }, [selectedId, hoverFocusId, hoverIds, highlightSet, focusSet, performanceMode])

  /* ------------------------------------------------------------- divestment -- */

  // Drop visuals for nodes the current filter/scope removed instead of keeping
  // their materials alive until unmount.
  useEffect(() => {
    for (const [id, visual] of visualsRef.current) {
      if (nodeById.has(id)) continue
      disposeVisual(visual)
      visualsRef.current.delete(id)
    }
  }, [nodeById])

  /* ------------------------------------------------------------- link state -- */

  useEffect(() => {
    rebuildLinkBatch()
  }, [rebuildLinkBatch, graphData])

  useEffect(() => {
    applyLinkTint()
  }, [applyLinkTint, graphData, selectedId, hoverFocusId])

  useEffect(() => {
    flowRef.current?.setRoutes(toFlowRoutes(linksRef.current))
  }, [graphData])

  /* ---------------------------------------------------- selection / search -- */

  useEffect(() => {
    applyVisualState()
  }, [
    applyVisualState,
    graphData,
    selectedId,
    highlightIds,
    focusIds,
    performanceMode,
    hoverFocusId
  ])

  // Performance mode: swap to the coarse shared geometries (no object rebuild)
  // and thin the flow particles. Breathing is skipped by the frame loop itself.
  useEffect(() => {
    const detail: GeometryDetail = performanceMode ? 0 : 1
    for (const visual of visualsRef.current.values()) {
      visual.shell.geometry = shellLineGeometry(visual.nodeType, detail)
      visual.core.geometry = coreSphereGeometry(detail)
    }
    flowRef.current?.setBudget(performanceMode)
    applyVisualState()
  }, [performanceMode, applyVisualState])

  useEffect(() => {
    flowRef.current?.setEnabled(!reducedMotion)
  }, [reducedMotion])

  /* --------------------------------------------------------------- auto-fit -- */

  // Re-frame whenever the visible set changes (scope switch / filter toggle) so
  // the constellation always fills the canvas instead of floating off-centre.
  // `onEngineStop` is the accurate signal (the simulation has settled); the timer
  // is only a fallback for the rare case where the engine never reports stopping.
  useEffect(() => {
    if (nodes.length === 0) return
    fittedRef.current = false
    interactedRef.current = false
    window.clearTimeout(autoFitTimerRef.current)
    autoFitTimerRef.current = window.setTimeout(() => {
      if (fittedRef.current || interactedRef.current) return
      fittedRef.current = true
      syncGrid()
      fitView()
    }, AUTO_FIT_FALLBACK_MS)
    return () => window.clearTimeout(autoFitTimerRef.current)
  }, [nodes, fitView, syncGrid])

  /* -------------------------------------------------------------- scene fx -- */

  // Attach the atmospheric layer (fog, starfield, holo-grid, batched links, flow
  // particles) once the force-graph controller exists, then tune camera + forces.
  useEffect(() => {
    if (!webglSupported) return
    let disposed = false
    let frame = 0
    let attempts = 0

    const start = (): void => {
      if (disposed) return
      const controller = graphRef.current
      if (controller === null) {
        attempts += 1
        if (attempts <= 300) frame = window.requestAnimationFrame(start)
        return
      }

      const scene = controller.scene()
      sceneRef.current = scene
      scene.background = new THREE.Color(NEBULA_BACKGROUND)
      scene.fog = new THREE.FogExp2(new THREE.Color(NEBULA_BACKGROUND), FOG_DENSITY)

      // HUD lens: tighter field of view than the library default, far plane wide
      // enough for the decorative star shell.
      const camera = controller.camera()
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.fov = CAMERA_FOV
        camera.far = Math.max(camera.far, STARFIELD_RADIUS * 2)
        camera.updateProjectionMatrix()
      }

      // Force tuning: a gentle charge + relation-aware distances keep hubs dense
      // and evidence rings readable.
      controller.d3Force('charge')?.strength(-70)
      controller.d3Force('link')?.distance?.((link: unknown) => linkDistance(link as GraphLink))
      controller.d3ReheatSimulation()
      // Only seed the default framing if a fit has not already happened (a tiny
      // graph can settle before this bootstrap frame runs).
      if (!fittedRef.current) {
        const elevation = DEFAULT_CAMERA_DISTANCE * DEFAULT_CAMERA_ELEVATION
        const planar = DEFAULT_CAMERA_DISTANCE * Math.sqrt(1 - DEFAULT_CAMERA_ELEVATION ** 2)
        controller.cameraPosition(
          { x: 0, y: elevation, z: planar },
          { x: 0, y: 0, z: 0 },
          0
        )
      }

      const controls = controller.controls()
      controls.enableDamping = true
      controls.autoRotate = autoRotateRef.current
      controls.autoRotateSpeed = AUTO_ROTATE_SPEED

      const starfield = new Starfield()
      starfield.attach(scene)
      starfieldRef.current = starfield

      const grid = new GridFloor()
      grid.attach(scene)
      gridRef.current = grid

      const flow = new FlowParticles(glowTexture(FLOW_PARTICLE_COLOR))
      flow.setBudget(performanceModeRef.current)
      flow.setEnabled(!reducedMotionRef.current)
      flow.setRoutes(toFlowRoutes(linksRef.current))
      scene.add(flow.object)
      flowRef.current = flow

      rebuildLinkBatch()
      syncGrid()
      // Labels may have been pushed before the controller existed; re-sync now.
      pushLabelData()
    }

    frame = window.requestAnimationFrame(start)
    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      const scene = sceneRef.current
      if (scene !== null) {
        scene.fog = null
        scene.background = null
      }
      const batch = linkBatchRef.current
      if (batch !== null) {
        batch.object.removeFromParent()
        batch.geometry.dispose()
        batch.material.dispose()
        linkBatchRef.current = null
      }
      flowRef.current?.dispose()
      flowRef.current = null
      gridRef.current?.dispose()
      gridRef.current = null
      starfieldRef.current?.dispose()
      starfieldRef.current = null
      sceneRef.current = null
    }
  }, [webglSupported, pushLabelData, rebuildLinkBatch, syncGrid])

  /* --------------------------------------------------------- HUD frame loop -- */

  // Own requestAnimationFrame loop (labels must follow the camera every frame;
  // `onRenderFramePost` is not reliable across graph impl versions). Order per
  // frame: spin/breathing → link positions → flow particles → LOD → labels.
  useEffect(() => {
    if (!webglSupported) return
    let disposed = false
    let frame = 0
    let lastTime = 0
    let lastLodCheck = 0

    const tick = (time: number): void => {
      if (disposed) return
      const deltaSeconds = lastTime === 0 ? 0 : Math.min(0.1, (time - lastTime) / 1000)
      lastTime = time

      const controller = graphRef.current
      if (controller !== null) {
        const nowMs = performance.now()
        animateNodeVisuals(nowMs, deltaSeconds)
        updateLinkBatchPositions()

        const flow = flowRef.current
        if (flow !== null) {
          flow.update((nodeId) => nodeByIdRef.current.get(nodeId), deltaSeconds)
        }
        if (autoRotateRef.current && !reducedMotionRef.current) {
          starfieldRef.current?.rotate(deltaSeconds)
        }

        if (nowMs - lastLodCheck >= LOD_CHECK_INTERVAL_MS) {
          lastLodCheck = nowMs
          updateLod(controller)
        }

        const layer = labelLayerRef.current
        const { width, height } = sizeRef.current
        if (layer !== null && width > 0 && height > 0) {
          const visible = layer.update(
            controller.camera(),
            width,
            height,
            lodRef.current,
            nowMs
          )
          if (visible !== lastVisibleLabelsRef.current) {
            lastVisibleLabelsRef.current = visible
            onLabelStatsRef.current?.(visible, layer.count)
          }
        }
      }

      frame = window.requestAnimationFrame(tick)
    }

    frame = window.requestAnimationFrame(tick)
    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
    }
  }, [animateNodeVisuals, updateLinkBatchPositions, updateLod, webglSupported])

  /* ------------------------------------------------------------ auto-rotate -- */

  useEffect(() => {
    let frame = 0
    let attempts = 0
    const tick = (): void => {
      const controls = graphRef.current?.controls()
      if (controls !== undefined) {
        controls.autoRotate = autoRotateRef.current
        controls.autoRotateSpeed = AUTO_ROTATE_SPEED
        controls.enableDamping = true
        return
      }
      attempts += 1
      if (attempts > 300) return
      frame = window.requestAnimationFrame(tick)
    }
    tick()
    return () => window.cancelAnimationFrame(frame)
  }, [autoRotate])

  // Any direct interaction pauses rotation; it resumes after a short idle gap.
  useEffect(() => {
    const element = containerRef.current
    if (element === null) return
    let idleTimer: number | undefined
    const pause = (): void => {
      interactedRef.current = true
      const controls = graphRef.current?.controls()
      if (controls !== undefined) controls.autoRotate = false
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        const nextControls = graphRef.current?.controls()
        if (nextControls !== undefined) nextControls.autoRotate = autoRotateRef.current
      }, AUTO_ROTATE_RESUME_MS)
    }
    const events = ['pointerdown', 'wheel', 'touchstart'] as const
    for (const event of events) element.addEventListener(event, pause, { passive: true })
    return () => {
      for (const event of events) element.removeEventListener(event, pause)
      window.clearTimeout(idleTimer)
    }
  }, [])

  /* --------------------------------------------------------- context loss -- */

  // A lost WebGL context (GPU reset, memory pressure, long background tab) must
  // not leave a frozen black canvas without an explanation.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const onLost = (event: Event): void => {
      // Prevent default so the browser may still attempt an automatic restore.
      event.preventDefault()
      setContextLost(true)
    }
    const onRestored = (): void => setContextLost(false)
    container.addEventListener('webglcontextlost', onLost, true)
    container.addEventListener('webglcontextrestored', onRestored, true)
    return () => {
      container.removeEventListener('webglcontextlost', onLost, true)
      container.removeEventListener('webglcontextrestored', onRestored, true)
    }
  }, [webglSupported])

  /* --------------------------------------------------------------- cleanup -- */

  useEffect(() => {
    mountGenerationRef.current += 1
    const generation = mountGenerationRef.current
    return () => {
      // Deferred one tick so React StrictMode's simulated remount can claim the
      // caches back before the real unmount frees them.
      window.setTimeout(() => {
        if (mountGenerationRef.current !== generation) return
        for (const visual of visualsRef.current.values()) disposeVisual(visual)
        visualsRef.current.clear()
        window.clearTimeout(autoFitTimerRef.current)
      }, 0)
    }
  }, [])

  /* ---------------------------------------------------------------- render -- */

  const nodeValue = useCallback((node: GraphNode): number => node.val, [])
  const emptyNodeLabel = useCallback((): string => '', [])
  // The library would otherwise build a `THREE.Line` + geometry per edge; the
  // batched HUD link layer renders them all in one additive draw call.
  const hideLinks = useCallback((): boolean => false, [])

  const heavyGraph = nodes.length + links.length > HEAVY_GRAPH_ELEMENT_LIMIT

  if (!webglSupported) {
    // P3 2D fallback: keep search/filter/selection usable without a GPU.
    return (
      <NebulaGraph2D
        nodes={nodes}
        links={links}
        selectedId={selectedId}
        highlightIds={highlightIds}
        focusIds={focusIds}
        performanceMode={performanceMode}
        onSelect={onSelect}
        className={className}
      />
    )
  }

  return (
    <div
      ref={containerRef}
      // `group` (not `img`): the container now holds real, focusable label
      // buttons, so it must not be exposed to assistive tech as a single image.
      role="group"
      aria-label={t('nebula.canvas.ariaLabel')}
      data-nebula-canvas="3d"
      className={cn('relative h-full w-full touch-none overflow-hidden', className)}
      style={{ backgroundColor: NEBULA_BACKGROUND }}
    >
      <style>{LABEL_INTERACTION_CSS}</style>

      {size.width > 0 && size.height > 0 ? (
        <ForceGraph3D
          ref={graphRef}
          graphData={graphData}
          width={size.width}
          height={size.height}
          backgroundColor={NEBULA_BACKGROUND}
          showNavInfo={false}
          nodeId="id"
          nodeVal={nodeValue}
          nodeLabel={emptyNodeLabel}
          rendererConfig={{ preserveDrawingBuffer: true, antialias: true }}
          controlType="orbit"
          enableNodeDrag
          warmupTicks={20}
          cooldownTicks={140}
          d3AlphaDecay={0.022}
          nodeThreeObject={buildNodeObject}
          linkVisibility={hideLinks}
          onNodeClick={handleNodeClick}
          onNodeHover={handleNodeHover}
          onBackgroundClick={handleBackgroundClick}
          onEngineStop={handleEngineStop}
        />
      ) : null}

      {/* Weak faux depth of field: keep the focal centre crisp and soften the
          periphery where nodes fly away. A CSS backdrop blur is used instead of
          a Three.js BokehPass so the force-graph render loop and PNG capture
          stay untouched; labels/HUD live above this layer and stay sharp. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[3]"
        style={{
          backdropFilter: performanceMode ? 'none' : 'blur(3px)',
          WebkitBackdropFilter: performanceMode ? 'none' : 'blur(3px)',
          maskImage:
            'radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,0.45) 68%, rgba(0,0,0,1) 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,0.45) 68%, rgba(0,0,0,1) 100%)'
        }}
      />

      {contextLost ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-[#02040a]/80 px-6 backdrop-blur-sm">
          <div
            className={cn(
              NEBULA_UI.glass,
              NEBULA_UI.panelRadius,
              'max-w-[380px] px-6 py-5 text-center'
            )}
          >
            <p className="font-mono text-[12px] uppercase tracking-[0.06em] text-[#FFAA00]">
              {t('nebula.webglLost.title')}
            </p>
            <p className={cn(NEBULA_UI.muted, 'mt-2 text-[12px] leading-relaxed')}>
              {t('nebula.webglLost.description')}
            </p>
            <HudButton className="mt-4" size="sm" onClick={() => window.location.reload()}>
              {t('nebula.webglLost.restore')}
            </HudButton>
          </div>
        </div>
      ) : null}

      {heavyGraph ? (
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 w-[min(22rem,calc(100%-2rem))] -translate-x-1/2 border border-[#FFAA00]/30 bg-[#020A14]/85 px-3 py-2 text-center backdrop-blur-md">
          <p className="font-mono text-[11.5px] uppercase tracking-[0.06em] text-[#FFAA00]">
            {t('nebula.performance.title')}
          </p>
          <p className={cn(NEBULA_UI.muted, 'mt-1 text-[11.5px] leading-relaxed')}>
            {t('nebula.performance.description', {
              nodes: nodes.length,
              links: links.length,
              limit: HEAVY_GRAPH_ELEMENT_LIMIT
            })}
          </p>
        </div>
      ) : null}
    </div>
  )
})
