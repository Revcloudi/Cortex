import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  ExternalLink,
  X
} from 'lucide-react'
import type {
  GraphNeighbor,
  HostNode,
  LeakNode,
  NebulaNode,
  ProjectNode,
  SnapshotNode,
  TargetNode,
  VulnNode
} from '@shared/graph'
import { useCopy } from '@renderer/hooks/useCopy'
import { useI18n } from '@renderer/i18n'
import { formatDateTimeFull, formatVulnType } from '@renderer/lib/format'
import {
  NEBULA_UI,
  NODE_TYPE_COLORS,
  SEVERITY_BADGE_CLASSES,
  SEVERITY_NODE_COLORS,
  STATUS_BADGE_CLASSES,
  nodeColor,
  rgba
} from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'

export interface NodeInspectorProps {
  /** Never null: the page mounts the inspector only when a node is selected. */
  node: NebulaNode
  /** Both link directions touching `node` in the *visible* graph. */
  neighbors: GraphNeighbor[]
  onClose: () => void
  /** Click a related node chip → select it (page re-renders inspector). */
  onSelectNode: (nodeId: string) => void
  /**
   * Label for the "view full details" button (vuln / asset / snapshot only).
   * The drawer is intentionally summary-only; long evidence lives on the page.
   */
  detailLabel: string | null
  onOpenDetail: () => void
  className?: string
}

/** Preview limits: the drawer never renders full evidence / inventories. */
const LEAK_PREVIEW_CHARS = 32
const TEXT_PREVIEW_CHARS = 90
const RELATION_LIMIT = 6
const CHIP_LIMIT = 4

/** Shared dark micro-button (copy / expand affordances). */
const GHOST_BUTTON = cn(
  'inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.04]',
  'px-1.5 py-1 text-[10.5px] text-white/55 transition-colors duration-150',
  'hover:border-white/20 hover:bg-white/[0.08] hover:text-white/85',
  NEBULA_UI.focusRing
)

