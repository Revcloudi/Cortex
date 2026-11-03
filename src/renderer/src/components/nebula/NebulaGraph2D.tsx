import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { aggregateInfoOf, type NebulaLink, type NebulaNode } from '@shared/graph'
import { HudStatusDot } from '@renderer/components/nebula/HudChrome'
import { useI18n } from '@renderer/i18n'
import {
  DERIVED_LINK_DASH,
  HUD,
  HUD_FONT,
  HUD_OVERLAY,
  LINK_COLORS,
  NEBULA_BACKGROUND,
  labelVariantOf,
  linkOpacity,
  nodeColor,
  rgba,
  type LabelVariant
} from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'

/**
 * 2D fallback for environments without WebGL (guide §10, P3).
 *
 * Deliberately simple: a deterministic circular layout (hosts on a ring, their
 * children in golden-angle orbits around the host, unparented nodes on an outer
 * ring), rendered as SVG so search highlighting, type filters, selection and
 * the inspector keep working without a GPU. No simulation and no animation.
 *
 * The HUD dress keeps the layout maths untouched: the canvas gets the same
 * #02040A holo grid as the 3D scene, nodes become wireframe glyphs with a white
 * core, and labels are counter-scaled so they stay 12px mono boxes no matter how
 * far the graph zooms out.
 */

export interface NebulaGraph2DProps {
  nodes: NebulaNode[]
  links: NebulaLink[]
  selectedId: string | null
  highlightIds: string[] | null
  focusIds: string[] | null
  performanceMode: boolean
  onSelect: (nodeId: string | null) => void
  className?: string
}

interface PositionedNode {
  node: NebulaNode
  x: number
  y: number
  radius: number
}

interface Layout {
  nodes: PositionedNode[]
  viewBox: string
}

const PADDING = 90

/** Label boxes are drawn in screen pixels via a counter-scale transform. */
const LABEL_FONT_SIZE = 12
const LABEL_CHAR_WIDTH = 7.2
const LABEL_BOX_HEIGHT = 19
const LABEL_BAR_WIDTH = 3
/** Hard cap for one label box (px); longer names get a single ellipsis. */
const LABEL_MAX_WIDTH = 210

/** Label text / border / 3px bar colours per HUD label variant. */
const LABEL_SVG: Record<LabelVariant, { border: string; bar: string; text: string }> = {
  default: { border: rgba(HUD.cyan, 0.4), bar: HUD.cyan, text: HUD.text },
  danger: { border: rgba(HUD.danger, 0.45), bar: HUD.danger, text: '#FF7A9C' },
  warning: { border: rgba(HUD.warning, 0.45), bar: HUD.warning, text: '#FFC766' },
  white: { border: 'rgba(255,255,255,0.35)', bar: HUD.white, text: HUD.white },
  success: { border: rgba(HUD.success, 0.45), bar: HUD.success, text: '#5EEAD4' },
  muted: { border: rgba(HUD.muted, 0.4), bar: HUD.muted, text: '#8FB8CC' }
}

function radiusOf(node: NebulaNode): number {
  if (node.type === 'host') return 11 + Math.min(10, Math.sqrt(node.val) * 1.4)
  if (node.type === 'snapshot') return 7 + Math.min(6, Math.sqrt(node.val) * 1.2)
  return 5 + Math.min(9, Math.sqrt(node.val) * 1.6)
}

