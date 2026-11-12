import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CornerDownRight } from 'lucide-react'
import type { RepeaterSendResult } from '@shared/repeater'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'
import {
  buildSafeHtmlPreview,
  headerValue,
  isBinaryResponse,
  isHtmlResponse,
  isRedirectResponse,
  prettyJsonBody,
  responseHead,
  statusTone
} from '@renderer/lib/retestResponse'
import { cn } from '@renderer/lib/utils'

type ResponseMode = 'raw' | 'json' | 'render'
type RepeaterResponse = RepeaterSendResult['response']

interface ResponseViewProps {
  /** Captured response; null shows the empty hint and no tabs. */
  response: RepeaterResponse | null
  /** Absolute request URL; relative HTML assets resolve against its origin. */
  baseUrl?: string
  /** Shared data-testid prefix, e.g. `fuzzer` or `retest-repeater`. */
  testIdPrefix: string
  /** Keeps the pre-existing raw-body id of each caller. */
  rawBodyTestId?: string
  /** Keeps the pre-existing JSON-body id of each caller. */
  jsonBodyTestId?: string
  /** Keeps the pre-existing follow-redirect button id of each caller. */
  followTestId?: string
  /** data-testid for the wrapping section. */
  paneTestId?: string
  /** Overrides the section aria-label (the fuzzer keeps its own key). */
  ariaLabel?: string
  /** Rendered when the response redirects; omitted means no follow control. */
  onFollowRedirect?: () => void
  followRedirectDisabled?: boolean
  className?: string
}

const BODY_PREVIEW_LIMIT = 200_000

interface ViewTabProps {
  testId: string
  active: boolean
  disabled?: boolean
  label: string
  onSelect: () => void
}

function ViewTab({ testId, active, disabled = false, label, onSelect }: ViewTabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-background font-medium text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground'
      )}
    >
      {label}
    </button>
  )
}

/**
 * Shared response viewer for the standalone Web Fuzzer and the single-request
 * Repeater. It owns the status chip, the timing/byte counters, the redirect
 * follow button and the 原始 / JSON / 渲染 tabs:
 *
 * - 原始: status line + headers + raw body in one monospace block.
 * - JSON: the same status/header block with a pretty-printed JSON body; JSON is
 *   the default view when the body parses, raw otherwise; the tab is disabled
 *   when the body is not JSON.
 * - 渲染: always keeps the status line + headers visible, then renders HTML in a
 *   `sandbox=""` iframe with a hardened CSP srcDoc, non-HTML text in a `<pre>`,
 *   and binary payloads as a non-renderable notice.
 */
