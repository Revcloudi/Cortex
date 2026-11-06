import { AlertTriangle, Network, ShieldAlert, Unplug } from 'lucide-react'
import type {
  Foothold,
  FootholdStatus,
  InternalHost,
  InternalOverview,
  InternalService,
  PivotWithHops,
  VulnerabilityListItem
} from '@shared/types'
import { SeverityBadge } from '@renderer/components/common/Badges'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { formatDateTimeFull } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { assetIdentity } from './internalUi'

export interface AssetInternalScope {
  footholds: Foothold[]
  hosts: InternalHost[]
  services: InternalService[]
  pivots: PivotWithHops[]
  vulns: VulnerabilityListItem[]
}

/**
 * Filter the project-level internal overview down to this Web asset: a foothold
 * whose normalized `entry_host_port` matches the asset, the hosts/services it
 * reaches, the pivots bound to those footholds, and the internal findings whose
 * `host` is this entry asset.
 */
export function scopeForEntry(
  overview: InternalOverview | null,
  hostPort: string
): AssetInternalScope {
  if (overview === null) {
    return { footholds: [], hosts: [], services: [], pivots: [], vulns: [] }
  }
  const identity = assetIdentity(hostPort)
  const footholds = overview.footholds.filter(
    (foothold) => assetIdentity(foothold.entry_host_port) === identity
  )
  const footholdIds = new Set(footholds.map((foothold) => foothold.id))
  const hostIds = new Set(footholds.flatMap((foothold) => foothold.host_ids))
  const hosts = overview.hosts.filter((host) => hostIds.has(host.id))
  const services = overview.services.filter((service) => hostIds.has(service.host_id))
  const pivots = overview.pivots.filter((pivot) => footholdIds.has(pivot.foothold_id))
  const vulns = overview.internal_vulns.filter(
    (vuln) => vuln.realm === 'internal' && assetIdentity(vuln.host) === identity
  )
  return { footholds, hosts, services, pivots, vulns }
}

const FOOTHOLD_STATUS_DOTS: Record<FootholdStatus, string> = {
  planned: 'bg-slate-400',
  established: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  lost: 'bg-slate-300'
}

interface AssetInternalEntryProps {
  hostPort: string
  overview: InternalOverview | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpenVuln: (vulnId: string) => void
}

/**
 * "内网入口" section of the asset inspector: the footholds recorded for this
 * asset, what they reach, and the related internal-realm findings. Rendered
 * inside the asset sheet's tab panel.
 */
