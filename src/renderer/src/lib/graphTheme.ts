import type { GraphNodeType, GraphRelation, LeakNode, NebulaNode } from '@shared/graph'
import type { Severity } from '@shared/types'

/**
 * Single source of truth for the Memory Nebula's J.A.R.V.I.S. tactical HUD.
 *
 * The whole nebula surface was rebuilt as a dark holographic HUD (visual
 * language ported from the reference `1.html` demo): deep-space navy `#02040A`,
 * cyan `#00E5FF` chrome, danger `#FF3366`, warning `#FFAA00`, success
 * `#10B981`, muted `#5C8FAE`, JetBrains Mono everywhere.
 *
 * This module deliberately stays free of React/Three imports (only shared
 * graph/types), so it can be consumed by the 3D canvas, the DOM label layer,
 * the 2D fallback and every glass panel without pulling the renderer in.
 */

/* ------------------------------------------------------------------ palette -- */

export const HUD = {
  /** Page + canvas background (deep-space navy black). */
  bg: '#02040A',
  /** Slightly lifted panel surface. */
  panel: '#020A14',
  cyan: '#00E5FF',
  cyanSoft: '#7DEBFF',
  cyanDim: '#1B8FA8',
  blue: '#3B82F6',
  violet: '#8B5CF6',
  danger: '#FF3366',
  warning: '#FFAA00',
  success: '#10B981',
  white: '#FFFFFF',
  /** Primary HUD text. */
  text: '#C7E9F5',
  /** Secondary / muted HUD text. */
  muted: '#5C8FAE',
  /** Faint text + decorative lines. */
  faint: 'rgba(92, 143, 174, 0.35)'
} as const

/**
 * Monospace stack used for every HUD string (DOM + canvas + SVG).
 *
 * JetBrains Mono covers Latin/numerals only, so a modern CJK fallback is placed
 * before the generic `monospace`: at HUD sizes (11–13px) the legacy SimSun
 * fallback rendered Chinese with thin, broken strokes on the dark surface.
 * Chinese glyphs therefore use the crisp Windows/PingFang UI sans while Latin
 * stays in JetBrains Mono.
 */
export const HUD_FONT =
  '"JetBrains Mono Variable", "JetBrains Mono", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", ui-monospace, SFMono-Regular, Consolas, monospace'

/** HUD backdrop overlays (see `<HudBackdrop />`). */
export const HUD_OVERLAY = {
  gridSizePx: 40,
  gridColor: 'rgba(0, 229, 255, 0.02)',
  gridColorStrong: 'rgba(0, 229, 255, 0.045)',
  scanlineColor: 'rgba(0, 229, 255, 0.15)',
  scanlineGlow: 'rgba(0, 229, 255, 0.3)',
  scanlineDurationMs: 6000,
  cornerSizePx: 20,
  cornerColor: 'rgba(0, 229, 255, 0.4)',
  vignette:
    'radial-gradient(ellipse at center, rgba(0,229,255,0.035) 0%, rgba(2,4,10,0) 55%, rgba(2,4,10,0.55) 100%)'
} as const

export const NEBULA_BACKGROUND = HUD.bg

/* --------------------------------------------------------------- UI classes -- */

/**
 * Tailwind class recipes for the HUD chrome. Panels must read as one material:
 * translucent navy glass, hairline cyan border, cyan glow, mono type.
 */