function preview(value: string, maxChars = TEXT_PREVIEW_CHARS): string {
  const trimmed = value.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`
}

/* ------------------------------------------------------------------ atoms -- */

interface FieldProps {
  label: string
  children: ReactNode
  /** Use the mono face for ids, hosts and URLs. */
  mono?: boolean
  className?: string
}

/** One definition-list row: uppercase micro label above a readable value. */
function Field({ label, children, mono = false, className }: FieldProps) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[10.5px] uppercase leading-relaxed tracking-[0.14em] text-white/35">
        {label}
      </dt>
      <dd
        className={cn(
          'mt-1 break-words text-[12.5px] leading-relaxed text-white/75',
          mono && 'font-mono'
        )}
      >
        {children}
      </dd>
    </div>
  )
}

/** Rounded status/type pill (colour comes from the graphTheme badge maps). */
function Pill({
  className,
  style,
  children
}: {
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium',
        className
      )}
      style={style}
    >
      {children}
    </span>
  )
}

/** Wrapping mono chips for id / host lists (bounded by CHIP_LIMIT). */
function ChipList({ values, mono = true }: { values: readonly string[]; mono?: boolean }) {
  const { t } = useI18n()
  if (values.length === 0) {
    return <span className="text-[12.5px] text-white/40">{t('nebula.field.none')}</span>
  }
  const shown = values.slice(0, CHIP_LIMIT)
  const rest = values.length - shown.length
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className={cn(
            'inline-block max-w-full break-all rounded border border-white/10 bg-white/[0.05]',
            'px-1.5 py-0.5 text-[10.5px] leading-relaxed text-white/65',
            mono && 'font-mono'
          )}
        >
          {value}
        </span>
      ))}
      {rest > 0 ? (
        <span className="inline-block rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10.5px] text-white/35">
          +{rest}
        </span>
      ) : null}
    </span>
  )
}

/** Type badge: vulns inherit their severity colour, other types their node hue. */
function TypeBadge({ node }: { node: NebulaNode }) {
  const { t } = useI18n()
  if (node.type === 'vuln') {
    return (
      <Pill className={SEVERITY_BADGE_CLASSES[node.severity]}>
        <span
          aria-hidden="true"
          className="mr-1 h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: SEVERITY_NODE_COLORS[node.severity] }}
        />
        {t('nebula.type.vuln')}
      </Pill>
    )
  }
  const color = NODE_TYPE_COLORS[node.type]
  return (
    <Pill
      style={{
        borderColor: rgba(color, 0.35),
        backgroundColor: rgba(color, 0.12),
        color: rgba(color, 0.9)
      }}
    >
      <span
        aria-hidden="true"
        className="mr-1 h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {t(`nebula.type.${node.type}`)}
    </Pill>
  )
}

/* -------------------------------------------------------------- summaries -- */

function HostSummary({ node }: { node: HostNode }) {
  const { t } = useI18n()
  const { data } = node
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <Field label={t('nebula.field.project')} className="col-span-2">
        {data.project_name.trim().length > 0 ? data.project_name : t('nebula.field.none')}
      </Field>
      <Field label={t('nebula.field.status')}>
        <Pill className={STATUS_BADGE_CLASSES[data.status]}>
          {t(`label.assetStatus.${data.status}`)}
        </Pill>
      </Field>
      <Field label={t('nebula.field.lastSeen')}>{formatDateTimeFull(data.last_seen)}</Field>
      <Field label={t('nebula.field.techStack')} className="col-span-2">
        {data.tech_stack.trim().length > 0 ? preview(data.tech_stack, 72) : t('nebula.field.none')}
      </Field>
      <Field label={t('nebula.field.interfaces')} mono>
        {data.interface_count}
      </Field>
      <Field label={t('nebula.field.leaks')} mono>
        {data.leaked_count}
      </Field>
    </dl>
  )
}

function VulnSummary({ node }: { node: VulnNode }) {
  const { t } = useI18n()
  const { data } = node
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <Field label={t('nebula.field.severity')}>
        <Pill className={SEVERITY_BADGE_CLASSES[node.severity]}>
          {t(`label.severity.${node.severity}`)}
        </Pill>
      </Field>
      <Field label={t('nebula.field.status')}>
        <Pill className={STATUS_BADGE_CLASSES[node.status]}>{t(`label.status.${node.status}`)}</Pill>
      </Field>
      <Field label={t('nebula.field.vulnType')}>{formatVulnType(data.vuln_type, t)}</Field>
      <Field label={t('nebula.field.host')} mono>
        {data.host}
      </Field>
      {data.service_host !== undefined && data.service_host.length > 0 ? (
        <Field label={t('nebula.field.serviceHost')} mono className="col-span-2">
          <span className="break-all">{data.service_host}</span>
        </Field>
      ) : null}
      <Field label={t('nebula.field.targetUrl')} mono className="col-span-2">
        <span className="break-all">{data.target_url}</span>
      </Field>
      {data.related_vuln_ids.length > 0 ? (
        <Field label={t('nebula.field.relatedVulns')} mono className="col-span-2">
          {t('nebula.inspector.relatedCount', { count: data.related_vuln_ids.length })}
        </Field>
      ) : null}
    </dl>
  )
}

function LeakValue({ value }: { value: string }) {
  const { t } = useI18n()
  const { copied, copy } = useCopy()
  const truncated = value.length > LEAK_PREVIEW_CHARS
  const shown = truncated ? `${value.slice(0, LEAK_PREVIEW_CHARS)}…` : value
  return (
    <div className="min-w-0">
      <p className="break-all rounded-md border border-white/[0.06] bg-black/25 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-white/70">
        {shown}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void copy(value, t('nebula.inspector.copied'))}
          className={GHOST_BUTTON}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3 w-3 text-emerald-400" />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3" />
          )}
          {copied ? t('nebula.inspector.copied') : t('nebula.inspector.copy')}
        </button>
        {truncated ? (
          <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10.5px] text-white/35">
            {t('nebula.inspector.truncated')}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function LeakSummary({ node }: { node: LeakNode }) {
  const { t } = useI18n()
  const { data } = node
  const color = NODE_TYPE_COLORS.leak
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <Field label={t('nebula.field.infoType')} className="col-span-2">
        <Pill
          style={{
            borderColor: rgba(color, 0.35),
            backgroundColor: rgba(color, 0.12),
            color: rgba(color, 0.9)
          }}
        >
          {t(`ui.leakType.${data.info_type}`)}
        </Pill>
      </Field>
      <Field label={t('nebula.field.host')} mono className="col-span-2">
        {data.host}
      </Field>
      <Field label={t('nebula.field.value')} className="col-span-2">
        <LeakValue value={data.value} />
      </Field>
      <Field label={t('nebula.field.source')} className="col-span-2">
        {preview(data.source, 80)}
      </Field>
      <Field label={t('nebula.field.impact')} className="col-span-2">
        {preview(data.potential_impact, 110)}
      </Field>
    </dl>
  )
}

function SnapshotSummary({ node }: { node: SnapshotNode }) {
  const { t } = useI18n()
  const { data } = node
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <Field label={t('nebula.field.project')} className="col-span-2">
        {data.project_name}
      </Field>
      <Field label={t('nebula.field.phase')} className="col-span-2">
        {data.current_phase.trim().length > 0
          ? preview(data.current_phase, 90)
          : t('nebula.field.none')}
      </Field>
      <Field label={t('nebula.field.session')} mono>
        {data.session_id}
      </Field>
      <Field label={t('nebula.field.updatedAt')}>
        {formatDateTimeFull(data.updated_at)}
      </Field>
      <Field label={t('nebula.field.targetHosts')} className="col-span-2">
        <ChipList values={data.target_hosts} />
      </Field>
      <Field label={t('nebula.field.relatedVulns')} className="col-span-2">
        {data.related_vuln_ids.length > 0
          ? t('nebula.inspector.relatedCount', { count: data.related_vuln_ids.length })
          : t('nebula.field.none')}
      </Field>
    </dl>
  )
}

/** Compact summary for a collapsed `+N` node (large-graph aggregation). */
function AggregateSummary({ node }: { node: VulnNode | LeakNode }) {
  const { t } = useI18n()
  const aggregate = node.data.aggregate
  if (aggregate === undefined) return null
  const accent =
    aggregate.kind === 'vuln'
      ? SEVERITY_NODE_COLORS[aggregate.severity ?? 'Info']
      : NODE_TYPE_COLORS.leak
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <Field label={t('nebula.aggregate.countLabel')} mono>
        {aggregate.count}
      </Field>
      <Field label={t('nebula.field.host')} mono>
        {node.data.host}
      </Field>
      <Field label={t('nebula.aggregate.severityLabel')}>
        {aggregate.severity !== undefined ? (
          <Pill className={SEVERITY_BADGE_CLASSES[aggregate.severity]}>
            {t(`label.severity.${aggregate.severity}`)}
          </Pill>
        ) : (
          <Pill
            style={{
              borderColor: rgba(accent, 0.35),
              backgroundColor: rgba(accent, 0.12),
              color: rgba(accent, 0.9)
            }}
          >
            {t('nebula.type.leak')}
          </Pill>
        )}
      </Field>
      <Field label={t('nebula.aggregate.samplesLabel')} className="col-span-2">
        <ChipList values={aggregate.samples} mono={false} />
      </Field>
      <div className="col-span-2 rounded-md border border-white/[0.06] bg-black/25 px-2.5 py-2 text-[11px] leading-relaxed text-white/45">
        {t('nebula.aggregate.hint')}
      </div>
    </dl>
  )
}

function ProjectSummary({ node }: { node: ProjectNode }) {
  const { t } = useI18n()
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <Field label={t('nebula.field.project')} className="col-span-2">
        {node.data.project_name}
      </Field>
      <Field label={t('nebula.field.assetCount', { count: node.data.asset_count })} mono>
        {node.data.asset_count}
      </Field>
      <Field label={t('nebula.field.sessionCount', { count: node.data.session_count })} mono>
        {node.data.session_count}
      </Field>
    </dl>
  )
}

function TargetSummary({ node }: { node: TargetNode }) {
  const { t } = useI18n()
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <Field label={t('nebula.field.target')} mono className="col-span-2">
        <span className="break-all">{node.data.target}</span>
      </Field>
      <Field label={t('nebula.field.project')} className="col-span-2">
        {node.data.project_name}
      </Field>
      <Field label={t('nebula.field.hostKey')} mono className="col-span-2">
        {node.data.host_key}
      </Field>
      <Field label={t('nebula.field.assetCount', { count: node.data.asset_count })} mono>
        {node.data.asset_count}
      </Field>
      <Field label={t('nebula.field.sessionCount', { count: node.data.session_count })} mono>
        {node.data.session_count}
      </Field>
    </dl>
  )
}

/** Discriminated-union dispatch — no casts, every branch gets its own data type. */
function NodeSummary({ node }: { node: NebulaNode }) {
  switch (node.type) {
    case 'project':
      return <ProjectSummary node={node} />
    case 'target':
      return <TargetSummary node={node} />
    case 'host':
      return <HostSummary node={node} />
    case 'vuln':
      return node.data.aggregate === undefined ? (
        <VulnSummary node={node} />
      ) : (
        <AggregateSummary node={node} />
      )
    case 'leak':
      return node.data.aggregate === undefined ? (
        <LeakSummary node={node} />
      ) : (
        <AggregateSummary node={node} />
      )
    case 'snapshot':
      return <SnapshotSummary node={node} />
    default:
      return null
  }
}

/* ------------------------------------------------------------ relations -- */

function RelationChip({
  neighbor,
  onSelectNode
}: {
  neighbor: GraphNeighbor
  onSelectNode: (nodeId: string) => void
}) {
  const { t } = useI18n()
  const outgoing = neighbor.direction === 'outgoing'
  const DirectionIcon = outgoing ? ArrowUpRight : ArrowDownLeft
  return (
    <button
      type="button"
      onClick={() => onSelectNode(neighbor.node.id)}
      title={t('nebula.inspector.openNode', { name: neighbor.node.name })}
      className={cn(
        'group inline-flex max-w-full items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03]',
        'px-2 py-1 text-left transition-colors duration-150 hover:border-white/20 hover:bg-white/[0.07]',
        NEBULA_UI.focusRing
      )}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: nodeColor(neighbor.node) }}
      />
      <span className="max-w-[9.5rem] truncate text-[11.5px] text-white/75 group-hover:text-white/90">
        {neighbor.node.name}
      </span>
      <span className="max-w-[9rem] truncate text-[10.5px] text-white/35">
        {t(`nebula.legend.relation.${neighbor.relation}`)}
      </span>
      {neighbor.derived ? (
        <span className="shrink-0 rounded border border-white/10 bg-white/[0.04] px-1 text-[10.5px] text-white/35">
          {t('nebula.inspector.derived')}
        </span>
      ) : null}
      <DirectionIcon aria-hidden="true" className="h-3 w-3 shrink-0 text-white/30" />
      <span className="sr-only">{t(`nebula.inspector.direction.${neighbor.direction}`)}</span>
    </button>
  )
}

/* ------------------------------------------------------------------ drawer -- */

/**
 * Right-hand glass drawer: type badge + identity, a **compact** per-type
 * summary (long evidence/inventories live on the dedicated page), relation
 * chips and a "view full details" button. Slide-in on mount only.
 */
export function NodeInspector({
  node,
  neighbors,
  onClose,
  onSelectNode,
  detailLabel,
  onOpenDetail,
  className
}: NodeInspectorProps) {
  const { t } = useI18n()
  const [entered, setEntered] = useState(false)

  // Two rAF ticks so the browser paints the off-screen state before animating.
  useEffect(() => {
    let second = 0
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setEntered(true))
    })
    return () => {
      window.cancelAnimationFrame(first)
      window.cancelAnimationFrame(second)
    }
  }, [])

  const shownNeighbors = neighbors.slice(0, RELATION_LIMIT)

  return (
    <aside
      aria-label={t('nebula.inspector.title')}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden border-l border-white/[0.08]',
        'bg-[#0b0c10]/95 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.85)] backdrop-blur-xl',
        'transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none',
        entered ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0',
        'motion-reduce:translate-x-0 motion-reduce:opacity-100',
        className
      )}
    >
      <header className="sticky top-0 z-10 shrink-0 border-b border-white/[0.07] bg-[#0b0c10]/85 px-4 pb-3 pt-3.5 backdrop-blur-xl">
        <div className="flex items-start justify-between gap-2">
          <TypeBadge node={node} />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('nebula.inspector.close')}
            title={t('nebula.inspector.close')}
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/45',
              'transition-colors duration-150 hover:bg-white/[0.08] hover:text-white/85',
              NEBULA_UI.focusRing
            )}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
        <h2 className="mt-2.5 break-words text-[13.5px] font-medium leading-snug text-white/90">
          {node.name}
        </h2>
        <p className="mt-1 truncate font-mono text-[10.5px] text-white/30" title={node.id}>
          {node.id}
        </p>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {/* Keyed by node id so local state resets when selection changes. */}
        <NodeSummary key={node.id} node={node} />

        <section className="mt-4">
          <h3 className="text-[10.5px] font-medium uppercase leading-relaxed tracking-[0.14em] text-white/35">
            {t('nebula.inspector.relations', { count: neighbors.length })}
          </h3>
          {neighbors.length === 0 ? (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/40">
              {t('nebula.inspector.noRelations')}
            </p>
          ) : (
            <>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {shownNeighbors.map((neighbor, index) => (
                  <li
                    key={`${neighbor.node.id}-${neighbor.relation}-${neighbor.direction}-${index}`}
                    className="min-w-0"
                  >
                    <RelationChip neighbor={neighbor} onSelectNode={onSelectNode} />
                  </li>
                ))}
              </ul>
              {neighbors.length > shownNeighbors.length ? (
                <p className="mt-1.5 text-[10.5px] text-white/30">
                  {t('nebula.inspector.relationsMore', {
                    count: neighbors.length - shownNeighbors.length
                  })}
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>

      {detailLabel !== null ? (
        <footer className="shrink-0 border-t border-white/[0.07] bg-[#0b0c10]/90 px-4 py-3 backdrop-blur-xl">
          <button
            type="button"
            onClick={onOpenDetail}
            className={cn(
              'inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-sky-400/30 bg-sky-400/10',
              'text-[12.5px] font-medium text-sky-200 transition-colors duration-150',
              'hover:border-sky-400/50 hover:bg-sky-400/15 hover:text-sky-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
              'focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c10]'
            )}
          >
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            {detailLabel}
          </button>
        </footer>
      ) : null}
    </aside>
  )
}
