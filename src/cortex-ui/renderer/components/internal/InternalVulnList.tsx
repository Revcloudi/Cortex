import { Fragment } from 'react'
import { AlertTriangle, ChevronRight, Inbox, RefreshCw } from 'lucide-react'
import type { VulnerabilityListItem, VulnPageSize } from '@shared/types'
import { SeverityBadge, StatusBadge } from '@renderer/components/common/Badges'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { PaginationBar } from '@renderer/components/vuln/PaginationBar'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { formatDateTime, formatVulnType } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { InternalPanel } from './InternalPanel'
import { groupVulnerabilitiesByHost, INTERNAL_TD, INTERNAL_TH } from './internalUi'

interface InternalVulnListProps {
  items: VulnerabilityListItem[] | null
  total: number
  page: number
  pageSize: VulnPageSize
  loading: boolean
  error: string | null
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: VulnPageSize) => void
  onOpenVuln: (vulnId: string) => void
  onRetry: () => void
}

function TableSkeleton() {
  const { t } = useI18n()
  return (
    <div aria-hidden="true" className="overflow-x-auto">
      <table className="w-full table-fixed">
        <thead>
          <tr>
            <th className={cn(INTERNAL_TH, 'w-[88px] text-center')}>{t('common.severity')}</th>
            <th className={cn(INTERNAL_TH, 'hidden w-[142px] lg:table-cell')}>ID</th>
            <th className={INTERNAL_TH}>{t('internal.vuln.columns.name')}</th>
            <th className={cn(INTERNAL_TH, 'w-[168px]')}>{t('internal.vuln.columns.service')}</th>
            <th className={cn(INTERNAL_TH, 'w-[188px]')}>
              {t('internal.vuln.columns.entryAsset')}
            </th>
            <th className={cn(INTERNAL_TH, 'w-[112px] text-center')}>{t('common.status')}</th>
            <th className={cn(INTERNAL_TH, 'hidden w-[100px] md:table-cell')}>
              {t('internal.vuln.columns.foundAt')}
            </th>
            <th className={cn(INTERNAL_TH, 'w-8 pr-4')} />
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2, 3].map((index) => (
            <tr key={index}>
              <td className={cn(INTERNAL_TD, 'text-center')}>
                <Skeleton className="mx-auto h-[22px] w-[52px] rounded-full" />
              </td>
              <td className={cn(INTERNAL_TD, 'hidden lg:table-cell')}>
                <Skeleton className="h-3 w-[112px]" />
              </td>
              <td className={INTERNAL_TD}>
                <Skeleton className="h-3.5 w-[56%]" />
                <Skeleton className="mt-2 h-2.5 w-[34%]" />
              </td>
              <td className={INTERNAL_TD}>
                <Skeleton className="h-3 w-[104px]" />
              </td>
              <td className={INTERNAL_TD}>
                <Skeleton className="h-3 w-[132px]" />
              </td>
              <td className={cn(INTERNAL_TD, 'text-center')}>
                <Skeleton className="mx-auto h-[22px] w-[62px] rounded-full" />
              </td>
              <td className={cn(INTERNAL_TD, 'hidden md:table-cell')}>
                <Skeleton className="h-3 w-[62px]" />
              </td>
              <td className={cn(INTERNAL_TD, 'pr-4')} />
            </tr>
          ))}
        </tbody>
      </table>
      <span role="status" className="sr-only">
        {t('internal.vuln.loading')}
      </span>
    </div>
  )
}

/**
 * Internal-realm vulnerability list, grouped by entry asset host. Legacy rows
 * that carry `service_host` without `internal_service_id` are flagged as
 * "待归一化" instead of being silently normalized.
 */
