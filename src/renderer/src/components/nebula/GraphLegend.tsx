import { ChevronDown, ChevronUp, Layers } from 'lucide-react'
import type { GraphNodeType, GraphRelation } from '@shared/graph'
import { DERIVED_RELATIONS, GRAPH_RELATIONS } from '@shared/graph'
import type { Severity } from '@shared/types'
import {
  HudButton,
  HudPanel,
  HudPanelHeader,
  HudSectionTitle
} from '@renderer/components/nebula/HudChrome'
import { useI18n } from '@renderer/i18n'
import {
  LINK_COLORS,
  NEBULA_UI,
  NODE_TYPE_COLORS,
  SEVERITY_NODE_COLORS,
  rgba
} from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'

export interface GraphLegendProps {
  /** Collapsed to a pill unless the page opened it (page also repositions it). */
  expanded: boolean
  onToggle: () => void
  /** Show the `+N aggregation` note when the canvas contains collapsed nodes. */
  hasAggregates?: boolean
  className?: string
}

/** The node kinds, in hierarchy order: project → target → asset → evidence. */
const NODE_TYPES: readonly GraphNodeType[] = [
  'project',
  'target',
  'host',
  'vuln',
  'leak',
  'snapshot'
]

/** Tiny severity swatches that hint the vuln sprites are severity-coloured. */
const VULN_SEVERITIES: readonly Severity[] = ['Critical', 'High', 'Medium', 'Low']

/** Single-letter micro-chips: full severity names stay available in the title. */
const SEVERITY_CHIP: Record<Severity, string> = {
  Critical: 'C',
  High: 'H',
  Medium: 'M',
  Low: 'L',
  Info: 'I'
}

/**
 * Node glyph silhouettes mirror the canvas: project/target are multi-sided
 * shells, host reads as an icosahedron-ish hexagon, vulns are octagons, leaks
 * are diamonds and snapshots are rings. Keeping the legend shapes in sync with
 * the 3D/2D canvases is what makes the legend a true key instead of a list.
 */
const GLYPH_SIDES: Record<GraphNodeType, number | null> = {
  project: 5,
  target: 6,
  host: 6,
  vuln: 8,
  leak: 4,
  snapshot: null
}

function glyphPoints(sides: number, radius: number, rotation = -Math.PI / 2): string {
  const points: string[] = []
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + (index * Math.PI * 2) / sides
    points.push(`${(Math.cos(angle) * radius).toFixed(2)},${(Math.sin(angle) * radius).toFixed(2)}`)
  }
  return points.join(' ')
}

/** 14×14 wireframe-ish node swatch for one legend row. */
function LegendGlyph({ type }: { type: GraphNodeType }) {
  const color = NODE_TYPE_COLORS[type]
  const sides = GLYPH_SIDES[type]
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className="h-4 w-4 shrink-0"
      style={{ filter: `drop-shadow(0 0 3px ${rgba(color, 0.45)})` }}
    >
      {sides === null ? (
        <>
          <circle cx={7} cy={7} r={5.2} fill="none" stroke={color} strokeWidth={1.1} />
          <circle
            cx={7}
            cy={7}
            r={3}
            fill="none"
            stroke={color}
            strokeOpacity={0.4}
            strokeWidth={0.6}
          />
        </>
      ) : (
        <>
          <polygon
            points={glyphPoints(sides, 5.4)}
            transform="translate(7 7)"
            fill={rgba(color, 0.12)}
            stroke={color}
            strokeWidth={1.1}
          />
          {type === 'host' ? (
            <polygon
              points={glyphPoints(3, 2.4, Math.PI / 2)}
              transform="translate(7 7)"
              fill="none"
              stroke={color}
              strokeOpacity={0.55}
              strokeWidth={0.6}
            />
          ) : null}
        </>
      )}
      {/* Every node in the nebula has a white emissive core dot. */}
      <circle cx={7} cy={7} r={1.2} fill="#FFFFFF" />
    </svg>
  )
}

/** Hairline line swatch used by the relation rows (dashed when derived). */
function RelationSwatch({ relation, derived = false }: { relation: GraphRelation; derived?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('h-0 w-5 shrink-0 border-t', derived ? 'border-dashed' : 'border-solid')}
      style={{
        borderColor: LINK_COLORS[relation],
        opacity: derived ? 0.55 : 0.95
      }}
    />
  )
}

/**
 * Canvas legend. Collapsed to a small pill by default so it never overlaps the
 * (often taller) control panel; the page owns the expanded state and moves the
 * expanded card to the right of the panel. Purely passive otherwise.
 */
