import { useMemo } from 'react'
import { aggregateInfoOf, type NebulaLink, type NebulaNode } from '@shared/graph'
import { useI18n } from '@renderer/i18n'
import { LINK_COLORS, NEBULA_BACKGROUND, nodeColor } from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'

/**
 * 2D fallback for environments without WebGL (guide §10, P3).
 *
 * Deliberately simple: a deterministic circular layout (hosts on a ring, their
 * children in golden-angle orbits around the host, unparented nodes on an outer
 * ring), rendered as SVG so search highlighting, type filters, selection and
 * the inspector keep working without a GPU. No simulation and no animation.
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

  return (
    <div
      className={cn('relative h-full w-full overflow-hidden', className)}
      style={{ backgroundColor: NEBULA_BACKGROUND }}
      role="img"
      aria-label={t('nebula.canvas.ariaLabel')}
    >
      <p className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-white/10 bg-[#0b0c10]/[0.82] px-3 py-1 text-[10.5px] text-white/45 backdrop-blur-xl">
        {t('nebula.mode2d.label')}
      </p>

      <svg
        className="h-full w-full"
        viewBox={layout.viewBox}
        preserveAspectRatio="xMidYMid meet"
        onClick={() => onSelect(null)}
      >
        <g>
          {links.map((link, index) => {
            const from = positions.get(link.source)
            const to = positions.get(link.target)
            if (from === undefined || to === undefined) return null
            const opacity = link.derived === true ? 0.1 : 0.2
            return (
              <line
                key={`link-${index}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={LINK_COLORS[link.relation]}
                strokeOpacity={opacity}
                strokeWidth={0.9}
              />
            )
          })}
        </g>
        <g>
          {layout.nodes.map(({ node, x, y, radius }) => {
            const color = nodeColor(node)
            const opacity = opacityOf(node)
            const selected = node.id === selectedId
            const label = node.name.length > 34 ? `${node.name.slice(0, 33)}…` : node.name
            return (
              <g
                key={node.id}
                transform={`translate(${x} ${y})`}
                opacity={opacity}
                className="cursor-pointer"
                onClick={(event) => {
                  event.stopPropagation()
                  onSelect(node.id)
                }}
              >
                {/* soft glow ring */}
                <circle r={radius * 2.1} fill={color} fillOpacity={0.16} />
                <circle
                  r={radius}
                  fill={color}
                  fillOpacity={0.9}
                  stroke={selected ? 'rgba(255,255,255,0.9)' : 'transparent'}
                  strokeWidth={selected ? 1.6 : 0}
                />
                {showLabel(node) ? (
                  <text
                    x={0}
                    y={radius + 10}
                    textAnchor="middle"
                    fontSize={9}
                    fill="rgba(255,255,255,0.72)"
                    style={{ pointerEvents: 'none', paintOrder: 'stroke' }}
                    stroke="rgba(5,5,5,0.75)"
                    strokeWidth={2.5}
                  >
                    {label}
                  </text>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
