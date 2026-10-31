import { type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, ChevronRight, Database, Inbox, Loader2, Search } from 'lucide-react'
import type { VulnerabilityListItem } from '@shared/types'
import { SeverityBadge, StatusBadge } from '@renderer/components/common/Badges'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { SEVERITY_STYLES } from '@renderer/lib/severity'
import { formatDateTime, formatVulnType } from '@renderer/lib/format'
import { useI18n } from '@renderer/i18n'
import { prefetchVulnerability } from '@renderer/lib/vulnPreload'
import { cn } from '@renderer/lib/utils'

interface VulnTableProps {
  items: VulnerabilityListItem[] | null
  loading: boolean
  error: string | null
  filtersActive: boolean
  seeding: boolean
  /** Multi-select is opt-in: no checkbox column is rendered while it is off. */
  selectMode: boolean
  selectedIds: ReadonlySet<string>
  onToggleSelect: (id: string, selected: boolean) => void
  onToggleSelectAll: (selected: boolean) => void
  onOpen: (id: string) => void
  onClearFilters: () => void
  onSeedDemo: () => void
  onOpenMcp: () => void
  onRetry: () => void
  /** Optional panel footer (pagination) rendered inside the table border. */
  footer?: ReactNode
}

const thBase =
  'sticky top-0 z-10 border-b border-border bg-background px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground'

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded-[10px] border border-border bg-background">
      {children}
    </div>
  )
}

