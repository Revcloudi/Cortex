import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { VULN_STATUSES, type Severity, type Vulnerability, type VulnerabilityListItem, type VulnStatus } from '@shared/types'
import { RepeaterPanel } from '@renderer/components/retest/RepeaterPanel'
import { RetestProxyDialog } from '@renderer/components/retest/RetestProxyDialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { SeverityBadge, StatusBadge } from '@renderer/components/common/Badges'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'

interface RetestPageProps {
  dataVersion: number
}

/**
 * Manual retest workbench: Web findings on the left, a raw HTTP repeater on the
 * right. The previous generated-JS PoC lab was removed in schema v5; only the
 * AI model configuration moved to the main sidebar and the retest proxy remains
 * here (it applies to repeater traffic only).
 */
export function RetestPage({ dataVersion }: RetestPageProps) {
  const { t, statusLabel } = useI18n()
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim(), 180)
  const [severity, setSeverity] = useState<Severity | 'all'>('all')
  const [items, setItems] = useState<VulnerabilityListItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Vulnerability | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [statusPending, setStatusPending] = useState(false)
  const [proxyOpen, setProxyOpen] = useState(false)
  const hasLoaded = useRef(false)
  const detailCache = useRef(new Map<string, Vulnerability>())

  useEffect(() => {
    const api = getApi()
    if (!api) {
      setError(t('common.apiUnavailable'))
      setLoading(false)
      return
    }
    let alive = true
    if (!hasLoaded.current) setLoading(true)
    api
      .listVulnerabilities({
        realm: 'web',
        ...(debouncedSearch === '' ? {} : { search: debouncedSearch }),
        ...(severity === 'all' ? {} : { severity }),
        page: 1,
        pageSize: 200
      })
      .then(
        (result) => {
          if (!alive) return
          setItems(result.items)
          setError(null)
          setLoading(false)
          hasLoaded.current = true
          setSelectedId((current) => {
            if (current !== null && result.items.some((item) => item.id === current)) return current
            return result.items[0]?.id ?? null
          })
        },
        (cause: unknown) => {
          if (!alive) return
          setError(cause instanceof Error ? cause.message : String(cause))
          setLoading(false)
        }
      )
    return () => {
      alive = false
    }
  }, [debouncedSearch, severity, dataVersion, t])

  const onSelect = useCallback((id: string) => setSelectedId(id), [])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      setDetailLoading(false)
      setDetailError(null)
      return
    }
    const cached = detailCache.current.get(selectedId)
    if (cached !== undefined) {
      setDetail(cached)
      setDetailLoading(false)
      setDetailError(null)
      return
    }
    const api = getApi()
    if (!api) {
      setDetailError(t('common.apiUnavailable'))
      setDetailLoading(false)
      return
    }
    let alive = true
    setDetail(null)
    setDetailLoading(true)
    setDetailError(null)
    api.getVulnerability(selectedId).then(
      (next) => {
        if (!alive) return
        if (next === null) {
          setDetailError(t('retest.page.detailMissing'))
        } else {
          detailCache.current.set(next.id, next)
          setDetail(next)
        }
        setDetailLoading(false)
      },
      (cause: unknown) => {
        if (!alive) return
        setDetailError(cause instanceof Error ? cause.message : String(cause))
        setDetailLoading(false)
      }
    )
    return () => {
      alive = false
    }
  }, [selectedId, dataVersion, t])

  const handleStatusChange = async (status: VulnStatus): Promise<void> => {
    if (detail === null || statusPending || status === detail.status) return
    const api = getApi()
    if (!api) {
      toast.error(t('common.apiUnavailable'))
      return
    }
    setStatusPending(true)
    try {
      const updated = await api.updateVulnerabilityStatus({ id: detail.id, status })
      detailCache.current.set(updated.id, updated)
      setDetail(updated)
      setItems((current) =>
        current === null
          ? current
          : current.map((item) => (item.id === updated.id ? { ...item, status: updated.status } : item))
      )
      toast.success(t('retest.status.updated'))
    } catch (cause) {
      toast.error(
        t('retest.status.updateFailed', {
          error: cause instanceof Error ? cause.message : String(cause)
        })
      )
    } finally {
      setStatusPending(false)
    }
  }

  return (
    <div data-testid="retest-page" className="mx-auto flex h-full min-h-0 w-full max-w-[1440px] flex-col px-8 py-4">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t('retest.header.eyebrow')}
          </p>
          <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight text-foreground">
            {t('nav.retest')}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10.5px] text-muted-foreground">{t('common.status')}</span>
            <Select
              value={detail?.status ?? 'Confirmed'}
              onValueChange={(value) => void handleStatusChange(value as VulnStatus)}
              disabled={detail === null || detailLoading || statusPending}
            >
              <SelectTrigger
                data-testid="retest-status"
                aria-label={t('retest.status.aria')}
                className="h-8 w-[124px] text-[11.5px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VULN_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {statusLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" data-testid="retest-config-open" onClick={() => setProxyOpen(true)} className="gap-1.5">
            <Settings2 aria-hidden="true" className="h-3.5 w-3.5" />
            {t('retest.proxy.button')}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 gap-3">
        <aside className="flex min-h-0 w-[300px] shrink-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t('retest.search.placeholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('retest.search.placeholder')}
                className="h-8 pl-8 text-[11.5px]"
              />
            </div>
            <Select value={severity} onValueChange={(value) => setSeverity(value as Severity | 'all')}>
              <SelectTrigger aria-label={t('retest.filter.severity')} className="h-8 w-[110px] text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('retest.filter.allSeverity')}</SelectItem>
                <SelectItem value="Critical">Critical</SelectItem>
                <SelectItem value="High">High</SelectItem>
                <SelectItem value="Medium">Medium</SelectItem>
                <SelectItem value="Low">Low</SelectItem>
                <SelectItem value="Info">Info</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-background">
            {error !== null ? (
              <p role="alert" className="p-3 text-[11px] text-red-700">{error}</p>
            ) : loading && items === null ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : items === null || items.length === 0 ? (
              <p className="p-3 text-[11px] text-muted-foreground">{t('retest.page.empty')}</p>
            ) : (
              items.map((item) => {
                const active = item.id === selectedId
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid="retest-candidate-row"
                    data-vuln-id={item.id}
                    onClick={() => onSelect(item.id)}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-muted',
                      active && 'bg-accent-soft/60'
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                      <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground">
                        {item.vuln_name}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 pl-3 text-[10px] text-muted-foreground">
                      <SeverityBadge severity={item.severity} />
                      <span className="truncate">{item.host}</span>
                      <span className="ml-auto shrink-0"><StatusBadge status={item.status} /></span>
                    </span>
                    <span className="truncate pl-3 font-mono text-[9.5px] text-muted-foreground/80">{item.target_url}</span>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {detailError !== null ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
              {detailError}
            </div>
          ) : (
            <RepeaterPanel vuln={detail} loading={detailLoading} />
          )}
        </section>
      </div>

      <RetestProxyDialog open={proxyOpen} onOpenChange={setProxyOpen} />
    </div>
  )
}
