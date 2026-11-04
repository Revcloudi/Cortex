import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import type {
  CredentialSuggestion,
  CredentialTrialStatus,
  InternalGraphData
} from '@shared/types'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { formatDateTimeFull } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { InternalPanel } from './InternalPanel'
import {
  CONFIDENCE_DOTS,
  CONFIDENCE_STYLES,
  INTERNAL_TD,
  INTERNAL_TH,
  sortServicesByEndpoint,
  TRIAL_STATUS_STYLES
} from './internalUi'

export interface CredentialTrialInput {
  credentialId: string
  serviceId: string
  action: string
  status: CredentialTrialStatus
}

interface CredentialMatrixProps {
  graph: InternalGraphData | null
  loading: boolean
  error: string | null
  onRetry: () => void
  /** Persists one trial; the page owns toasts + refresh. Rejects on failure. */
  onRecordTrial: (input: CredentialTrialInput) => Promise<void>
}

const ROW_PAGE_SIZE = 8
const DEFAULT_COLUMN_LIMIT = 24
const COLUMN_STEP = 24

function MatrixSkeleton() {
  const { t } = useI18n()
  return (
    <div className="space-y-2 px-4 py-3" aria-hidden="true">
      <Skeleton className="h-8 w-full" />
      {[0, 1, 2, 3, 4].map((index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
      <span role="status" className="sr-only">
        {t('internal.matrix.loading')}
      </span>
    </div>
  )
}

/**
 * Credential × service matrix (§8.2). Rows are credentials rendered with the
 * masked `secret_preview` only (the raw secret never reaches the renderer), the
 * columns are internal services sorted by host IP / port, and each non-empty
 * cell is a deterministic suggestion carrying rule / caveat / confidence.
 *
 * Clicking a suggestion opens the inline detail strip where a trial outcome can
 * be recorded — the matrix never connects or authenticates by itself.
 */
export function CredentialMatrix({
  graph,
  loading,
  error,
  onRetry,
  onRecordTrial
}: CredentialMatrixProps) {
  const { t } = useI18n()
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string | null>(null)
  const [recording, setRecording] = useState<CredentialTrialStatus | null>(null)
  const [credentialPage, setCredentialPage] = useState(1)
  const [columnLimit, setColumnLimit] = useState(DEFAULT_COLUMN_LIMIT)

  const credentials = graph?.credentials ?? []
  const services = useMemo(
    () => sortServicesByEndpoint(graph?.services ?? []),
    [graph?.services]
  )
  const suggestionMap = useMemo(() => {
    const map = new Map<string, CredentialSuggestion>()
    for (const suggestion of graph?.suggestions ?? []) map.set(suggestion.id, suggestion)
    return map
  }, [graph?.suggestions])

  const totalPages = Math.max(1, Math.ceil(credentials.length / ROW_PAGE_SIZE))
  const currentPage = Math.min(credentialPage, totalPages)
  const visibleCredentials = credentials.slice(
    (currentPage - 1) * ROW_PAGE_SIZE,
    currentPage * ROW_PAGE_SIZE
  )
  const visibleServices = services.slice(0, columnLimit)
  const selected =
    selectedSuggestionId === null ? null : (suggestionMap.get(selectedSuggestionId) ?? null)

  useEffect(() => {
    setCredentialPage((previous) => (previous > totalPages ? totalPages : previous))
  }, [totalPages])

  // Reset transient selection/limits when the page switches project.
  useEffect(() => {
    setSelectedSuggestionId(null)
    setCredentialPage(1)
    setColumnLimit(DEFAULT_COLUMN_LIMIT)
  }, [graph?.project_name])

  const recordTrial = async (status: CredentialTrialStatus): Promise<void> => {
    if (selected === null || recording !== null) return
    setRecording(status)
    try {
      await onRecordTrial({
        credentialId: selected.credential_id,
        serviceId: selected.service_id,
        action: selected.action,
        status
      })
    } finally {
      setRecording(null)
    }
  }

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="internal-matrix-refresh"
        aria-label={t('common.refresh')}
        title={t('common.refresh')}
        onClick={onRetry}
      >
        <RefreshCw strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
    </div>
  )

  return (
    <InternalPanel
      testId="internal-matrix"
      title={t('internal.matrix.title')}
      count={credentials.length > 0 ? credentials.length : undefined}
      actions={actions}
    >
      {graph === null && loading ? (
        <MatrixSkeleton />
      ) : graph === null ? (
        <EmptyState
          icon={AlertTriangle}
          title={t('internal.matrix.empty.title')}
          description={error ?? undefined}
        >
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </EmptyState>
      ) : credentials.length === 0 || services.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={t('internal.matrix.empty.title')}
          description={t('internal.matrix.empty.description')}
        />
      ) : (
        <>
          {error !== null ? (
            <div className="flex items-center justify-between gap-3 border-b border-red-200/70 bg-red-50 px-4 py-1.5 text-[11.5px] text-red-700">
              <span className="flex min-w-0 items-center gap-2">
                <AlertTriangle strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{error}</span>
              </span>
              <button
                type="button"
                onClick={onRetry}
                className="shrink-0 underline underline-offset-2 hover:text-red-800"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-left">
              <caption className="sr-only">{t('internal.matrix.title')}</caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className={cn(INTERNAL_TH, 'sticky left-0 z-20 w-[232px] min-w-[232px]')}
                  >
                    {t('internal.matrix.columns.credential')}
                  </th>
                  {visibleServices.map((service) => {
                    const serviceLabel = service.service.trim()
                    return (
                      <th
                        key={service.id}
                        scope="col"
                        data-testid="internal-matrix-column"
                        data-service-id={service.id}
                        title={
                          serviceLabel.length > 0
                            ? t('internal.matrix.columnTitle', {
                                ip: service.host_ip,
                                port: service.port,
                                service: serviceLabel
                              })
                            : t('internal.matrix.columnTitleNoService', {
                                ip: service.host_ip,
                                port: service.port
                              })
                        }
                        className={cn(INTERNAL_TH, 'w-[104px] min-w-[104px] text-center')}
                      >
                        <span className="block font-mono text-[10px] tabular-nums text-foreground/80">
                          {service.host_ip}:{service.port}
                        </span>
                        <span className="block truncate text-[9.5px] font-normal text-muted-foreground">
                          {serviceLabel.length > 0 ? serviceLabel : service.protocol || '—'}
                        </span>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {visibleCredentials.map((credential) => {
                  const identity =
                    credential.username.trim().length > 0
                      ? credential.username
                      : t('internal.matrix.noUsername')
                  const domainSuffix =
                    credential.domain.trim().length > 0 ? `@${credential.domain}` : ''
                  const rowName = `${identity}${domainSuffix}`
                  return (
                    <tr
                      key={credential.id}
                      data-testid="internal-matrix-row"
                      data-credential-id={credential.id}
                    >
                      <th
                        scope="row"
                        className={cn(
                          INTERNAL_TD,
                          'sticky left-0 z-10 w-[232px] min-w-[232px] bg-background text-left font-normal'
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-border bg-background px-1.5 font-mono text-[9.5px] text-muted-foreground">
                            {t(`internal.credType.${credential.type}`)}
                          </span>
                          <span
                            className="truncate font-mono text-[11px] text-foreground"
                            title={rowName}
                          >
                            {rowName}
                          </span>
                          <span
                            aria-hidden="true"
                            title={t('internal.confidenceLabel', {
                              level: t(`internal.confidence.${credential.confidence}`)
                            })}
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              CONFIDENCE_DOTS[credential.confidence]
                            )}
                          />
                        </span>
                        <span className="mt-1 flex items-center gap-1.5">
                          <code
                            className="truncate font-mono text-[10.5px] text-muted-foreground"
                            title={t('internal.matrix.maskedSecret')}
                          >
                            {credential.secret_preview || '—'}
                          </code>
                          <span className="shrink-0 text-[9.5px] tabular-nums text-muted-foreground/70">
                            {t('internal.matrix.secretLength', {
                              length: credential.secret_length
                            })}
                          </span>
                          <span
                            className={cn(
                              'ml-auto shrink-0 rounded-full border px-1.5 text-[9.5px] font-medium',
                              credential.status === 'valid'
                                ? 'border-emerald-200/70 bg-emerald-50 text-emerald-700'
                                : credential.status === 'invalid'
                                  ? 'border-red-200/70 bg-red-50 text-red-700'
                                  : 'border-border bg-background text-muted-foreground'
                            )}
                          >
                            {t(`internal.credStatus.${credential.status}`)}
                          </span>
                        </span>
                      </th>
                      {visibleServices.map((service) => {
                        const suggestion = suggestionMap.get(`${credential.id}::${service.id}`)
                        if (suggestion === undefined) {
                          return (
                            <td
                              key={service.id}
                              className={cn(INTERNAL_TD, 'text-center text-muted-foreground/40')}
                              title={t('internal.matrix.cellEmpty')}
                            >
                              ·
                            </td>
                          )
                        }
                        const active = selectedSuggestionId === suggestion.id
                        return (
                          <td key={service.id} className={cn(INTERNAL_TD, 'text-center')}>
                            <button
                              type="button"
                              data-testid="internal-matrix-cell"
                              data-suggestion-id={suggestion.id}
                              data-rule={suggestion.rule}
                              data-confidence={suggestion.confidence}
                              data-trial={suggestion.trial?.status ?? 'none'}
                              aria-label={t('internal.matrix.cellAria', {
                                credential: rowName,
                                service: `${service.host_ip}:${service.port}`,
                                action: t(`internal.action.${suggestion.action}`)
                              })}
                              title={`${t(`internal.rule.${suggestion.rule}.reason`)} — ${t(
                                `internal.rule.${suggestion.rule}.caveat`
                              )}`}
                              onClick={() =>
                                setSelectedSuggestionId((previous) =>
                                  previous === suggestion.id ? null : suggestion.id
                                )
                              }
                              className={cn(
                                'inline-flex w-full items-center justify-center gap-1 rounded-[5px] border px-1 py-0.5 text-[10px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                                active
                                  ? 'border-accent bg-accent-soft font-medium text-accent'
                                  : 'border-border bg-background text-foreground/80 hover:bg-muted'
                              )}
                            >
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'h-1.5 w-1.5 shrink-0 rounded-full',
                                  CONFIDENCE_DOTS[suggestion.confidence]
                                )}
                              />
                              <span className="truncate">
                                {suggestion.trial !== null
                                  ? t(`internal.trialStatus.${suggestion.trial.status}`)
                                  : t(`internal.action.${suggestion.action}`)}
                              </span>
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {selected !== null ? (
            <div
              data-testid="internal-matrix-detail"
              className="border-t border-border bg-sidebar/70 px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-2 text-[11px] font-medium text-foreground">
                    {t('internal.matrix.detailTitle')}
                    <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {selected.ip}:{selected.port} · {selected.service || selected.protocol || '—'}
                    </span>
                  </p>
                  <dl className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="text-[10px] font-medium text-foreground/60">
                        {t('internal.matrix.rule')}
                      </dt>
                      <dd className="text-[11.5px] text-foreground">
                        {t(`internal.rule.${selected.rule}`)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[10px] font-medium text-foreground/60">
                        {t('internal.matrix.action')}
                      </dt>
                      <dd className="text-[11.5px] text-foreground">
                        {t(`internal.action.${selected.action}`)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[10px] font-medium text-foreground/60">
                        {t('internal.matrix.confidence')}
                      </dt>
                      <dd>
                        <span
                          className={cn(
                            'inline-flex h-[20px] items-center gap-1 rounded-full border px-1.5 text-[10.5px] font-medium',
                            CONFIDENCE_STYLES[selected.confidence]
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              CONFIDENCE_DOTS[selected.confidence]
                            )}
                          />
                          {t(`internal.confidence.${selected.confidence}`)}
                        </span>
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[10px] font-medium text-foreground/60">
                        {t('internal.matrix.trial')}
                      </dt>
                      <dd className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        {selected.trial !== null ? (
                          <>
                            <span
                              className={cn(
                                'inline-flex h-[20px] items-center rounded-full border px-1.5 text-[10.5px] font-medium',
                                TRIAL_STATUS_STYLES[selected.trial.status]
                              )}
                            >
                              {t(`internal.trialStatus.${selected.trial.status}`)}
                            </span>
                            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                              {t('internal.matrix.trialAt', {
                                time: formatDateTimeFull(selected.trial.attempted_at)
                              })}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">
                            {t('internal.matrix.trialNone')}
                          </span>
                        )}
                      </dd>
                    </div>
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-[10px] font-medium text-foreground/60">
                        {t('internal.matrix.reason')}
                      </dt>
                      <dd className="text-[11.5px] leading-relaxed text-foreground/85">
                        {t(`internal.rule.${selected.rule}.reason`)}
                      </dd>
                    </div>
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-[10px] font-medium text-foreground/60">
                        {t('internal.matrix.caveat')}
                      </dt>
                      <dd className="text-[11.5px] leading-relaxed text-muted-foreground">
                        {t(`internal.rule.${selected.rule}.caveat`)}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="internal-matrix-record-attempted"
                    disabled={recording !== null}
                    onClick={() => void recordTrial('attempted')}
                    className="gap-1.5"
                  >
                    {recording === 'attempted' ? (
                      <Loader2 strokeWidth={1.75} aria-hidden="true" className="h-3 w-3 animate-spin" />
                    ) : null}
                    {recording === 'attempted'
                      ? t('internal.matrix.recording')
                      : t('internal.matrix.recordAttempted')}
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="internal-matrix-record-success"
                    disabled={recording !== null}
                    onClick={() => void recordTrial('success')}
                    className="gap-1.5"
                  >
                    {recording === 'success' ? (
                      <Loader2 strokeWidth={1.75} aria-hidden="true" className="h-3 w-3 animate-spin" />
                    ) : null}
                    {t('internal.matrix.recordSuccess')}
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="internal-matrix-record-failed"
                    disabled={recording !== null}
                    onClick={() => void recordTrial('failed')}
                    className="gap-1.5"
                  >
                    {recording === 'failed' ? (
                      <Loader2 strokeWidth={1.75} aria-hidden="true" className="h-3 w-3 animate-spin" />
                    ) : null}
                    {t('internal.matrix.recordFailed')}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-4 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
              {visibleServices.length < services.length ? (
                <>
                  <span data-testid="internal-matrix-truncated">
                    {t('internal.matrix.truncatedColumns', {
                      shown: visibleServices.length,
                      total: services.length
                    })}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    data-testid="internal-matrix-more-columns"
                    onClick={() => setColumnLimit((previous) => previous + COLUMN_STEP)}
                    className="gap-1 text-[11px]"
                  >
                    {t('internal.matrix.showMoreColumns')}
                  </Button>
                </>
              ) : (graph?.suggestions.length ?? 0) === 0 ? (
                <span>{t('internal.matrix.noSuggestions')}</span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                {t('internal.matrix.pageSummary', {
                  page: currentPage,
                  totalPages,
                  total: credentials.length
                })}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="internal-matrix-prev"
                aria-label={t('internal.matrix.prevPage')}
                title={t('internal.matrix.prevPage')}
                disabled={currentPage <= 1}
                onClick={() => setCredentialPage((previous) => Math.max(1, previous - 1))}
              >
                <ChevronLeft strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="internal-matrix-next"
                aria-label={t('internal.matrix.nextPage')}
                title={t('internal.matrix.nextPage')}
                disabled={currentPage >= totalPages}
                onClick={() =>
                  setCredentialPage((previous) => Math.min(totalPages, previous + 1))
                }
              >
                <ChevronRight strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </>
      )}
    </InternalPanel>
  )
}
