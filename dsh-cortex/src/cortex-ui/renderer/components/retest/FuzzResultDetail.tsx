import { useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { utf8ByteLength } from '@renderer/lib/fuzz'
import {
  fuzzerErrorMessage,
  getFuzzResult,
  type FuzzResultDetail as FuzzResultDetailData
} from '@renderer/lib/fuzzerApi'
import {
  buildHtmlPreview,
  headerValue,
  isHtmlResponse,
  prettyJsonBody,
  statusTone
} from '@renderer/lib/retestResponse'
import { serializeRawRequest } from '@renderer/lib/repeaterRaw'
import { cn } from '@renderer/lib/utils'

type DetailView = 'raw' | 'json' | 'html'

interface FuzzResultDetailProps {
  jobId: string
  index: number | 'baseline'
  /** Finding target URL, used as the HTML preview base origin. */
  targetUrl: string
  onClose: () => void
}

/**
 * Full result inspector: the replaced request plus response headers/body, with
 * raw / pretty-JSON / sandboxed-HTML views. The iframe never gets permissions
 * (`sandbox=""`) and never loads the body as a same-origin document.
 */
export function FuzzResultDetail({ jobId, index, targetUrl, onClose }: FuzzResultDetailProps) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<FuzzResultDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<DetailView>('raw')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setDetail(null)
    setView('raw')
    getFuzzResult(jobId, index).then(
      (result) => {
        if (!alive) return
        if (result === null || result === undefined) {
          setError(t('fuzzer.error.detailMissing'))
        } else {
          setDetail(result)
        }
        setLoading(false)
      },
      (cause: unknown) => {
        if (!alive) return
        setError(t('fuzzer.error.loadDetail', { error: fuzzerErrorMessage(cause) }))
        setLoading(false)
      }
    )
    return () => {
      alive = false
    }
    // `attempt` lets the retry button re-run the same fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, index, attempt])

  const response = detail?.response ?? null
  const headers = response?.headers ?? {}
  const body = response?.body ?? ''
  const contentType = response?.contentType ?? headerValue(headers, 'content-type')
  const formattedJson = useMemo(() => prettyJsonBody(body, contentType), [body, contentType])
  const htmlResponse = useMemo(() => isHtmlResponse(body, headers), [body, headers])
  const htmlPreview = useMemo(
    () => (htmlResponse ? buildHtmlPreview(body, targetUrl) : ''),
    [htmlResponse, body, targetUrl]
  )

  const isBaseline = index === 'baseline'
  const title = isBaseline
    ? t('fuzzer.detail.baselineTitle')
    : t('fuzzer.detail.index', { index })

  return (
    <aside
      data-testid="fuzzer-detail"
      data-index={String(index)}
      aria-label={t('fuzzer.detail.title')}
      className="flex min-h-0 w-full shrink-0 flex-col border-t border-border bg-background lg:w-[46%] lg:min-w-[320px] lg:max-w-[680px] lg:border-l lg:border-t-0"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12px] font-medium text-foreground">{t('fuzzer.detail.title')}</span>
        <span className="truncate text-[10px] text-muted-foreground">{title}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="fuzzer-detail-close"
          aria-label={t('fuzzer.detail.closeAria')}
          onClick={onClose}
          className="ml-auto h-6 w-6 shrink-0"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex items-center gap-1 border-b border-border bg-muted/40 px-3 py-1">
        <span className="mr-auto text-[9.5px] text-muted-foreground">{t('fuzzer.detail.viewAria')}</span>
        <button
          type="button"
          data-testid="fuzzer-view-raw"
          disabled={response === null}
          onClick={() => setView('raw')}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            view === 'raw'
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t('fuzzer.detail.viewRaw')}
        </button>
        <button
          type="button"
          data-testid="fuzzer-view-json"
          disabled={formattedJson === null}
          onClick={() => setView('json')}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            view === 'json'
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t('fuzzer.detail.viewJson')}
        </button>
        <button
          type="button"
          data-testid="fuzzer-view-html"
          disabled={!htmlResponse}
          onClick={() => setView('html')}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            view === 'html'
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t('fuzzer.detail.viewHtml')}
        </button>
      </div>

      {loading ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : error !== null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <p role="alert" className="text-[11px] leading-relaxed text-red-700">
            {error}
          </p>
          <Button variant="outline" size="xs" onClick={() => setAttempt((value) => value + 1)} className="gap-1.5">
            {t('fuzzer.action.retry')}
          </Button>
        </div>
      ) : detail === null ? (
        <p className="flex flex-1 items-center justify-center p-4 text-[11px] text-muted-foreground">
          {t('fuzzer.error.detailMissing')}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {isBaseline ? (
            <p className="mb-2 rounded-md border border-border bg-sidebar/60 px-2 py-1 text-[10px] text-muted-foreground">
              {t('fuzzer.result.baselineHint')}
            </p>
          ) : (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">{t('fuzzer.detail.payloads')}</span>
              <span className="rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                {detail.payloadBrief === '' ? '-' : detail.payloadBrief}
              </span>
              {(detail.payloads ?? []).map((payload, payloadIndex) => (
                <span
                  key={`${payloadIndex}-${payload}`}
                  className="max-w-[180px] truncate rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground"
                  title={payload}
                >
                  {payload === '' ? '∅' : payload}
                </span>
              ))}
            </div>
          )}

          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[10.5px] font-medium text-foreground">{t('fuzzer.detail.request')}</span>
            <span className="font-mono text-[9.5px] text-muted-foreground">
              {detail.request.method} · {utf8ByteLength(detail.request.body)} B
            </span>
          </div>
          <pre
            data-testid="fuzzer-detail-request"
            className="whitespace-pre-wrap break-words rounded-md border border-border bg-[hsl(var(--code))] px-3 py-2 font-mono text-[10.5px] leading-relaxed text-[hsl(220_14%_92%)]"
          >
            {serializeRawRequest(detail.request)}
          </pre>

          <div className="mb-1 mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] font-medium text-foreground">{t('fuzzer.detail.response')}</span>
            {response !== null ? (
              <>
                <span
                  className={cn(
                    'rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums',
                    statusTone(response.status)
                  )}
                >
                  {response.status} {response.statusText ?? ''}
                </span>
                <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">
                  {response.durationMs} ms ·{' '}
                  {t('fuzzer.detail.bytes', {
                    count:
                      typeof response.bodyBytes === 'number'
                        ? response.bodyBytes
                        : utf8ByteLength(body)
                  })}
                </span>
                {response.truncated ? (
                  <span className="text-[9.5px] text-amber-700">{t('fuzzer.result.truncated')}</span>
                ) : null}
              </>
            ) : (
              <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">
                {t('fuzzer.detail.emptyResponse')}
              </span>
            )}
          </div>

          {response === null ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] leading-relaxed text-red-700">
              <p>{detail.error ?? t('fuzzer.detail.emptyResponse')}</p>
              {detail.errorCode !== null ? (
                <p className="mt-1 font-mono text-[9.5px] text-red-600">
                  {t('fuzzer.detail.errorCode', { code: detail.errorCode })}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <p className="mb-1 text-[10px] text-muted-foreground">{t('fuzzer.detail.responseHeaders')}</p>
              <pre className="mb-2 whitespace-pre-wrap break-words rounded-md border border-border bg-sidebar px-2.5 py-2 font-mono text-[10px] leading-relaxed text-foreground">
                {Object.entries(headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join('\n')}
              </pre>
              {view === 'html' && htmlResponse ? (
                <iframe
                  title={t('fuzzer.detail.htmlPreview')}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={htmlPreview}
                  className="h-[min(60vh,520px)] min-h-[280px] w-full rounded-md border border-border bg-white"
                />
              ) : view === 'json' && formattedJson !== null ? (
                <pre
                  data-testid="fuzzer-detail-json"
                  className="whitespace-pre-wrap break-words rounded-md border border-border bg-[hsl(var(--code))] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[hsl(220_14%_92%)]"
                >
                  {formattedJson}
                </pre>
              ) : (
                <pre
                  data-testid="fuzzer-detail-body"
                  className="whitespace-pre-wrap break-words rounded-md border border-border bg-[hsl(var(--code))] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[hsl(220_14%_92%)]"
                >
                  {body === '' ? t('fuzzer.detail.noBody') : body.slice(0, 200_000)}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  )
}