export const NEBULA_UI = {
  glass:
    'border border-[#00E5FF]/20 bg-[#020A14]/85 backdrop-blur-md shadow-[0_0_28px_-10px_rgba(0,229,255,0.45)]',
  /** HUD panels are near-square; the reference uses 2px corner notches. */
  panelRadius: 'rounded-[3px]',
  divider: 'border-[#00E5FF]/[0.12]',
  heading: 'font-mono text-[12px] uppercase tracking-[0.09em] text-[#00E5FF]',
  body: 'font-mono text-[13px] text-[#A9D6E5]',
  muted: 'font-mono text-[11px] text-[#7FA9BE]',
  faint: 'font-mono text-[10.5px] text-[#4E7387]',
  accent: 'text-[#00E5FF]',
  focusRing:
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#00E5FF]/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#02040A]',
  /** Button shells shared by toolbar / panel actions. */
  button:
    'inline-flex items-center justify-center gap-1.5 rounded-[2px] border border-[#00E5FF]/25 bg-[#020A14]/70 font-mono uppercase tracking-[0.06em] text-[#8FB8CC] transition-colors duration-150 hover:border-[#00E5FF]/60 hover:bg-[#00E5FF]/[0.08] hover:text-[#00E5FF] active:bg-[#00E5FF]/[0.14] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#00E5FF]/25 disabled:hover:bg-[#020A14]/70 disabled:hover:text-[#8FB8CC]',
  buttonPrimary:
    'inline-flex items-center justify-center gap-1.5 rounded-[2px] border border-[#00E5FF]/65 bg-[#00E5FF]/[0.12] font-mono uppercase tracking-[0.06em] text-[#00E5FF] transition-colors duration-150 hover:bg-[#00E5FF]/20 active:bg-[#00E5FF]/25 disabled:cursor-not-allowed disabled:opacity-40',
  buttonDanger:
    'inline-flex items-center justify-center gap-1.5 rounded-[2px] border border-[#FF3366]/50 bg-[#FF3366]/[0.1] font-mono uppercase tracking-[0.06em] text-[#FF7A9C] transition-colors duration-150 hover:bg-[#FF3366]/20 hover:text-[#FF99B4]',
  input:
    'w-full rounded-[2px] border border-[#00E5FF]/20 bg-[#01060D]/80 font-mono text-[12.5px] text-[#C7E9F5] placeholder:text-[#4E7387] transition-colors duration-150 hover:border-[#00E5FF]/35 focus:border-[#00E5FF]/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-[#00E5FF]/40',
  /**
   * Small uppercase label above a value / section. 11px is the hard floor for
   * HUD micro copy and tracking stays ≤0.1em so Chinese labels (which fall back
   * to the CJK UI sans) do not break into widely spaced, unreadable glyphs.
   */
  label: 'font-mono text-[11px] uppercase tracking-[0.08em] text-[#7FA9BE]',
  value: 'font-mono text-[13px] tabular-nums text-[#C7E9F5]',
  chip:
    'inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[11px] tracking-[0.05em]'
} as const

/* ------------------------------------------------------------- node colours -- */

/** HUD hierarchy: project violet → target blue → host cyan → evidence. */
export const NODE_TYPE_COLORS: Record<GraphNodeType, string> = {
  project: HUD.violet,
  target: HUD.blue,
  host: HUD.cyan,
  vuln: HUD.danger,
  leak: HUD.white,
  snapshot: HUD.success
}

/** Vulns are coloured by severity (Critical/High share the danger red). */
export const SEVERITY_NODE_COLORS: Record<Severity, string> = {
  Critical: HUD.danger,
  High: HUD.danger,
  Medium: HUD.warning,
  Low: HUD.muted,
  Info: '#3E6274'
}

/** DOM badge classes for the inspector / legend (dark HUD surface variants). */
export const SEVERITY_BADGE_CLASSES: Record<Severity, string> = {
  Critical: 'border-[#FF3366]/45 bg-[#FF3366]/[0.1] text-[#FF7A9C]',
  High: 'border-[#FF3366]/35 bg-[#FF3366]/[0.08] text-[#FF8FA8]',
  Medium: 'border-[#FFAA00]/40 bg-[#FFAA00]/[0.08] text-[#FFC766]',
  Low: 'border-[#00E5FF]/25 bg-[#00E5FF]/[0.06] text-[#9ADBEA]',
  Info: 'border-[#5C8FAE]/30 bg-[#5C8FAE]/[0.08] text-[#8FB8CC]'
}

