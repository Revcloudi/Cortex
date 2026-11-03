import type { GraphNodeType, GraphRelation, NebulaNode } from '@shared/graph'
import type { Severity } from '@shared/types'

/**
 * Single source of truth for Memory Nebula visuals.
 *
 * The 3D canvas is the only dark surface in the app (everything else stays on
 * the light shell), so these literal colours deliberately bypass the Tailwind
 * token layer: they are emissive WebGL values, not UI chrome. DOM overlays that
 * sit on top of the canvas (control panel, inspector, legend) use the matching
 * `NEBULA_UI` strings so the whole surface reads as one material.
 */

/** Canvas background, per the visual spec (kept slightly deep-space blue). */
export const NEBULA_BACKGROUND = '#06080f'

export const NEBULA_UI = {
  /** Glass panel surface used by the control panel / inspector / legend. */
  glass:
    'bg-[#0b0c10]/[0.78] backdrop-blur-xl border border-white/[0.08] shadow-[0_24px_60px_-24px_rgba(0,0,0,0.85)]',
  panelRadius: 'rounded-xl',
  divider: 'border-white/[0.07]',
  heading: 'text-white/90',
  body: 'text-white/65',
  muted: 'text-white/40',
  faint: 'text-white/30',
  focusRing:
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#050505]'
} as const

/* ------------------------------------------------------------- node colours -- */

export const NODE_TYPE_COLORS: Record<GraphNodeType, string> = {
  project: '#a78bfa',
  target: '#f59e0b',
  host: '#3b82f6',
  vuln: '#ef4444',
  leak: '#a855f7',
  snapshot: '#10b981'
}

/** Vulns are coloured by severity; Low/Info are the grey-blue pair. */
export const SEVERITY_NODE_COLORS: Record<Severity, string> = {
  Critical: '#ef4444',
  High: '#f97316',
  Medium: '#eab308',
  Low: '#94a3b8',
  Info: '#64748b'
}

/** DOM badge classes for the inspector / legend (dark surface variants). */
export const SEVERITY_BADGE_CLASSES: Record<Severity, string> = {
  Critical: 'border-red-500/35 bg-red-500/[0.12] text-red-300',
  High: 'border-orange-500/35 bg-orange-500/[0.12] text-orange-300',
  Medium: 'border-amber-500/35 bg-amber-500/[0.12] text-amber-300',
  Low: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  Info: 'border-white/15 bg-white/[0.06] text-white/55'
}

export const STATUS_BADGE_CLASSES: Record<string, string> = {
  Confirmed: 'border-white/15 bg-white/[0.06] text-white/70',
  Inconclusive: 'border-white/10 bg-white/[0.03] text-white/45',
  Retest_Passed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  Alive: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  Dead: 'border-white/10 bg-white/[0.03] text-white/40',
  WAF_Blocked: 'border-amber-500/30 bg-amber-500/10 text-amber-300'
}

export function nodeColor(node: NebulaNode): string {
  if (node.type === 'vuln') return SEVERITY_NODE_COLORS[node.severity]
  return NODE_TYPE_COLORS[node.type]
}

/* -------------------------------------------------------------- node sizing -- */

/** Sprite radius in world units. Hosts are the anchors, leaks the smallest. */
const SIZE_FACTOR: Record<GraphNodeType, number> = {
  project: 3.4,
  target: 3,
  host: 2.35,
  vuln: 1.55,
  leak: 1.05,
  snapshot: 1.75
}

/** Hard clamps keep overlapping mock nodes readable at default zoom. */
const MIN_RADIUS: Record<GraphNodeType, number> = {
  project: 12,
  target: 11,
  host: 9,
  vuln: 4.5,
  leak: 2.6,
  snapshot: 5.5
}

export function nodeRadius(node: NebulaNode): number {
  const scaled = SIZE_FACTOR[node.type] * Math.sqrt(Math.max(1, node.val))
  return Math.max(MIN_RADIUS[node.type], scaled)
}

