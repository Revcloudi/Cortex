import { useEffect, useMemo, useState } from 'react'
import { Braces, Loader2, Play } from 'lucide-react'
import type { Vulnerability } from '@shared/types'
import type { RepeaterSendInput, RepeaterSendResult } from '@shared/repeater'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'
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
import { ResponseView } from './ResponseView'

interface YakitSendPanelProps {
  /**
   * Optional finding. The Web Fuzzer never needs one: when injected, the finding
   * is used only to seed the raw editor and to resolve relative request URLs.
   */
  vuln?: Vulnerability | null
  /** Kept for the routed page contract; the standalone sender never blocks on it. */
  loading?: boolean
}

const SUPPORTED_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS'
])

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
 * Resolve the editor target to an absolute http(s) URL. Standalone mode has no
 * finding target, so relative URLs are rejected with a clear error; an injected
 * finding still resolves them against its target_url.
 */
function resolveAbsoluteUrl(rawUrl: string, vuln: Vulnerability | null): string | null {
  const value = rawUrl.trim()
  if (value === '') return null
  const candidate = /^https?:\/\//i.test(value)
    ? value
    : vuln === null
      ? ''
      : resolveRepeaterUrl(value, vuln.target_url)
  if (candidate === '') return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.hostname === '') return null
    return parsed.href
  } catch {
    return null
  }
}

/**
 * Yakit-style manual HTTP sender: the request editor fills the left half with
 * the send button at its top-left, the shared response viewer fills the right
 * half, and both panes use the full available height. The raw request editor is
 * the only input, no finding is required, and the send payload never carries a
 * vulnId: the Host validates the target independently.
 */
export function YakitSendPanel({ vuln = null }: YakitSendPanelProps) {
  const { t } = useI18n()
  const [raw, setRaw] = useState('')
  const [sending, setSending] = useState(false)
  const [followRedirects, setFollowRedirects] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RepeaterSendResult | null>(null)

  // A finding is never required. When one is injected it only seeds the editor;
  // manual edits survive re-renders because this runs on finding changes only.
  useEffect(() => {
    if (vuln === null) return
    const requests = extractRepeaterRequests(vuln)
    const step = defaultRequestIndex(vuln, requests)
    const initial = requests[step]?.raw ?? ''
    setRaw(formatRequestBody(initial) ?? initial)
    setResult(null)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vuln?.id])

  /** Parsed editor content; null when empty or unparseable (send is disabled). */
  const parsedRequest = useMemo(() => {
    if (raw.trim() === '') return null
    try {
      return parseRawRequest(raw)
    } catch {
      return null
    }
  }, [raw])

  const rawBytes = useMemo(() => new TextEncoder().encode(raw).byteLength, [raw])

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

  const send = async (forceFollowRedirect = false): Promise<void> => {
    if (sending || parsedRequest === null) return
    const api = getApi()
    if (!api) {
      setError(t('common.apiUnavailable'))
      return
    }
    const url = resolveAbsoluteUrl(parsedRequest.url, vuln)
    if (url === null) {
      setError(t('fuzzer.request.urlRequired'))
      return
    }
    if (!SUPPORTED_METHODS.has(parsedRequest.method)) {
      setError(t('fuzzer.request.methodUnsupported', { method: parsedRequest.method }))
      return
    }
    setSending(true)
    setError(null)
    try {
      const response = await api.sendRepeaterRequest({
        method: parsedRequest.method as RepeaterSendInput['method'],
        url,
        headers: stripDerivedHeaders(parsedRequest.headers),
        ...(parsedRequest.body === '' ? {} : { body: parsedRequest.body }),
        followRedirects: forceFollowRedirect || followRedirects
      })
      setResult(response)
    } catch (cause) {
      setError(describeSendError(cause, t('retest.repeater.connectionFailed')))
      setResult(null)
    } finally {
      setSending(false)
    }
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
            disabled={sending || parsedRequest === null}
            className="shrink-0 gap-1.5"
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
          <Button
            variant="outline"
            size="xs"
            data-testid="fuzzer-format-request"
            title={t('retest.repeater.formatRequestTitle')}
            onClick={formatRequest}
            disabled={raw.trim() === ''}
            className="shrink-0 gap-1"
          >
            <Braces aria-hidden="true" className="h-3 w-3" />
            {t('retest.repeater.formatRequest')}
          </Button>
          <span className="ml-auto shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground">
            {t('retest.repeater.bytes', { count: rawBytes })}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-3">
          <textarea
            data-testid="fuzzer-request"
            aria-label={t('retest.repeater.requestAria')}
            value={raw}
            spellCheck={false}
            placeholder={t('fuzzer.request.placeholder')}
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
          ) : parsedRequest === null && raw.trim() !== '' ? (
            <p
              role="status"
              data-testid="fuzzer-request-invalid"
              className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-amber-800"
            >
              {t('fuzzer.request.invalidHint')}
            </p>
          ) : null}
        </div>
      </section>

      {/* ------------------------------------------------------------ response */}
      <ResponseView
        response={result === null ? null : result.response}
        baseUrl={result === null ? '' : result.request.url}
        testIdPrefix="fuzzer"
        paneTestId="fuzzer-response-pane"
        ariaLabel={t('fuzzer.response.aria')}
        onFollowRedirect={() => void send(true)}
        followRedirectDisabled={sending}
      />
    </div>
  )
}