export const STATUS_BADGE_CLASSES: Record<string, string> = {
  Confirmed: 'border-[#FF3366]/30 bg-[#FF3366]/[0.08] text-[#FF8FA8]',
  Inconclusive: 'border-[#FFAA00]/30 bg-[#FFAA00]/[0.08] text-[#FFC766]',
  Retest_Passed: 'border-[#10B981]/35 bg-[#10B981]/[0.1] text-[#5EEAD4]',
  Alive: 'border-[#10B981]/35 bg-[#10B981]/[0.1] text-[#5EEAD4]',
  Dead: 'border-[#5C8FAE]/25 bg-[#5C8FAE]/[0.08] text-[#8FB8CC]',
  WAF_Blocked: 'border-[#FFAA00]/35 bg-[#FFAA00]/[0.1] text-[#FFC766]'
}

export function nodeColor(node: NebulaNode): string {
  if (node.type === 'vuln') return SEVERITY_NODE_COLORS[node.severity]
  return NODE_TYPE_COLORS[node.type]
}

/* -------------------------------------------------------------- node sizing -- */

/**
 * Wireframe shell radius in world units. The force layout places direct
 * neighbours 28–96 units apart, so shells stay in the 2.5–11 range and leave
 * room for the white core, the additive glow and the projected label above.
 */
