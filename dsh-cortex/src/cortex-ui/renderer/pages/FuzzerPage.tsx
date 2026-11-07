import { useEffect, useRef, useState } from 'react'
import { Zap } from 'lucide-react'
import type { Severity, Vulnerability, VulnerabilityListItem } from '@shared/types'
import { YakitSendPanel } from '@renderer/components/retest/YakitSendPanel'
import { SeverityBadge, StatusBadge } from '@renderer/components/common/Badges'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'

interface FuzzerPageProps {
  dataVersion: number
}

const TARGET_STORAGE_KEY = 'cortex.fuzzer.target'

function storedTargetId(): string {
  try {
    return window.localStorage.getItem(TARGET_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberTarget(id: string): void {
  try {
    window.localStorage.setItem(TARGET_STORAGE_KEY, id)
  } catch {
    /* localStorage may be unavailable in a hardened WebView */
  }
}

/**
 * Dedicated Web Fuzzer page: a Yakit-style manual HTTP sender with the request
 * editor on the left, the response viewer on the right and both panes filling
 * the available height. There is deliberately no ported vulnerability list and
 * no batch fuzzing: a compact target selector in the header is the only link to
 * a finding, because the Host derives the outbound origin allowlist from it.
 */
export function FuzzerPage({ dataVersion }: FuzzerPageProps) {
  const { t } = useI18n()
  const [items, setItems] = useState<VulnerabilityListItem[] | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Vulnerability | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const detailCache = useRef(new Map<string, Vulnerability>())

  useEffect(() => {
    const api = getApi()
    if (!api) {
      setListError(t('common.apiUnavailable'))
      setListLoading(false)
      return
    }
    let alive = true
    setListLoading(true)
    api
      .listVulnerabilities({ realm: 'web', page: 1, pageSize: 200 })
      .then(
        (result) => {
          if (!alive) return
          setItems(result.items)
          setListError(null)
          setListLoading(false)
          const remembered = storedTargetId()
          setSelectedId((current) => {
            const preferred = current ?? remembered
            if (preferred !== '' && result.items.some((item) => item.id === preferred)) {
              return preferred
            }
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
  }, [dataVersion, t])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      setDetailLoading(false)
      setDetailError(null)
      return
    }
    rememberTarget(selectedId)
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

  const selectedItem = items?.find((item) => item.id === selectedId) ?? null

  return (
    <div
      data-testid="fuzzer-page"
      className="mx-auto flex h-full min-h-0 w-full max-w-[1680px] flex-col px-6 py-4"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-[19px] font-semibold tracking-tight text-foreground">
          {t('nav.fuzzer')}
        </h1>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span className="text-[10.5px] text-muted-foreground">{t('fuzzer.target.title')}</span>
          {listLoading && items === null ? (
            <Skeleton className="h-8 w-[300px]" />
          ) : (
            <Select
              value={selectedId ?? undefined}
              onValueChange={(value) => setSelectedId(value)}
              disabled={items === null || items.length === 0}
            >
              <SelectTrigger
                data-testid="fuzzer-target-select"
                aria-label={t('fuzzer.target.title')}
                className="h-8 w-[300px] text-[11.5px]"
              >
                <SelectValue placeholder={t('fuzzer.target.select')} />
              </SelectTrigger>
              <SelectContent className="max-h-[320px]">
                {(items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id} className="text-[11.5px]">
                    {item.vuln_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {selectedItem !== null ? (
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <SeverityBadge severity={selectedItem.severity as Severity} />
              <span className="max-w-[180px] truncate font-mono">{selectedItem.host}</span>
              <StatusBadge status={selectedItem.status} />
            </span>
          ) : null}
        </div>
      </div>

      {listError !== null ? (
        <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
          {t('fuzzer.target.loadFailed', { error: listError })}
        </div>
      ) : null}

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        {detailError !== null ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
            {detailError}
          </div>
        ) : detail === null && listError === null && !listLoading && (items?.length ?? 0) === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-background/60 text-[12px] text-muted-foreground">
            {t('fuzzer.target.empty')}
          </div>
        ) : detail === null ? (
          <YakitSendPanel vuln={null} loading={detailLoading || listLoading || (items?.length ?? 0) > 0} />
        ) : (
          <YakitSendPanel key={detail.id} vuln={detail} loading={detailLoading} />
        )}
      </div>
    </div>
  )
}
