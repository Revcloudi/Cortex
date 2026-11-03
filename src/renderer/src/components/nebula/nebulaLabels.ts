import * as THREE from 'three'
import type { GraphNodeType } from '@shared/graph'
import { LABEL, LABEL_BASE_CLASS, LABEL_UI, type LabelVariant } from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'

/**
 * 2D projected DOM labels for the 3D nebula (J.A.R.V.I.S. HUD reference).
 *
 * The old implementation rendered labels as Three.js sprites, which were blurry,
 * impossible to click and always drew over the nodes. This layer keeps the
 * reference demo's approach: one absolutely-positioned DOM button per node in a
 * `pointer-events: none` overlay, projected from world space with
 * `Vector3.project(camera)` every frame and moved only through `transform`
 * (no layout thrash). The layer also owns:
 *
 * - priority ordering (selected > hovered > structural nodes > critical vulns >
 *   snapshot > other evidence) so the important labels win;
 * - overlap culling with an AABB test, cap per LOD level and performance mode;
 * - camera-distance LOD (leaves disappear first when zoomed far out);
 * - search / filter / focus / hover dimming and hiding;
 * - click-to-select and hover-to-focus (labels are real buttons, keyboard
 *   reachable while visible, inert + aria-hidden while culled).
 *
 * The component owns a single instance and feeds it live force-graph node
 * objects (the simulation mutates their x/y/z in place).
 */

export interface NebulaLabelDatum {
  id: string
  /** Full display name; also the native tooltip (`title`). */
  name: string
  /**
   * Short, localized label shown on the puck (e.g. vulnerability type or leak
   * type). Falls back to `name` when the summaries are disabled.
   */
  label?: string
  kind: GraphNodeType
  variant: LabelVariant
  /** Higher wins the overlap test (see `nodeLabelPriority`). */
  priority: number
  /** True for Critical/High vulnerabilities (kept on screen at far LOD). */
  danger: boolean
  /** `+N` aggregate node (styled with a highlight chip). */
  aggregate: boolean
  /** World-space lift above the node origin (usually `nodeRadius + LABEL.lift`). */
  lift: number
  /** Live position holder mutated by the force simulation. */
  position: { x?: number; y?: number; z?: number }
}

export interface NebulaLabelState {
  selectedId: string | null
  hoveredId: string | null
  /** Hovered node + direct neighbours; `null` when nothing is hovered. */
  hoverIds: ReadonlySet<string> | null
  /** Search matches; `null` when no search is active. */
  highlightIds: ReadonlySet<string> | null
  /** Focus neighbourhood; `null` when focus mode is off. */
  focusIds: ReadonlySet<string> | null
  performanceMode: boolean
}

export interface NebulaLabelLayerOptions {
  /** Positioned canvas container; the overlay is appended to it. */
  container: HTMLElement
  onSelect: (nodeId: string) => void
  onHover?: (nodeId: string | null) => void
}

interface LabelEntry {
  datum: NebulaLabelDatum
  element: HTMLButtonElement
  /** Measured once per content change (never per frame). */
  width: number
  /** Projected screen position of the label anchor (node position + lift). */
  screenX: number
  screenY: number
  onScreen: boolean
  /** Final visibility decided by the cull pass. */
  shown: boolean
  lastTransform: string
}

const OFFSCREEN_MARGIN = 80
const EMPTY_STATE: NebulaLabelState = {
  selectedId: null,
  hoveredId: null,
  hoverIds: null,
  highlightIds: null,
  focusIds: null,
  performanceMode: false
}

function labelText(datum: NebulaLabelDatum): string {
  const raw = (datum.label ?? datum.name).trim()
  if (raw.length === 0) return datum.aggregate ? '+N' : '—'
  if (raw.length > LABEL.maxChars) return `${raw.slice(0, LABEL.maxChars - 1)}…`
  return raw
}

export class NebulaLabelLayer {
  private readonly overlay: HTMLDivElement
  private readonly entries = new Map<string, LabelEntry>()
  private readonly onSelect: (nodeId: string) => void
  private readonly onHover: ((nodeId: string | null) => void) | undefined
  private state: NebulaLabelState = EMPTY_STATE
  private cullDue = true
  private lastCullMs = 0
  private visibleCount = 0
  private disposed = false
  private readonly projected = new THREE.Vector3()

  constructor(options: NebulaLabelLayerOptions) {
    this.onSelect = options.onSelect
    this.onHover = options.onHover
    this.overlay = document.createElement('div')
    this.overlay.className = 'pointer-events-none absolute inset-0 z-[5] overflow-hidden'
    this.overlay.setAttribute('data-nebula-labels', '')
    options.container.appendChild(this.overlay)
  }

