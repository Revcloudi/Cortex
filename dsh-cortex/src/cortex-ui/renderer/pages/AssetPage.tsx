import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { ASSET_STATUSES, type AssetFilters, type AssetListItem, type AssetStatus } from '@shared/types'
import { AssetTable } from '@renderer/components/asset/AssetTable'
import { AssetDetail } from '@renderer/components/asset/AssetDetail'
import { AssetExportDialog } from '@renderer/components/asset/AssetExportDialog'
import { DeleteAssetsDialog } from '@renderer/components/asset/DeleteAssetsDialog'
import { VulnDetail } from '@renderer/components/vuln/VulnDetail'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import {
  deleteSelectedAssets,
  testDataExportErrorMessage,
  type TestDataExportResult
} from '@renderer/lib/testDataExportApi'
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

interface AssetPageProps {
  dataVersion: number
  /** Deep link from the nebula inspector: open this asset immediately. */
  initialHostPort?: string | null
}

export function AssetPage({ dataVersion, initialHostPort = null }: AssetPageProps) {
  const { t, assetStatusLabel } = useI18n()
  const [items, setItems] = useState<AssetListItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<AssetStatus | 'all'>('all')
  const [retrySeq, setRetrySeq] = useState(0)
  const [refreshSeq, setRefreshSeq] = useState(0)
  const [selectedHostPort, setSelectedHostPort] = useState<string | null>(null)
  const [relatedVulnId, setRelatedVulnId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportMode, setExportMode] = useState<'project' | 'assets'>('project')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const debouncedSearch = useDebouncedValue(search, 180)

  // Cross-page deep link (nebula → "view full details"): open the drawer once.
  useEffect(() => {
    if (initialHostPort !== null) setSelectedHostPort(initialHostPort)
  }, [initialHostPort])

  const filters: AssetFilters = useMemo(
    () => ({
      search: debouncedSearch.trim() || undefined,
      status: status === 'all' ? undefined : status
    }),
    [debouncedSearch, status]
  )
  const filtersActive = search.trim().length > 0 || status !== 'all'

  const load = useCallback(
    async (silent: boolean) => {
      const api = getApi()
      if (!api) {
        setError(apiUnavailableMessage(t))
        setLoading(false)
        return
      }
      if (!silent) setLoading(true)
      try {
        const next = await api.listAssets(filters)
        setItems(next)
        setError(null)
      } catch (cause) {
        setError(toErrorMessage(cause, t))
      } finally {
        setLoading(false)
      }
    },
    [filters, t]
  )

  useEffect(() => {
    void load(items !== null)
  }, [load, dataVersion, retrySeq, refreshSeq])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const handleRetry = () => {
    setItems(null)
    setRetrySeq((value) => value + 1)
  }

  const clearFilters = () => {
    setSearch('')
    setStatus('all')
  }

  const relatedVulnVersion = dataVersion + refreshSeq

  const assetIdOf = useCallback(
    (item: AssetListItem): string => item.asset_id || item.host_port,
    []
  )

  const projects = useMemo(() => {
    const names = new Set<string>()
    for (const item of items ?? []) {
      const name = item.project_name.trim()
      if (name.length > 0) names.add(name)
    }
    return [...names].sort((left, right) => left.localeCompare(right))
  }, [items])

  const selectedItems = useMemo(
    () => (items ?? []).filter((item) => selectedIds.has(assetIdOf(item))),
    [items, selectedIds, assetIdOf]
  )

  const toggleSelection = (assetId: string): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }

  const toggleAll = (selectAll: boolean): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      for (const item of items ?? []) {
        const id = assetIdOf(item)
        if (selectAll) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  const openExport = (mode: 'project' | 'assets'): void => {
    setExportMode(mode)
    setExportOpen(true)
  }

  const handleExported = (result: TestDataExportResult): void => {
    const count = result.savedPaths.length
    if (count === 0) {
      toast.success(t('asset.export.successNoPath', { count }))
      return
    }
    toast.success(
      t('asset.export.success', { count, path: result.savedPaths[0] })
    )
  }

  const handleBulkDelete = async (): Promise<void> => {
    if (deleting || selectedIds.size === 0) return
    setDeleting(true)
    try {
      const result = await deleteSelectedAssets([...selectedIds])
      setDeleteOpen(false)
      setSelectedIds(new Set())
      if (result.missing.length > 0 && result.deleted === 0) {
        toast(t('asset.bulkDelete.partial', { deleted: 0, missing: result.missing.length }))
      } else if (result.missing.length > 0) {
        toast.success(
          t('asset.bulkDelete.partial', {
            deleted: result.deleted,
            missing: result.missing.length
          })
        )
      } else {
        toast.success(t('asset.bulkDelete.deleted', { count: result.deleted }))
      }
      setRefreshSeq((value) => value + 1)
    } catch (cause) {
      toast.error(
        t('asset.bulkDelete.failed', { error: testDataExportErrorMessage(cause) })
      )
    } finally {
      setDeleting(false)
    }
  }

  const exportProject = projects.includes(selectedItems[0]?.project_name ?? '')
    ? (selectedItems[0]?.project_name ?? projects[0] ?? '')
    : projects[0] ?? ''

  return (
    <section className="mx-auto w-full max-w-[1440px] px-8 py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {t('asset.page.eyebrow')}
          </p>
          <div className="mt-1 flex items-baseline gap-2.5">
            <h1 className="text-[18px] font-medium tracking-tight text-foreground">
              {t('asset.page.title')}
            </h1>
            <span className="font-mono text-[11px] tabular-nums text-foreground/70">
              {items === null ? '—' : t('asset.page.assetCount', { count: items.length })}
            </span>
          </div>
        </div>

        <div className="flex w-full max-w-[430px] items-center gap-2 sm:w-auto">
          <Button
            variant="outline"
            size="sm"
            data-testid="asset-export-open"
            disabled={items === null || items.length === 0}
            onClick={() => openExport('project')}
            className="h-9 shrink-0 gap-1.5"
          >
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
            {t('asset.page.export')}
          </Button>
          <div className="relative min-w-0 flex-1 sm:w-[300px]">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchInputRef}
              data-testid="asset-search"
              aria-label={t('asset.search.label')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('asset.search.placeholder')}
              className="pl-9 pr-9"
            />
            {search ? (
              <button
                type="button"
                aria-label={t('asset.search.clear')}
                onClick={() => setSearch('')}
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
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div
          data-testid="asset-status-filter"
          role="group"
          aria-label={t('asset.filter.group')}
          className="inline-flex h-9 items-center rounded-md border border-border bg-muted p-1"
        >
          {(['all', ...ASSET_STATUSES] as const).map((value) => {
            const active = status === value
            const label = value === 'all' ? t('common.all') : assetStatusLabel(value)
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setStatus(value)}
                className={cn(
                  'inline-flex h-7 items-center rounded-[5px] border px-2.5 text-[12px] transition-colors duration-150 focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  active
                    ? 'border-border bg-background font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">
            {items === null ? t('asset.page.loading') : t('common.count', { count: items.length })}
          </span>
          <button
            type="button"
            aria-label={t('asset.page.refresh')}
            onClick={() => setRefreshSeq((value) => value + 1)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {selectedIds.size > 0 ? (
        <div
          data-testid="asset-batch-bar"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-sidebar px-3 py-2"
        >
          <span
            data-testid="asset-selected-count"
            className="font-mono text-[11px] tabular-nums text-foreground"
          >
            {t('asset.selection.selected', { count: selectedIds.size })}
          </span>
          <Button
            variant="outline"
            size="xs"
            data-testid="asset-batch-export"
            onClick={() => openExport('assets')}
            className="gap-1.5"
          >
            <Download aria-hidden="true" className="h-3 w-3" />
            {t('asset.selection.export')}
          </Button>
          <Button
            variant="destructive"
            size="xs"
            data-testid="asset-batch-delete"
            onClick={() => setDeleteOpen(true)}
            className="gap-1.5"
          >
            <Trash2 aria-hidden="true" className="h-3 w-3" />
            {t('asset.selection.delete')}
          </Button>
          <button
            type="button"
            data-testid="asset-selection-clear"
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-3 w-3" />
            {t('asset.selection.clear')}
          </button>
        </div>
      ) : null}

      <div className="mt-3">
        <AssetTable
          items={items}
          loading={loading}
          error={error}
          filtersActive={filtersActive}
          selectedIds={selectedIds}
          onToggleSelection={toggleSelection}
          onToggleAll={toggleAll}
          onOpen={setSelectedHostPort}
          onClearFilters={clearFilters}
          onRetry={handleRetry}
        />
      </div>

      <AssetDetail
        hostPort={selectedHostPort}
        dataVersion={relatedVulnVersion}
        onClose={() => setSelectedHostPort(null)}
        onOpenVuln={setRelatedVulnId}
        onDeleted={() => {
          setSelectedHostPort(null)
          setRelatedVulnId(null)
          setRefreshSeq((value) => value + 1)
        }}
      />

      <VulnDetail
        vulnId={relatedVulnId}
        dataVersion={relatedVulnVersion}
        onClose={() => setRelatedVulnId(null)}
        onChanged={() => setRefreshSeq((value) => value + 1)}
        onOpenRelated={setRelatedVulnId}
      />

      <DeleteAssetsDialog
        open={deleteOpen}
        count={selectedIds.size}
        pending={deleting}
        onOpenChange={(open) => {
          if (!deleting) setDeleteOpen(open)
        }}
        onConfirm={() => void handleBulkDelete()}
      />

      <AssetExportDialog
        open={exportOpen}
        mode={exportMode}
        projects={projects}
        initialProject={exportProject}
        selectedAssetIds={[...selectedIds]}
        onOpenChange={setExportOpen}
        onExported={handleExported}
      />
    </section>
  )
}
