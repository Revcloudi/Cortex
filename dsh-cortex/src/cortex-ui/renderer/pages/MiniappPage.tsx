import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Boxes,
  FolderPlus,
  Loader2,
  PackageSearch,
  RefreshCw,
  Search,
  ShieldCheck,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { MiniappCard } from '@renderer/components/miniapp/MiniappCard'
import type { MiniappCardAction } from '@renderer/components/miniapp/MiniappCard'
import { MiniappDetail } from '@renderer/components/miniapp/MiniappDetail'
import {
  MINIAPP_STATUSES,
  analyzeMiniapp,
  importMiniappAssets,
  listMiniappRoots,
  listMiniapps,
  openMiniappDir,
  scanMiniapps,
  setMiniappRoots,
  toMiniappErrorMessage,
  unpackMiniapp,
  type MiniappListResponse,
  type MiniappRootsResponse,
  type MiniappRow,
  type MiniappScanRoot,
  type MiniappStatus
} from '@renderer/lib/miniappApi'
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

interface MiniappPageProps {
  dataVersion: number
}

const EMPTY_LIST: MiniappListResponse = {
  miniapps: [],
  total: 0,
  appCount: 0,
  customRoots: [],
  workspaceRoot: '',
  lastScanAt: null
}

/**
 * Mini-program (wxapkg) reverse-engineering workbench.
 *
 * The page only reads the host routes under `/cortex-api/cortex/miniapps`; the
 * host owns the WeChat cache read-only contract. Every destructive-looking
 * action here (unpack/analyze/import/open) is explicit and disabled while a
 * request is in flight, and the detail inspector opens on browse.
 */