/** Selected/hovered nodes get an extra halo sprite at this radius multiplier. */
export const HALO_SCALE: Record<GraphNodeType, number> = {
  project: 1.7,
  target: 1.75,
  host: 1.85,
  vuln: 2.1,
  leak: 2.4,
  snapshot: 1.9
}

/* ----------------------------------------------------------------- link style -- */

/** Cool cyan/white links per the spec — never thicker than a hairline. */
export const LINK_COLORS: Record<GraphRelation, string> = {
  BELONGS_TO: '#94a3b8',
  TARGET_SESSION: '#fbbf24',
  TARGET_ASSET: '#f59e0b',
  HAS_VULN: '#7dd3fc',
  LEAKED: '#c084fc',
  RELATED_VULN: '#e2e8f0',
  SNAPSHOT_TARGETS: '#5eead4',
  SNAPSHOT_VULN: '#5eead4',
  TASK_TOUCHED_HOST: '#7dd3fc'
}

/**
 * Alphas are pre-blended against the canvas by `blendOnCanvas()` before being
 * handed to Three.js (its Color parser drops `rgba` alpha). Kept low so the
 * graph reads as a faint web with the nodes as the bright objects.
 */
export const LINK_OPACITY: Record<GraphRelation, number> = {
  BELONGS_TO: 0.1,
  TARGET_SESSION: 0.12,
  TARGET_ASSET: 0.13,
  HAS_VULN: 0.2,
  LEAKED: 0.18,
  RELATED_VULN: 0.16,
  SNAPSHOT_TARGETS: 0.15,
  SNAPSHOT_VULN: 0.18,
  TASK_TOUCHED_HOST: 0.1
}

export const LINK_WIDTH = 0.32
/** Derived edges are also thinner, not just fainter (see legend copy). */
export const DERIVED_LINK_WIDTH = 0.16
export const LINK_HIGHLIGHT_OPACITY = 0.75

/**
 * `three-forcegraph@1.43` (pulled in by react-force-graph-3d 1.29) has no
 * `linkLineDash` accessor, so derived relations are encoded as *fainter and
 * thinner* lines instead of dashed ones — the spec (§3.3) allows either.
 */
export const DERIVED_LINK_DASH: [number, number] = [2, 3]

export function linkOpacity(relation: GraphRelation, derived: boolean): number {
  const base = LINK_OPACITY[relation]
  return derived ? base * 0.7 : base
}

/* ------------------------------------------------------------------ motion -- */

export const CAMERA_FOCUS_MS = 800
export const CAMERA_RESET_MS = 700
export const AUTO_ROTATE_SPEED = 0.5
/** Idle delay before auto-rotation resumes after a pointer interaction. */
export const AUTO_ROTATE_RESUME_MS = 4000
/** Initial camera distance for the default framing of the whole graph. */
export const DEFAULT_CAMERA_DISTANCE = 320

/* ------------------------------------------------------------- sprite assets -- */

export const SPRITE_TEXTURE_SIZE = 128
/** Label textures are rendered on the fly; the size keeps text crisp. */
export const LABEL_TEXTURE_WIDTH = 512
export const LABEL_TEXTURE_HEIGHT = 128
export const LABEL_FONT = '500 44px "Inter Variable", Inter, system-ui, sans-serif'
export const LABEL_TEXT_COLOR = 'rgba(255, 255, 255, 0.94)'
export const LABEL_BG_COLOR = 'rgba(5, 5, 8, 0.72)'
export const LABEL_BORDER_COLOR = 'rgba(255, 255, 255, 0.16)'
export const LABEL_SPRITE_SCALE = 36
/** Labels stay visible (dimmed) so the canvas reads as a dense knowledge map. */
export const LABEL_IDLE_SCALE = 24
export const LABEL_IDLE_OPACITY = 0.55
export const LABEL_EMPHASIS_OPACITY = 0.95
export const LABEL_DIM_FACTOR = 0.4

