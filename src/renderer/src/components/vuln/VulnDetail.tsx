import { lazy, startTransition, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Download, KeyRound, Loader2, RefreshCw, ScrollText, ShieldCheck, Trash2 } from 'lucide-react'
import type { Vulnerability, VulnStatus } from '@shared/types'
import { VULN_STATUSES } from '@shared/types'
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetTitle
} from '@renderer/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { SeverityBadge, StatusBadge } from '@renderer/components/common/Badges'
import { CopyButton } from '@renderer/components/common/CopyButton'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { MarkdownText } from '@renderer/components/common/MarkdownText'
import { VulnSummary } from './VulnSummary'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import { getPrefetchedVulnerability } from '@renderer/lib/vulnPreload'
import { formatDateTime, formatVulnType } from '@renderer/lib/format'
import { useI18n } from '@renderer/i18n'

/**
 * The syntax highlighter and Markdown evidence renderer is a large module, so it
 * is loaded only when a detail sheet reaches the reproduction tab; the sheet
 * chrome paints first so opening and closing feel immediate.
 */
const ReproductionMarkdown = lazy(() =>
  import('./ReproductionMarkdown').then((module) => ({ default: module.ReproductionMarkdown }))
)

interface VulnDetailProps {
  vulnId: string | null
  dataVersion: number
  onClose: () => void
  onChanged: () => void
  onOpenRelated: (id: string) => void
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-14 shrink-0 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-foreground/70">
        {label}
      </dt>
      <dd className="flex min-w-0 items-center gap-1.5 font-mono text-[12.5px] text-foreground">
        {children}
      </dd>
    </div>
  )
}

const CHINESE_ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** Internal marker for a record the API no longer returns; never rendered as-is. */
const NOT_FOUND = '__cortex_vuln_missing__'

function SheetSkeleton() {
  const remediationWidths = ['76%', '62%', '70%', '54%']
  return (
    <div aria-hidden="true" className="px-6 py-5">
      <div className="flex gap-1.5">
        <Skeleton className="h-[22px] w-[62px] rounded-full" />
        <Skeleton className="h-[22px] w-[74px] rounded-full" />
        <Skeleton className="h-[22px] w-[58px] rounded-full" />
      </div>
      <Skeleton className="mt-4 h-6 w-[72%]" />
      <Skeleton className="mt-2 h-6 w-[45%]" />
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3 w-[46%]" />
        <Skeleton className="h-3 w-[52%]" />
        <Skeleton className="h-3 w-[64%]" />
      </div>
      <div className="mt-5 space-y-2">
        <Skeleton className="h-3 w-[84%]" />
        <Skeleton className="h-3 w-[68%]" />
      </div>
      <div className="mt-5 flex gap-6 border-t border-border pt-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="mt-4 space-y-3">
        {remediationWidths.map((width) => (
          <div key={width} className="flex items-center gap-3">
            <Skeleton className="h-5 w-5 rounded-full" />
            <Skeleton className="h-3" style={{ width }} />
          </div>
        ))}
      </div>
    </div>
  )
}

function MarkdownSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-3 py-1">
      <Skeleton className="h-4 w-[45%]" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-[88%]" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-4 w-[35%]" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

/**
 * Right-hand inspector for a single vulnerability: a floating inset panel, a
 * bottom status control with optimistic updates, destructive delete behind a
 * confirmation dialog, and silent re-fetch of data pushed over MCP without
 * closing the sheet.
 */