export function MiniappPage({ dataVersion }: MiniappPageProps) {
  const { t } = useI18n()
  const [data, setData] = useState<MiniappListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim(), 180)
  const [status, setStatus] = useState<MiniappStatus | 'all'>('all')
  const [showExtras, setShowExtras] = useState(false)
  const [retrySeq, setRetrySeq] = useState(0)
  const [refreshSeq, setRefreshSeq] = useState(0)
  const [scanPending, setScanPending] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [roots, setRoots] = useState<MiniappRootsResponse | null>(null)
  const [scanRoots, setScanRoots] = useState<MiniappScanRoot[] | null>(null)
  const [addRootOpen, setAddRootOpen] = useState(false)
  const [addRootValue, setAddRootValue] = useState('')
  const [addRootPending, setAddRootPending] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ id: string; action: MiniappCardAction } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const filtersActive = search.trim().length > 0 || status !== 'all'

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true)
      try {
        const next = await listMiniapps({
          search: debouncedSearch,
          status: status === 'all' ? '' : status
        })
        setData(next)
        setError(null)
      } catch (cause) {
        setError(toMiniappErrorMessage(cause))
      } finally {
        setLoading(false)
      }
    },
    [debouncedSearch, status]
  )

  useEffect(() => {
    void load(data !== null)
  }, [load, dataVersion, retrySeq, refreshSeq])

  useEffect(() => {
    let alive = true
    listMiniappRoots().then(
      (next) => {
        if (alive) setRoots(next)
      },
      () => {
        /* root metadata is informational; the scan still works without it */
      }
    )
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const replaceRow = (row: MiniappRow): void => {
    setData((prev) => {
      if (prev === null) return prev
      return {
        ...prev,
        miniapps: prev.miniapps.map((item) => (item.id === row.id ? { ...item, ...row } : item))
      }
    })
  }

  const handleScan = async (customRoots?: string[]): Promise<void> => {
    if (scanPending) return
    setScanPending(true)
    setScanError(null)
    try {
      const result = await scanMiniapps(customRoots)
      setScanRoots(Array.isArray(result.roots) ? result.roots : null)
      const scannedRows = result.miniapps ?? []
      setData((prev) => {
        const base = prev ?? EMPTY_LIST
        return {
          ...base,
          miniapps: scannedRows,
          total: result.totalSources ?? scannedRows.length,
          appCount: new Set(scannedRows.map((row) => row.appid)).size,
          customRoots: customRoots ?? base.customRoots,
          lastScanAt: result.scannedAt
        }
      })
      setError(null)
      toast.success(
        t('miniapp.scan.done', {
          total: result.totalPackages,
          added: result.added,
          updated: result.updated,
          unchanged: result.unchanged
        })
      )
      if (result.errors.length > 0) {
        toast.warning(t('miniapp.scan.errors', { count: result.errors.length }))
      }
    } catch (cause) {
      const message = toMiniappErrorMessage(cause)
      setScanError(message)
      toast.error(t('miniapp.scan.failed', { error: message }))
    } finally {
      setScanPending(false)
    }
  }

  const handleAddRoot = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const directory = addRootValue.trim()
    if (directory.length === 0 || addRootPending) return
    setAddRootPending(true)
    try {
      const next = await setMiniappRoots([directory], 'append')
      setRoots(next)
      setAddRootValue('')
      setAddRootOpen(false)
      toast.success(t('miniapp.toast.rootAdded', { path: directory }))
      await handleScan(next.customRoots)
    } catch (cause) {
      toast.error(t('miniapp.toast.rootFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setAddRootPending(false)
    }
  }

  const handleUnpack = async (item: MiniappRow): Promise<void> => {
    if (busy !== null) return
    setBusy({ id: item.id, action: 'unpack' })
    try {
      const result = await unpackMiniapp(item.id)
      replaceRow({ ...item, ...result.miniapp })
      if (result.ok) {
        toast.success(t('miniapp.toast.unpacked', { appid: item.appid }))
      } else if (result.status === 'unsupported') {
        toast.error(t('miniapp.toast.unpackUnsupported', { error: result.error }))
      } else {
        toast.error(t('miniapp.toast.unpackFailed', { error: result.error }))
      }
    } catch (cause) {
      toast.error(t('miniapp.toast.unpackFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const handleAnalyze = async (item: MiniappRow): Promise<void> => {
    if (busy !== null) return
    setBusy({ id: item.id, action: 'analyze' })
    try {
      const result = await analyzeMiniapp(item.id)
      replaceRow({ ...item, has_analysis: true })
      toast.success(
        t('miniapp.toast.analyzed', {
          pages: result.analysis?.pages.length ?? 0,
          endpoints: result.counts.endpoints,
          secrets: result.counts.secrets
        })
      )
      setSelectedId(item.id)
    } catch (cause) {
      toast.error(t('miniapp.toast.analyzeFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const handleImport = async (item: MiniappRow): Promise<void> => {
    if (busy !== null) return
    setBusy({ id: item.id, action: 'import' })
    try {
      const result = await importMiniappAssets(item.id, {})
      replaceRow({ ...item, has_analysis: true })
      if (result.ok) {
        toast.success(t('miniapp.toast.imported', { ...result.totals }))
      } else {
        toast.warning(t('miniapp.toast.importWarnings', { warnings: result.warnings.join('; ') }))
      }
    } catch (cause) {
      toast.error(t('miniapp.toast.importFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const handleOpenDir = async (item: MiniappRow): Promise<void> => {
    if (busy !== null) return
    setBusy({ id: item.id, action: 'open' })
    try {
      const result = await openMiniappDir(item.id)
      toast.success(t('miniapp.toast.opened', { path: result.path }))
    } catch (cause) {
      toast.error(t('miniapp.toast.openFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const resetFilters = (): void => {
    setSearch('')
    setStatus('all')
  }

  const workspaceRoot = data?.workspaceRoot ?? ''
  const customRootCount = roots?.customRoots?.length ?? data?.customRoots?.length ?? 0
  const extraCount =
    data === null
      ? 0
      : data.miniapps.filter((row) => row.kind === 'plugin' || row.kind === 'library').length
  const visibleMiniapps =
    data === null
      ? []
      : data.miniapps.filter(
          (row) => showExtras || (row.kind !== 'plugin' && row.kind !== 'library')
        )
  const visibleCountLabel = t('miniapp.page.count', {
    count: visibleMiniapps.length,
    apps: new Set(visibleMiniapps.map((row) => row.appid)).size
  })
  const headerCountLabel =
    data === null
      ? '—'
      : !showExtras && extraCount > 0
        ? t('miniapp.page.countVisible', {
            visible: visibleMiniapps.length,
            total: data.total,
            apps: data.appCount
          })
        : t('miniapp.page.count', { count: data.total, apps: data.appCount })

  return (
    <section
      data-testid="miniapps-page"
      className="mx-auto w-full max-w-[1440px] px-8 py-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {t('miniapp.page.eyebrow')}
          </p>
          <div className="mt-1 flex items-baseline gap-2.5">
            <h1 className="text-[18px] font-medium tracking-tight text-foreground">
              {t('nav.miniapps')}
            </h1>
            <span className="font-mono text-[11px] tabular-nums text-foreground/70">
              {headerCountLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-start gap-3 rounded-lg border border-border bg-sidebar px-4 py-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-emerald-700">
          <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-foreground">{t('miniapp.banner.title')}</p>
          <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground/80">
            {workspaceRoot.length > 0
              ? t('miniapp.banner.workspace', { path: workspaceRoot })
              : null}
            {customRootCount > 0
              ? `${workspaceRoot.length > 0 ? ' · ' : ''}${t('miniapp.banner.roots', {
                  count: customRootCount
                })}`
              : null}
          </p>
        </div>
      </div>

      {scanRoots !== null && scanRoots.length > 0 ? (
        <div className="mt-2 flex flex-col gap-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
          <p className="break-all font-mono text-[10px] text-muted-foreground/80">
            {t('miniapp.page.rootsSummary', {
              summary: scanRoots
                .map(
                  (root) =>
                    `${root.path.split(/[\\/]/).filter(Boolean).pop() ?? root.kind} ${
                      root.exists ? (root.filesFound ?? 0) : '—'
                    }`
                )
                .join(' · ')
            })}
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          data-testid="miniapps-scan"
          disabled={scanPending}
          onClick={() => void handleScan()}
          className="gap-1.5"
        >
          {scanPending ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PackageSearch aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {scanPending ? t('miniapp.action.scanning') : t('miniapp.action.scan')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="miniapps-refresh"
          aria-label={t('common.refresh')}
          disabled={loading && data === null}
          onClick={() => setRefreshSeq((value) => value + 1)}
          className="gap-1.5"
        >
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          {t('common.refresh')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="miniapps-add-root-toggle"
          aria-expanded={addRootOpen}
          onClick={() => setAddRootOpen((value) => !value)}
          className="gap-1.5"
        >
          <FolderPlus aria-hidden="true" className="h-3.5 w-3.5" />
          {t('miniapp.action.addRoot')}
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as MiniappStatus | 'all')}
          >
            <SelectTrigger
              data-testid="miniapps-status-filter"
              aria-label={t('miniapp.filter.statusAria')}
              className="h-8 w-[132px] text-[11px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('miniapp.filter.all')}</SelectItem>
              {MINIAPP_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`miniapp.status.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant={showExtras ? 'subtle' : 'outline'}
            size="sm"
            data-testid="miniapps-show-extras"
            aria-pressed={showExtras}
            onClick={() => setShowExtras((value) => !value)}
            className="gap-1.5"
          >
            <Boxes aria-hidden="true" className="h-3.5 w-3.5" />
            {t(showExtras ? 'miniapp.filter.hideExtras' : 'miniapp.filter.showExtras')}
            {extraCount > 0 ? (
              <span className="font-mono text-[10px] tabular-nums">({extraCount})</span>
            ) : null}
          </Button>

          <div className="relative w-full max-w-[320px] sm:w-[280px]">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchInputRef}
              data-testid="miniapps-search"
              aria-label={t('miniapp.search.ariaLabel')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('miniapp.search.placeholder')}
              className="pl-9 pr-9"
            />
            {search.length > 0 ? (
              <button
                type="button"
                aria-label={t('miniapp.search.clear')}
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {addRootOpen ? (
        <form
          onSubmit={(event) => void handleAddRoot(event)}
          className="mt-3 flex flex-wrap items-start gap-2 rounded-lg border border-border bg-background px-3 py-2.5"
        >
          <div className="min-w-[240px] flex-1">
            <Input
              autoFocus
              data-testid="miniapps-add-root-input"
              aria-label={t('miniapp.action.addRoot')}
              value={addRootValue}
              onChange={(event) => setAddRootValue(event.target.value)}
              placeholder={t('miniapp.addRoot.placeholder')}
              className="h-8 font-mono text-[11.5px]"
            />
            <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
              {t('miniapp.addRoot.hint')}
            </p>
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            data-testid="miniapps-add-root-submit"
            disabled={addRootPending || addRootValue.trim().length === 0}
            className="gap-1.5"
          >
            {addRootPending ? (
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderPlus aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {t('miniapp.action.addRootSubmit')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setAddRootOpen(false)
              setAddRootValue('')
            }}
          >
            {t('miniapp.action.addRootCancel')}
          </Button>
        </form>
      ) : null}

      {scanError !== null ? (
        <p
          role="alert"
          className="mt-3 break-all rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700"
        >
          {t('miniapp.scan.failed', { error: scanError })}
        </p>
      ) : null}

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-1.5">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t('nav.miniapps')}
          </span>
          <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
            {data === null
              ? t('miniapp.page.loading')
              : filtersActive
                ? t('miniapp.page.count', {
                    count: visibleMiniapps.length,
                    apps: new Set(visibleMiniapps.map((row) => row.appid)).size
                  })
                : visibleCountLabel}
            {!showExtras && extraCount > 0
              ? ` · ${t('miniapp.page.hiddenExtras', { count: extraCount })}`
              : ''}
          </span>
        </div>

        {error !== null ? (
          <div role="alert" data-testid="miniapps-error" className="flex flex-wrap items-start gap-3 px-4 py-6">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-red-700">{t('miniapp.error.title')}</p>
              <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-red-700/80">
                {error}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setData(null)
                setRetrySeq((value) => value + 1)
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : loading && data === null ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : data === null || data.miniapps.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title={filtersActive ? t('miniapp.emptyFiltered.title') : t('miniapp.empty.title')}
            description={
              filtersActive
                ? t('miniapp.emptyFiltered.description')
                : t('miniapp.empty.description')
            }
          >
            {filtersActive ? (
              <Button variant="outline" size="sm" onClick={resetFilters}>
                {t('miniapp.emptyFiltered.reset')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={scanPending}
                onClick={() => void handleScan()}
                className={cn('gap-1.5')}
              >
                {scanPending ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PackageSearch aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {t('miniapp.empty.cta')}
              </Button>
            )}
          </EmptyState>
        ) : visibleMiniapps.length === 0 && filtersActive ? (
          <EmptyState
            icon={Search}
            title={t('miniapp.emptyFiltered.title')}
            description={t('miniapp.emptyFiltered.description')}
          >
            <Button variant="outline" size="sm" onClick={resetFilters}>
              {t('miniapp.emptyFiltered.reset')}
            </Button>
          </EmptyState>
        ) : visibleMiniapps.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title={t('miniapp.emptyExtras.title')}
            description={t('miniapp.emptyExtras.description')}
          >
            <Button variant="outline" size="sm" onClick={() => setShowExtras(true)}>
              {t('miniapp.emptyExtras.cta')}
            </Button>
          </EmptyState>
        ) : (
          <ul>
            {visibleMiniapps.map((item) => (
              <MiniappCard
                key={item.id}
                item={item}
                busy={busy !== null && busy.id === item.id}
                busyAction={busy !== null && busy.id === item.id ? busy.action : null}
                onOpen={(row) => setSelectedId(row.id)}
                onUnpack={(row) => void handleUnpack(row)}
                onAnalyze={(row) => void handleAnalyze(row)}
                onImport={(row) => void handleImport(row)}
                onOpenDir={(row) => void handleOpenDir(row)}
              />
            ))}
          </ul>
        )}
      </div>

      <MiniappDetail
        miniappId={selectedId}
        onClose={() => setSelectedId(null)}
        onChanged={() => setRefreshSeq((value) => value + 1)}
      />
    </section>
  )
}
