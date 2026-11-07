import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CornerDownRight, Loader2, Play } from 'lucide-react'
import type { Vulnerability } from '@shared/types'
import type { RepeaterSendResult } from '@shared/repeater'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'
import {
  defaultRequestIndex,
  extractRepeaterRequests,
  resolveRepeaterUrl
} from '@renderer/lib/retestRequest'
import { prettyJsonBody } from '@renderer/lib/retestResponse'

interface RepeaterPanelProps {
  vuln: Vulnerability | null
  loading: boolean
}

interface ParsedRawRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * Protocol-level headers copied from a report are re-derived by the outbound
 * request (Host from the URL, length/connection by the HTTP client). Dropping
 * them here keeps raw requests sendable without a validation error.
 */
const DERIVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'proxy-connection'
])

/** Parse a Burp-like raw request into the typed repeater payload. */
function parseRawRequest(text: string): ParsedRawRequest {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const requestLine = (lines.shift() ?? '').trim()
  const match = /^([A-Za-z]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/.exec(requestLine)
  if (match === null) throw new Error('请求行必须形如：GET /path HTTP/1.1')
  const headers: Record<string, string> = {}
  let index = 0
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) break
    if (line.trim() === '') {
      index += 1
      break
    }
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error(`请求头不合法：${line}`)
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name !== '') headers[name] = value
  }
  const body = lines.slice(index).join('\n')
  return { method: match[1].toUpperCase(), url: match[2], headers, body }
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

function headerValue(headers: Record<string, string>, name: string): string {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  return entry?.[1] ?? ''
}

function isRedirectResponse(result: RepeaterSendResult): boolean {
  const status = result.response.status
  return status >= 300 && status < 400 && headerValue(result.response.headers, 'location') !== ''
}

function isHtmlResponse(result: RepeaterSendResult): boolean {
  const contentType = headerValue(result.response.headers, 'content-type')
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) return true
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(result.response.body.slice(0, 300))
}

