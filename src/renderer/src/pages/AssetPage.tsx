import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search, X } from 'lucide-react'
import { ASSET_STATUSES, type AssetFilters, type AssetListItem, type AssetStatus } from '@shared/types'
import { AssetTable } from '@renderer/components/asset/AssetTable'
import { AssetDetail } from '@renderer/components/asset/AssetDetail'
import { VulnDetail } from '@renderer/components/vuln/VulnDetail'
import { Input } from '@renderer/components/ui/input'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

interface AssetPageProps {
  dataVersion: number
}

export function AssetPage({ dataVersion }: AssetPageProps) {
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
  const searchInputRef = useRef<HTMLInputElement>(null)
  const debouncedSearch = useDebouncedValue(search, 180)

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

        <div className="relative w-full max-w-[320px] sm:w-[300px]">
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

      <div className="mt-3">
        <AssetTable
          items={items}
          loading={loading}
          error={error}
          filtersActive={filtersActive}
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
    </section>
  )
}