function TableSkeleton({ selectMode }: { selectMode: boolean }) {
  const { t } = useI18n()
  const nameWidths = ['62%', '48%', '71%', '55%', '66%', '44%', '58%', '50%']
  return (
    <div className="flex h-full min-h-0 flex-col" aria-hidden="true">
      <div className="min-h-0 flex-1 overflow-x-auto">
        <table className="h-full w-full table-fixed">
          <thead className="sticky top-0 z-10">
            <tr>
              {selectMode ? <th className={cn(thBase, 'w-9')} /> : null}
              <th className={cn(thBase, 'w-[88px] text-center')}>{t('common.severity')}</th>
              <th className={cn(thBase, 'hidden w-[142px] lg:table-cell')}>ID</th>
              <th className={thBase}>{t('vuln.table.name')}</th>
              <th className={cn(thBase, 'w-[156px]')}>Host</th>
              <th className={cn(thBase, 'w-[100px] text-center')}>{t('common.status')}</th>
              <th className={cn(thBase, 'hidden w-[100px] md:table-cell')}>
                {t('vuln.table.discoveredAt')}
              </th>
              <th className={cn(thBase, 'w-8 pr-4')} />
            </tr>
          </thead>
          <tbody>
            {nameWidths.map((width, index) => (
              <tr key={index}>
                {selectMode ? (
                  <td className="border-b border-border px-3 py-2">
                    <Skeleton className="h-3.5 w-3.5" />
                  </td>
                ) : null}
                <td className="border-b border-border px-3 py-2 text-center">
                  <Skeleton className="mx-auto h-[22px] w-[52px] rounded-full" />
                </td>
                <td className="hidden border-b border-border px-3 py-2 lg:table-cell">
                  <Skeleton className="h-3 w-[110px]" />
                </td>
                <td className="border-b border-border px-3 py-2">
                  <Skeleton className="h-3.5" style={{ width }} />
                  <Skeleton className="mt-2 h-2.5 w-[38%]" />
                </td>
                <td className="border-b border-border px-3 py-2">
                  <Skeleton className="h-3 w-[105px]" />
                </td>
                <td className="border-b border-border px-3 py-2 text-center">
                  <Skeleton className="mx-auto h-[22px] w-[62px] rounded-full" />
                </td>
                <td className="hidden border-b border-border px-3 py-2 md:table-cell">
                  <Skeleton className="h-3 w-[62px]" />
                </td>
                <td className="border-b border-border py-2 pr-4" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span role="status" className="sr-only">
        {t('vuln.table.loading')}
      </span>
    </div>
  )
}

export function VulnTable({
  items,
  loading,
  error,
  filtersActive,
  seeding,
  selectMode,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onOpen,
  onClearFilters,
  onSeedDemo,
  onOpenMcp,
  onRetry,
  footer
}: VulnTableProps) {
  const { t } = useI18n()

  if (loading && items === null) {
    return (
      <Panel>
        <TableSkeleton selectMode={selectMode} />
      </Panel>
    )
  }

  if (error !== null && items === null) {
    return (
      <Panel>
        <EmptyState
          icon={AlertTriangle}
          title={t('vuln.table.loadFailedTitle')}
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
            title={t('vuln.table.emptyFilteredTitle')}
            description={t('vuln.table.emptyFilteredDescription')}
          >
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              {t('vuln.filter.reset')}
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={Inbox}
            title={t('vuln.table.emptyTitle')}
            description={t('vuln.table.emptyDescription')}
          >
            <Button
              variant="primary"
              size="sm"
              data-testid="seed-demo"
              onClick={onSeedDemo}
              disabled={seeding}
            >
              {seeding ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Database aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {seeding ? t('vuln.table.seeding') : t('vuln.table.seed')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onOpenMcp}>
              {t('vuln.table.viewMcp')}
            </Button>
          </EmptyState>
        )}
      </Panel>
    )
  }

  const rows = items ?? []
  const allSelected = rows.length > 0 && rows.every((item) => selectedIds.has(item.id))
  const someSelected = rows.some((item) => selectedIds.has(item.id))

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'BUTTON') return
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      onOpen(id)
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

      <div className="min-h-0 flex-1 overflow-x-auto">
        <table className="h-full w-full table-fixed border-separate border-spacing-0 text-left">
          <caption className="sr-only">{t('vuln.table.caption')}</caption>
          <thead className="sticky top-0 z-10">
            <tr>
              {selectMode ? (
                <th scope="col" className={cn(thBase, 'w-9 pl-3 pr-1')}>
                  <Checkbox
                    data-testid="vuln-select-all"
                    aria-label={t('vuln.table.selectAllAria')}
                    checked={allSelected}
                    indeterminate={someSelected && !allSelected}
                    onChange={(event) => onToggleSelectAll(event.target.checked)}
                  />
                </th>
              ) : null}
              <th scope="col" className={cn(thBase, 'w-[88px] text-center')}>
                {t('common.severity')}
              </th>
              <th scope="col" className={cn(thBase, 'hidden w-[142px] lg:table-cell')}>
                ID
              </th>
              <th scope="col" className={thBase}>
                {t('vuln.table.name')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[156px]')}>
                Host
              </th>
              <th scope="col" className={cn(thBase, 'w-[100px] text-center')}>
                {t('common.status')}
              </th>
              <th scope="col" className={cn(thBase, 'hidden w-[100px] md:table-cell')}>
                {t('vuln.table.discoveredAt')}
              </th>
              <th scope="col" className={cn(thBase, 'w-8 pr-4')}>
                <span className="sr-only">{t('vuln.table.openDetail')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item, index) => {
              const last = index === rows.length - 1
              const severityStyle = SEVERITY_STYLES[item.severity]
              const selected = selectedIds.has(item.id)
              return (
                <tr
                  key={item.id}
                  data-testid="vuln-row"
                  data-vuln-id={item.id}
                  data-severity={item.severity}
                  data-selected={selected ? 'true' : undefined}
                  tabIndex={0}
                  aria-label={t('vuln.table.openRowAria', { name: item.vuln_name })}
                  onClick={() => onOpen(item.id)}
                  onMouseEnter={() => prefetchVulnerability(item.id)}
                  onFocus={() => prefetchVulnerability(item.id)}
                  onKeyDown={(event) => handleRowKeyDown(event, item.id)}
                  className={cn(
                    'group cursor-pointer transition-colors duration-150 hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none',
                    selected && 'bg-accent-soft/60'
                  )}
                >
                  {selectMode ? (
                    <td
                      className={cn(
                        'border-b border-border py-2 pl-3 pr-1 align-middle',
                        last && 'border-b-0'
                      )}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Checkbox
                        data-testid="vuln-select"
                        aria-label={t('vuln.table.selectRowAria', { name: item.vuln_name })}
                        checked={selected}
                        onChange={(event) => onToggleSelect(item.id, event.target.checked)}
                      />
                    </td>
                  ) : null}
                  <td
                    className={cn(
                      'relative border-b border-border px-3 py-2 text-center align-middle',
                      last && 'border-b-0'
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute inset-y-0 left-0 w-[2px] opacity-70 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
                        severityStyle.spine
                      )}
                    />
                    <SeverityBadge severity={item.severity} />
                  </td>
                  <td
                    className={cn(
                      'hidden border-b border-border px-3 py-2 align-middle lg:table-cell',
                      last && 'border-b-0'
                    )}
                  >
                    <span
                      className="block truncate font-mono text-[11.5px] tabular-nums text-muted-foreground"
                      title={item.id}
                    >
                      {item.id}
                    </span>
                  </td>
                  <td
                    className={cn(
                      'min-w-0 border-b border-border px-3 py-2 align-middle',
                      last && 'border-b-0'
                    )}
                  >
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
                  <td
                    className={cn(
                      'border-b border-border px-3 py-2 align-middle',
                      last && 'border-b-0'
                    )}
                  >
                    <span
                      className="block truncate font-mono text-[11.5px] text-foreground"
                      title={item.host}
                    >
                      {item.host}
                    </span>
                  </td>
                  <td
                    className={cn(
                      'border-b border-border px-3 py-2 text-center align-middle',
                      last && 'border-b-0'
                    )}
                  >
                    <StatusBadge status={item.status} />
                  </td>
                  <td
                    className={cn(
                      'hidden border-b border-border px-3 py-2 align-middle md:table-cell',
                      last && 'border-b-0'
                    )}
                  >
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {formatDateTime(item.created_at)}
                    </span>
                  </td>
                  <td
                    className={cn(
                      'border-b border-border py-2 pr-4 text-right align-middle',
                      last && 'border-b-0'
                    )}
                  >
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
      {footer}
    </Panel>
  )
}