/* ----------------------------------------------------------------- utilities -- */

/** `#rrggbb` → `rgba(r, g, b, a)` for canvas gradients and DOM inline styles. */
export function rgba(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha))
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${clamped})`
}

/**
 * Pre-blend a colour against the canvas background at the given "alpha".
 *
 * Three.js `Color` parses `rgba(...)` but silently drops the alpha channel, so
 * link colours cannot carry transparency. The canvas background is nearly pure
 * black, so blending here is visually equivalent to alpha and keeps per-relation
 * opacity working with `LineBasicMaterial`.
 */
export function blendOnCanvas(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha))
  const [r, g, b] = hexToRgb(hex)
  const [br, bg, bb] = hexToRgb(NEBULA_BACKGROUND)
  const mix = (channel: number, background: number): string =>
    Math.round(channel * clamped + background * (1 - clamped))
      .toString(16)
      .padStart(2, '0')
  return `#${mix(r, br)}${mix(g, bg)}${mix(b, bb)}`
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  const value =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => `${char}${char}`)
          .join('')
      : normalized
  const int = Number.parseInt(value, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

/** Node dimming factor when a search is active and the node does not match. */
export const DIM_OPACITY = 0.14
export const SEARCH_MATCH_HIGHLIGHT_OPACITY = 0.95

/* ------------------------------------------------------- P3 performance mode -- */

/**
 * Above this many elements (nodes + links) the canvas switches to "performance
 * mode": idle labels and halos are disabled, so large graphs stay interactive
 * (P3). Aggregation into `+N` cluster nodes is the next step after this.
 */
export const PERFORMANCE_MODE_ELEMENT_LIMIT = 420
/** Focus neighbourhood dims everything outside the selected node's N-hop set. */
export const FOCUS_DIM_OPACITY = 0.09
/** Halo glow is dropped in performance mode; only the selected node keeps one. */
export const PERFORMANCE_SELECTED_HALO_OPACITY = 0.55

/* ------------------------------------------------- background starfield (P3) -- */

/**
 * Procedural deep-space backdrop (P3 feedback): a *realistic-ish* nebula instead
 * of plain dots — two large generated gas-cloud textures (multi-scale puffs,
 * filaments, dark dust lanes, soft edge fade), a natural star field with varied
 * sizes/colour temperatures and a few bright stars, plus dust motes drifting
 * along the cloud filaments. All decorative: never raycast, labelled or counted.
 */
/**
 * Equirectangular nebula skybox (2:1). Baked into `scene.background` so the
 * backdrop surrounds the camera on every side — a world-space sprite only
 * covered the half of the orbit facing -Z and left the other side black.
 */
export const NEBULA_SKYBOX_WIDTH = 2_048
export const NEBULA_SKYBOX_HEIGHT = 1_024
/** 3D drift of the star / dust layers. */
export const STARFIELD_ROTATE_SPEED = 0.008

export const STARFIELD_FAR_COUNT = 1_300
export const STARFIELD_FAR_MIN_RADIUS = 820
export const STARFIELD_FAR_MAX_RADIUS = 2_100
export const STARFIELD_FAR_SIZE = 2.2
export const STARFIELD_FAR_OPACITY = 0.85

/** A handful of brighter stars with a wider halo. */
export const STARFIELD_BRIGHT_COUNT = 48
export const STARFIELD_BRIGHT_SIZE = 5.5
export const STARFIELD_BRIGHT_OPACITY = 0.95

/** Dust motes clustered along the nebula filaments. */
export const STARFIELD_DUST_COUNT = 1_500
export const STARFIELD_DUST_SIZE = 4
export const STARFIELD_DUST_OPACITY = 0.26
export const STARFIELD_DUST_CLUSTERS = 7

export const STARFIELD_FAR_COLOR = '#dbeafe'
export const STARFIELD_DUST_COLOR = '#93c5fd'
