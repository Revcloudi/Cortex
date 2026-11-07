import { useMemo, useState, type ReactElement } from 'react'
import { ArrowUpDown } from 'lucide-react'
import type { FuzzJob, FuzzResultSummary } from '@renderer/lib/fuzzerApi'
import type { FuzzSortKey, FuzzSortState, FuzzStatusFilter } from '@renderer/lib/fuzz'
import {
  filterFuzzResults,
  formatByteSize,
  isLengthChanged,
  isResultAnomaly,
  relativeDelta,
  sortFuzzResults,
  toggleFuzzSort
} from '@renderer/lib/fuzz'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useI18n } from '@renderer/i18n'
import { statusTone } from '@renderer/lib/retestResponse'
import { cn } from '@renderer/lib/utils'

interface FuzzResultsTableProps {
  job: FuzzJob
  results: FuzzResultSummary[]
  /** Total number of stored results for the job (may exceed the loaded page). */
  totalResults: number
  selected: number | 'baseline' | null
  onSelect: (index: number | 'baseline') => void
}

const STATUS_FILTERS: FuzzStatusFilter[] = ['all', '2xx', '3xx', '4xx', '5xx', 'error']

function statusFilterLabel(filter: FuzzStatusFilter, t: (key: string) => string): string {
  if (filter === 'all') return t('fuzzer.result.statusAll')
  if (filter === 'error') return t('fuzzer.result.statusError')
  return filter
}

function statusChipClass(status: number | null, error: string | null): string {
  if (status === null || error !== null) return 'border-red-300 bg-red-50 text-red-800'
  return statusTone(status)
}

/**
 * Client-side results table: sorting/filtering only touches the loaded page.
 * The baseline row stays pinned on top and is never hidden by filters. Result
 * rows use a fixed height and tabular numbers so waveform-like scanning works.
 */