export function ResponseView({
  response,
  baseUrl,
  testIdPrefix,
  rawBodyTestId,
  jsonBodyTestId,
  followTestId,
  paneTestId,
  ariaLabel,
  onFollowRedirect,
  followRedirectDisabled = false,
  className
}: ResponseViewProps) {
  const { t } = useI18n()
  const [mode, setMode] = useState<ResponseMode>('raw')
  const prefix = testIdPrefix

  const contentType = response === null ? '' : headerValue(response.headers, 'content-type')
  const jsonBody = useMemo(
    () => (response === null ? null : prettyJsonBody(response.body, contentType)),
    [response, contentType]
  )
  const head = useMemo(
    () => (response === null ? '' : responseHead(response.status, response.headers)),
    [response]
  )
  const rawText = useMemo(
    () => (response === null ? '' : `${head}\n\n${response.body}`.slice(0, BODY_PREVIEW_LIMIT)),
    [response, head]
  )
  const jsonText = useMemo(
    () => (jsonBody === null ? '' : `${head}\n\n${jsonBody}`.slice(0, BODY_PREVIEW_LIMIT)),
    [jsonBody, head]
  )
  const responseIsHtml = response !== null && isHtmlResponse(response.body, response.headers)
  const htmlPreview = useMemo(
    () =>
      response !== null && responseIsHtml
        ? buildSafeHtmlPreview(response.body.slice(0, BODY_PREVIEW_LIMIT), baseUrl ?? '')
        : '',
    [response, responseIsHtml, baseUrl]
  )
  const binary =
    response !== null && !responseIsHtml && isBinaryResponse(response.body, response.headers)
  const renderText = response === null ? '' : response.body.slice(0, BODY_PREVIEW_LIMIT)
  const redirect =
    response !== null && isRedirectResponse(response.status, response.headers)

  // Default view: JSON when the body parses as JSON, raw otherwise. Runs when a
  // new response arrives so a restored/sent response never opens in a stale tab.
  useEffect(() => {
    if (response === null) {
      setMode('raw')
      return
    }
    setMode(
      prettyJsonBody(response.body, headerValue(response.headers, 'content-type')) !== null
        ? 'json'
        : 'raw'
    )
  }, [response])

  return (
    <section
      data-testid={paneTestId}
      aria-label={ariaLabel ?? t('retest.repeater.responseTitle')}
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background',
        className
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-3">
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[12px] font-medium text-foreground">
          {t('retest.repeater.responseTitle')}
        </span>
        {response !== null ? (
          <>
            <span
              data-testid={`${prefix}-response-status`}
              className={cn(
                'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums',
                statusTone(response.status)
              )}
            >
              {response.status}
            </span>
            <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground">
              {response.durationMs} ms · {response.body.length} B
            </span>
            {response.truncated ? (
              <span className="shrink-0 text-[9.5px] text-amber-700">
                {t('retest.repeater.truncated')}
              </span>
            ) : null}
            {redirect && onFollowRedirect !== undefined ? (
              <Button
                variant="outline"
                size="xs"
                data-testid={followTestId ?? `${prefix}-follow`}
                onClick={onFollowRedirect}
                disabled={followRedirectDisabled}
                className="shrink-0 gap-1 text-[10.5px]"
              >
                <CornerDownRight aria-hidden="true" className="h-3 w-3" />
                {t('retest.repeater.followRedirect')}
              </Button>
            ) : null}
            <div
              role="tablist"
              aria-label={t('retest.repeater.viewAria')}
              className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
            >
              <ViewTab
                testId={`${prefix}-view-raw`}
                active={mode === 'raw'}
                label={t('retest.repeater.viewRaw')}
                onSelect={() => setMode('raw')}
              />
              <ViewTab
                testId={`${prefix}-view-json`}
                active={mode === 'json'}
                disabled={jsonBody === null}
                label={t('retest.repeater.viewJson')}
                onSelect={() => setMode('json')}
              />
              <ViewTab
                testId={`${prefix}-view-render`}
                active={mode === 'render'}
                label={t('retest.repeater.viewRender')}
                onSelect={() => setMode('render')}
              />
            </div>
          </>
        ) : null}
      </div>

      {response === null ? (
        <p className="flex flex-1 items-center justify-center px-3 text-[11.5px] text-muted-foreground">
          {t('retest.repeater.emptyResponse')}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-3">
          {mode === 'json' && jsonBody !== null ? (
            <pre
              data-testid={jsonBodyTestId ?? `${prefix}-response-json`}
              className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-white px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground"
            >
              {jsonText}
            </pre>
          ) : mode === 'render' ? (
            <div
              data-testid={`${prefix}-response-render`}
              className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-white"
            >
              <pre
                data-testid={`${prefix}-response-render-head`}
                className="max-h-44 shrink-0 overflow-auto whitespace-pre-wrap break-words border-b border-border bg-sidebar px-3 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground"
              >
                {head}
              </pre>
              {htmlPreview !== '' ? (
                <iframe
                  title={t('retest.repeater.htmlPreview')}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={htmlPreview}
                  className="min-h-0 w-full flex-1 border-0 bg-white"
                />
              ) : binary ? (
                <div
                  role="status"
                  data-testid={`${prefix}-response-binary`}
                  className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center"
                >
                  <p className="text-[11.5px] text-muted-foreground">
                    {t('retest.repeater.renderBinary')}
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground/80">
                    {t('retest.repeater.renderBinaryType', {
                      type: contentType === '' ? '—' : contentType
                    })}
                  </p>
                </div>
              ) : (
                <pre
                  data-testid={`${prefix}-response-text`}
                  className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-white px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground"
                >
                  {renderText === '' ? t('retest.repeater.renderEmptyBody') : renderText}
                </pre>
              )}
            </div>
          ) : (
            <pre
              data-testid={rawBodyTestId ?? `${prefix}-response-body`}
              className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-white px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground"
            >
              {rawText}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}