export function AssetInternalEntry({
  hostPort,
  overview,
  loading,
  error,
  onRetry,
  onOpenVuln
}: AssetInternalEntryProps) {
  const { t } = useI18n()

  if (loading && overview === null) {
    return (
      <div className="space-y-2 py-2" aria-hidden="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
        <span role="status" className="sr-only">
          {t('asset.internal.loading')}
        </span>
      </div>
    )
  }

  if (error !== null && overview === null) {
    return (
      <EmptyState icon={Unplug} title={t('asset.internal.loadError')} description={error}>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </EmptyState>
    )
  }

  const scope = scopeForEntry(overview, hostPort)

  if (scope.footholds.length === 0 && scope.vulns.length === 0) {
    return (
      <EmptyState
        icon={Network}
        title={t('asset.internal.notEntry.title')}
        description={t('asset.internal.notEntry.description')}
      />
    )
  }

  return (
    <div data-testid="asset-internal-entry" className="space-y-5">
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[10px] border border-border bg-border">
        {[
          { key: 'hosts', label: t('asset.internal.reachableHosts'), value: scope.hosts.length },
          {
            key: 'services',
            label: t('asset.internal.reachableServices'),
            value: scope.services.length
          },
          { key: 'pivots', label: t('asset.internal.pivots'), value: scope.pivots.length }
        ].map((cell) => (
          <div
            key={cell.key}
            data-testid={`asset-internal-count-${cell.key}`}
            className="flex min-w-0 flex-col bg-background px-3 py-2"
          >
            <span className="text-[10px] text-muted-foreground">{cell.label}</span>
            <span className="mt-0.5 font-mono text-[18px] font-medium leading-none tabular-nums text-foreground">
              {cell.value}
            </span>
          </div>
        ))}
      </div>

      {scope.footholds.length > 0 ? (
        <section>
          <h3 className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t('asset.internal.footholds')}
          </h3>
          <ul className="mt-2 space-y-2">
            {scope.footholds.map((foothold) => (
              <li
                key={foothold.id}
                data-testid="asset-internal-foothold"
                data-foothold-id={foothold.id}
                className="rounded-[10px] border border-border bg-background"
              >
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                  <Badge variant="outline" className="font-mono text-[10.5px]">
                    {t(`internal.foothold.access.${foothold.access_type}`)}
                  </Badge>
                  <span className="truncate font-mono text-[11px] text-foreground/80">
                    {foothold.id}
                  </span>
                  <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        FOOTHOLD_STATUS_DOTS[foothold.status]
                      )}
                    />
                    {t(`internal.foothold.status.${foothold.status}`)}
                  </span>
                </div>
                <dl className="grid gap-x-4 gap-y-2 px-3 py-2 sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-[10px] font-medium text-foreground/60">
                      {t('asset.internal.footholdPrivilege')}
                    </dt>
                    <dd className="text-[11.5px] text-foreground">
                      {t(`internal.privilege.${foothold.privilege_level}`)}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10px] font-medium text-foreground/60">
                      {t('asset.internal.footholdEstablishedAt')}
                    </dt>
                    <dd className="font-mono text-[10.5px] tabular-nums text-foreground/80">
                      {footholdTimestamp(foothold.established_at, t('internal.common.notRecorded'))}
                    </dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-[10px] font-medium text-foreground/60">
                      {t('asset.internal.footholdEvidence')}
                    </dt>
                    <dd className="mt-0.5 whitespace-pre-wrap break-words rounded-md border border-border bg-sidebar px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-foreground/80">
                      {foothold.evidence.trim().length > 0
                        ? foothold.evidence
                        : t('asset.internal.noEvidence')}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t('asset.internal.reachableHosts')}
        </h3>
        {scope.hosts.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">{t('asset.internal.noHosts')}</p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-[10px] border border-border bg-background">
            {scope.hosts.map((host) => (
              <li
                key={host.id}
                data-testid="asset-internal-host"
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5"
              >
                <span className="font-mono text-[11.5px] tabular-nums text-foreground">
                  {host.ip}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {host.hostname || t('internal.common.notRecorded')}
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {t(`internal.heatmap.state.${host.state}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t('asset.internal.reachableServices')}
        </h3>
        {scope.services.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {t('asset.internal.noServices')}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-[10px] border border-border bg-background">
            {scope.services.map((service) => (
              <li
                key={service.id}
                data-testid="asset-internal-service"
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5"
              >
                <span className="font-mono text-[11.5px] tabular-nums text-foreground">
                  {service.host_ip}:{service.port}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {service.service || service.protocol || t('internal.common.notRecorded')}
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {service.state}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t('asset.internal.pivots')}
        </h3>
        {scope.pivots.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">{t('asset.internal.noPivots')}</p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-[10px] border border-border bg-background">
            {scope.pivots.map((pivot) => (
              <li
                key={pivot.id}
                data-testid="asset-internal-pivot"
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5"
              >
                <span className="font-mono text-[11.5px] text-foreground">
                  {pivot.tool || pivot.kind}
                </span>
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {pivot.local_host}:{pivot.local_port}
                  {pivot.local_protocol ? ` · ${pivot.local_protocol}` : ''}
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {t(`internal.route.status.${pivot.status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          <ShieldAlert strokeWidth={1.75} aria-hidden="true" className="h-3 w-3" />
          {t('asset.internal.relatedVulns')}
        </h3>
        {scope.vulns.length === 0 ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {t('asset.internal.noRelatedVulns')}
          </p>
        ) : (
          <ul className="mt-2">
            {scope.vulns.map((vuln) => (
              <li key={vuln.id}>
                <button
                  type="button"
                  data-testid="asset-internal-vuln"
                  data-vuln-id={vuln.id}
                  onClick={() => onOpenVuln(vuln.id)}
                  className="group flex w-full items-start gap-3 border-b border-border px-1 py-2.5 text-left transition-colors last:border-b-0 hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none"
                >
                  <span className="mt-0.5 shrink-0">
                    <SeverityBadge severity={vuln.severity} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-foreground group-hover:text-accent">
                      {vuln.vuln_name}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
                      <span>{vuln.id}</span>
                      <span>{vuln.service_host || vuln.host}</span>
                    </span>
                  </span>
                  <span className="shrink-0 pt-0.5 text-[11px] text-foreground/60">
                    {t('asset.internal.openVuln')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error !== null ? (
        <div className="flex items-center gap-2 rounded-md border border-red-200/70 bg-red-50 px-3 py-1.5 text-[11px] text-red-700">
          <AlertTriangle strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      ) : null}
    </div>
  )
}

function footholdTimestamp(value: string, fallback: string): string {
  return value.trim().length > 0 ? formatDateTimeFull(value) : fallback
}