export function FuzzResultsTable({
  job,
  results,
  totalResults,
  selected,
  onSelect
}: FuzzResultsTableProps) {
  const { t } = useI18n()
  const [statusFilter, setStatusFilter] = useState<FuzzStatusFilter>('all')
  const [onlyAnomaly, setOnlyAnomaly] = useState(false)
  const [onlyLengthChange, setOnlyLengthChange] = useState(false)
  const [sort, setSort] = useState<FuzzSortState>({ key: 'status', dir: 'asc' })

  const baseline = job.baseline
  const visible = useMemo(() => {
    const filtered = filterFuzzResults(results, {
      status: statusFilter,
      onlyAnomaly,
      onlyLengthChange,
      baseline
    })
    return sortFuzzResults(filtered, sort)
  }, [results, statusFilter, onlyAnomaly, onlyLengthChange, baseline, sort])

  const sortHeader = (key: FuzzSortKey, label: string): ReactElement => {
    const active = sort.key === key
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className="px-2 py-1.5 text-right font-medium"
      >
        <button
          type="button"
          data-testid={`fuzzer-sort-${key}`}
          onClick={() => setSort((current) => toggleFuzzSort(current, key))}
          aria-label={t('fuzzer.result.sortBy', { label })}
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            active ? 'font-medium text-foreground' : 'text-muted-foreground'
          )}
        >
          {label}
          <ArrowUpDown
            aria-hidden="true"
            className={cn('h-2.5 w-2.5', active ? 'text-accent' : 'text-muted-foreground/60')}
          />
        </button>
      </th>
    )
  }

  const rowBase =
    'h-8 cursor-pointer border-b border-border/80 align-middle transition-colors outline-none hover:bg-muted focus-visible:bg-muted'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-1.5">
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as FuzzStatusFilter)}
        >
          <SelectTrigger
            data-testid="fuzzer-filter-status"
            aria-label={t('fuzzer.result.filterStatus')}
            className="h-7 w-[128px] text-[11px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((filter) => (
              <SelectItem key={filter} value={filter}>
                {statusFilterLabel(filter, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <Checkbox
            data-testid="fuzzer-only-anomaly"
            checked={onlyAnomaly}
            onChange={(event) => setOnlyAnomaly(event.target.checked)}
          />
          {t('fuzzer.result.onlyAnomaly')}
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <Checkbox
            data-testid="fuzzer-only-length-change"
            checked={onlyLengthChange}
            onChange={(event) => setOnlyLengthChange(event.target.checked)}
          />
          {t('fuzzer.result.onlyLengthChange')}
        </label>

        <span className="ml-auto font-mono text-[9.5px] tabular-nums text-muted-foreground">
          {t('fuzzer.result.count', { shown: visible.length, total: totalResults })}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table aria-label={t('fuzzer.result.requestsAria')} className="w-full min-w-[540px] border-collapse">
          <thead className="sticky top-0 z-[1] bg-background text-[10px] text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
            <tr>
              <th scope="col" className="w-[44px] px-2 py-1.5 text-left font-medium">
                {t('fuzzer.result.colIndex')}
              </th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {t('fuzzer.result.colPayload')}
              </th>
              {sortHeader('status', t('fuzzer.result.colStatus'))}
              {sortHeader('length', t('fuzzer.result.colLength'))}
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                {t('fuzzer.result.colDelta')}
              </th>
              {sortHeader('duration', t('fuzzer.result.colDuration'))}
            </tr>
          </thead>
          <tbody>
            {baseline !== null ? (
              <tr
                data-baseline="true"
                data-testid="fuzzer-results-baseline"
                tabIndex={0}
                aria-selected={selected === 'baseline'}
                aria-label={t('fuzzer.result.baselineRowAria')}
                onClick={() => onSelect('baseline')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect('baseline')
                  }
                }}
                className={cn(
                  rowBase,
                  'bg-sidebar/60',
                  selected === 'baseline' && 'bg-accent-soft/70 hover:bg-accent-soft/70'
                )}
              >
                <td className="px-2 py-0 font-mono text-[10px] tabular-nums text-muted-foreground">—</td>
                <td className="max-w-[220px] truncate px-2 py-0">
                  <span className="inline-flex items-center gap-1">
                    <span className="rounded border border-border bg-background px-1 py-0.5 text-[9.5px] font-medium text-foreground">
                      {t('fuzzer.result.baseline')}
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground" title={t('fuzzer.result.baselineHint')}>
                      {t('fuzzer.result.baselineHint')}
                    </span>
                  </span>
                </td>
                <td className="px-2 py-0 text-right">
                  <span className={cn('inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums', statusChipClass(baseline.status, baseline.error))}>
                    {baseline.status ?? 'ERR'}
                  </span>
                </td>
                <td className="px-2 py-0 text-right font-mono text-[10.5px] tabular-nums text-foreground">
                  {formatByteSize(baseline.length)}
                </td>
                <td className="px-2 py-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">—</td>
                <td className="px-2 py-0 text-right font-mono text-[10.5px] tabular-nums text-foreground">
                  {baseline.durationMs === null ? '-' : `${baseline.durationMs} ms`}
                </td>
              </tr>
            ) : null}

            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                  {results.length === 0 ? t('fuzzer.result.empty') : t('fuzzer.result.emptyFiltered')}
                </td>
              </tr>
            ) : (
              visible.map((result) => {
                const delta = relativeDelta(result.length, baseline?.length ?? null)
                const anomaly = isResultAnomaly(result, baseline)
                const lengthChanged = isLengthChanged(result, baseline)
                return (
                  <tr
                    key={result.index}
                    data-testid="fuzzer-results-row"
                    data-index={result.index}
                    data-status={result.status ?? ''}
                    data-length={result.length ?? ''}
                    data-duration={result.durationMs ?? ''}
                    data-baseline="false"
                    tabIndex={0}
                    aria-selected={selected === result.index}
                    aria-label={t('fuzzer.result.rowAria', { index: result.index })}
                    onClick={() => onSelect(result.index)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onSelect(result.index)
                      }
                    }}
                    className={cn(
                      rowBase,
                      anomaly && 'bg-amber-50/50',
                      selected === result.index && 'bg-accent-soft/70 hover:bg-accent-soft/70'
                    )}
                  >
                    <td className="px-2 py-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {result.index}
                    </td>
                    <td
                      className="max-w-[220px] truncate px-2 py-0 font-mono text-[10.5px] text-foreground"
                      title={result.payloadBrief}
                    >
                      {result.payloadBrief === '' ? '-' : result.payloadBrief}
                    </td>
                    <td className="px-2 py-0 text-right">
                      <span className="inline-flex items-center gap-1">
                        <span
                          className={cn(
                            'inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums',
                            statusChipClass(result.status, result.error)
                          )}
                        >
                          {result.status ?? 'ERR'}
                        </span>
                        {result.error !== null ? (
                          <span
                            className="rounded border border-red-200 bg-red-50 px-1 py-0.5 text-[9px] text-red-700"
                            title={result.errorCode ?? result.error}
                          >
                            {t('fuzzer.result.errorBadge')}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-2 py-0 text-right font-mono text-[10.5px] tabular-nums text-foreground">
                      {formatByteSize(result.length)}
                    </td>
                    <td className="px-2 py-0 text-right font-mono text-[10px] tabular-nums">
                      {delta.text === '' || delta.direction === 'same' ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={lengthChanged ? 'text-amber-700' : 'text-muted-foreground'}>
                          {delta.text}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-0 text-right font-mono text-[10.5px] tabular-nums text-foreground">
                      {result.durationMs === null ? '-' : `${result.durationMs} ms`}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