function computeLayout(nodes: readonly NebulaNode[], links: readonly NebulaLink[]): Layout {
  const hosts = nodes.filter((node) => node.type === 'host')
  const hostPositions = new Map<string, { x: number; y: number }>()
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
  const spacing = 58
  // Sunflower (phyllotaxis) packing fills the canvas instead of one big ring.
  const hostOrbit = Math.sqrt(Math.max(1, hosts.length)) * spacing

  hosts.forEach((host, index) => {
    const radius = Math.sqrt(index + 0.5) * spacing
    const angle = index * GOLDEN_ANGLE
    hostPositions.set(host.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    })
  })

  // Attach children to the host they belong to, when the graph says so.
  const parentHostOf = new Map<string, string>()
  for (const link of links) {
    if (link.relation === 'HAS_VULN' || link.relation === 'LEAKED') {
      if (hostPositions.has(link.source) && !parentHostOf.has(link.target)) {
        parentHostOf.set(link.target, link.source)
      }
    } else if (link.relation === 'SNAPSHOT_TARGETS') {
      if (hostPositions.has(link.target) && !parentHostOf.has(link.source)) {
        parentHostOf.set(link.source, link.target)
      }
    }
  }

  const childrenByHost = new Map<string, NebulaNode[]>()
  const unparented: NebulaNode[] = []
  for (const node of nodes) {
    if (node.type === 'host') continue
    const parent = parentHostOf.get(node.id)
    if (parent !== undefined) {
      const bucket = childrenByHost.get(parent) ?? []
      bucket.push(node)
      childrenByHost.set(parent, bucket)
    } else {
      unparented.push(node)
    }
  }

  const positioned: PositionedNode[] = []
  for (const host of hosts) {
    const position = hostPositions.get(host.id)
    if (position === undefined) continue
    positioned.push({ node: host, x: position.x, y: position.y, radius: radiusOf(host) })
  }

  for (const [hostId, children] of childrenByHost) {
    const center = hostPositions.get(hostId)
    if (center === undefined) continue
    const sorted = [...children].sort((left, right) => left.id.localeCompare(right.id))
    sorted.forEach((child, index) => {
      const orbit = 26 + Math.sqrt(index + 1) * 15
      const angle = index * GOLDEN_ANGLE
      positioned.push({
        node: child,
        x: center.x + Math.cos(angle) * orbit,
        y: center.y + Math.sin(angle) * orbit,
        radius: radiusOf(child)
      })
    })
  }

  unparented.forEach((node, index) => {
    const radius = hostOrbit + 90 + Math.sqrt(index + 1) * 26
    const angle = index * GOLDEN_ANGLE
    positioned.push({
      node,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      radius: radiusOf(node)
    })
  })

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const entry of positioned) {
    minX = Math.min(minX, entry.x - entry.radius)
    minY = Math.min(minY, entry.y - entry.radius)
    maxX = Math.max(maxX, entry.x + entry.radius)
    maxY = Math.max(maxY, entry.y + entry.radius)
  }
  if (!Number.isFinite(minX)) {
    return { nodes: [], viewBox: '-100 -100 200 200' }
  }
  return {
    nodes: positioned,
    viewBox: `${minX - PADDING} ${minY - PADDING} ${maxX - minX + PADDING * 2} ${maxY - minY + PADDING * 2}`
  }
}

/** CJK glyphs are nearly square: account for them when sizing label boxes. */
function charWidth(char: string): number {
  return /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(char) ? LABEL_FONT_SIZE : LABEL_CHAR_WIDTH
}

/** Truncate by rendered width so the SVG label text never spills out of its box. */
function truncateLabel(name: string, maxWidth: number): string {
  let result = ''
  let width = 0
  for (const char of name) {
    const next = charWidth(char)
    if (width + next > maxWidth) return `${result}…`
    result += char
    width += next
  }
  return result
}

function textWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/** Regular polygon centred on the node origin (rotation −90° puts a corner up). */
function polygonPoints(radius: number, sides: number, rotation = -Math.PI / 2): string {
  const points: string[] = []
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + (index * Math.PI * 2) / sides
    points.push(`${(Math.cos(angle) * radius).toFixed(2)},${(Math.sin(angle) * radius).toFixed(2)}`)
  }
  return points.join(' ')
}

