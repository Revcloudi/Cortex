import type { KeyboardEvent, ReactNode } from 'react'
import { AlertTriangle, Brain, ChevronRight, Search } from 'lucide-react'
import type { SnapshotSummary } from '@shared/types'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { formatDateTime } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'

interface SnapshotTableProps {
  items: SnapshotSummary[] | null
  loading: boolean
  error: string | null
  filtersActive: boolean
  onOpen: (sessionId: string) => void
  onClearFilters: () => void
  onRetry: () => void
}

const thBase =
  'sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-left text-[11px] font-medium text-foreground/70'

/** Table cells share the hairline bottom border; the last row drops it. */
function cellClass(last: boolean, extra?: string): string {
  return cn('border-b border-border px-3 py-2.5 align-middle', last && 'border-b-0', extra)
}

/** Host chips: two visible targets, the rest folded into a `+N` counter. */
function HostChips({ hosts }: { hosts: string[] }) {
  const { t } = useI18n()
  if (hosts.length === 0) {
    return (
      <span className="text-[11px] text-muted-foreground">{t('snapshot.value.notRecorded')}</span>
    )
  }

  const visibleHosts = hosts.slice(0, 2)
  const hiddenCount = hosts.length - visibleHosts.length

  return (
    <span className="flex flex-wrap items-center gap-1">
      {visibleHosts.map((host) => (
        <span
          key={host}
          title={host}
          className="inline-block max-w-full break-words rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[11.5px] leading-relaxed text-foreground/75"
        >
          {host}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span
          title={hosts.slice(2).join(', ')}
          className="font-mono text-[11.5px] tabular-nums text-foreground/60"
        >
          +{hiddenCount}
        </span>
      ) : null}
    </span>
  )
}

/** Count cell: coloured only when non-zero, so the eye lands on real work. */
function CountCell({ value, tone }: { value: number; tone: 'amber' | 'red' | 'neutral' }) {
  const activeStyle =
    tone === 'amber' ? 'text-amber-700' : tone === 'red' ? 'text-red-700' : 'text-foreground'
  return (
    <span
      className={cn(
        'font-mono text-[12.5px] tabular-nums',
        value > 0 ? activeStyle : 'text-muted-foreground'
      )}
    >
      {value}
    </span>
  )
}

/** Muted marker for archived sessions. */
function ArchivedBadge() {
  const { t } = useI18n()
  return (
    <span
      data-testid="snapshot-archived-badge"
      className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-border bg-muted px-1.5 text-[10.5px] font-medium text-muted-foreground"
    >
      {t('snapshot.badge.archived')}
    </span>
  )
}

/** Marker for child (system) sessions surfaced by a keyword search. */
function ChildBadge() {
  const { t } = useI18n()
  return (
    <span
      data-testid="snapshot-child-badge"
      className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-border bg-background px-1.5 text-[10.5px] text-foreground/60"
    >
      {t('snapshot.badge.child')}
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
              <th className={cn(thBase, 'w-[240px]')}>{t('snapshot.table.project')}</th>
              <th className={cn(thBase, 'w-[156px]')}>{t('snapshot.table.phase')}</th>
              <th className={thBase}>{t('snapshot.table.targetHosts')}</th>
              <th className={cn(thBase, 'w-[64px] text-center')}>
                {t('snapshot.table.unfinished')}
              </th>
              <th className={cn(thBase, 'w-[64px] text-center')}>
                {t('snapshot.table.failed')}
              </th>
              <th className={cn(thBase, 'w-[84px] text-center')}>
                {t('snapshot.table.tested')}
              </th>
              <th className={cn(thBase, 'w-[64px] text-center')}>
                {t('snapshot.table.children')}
              </th>
              <th className={cn(thBase, 'w-[116px]')}>{t('snapshot.table.updatedAt')}</th>
              <th className={cn(thBase, 'w-8 pr-4')} />
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <tr key={index}>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="h-3.5 w-[152px]" />
                  <Skeleton className="mt-1.5 h-2.5 w-[104px]" />
                </td>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="h-3 w-[92px]" />
                </td>
                <td className="border-b border-border px-3 py-3.5">
                  <Skeleton className="h-[22px] w-[132px] rounded" />
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
        {t('snapshot.table.loading')}
      </span>
    </Panel>
  )
}

export function SnapshotTable({
  items,
  loading,
  error,
  filtersActive,
  onOpen,
  onClearFilters,
  onRetry
}: SnapshotTableProps) {
  const { t } = useI18n()
  if (loading && items === null) return <TableSkeleton />

  if (error !== null && items === null) {
    return (
      <Panel>
        <EmptyState
          icon={AlertTriangle}
          title={t('snapshot.table.loadErrorTitle')}
          description={error}
        >
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
            title={t('snapshot.table.emptyFilteredTitle')}
            description={t('snapshot.table.emptyFilteredDescription')}
          >
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              {t('snapshot.table.resetSearch')}
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={Brain}
            title={t('snapshot.table.emptyTitle')}
            description={t('snapshot.table.emptyDescription')}
          />
        )}
      </Panel>
    )
  }

  const rows = items ?? []
  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, sessionId: string) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      onOpen(sessionId)
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
          <caption className="sr-only">{t('snapshot.table.caption')}</caption>
          <thead className="sticky top-0 z-10">
            <tr>
              <th scope="col" className={cn(thBase, 'w-[240px] pl-3')}>
                {t('snapshot.table.project')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[156px]')}>
                {t('snapshot.table.phase')}
              </th>
              <th scope="col" className={thBase}>
                {t('snapshot.table.targetHosts')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[64px] text-center')}>
                {t('snapshot.table.unfinished')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[64px] text-center')}>
                {t('snapshot.table.failed')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[84px] text-center')}>
                {t('snapshot.table.tested')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[64px] text-center')}>
                {t('snapshot.table.children')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[116px]')}>
                {t('snapshot.table.updatedAt')}
              </th>
              <th scope="col" className={cn(thBase, 'w-8 pr-4')}>
                <span className="sr-only">{t('snapshot.table.openDetail')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item, index) => {
              const last = index === rows.length - 1
              return (
                <tr
                  key={item.session_id}
                  data-testid="snapshot-row"
                  data-session-id={item.session_id}
                  tabIndex={0}
                  aria-label={t('snapshot.table.openAria', {
                    project: item.project_name,
                    id: item.session_id
                  })}
                  onClick={() => onOpen(item.session_id)}
                  onKeyDown={(event) => handleRowKeyDown(event, item.session_id)}
                  className="group cursor-pointer transition-colors duration-150 hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none"
                >
                  <td className={cellClass(last, 'pl-3')}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="truncate text-[12.5px] font-medium text-foreground"
                        title={item.project_name}
                      >
                        {item.project_name}
                      </span>
                      {item.archived_at !== null ? <ArchivedBadge /> : null}
                      {item.parent_session_id !== null ? <ChildBadge /> : null}
                    </span>
                    <span
                      className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground"
                      title={item.session_id}
                    >
                      {item.session_id}
                    </span>
                  </td>
                  <td className={cellClass(last)}>
                    <span
                      className="block truncate text-[12.5px] text-foreground/80"
                      title={item.current_phase}
                    >
                      {item.current_phase.trim().length > 0
                        ? item.current_phase
                        : t('snapshot.value.notRecorded')}
                    </span>
                  </td>
                  <td className={cellClass(last)}>
                    <HostChips hosts={item.target_hosts} />
                  </td>
                  <td className={cn(cellClass(last), 'text-center')}>
                    <CountCell value={item.unfinished_count} tone="amber" />
                  </td>
                  <td className={cn(cellClass(last), 'text-center')}>
                    <CountCell value={item.failed_count} tone="red" />
                  </td>
                  <td className={cn(cellClass(last), 'text-center')}>
                    <CountCell value={item.tested_interface_count} tone="neutral" />
                  </td>
                  <td className={cn(cellClass(last), 'text-center')}>
                    {item.child_count > 0 ? (
                      <span className="font-mono text-[12.5px] tabular-nums text-foreground">
                        {item.child_count}
                      </span>
                    ) : (
                      <span className="text-[12.5px] text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className={cellClass(last)}>
                    <span className="font-mono text-[12.5px] tabular-nums text-foreground/80">
                      {formatDateTime(item.updated_at)}
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