export function InternalVulnList({
  items,
  total,
  page,
  pageSize,
  loading,
  error,
  onPageChange,
  onPageSizeChange,
  onOpenVuln,
  onRetry
}: InternalVulnListProps) {
  const { t } = useI18n()

  const actions = (
    <Button
      variant="ghost"
      size="icon-sm"
      data-testid="internal-vuln-refresh"
      aria-label={t('common.refresh')}
      title={t('common.refresh')}
      onClick={onRetry}
    >
      <RefreshCw strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
    </Button>
  )

  const groups = items === null ? [] : groupVulnerabilitiesByHost(items)

  return (
    <InternalPanel
      testId="internal-vuln-list"
      title={t('internal.vuln.title')}
      count={items === null || total === 0 ? undefined : total}
      actions={actions}
    >
      {items === null && loading ? (
        <TableSkeleton />
      ) : items === null ? (
        <EmptyState
          icon={AlertTriangle}
          title={t('internal.vuln.loadError')}
          description={error ?? undefined}
        >
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={t('internal.vuln.empty.title')}
          description={t('internal.vuln.empty.description')}
        />
      ) : (
        <>
          {error !== null ? (
            <div className="flex items-center justify-between gap-3 border-b border-red-200/70 bg-red-50 px-4 py-1.5 text-[11.5px] text-red-700">
              <span className="flex min-w-0 items-center gap-2">
                <AlertTriangle strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{error}</span>
              </span>
              <button
                type="button"
                onClick={onRetry}
                className="shrink-0 underline underline-offset-2 hover:text-red-800"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full table-fixed border-separate border-spacing-0 text-left">
              <caption className="sr-only">{t('internal.vuln.title')}</caption>
              <thead>
                <tr>
                  <th scope="col" className={cn(INTERNAL_TH, 'w-[88px] text-center')}>
                    {t('common.severity')}
                  </th>
                  <th scope="col" className={cn(INTERNAL_TH, 'hidden w-[142px] lg:table-cell')}>
                    ID
                  </th>
                  <th scope="col" className={INTERNAL_TH}>
                    {t('internal.vuln.columns.name')}
                  </th>
                  <th scope="col" className={cn(INTERNAL_TH, 'w-[168px]')}>
                    {t('internal.vuln.columns.service')}
                  </th>
                  <th scope="col" className={cn(INTERNAL_TH, 'w-[188px]')}>
                    {t('internal.vuln.columns.entryAsset')}
                  </th>
                  <th scope="col" className={cn(INTERNAL_TH, 'w-[112px] text-center')}>
                    {t('common.status')}
                  </th>
                  <th scope="col" className={cn(INTERNAL_TH, 'hidden w-[100px] md:table-cell')}>
                    {t('internal.vuln.columns.foundAt')}
                  </th>
                  <th scope="col" className={cn(INTERNAL_TH, 'w-8 pr-4')}>
                    <span className="sr-only">{t('internal.vuln.open')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <Fragment key={group.host}>
                    <tr
                      data-testid="internal-vuln-group"
                      data-host={group.host}
                      className="bg-sidebar"
                    >
                      <td
                        colSpan={8}
                        className="border-b border-border px-3 py-1 font-mono text-[10.5px] tabular-nums text-muted-foreground"
                      >
                        <span className="text-foreground/70">
                          {t('internal.vuln.entryAssetGroup', { host: group.host })}
                        </span>
                        <span className="ml-2">
                          {t('internal.vuln.groupCount', { count: group.items.length })}
                        </span>
                      </td>
                    </tr>
                    {group.items.map((item) => {
                      const last = item === group.items[group.items.length - 1]
                      const pending =
                        item.service_host.trim().length > 0 &&
                        item.internal_service_id.trim().length === 0
                      return (
                        <tr
                          key={item.id}
                          data-testid="internal-vuln-row"
                          data-vuln-id={item.id}
                          data-service-host={item.service_host}
                          data-pending-normalization={pending ? 'true' : undefined}
                          tabIndex={0}
                          aria-label={t('vuln.table.openRowAria', { name: item.vuln_name })}
                          onClick={() => onOpenVuln(item.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              onOpenVuln(item.id)
                            }
                          }}
                          className={cn(
                            'group cursor-pointer transition-colors duration-150 hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none',
                            last && 'border-b-0'
                          )}
                        >
                          <td className={cn(INTERNAL_TD, 'text-center')}>
                            <SeverityBadge severity={item.severity} />
                          </td>
                          <td
                            className={cn(INTERNAL_TD, 'hidden lg:table-cell')}
                            title={item.id}
                          >
                            <span className="block truncate font-mono text-[11.5px] tabular-nums text-muted-foreground">
                              {item.id}
                            </span>
                          </td>
                          <td className={INTERNAL_TD}>
                            <p
                              className="truncate text-[13px] font-medium text-foreground"
                              title={item.vuln_name}
                            >
                              {item.vuln_name}
                            </p>
                            <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
                              {formatVulnType(item.vuln_type, t)}
                              {' · '}
                              {item.entry_point || '/'}
                            </p>
                          </td>
                          <td className={INTERNAL_TD}>
                            {item.service_host.trim().length > 0 ? (
                              <span className="flex min-w-0 flex-col gap-1">
                                <span
                                  className="block truncate font-mono text-[11.5px] text-amber-700"
                                  title={item.service_host}
                                >
                                  {item.service_host}
                                </span>
                                {pending ? (
                                  <span
                                    data-testid="internal-vuln-pending"
                                    title={t('internal.vuln.pendingNormalizationHint')}
                                    className="inline-flex w-fit items-center rounded-full border border-amber-300/80 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                                  >
                                    {t('internal.vuln.pendingNormalization')}
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">
                                {t('internal.common.notRecorded')}
                              </span>
                            )}
                          </td>
                          <td className={INTERNAL_TD}>
                            <span
                              className="block truncate font-mono text-[11.5px] text-foreground"
                              title={item.host}
                            >
                              {item.host}
                            </span>
                          </td>
                          <td className={cn(INTERNAL_TD, 'text-center')}>
                            <StatusBadge status={item.status} />
                          </td>
                          <td className={cn(INTERNAL_TD, 'hidden md:table-cell')}>
                            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                              {formatDateTime(item.created_at)}
                            </span>
                          </td>
                          <td className={cn(INTERNAL_TD, 'pr-4 text-right')}>
                            <ChevronRight
                              strokeWidth={1.75} aria-hidden="true"
                              className="ml-auto h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {total > 0 ? (
            <PaginationBar
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
            />
          ) : null}
        </>
      )}
    </InternalPanel>
  )
}
