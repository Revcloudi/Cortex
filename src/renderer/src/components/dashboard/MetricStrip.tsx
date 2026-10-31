import { SEVERITIES, type DashboardStats } from '@shared/types'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { SEVERITY_STYLES } from '@renderer/lib/severity'
import { percentage } from '@renderer/lib/format'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import type { ReactNode } from 'react'

interface MetricStripProps {
  stats: DashboardStats | null
  loading: boolean
  error: string | null
}

interface MetricCellProps {
  testId: string
  label: string
  value: string
  context: ReactNode
  accent?: boolean
}

function MetricCell({ testId, label, value, context, accent = false }: MetricCellProps) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col bg-background px-5 py-4">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'mt-2 text-[30px] font-medium leading-none tracking-tight tabular-nums',
          accent ? 'text-accent' : 'text-foreground'
        )}
      >
        {value}
      </span>
      <div className="mt-auto pt-4 text-[11px] leading-relaxed text-muted-foreground">{context}</div>
    </div>
  )
}

function MetricBar({ stats }: { stats: DashboardStats }) {
  const total = stats.total
  return (
    <div className="flex h-1 w-full items-stretch gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
      {SEVERITIES.map((severity) => {
        const count = stats.bySeverity[severity]
        if (count <= 0) return null
        return (
          <span
            key={severity}
            className={cn('h-full rounded-full', SEVERITY_STYLES[severity].spine)}
            style={{ width: `${(count / total) * 100}%` }}
          />
        )
      })}
    </div>
  )
}

/**
 * Four metrics in one quiet strip (hairline gaps instead of floating cards).
 * Only the total vulnerability count carries the accent; the others keep the
 * default text color.
 */
export function MetricStrip({ stats, loading, error }: MetricStripProps) {
  const { t } = useI18n()

  if (!stats && loading) {
    return (
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border lg:grid-cols-4">
        {[
          'dashboard.metric.total',
          'dashboard.metric.critical',
          'dashboard.metric.hosts',
          'dashboard.metric.today'
        ].map((key) => (
          <div key={key} className="flex flex-col bg-background px-5 py-4">
            <span className="text-[11.5px] text-muted-foreground">{t(key)}</span>
            <Skeleton className="mt-2.5 h-7 w-14" />
            <div className="mt-auto pt-4">
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
        <span role="status" className="sr-only">
          {t('dashboard.metric.loading')}
        </span>
      </div>
    )
  }

  const total = stats?.total ?? 0
  const critical = stats?.critical ?? 0
  const high = stats?.high ?? 0
  const hosts = stats?.hosts ?? 0
  const today = stats?.today ?? 0
  const confirmed = stats?.byStatus.Confirmed ?? 0
  const inconclusive = stats?.byStatus.Inconclusive ?? 0
  const avgPerHost = hosts > 0 ? (total / hosts).toFixed(1) : '0'
  const unavailable = !stats
  const unavailableNote = (
    <span title={error ?? t('dashboard.metric.unavailable')}>
      {t('dashboard.metric.unavailable')}
    </span>
  )

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border lg:grid-cols-4">
      <MetricCell
        testId="metric-total"
        label={t('dashboard.metric.total')}
        value={unavailable ? '—' : String(total)}
        accent={!unavailable}
        context={
          unavailable ? (
            unavailableNote
          ) : (
            <span className="tabular-nums">
              {t('dashboard.metric.totalContext', { confirmed, inconclusive })}
            </span>
          )
        }
      />
      <MetricCell
        testId="metric-critical"
        label={t('dashboard.metric.critical')}
        value={unavailable ? '—' : String(critical)}
        context={
          unavailable ? (
            unavailableNote
          ) : (
            <div className="w-full">
              <MetricBar stats={stats} />
              <p className="mt-2 tabular-nums">
                {t('dashboard.metric.criticalContext', {
                  percent: percentage(critical, total),
                  high
                })}
              </p>
            </div>
          )
        }
      />
      <MetricCell
        testId="metric-hosts"
        label={t('dashboard.metric.hosts')}
        value={unavailable ? '—' : String(hosts)}
        context={
          unavailable ? (
            unavailableNote
          ) : (
            <span className="tabular-nums">
              {t('dashboard.metric.hostsContext', { average: avgPerHost })}
            </span>
          )
        }
      />
      <MetricCell
        testId="metric-today"
        label={t('dashboard.metric.today')}
        value={unavailable ? '—' : String(today)}
        context={unavailable ? unavailableNote : t('dashboard.metric.todayContext')}
      />
    </div>
  )
}
