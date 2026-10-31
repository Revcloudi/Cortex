import type { RefObject } from 'react'
import {
  SEVERITIES,
  VULN_STATUSES,
  type DashboardStats,
  type Severity,
  type VulnStatus
} from '@shared/types'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'
import { CheckSquare, RefreshCw, Search, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

interface FilterBarProps {
  search: string
  severity: Severity | 'all'
  status: VulnStatus | 'all'
  stats: DashboardStats | null
  /** Filtered row count across all pages; null while the list has not loaded. */
  total: number | null
  filtersActive: boolean
  selectMode: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  onSearchChange: (value: string) => void
  onSeverityChange: (value: Severity | 'all') => void
  onStatusChange: (value: VulnStatus | 'all') => void
  onToggleSelectMode: () => void
  onClear: () => void
  onRefresh: () => void
}

export function FilterBar({
  search,
  severity,
  status,
  stats,
  total,
  filtersActive,
  selectMode,
  searchInputRef,
  onSearchChange,
  onSeverityChange,
  onStatusChange,
  onToggleSelectMode,
  onClear,
  onRefresh
}: FilterBarProps) {
  const { t, severityLabel, statusLabel } = useI18n()

  const severityOptions: { value: Severity | 'all'; label: string; count: number | null }[] = [
    { value: 'all', label: t('common.all'), count: stats ? stats.total : null },
    ...SEVERITIES.map((value) => ({
      value,
      label: severityLabel(value),
      count: stats ? stats.bySeverity[value] : null
    }))
  ]

  const resultLabel =
    total === null
      ? '—'
      : filtersActive && stats
        ? t('vuln.filter.resultFiltered', { total, all: stats.total })
        : filtersActive
          ? t('vuln.filter.resultFilteredOnly', { total })
          : t('vuln.filter.resultTotal', { total })

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="relative w-full max-w-[300px] sm:w-[280px] xl:w-[320px]">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={searchInputRef}
          data-testid="vuln-search"
          aria-label={t('vuln.filter.searchAria')}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t('vuln.filter.searchPlaceholder')}
          className="h-8 pl-9 pr-9 text-[12px]"
        />
        {search ? (
          <button
            type="button"
            aria-label={t('vuln.filter.clearSearch')}
            onClick={() => onSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
            /
          </kbd>
        )}
      </div>

      <div
        data-testid="severity-filter"
        role="group"
        aria-label={t('vuln.filter.severityAria')}
        className="inline-flex h-8 items-center rounded-md border border-border bg-muted p-0.5"
      >
        {severityOptions.map((option) => {
          const active = severity === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSeverityChange(option.value)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-[5px] border px-1.5 text-[11.5px] transition-colors duration-150 focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                active
                  ? 'border-border bg-background font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {option.label}
              {option.count !== null ? (
                <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">
                  {option.count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <Select
        value={status}
        onValueChange={(value) => onStatusChange(value as VulnStatus | 'all')}
      >
        <SelectTrigger
          data-testid="status-filter"
          aria-label={t('vuln.filter.statusAria')}
          className="h-8 w-[128px] text-[12px]"
        >
          <SelectValue placeholder={t('vuln.filter.allStatuses')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('vuln.filter.allStatuses')}</SelectItem>
          {VULN_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {statusLabel(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-[11px] tabular-nums text-muted-foreground">{resultLabel}</span>
        <Button
          variant="ghost"
          size="xs"
          data-testid="vuln-multiselect"
          aria-pressed={selectMode}
          title={selectMode ? t('vuln.filter.exitSelectMode') : t('vuln.filter.enterSelectMode')}
          onClick={onToggleSelectMode}
          className={cn(
            'gap-1 text-[11.5px]',
            selectMode
              ? 'border border-accent bg-accent-soft font-medium text-accent hover:bg-accent-soft hover:text-accent'
              : undefined
          )}
        >
          <CheckSquare aria-hidden="true" className="h-3.5 w-3.5" />
          {t('vuln.filter.selectMode')}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRefresh}
          aria-label={t('vuln.filter.refresh')}
          title={t('vuln.filter.refresh')}
        >
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        {filtersActive ? (
          <Button variant="ghost" size="xs" onClick={onClear} className="gap-1 text-[11.5px]">
            <X aria-hidden="true" className="h-3 w-3" />
            {t('vuln.filter.reset')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
