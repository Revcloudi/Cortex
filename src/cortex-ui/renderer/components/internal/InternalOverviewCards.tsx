import type { ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { InternalOverview } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

interface InternalOverviewCardsProps {
  overview: InternalOverview | null
  loading: boolean
  error: string | null
  onRetry: () => void
}

interface InternalMetricCellProps {
  testId: string
  label: string
  value: string
  context: ReactNode
  accent?: boolean
}

/**
 * One hairline metric cell (the internal counterpart of `MetricStrip`): label,
 * large tabular number, small explanatory context.
 */
function InternalMetricCell({
  testId,
  label,
  value,
  context,
  accent = false
}: InternalMetricCellProps) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col bg-background px-4 py-3">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'mt-1.5 text-[24px] font-medium leading-none tracking-tight tabular-nums',
          accent ? 'text-accent' : 'text-foreground'
        )}
      >
        {value}
      </span>
      <div className="mt-auto pt-2 text-[10.5px] leading-relaxed text-muted-foreground">
        {context}
      </div>
    </div>
  )
}

const METRIC_KEYS = [
  'footholds',
  'hosts',
  'services',
  'credentials',
  'pivots',
  'vulns',
  'loot'
] as const

function OverviewSkeleton() {
  const { t } = useI18n()
  return (
    <div
      data-testid="internal-overview"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border sm:grid-cols-4 xl:grid-cols-7"
    >
      {METRIC_KEYS.map((key) => (
        <div key={key} className="flex flex-col bg-background px-4 py-3">
          <span className="text-[11px] text-muted-foreground">{t(`internal.overview.${key}`)}</span>
          <Skeleton className="mt-2 h-5 w-12" />
          <div className="mt-auto pt-2">
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
      {/* Keeps the hairline grid rectangular while not every breakpoint shows 7 columns. */}
      <div aria-hidden="true" className="bg-background xl:hidden" />
      <span role="status" className="sr-only">
        {t('internal.overview.loading')}
      </span>
    </div>
  )
}

/**
 * Seven internal counters (footholds / hosts / services / credentials / pivots /
 * internal vulns / loot imports) in one quiet hairline grid.
 */
export function InternalOverviewCards({
  overview,
  loading,
  error,
  onRetry
}: InternalOverviewCardsProps) {
  const { t } = useI18n()

  if (overview === null) {
    if (loading) return <OverviewSkeleton />
    return (
      <div
        data-testid="internal-overview"
        className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-background px-4 py-3"
      >
        <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-muted-foreground">
          <AlertTriangle strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{error ?? t('internal.overview.loading')}</span>
        </span>
        <Button variant="outline" size="xs" onClick={onRetry} className="shrink-0 gap-1.5">
          <RefreshCw strokeWidth={1.75} aria-hidden="true" className="h-3 w-3" />
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  const counts = overview.counts
  const establishedFootholds = overview.footholds.filter(
    (foothold) => foothold.status === 'established'
  ).length
  const compromisedHosts = overview.hosts.filter((host) => host.state === 'compromised').length
  const aliveHosts = overview.hosts.filter((host) => host.state === 'alive').length
  const openServices = overview.services.filter((service) => service.state === 'open').length
  const validCredentials = overview.credentials.filter(
    (credential) => credential.status === 'valid'
  ).length
  const untestedCredentials = overview.credentials.filter(
    (credential) => credential.status === 'untested'
  ).length
  const establishedPivots = overview.pivots.filter(
    (pivot) => pivot.status === 'established'
  ).length
  const criticalVulns = overview.internal_vulns.filter((vuln) => vuln.severity === 'Critical').length
  const highVulns = overview.internal_vulns.filter((vuln) => vuln.severity === 'High').length
  const parsedLoot = overview.loot_imports.filter((loot) => loot.status === 'parsed').length
  const reviewLoot = overview.loot_imports.filter((loot) => loot.status === 'needs_review').length

  return (
    <div
      data-testid="internal-overview"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border sm:grid-cols-4 xl:grid-cols-7"
    >
      <InternalMetricCell
        testId="internal-metric-footholds"
        label={t('internal.overview.footholds')}
        value={String(counts.footholds)}
        accent
        context={t('internal.overview.footholdsContext', { established: establishedFootholds })}
      />
      <InternalMetricCell
        testId="internal-metric-hosts"
        label={t('internal.overview.hosts')}
        value={String(counts.hosts)}
        context={t('internal.overview.hostsContext', {
          compromised: compromisedHosts,
          alive: aliveHosts
        })}
      />
      <InternalMetricCell
        testId="internal-metric-services"
        label={t('internal.overview.services')}
        value={String(counts.services)}
        context={t('internal.overview.servicesContext', { open: openServices })}
      />
      <InternalMetricCell
        testId="internal-metric-credentials"
        label={t('internal.overview.credentials')}
        value={String(counts.credentials)}
        context={t('internal.overview.credentialsContext', {
          valid: validCredentials,
          untested: untestedCredentials
        })}
      />
      <InternalMetricCell
        testId="internal-metric-pivots"
        label={t('internal.overview.pivots')}
        value={String(counts.pivots)}
        context={t('internal.overview.pivotsContext', { established: establishedPivots })}
      />
      <InternalMetricCell
        testId="internal-metric-vulns"
        label={t('internal.overview.vulns')}
        value={String(counts.internal_vulns)}
        context={t('internal.overview.vulnsContext', {
          critical: criticalVulns,
          high: highVulns
        })}
      />
      <InternalMetricCell
        testId="internal-metric-loot"
        label={t('internal.overview.loot')}
        value={String(counts.loot_imports)}
        context={t('internal.overview.lootContext', {
          parsed: parsedLoot,
          needsReview: reviewLoot
        })}
      />
      {/* Keeps the hairline grid rectangular while not every breakpoint shows 7 columns. */}
      <div aria-hidden="true" className="bg-background xl:hidden" />
    </div>
  )
}
