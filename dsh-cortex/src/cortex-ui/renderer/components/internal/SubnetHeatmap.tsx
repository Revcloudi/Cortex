import { useState } from 'react'
import { AlertTriangle, Network, RefreshCw, X } from 'lucide-react'
import type { SubnetHeatmapBucket, SubnetHeatmapHost } from '@shared/types'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { InternalPanel } from './InternalPanel'
import {
  compareNatural,
  HOST_STATE_ORDER,
  HOST_STATE_STYLES,
  INTERNAL_TD,
  INTERNAL_TH
} from './internalUi'

interface SubnetHeatmapProps {
  buckets: SubnetHeatmapBucket[]
  loading: boolean
  error: string | null
  onRetry: () => void
}

interface FlatHost {
  subnet: string
  host: SubnetHeatmapHost
}

/** Compact chip label: last IPv4 octet keeps the /24 buckets scannable. */
function hostChipLabel(ip: string): string {
  const parts = ip.split('.')
  return parts.length === 4 ? (parts[3] ?? ip) : ip
}

function flattenHosts(buckets: readonly SubnetHeatmapBucket[]): FlatHost[] {
  const rows: FlatHost[] = []
  for (const bucket of buckets) {
    for (const host of bucket.hosts) rows.push({ subnet: bucket.subnet, host })
  }
  return rows.sort((a, b) => compareNatural(a.host.ip, b.host.ip))
}

function HeatmapSkeleton() {
  const { t } = useI18n()
  return (
    <div className="space-y-2 px-4 py-3" aria-hidden="true">
      <div className="flex flex-wrap gap-2">
        {HOST_STATE_ORDER.map((state) => (
          <Skeleton key={state} className="h-4 w-[74px]" />
        ))}
      </div>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <span role="status" className="sr-only">
        {t('internal.heatmap.loading')}
      </span>
    </div>
  )
}

/**
 * Subnet heatmap (§8.1): hosts are bucketed /24 (IPv6 /64) by the backend and
 * each host is a state-colored chip. The legend explicitly says the data is from
 * agent records, not a live scan; clicking a bucket filters the host list.
 */
