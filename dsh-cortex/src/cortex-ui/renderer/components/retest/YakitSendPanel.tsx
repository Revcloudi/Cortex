import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CornerDownRight, Loader2, Play } from 'lucide-react'
import type { Vulnerability } from '@shared/types'
import type { RepeaterSendResult } from '@shared/repeater'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'
import { parseRawRequest, stripDerivedHeaders } from '@renderer/lib/repeaterRaw'
import {
  defaultRequestIndex,
  extractRepeaterRequests,
  resolveRepeaterUrl
} from '@renderer/lib/retestRequest'
import {
  buildHtmlPreview,
  headerValue,
  isHtmlResponse,
  isRedirectResponse,
  prettyJsonBody,
  statusTone
} from '@renderer/lib/retestResponse'
import { cn } from '@renderer/lib/utils'

interface YakitSendPanelProps {
  vuln: Vulnerability | null
  loading: boolean
}

function describeSendError(cause: unknown, connectionRefused: string): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(cleaned)) return connectionRefused
  return cleaned === '' ? connectionRefused : cleaned
}

/**
 * Yakit-style manual HTTP sender: the request editor fills the left half with
 * the send button at its top-left, the response viewer fills the right half, and
 * both panes use the full available height. This is the plain Web Fuzzer module
 * (no payload markers, attack modes, batch jobs or result table); every request
 * still goes through the retest proxy and the finding origin allowlist.
 */
