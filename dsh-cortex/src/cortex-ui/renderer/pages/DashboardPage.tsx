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
import { ExportReportDialog } from '@renderer/components/vuln/ExportReportDialog'
import { InternalPage } from '@renderer/pages/InternalPage'
import { Button } from '@renderer/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { useI18n } from '@renderer/i18n'
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import { invalidateVulnerabilityCache } from '@renderer/lib/vulnPreload'

type DashboardTab = 'web' | 'internal'

interface DashboardPageProps {
  dataVersion: number
  /** Switch to the dedicated internal operations page (sidebar page). */
  onOpenInternal?: () => void
  /** Deep link from the nebula inspector: open this vulnerability immediately. */
  initialVulnId?: string | null
}

export function DashboardPage({
  dataVersion,
  onOpenInternal,
  initialVulnId = null
}: DashboardPageProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<DashboardTab>('web')
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
  const [exportOpen, setExportOpen] = useState(false)

  const hasLoadedList = useRef(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // Cross-page deep link (nebula → "view full details"): the vuln drawer only
  // exists on the Web tab, so switch there and open the record once.
  useEffect(() => {
    if (initialVulnId !== null) {
      setTab('web')
      setSelectedId(initialVulnId)
    }
  }, [initialVulnId])

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
        realm: 'web',
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
    api.getStats({ realm: 'web' }).then(
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

  // Header badge on the internal tab: `stats.internal` is computed across both
  // realms, so it stays accurate next to the Web-realm metrics.
  const internalCount = stats === null ? null : stats.internal.total

  // `/` focuses the Web-tab search input. The shortcut is gated to the Web tab
  // (the internal tab mounts no FilterBar) and to plain keystrokes.
  useEffect(() => {
    if (tab !== 'web') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
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
  }, [tab])

  const filtersActive = search.trim() !== '' || severity !== 'all' || status !== 'all'

  const handleTabChange = useCallback((next: string) => {
    const value: DashboardTab = next === 'internal' ? 'internal' : 'web'
    setTab(value)
    if (value === 'internal') {
      setSelectedId(null)
      setBulkConfirmOpen(false)
    }
  }, [])

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

  const handleExportSelected = async (outputDir?: string, format?: 'md' | 'docx' | 'pdf') => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      setExportOpen(false)
      return
    }
    setExporting(true)
    try {
      const result = await api.exportVulnerabilities(ids, { outputDir, format })
      const savedPath = result.savedPaths?.[0]
      if (!result.cancelled) {
        const message =
          result.files.length > 1
            ? t('vuln.toast.exportedMany', { count: result.files.length })
            : t('vuln.toast.exported')
        toast.success(
          message,
          savedPath ? { description: t('vuln.toast.exportedPath', { path: savedPath }) } : undefined
        )
      }
    } catch (cause) {
      toast.error(t('vuln.toast.exportFailed', { error: toErrorMessage(cause, t) }))
    } finally {
      setExporting(false)
      setExportOpen(false)
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
      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        className="mx-auto flex h-full min-h-0 w-full max-w-[1440px] flex-col px-8 pt-4 pb-4"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <TabsList
            data-testid="dashboard-tabs"
            aria-label={t('dashboard.tab.groupAria')}
            className="inline-flex h-8 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
          >
            <TabsTrigger
              value="web"
              data-testid="dashboard-tab-web"
              className="h-7 rounded-[5px] border border-transparent px-2.5 text-[12px] data-[state=active]:border-border data-[state=active]:bg-background data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:after:hidden data-[state=active]:shadow-none"
            >
              {t('dashboard.tab.web')}
            </TabsTrigger>
            <TabsTrigger
              value="internal"
              data-testid="dashboard-tab-internal"
              className="h-7 rounded-[5px] border border-transparent px-2.5 text-[12px] data-[state=active]:border-border data-[state=active]:bg-background data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:after:hidden data-[state=active]:shadow-none"
            >
              {t('dashboard.tab.internal')}
              {internalCount !== null ? (
                <span
                  data-testid="dashboard-internal-count"
                  aria-label={t('dashboard.tab.internalCountAria', { count: internalCount })}
                  className="rounded-full border border-border bg-background px-1.5 font-mono text-[9.5px] tabular-nums text-muted-foreground"
                >
                  {internalCount}
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="mt-3 shrink-0">
          <MetricStrip stats={stats} loading={statsLoading} error={statsError} />
        </div>

        <TabsContent
          value="web"
          className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <div className="shrink-0">
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
                  onClick={() => setExportOpen(true)}
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
              onRetry={refresh}
              fillHeight={(items?.length ?? 0) >= pageSize}
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
        </TabsContent>

        <TabsContent
          value="internal"
          data-testid="dashboard-internal-panel"
          className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto pr-1 data-[state=inactive]:hidden"
        >
          <InternalPage
            dataVersion={dataVersion}
            embedded
            onOpenPage={onOpenInternal}
          />
        </TabsContent>
      </Tabs>

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

      <ExportReportDialog
        open={exportOpen}
        count={selectedCount}
        pending={exporting}
        onOpenChange={setExportOpen}
        onConfirm={(outputDir, format) => void handleExportSelected(outputDir, format)}
      />
    </>
  )
}
