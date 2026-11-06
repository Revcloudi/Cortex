import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { VULN_PAGE_SIZE_OPTIONS, type VulnPageSize } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useI18n } from '@renderer/i18n'

interface PaginationBarProps {
  page: number
  pageSize: VulnPageSize
  /** Filtered row count across all pages (not the current page length). */
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: VulnPageSize) => void
}

/**
 * Lightweight pager attached to the bottom edge of the vulnerability panel.
 * Server-side paging: the parent owns `page` / `pageSize` and re-queries on
 * change; this component only clamps what it renders.
 */
export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange
}: PaginationBarProps) {
  const { t } = useI18n()

  if (total <= 0) return null

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const atFirst = currentPage <= 1
  const atLast = currentPage >= totalPages

  return (
    <nav
      data-testid="vuln-pagination"
      aria-label={t('vuln.pagination.aria')}
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-3 py-1.5"
    >
      <span className="text-[11px] tabular-nums text-muted-foreground">
        {t('vuln.pagination.summary', { page: currentPage, totalPages, total })}
      </span>

      <div className="flex items-center gap-2">
        <Select
          value={String(pageSize)}
          onValueChange={(value) => onPageSizeChange(Number(value) as VulnPageSize)}
        >
          <SelectTrigger
            data-testid="vuln-page-size"
            aria-label={t('vuln.pagination.perPageAria')}
            className="h-7 w-[100px] px-2 text-[11.5px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VULN_PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {t('vuln.pagination.perPage', { size })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="vuln-page-first"
            aria-label={t('vuln.pagination.first')}
            title={t('vuln.pagination.first')}
            disabled={atFirst}
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeft aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="vuln-page-prev"
            aria-label={t('vuln.pagination.prev')}
            title={t('vuln.pagination.prev')}
            disabled={atFirst}
            onClick={() => onPageChange(currentPage - 1)}
          >
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="vuln-page-next"
            aria-label={t('vuln.pagination.next')}
            title={t('vuln.pagination.next')}
            disabled={atLast}
            onClick={() => onPageChange(currentPage + 1)}
          >
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="vuln-page-last"
            aria-label={t('vuln.pagination.last')}
            title={t('vuln.pagination.last')}
            disabled={atLast}
            onClick={() => onPageChange(totalPages)}
          >
            <ChevronsRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </nav>
  )
}
