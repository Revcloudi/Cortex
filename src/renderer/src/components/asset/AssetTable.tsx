import { type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, ChevronRight, Inbox, Search } from 'lucide-react'
import type { AssetListItem } from '@shared/types'
import { AssetStatusBadge } from '@renderer/components/common/Badges'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { techStackTags } from '@renderer/lib/assets'
import { formatDateTime } from '@renderer/lib/format'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

interface AssetTableProps {
  items: AssetListItem[] | null
  loading: boolean
  error: string | null
  filtersActive: boolean
  onOpen: (hostPort: string) => void
  onClearFilters: () => void
  onRetry: () => void
}

const thBase =
  'sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-left text-[11px] font-medium text-foreground/70'

/** Table cells share the hairline bottom border; the last row drops it. */
function cellClass(last: boolean, extra?: string): string {
  return cn('border-b border-border px-3 py-2.5 align-middle', last && 'border-b-0', extra)
}

/** Technology fingerprints render as one complete chip per technology. */
function TechStackTags({ techStack }: { techStack: string }) {
  const { t } = useI18n()
  const tags = techStackTags(techStack)
  if (tags.length === 0) {
    return <span className="text-[11px] text-muted-foreground">{t('asset.value.notRecorded')}</span>
  }

  const visibleTags = tags.slice(0, 4)
  const hiddenCount = tags.length - visibleTags.length

  return (
    <span className="flex flex-wrap items-center gap-1">
      {visibleTags.map((tag) => (
        <span
          key={tag}
          title={tag}
          className="inline-block max-w-full break-words rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[11px] leading-relaxed text-foreground/75"
        >
          {tag}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span className="font-mono text-[11px] tabular-nums text-foreground/60">+{hiddenCount}</span>
      ) : null}
    </span>
  )
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-[10px] border border-border bg-background">{children}</div>
}

function TableSkeleton() {
  const { t } = useI18n()
  return (
    <Panel>
      <div aria-hidden="true" className="overflow-x-auto">
        <table className="w-full table-fixed">
          <thead>
            <tr>
              <th className={cn(thBase, 'w-[240px]')}>{t('asset.table.url')}</th>
              <th className={cn(thBase, 'w-[160px]')}>{t('asset.table.project')}</th>
              <th className={thBase}>{t('asset.table.techStack')}</th>
              <th className={cn(thBase, 'w-[104px] text-center')}>{t('common.status')}</th>
              <th className={cn(thBase, 'w-[64px] text-center')}>{t('asset.table.interfaces')}</th>
              <th className={cn(thBase, 'w-[60px] text-center')}>{t('asset.table.leaks')}</th>
              <th className={cn(thBase, 'w-[76px] text-center')}>{t('asset.table.relatedVulns')}</th>
              <th className={cn(thBase, 'w-[116px]')}>{t('asset.table.lastUpdated')}</th>
              <th className={cn(thBase, 'w-8 pr-4')} />
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <tr key={index}>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="h-3.5 w-[182px]" />
                </td>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="h-3 w-[92px]" />
                </td>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="h-3 w-[68%]" />
                </td>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="mx-auto h-[22px] w-[56px] rounded-full" />
                </td>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="mx-auto h-3 w-5" />
                </td>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="mx-auto h-3 w-5" />
                </td>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="mx-auto h-3 w-5" />
                </td>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="h-3 w-[62px]" />
                </td>
                <td className="border-b border-border py-3 pr-4" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span role="status" className="sr-only">
        {t('asset.table.loading')}
      </span>
    </Panel>
  )
}

export function AssetTable({
  items,
  loading,
  error,
  filtersActive,
  onOpen,
  onClearFilters,
  onRetry
}: AssetTableProps) {
  const { t } = useI18n()

  if (loading && items === null) return <TableSkeleton />

  if (error !== null && items === null) {
    return (
      <Panel>
        <EmptyState icon={AlertTriangle} title={t('asset.table.loadError')} description={error}>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </EmptyState>
      </Panel>
    )
  }

  if (items !== null && items.length === 0) {
    return (
      <Panel>
        {filtersActive ? (
          <EmptyState
            icon={Search}
            title={t('asset.table.emptyFiltered.title')}
            description={t('asset.table.emptyFiltered.description')}
          >
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              {t('asset.table.resetFilters')}
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={Inbox}
            title={t('asset.table.empty.title')}
            description={t('asset.table.empty.description')}
          />
        )}
      </Panel>
    )
  }

  const rows = items ?? []
  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, hostPort: string) => {
    const target = event.target as HTMLElement
    if (target.tagName === 'BUTTON' || target.tagName === 'A') return
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      onOpen(hostPort)
    }
  }

  return (
    <Panel>
      {error !== null ? (
        <div className="flex items-center justify-between gap-3 border-b border-red-200/70 bg-red-50 px-4 py-2 text-[11.5px] text-red-700">
          <span className="flex min-w-0 items-center gap-2">
            <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
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
          <caption className="sr-only">{t('asset.table.caption')}</caption>
          <thead className="sticky top-0 z-10">
            <tr>
              <th scope="col" className={cn(thBase, 'w-[240px] pl-3')}>
                {t('asset.table.url')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[160px]')}>
                {t('asset.table.project')}
              </th>
              <th scope="col" className={thBase}>
                {t('asset.table.techStack')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[104px] text-center')}>
                {t('common.status')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[64px] text-center')}>
                {t('asset.table.interfaces')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[60px] text-center')}>
                {t('asset.table.leaks')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[76px] text-center')}>
                {t('asset.table.relatedVulns')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[116px]')}>
                {t('asset.table.lastUpdated')}
              </th>
              <th scope="col" className={cn(thBase, 'w-8 pr-4')}>
                <span className="sr-only">{t('asset.table.openDetail')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item, index) => {
              const last = index === rows.length - 1
              return (
                <tr
                  key={item.host_port}
                  data-testid="asset-row"
                  data-host-port={item.host_port}
                  tabIndex={0}
                  aria-label={t('asset.table.openRow', { host: item.host_port })}
                  onClick={() => onOpen(item.host_port)}
                  onKeyDown={(event) => handleRowKeyDown(event, item.host_port)}
                  className="group cursor-pointer transition-colors duration-150 hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none"
                >
                  <td className={cellClass(last, 'pl-3')}>
                    <span
                      className="block truncate font-mono text-[12.5px] font-medium text-foreground"
                      title={item.host_port}
                    >
                      {item.host_port}
                    </span>
                  </td>
                  <td className={cellClass(last)}>
                    <span
                      className="block truncate text-[12.5px] text-foreground"
                      title={item.project_name}
                    >
                      {item.project_name}
                    </span>
                  </td>
                  <td className={cellClass(last)}>
                    <TechStackTags techStack={item.tech_stack} />
                  </td>
                  <td className={cellClass(last, 'text-center')}>
                    <AssetStatusBadge status={item.status} />
                  </td>
                  <td className={cellClass(last, 'text-center')}>
                    <span className="font-mono text-[12.5px] tabular-nums text-foreground">
                      {item.interface_count}
                    </span>
                  </td>
                  <td className={cellClass(last, 'text-center')}>
                    <span
                      className={cn(
                        'font-mono text-[12.5px] tabular-nums',
                        item.leak_count > 0 ? 'text-red-700' : 'text-muted-foreground'
                      )}
                    >
                      {item.leak_count}
                    </span>
                  </td>
                  <td className={cellClass(last, 'text-center')}>
                    <span className="font-mono text-[12.5px] tabular-nums text-foreground">
                      {item.related_vuln_count}
                    </span>
                  </td>
                  <td className={cellClass(last)}>
                    <span className="font-mono text-[12.5px] tabular-nums text-foreground/80">
                      {formatDateTime(item.last_seen)}
                    </span>
                  </td>
                  <td className={cellClass(last, 'py-2.5 pr-4 text-right')}>
                    <ChevronRight
                      aria-hidden="true"
                      className="ml-auto h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