export function GraphLegend({
  expanded,
  onToggle,
  hasAggregates = false,
  className
}: GraphLegendProps) {
  const { t } = useI18n()

  if (!expanded) {
    return (
      <button
        type="button"
        aria-expanded={false}
        aria-label={t('nebula.legend.expand')}
        title={t('nebula.legend.expand')}
        onClick={onToggle}
        className={cn(
          NEBULA_UI.glass,
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5',
          'font-mono text-[11px] uppercase tracking-[0.08em] text-[#A9D6E5]',
          'transition-colors duration-150 hover:border-[#00E5FF]/60 hover:bg-[#00E5FF]/[0.08] hover:text-[#00E5FF]',
          NEBULA_UI.focusRing,
          className
        )}
      >
        <Layers aria-hidden="true" className="h-3 w-3 text-[#00E5FF]/70" />
        {t('nebula.legend.title')}
        <ChevronUp aria-hidden="true" className="h-3 w-3 text-[#5C8FAE]" />
      </button>
    )
  }

  return (
    <section
      aria-label={t('nebula.legend.title')}
      className={cn('w-full max-w-[320px]', className)}
    >
      <HudPanel accent className="flex max-h-[min(58vh,470px)] flex-col">
        <HudPanelHeader
          title={t('nebula.legend.title')}
          actions={
            <HudButton
              size="icon"
              variant="ghost"
              aria-expanded
              aria-label={t('nebula.legend.collapse')}
              title={t('nebula.legend.collapse')}
              onClick={onToggle}
            >
              <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
            </HudButton>
          }
          className="shrink-0 pb-2.5"
        />

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {/* ---------------------------------------------------- node types -- */}
          <HudSectionTitle>{t('nebula.hud.legendNodes')}</HudSectionTitle>
          <ul className="mt-1.5 divide-y divide-[#00E5FF]/[0.07]">
            {NODE_TYPES.map((type) => {
              return (
                <li key={type} className="flex min-w-0 items-center gap-2 py-1.5">
                  <LegendGlyph type={type} />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-relaxed text-[#A9D6E5]"
                    title={t(`nebula.legend.${type}`)}
                  >
                    {t(`nebula.legend.${type}`)}
                  </span>
                  {type === 'vuln' ? (
                    <span className="flex shrink-0 items-center gap-0.5">
                      {VULN_SEVERITIES.map((severity) => {
                        const color = SEVERITY_NODE_COLORS[severity]
                        return (
                          <span
                            key={severity}
                            aria-hidden="true"
                            title={t(`label.severity.${severity}`)}
                            className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-[1px] border px-0.5 font-mono text-[10.5px] leading-none"
                            style={{
                              borderColor: rgba(color, 0.45),
                              backgroundColor: rgba(color, 0.12),
                              color: rgba(color, 0.95)
                            }}
                          >
                            {SEVERITY_CHIP[severity]}
                          </span>
                        )
                      })}
                    </span>
                  ) : null}
                </li>
              )
            })}
            {hasAggregates ? (
              <li className="flex min-w-0 items-center gap-2 py-1">
                <span
                  aria-hidden="true"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[1px] border border-[#00E5FF]/45 bg-[#00E5FF]/[0.08] font-mono text-[10.5px] leading-none text-[#00E5FF]"
                >
                  +N
                </span>
                <span className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed text-[#8FB8CC]">
                  {t('nebula.legend.aggregate')}
                </span>
              </li>
            ) : null}
          </ul>

          {/* ----------------------------------------------------- relations -- */}
          <HudSectionTitle className="mt-3">{t('nebula.hud.legendRelations')}</HudSectionTitle>
          <ul className="mt-1.5 space-y-1">
            {GRAPH_RELATIONS.map((relation) => {
              const derived = DERIVED_RELATIONS.includes(relation)
              return (
                <li key={relation} className="flex min-w-0 items-center gap-2 py-0.5">
                  <RelationSwatch relation={relation} derived={derived} />
                  <span
                    className="min-w-0 truncate font-mono text-[11.5px] leading-relaxed text-[#8FB8CC]"
                    title={t(`nebula.legend.relation.${relation}`)}
                  >
                    {t(`nebula.legend.relation.${relation}`)}
                  </span>
                </li>
              )
            })}
          </ul>

          {/* One-line note; the longer explanation stays in the title tooltip. */}
          <p
            className="mt-2.5 flex min-w-0 cursor-help items-center gap-2 border-t border-[#00E5FF]/[0.08] pt-2 font-mono text-[11px] leading-relaxed text-[#7FA9BE]"
            title={t('nebula.legend.derivedHint')}
          >
            <RelationSwatch relation="RELATED_VULN" derived />
            <span className="min-w-0">{t('nebula.legend.derived')}</span>
          </p>
        </div>
      </HudPanel>
    </section>
  )
}