export function SubnetHeatmap({ buckets, loading, error, onRetry }: SubnetHeatmapProps) {
  const { t } = useI18n()
  const [selectedSubnet, setSelectedSubnet] = useState<string | null>(null)

  const allHosts = flattenHosts(buckets)
  const selectedBucket =
    selectedSubnet === null ? null : (buckets.find((bucket) => bucket.subnet === selectedSubnet) ?? null)
  const visibleHosts =
    selectedBucket === null ? allHosts : allHosts.filter((row) => row.subnet === selectedBucket.subnet)

  const toggleSubnet = (subnet: string): void => {
    setSelectedSubnet((previous) => (previous === subnet ? null : subnet))
  }

  const actions = (
    <div className="flex items-center gap-2">
      {selectedSubnet !== null ? (
        <Button
          variant="ghost"
          size="xs"
          data-testid="internal-heatmap-clear"
          onClick={() => setSelectedSubnet(null)}
          className="gap-1 text-[11.5px]"
        >
          <X strokeWidth={1.75} aria-hidden="true" className="h-3 w-3" />
          {t('internal.heatmap.clearFilter')}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="internal-heatmap-refresh"
        aria-label={t('common.refresh')}
        title={t('common.refresh')}
        onClick={onRetry}
      >
        <RefreshCw strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
    </div>
  )

  return (
    <InternalPanel
      testId="internal-heatmap"
      title={t('internal.heatmap.title')}
      actions={actions}
    >
      {error !== null && buckets.length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          title={t('internal.page.loadError.title')}
          description={error}
        >
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </EmptyState>
      ) : loading && buckets.length === 0 ? (
        <HeatmapSkeleton />
      ) : buckets.length === 0 ? (
        <EmptyState
          icon={Network}
          title={t('internal.heatmap.empty.title')}
          description={t('internal.heatmap.empty.description')}
        />
      ) : (
        <div className="space-y-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t('internal.heatmap.legend')}
            </span>
            {HOST_STATE_ORDER.map((state) => {
              const style = HOST_STATE_STYLES[state]
              return (
                <span
                  key={state}
                  data-testid="internal-heatmap-legend"
                  data-state={state}
                  className="inline-flex items-center gap-1.5 text-[10.5px] text-muted-foreground"
                >
                  <span aria-hidden="true" className={cn('h-2 w-2 rounded-[2px]', style.dot)} />
                  {t(`internal.heatmap.state.${state}`)}
                </span>
              )
            })}
          </div>

          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {buckets.map((bucket) => {
              const selected = bucket.subnet === selectedSubnet
              const subnetLabel =
                bucket.subnet === 'unknown' ? t('internal.heatmap.unknownSubnet') : bucket.subnet
              return (
                <div
                  key={bucket.subnet}
                  data-testid="internal-heatmap-bucket-card"
                  data-subnet={bucket.subnet}
                  className={cn(
                    'rounded-[8px] border bg-background p-2.5 transition-colors duration-150',
                    selected ? 'border-accent bg-accent-soft/40' : 'border-border'
                  )}
                >
                  <button
                    type="button"
                    data-testid="internal-heatmap-bucket"
                    aria-pressed={selected}
                    aria-label={t('internal.heatmap.bucketAria', { subnet: subnetLabel })}
                    onClick={() => toggleSubnet(bucket.subnet)}
                    className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="font-mono text-[12px] font-medium tabular-nums text-foreground">
                        {subnetLabel}
                      </span>
                      {selected ? (
                        <span className="rounded-full border border-accent/50 bg-background px-1.5 py-0.5 text-[9.5px] font-medium text-accent">
                          {t('internal.heatmap.bucketSelected')}
                        </span>
                      ) : null}
                    </span>
                    <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {t('internal.heatmap.bucketMeta', {
                        hosts: bucket.host_count,
                        services: bucket.service_count
                      })}
                    </span>
                  </button>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {bucket.hosts.map((host) => {
                      const style = HOST_STATE_STYLES[host.state]
                      const title =
                        host.hostname.trim().length > 0
                          ? t('internal.heatmap.hostTitle', {
                              ip: host.ip,
                              hostname: host.hostname,
                              count: host.service_count
                            })
                          : t('internal.heatmap.hostTitleNoName', {
                              ip: host.ip,
                              count: host.service_count
                            })
                      return (
                        <span
                          key={host.id}
                          data-testid="internal-heatmap-host"
                          data-state={host.state}
                          data-ip={host.ip}
                          title={title}
                          className={cn(
                            'inline-flex h-[20px] min-w-[38px] items-center justify-center rounded-[4px] border px-1 font-mono text-[10px] tabular-nums',
                            style.chip
                          )}
                        >
                          {hostChipLabel(host.ip)}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-baseline gap-2 text-[11px] font-medium text-foreground">
                {t('internal.heatmap.hostsTitle')}
                <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                  {selectedBucket === null
                    ? t('internal.heatmap.hostCount', { count: visibleHosts.length })
                    : t('internal.heatmap.hostsFiltered', { subnet: selectedBucket.subnet })}
                </span>
              </span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {selectedBucket === null
                  ? t('internal.heatmap.allHosts')
                  : `${visibleHosts.length}/${allHosts.length}`}
              </span>
            </div>

            <div
              data-testid="internal-heatmap-host-list"
              className="mt-2 max-h-[280px] overflow-auto rounded-[8px] border border-border"
            >
              <table className="w-full table-fixed text-left">
                <caption className="sr-only">{t('internal.heatmap.hostsTitle')}</caption>
                <thead>
                  <tr>
                    <th className={cn(INTERNAL_TH, 'w-[150px]')}>
                      {t('internal.heatmap.columns.ip')}
                    </th>
                    <th className={INTERNAL_TH}>{t('internal.heatmap.columns.hostname')}</th>
                    <th className={cn(INTERNAL_TH, 'w-[108px]')}>
                      {t('internal.heatmap.columns.state')}
                    </th>
                    <th className={cn(INTERNAL_TH, 'hidden w-[96px] md:table-cell')}>
                      {t('internal.heatmap.columns.confidence')}
                    </th>
                    <th className={cn(INTERNAL_TH, 'w-[112px]')}>
                      {t('internal.heatmap.columns.subnet')}
                    </th>
                    <th className={cn(INTERNAL_TH, 'w-[76px] text-right')}>
                      {t('internal.heatmap.columns.services')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHosts.map(({ subnet, host }) => {
                    const style = HOST_STATE_STYLES[host.state]
                    return (
                      <tr key={host.id} data-testid="internal-heatmap-host-row" data-ip={host.ip}>
                        <td className={cn(INTERNAL_TD, 'font-mono text-[11.5px] tabular-nums')}>
                          {host.ip}
                        </td>
                        <td className={cn(INTERNAL_TD, 'truncate text-[11.5px]')}>
                          {host.hostname || t('internal.heatmap.notRecorded')}
                        </td>
                        <td className={INTERNAL_TD}>
                          <span className="inline-flex items-center gap-1.5 text-[11px]">
                            <span
                              aria-hidden="true"
                              className={cn('h-1.5 w-1.5 rounded-full', style.dot)}
                            />
                            <span className={style.text}>
                              {t(`internal.heatmap.state.${host.state}`)}
                            </span>
                          </span>
                        </td>
                        <td className={cn(INTERNAL_TD, 'hidden md:table-cell')}>
                          <span className="text-[11px] text-muted-foreground">
                            {t(`internal.confidence.${host.confidence}`)}
                          </span>
                        </td>
                        <td
                          className={cn(
                            INTERNAL_TD,
                            'truncate font-mono text-[10.5px] text-muted-foreground'
                          )}
                        >
                          {subnet === 'unknown' ? t('internal.heatmap.unknownSubnet') : subnet}
                        </td>
                        <td
                          className={cn(
                            INTERNAL_TD,
                            'text-right font-mono text-[11px] tabular-nums text-muted-foreground'
                          )}
                        >
                          {host.service_count}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </InternalPanel>
  )
}