  /** Replace the label set. Safe to call on every graph-data change. */
  setData(data: readonly NebulaLabelDatum[]): void {
    if (this.disposed) return
    const nextIds = new Set<string>()
    for (const datum of data) {
      nextIds.add(datum.id)
      const existing = this.entries.get(datum.id)
      if (existing === undefined) {
        this.entries.set(datum.id, this.createEntry(datum))
        continue
      }
      const stale =
        existing.datum.name !== datum.name ||
        existing.datum.label !== datum.label ||
        existing.datum.variant !== datum.variant ||
        existing.datum.aggregate !== datum.aggregate
      existing.datum = datum
      if (stale) this.updateEntryContent(existing)
    }
    for (const [id, entry] of this.entries) {
      if (nextIds.has(id)) continue
      entry.element.remove()
      this.entries.delete(id)
    }
    this.cullDue = true
  }

  setState(state: NebulaLabelState): void {
    if (this.disposed) return
    this.state = state
    this.cullDue = true
  }

  /**
   * Project + position + cull. Called once per rendered frame from the graph's
   * animation loop; the cull pass itself is throttled to `LABEL.cullIntervalMs`
   * and whenever the state / data changes.
   *
   * @returns number of labels currently visible (used by the HUD status line).
   */
  update(camera: THREE.Camera, width: number, height: number, lod: 0 | 1 | 2, nowMs: number): number {
    if (this.disposed || width <= 0 || height <= 0) return 0

    for (const entry of this.entries.values()) {
      const position = entry.datum.position
      // Project to clip space, then to screen pixels. The anchor must be inside
      // the actual viewport: clip-space ±1.25 would still call a label "visible"
      // while its projected anchor sits fully outside the canvas (observed while
      // the camera flies to a search match).
      this.projected.set(
        position.x ?? 0,
        (position.y ?? 0) + entry.datum.lift,
        position.z ?? 0
      )
      this.projected.project(camera)
      const clipZ = this.projected.z
      entry.screenX = (this.projected.x * 0.5 + 0.5) * width
      entry.screenY = (-this.projected.y * 0.5 + 0.5) * height
      entry.onScreen =
        clipZ <= 1 &&
        clipZ >= -1 &&
        entry.screenX >= 0 &&
        entry.screenX <= width &&
        entry.screenY >= 0 &&
        entry.screenY <= height
      if (!entry.onScreen) continue
      const transform = `translate3d(${entry.screenX.toFixed(1)}px, ${entry.screenY.toFixed(1)}px, 0) translate(-50%, -100%)`
      if (transform !== entry.lastTransform) {
        entry.element.style.transform = transform
        entry.lastTransform = transform
      }
    }

    if (this.cullDue || nowMs - this.lastCullMs >= LABEL.cullIntervalMs) {
      this.cullDue = false
      this.lastCullMs = nowMs
      this.cull(lod, width, height)
    }
    return this.visibleCount
  }

  get count(): number {
    return this.entries.size
  }