export function YakitSendPanel({ vuln, loading }: YakitSendPanelProps) {
  const { t } = useI18n()
  const [raw, setRaw] = useState('')
  const [step, setStep] = useState(0)
  const [sending, setSending] = useState(false)
  const [followRedirects, setFollowRedirects] = useState(false)
  const [bodyView, setBodyView] = useState<'raw' | 'pretty' | 'html'>('raw')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RepeaterSendResult | null>(null)

  const requests = useMemo(() => (vuln === null ? [] : extractRepeaterRequests(vuln)), [vuln])

  useEffect(() => {
    setResult(null)
    setError(null)
    if (vuln === null) {
      setRaw('')
      setStep(0)
      return
    }
    const nextStep = defaultRequestIndex(vuln, requests)
    setStep(nextStep)
    setRaw(requests[nextStep]?.raw ?? '')
    // Reset only when the selected vulnerability changes; user edits must survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vuln?.id])

  const selectStep = (nextStep: number): void => {
    const next = requests[nextStep]
    if (next === undefined) return
    setStep(nextStep)
    setRaw(next.raw)
    setResult(null)
    setError(null)
  }

  const rawBytes = useMemo(() => new TextEncoder().encode(raw).byteLength, [raw])
  const responseIsRedirect =
    result !== null && isRedirectResponse(result.response.status, result.response.headers)
  const responseIsHtml =
    result !== null && isHtmlResponse(result.response.body, result.response.headers)
  const formattedJson = useMemo(
    () =>
      result === null
        ? null
        : prettyJsonBody(result.response.body, headerValue(result.response.headers, 'content-type')),
    [result]
  )
  const htmlPreview = useMemo(
    () =>
      result === null || vuln === null
        ? ''
        : buildHtmlPreview(result.response.body, vuln.target_url),
    [result, vuln]
  )
  /** Raw response as one block: status line + headers + blank line + body. */
  const rawResponse = useMemo(() => {
    if (result === null) return ''
    const lines = [`HTTP/1.1 ${result.response.status}`]
    for (const [name, value] of Object.entries(result.response.headers)) {
      lines.push(`${name}: ${value}`)
    }
    lines.push('', result.response.body)
    return lines.join('\n')
  }, [result])

  const send = async (): Promise<void> => {
    if (vuln === null || sending) return
    const api = getApi()
    if (!api) {
      setError(t('common.apiUnavailable'))
      return
    }
    setSending(true)
    setError(null)
    try {
      const parsed = parseRawRequest(raw)
      const response = await api.sendRepeaterRequest({
        vulnId: vuln.id,
        method: parsed.method,
        url: resolveRepeaterUrl(parsed.url, vuln.target_url),
        headers: stripDerivedHeaders(parsed.headers),
        ...(parsed.body === '' ? {} : { body: parsed.body }),
        followRedirects
      })
      setResult(response)
      setBodyView('raw')
    } catch (cause) {
      setError(describeSendError(cause, t('retest.repeater.connectionFailed')))
      setResult(null)
    } finally {
      setSending(false)
    }
  }

  if (loading && vuln === null) {
    return (
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        <Skeleton className="h-full min-h-[360px] w-full" />
        <Skeleton className="h-full min-h-[360px] w-full" />
      </div>
    )
  }

  if (vuln === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-background/60 text-[12px] text-muted-foreground">
        {t('retest.repeater.empty')}
      </div>
    )
  }

  return (
    <div
      data-testid="fuzzer-panel"
      className="grid min-h-0 flex-1 items-stretch gap-3 lg:grid-cols-2"
    >
      {/* ------------------------------------------------------------- request */}
      <section
        data-testid="fuzzer-request-pane"
        aria-label={t('fuzzer.request.paneAria')}
        className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            size="sm"
            data-testid="fuzzer-send"
            onClick={() => void send()}
            disabled={sending || raw.trim() === ''}
            className="gap-1.5"
          >
            {sending ? (
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin poc-spinner" />
            ) : (
              <Play aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {sending ? t('retest.repeater.sending') : t('retest.repeater.send')}
          </Button>
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <Checkbox
              data-testid="fuzzer-follow-redirects"
              checked={followRedirects}
              onChange={(event) => setFollowRedirects(event.target.checked)}
            />
            {t('retest.repeater.followRedirects')}
          </label>
          <span className="shrink-0 rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
            {vuln.id}
          </span>
          {requests.length > 0 ? (
            <div
              className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto"
              role="tablist"
              aria-label={t('retest.repeater.stepsAria')}
            >
              {requests.map((request, index) => (
                <button
                  key={`${index}-${request.label}`}
                  type="button"
                  role="tab"
                  aria-selected={index === step}
                  title={request.label}
                  data-testid={`fuzzer-request-step-${index}`}
                  onClick={() => selectStep(index)}
                  className={cn(
                    'h-6 shrink-0 rounded border px-2 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    index === step
                      ? 'border-accent/50 bg-accent-soft font-medium text-accent'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {t('retest.repeater.stepN', { n: index + 1 })}
                </button>
              ))}
            </div>
          ) : null}
          <span className={cn('shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground', requests.length === 0 && 'ml-auto')}>
            {t('retest.repeater.bytes', { count: rawBytes })}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-3">
          <textarea
            data-testid="fuzzer-request"
            aria-label={t('retest.repeater.requestAria')}
            value={raw}
            spellCheck={false}
            onChange={(event) => setRaw(event.target.value)}
            className="min-h-0 w-full flex-1 resize-none rounded-lg border border-border bg-white px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground caret-accent placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          {error !== null ? (
            <p
              role="alert"
              data-testid="fuzzer-send-error"
              className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-red-700"
            >
              {error}
            </p>
          ) : null}
        </div>
      </section>

      {/* ------------------------------------------------------------ response */}
      <section
        data-testid="fuzzer-response-pane"
        aria-label={t('fuzzer.response.aria')}
        className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-[12px] font-medium text-foreground">{t('retest.repeater.responseTitle')}</span>
          {result !== null ? (
            <>
              <span
                data-testid="fuzzer-response-status"
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${statusTone(result.response.status)}`}
              >
                {result.response.status}
              </span>
              <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">
                {result.response.durationMs} ms · {result.response.body.length} B
              </span>
              {result.response.truncated ? (
                <span className="text-[9.5px] text-amber-700">{t('retest.repeater.truncated')}</span>
              ) : null}
              {responseIsRedirect ? (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => void send()}
                  disabled={sending}
                  className="gap-1 text-[10.5px]"
                >
                  <CornerDownRight aria-hidden="true" className="h-3 w-3" />
                  {t('retest.repeater.followRedirect')}
                </Button>
              ) : null}
              {formattedJson !== null || responseIsHtml ? (
                <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
                  <button
                    type="button"
                    data-testid="fuzzer-view-raw"
                    onClick={() => setBodyView('raw')}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                      bodyView === 'raw'
                        ? 'bg-background font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t('retest.repeater.viewRaw')}
                  </button>
                  {formattedJson !== null ? (
                    <button
                      type="button"
                      data-testid="fuzzer-view-json"
                      onClick={() => setBodyView('pretty')}
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                        bodyView === 'pretty'
                          ? 'bg-background font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t('retest.repeater.formatJson')}
                    </button>
                  ) : null}
                  {responseIsHtml ? (
                    <button
                      type="button"
                      data-testid="fuzzer-view-html"
                      onClick={() => setBodyView('html')}
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                        bodyView === 'html'
                          ? 'bg-background font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t('retest.repeater.viewHtml')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {result === null ? (
          <p className="flex flex-1 items-center justify-center px-3 text-[11.5px] text-muted-foreground">
            {t('retest.repeater.emptyResponse')}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
            {responseIsHtml && bodyView === 'html' ? (
              <iframe
                title={t('retest.repeater.htmlPreview')}
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={htmlPreview}
                className="min-h-0 w-full flex-1 rounded-md border border-border bg-white"
              />
            ) : formattedJson !== null && bodyView === 'pretty' ? (
              <pre
                data-testid="fuzzer-response-json"
                className="whitespace-pre-wrap break-words rounded-md border border-border bg-white px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground"
              >
                {formattedJson}
              </pre>
            ) : (
              <pre
                data-testid="fuzzer-response-body"
                className="whitespace-pre-wrap break-words rounded-md border border-border bg-white px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground"
              >
                {rawResponse.slice(0, 200_000)}
              </pre>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
