import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, Trash2 } from 'lucide-react'
import {
  DEFAULT_VULN_PAGE_SIZE,
  type DashboardStats,
  type Severity,
  type VulnerabilityListItem,
  type VulnPageSize,
  type VulnStatus
} from '@shared/types'
import { MetricStrip } from '@renderer/components/dashboard/MetricStrip'
import { FilterBar } from '@renderer/components/vuln/FilterBar'
import { PaginationBar } from '@renderer/components/vuln/PaginationBar'
import { VulnTable } from '@renderer/components/vuln/VulnTable'
import { VulnDetail } from '@renderer/components/vuln/VulnDetail'
import { BulkDeleteDialog } from '@renderer/components/vuln/BulkDeleteDialog'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import { invalidateVulnerabilityCache } from '@renderer/lib/vulnPreload'

interface DashboardPageProps {
  dataVersion: number
  onOpenMcp: () => void
}

export function DashboardPage({ dataVersion, onOpenMcp }: DashboardPageProps) {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim(), 180)
  const [severity, setSeverity] = useState<Severity | 'all'>('all')
  const [status, setStatus] = useState<VulnStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<VulnPageSize>(DEFAULT_VULN_PAGE_SIZE)

  const [items, setItems] = useState<VulnerabilityListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [reloadSeq, setReloadSeq] = useState(0)
  const [seeding, setSeeding] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [exporting, setExporting] = useState(false)

  const hasLoadedList = useRef(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const clearSelection = useCallback(() => {
    setSelectedIds((previous) => (previous.size === 0 ? previous : new Set()))
  }, [])

  const refresh = useCallback(() => {
    clearSelection()
    invalidateVulnerabilityCache()
    setReloadSeq((value) => value + 1)
  }, [clearSelection])

  useEffect(() => {
    const api = getApi()
    if (!api) {
      setListError(apiUnavailableMessage(t))
      setListLoading(false)
      return
    }

    if (!hasLoadedList.current) setListLoading(true)
    let alive = true

    api
      .listVulnerabilities({
        search: debouncedSearch ? debouncedSearch : undefined,
        severity,
        status,
        page,
        pageSize
      })
      .then(
        (result) => {
          if (!alive) return
          setItems(result.items)
          setTotal(result.total)
          if (result.page !== page) setPage(result.page)
          setListError(null)
        },
        (cause: unknown) => {
          if (alive) setListError(toErrorMessage(cause, t))
        }
      )
      .finally(() => {
        if (!alive) return
        hasLoadedList.current = true
        setListLoading(false)
      })

    return () => {
      alive = false
    }
  }, [debouncedSearch, severity, status, page, pageSize, dataVersion, reloadSeq])

  useEffect(() => {
    if (items === null) return
    const visible = new Set(items.map((item) => item.id))
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => visible.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [items])

  useEffect(() => {
    clearSelection()
  }, [dataVersion, clearSelection])

  useEffect(() => {
    const api = getApi()
    if (!api) {
      setStatsLoading(false)
      return
    }
    let alive = true
    api.getStats().then(
      (next) => {
        if (!alive) return
        setStats(next)
        setStatsError(null)
        setStatsLoading(false)
      },
      (cause: unknown) => {
        if (!alive) return
        setStatsError(toErrorMessage(cause, t))
        setStatsLoading(false)
      }
    )
    return () => {
      alive = false
    }
  }, [dataVersion, reloadSeq])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return
        }
      }
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const filtersActive = search.trim() !== '' || severity !== 'all' || status !== 'all'

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value)
      setPage(1)
      clearSelection()
    },
    [clearSelection]
  )

  const handleSeverityChange = useCallback(
    (value: Severity | 'all') => {
      setSeverity(value)
      setPage(1)
      clearSelection()
    },
    [clearSelection]
  )

  const handleStatusChange = useCallback(
    (value: VulnStatus | 'all') => {
      setStatus(value)
      setPage(1)
      clearSelection()
    },
    [clearSelection]
  )

  const handleClearFilters = useCallback(() => {
    setSearch('')
    setSeverity('all')
    setStatus('all')
    setPage(1)
    clearSelection()
  }, [clearSelection])

  const handlePageChange = useCallback(
    (next: number) => {
      setPage(next)
      clearSelection()
    },
    [clearSelection]
  )

  const handlePageSizeChange = useCallback(
    (next: VulnPageSize) => {
      setPageSize(next)
      setPage(1)
      clearSelection()
    },
    [clearSelection]
  )

  const handleToggleSelectMode = useCallback(() => {
    if (selectMode) clearSelection()
    setSelectMode(!selectMode)
  }, [selectMode, clearSelection])

  const handleCancelSelection = useCallback(() => {
    clearSelection()
    setSelectMode(false)
  }, [clearSelection])

  const handleSeedDemo = async () => {
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }
    setSeeding(true)
    try {
      const result = await api.seedDemoData()
      if (result.inserted > 0) {
        toast.success(t('dashboard.seed.loaded', { count: result.inserted }))
      } else {
        toast(t('dashboard.seed.exists'))
      }
      refresh()
    } catch (cause) {
      toast.error(t('dashboard.seed.failed', { error: toErrorMessage(cause, t) }))
    } finally {
      setSeeding(false)
    }
  }

  const handleToggleSelect = useCallback((id: string, selected: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const handleToggleSelectAll = useCallback(
    (selected: boolean) => {
      setSelectedIds(selected ? new Set((items ?? []).map((item) => item.id)) : new Set())
    },
    [items]
  )

  const handleExportSelected = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }
    setExporting(true)
    try {
      const result = await api.exportVulnerabilities(ids)
      if (!result.cancelled) {
        toast.success(
          result.files.length > 1
            ? t('vuln.toast.exportedMany', { count: result.files.length })
            : t('vuln.toast.exported')
        )
      }
    } catch (cause) {
      toast.error(t('vuln.toast.exportFailed', { error: toErrorMessage(cause, t) }))
    } finally {
      setExporting(false)
    }
  }

  const handleBulkDelete = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }
    setBulkDeleting(true)
    try {
      const result = await api.deleteVulnerabilities(ids)
      if (result.deleted > 0) {
        toast.success(t('vuln.toast.bulkDeleted', { count: result.deleted }))
      } else {
        toast.error(t('vuln.toast.deleteNone'))
      }
      setBulkConfirmOpen(false)
      clearSelection()
      refresh()
    } catch (cause) {
      toast.error(t('vuln.toast.bulkDeleteFailed', { error: toErrorMessage(cause, t) }))
    } finally {
      setBulkDeleting(false)
    }
  }

  const selectedCount = selectedIds.size
  const showBulkBar = selectMode && selectedCount > 0

  return (
    <>
      <section className="mx-auto flex h-full w-full max-w-[1440px] flex-col px-8 pt-4 pb-4">
        <div className="shrink-0">
          <MetricStrip stats={stats} loading={statsLoading} error={statsError} />
        </div>

        <div className="mt-4 shrink-0">
          <FilterBar
            search={search}
            severity={severity}
            status={status}
            stats={stats}
            total={items === null ? null : total}
            filtersActive={filtersActive}
            selectMode={selectMode}
            searchInputRef={searchInputRef}
            onSearchChange={handleSearchChange}
            onSeverityChange={handleSeverityChange}
            onStatusChange={handleStatusChange}
            onToggleSelectMode={handleToggleSelectMode}
            onClear={handleClearFilters}
            onRefresh={refresh}
          />
        </div>

        {showBulkBar ? (
          <div
            data-testid="vuln-bulk-bar"
            role="region"
            aria-label={t('dashboard.bulk.region')}
            className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-accent-soft px-3 py-2"
          >
            <span
              className="text-[12px] font-medium tabular-nums text-foreground"
              aria-live="polite"
            >
              {t('dashboard.bulk.selected', { count: selectedCount })}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleExportSelected()}
                disabled={exporting}
                className="gap-1.5"
              >
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
                {exporting ? t('dashboard.bulk.exporting') : t('dashboard.bulk.export')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkConfirmOpen(true)}
                disabled={bulkDeleting}
                className="gap-1.5"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                {t('dashboard.bulk.deleteSelected')}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancelSelection}>
                {t('dashboard.bulk.cancelSelection')}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-2 flex min-h-0 flex-1 flex-col">
          <VulnTable
            items={items}
            loading={listLoading}
            error={listError}
            filtersActive={filtersActive}
            seeding={seeding}
            selectMode={selectMode}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            onOpen={setSelectedId}
            onClearFilters={handleClearFilters}
            onSeedDemo={() => void handleSeedDemo()}
            onOpenMcp={onOpenMcp}
            onRetry={refresh}
            footer={
              items !== null && total > 0 ? (
                <PaginationBar
                  page={page}
                  pageSize={pageSize}
                  total={total}
                  onPageChange={handlePageChange}
                  onPageSizeChange={handlePageSizeChange}
                />
              ) : null
            }
          />
        </div>
      </section>

      <VulnDetail
        vulnId={selectedId}
        dataVersion={dataVersion}
        onClose={() => setSelectedId(null)}
        onChanged={refresh}
        onOpenRelated={setSelectedId}
      />

      <BulkDeleteDialog
        open={bulkConfirmOpen}
        count={selectedCount}
        pending={bulkDeleting}
        onOpenChange={setBulkConfirmOpen}
        onConfirm={() => void handleBulkDelete()}
      />
    </>
  )
}
