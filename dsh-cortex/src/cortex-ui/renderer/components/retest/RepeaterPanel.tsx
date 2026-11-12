import { useEffect, useMemo, useState } from 'react'
import {
  Braces,
  Clock,
  FileInput,
  FileOutput,
  Loader2,
  Play,
  Star
} from 'lucide-react'
import { toast } from 'sonner'
import type { Vulnerability } from '@shared/types'
import type { RepeaterSendResult } from '@shared/repeater'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useCopy } from '@renderer/hooks/useCopy'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'
import { buildCurlCommand } from '@renderer/lib/curl'
import {
  formatRequestBody,
  parseRawRequest,
  stripDerivedHeaders
} from '@renderer/lib/repeaterRaw'
import {
  defaultRequestIndex,
  extractRepeaterRequests,
  resolveRepeaterUrl
} from '@renderer/lib/retestRequest'
import { CurlImportDialog } from './CurlImportDialog'
import { ResponseView } from './ResponseView'
import { RepeaterCollectionsDialog } from './RepeaterCollectionsDialog'
import { RepeaterHistoryDialog } from './RepeaterHistoryDialog'

interface RepeaterPanelProps {
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

/** Saved history/collection rows share the raw + request + response shape. */
interface SavedRepeaterEntry {
  raw: string
  request: RepeaterSendResult['request']
  response: RepeaterSendResult['response'] | null
}

/**
 * Manual HTTP repeater. Requests are extracted from the finding's Markdown
 * report (all HTTP request steps are selectable) instead of the old generated-JS
 * pipeline. The user edits the raw request and sends it through the retest proxy
 * with the finding vulnId (history/favorites are finding-scoped here).
 *
 * The Yakit-style standalone sender lives on its own Web Fuzzer page; this panel
 * stays the per-finding single-request repeater (plus history, favorites and
 * curl tools) and shares the raw/JSON/render response viewer with it.
 */
export function RepeaterPanel({ vuln, loading }: RepeaterPanelProps) {
  const { t } = useI18n()

  const header = (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <span className="text-[12px] font-medium text-foreground">{t('retest.repeater.title')}</span>
      {vuln !== null ? (
        <span className="rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
          {vuln.id}
        </span>
      ) : null}
    </div>
  )

  if (vuln === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {header}
        {loading ? (
          <>
            <Skeleton className="h-[310px] w-full" />
            <Skeleton className="h-[220px] w-full" />
          </>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-background/60 text-[12px] text-muted-foreground">
            {t('retest.repeater.empty')}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {header}
      <SingleRepeater vuln={vuln} />
    </div>
  )
}

interface SingleRepeaterProps {
  vuln: Vulnerability
}

/**
 * The original single Repeater. Behavior is intentionally unchanged: same
 * request extraction/default step, retest-proxy send with the finding vulnId,
 * redirect follow, shared raw/JSON/render views and byte counter. The toolbar
 * keeps read-only helpers (history, favorites, curl import/export) that never
 * change how a send works.
 */
function SingleRepeater({ vuln }: SingleRepeaterProps) {
  const { t } = useI18n()
  const { copy } = useCopy()
  const [raw, setRaw] = useState('')
  const [step, setStep] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RepeaterSendResult | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  const [curlImportOpen, setCurlImportOpen] = useState(false)

  const requests = useMemo(() => extractRepeaterRequests(vuln), [vuln])

  useEffect(() => {
    setResult(null)
    setError(null)
    const nextStep = defaultRequestIndex(vuln, requests)
    setStep(nextStep)
    const initial = requests[nextStep]?.raw ?? ''
    setRaw(formatRequestBody(initial) ?? initial)
    // Reset only when the selected vulnerability changes; user edits must survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vuln.id])

  const selectStep = (nextStep: number): void => {
    const next = requests[nextStep]
    if (next === undefined) return
    setStep(nextStep)
    setRaw(formatRequestBody(next.raw) ?? next.raw)
    setResult(null)
    setError(null)
  }

  /** Pretty-print the JSON request body while keeping the request line/headers. */
  const formatRequest = (): void => {
    const formatted = formatRequestBody(raw)
    if (formatted === null) {
      setError(t('retest.repeater.formatRequestFailed'))
      return
    }
    setRaw(formatted)
    setError(null)
  }

  const rawBytes = useMemo(() => new TextEncoder().encode(raw).byteLength, [raw])

  /** Parsed request used by the favorites dialog (null while the editor is invalid). */
  const currentRequest = useMemo<RepeaterSendResult['request'] | null>(() => {
    try {
      const parsed = parseRawRequest(raw)
      return {
        method: parsed.method,
        url: resolveRepeaterUrl(parsed.url, vuln.target_url),
        headers: stripDerivedHeaders(parsed.headers),
        body: parsed.body
      }
    } catch {
      return null
    }
  }, [raw, vuln.target_url])

  const restoreSaved = (item: SavedRepeaterEntry): void => {
    setRaw(item.raw)
    setError(null)
    setResult(
      item.response === null ? null : { request: item.request, response: item.response }
    )
  }

  const send = async (followRedirects = false): Promise<void> => {
    if (sending) return
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
    } catch (cause) {
      setError(describeSendError(cause, t('retest.repeater.connectionFailed')))
      setResult(null)
    } finally {
      setSending(false)
    }
  }

  const exportCurl = async (): Promise<void> => {
    let command: string
    try {
      const parsed = parseRawRequest(raw)
      command = buildCurlCommand({
        method: parsed.method,
        url: resolveRepeaterUrl(parsed.url, vuln.target_url),
        headers: stripDerivedHeaders(parsed.headers),
        body: parsed.body
      })
    } catch {
      toast.error(t('retest.repeater.curl.parseFailed'))
      return
    }
    // The toast only says "copied"; the command (cookies included) is never shown.
    await copy(command, t('retest.repeater.curl.exported'))
  }

  const applyCurl = (nextRaw: string): void => {
    setRaw(nextRaw)
    setResult(null)
    setError(null)
  }

  return (
    <>
      <section className="rounded-lg border border-border bg-background">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-[12px] font-medium text-foreground">
            {t('retest.repeater.requestSection')}
          </span>
          {requests.length > 0 ? (
            <div
              className="ml-auto flex max-w-full items-center gap-1 overflow-x-auto"
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
            className="min-h-[210px] w-full resize-y rounded-lg border border-border bg-white px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground caret-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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

            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                data-testid="retest-repeater-format"
                title={t('retest.repeater.formatRequestTitle')}
                onClick={formatRequest}
                className="gap-1 text-[10.5px]"
              >
                <Braces aria-hidden="true" className="h-3 w-3" />
                {t('retest.repeater.formatRequest')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                data-testid="repeater-history-open"
                onClick={() => setHistoryOpen(true)}
                className="gap-1 text-[10.5px]"
              >
                <Clock aria-hidden="true" className="h-3 w-3" />
                {t('retest.repeater.history.open')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                data-testid="repeater-collections-open"
                onClick={() => setCollectionsOpen(true)}
                className="gap-1 text-[10.5px]"
              >
                <Star aria-hidden="true" className="h-3 w-3" />
                {t('retest.repeater.favorites.open')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                data-testid="repeater-curl-import"
                onClick={() => setCurlImportOpen(true)}
                className="gap-1 text-[10.5px]"
              >
                <FileInput aria-hidden="true" className="h-3 w-3" />
                {t('retest.repeater.curl.import')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                data-testid="repeater-curl-export"
                disabled={raw.trim() === ''}
                onClick={() => void exportCurl()}
                className="gap-1 text-[10.5px]"
              >
                <FileOutput aria-hidden="true" className="h-3 w-3" />
                {t('retest.repeater.curl.export')}
              </Button>
            </div>

            <span className="ml-auto font-mono text-[9.5px] tabular-nums text-muted-foreground">
              {t('retest.repeater.bytes', { count: rawBytes })}
            </span>
          </div>
          {error !== null ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-red-700"
            >
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <ResponseView
        response={result === null ? null : result.response}
        baseUrl={result === null ? vuln.target_url : result.request.url}
        testIdPrefix="retest-repeater"
        rawBodyTestId="retest-repeater-response"
        jsonBodyTestId="retest-repeater-json"
        followTestId="retest-repeater-follow"
        onFollowRedirect={() => void send(true)}
        followRedirectDisabled={sending}
      />

      <RepeaterHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestore={restoreSaved}
      />
      <RepeaterCollectionsDialog
        open={collectionsOpen}
        vulnId={vuln.id}
        raw={raw}
        request={currentRequest}
        response={result === null ? null : result.response}
        onOpenChange={setCollectionsOpen}
        onLoad={restoreSaved}
      />
      <CurlImportDialog
        open={curlImportOpen}
        onOpenChange={setCurlImportOpen}
        onApply={applyCurl}
      />
    </>
  )
}