/** Four HUD viewfinder brackets around the selected node. */
function SelectionBrackets({ radius }: { radius: number }) {
  const box = radius * 1.55
  const arm = Math.max(2.5, radius * 0.45)
  const path = [
    `M ${-box} ${-box + arm} L ${-box} ${-box} L ${-box + arm} ${-box}`,
    `M ${box - arm} ${-box} L ${box} ${-box} L ${box} ${-box + arm}`,
    `M ${box} ${box - arm} L ${box} ${box} L ${box - arm} ${box}`,
    `M ${-box + arm} ${box} L ${-box} ${box} L ${-box} ${box - arm}`
  ].join(' ')
  return (
    <path
      d={path}
      fill="none"
      stroke={HUD.cyan}
      strokeOpacity={0.9}
      strokeWidth={1.1}
      strokeLinecap="square"
    />
  )
}

/** Holographic node glyph: wireframe shell + white core + selection brackets. */
function NodeGlyph({
  node,
  radius,
  color,
  selected,
  focused
}: {
  node: NebulaNode
  radius: number
  color: string
  selected: boolean
  focused: boolean
}): ReactNode {
  const core = Math.max(1.6, radius * 0.22)
  return (
    <>
      {/* Outer additive halo (the reference's glow mesh). */}
      <circle r={radius * 1.9} fill={color} fillOpacity={0.1} />

      {node.type === 'project' ? (
        <>
          <polygon
            points={polygonPoints(radius * 1.1, 5)}
            fill={rgba(color, 0.08)}
            stroke={color}
            strokeOpacity={0.95}
            strokeWidth={1.2}
          />
          <circle r={radius * 0.62} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={0.6} />
        </>
      ) : node.type === 'target' ? (
        <>
          <polygon
            points={polygonPoints(radius * 0.95, 6)}
            fill={rgba(color, 0.08)}
            stroke={color}
            strokeOpacity={0.9}
            strokeWidth={1.1}
          />
          <polygon
            points={polygonPoints(radius * 0.5, 6, Math.PI / 2)}
            fill="none"
            stroke={color}
            strokeOpacity={0.35}
            strokeWidth={0.6}
          />
        </>
      ) : node.type === 'host' ? (
        <>
          {/* Icosahedron-ish host shell: hexagon + inner triangle + orbit ring. */}
          <polygon
            points={polygonPoints(radius, 6)}
            fill={rgba(color, 0.1)}
            stroke={color}
            strokeOpacity={0.95}
            strokeWidth={1.2}
          />
          <polygon
            points={polygonPoints(radius * 0.62, 3, Math.PI / 2)}
            fill="none"
            stroke={color}
            strokeOpacity={0.55}
            strokeWidth={0.7}
          />
          <circle r={radius * 1.22} fill="none" stroke={color} strokeOpacity={0.3} strokeWidth={0.6} />
        </>
      ) : node.type === 'vuln' ? (
        <>
          {/* Octagon; the severity colour comes from nodeColor(). */}
          <polygon
            points={polygonPoints(radius, 8)}
            fill={rgba(color, 0.12)}
            stroke={color}
            strokeWidth={1.5}
          />
          <polygon
            points={polygonPoints(radius * 0.58, 8)}
            fill="none"
            stroke={color}
            strokeOpacity={0.45}
            strokeWidth={0.6}
          />
        </>
      ) : node.type === 'leak' ? (
        <>
          <polygon
            points={polygonPoints(radius, 4)}
            fill={rgba(color, 0.08)}
            stroke={color}
            strokeOpacity={0.95}
            strokeWidth={1.2}
          />
          <polygon
            points={polygonPoints(radius * 0.55, 4)}
            fill="none"
            stroke={color}
            strokeOpacity={0.35}
            strokeWidth={0.6}
          />
        </>
      ) : (
        <>
          {/* Snapshot: emerald double ring. */}
          <circle r={radius} fill="none" stroke={color} strokeWidth={1.4} />
          <circle r={radius * 0.6} fill="none" stroke={color} strokeOpacity={0.4} strokeWidth={0.6} />
        </>
      )}

      {/* Pure white emissive core, matching the 3D scene. */}
      <circle r={core * 2.2} fill={HUD.white} fillOpacity={0.1} />
      <circle r={core} fill={HUD.white} />

      {selected ? (
        <>
          <circle
            r={radius * 1.8}
            fill="none"
            stroke={HUD.white}
            strokeOpacity={0.8}
            strokeWidth={0.7}
            strokeDasharray="3 3"
          />
          <SelectionBrackets radius={radius} />
        </>
      ) : focused ? (
        <circle
          r={radius * 1.8}
          fill="none"
          stroke={HUD.cyan}
          strokeOpacity={0.6}
          strokeWidth={0.7}
          strokeDasharray="2 3"
        />
      ) : null}
    </>
  )
}

