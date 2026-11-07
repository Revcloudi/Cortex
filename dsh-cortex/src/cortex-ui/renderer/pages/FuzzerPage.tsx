import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { Severity, Vulnerability, VulnerabilityListItem } from '@shared/types'
import { FuzzerPanel } from '@renderer/components/retest/FuzzerPanel'
import { SeverityBadge, StatusBadge } from '@renderer/components/common/Badges'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'

interface FuzzerPageProps {
  dataVersion: number
}

/**
 * Dedicated Web Fuzzer page: the finding picker lives in a compact left rail,
 * while the workbench follows Yakit's layout — request editor on the left,
 * response viewer on the right, results and recent jobs in the bottom panel.
 * The Host still enforces the origin allowlist for every request.
 */
export function FuzzerPage({ dataVersion }: FuzzerPageProps) {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim(), 180)
  const [severity, setSeverity] = useState<Severity | 'all'>('all')
  const [items, setItems] = useState<VulnerabilityListItem[] | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Vulnerability | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const hasLoaded = useRef(false)
  const detailCache = useRef(new Map<string, Vulnerability>())

  useEffect(() => {
    const api = getApi()
    if (!api) {
      setListError(t('common.apiUnavailable'))
      setListLoading(false)
      return
    }
    let alive = true
    if (!hasLoaded.current) setListLoading(true)
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
          setListError(null)
          setListLoading(false)
          hasLoaded.current = true
          setSelectedId((current) => {
            if (current !== null && result.items.some((item) => item.id === current)) return current
            return result.items[0]?.id ?? null
          })
        },
        (cause: unknown) => {
          if (!alive) return
          setListError(cause instanceof Error ? cause.message : String(cause))
          setListLoading(false)
        }
      )
    return () => {
      alive = false
    }
  }, [debouncedSearch, severity, dataVersion, t])

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
          setDetailError(t('fuzzer.target.detailFailed'))
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

  const workspace = (() => {
    if (detailError !== null) {
      return (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
          {detailError}
        </div>
      )
    }
    if (detail === null) {
      return <FuzzerPanel vuln={null} loading={detailLoading || (items !== null && items.length > 0)} />
    }
    return <FuzzerPanel key={detail.id} vuln={detail} loading={detailLoading} />
  })()

  return (
    <div
      data-testid="fuzzer-page"
      className="mx-auto flex h-full min-h-0 w-full max-w-[1680px] flex-col px-6 py-4"
    >
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t('fuzzer.page.eyebrow')}
          </p>
          <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight text-foreground">
            {t('nav.fuzzer')}
          </h1>
          <p className="mt-1 max-w-[760px] text-[11px] leading-relaxed text-muted-foreground">
            {t('fuzzer.page.description')}
          </p>
        </div>
        {detail !== null ? (
          <div className="flex min-w-0 max-w-[420px] flex-col items-end gap-1">
            <span className="rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
              {detail.id}
            </span>
            <span className="w-full truncate text-right font-mono text-[10px] text-muted-foreground" title={detail.target_url}>
              {detail.target_url}
            </span>
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex min-h-0 flex-1 gap-3">
        <aside className="flex min-h-0 w-[250px] shrink-0 flex-col gap-2" aria-label={t('fuzzer.target.title')}>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                data-testid="fuzzer-target-search"
                aria-label={t('fuzzer.target.search')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('fuzzer.target.search')}
                className="h-8 pl-8 text-[11.5px]"
              />
            </div>
            <Select value={severity} onValueChange={(value) => setSeverity(value as Severity | 'all')}>
              <SelectTrigger
                data-testid="fuzzer-target-severity"
                aria-label={t('retest.filter.severity')}
                className="h-8 w-[104px] text-[11px]"
              >
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
            {listError !== null ? (
              <p role="alert" className="p-3 text-[11px] text-red-700">
                {t('fuzzer.target.loadFailed', { error: listError })}
              </p>
            ) : listLoading && items === null ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : items === null || items.length === 0 ? (
              <p className="p-3 text-[11px] text-muted-foreground">{t('fuzzer.target.empty')}</p>
            ) : (
              items.map((item) => {
                const active = item.id === selectedId
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid="fuzzer-candidate-row"
                    data-vuln-id={item.id}
                    onClick={() => setSelectedId(item.id)}
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
                      <SeverityBadge severity={item.severity as Severity} />
                      <span className="truncate">{item.host}</span>
                      <span className="ml-auto shrink-0">
                        <StatusBadge status={item.status} />
                      </span>
                    </span>
                    <span className="truncate pl-3 font-mono text-[9.5px] text-muted-foreground/80">
                      {item.target_url}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">{workspace}</section>
      </div>
    </div>
  )
}