/** Rendered HTML needs a base URL so relative CSS/images resolve against the target. */
function buildHtmlPreview(body: string, targetUrl: string): string {
  let base = ''
  try {
    base = `${new URL(targetUrl).origin}/`
  } catch {
    base = ''
  }
  if (base === '') return body
  const tag = `<base href="${base.replace(/"/g, '&quot;')}">`
  if (/<head(?:\s[^>]*)?>/i.test(body)) {
    return body.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${tag}`)
  }
  return `${tag}${body}`
}

function statusTone(status: number): string {
  if (status >= 500) return 'border-red-300 bg-red-50 text-red-800'
  if (status >= 400) return 'border-amber-300 bg-amber-50 text-amber-900'
  if (status >= 300) return 'border-sky-300 bg-sky-50 text-sky-900'
  return 'border-emerald-300 bg-emerald-50 text-emerald-900'
}

/**
 * Manual HTTP repeater. Requests are extracted from the finding's Markdown
 * report (all HTTP request steps are selectable) instead of the old generated-JS
 * pipeline. The user edits the raw request and sends it through the retest proxy.
 */
export function RepeaterPanel({ vuln, loading }: RepeaterPanelProps) {
  const { t } = useI18n()
  const [raw, setRaw] = useState('')
  const [step, setStep] = useState(0)
  const [sending, setSending] = useState(false)
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
  const responseIsRedirect = result !== null && isRedirectResponse(result)
  const responseIsHtml = result !== null && isHtmlResponse(result)
  const formattedJson = useMemo(
    () =>
      result === null
        ? null
        : prettyJsonBody(result.response.body, headerValue(result.response.headers, 'content-type')),
    [result]
  )
  const htmlPreview = useMemo(
    () => (result === null || vuln === null ? '' : buildHtmlPreview(result.response.body, vuln.target_url)),
    [result, vuln]
  )

  const send = async (followRedirects = false): Promise<void> => {
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
      const headers = Object.fromEntries(
        Object.entries(parsed.headers).filter(([name]) => !DERIVED_HEADERS.has(name.toLowerCase()))
      )
      const response = await api.sendRepeaterRequest({
        vulnId: vuln.id,
        method: parsed.method,
        url: resolveRepeaterUrl(parsed.url, vuln.target_url),
        headers,
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
      <div className="flex h-full flex-col gap-3">
        <Skeleton className="h-[310px] w-full" />
        <Skeleton className="h-[220px] w-full" />
      </div>
    )
  }

  if (vuln === null) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-background/60 text-[12px] text-muted-foreground">
        {t('retest.repeater.empty')}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="rounded-lg border border-border bg-background">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-[12px] font-medium text-foreground">{t('retest.repeater.title')}</span>
          <span className="rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
            {vuln.id}
          </span>
          {requests.length > 0 ? (
            <div className="ml-auto flex max-w-full items-center gap-1 overflow-x-auto" role="tablist" aria-label={t('retest.repeater.stepsAria')}>
              {requests.map((request, index) => (
                <button
                  key={`${index}-${request.label}`}
                  type="button"
                  role="tab"
                  aria-selected={index === step}
                  title={request.label}
                  data-testid={`retest-repeater-step-${index}`}
                  onClick={() => selectStep(index)}
                  className={`h-6 shrink-0 rounded border px-2 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    index === step
                      ? 'border-accent/50 bg-accent-soft font-medium text-accent'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {t('retest.repeater.stepN', { n: index + 1 })}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="p-3">
          <textarea
            data-testid="retest-repeater-request"
            aria-label={t('retest.repeater.requestAria')}
            value={raw}
            spellCheck={false}
            onChange={(event) => setRaw(event.target.value)}
            className="min-h-[210px] w-full resize-y rounded-lg border border-border bg-[hsl(var(--code))] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-[hsl(220_14%_92%)] caret-[hsl(174_77%_45%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="retest-repeater-send"
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

            <span className="ml-auto font-mono text-[9.5px] tabular-nums text-muted-foreground">
              {t('retest.repeater.bytes', { count: rawBytes })}
            </span>
          </div>
          {error !== null ? (
            <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-red-700">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-background">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[12px] font-medium text-foreground">{t('retest.repeater.responseTitle')}</span>
          {result !== null ? (
            <>
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${statusTone(result.response.status)}`}>
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
                  data-testid="retest-repeater-follow"
                  onClick={() => void send(true)}
                  disabled={sending}
                  className="gap-1 text-[10.5px]"
                >
                  <CornerDownRight aria-hidden="true" className="h-3 w-3" />
                  {t('retest.repeater.followRedirect')}
                </Button>
              ) : null}
              {formattedJson !== null || responseIsHtml ? (
                <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
                  <button
                    type="button"
                    data-testid="retest-repeater-view-raw"
                    onClick={() => setBodyView('raw')}
                    className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                      bodyView === 'raw'
                        ? 'bg-background font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('retest.repeater.viewRaw')}
                  </button>
                  {formattedJson !== null ? (
                    <button
                      type="button"
                      data-testid="retest-repeater-view-json"
                      onClick={() => setBodyView('pretty')}
                      className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                        bodyView === 'pretty'
                          ? 'bg-background font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {t('retest.repeater.formatJson')}
                    </button>
                  ) : null}
                  {responseIsHtml ? (
                    <button
                      type="button"
                      data-testid="retest-repeater-view-html"
                      onClick={() => setBodyView('html')}
                      className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                        bodyView === 'html'
                          ? 'bg-background font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
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
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <pre className="mb-2 whitespace-pre-wrap break-words rounded-md border border-border bg-sidebar px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-foreground">
              {Object.entries(result.response.headers)
                .map(([name, value]) => `${name}: ${value}`)
                .join('\n')}
            </pre>
            {responseIsHtml && bodyView === 'html' ? (
              <iframe
                title={t('retest.repeater.htmlPreview')}
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={htmlPreview}
                className="h-[min(60vh,520px)] min-h-[320px] w-full rounded-md border border-border bg-white"
              />
            ) : formattedJson !== null && bodyView === 'pretty' ? (
              <pre
                data-testid="retest-repeater-json"
                className="whitespace-pre-wrap break-words rounded-md border border-border bg-[hsl(var(--code))] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[hsl(220_14%_92%)]"
              >
                {formattedJson}
              </pre>
            ) : (
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-[hsl(var(--code))] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[hsl(220_14%_92%)]">
                {result.response.body.slice(0, 200_000)}
              </pre>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