  get visible(): number {
    return this.visibleCount
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) entry.element.remove()
    this.entries.clear()
    this.overlay.remove()
  }

  /* ------------------------------------------------------------- internals -- */

  private createEntry(datum: NebulaLabelDatum): LabelEntry {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = cn(LABEL_BASE_CLASS, LABEL_UI[datum.variant])
    element.dataset.nodeId = datum.id
    element.dataset.variant = datum.variant
    element.dataset.kind = datum.kind
    if (datum.aggregate) element.dataset.aggregate = 'true'
    element.style.visibility = 'hidden'
    element.style.opacity = '0'
    element.style.transform = 'translate3d(-9999px, -9999px, 0) translate(-50%, -100%)'
    element.setAttribute('aria-hidden', 'true')
    element.tabIndex = -1
    element.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.onSelect(datum.id)
    })
    element.addEventListener('mouseenter', () => this.onHover?.(datum.id))
    element.addEventListener('mouseleave', () => this.onHover?.(null))
    element.addEventListener('pointerdown', (event) => event.stopPropagation())
    this.overlay.appendChild(element)
    const entry: LabelEntry = {
      datum,
      element,
      width: 0,
      screenX: 0,
      screenY: 0,
      onScreen: false,
      shown: false,
      lastTransform: ''
    }
    this.updateEntryContent(entry)
    return entry
  }

  private updateEntryContent(entry: LabelEntry): void {
    const { datum, element } = entry
    element.textContent = labelText(datum)
    element.title = datum.name
    element.dataset.variant = datum.variant
    element.className = cn(
      LABEL_BASE_CLASS,
      LABEL_UI[datum.variant],
      datum.aggregate && 'font-semibold text-[#FFC766]'
    )
    // Content changed: measure once (still `visibility: hidden`, so layout is
    // computed and the read is accurate) and cache the width for the overlap test.
    entry.width = Math.max(36, Math.ceil(element.offsetWidth))
    entry.lastTransform = ''
  }

  private cull(lod: 0 | 1 | 2, width: number, height: number): void {
    const state = this.state
    const cap = state.performanceMode
      ? LABEL.maxVisiblePerformance
      : lod >= 2
        ? LABEL.maxVisibleFar
        : LABEL.maxVisible

    const candidates: LabelEntry[] = []
    for (const entry of this.entries.values()) {
      if (!entry.onScreen) {
        this.applyVisibility(entry, false, 0)
        continue
      }
      if (!this.allowedByState(entry, state, lod)) {
        this.applyVisibility(entry, false, 0)
        continue
      }
      candidates.push(entry)
    }

    candidates.sort((left, right) => {
      if (right.datum.priority !== left.datum.priority) {
        return right.datum.priority - left.datum.priority
      }
      if (left.screenY !== right.screenY) return left.screenY - right.screenY
      return left.datum.id.localeCompare(right.datum.id)
    })

    const occupied: number[] = []
    let shown = 0
    for (const entry of candidates) {
      const forced = entry.datum.id === state.selectedId || entry.datum.id === state.hoveredId
      const halfWidth = entry.width / 2 + LABEL.overlapPaddingPx
      const left = entry.screenX - halfWidth
      const right = entry.screenX + halfWidth
      const top = entry.screenY - LABEL.heightPx - LABEL.overlapPaddingPx
      const bottom = entry.screenY + LABEL.overlapPaddingPx
      let overlaps = false
      for (let index = 0; index < occupied.length; index += 4) {
        if (
          left < occupied[index + 2] &&
          right > occupied[index] &&
          top < occupied[index + 3] &&
          bottom > occupied[index + 1]
        ) {
          overlaps = true
          break
        }
      }
      if (!forced && (overlaps || shown >= cap)) {
        this.applyVisibility(entry, false, 0)
        continue
      }
      occupied.push(left, top, right, bottom)
      shown += 1
      const opacity =
        entry.datum.id === state.selectedId || entry.datum.id === state.hoveredId ? 1 : 0.88
      this.applyVisibility(entry, true, opacity)
    }
    this.visibleCount = shown

    // Keep partially off-canvas labels clipped by the overlay, not by the page.
    if (width <= 0 || height <= 0) this.visibleCount = 0
  }

  private allowedByState(entry: LabelEntry, state: NebulaLabelState, lod: 0 | 1 | 2): boolean {
    const { id, kind, danger } = entry.datum
    const isSelected = id === state.selectedId
    const isHovered = id === state.hoveredId
    if (isSelected || isHovered) return true

    if (state.highlightIds !== null && !state.highlightIds.has(id)) return false
    if (state.focusIds !== null && !state.focusIds.has(id)) return false
    if (state.hoveredId !== null && !(state.hoverIds?.has(id) ?? false)) return false

    const structural = kind === 'project' || kind === 'target' || kind === 'host'
    const evidence = kind === 'vuln' || kind === 'leak'

    if (state.performanceMode && !structural && !danger && kind !== 'snapshot') return false
    if (lod >= 2 && !structural && !danger) return false
    if (lod >= 1 && evidence && !danger) return false
    return true
  }

  private applyVisibility(entry: LabelEntry, visible: boolean, opacity: number): void {
    const { element } = entry
    if (entry.shown === visible) {
      if (visible) element.style.opacity = String(opacity)
      return
    }
    entry.shown = visible
    if (visible) {
      element.style.visibility = 'visible'
      element.style.opacity = String(opacity)
      element.setAttribute('aria-hidden', 'false')
      element.tabIndex = 0
    } else {
      element.style.visibility = 'hidden'
      element.style.opacity = '0'
      element.setAttribute('aria-hidden', 'true')
      element.tabIndex = -1
    }
  }
}

/** Off-canvas helpers are exported for the graph's LOD math / tests. */
export function isLabelOffCanvas(screenX: number, screenY: number, width: number, height: number): boolean {
  return (
    screenX < -OFFSCREEN_MARGIN ||
    screenX > width + OFFSCREEN_MARGIN ||
    screenY < -OFFSCREEN_MARGIN ||
    screenY > height + OFFSCREEN_MARGIN
  )
}
