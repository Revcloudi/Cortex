import { ChevronDown, ChevronUp, Layers } from 'lucide-react'
import type { GraphNodeType } from '@shared/graph'
import { DERIVED_RELATIONS, GRAPH_RELATIONS } from '@shared/graph'
import type { Severity } from '@shared/types'
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

const ICON_BUTTON_CLASS = cn(
  'inline-flex h-5 w-5 items-center justify-center rounded text-white/40',
  'transition-colors duration-150 hover:bg-white/10 hover:text-white/80',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60'
)

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
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] text-white/60',
          'transition-colors duration-150 hover:bg-white/[0.08] hover:text-white/85',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
          'focus-visible:ring-offset-2 focus-visible:ring-offset-[#050505]',
          className
        )}
      >
        <Layers aria-hidden="true" className="h-3 w-3" />
        {t('nebula.legend.title')}
        <ChevronUp aria-hidden="true" className="h-3 w-3 text-white/35" />
      </button>
    )
  }

  return (
    <section
      aria-label={t('nebula.legend.title')}
      className={cn(
        NEBULA_UI.glass,
        NEBULA_UI.panelRadius,
        'scrollbar-thin w-full max-w-[320px] overflow-y-auto p-3 text-[10.5px] leading-relaxed text-white/70',
        'max-h-[min(58vh,470px)]',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium uppercase tracking-[0.16em] text-white/30">
          {t('nebula.legend.title')}
        </h2>
        <button
          type="button"
          aria-expanded
          aria-label={t('nebula.legend.collapse')}
          title={t('nebula.legend.collapse')}
          onClick={onToggle}
          className={ICON_BUTTON_CLASS}
        >
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ---------------------------------------------------------- node types -- */}
      <ul className="mt-2 space-y-1">
        {NODE_TYPES.map((type) => {
          const color = NODE_TYPE_COLORS[type]
          return (
            <li key={type} className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color, boxShadow: `0 0 6px ${rgba(color, 0.55)}` }}
              />
              <span className="min-w-0 text-white/60">{t(`nebula.legend.${type}`)}</span>
              {type === 'vuln' ? (
                <span className="ml-auto flex shrink-0 items-center gap-1 pl-1.5">
                  {VULN_SEVERITIES.map((severity) => (
                    <span
                      key={severity}
                      aria-hidden="true"
                      title={t(`label.severity.${severity}`)}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: SEVERITY_NODE_COLORS[severity] }}
                    />
                  ))}
                </span>
              ) : null}
            </li>
          )
        })}
        {hasAggregates ? (
          <li className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-full border border-white/40 font-mono text-[7px] leading-none text-white/60"
            >
              +
            </span>
            <span className="min-w-0 text-white/55">{t('nebula.legend.aggregate')}</span>
          </li>
        ) : null}
      </ul>

      {/* ----------------------------------------------------------- relations -- */}
      <div className={cn('mt-2.5 border-t pt-2', NEBULA_UI.divider)}>
        <h3 className="font-medium uppercase tracking-[0.16em] text-white/30">
          {t('nebula.legend.relation.title')}
        </h3>
        <ul className="mt-1.5 space-y-1">
          {GRAPH_RELATIONS.map((relation) => {
            const derived = DERIVED_RELATIONS.includes(relation)
            return (
              <li key={relation} className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-0 w-3.5 shrink-0 border-t border-solid"
                  style={{
                    borderColor: LINK_COLORS[relation],
                    opacity: derived ? 0.22 : 0.85
                  }}
                />
                <span className="min-w-0 truncate text-white/50">
                  {t(`nebula.legend.relation.${relation}`)}
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      {/* One-line note; the longer explanation stays in the title tooltip. */}
      <p
        className="mt-2 flex min-w-0 items-center gap-1.5 text-white/35"
        title={t('nebula.legend.derivedHint')}
      >
        <span
          aria-hidden="true"
          className="h-0 w-3.5 shrink-0 border-t border-solid"
          style={{ borderColor: LINK_COLORS.RELATED_VULN, opacity: 0.22 }}
        />
        <span className="min-w-0">{t('nebula.legend.derived')}</span>
      </p>
    </section>
  )
}