export function NebulaGraph2D({
  nodes,
  links,
  selectedId,
  highlightIds,
  focusIds,
  performanceMode,
  onSelect,
  className
}: NebulaGraph2DProps) {
  const { t } = useI18n()
  const layout = useMemo(() => computeLayout(nodes, links), [nodes, links])
  const positions = useMemo(
    () => new Map(layout.nodes.map((entry) => [entry.node.id, entry] as const)),
    [layout]
  )

  const highlightSet = useMemo(
    () => (highlightIds === null ? null : new Set(highlightIds)),
    [highlightIds]
  )
  const focusSet = useMemo(() => (focusIds === null ? null : new Set(focusIds)), [focusIds])

  const opacityOf = (node: NebulaNode): number => {
    const selected = node.id === selectedId
    const matched = highlightSet === null || highlightSet.has(node.id)
    const inFocus = focusSet === null || focusSet.has(node.id) || selected
    return matched && inFocus ? 1 : 0.12
  }

  const showLabel = (node: NebulaNode): boolean => {
    if (node.id === selectedId) return true
    if (aggregateInfoOf(node) !== null) return true
    // Large graphs keep only aggregate labels to avoid text soup; small graphs
    // additionally label hosts and heavy nodes.
    if (performanceMode) return false
    if (node.type === 'host') return true
    return node.val >= 14
  }

  // Unique per instance: pattern ids cannot collide if the fallback ever mounts
  // twice (StrictMode / future split view).
  const svgRef = useRef<SVGSVGElement | null>(null)
  const gridId = `nebula2d-grid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  /**
   * SVG text scales with the viewBox, so labels would shrink to nothing on a
   * large graph. Measure the real px-per-user-unit factor and counter-scale the
   * label groups, keeping every HUD label at a constant 11px.
   */
  const [pixelScale, setPixelScale] = useState(1)
  // Measure before paint so the label counter-scale never flashes at the wrong size.
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    const measure = (): void => {
      const rect = svg.getBoundingClientRect()
      const box = svg.viewBox.baseVal
      if (rect.width <= 0 || rect.height <= 0 || box.width <= 0 || box.height <= 0) return
      setPixelScale(Math.min(rect.width / box.width, rect.height / box.height))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [layout.viewBox])
  const labelScale = 1 / Math.min(10, Math.max(0.05, pixelScale))

  const [focusedId, setFocusedId] = useState<string | null>(null)

  return (
    <div
      className={cn('relative h-full w-full overflow-hidden', className)}
      style={{ backgroundColor: NEBULA_BACKGROUND, backgroundImage: HUD_OVERLAY.vignette }}
      role="group"
      aria-label={t('nebula.canvas.ariaLabel')}
    >
      <p className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-[2px] border border-[#00E5FF]/30 bg-[#020A14]/[0.88] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-[#00E5FF] shadow-[0_0_20px_-8px_rgba(0,229,255,0.6)] backdrop-blur-md">
        <HudStatusDot tone="warning" />
        {t('nebula.mode2d.label')}
      </p>

      <svg
        ref={svgRef}
        className="h-full w-full select-none"
        viewBox={layout.viewBox}
        preserveAspectRatio="xMidYMid meet"
        onClick={() => onSelect(null)}
      >
        <defs>
          {/* 40-user-unit cyan holo grid, the SVG counterpart of the HUD backdrop. */}
          <pattern id={gridId} width={40} height={40} patternUnits="userSpaceOnUse">
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke={HUD.cyan}
              strokeOpacity={0.05}
              strokeWidth={0.5}
            />
          </pattern>
        </defs>

        <rect
          x={-5000}
          y={-5000}
          width={10000}
          height={10000}
          fill={`url(#${gridId})`}
        />

        {/* Faint cyan link web; derived edges are thinner + dashed (see legend). */}
        <g>
          {links.map((link, index) => {
            const from = positions.get(link.source)
            const to = positions.get(link.target)
            if (from === undefined || to === undefined) return null
            const derived = link.derived === true
            return (
              <line
                key={`link-${index}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={LINK_COLORS[link.relation]}
                strokeOpacity={linkOpacity(link.relation, derived)}
                strokeWidth={derived ? 0.5 : 0.85}
                strokeDasharray={
                  derived ? `${DERIVED_LINK_DASH[0]} ${DERIVED_LINK_DASH[1]}` : undefined
                }
              />
            )
          })}
        </g>

        <g>
          {layout.nodes.map(({ node, x, y, radius }) => {
            const color = nodeColor(node)
            const opacity = opacityOf(node)
            const selected = node.id === selectedId
            const focused = focusedId === node.id && !selected
            const label = truncateLabel(node.name, LABEL_MAX_WIDTH - 14)
            const labelWidth = Math.round(textWidth(label) + 14)
            const labelStyle = LABEL_SVG[labelVariantOf(node)]
            return (
              <g
                key={node.id}
                transform={`translate(${x} ${y})`}
                opacity={opacity}
                role="button"
                tabIndex={0}
                aria-label={t('nebula.inspector.openNode', { name: node.name })}
                className="cursor-pointer outline-none"
                onFocus={() => setFocusedId(node.id)}
                onBlur={() => setFocusedId((current) => (current === node.id ? null : current))}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelect(node.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.stopPropagation()
                    onSelect(node.id)
                  }
                }}
              >
                {/* Browser tooltip for unlabeled nodes (aria-label names the action). */}
                <title>{node.name}</title>
                <NodeGlyph
                  node={node}
                  radius={radius}
                  color={color}
                  selected={selected}
                  focused={focused}
                />

                {showLabel(node) ? (
                  <>
                    {/* Stem connecting the glyph to its projected-style label box. */}
                    <line
                      x1={0}
                      y1={-radius}
                      x2={0}
                      y2={-(radius + 4)}
                      stroke={labelStyle.bar}
                      strokeOpacity={0.45}
                      strokeWidth={0.8}
                    />
                    <g transform={`translate(0 ${-(radius + 5)}) scale(${labelScale})`}>
                      <rect
                        x={-labelWidth / 2}
                        y={-LABEL_BOX_HEIGHT}
                        width={labelWidth}
                        height={LABEL_BOX_HEIGHT}
                        fill={NEBULA_BACKGROUND}
                        fillOpacity={0.92}
                        stroke={labelStyle.border}
                        strokeWidth={1}
                      />
                      {/* 3px left bar — the reference label's signature detail. */}
                      <rect
                        x={-labelWidth / 2}
                        y={-LABEL_BOX_HEIGHT}
                        width={LABEL_BAR_WIDTH}
                        height={LABEL_BOX_HEIGHT}
                        fill={labelStyle.bar}
                      />
                      <text
                        x={-labelWidth / 2 + LABEL_BAR_WIDTH + 5}
                        y={-6.5}
                        fontFamily={HUD_FONT}
                        fontSize={LABEL_FONT_SIZE}
                        fill={labelStyle.text}
                      >
                        {label}
                      </text>
                    </g>
                  </>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
