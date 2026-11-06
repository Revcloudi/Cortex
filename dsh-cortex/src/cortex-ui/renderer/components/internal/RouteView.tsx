import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw, Route } from 'lucide-react'
import type { Foothold, PivotWithHops } from '@shared/types'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { formatDateTimeFull } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { InternalPanel } from './InternalPanel'
import { PIVOT_STATUS_STYLES } from './internalUi'

interface RouteViewProps {
  pivots: PivotWithHops[]
  footholds: Foothold[]
  loading: boolean
  error: string | null
  onRetry: () => void
}

interface LaneNode {
  key: string
  title: string
  subtitle: string
  detail: string
  tone: 'local' | 'entry' | 'hop'
}

const NODE_W = 148
const NODE_H = 62
const GAP = 70
const PAD_X = 16
const TOP = 22

/** Clip SVG text (no CSS ellipsis inside inline SVG). */
function clip(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function RouteSkeleton() {
  const { t } = useI18n()
  return (
    <div className="space-y-2 px-4 py-3" aria-hidden="true">
      <Skeleton className="h-6 w-[280px]" />
      <Skeleton className="h-[120px] w-full" />
      <Skeleton className="h-3 w-[320px]" />
      <span role="status" className="sr-only">
        {t('internal.route.loading')}
      </span>
    </div>
  )
}

/**
 * 2D pivot route view (§8.3): `LOCAL → entry asset / foothold → hops` drawn as
 * an inline SVG lane. Edge style encodes the pivot status: established solid,
 * planned dashed, degraded amber dashed, lost gray/dotted.
 */
export function RouteView({ pivots, footholds, loading, error, onRetry }: RouteViewProps) {
  const { t } = useI18n()
  const [selectedPivotId, setSelectedPivotId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedPivotId((previous) =>
      previous !== null && pivots.some((pivot) => pivot.id === previous)
        ? previous
        : (pivots[0]?.id ?? null)
    )
  }, [pivots])

  const selectedPivot = useMemo(
    () => pivots.find((pivot) => pivot.id === selectedPivotId) ?? null,
    [pivots, selectedPivotId]
  )

  const actions = (
    <Button
      variant="ghost"
      size="icon-sm"
      data-testid="internal-route-refresh"
      aria-label={t('common.refresh')}
      title={t('common.refresh')}
      onClick={onRetry}
    >
      <RefreshCw strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
    </Button>
  )

  const lane = useMemo(() => {
    if (selectedPivot === null) return null
    const foothold = footholds.find((item) => item.id === selectedPivot.foothold_id)
    const nodes: LaneNode[] = [
      {
        key: 'local',
        title: t('internal.route.local'),
        subtitle: t('internal.route.localEndpoint', {
          host: selectedPivot.local_host,
          port: selectedPivot.local_port
        }),
        detail: selectedPivot.local_protocol,
        tone: 'local'
      },
      {
        key: 'foothold',
        title: t('internal.route.foothold'),
        subtitle: foothold?.entry_host_port ?? '—',
        detail: foothold === undefined ? '' : t(`internal.foothold.access.${foothold.access_type}`),
        tone: 'entry'
      },
      ...selectedPivot.hops.map((hop, index) => ({
        key: `hop-${index}-${hop.seq}`,
        title:
          hop.label.trim().length > 0
            ? hop.label
            : t('internal.route.hop', { seq: index + 1 }),
        subtitle:
          hop.via.trim().length > 0
            ? hop.via
            : `${t(`internal.route.hopRefKind.${hop.ref_kind}`)} ${hop.ref_id}`,
        detail: t(`internal.route.hopRefKind.${hop.ref_kind}`),
        tone: 'hop' as const
      }))
    ]
    const edgeLabels = nodes.slice(1).map((_node, index) => {
      if (index === 0) {
        return selectedPivot.tool.trim().length > 0
          ? selectedPivot.tool
          : selectedPivot.local_protocol
      }
      const hop = selectedPivot.hops[index - 1]
      return hop?.via.trim() || selectedPivot.tool || '—'
    })
    const width = PAD_X * 2 + nodes.length * NODE_W + (nodes.length - 1) * GAP
    const height = TOP + NODE_H + 26
    return { nodes, edgeLabels, width, height }
  }, [selectedPivot, footholds, t])

  const statusStyle = selectedPivot === null ? null : PIVOT_STATUS_STYLES[selectedPivot.status]
  const edgeStroke =
    selectedPivot === null
      ? 'hsl(var(--border))'
      : selectedPivot.status === 'established'
        ? 'hsl(var(--foreground))'
        : selectedPivot.status === 'degraded'
          ? '#d97706'
          : selectedPivot.status === 'lost'
            ? '#cbd5e1'
            : 'hsl(var(--muted-foreground))'

  return (
    <InternalPanel
      testId="internal-route"
      title={t('internal.route.title')}
      count={pivots.length > 0 ? pivots.length : undefined}
      actions={actions}
    >
      {loading && pivots.length === 0 ? (
        <RouteSkeleton />
      ) : pivots.length === 0 ? (
        <EmptyState
          icon={error !== null ? AlertTriangle : Route}
          title={error !== null ? t('internal.page.loadError.title') : t('internal.route.empty.title')}
          description={error ?? t('internal.route.empty.description')}
        >
          {error !== null ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <div
            data-testid="internal-route-select"
            role="group"
            aria-label={t('internal.route.selectorAria')}
            className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5"
          >
            {pivots.map((pivot) => {
              const style = PIVOT_STATUS_STYLES[pivot.status]
              const active = pivot.id === selectedPivotId
              const kindLabel = t(`internal.route.kind.${pivot.kind}`)
              const name = pivot.tool.trim().length > 0 ? pivot.tool : kindLabel
              return (
                <button
                  key={pivot.id}
                  type="button"
                  data-testid="internal-route-option"
                  data-pivot-id={pivot.id}
                  data-status={pivot.status}
                  aria-pressed={active}
                  aria-label={t('internal.route.optionAria', { name })}
                  onClick={() => setSelectedPivotId(pivot.id)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'border-accent bg-accent-soft font-medium text-accent'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn('h-1.5 w-1.5 rounded-full', style.dot)}
                  />
                  <span className="max-w-[160px] truncate font-mono">{name}</span>
                  <span className={cn('rounded-full border px-1.5 text-[9.5px]', style.badge)}>
                    {t(`internal.route.status.${pivot.status}`)}
                  </span>
                </button>
              )
            })}
          </div>

          {selectedPivot !== null && lane !== null && statusStyle !== null ? (
            <div className="space-y-3 px-4 py-3">
              <div
                data-testid="internal-route-lane"
                data-pivot-id={selectedPivot.id}
                data-status={selectedPivot.status}
                className="overflow-x-auto rounded-[8px] border border-border bg-sidebar/50 p-2"
              >
                <svg
                  role="img"
                  aria-label={t('internal.route.description')}
                  width={lane.width}
                  height={lane.height}
                  viewBox={`0 0 ${lane.width} ${lane.height}`}
                  className="block"
                >
                  {lane.nodes.slice(0, -1).map((node, index) => {
                    const x1 = PAD_X + index * (NODE_W + GAP) + NODE_W
                    const x2 = PAD_X + (index + 1) * (NODE_W + GAP)
                    const midY = TOP + NODE_H / 2
                    const next = lane.nodes[index + 1]
                    return (
                      <g key={`edge-${node.key}`}>
                        <line
                          x1={x1}
                          y1={midY}
                          x2={x2 - 6}
                          y2={midY}
                          style={{ stroke: edgeStroke }}
                          strokeWidth={1.5}
                          strokeDasharray={statusStyle.dash}
                        />
                        <path
                          d={`M ${x2 - 11} ${midY - 3.5} L ${x2 - 4} ${midY} L ${x2 - 11} ${midY + 3.5}`}
                          fill="none"
                          style={{ stroke: edgeStroke }}
                          strokeWidth={1.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <text
                          x={(x1 + x2) / 2}
                          y={midY - 8}
                          textAnchor="middle"
                          fontSize={9.5}
                          style={{ fill: 'hsl(var(--muted-foreground))' }}
                        >
                          {clip(lane.edgeLabels[index] ?? '', 13)}
                        </text>
                        <title>
                          {`${node.title} → ${next?.title ?? ''}: ${
                            lane.edgeLabels[index] ?? ''
                          } · ${t(`internal.route.status.${selectedPivot.status}`)}`}
                        </title>
                      </g>
                    )
                  })}

                  {lane.nodes.map((node, index) => {
                    const x = PAD_X + index * (NODE_W + GAP)
                    const fill =
                      node.tone === 'local'
                        ? 'hsl(var(--accent-soft))'
                        : 'hsl(var(--background))'
                    const stroke =
                      node.tone === 'local'
                        ? 'hsl(var(--accent))'
                        : node.tone === 'entry'
                          ? '#d97706'
                          : 'hsl(var(--border))'
                    return (
                      <g key={node.key}>
                        <title>
                          {`${node.title} · ${node.subtitle}${node.detail.length > 0 ? ` · ${node.detail}` : ''}`}
                        </title>
                        <rect
                          x={x}
                          y={TOP}
                          width={NODE_W}
                          height={NODE_H}
                          rx={8}
                          style={{ fill, stroke }}
                          strokeWidth={1}
                        />
                        <circle
                          cx={x + NODE_W - 11}
                          cy={TOP + 11}
                          r={3}
                          style={{
                            fill:
                              node.tone === 'local'
                                ? 'hsl(var(--accent))'
                                : node.tone === 'entry'
                                  ? '#d97706'
                                  : 'hsl(var(--muted-foreground))'
                          }}
                        />
                        <text
                          x={x + 10}
                          y={TOP + 19}
                          fontSize={10.5}
                          fontWeight={node.tone === 'local' ? 600 : 500}
                          style={{ fill: 'hsl(var(--foreground))' }}
                        >
                          {clip(node.title, 20)}
                        </text>
                        <text
                          x={x + 10}
                          y={TOP + 35}
                          fontSize={9.5}
                          style={{ fill: 'hsl(var(--foreground))' }}
                        >
                          {clip(node.subtitle, 25)}
                        </text>
                        <text
                          x={x + 10}
                          y={TOP + 50}
                          fontSize={9}
                          style={{ fill: 'hsl(var(--muted-foreground))' }}
                        >
                          {clip(node.detail, 26)}
                        </text>
                      </g>
                    )
                  })}
                </svg>
              </div>

              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-4">
                <div className="min-w-0">
                  <dt className="text-[10px] font-medium text-foreground/60">
                    {t('internal.route.tool')}
                  </dt>
                  <dd className="font-mono text-[11.5px] text-foreground">
                    {selectedPivot.tool || '—'}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[10px] font-medium text-foreground/60">
                    {t('internal.route.kind')}
                  </dt>
                  <dd className="text-[11.5px] text-foreground">
                    {t(`internal.route.kind.${selectedPivot.kind}`)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[10px] font-medium text-foreground/60">
                    {t('internal.route.status')}
                  </dt>
                  <dd className="flex flex-wrap items-center gap-1.5">
                    <span className={cn('inline-flex h-[20px] items-center rounded-full border px-1.5 text-[10.5px] font-medium', statusStyle.badge)}>
                      {t(`internal.route.status.${selectedPivot.status}`)}
                    </span>
                    <span className="text-[10.5px] text-muted-foreground">
                      {t('internal.route.hopCount', { count: selectedPivot.hops.length })}
                    </span>
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[10px] font-medium text-foreground/60">
                    {t('internal.route.localSub')}
                  </dt>
                  <dd className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                    {selectedPivot.local_host}:{selectedPivot.local_port}
                    {selectedPivot.local_protocol ? ` · ${selectedPivot.local_protocol}` : ''}
                  </dd>
                  <dd className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/80">
                    {t('internal.route.updatedAt', {
                      time: formatDateTimeFull(
                        selectedPivot.last_verified_at || selectedPivot.updated_at
                      )
                    })}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-medium text-foreground/60">
                    {t('internal.route.reachable')}
                  </p>
                  {selectedPivot.reachable_subnets.length === 0 ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t('internal.route.noReachable')}
                    </p>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {selectedPivot.reachable_subnets.map((subnet) => (
                        <span
                          key={subnet}
                          className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10.5px] text-foreground/80"
                        >
                          {subnet}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {selectedPivot.notes.trim().length > 0 ? (
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-medium text-foreground/60">
                      {t('internal.route.notes')}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
                      {selectedPivot.notes}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </InternalPanel>
  )
}