const SHELL_BASE: Record<GraphNodeType, readonly [number, number, number]> = {
  project: [2.1, 9, 14],
  target: [1.9, 8, 12],
  host: [1.35, 6, 10],
  vuln: [1.15, 3.6, 6],
  leak: [0.85, 2.6, 4],
  snapshot: [1.45, 5, 8.5]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Wireframe outer radius for a node (also drives focus distance + label lift). */
export function nodeRadius(node: NebulaNode): number {
  const [base, min, max] = SHELL_BASE[node.type]
  return clamp(base * Math.sqrt(Math.max(1, node.val)), min, max)
}

/** White emissive core tucked inside the wireframe shell. */
export function nodeCoreRadius(node: NebulaNode): number {
  return Math.max(0.7, nodeRadius(node) * 0.3)
}

/** Additive halo sprite diameter relative to the shell radius. */
export function nodeGlowScale(node: NebulaNode): number {
  const factor = node.type === 'host' || node.type === 'project' || node.type === 'target' ? 5.2 : 4.4
  return nodeRadius(node) * factor
}

/* ----------------------------------------------------------------- link style -- */

/**
 * Links stay a faint cyan web (never brighter than the nodes). Relation types
 * keep a subtle hue difference so the legend remains truthful, but everything
 * is pulled toward the HUD palette.
 */
export const LINK_COLORS: Record<GraphRelation, string> = {
  BELONGS_TO: '#2E7DA0',
  TARGET_SESSION: HUD.cyan,
  TARGET_ASSET: '#00B8D9',
  HAS_VULN: HUD.cyan,
  LEAKED: HUD.white,
  RELATED_VULN: HUD.muted,
  SNAPSHOT_TARGETS: HUD.success,
  SNAPSHOT_VULN: HUD.success,
  TASK_TOUCHED_HOST: HUD.cyan
}

/** Pre-blended alpha look; hairline links stay between ~0.10 and ~0.22. */
export const LINK_OPACITY: Record<GraphRelation, number> = {
  BELONGS_TO: 0.1,
  TARGET_SESSION: 0.16,
  TARGET_ASSET: 0.14,
  HAS_VULN: 0.22,
  LEAKED: 0.18,
  RELATED_VULN: 0.13,
  SNAPSHOT_TARGETS: 0.16,
  SNAPSHOT_VULN: 0.18,
  TASK_TOUCHED_HOST: 0.12
}

export const LINK_WIDTH = 0.32
/** Derived edges are also thinner, not just fainter (see legend copy). */
export const DERIVED_LINK_WIDTH = 0.16
/** Connected edges while hovering/selected get this opacity multiplier. */
export const LINK_HIGHLIGHT_OPACITY = 0.85
/** Unrelated edges while hovering/selected fade out to near-invisible. */
export const LINK_DIM_OPACITY = 0.035
/** `three-forcegraph` has no line-dash accessor; derived = thinner + fainter. */
export const DERIVED_LINK_DASH: [number, number] = [2, 3]

export function linkOpacity(relation: GraphRelation, derived: boolean): number {
  const base = LINK_OPACITY[relation]
  return derived ? base * 0.7 : base
}

/* ------------------------------------------------------------------ motion -- */

export const CAMERA_FOV = 45
export const CAMERA_FOCUS_MS = 900
export const CAMERA_RESET_MS = 800
/** Slow holo-table auto-rotation (reference: 0.5). */
export const AUTO_ROTATE_SPEED = 0.5
/** Idle delay before auto-rotation resumes after a pointer interaction. */
export const AUTO_ROTATE_RESUME_MS = 4000
/** Initial camera distance for the default framing of the whole graph. */
export const DEFAULT_CAMERA_DISTANCE = 420
/**
 * Default orbit elevation as a fraction of the camera distance. A slight
 * top-down angle (reference demo: camera above the holo-table) is what makes the
 * grid floor and its coordinate axes readable in the default view; 0 would put
 * the camera exactly at graph height and hide the plane under the constellation.
 */
export const DEFAULT_CAMERA_ELEVATION = 0.26

/** Wireframe spin + breathing, paused for reduced-motion users. */
export const NODE_SPIN_SPEED = 0.34
export const NODE_BREATHE_SPEED = 1.6
export const NODE_BREATHE_AMPLITUDE = 0.045
export const NODE_HOVER_SCALE = 1.14

export const CAMERA_LOD_NEAR = 1.7
export const CAMERA_LOD_FAR = 2.9

/* -------------------------------------------------------------------- scene -- */

/** Atmospheric depth, gentle enough not to swallow the nearest nodes. */
export const FOG_DENSITY = 0.00105

/** Holographic grid floor parked below the graph bounding box. */
export const GRID_Y_OFFSET = 75
export const GRID_SIZE_MIN = 700
export const GRID_SIZE_MAX = 2600
export const GRID_DIVISIONS = 80
/** Just above the 0.1 reference value so the floor reads without competing. */
export const GRID_OPACITY = 0.15

/** Sparse static starfield behind the holo-table (decorative, never raycast). */
export const STARFIELD_COUNT = 480
export const STARFIELD_RADIUS = 1500
export const STARFIELD_SIZE = 2.1
export const STARFIELD_OPACITY = 0.6
export const STARFIELD_ROTATE_SPEED = 0.008
export const STARFIELD_COLOR = '#BFE9FF'

/** Additive flow particles travelling along the links (reference: 流光). */
export const FLOW_PARTICLE_COLOR = '#FFFFFF'
export const FLOW_PARTICLE_SIZE = 2.6
/** Per-link particle count (1 normal, 2 for the most important relations). */
export const FLOW_PARTICLES_PER_LINK = 1
export const FLOW_PARTICLE_MAX = 220
export const FLOW_SPEED_RANGE: readonly [number, number] = [0.055, 0.14]

/* ------------------------------------------------------------- DOM labels -- */

export type LabelVariant = 'default' | 'danger' | 'warning' | 'white' | 'success' | 'muted'

/**
 * 2D projected labels replace the old canvas sprites: absolutely positioned DOM
 * buttons over the canvas, updated with `transform` every frame (never layout).
 */
export const LABEL = {
  /** Single-line label height (px) used by the overlap test. */
  heightPx: 26,
  /** Horizontal padding around the label box when testing overlap. */
  overlapPaddingPx: 3,
  /** Lift of the label above the node shell, in world units. */
  lift: 11,
  /** Hard cap of simultaneously visible labels. */
  maxVisible: 80,
  maxVisiblePerformance: 24,
  maxVisibleFar: 38,
  /** Re-run priority / overlap / LOD culling no more often than this. */
  cullIntervalMs: 140,
  /** Max characters before the CSS ellipsis kicks in (single line). */
  maxChars: 26
} as const

/** Label shape: dark glass pill with a 1px cyan border and 3px left bar. */
export const LABEL_UI: Record<LabelVariant, string> = {
  default:
    'border-[#00E5FF]/40 border-l-[#00E5FF] text-[#C7E9F5] shadow-[0_0_10px_rgba(0,229,255,0.1)]',
  danger:
    'border-[#FF3366]/45 border-l-[#FF3366] text-[#FF7A9C] shadow-[0_0_10px_rgba(255,51,102,0.18)]',
  warning:
    'border-[#FFAA00]/45 border-l-[#FFAA00] text-[#FFC766] shadow-[0_0_10px_rgba(255,170,0,0.16)]',
  white:
    'border-white/35 border-l-white text-white shadow-[0_0_10px_rgba(255,255,255,0.14)]',
  success:
    'border-[#10B981]/45 border-l-[#10B981] text-[#5EEAD4] shadow-[0_0_10px_rgba(16,185,129,0.16)]',
  muted:
    'border-[#5C8FAE]/35 border-l-[#5C8FAE] text-[#8FB8CC] shadow-[0_0_8px_rgba(92,143,174,0.1)]'
}

export const LABEL_BASE_CLASS = [
  'pointer-events-auto absolute left-0 top-0 z-[5] max-w-[280px] cursor-pointer select-none',
  'overflow-hidden text-ellipsis whitespace-nowrap',
  'border border-l-[3px] bg-[#020A14]/[0.85] px-2 py-[3px]',
  'font-mono text-[12.5px] font-medium leading-[18px] tracking-[0.01em] backdrop-blur-[2px]',
  '[will-change:transform] transition-opacity duration-150'
].join(' ')

export function labelVariantOf(node: NebulaNode): LabelVariant {
  if (node.type === 'vuln') {
    if (node.severity === 'Critical' || node.severity === 'High') return 'danger'
    if (node.severity === 'Medium') return 'warning'
    return 'muted'
  }
  if (node.type === 'leak') return 'white'
  if (node.type === 'snapshot') return 'success'
  return 'default'
}

const CREDENTIAL_LEAK_TYPES: ReadonlySet<string> = new Set(['Credential', 'API_Key', 'Token'])

/**
 * Label priority (higher wins the overlap test). Selection/hover always win;
 * structural nodes come next; evidence is ranked by severity and by the
 * importance of the leaked secret kind.
 */
export function nodeLabelPriority(node: NebulaNode, selected: boolean, hovered: boolean): number {
  if (selected) return 1000
  if (hovered) return 950
  const aggregate = node.type === 'vuln' || node.type === 'leak' ? node.data.aggregate : undefined
  const aggregateBoost = aggregate !== undefined && aggregate !== null ? 40 : 0
  switch (node.type) {
    case 'project':
      return 820
    case 'target':
      return 780
    case 'host':
      return 740
    case 'snapshot':
      return 580
    case 'vuln': {
      const severityRank: Record<Severity, number> = {
        Critical: 720,
        High: 690,
        Medium: 600,
        Low: 480,
        Info: 450
      }
      return severityRank[node.severity] + aggregateBoost
    }
    case 'leak': {
      const leak = node as LeakNode
      return (CREDENTIAL_LEAK_TYPES.has(leak.data.info_type) ? 560 : 520) + aggregateBoost
    }
  }
}

/* --------------------------------------------------------------- dimming -- */

/** Node dimming factor when a search is active and the node does not match. */
export const DIM_OPACITY = 0.14
/** Unrelated nodes while hovering a node ("focus + context" mode). */
export const HOVER_CONTEXT_DIM_OPACITY = 0.06
export const SEARCH_MATCH_HIGHLIGHT_OPACITY = 0.95
/** Focus neighbourhood dims everything outside the selected node's N-hop set. */
export const FOCUS_DIM_OPACITY = 0.09
/** Selected/hovered shell emphasis. */
export const EMPHASIS_OPACITY = 0.95

/* ------------------------------------------------------- P3 performance mode -- */

/**
 * Above this many elements (nodes + links) the canvas switches to "performance
 * mode": idle labels and halos are disabled, wireframes drop a detail level and
 * the flow particles are thinned out.
 */
export const PERFORMANCE_MODE_ELEMENT_LIMIT = 420
/** Focus neighbourhood dims everything outside the selected node's N-hop set. */
export const PERFORMANCE_SELECTED_HALO_OPACITY = 0.55

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

export function hexToRgb(hex: string): [number, number, number] {
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