export function VulnDetail({
  vulnId,
  dataVersion,
  onClose,
  onChanged,
  onOpenRelated
}: VulnDetailProps) {
  const [detail, setDetail] = useState<Vulnerability | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [statusPending, setStatusPending] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [activeTab, setActiveTab] = useState('steps')

  const { t, lang, statusLabel } = useI18n()

  const retestLabel = (index: number): string => {
    const ordinal =
      lang === 'zh' ? (CHINESE_ORDINALS[index] ?? String(index + 1)) : String(index + 1)
    return t('vuln.retest.label', { index: ordinal })
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const open = vulnId !== null

  useEffect(() => {
    if (!vulnId) return
    const api = getApi()
    if (!api) {
      setError(apiUnavailableMessage(t))
      setLoading(false)
      return
    }

    let alive = true
    setLoading(true)
    setError(null)

    const prefetched = getPrefetchedVulnerability(vulnId)
    if (prefetched) setDetail(prefetched)

    api.getVulnerability(vulnId).then(
      (next) => {
        if (!alive) return
        if (next === null) {
          setDetail(null)
          setError(NOT_FOUND)
        } else {
          startTransition(() => {
            setDetail(next)
            setError(null)
          })
        }
      },
      (cause: unknown) => {
        if (alive) setError(toErrorMessage(cause, t))
      }
    ).finally(() => {
      if (alive) setLoading(false)
    })

    return () => {
      alive = false
    }
  }, [vulnId, dataVersion, retryKey])

  useEffect(() => {
    setActiveTab('steps')
    setConfirmOpen(false)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [vulnId])

  const handleStatusChange = async (value: VulnStatus) => {
    if (!detail || loading) return
    const next = value
    const previous = detail.status
    if (next === previous) return

    setDetail({ ...detail, status: next })
    setStatusPending(true)

    const api = getApi()
    if (!api) {
      setDetail({ ...detail, status: previous })
      setStatusPending(false)
      toast.error(apiUnavailableMessage(t))
      return
    }

    try {
      const updated = await api.updateVulnerabilityStatus({ id: detail.id, status: next })
      setDetail(updated)
      toast.success(t('vuln.toast.statusUpdated', { status: statusLabel(next) }))
      onChanged()
    } catch (cause) {
      setDetail({ ...detail, status: previous })
      toast.error(t('vuln.toast.statusUpdateFailed', { error: toErrorMessage(cause, t) }))
    } finally {
      setStatusPending(false)
    }
  }

  const handleDelete = async () => {
    if (!detail || loading) return
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }
    setDeleting(true)
    try {
      const result = await api.deleteVulnerability(detail.id)
      setConfirmOpen(false)
      if (result.deleted) {
        toast.success(t('vuln.toast.deleted', { id: detail.id }))
      } else {
        toast.error(t('vuln.record.missing'))
      }
      onChanged()
      onClose()
    } catch (cause) {
      toast.error(t('vuln.toast.deleteFailed', { error: toErrorMessage(cause, t) }))
    } finally {
      setDeleting(false)
    }
  }

  const handleExport = async () => {
    if (!detail || loading) return
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }
    setExporting(true)
    try {
      const result = await api.exportVulnerabilities([detail.id])
      if (!result.cancelled) toast.success(t('vuln.toast.exported'))
    } catch (cause) {
      toast.error(t('vuln.toast.exportFailed', { error: toErrorMessage(cause, t) }))
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
      >
        <SheetContent data-testid="vuln-sheet">
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {t('vuln.detail.eyebrow')}
            </span>
            <div className="flex items-center gap-1">
              {detail ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="export-vuln-md"
                  onClick={() => void handleExport()}
                  disabled={loading || exporting}
                  className="h-7 gap-1.5 px-2 text-[11px]"
                >
                  {exporting ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {exporting ? t('vuln.detail.exporting') : t('vuln.detail.export')}
                </Button>
              ) : null}
              <SheetCloseButton />
            </div>
          </div>

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          >
            {detail === null && error === null ? (
              <>
                <SheetTitle className="sr-only">{t('vuln.detail.title')}</SheetTitle>
                <SheetDescription className="sr-only">
                  {t('vuln.detail.loadingDescription')}
                </SheetDescription>
                <SheetSkeleton />
              </>
            ) : detail === null ? (
              <>
                <SheetTitle className="sr-only">{t('vuln.detail.title')}</SheetTitle>
                <SheetDescription className="sr-only">
                  {t('vuln.detail.loadFailedDescription')}
                </SheetDescription>
                <EmptyState
                  icon={AlertTriangle}
                  title={
                    error === NOT_FOUND
                      ? t('vuln.detail.notFoundTitle')
                      : t('vuln.detail.loadFailedTitle')
                  }
                  description={
                    error === NOT_FOUND
                      ? t('vuln.record.missing')
                      : (error ?? t('common.unknownError'))
                  }
                  className="py-24"
                >
                  {error === NOT_FOUND ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRetryKey((value) => value + 1)}
                    >
                      {t('common.retry')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    {t('common.close')}
                  </Button>
                </EmptyState>
              </>
            ) : (
              <>
                <header className="px-6 pb-4 pt-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SeverityBadge severity={detail.severity} />
                    <span className="inline-flex h-[22px] items-center rounded-full border border-border bg-background px-2 font-mono text-[11px] uppercase tracking-[0.08em] text-foreground/70">
                      {formatVulnType(detail.vuln_type, t)}
                    </span>
                    <StatusBadge status={detail.status} />
                    <span
                      className="ml-auto font-mono text-[12.5px] tabular-nums text-foreground/70"
                      title={t('vuln.table.discoveredAt')}
                    >
                      {formatDateTime(detail.created_at)}
                    </span>
                  </div>

                  <SheetTitle className="mt-2.5 pr-2 text-[20px] leading-snug">
                    {detail.vuln_name}
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    {t('vuln.detail.description', { id: detail.id })}
                  </SheetDescription>

                  <dl className="mt-3 space-y-1">
                    <MetaRow label="ID">
                      <span className="truncate">{detail.id}</span>
                      <CopyButton
                        value={detail.id}
                        label={t('vuln.copy.vulnId')}
                        toastMessage={t('vuln.copy.vulnIdDone')}
                      />
                    </MetaRow>
                    <MetaRow label="Host">
                      <span className="truncate">{detail.host}</span>
                      <CopyButton
                        value={detail.host}
                        label={t('vuln.copy.host')}
                        toastMessage={t('vuln.copy.hostDone')}
                      />
                    </MetaRow>
                    <MetaRow label="Target">
                      <span className="truncate" title={detail.target_url}>
                        {detail.target_url}
                      </span>
                      <CopyButton
                        testId="copy-target"
                        value={detail.target_url}
                        label={t('vuln.copy.targetUrl')}
                        toastMessage={t('vuln.copy.targetUrlDone')}
                      />
                    </MetaRow>
                  </dl>
                </header>

                <div className="border-t border-border px-6 py-4">
                  <VulnSummary vuln={detail} onOpenRelated={onOpenRelated} />
                </div>

                <Tabs
                  value={activeTab}
                  onValueChange={setActiveTab}
                  className="border-t border-border"
                >
                  <div className="sticky top-0 z-10 border-b border-border bg-background px-6">
                    <TabsList>
                      <TabsTrigger value="steps" data-testid="tab-steps">
                        {t('vuln.tab.steps')}
                      </TabsTrigger>
                      <TabsTrigger value="remediation" data-testid="tab-remediation">
                        {t('vuln.tab.remediation')}
                      </TabsTrigger>
                      <TabsTrigger value="boundaries" data-testid="tab-boundaries">
                        {t('vuln.tab.boundaries')}
                      </TabsTrigger>
                      <TabsTrigger value="retests" data-testid="tab-retests">
                        {t('vuln.tab.retests')}
                        {detail.retest_results.length > 0 ? (
                          <span className="ml-1 font-mono text-[12px] tabular-nums text-foreground/60">
                            {detail.retest_results.length}
                          </span>
                        ) : null}
                      </TabsTrigger>
                      <TabsTrigger value="crypto" data-testid="tab-crypto">
                        {t('vuln.tab.crypto')}
                      </TabsTrigger>
                    </TabsList>
                  </div>

                  <div className="px-6 pb-8 pt-4">
                    <TabsContent value="steps">
                      {detail.reproduction_steps.trim().length > 0 ? (
                        <Suspense fallback={<MarkdownSkeleton />}>
                          <ReproductionMarkdown markdown={detail.reproduction_steps} />
                        </Suspense>
                      ) : (
                        <EmptyState
                          icon={ScrollText}
                          title={t('vuln.empty.stepsTitle')}
                          description={t('vuln.empty.stepsDescription')}
                          className="py-12"
                        />
                      )}
                    </TabsContent>

                    <TabsContent value="remediation">
                      {detail.remediation.length > 0 ? (
                        <ul className="list-disc space-y-2.5 pl-5 marker:text-muted-foreground">
                          {detail.remediation.map((item, index) => (
                            <li
                              key={`${detail.id}-remediation-${index}`}
                              className="break-words pl-1 text-foreground"
                            >
                              <MarkdownText content={item} compact />
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <EmptyState
                          icon={ShieldCheck}
                          title={t('vuln.empty.remediationTitle')}
                          description={t('vuln.empty.remediationDescription')}
                          className="py-12"
                        />
                      )}
                    </TabsContent>

                    <TabsContent value="boundaries">
                      {detail.test_boundaries.trim().length > 0 ? (
                        <MarkdownText content={detail.test_boundaries} />
                      ) : (
                        <EmptyState
                          icon={ShieldCheck}
                          title={t('vuln.empty.boundariesTitle')}
                          description={t('vuln.empty.boundariesDescription')}
                          className="py-12"
                        />
                      )}
                    </TabsContent>

                    <TabsContent value="retests">
                      {detail.retest_results.length === 0 ? (
                        <EmptyState
                          icon={RefreshCw}
                          title={t('vuln.empty.retestsTitle')}
                          description={t('vuln.empty.retestsDescription')}
                          className="py-12"
                        />
                      ) : (
                        <div className="space-y-4">
                          {detail.retest_results.map((retest, index) => (
                            <article
                              key={`${detail.id}-retest-${index}`}
                              className="rounded-md border border-border bg-background px-4 py-3.5"
                            >
                              <h3 className="text-[12.5px] font-medium text-foreground">
                                {retestLabel(index)}
                              </h3>
                              <p className="mt-1 break-words font-mono text-[12px] tabular-nums text-foreground/70">
                                {retest.time_range}
                              </p>
                              <div className="mt-2 pl-[2em]">
                                <Suspense fallback={<MarkdownSkeleton />}>
                                  <ReproductionMarkdown markdown={retest.conclusion} />
                                </Suspense>
                              </div>
                            </article>
                          ))}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="crypto">
                      {detail.crypto_details.trim().length > 0 ? (
                        <div className="rounded-md border border-border bg-sidebar px-4 py-3">
                          <MarkdownText content={detail.crypto_details} />
                        </div>
                      ) : (
                        <EmptyState
                          icon={KeyRound}
                          title={t('vuln.empty.cryptoTitle')}
                          description={t('vuln.empty.cryptoDescription')}
                          className="py-12"
                        />
                      )}
                    </TabsContent>
                  </div>
                </Tabs>
              </>
            )}
          </div>

          {detail ? (
            <SheetFooter>
              <div className="flex items-center gap-2.5">
                <label htmlFor="vuln-status" className="text-[11px] text-muted-foreground">
                  {t('common.status')}
                </label>
                <Select
                  value={detail.status}
                  onValueChange={(value) => void handleStatusChange(value as VulnStatus)}
                  disabled={statusPending || loading}
                >
                  <SelectTrigger
                    id="vuln-status"
                    data-testid="vuln-status"
                    aria-label={t('vuln.detail.statusAria')}
                    className="h-8 w-[136px] text-[12px]"
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
                {statusPending ? (
                  <Loader2
                    aria-hidden="true"
                    className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                  />
                ) : null}
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={loading || deleting}
                className="gap-1.5 text-destructive hover:bg-red-50 hover:text-red-700 focus-visible:bg-red-50 focus-visible:text-red-700"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                {t('common.delete')}
              </Button>
            </SheetFooter>
          ) : null}
        </SheetContent>
      </Sheet>

      {detail ? (
        <ConfirmDeleteDialog
          open={confirmOpen}
          vulnId={detail.id}
          pending={deleting}
          onOpenChange={setConfirmOpen}
          onConfirm={() => void handleDelete()}
        />
      ) : null}
    </>
  )
}
