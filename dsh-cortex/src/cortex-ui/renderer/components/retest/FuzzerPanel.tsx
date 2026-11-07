import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  Eraser,
  FileJson,
  Highlighter,
  History,
  Loader2,
  Play,
  RefreshCcw,
  Square,
  TriangleAlert
} from 'lucide-react'
import { toast } from 'sonner'
import type { Vulnerability } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { getPortalContainer } from '../../../dsh/portal'
import {
  cancelFuzzJob,
  createFuzzJob,
  exportFuzzJob,
  fuzzerErrorMessage,
  getFuzzJob,
  listFuzzJobs,
  type FuzzCreateInput,
  type FuzzHistoryItem,
  type FuzzJob,
  type FuzzResultSummary
} from '@renderer/lib/fuzzerApi'
import {
  FUZZ_MODES,
  MAX_FUZZ_CASES,
  MAX_FUZZ_CONCURRENCY,
  MAX_FUZZ_DELAY_MS,
  MAX_FUZZ_POSITIONS,
  MAX_PAYLOAD_BYTES,
  MAX_TEMPLATE_BODY_BYTES,
  MAX_TEMPLATE_HEADERS,
  MAX_TEMPLATE_URL_LENGTH,
  clampInt,
  clearMarkers,
  expectedCaseCount,
  formatJobTime,
  fuzzTargetOrigin,
  markSelection,
  parsePayloadLines,
  payloadBytes,
  resolveFuzzUrl,
  scanMarkers,
  usedPayloadSetCount,
  usedPayloadSets,
  utf8ByteLength,
  type FuzzJobStatus,
  type FuzzMode,
  type ExpectedCasesError
} from '@renderer/lib/fuzz'
import { parseRawRequest, stripDerivedHeaders } from '@renderer/lib/repeaterRaw'
import { defaultRequestIndex, extractRepeaterRequests } from '@renderer/lib/retestRequest'
import { cn } from '@renderer/lib/utils'
import { FuzzResultDetail } from './FuzzResultDetail'
import { FuzzResultsTable } from './FuzzResultsTable'
import { PayloadSetEditor } from './PayloadSetEditor'

interface FuzzerPanelProps {
  vuln: Vulnerability | null
  loading: boolean
}

interface ValidationIssue {
  key: string
  params?: Record<string, string | number>
}

interface PreparedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

type PrepareStartResult =
  | { ok: true; request: PreparedRequest; payloadSets: string[][]; origin: string }
  | { ok: false; issue: ValidationIssue }

const JOB_STATUS_TONE: Record<FuzzJobStatus, string> = {
  running: 'border-sky-300 bg-sky-50 text-sky-900',
  completed: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  cancelled: 'border-border bg-sidebar text-muted-foreground',
  interrupted: 'border-amber-300 bg-amber-50 text-amber-900',
  failed: 'border-red-300 bg-red-50 text-red-800'
}

const STOPPED_REASON_KEYS: Record<string, string> = {
  time_limit: 'fuzzer.status.stoppedReason.time_limit',
  network_errors: 'fuzzer.status.stoppedReason.network_errors',
  host_restart: 'fuzzer.status.stoppedReason.host_restart'
}

/**
 * Fuzzer workbench: raw request with § injection markers, per-position payload
 * sets, attack-mode count preview, a mandatory start confirmation, background
 * polling (1s), a sortable result table with a full detail inspector, CSV/JSON
 * export and recent-job history.
 *
 * All network access goes through `lib/fuzzerApi` and all copy through the
 * `fuzzer.*` i18n keys.
 */
export function FuzzerPanel({ vuln, loading }: FuzzerPanelProps) {
  const { t } = useI18n()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const [raw, setRaw] = useState('')
  const [mode, setMode] = useState<FuzzMode>('sniper')
  const [payloadTexts, setPayloadTexts] = useState<string[]>([])
  const [concurrency, setConcurrency] = useState(5)
  const [delayMs, setDelayMs] = useState(0)
  const [followRedirects, setFollowRedirects] = useState(false)
  const [stopOnConsecutiveErrors, setStopOnConsecutiveErrors] = useState(false)

  const [attempted, setAttempted] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [markerError, setMarkerError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [starting, setStarting] = useState(false)

  const [jobId, setJobId] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [job, setJob] = useState<FuzzJob | null>(null)
  const [results, setResults] = useState<FuzzResultSummary[]>([])
  const [resultsCount, setResultsCount] = useState(0)
  const [jobLoading, setJobLoading] = useState(false)
  const [jobError, setJobError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | 'baseline' | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null)

  const [history, setHistory] = useState<FuzzHistoryItem[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const requests = useMemo(
    () => (vuln === null ? [] : extractRepeaterRequests(vuln)),
    [vuln]
  )

  // Reset per-finding state and preload the best report request as raw text.
  useEffect(() => {
    setRaw('')
    setJobId(null)
    setJob(null)
    setResults([])
    setResultsCount(0)
    setSelected(null)
    setJobError(null)
    setJobLoading(false)
    setActionError(null)
    setMarkerError(null)
    setAttempted(false)
    setPayloadTexts([])
    if (vuln === null) return
    const index = defaultRequestIndex(vuln, requests)
    setRaw(requests[index]?.raw ?? '')
    // Only react to the selected finding; in-flight edits must survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vuln?.id])

  const markerScan = useMemo(() => scanMarkers(raw), [raw])
  const positions = markerScan.pairs

  // Keep exactly one payload editor value per marker position, preserving edits.
  useEffect(() => {
    setPayloadTexts((current) => {
      if (current.length === positions) return current
      return Array.from({ length: positions }, (_, index) => current[index] ?? '')
    })
  }, [positions])

  const payloadSets = useMemo(
    () =>
      Array.from({ length: Math.max(positions, 1) }, (_, index) =>
        parsePayloadLines(payloadTexts[index] ?? '')
      ),
    [positions, payloadTexts]
  )

  const expected = useMemo(
    () => expectedCaseCount(mode, positions, payloadSets),
    [mode, positions, payloadSets]
  )

  const expectedIssue = useMemo((): ValidationIssue | null => {
    if (expected.error === null) return null
    return describeExpectedIssue(expected.error, mode, positions, payloadSets, expected.total)
  }, [expected, mode, positions, payloadSets])

  const originPreview = useMemo(() => {
    const targetUrl = vuln?.target_url ?? ''
    if (targetUrl === '') return ''
    try {
      const parsed = parseRawRequest(raw)
      return fuzzTargetOrigin(targetUrl, resolveFuzzUrl(parsed.url, targetUrl))
    } catch {
      return fuzzTargetOrigin(targetUrl, '')
    }
  }, [raw, vuln])

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const jobs = await listFuzzJobs(20)
      setHistory(jobs)
    } catch (cause) {
      setHistoryError(fuzzerErrorMessage(cause))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  // Poll the job every second while it runs; the first fetch is immediate so a
  // completed mock/quick job renders without waiting for the first interval.
  useEffect(() => {
    if (jobId === null) return
    let alive = true
    let timer: number | null = null
    let failures = 0

    const schedule = (delay: number): void => {
      timer = window.setTimeout(() => {
        void tick()
      }, delay)
    }

    const tick = async (): Promise<void> => {
      try {
        const page = await getFuzzJob(jobId, { offset: 0, limit: 200 })
        if (!alive) return
        failures = 0
        setJob({ ...page.job, baseline: page.job.baseline ?? null })
        setResults(page.results ?? [])
        setResultsCount(
          typeof page.count === 'number' ? page.count : (page.results ?? []).length
        )
        setJobLoading(false)
        setJobError(null)
        if (page.job.status === 'running') schedule(1000)
      } catch (cause) {
        if (!alive) return
        failures += 1
        setJobError(fuzzerErrorMessage(cause))
        setJobLoading(false)
        if (failures < 3) schedule(1500)
      }
    }

    setJob(null)
    setResults([])
    setResultsCount(0)
    setSelected(null)
    setJobLoading(true)
    setJobError(null)
    void tick()

    return () => {
      alive = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [jobId, reloadNonce])

  const terminalKey =
    job !== null && job.status !== 'running' ? `${job.jobId}:${job.status}` : null
  useEffect(() => {
    if (terminalKey !== null) void refreshHistory()
    // Refresh history once per terminal state transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalKey])

  const describeStartIssue = (): ValidationIssue | null => {
    if (vuln === null) return { key: 'fuzzer.error.api', params: { error: 'no finding' } }
    if (markerScan.open) return { key: 'fuzzer.error.unclosedMarkers' }
    if (positions < 1) return { key: 'fuzzer.error.noMarkers' }
    if (positions > MAX_FUZZ_POSITIONS) {
      return { key: 'fuzzer.error.tooManyPositions', params: { max: MAX_FUZZ_POSITIONS } }
    }
    if (expectedIssue !== null) return expectedIssue
    return null
  }

  const prepareStart = (): PrepareStartResult => {
    const issue = describeStartIssue()
    if (issue !== null) return { ok: false, issue }
    if (vuln === null) return { ok: false, issue: { key: 'fuzzer.error.api', params: { error: 'no finding' } } }

    let parsed: ReturnType<typeof parseRawRequest>
    try {
      parsed = parseRawRequest(raw)
    } catch {
      return { ok: false, issue: { key: 'fuzzer.error.invalidRequest' } }
    }

    const url = resolveFuzzUrl(parsed.url, vuln.target_url)
    if (!/^https?:\/\//i.test(url)) return { ok: false, issue: { key: 'fuzzer.error.invalidUrl' } }
    if (url.length > MAX_TEMPLATE_URL_LENGTH) {
      return {
        ok: false,
        issue: { key: 'fuzzer.error.urlTooLong', params: { max: MAX_TEMPLATE_URL_LENGTH } }
      }
    }

    const headers = stripDerivedHeaders(parsed.headers)
    if (Object.keys(headers).length > MAX_TEMPLATE_HEADERS) {
      return {
        ok: false,
        issue: { key: 'fuzzer.error.tooManyHeaders', params: { max: MAX_TEMPLATE_HEADERS } }
      }
    }
    if (utf8ByteLength(parsed.body) > MAX_TEMPLATE_BODY_BYTES) {
      return { ok: false, issue: { key: 'fuzzer.error.bodyTooLarge' } }
    }

    const selectedSets = usedPayloadSets(mode, payloadSets)
    if (payloadBytes(selectedSets) > MAX_PAYLOAD_BYTES) {
      return { ok: false, issue: { key: 'fuzzer.error.payloadBytes' } }
    }

    return {
      ok: true,
      request: { method: parsed.method, url, headers, body: parsed.body },
      payloadSets: selectedSets,
      origin: fuzzTargetOrigin(vuln.target_url, url)
    }
  }

  const handleMarkerSelection = (): void => {
    const element = textareaRef.current
    const result = markSelection(raw, element?.selectionStart ?? 0, element?.selectionEnd ?? 0)
    if (!result.ok) {
      setMarkerError(t('fuzzer.error.emptySelection'))
      return
    }
    setMarkerError(null)
    setActionError(null)
    setRaw(result.text)
    window.setTimeout(() => {
      const next = textareaRef.current
      if (next === null) return
      next.focus()
      next.setSelectionRange(result.selectionStart, result.selectionEnd)
    }, 0)
  }

  const handleClearMarkers = (): void => {
    setMarkerError(null)
    setRaw(clearMarkers(raw))
  }

  const handleStartClick = (): void => {
    setAttempted(true)
    const prepared = prepareStart()
    if (!prepared.ok) {
      setActionError(t(prepared.issue.key, prepared.issue.params))
      return
    }
    setActionError(null)
    setConfirmOpen(true)
  }

  const confirmStart = async (): Promise<void> => {
    if (starting || vuln === null) return
    const prepared = prepareStart()
    if (!prepared.ok) {
      setActionError(t(prepared.issue.key, prepared.issue.params))
      setConfirmOpen(false)
      return
    }
    setStarting(true)
    setActionError(null)
    try {
      const input: FuzzCreateInput = {
        vulnId: vuln.id,
        request: prepared.request,
        attack: { mode, payloadSets: prepared.payloadSets },
        options: { concurrency, delayMs, followRedirects, stopOnConsecutiveErrors }
      }
      const created = await createFuzzJob(input)
      setConfirmOpen(false)
      setSelected(null)
      setResults([])
      setResultsCount(0)
      setJob(null)
      setJobLoading(true)
      setJobError(null)
      setJobId(created.jobId)
      setReloadNonce((value) => value + 1)
      void refreshHistory()
    } catch (cause) {
      setActionError(t('fuzzer.error.startFailed', { error: fuzzerErrorMessage(cause) }))
      setConfirmOpen(false)
    } finally {
      setStarting(false)
    }
  }

  const stopJob = async (): Promise<void> => {
    if (jobId === null || cancelling) return
    setCancelling(true)
    setActionError(null)
    try {
      await cancelFuzzJob(jobId)
      const page = await getFuzzJob(jobId, { offset: 0, limit: 200 })
      setJob({ ...page.job, baseline: page.job.baseline ?? null })
      setResults(page.results ?? [])
      setResultsCount(typeof page.count === 'number' ? page.count : (page.results ?? []).length)
      setJobLoading(false)
      setJobError(null)
      setReloadNonce((value) => value + 1)
    } catch (cause) {
      setActionError(t('fuzzer.error.cancelFailed', { error: fuzzerErrorMessage(cause) }))
    } finally {
      setCancelling(false)
    }
  }

  const runExport = async (format: 'csv' | 'json'): Promise<void> => {
    if (jobId === null || exporting !== null) return
    setExporting(format)
    try {
      const result = await exportFuzzJob(jobId, format)
      const path = result.savedPaths?.[0] ?? ''
      if (path !== '') {
        toast.success(t('fuzzer.result.exported', { count: result.count, path }))
      } else {
        toast.success(t('fuzzer.result.exportedNoPath', { count: result.count }))
      }
    } catch (cause) {
      toast.error(t('fuzzer.error.exportFailed', { error: fuzzerErrorMessage(cause) }))
    } finally {
      setExporting(null)
    }
  }

  const openHistoryJob = (item: FuzzHistoryItem): void => {
    setSelected(null)
    setJob(null)
    setResults([])
    setResultsCount(0)
    setJobLoading(true)
    setJobError(null)
    setJobId(item.jobId)
    setReloadNonce((value) => value + 1)
  }

  const bytes = useMemo(() => utf8ByteLength(raw), [raw])
  const progressPercent =
    job === null || job.total <= 0
      ? 0
      : Math.min(100, Math.round((job.completed / job.total) * 100))
  const stoppedReasonLabel =
    job?.stoppedReason === null || job?.stoppedReason === undefined
      ? null
      : (() => {
          const key = STOPPED_REASON_KEYS[job.stoppedReason as string]
          if (key === undefined) return job.stoppedReason
          const label = t(key)
          return label === key ? job.stoppedReason : label
        })()
  const isRunning = job?.status === 'running'

  if (loading && vuln === null) {
    return (
      <div className="flex h-full flex-col gap-3">
        <Skeleton className="h-[340px] w-full" />
        <Skeleton className="h-[240px] w-full" />
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

  const showExpectedIssue =
    expectedIssue !== null && (attempted || expectedIssue.key !== 'fuzzer.error.noMarkers')

  return (
    <div
      data-testid="fuzzer-panel"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-1 pr-0.5"
    >
      <div className="grid gap-3 3xl:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
        <section className="flex flex-col rounded-lg border border-border bg-background">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-[12px] font-medium text-foreground">{t('fuzzer.request.title')}</span>
            <span className="rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
              {vuln.id}
            </span>
            <span className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground" title={t('fuzzer.subtitle')}>
              {t('fuzzer.subtitle')}
            </span>
          </div>
          <div className="p-3">
            <textarea
              ref={textareaRef}
              data-testid="fuzzer-request"
              aria-label={t('fuzzer.request.aria')}
              value={raw}
              spellCheck={false}
              onChange={(event) => {
                setRaw(event.target.value)
                setMarkerError(null)
                setActionError(null)
              }}
              className="min-h-[196px] w-full resize-y rounded-lg border border-border bg-[hsl(var(--code))] px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-[hsl(220_14%_92%)] caret-[hsl(174_77%_45%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button
                size="xs"
                data-testid="fuzzer-mark-selection"
                title={t('fuzzer.request.markSelectionTitle')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleMarkerSelection}
                className="gap-1"
              >
                <Highlighter aria-hidden="true" className="h-3 w-3" />
                {t('fuzzer.request.markSelection')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                data-testid="fuzzer-clear-markers"
                title={t('fuzzer.request.clearMarkersTitle')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleClearMarkers}
                className="gap-1"
              >
                <Eraser aria-hidden="true" className="h-3 w-3" />
                {t('fuzzer.request.clearMarkers')}
              </Button>
              <span className="ml-1 inline-flex items-center gap-1 rounded border border-border bg-sidebar px-1.5 py-0.5">
                <span className="text-[10px] text-muted-foreground">{t('fuzzer.request.markerCount')}</span>
                <span
                  data-testid="fuzzer-marker-count"
                  data-count={positions}
                  aria-label={t('fuzzer.request.markerCountAria')}
                  className="font-mono text-[11px] font-medium tabular-nums text-foreground"
                >
                  {positions}
                </span>
              </span>
              <span className="ml-auto font-mono text-[9.5px] tabular-nums text-muted-foreground">
                {t('fuzzer.request.bytes', { count: bytes })}
              </span>
            </div>

            {markerScan.open ? (
              <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-red-700">
                {t('fuzzer.error.unclosedMarkers')}
              </p>
            ) : markerError !== null ? (
              <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-red-700">
                {markerError}
              </p>
            ) : positions === 0 ? (
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                {t('fuzzer.error.noMarkers')}
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
              <span className="text-[10px] text-muted-foreground">{t('fuzzer.attack.label')}</span>
              <Select
                value={mode}
                onValueChange={(value) => {
                  setMode(value as FuzzMode)
                  setActionError(null)
                }}
              >
                <SelectTrigger
                  data-testid="fuzzer-attack-mode"
                  aria-label={t('fuzzer.attack.label')}
                  className="h-8 w-[170px] text-[11.5px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FUZZ_MODES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`fuzzer.attack.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="ml-1 text-[10px] text-muted-foreground">{t('fuzzer.attack.total')}</span>
              <span
                data-testid="fuzzer-total"
                data-total={expected.total}
                className={cn(
                  'rounded border px-1.5 py-0.5 font-mono text-[11.5px] font-medium tabular-nums',
                  expected.ok
                    ? 'border-border bg-sidebar text-foreground'
                    : 'border-red-200 bg-red-50 text-red-700'
                )}
              >
                {expected.total}
              </span>
              <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">
                {t('fuzzer.attack.positions')} · {positions}
              </span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {t(`fuzzer.attack.hint.${mode}`)}
            </p>
            {showExpectedIssue ? (
              <p role="alert" className={cn('mt-1.5 text-[10px] leading-relaxed', attempted ? 'text-red-700' : 'text-muted-foreground')}>
                {t(expectedIssue.key, expectedIssue.params)}
              </p>
            ) : null}
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-3">
          <PayloadSetEditor
            positions={positions}
            mode={mode}
            values={payloadTexts}
            disabled={starting}
            onChange={(index, value) =>
              setPayloadTexts((current) =>
                current.map((entry, entryIndex) => (entryIndex === index ? value : entry))
              )
            }
            onClear={(index) =>
              setPayloadTexts((current) =>
                current.map((entry, entryIndex) => (entryIndex === index ? '' : entry))
              )
            }
            onApplyPreset={(text) =>
              setPayloadTexts((current) =>
                Array.from({ length: Math.max(positions, 0) }, (_, index) => text || current[index] || '')
              )
            }
          />

          <section className="rounded-lg border border-border bg-background">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <span className="text-[12px] font-medium text-foreground">{t('fuzzer.options.title')}</span>
              <span className="text-[10px] text-muted-foreground">{t('fuzzer.options.hint')}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 px-3 pt-3">
              <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                {t('fuzzer.options.concurrency')}
                <Input
                  type="number"
                  min={1}
                  max={MAX_FUZZ_CONCURRENCY}
                  step={1}
                  data-testid="fuzzer-concurrency"
                  value={concurrency}
                  onChange={(event) =>
                    setConcurrency(clampInt(Number(event.target.value), 1, MAX_FUZZ_CONCURRENCY, 5))
                  }
                  className="h-7 w-full px-2 font-mono text-[11px] tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                {t('fuzzer.options.delay')}
                <Input
                  type="number"
                  min={0}
                  max={MAX_FUZZ_DELAY_MS}
                  step={50}
                  data-testid="fuzzer-delay"
                  value={delayMs}
                  onChange={(event) =>
                    setDelayMs(clampInt(Number(event.target.value), 0, MAX_FUZZ_DELAY_MS, 0))
                  }
                  className="h-7 w-full px-2 font-mono text-[11px] tabular-nums"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <Checkbox
                  data-testid="fuzzer-follow-redirects"
                  checked={followRedirects}
                  onChange={(event) => setFollowRedirects(event.target.checked)}
                />
                {t('fuzzer.options.followRedirects')}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <Checkbox
                  data-testid="fuzzer-stop-on-errors"
                  checked={stopOnConsecutiveErrors}
                  onChange={(event) => setStopOnConsecutiveErrors(event.target.checked)}
                />
                {t('fuzzer.options.stopOnErrors')}
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
              <Button
                size="sm"
                data-testid="fuzzer-start"
                disabled={starting || isRunning}
                onClick={handleStartClick}
                className="gap-1.5"
              >
                {starting ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin poc-spinner" />
                ) : (
                  <Play aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {starting ? t('fuzzer.action.starting') : t('fuzzer.action.start')}
              </Button>
              {isRunning ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fuzzer-stop"
                  disabled={cancelling}
                  onClick={() => void stopJob()}
                  className="gap-1.5"
                >
                  {cancelling ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin poc-spinner" />
                  ) : (
                    <Square aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {cancelling ? t('fuzzer.action.stopping') : t('fuzzer.action.stop')}
                </Button>
              ) : null}
              <span className="ml-auto font-mono text-[9.5px] text-muted-foreground">
                {t('fuzzer.attack.positions')} · {positions}
              </span>
            </div>

            {actionError !== null ? (
              <p role="alert" className="mx-3 mb-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-red-700">
                {actionError}
              </p>
            ) : null}
          </section>
        </div>
      </div>

      <section
        data-testid="fuzzer-results"
        className="flex h-[min(56vh,560px)] min-h-[340px] flex-col overflow-hidden rounded-lg border border-border bg-background"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-[12px] font-medium text-foreground">{t('fuzzer.result.title')}</span>
          {job !== null ? (
            <>
              <span
                data-status={job.status}
                className={cn('rounded border px-1.5 py-0.5 font-mono text-[9.5px]', JOB_STATUS_TONE[job.status])}
              >
                {t(`fuzzer.status.${job.status}`)}
              </span>
              <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">
                {t('fuzzer.result.completed', { completed: job.completed, total: job.total })}
              </span>
              {job.failed > 0 ? (
                <span className="font-mono text-[9.5px] text-red-700">
                  {t('fuzzer.result.failed', { count: job.failed })}
                </span>
              ) : null}
              <span className="max-w-[300px] truncate font-mono text-[9.5px] text-muted-foreground" title={job.target.origin}>
                {job.target.origin}
              </span>
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="xs"
              data-testid="fuzzer-export-csv"
              disabled={jobId === null || exporting !== null}
              onClick={() => void runExport('csv')}
              className="gap-1"
            >
              {exporting === 'csv' ? (
                <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin poc-spinner" />
              ) : (
                <Download aria-hidden="true" className="h-3 w-3" />
              )}
              {t('fuzzer.action.exportCsv')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              data-testid="fuzzer-export-json"
              disabled={jobId === null || exporting !== null}
              onClick={() => void runExport('json')}
              className="gap-1"
            >
              {exporting === 'json' ? (
                <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin poc-spinner" />
              ) : (
                <FileJson aria-hidden="true" className="h-3 w-3" />
              )}
              {t('fuzzer.action.exportJson')}
            </Button>
          </div>
        </div>

        {job !== null ? (
          <div
            data-testid="fuzzer-progress"
            data-status={job.status}
            data-completed={job.completed}
            data-total={job.total}
            data-percent={progressPercent}
            className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5"
          >
            <div
              role="progressbar"
              aria-label={t('fuzzer.result.progress')}
              aria-valuemin={0}
              aria-valuemax={job.total}
              aria-valuenow={job.completed}
              className="h-1.5 min-w-[80px] flex-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">
              {t('fuzzer.result.completed', { completed: job.completed, total: job.total })} ·{' '}
              {t('fuzzer.result.percent', { percent: progressPercent })}
            </span>
            {stoppedReasonLabel !== null ? (
              <span className="font-mono text-[9.5px] text-amber-700">
                {t('fuzzer.status.stoppedReason', { reason: stoppedReasonLabel })}
              </span>
            ) : null}
          </div>
        ) : null}

        {jobError !== null ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-[10.5px] text-red-700">
            <span>{t('fuzzer.error.loadJob', { error: jobError })}</span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setReloadNonce((value) => value + 1)}
              className="ml-auto h-5 px-1.5 text-[10px]"
            >
              {t('fuzzer.action.retry')}
            </Button>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {jobId === null ? (
            <p className="flex flex-1 items-center justify-center px-3 py-8 text-[11.5px] text-muted-foreground">
              {t('fuzzer.result.empty')}
            </p>
          ) : job === null ? (
            <div className="flex flex-1 flex-col gap-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <p className="text-center text-[10.5px] text-muted-foreground">
                {t('fuzzer.result.loading')}
              </p>
            </div>
          ) : (
            <>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <FuzzResultsTable
                  job={job}
                  results={results}
                  totalResults={resultsCount}
                  selected={selected}
                  onSelect={setSelected}
                />
              </div>
              {selected !== null ? (
                <FuzzResultDetail
                  jobId={job.jobId}
                  index={selected}
                  targetUrl={vuln.target_url}
                  onClose={() => setSelected(null)}
                />
              ) : null}
            </>
          )}
        </div>
      </section>

      <section data-testid="fuzzer-history" className="rounded-lg border border-border bg-background">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <History aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[12px] font-medium text-foreground">{t('fuzzer.history.title')}</span>
          {history !== null && history.length > 0 ? (
            <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">{history.length}</span>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            data-testid="fuzzer-history-refresh"
            disabled={historyLoading}
            onClick={() => void refreshHistory()}
            className="ml-auto h-6 gap-1 px-2 text-[10px]"
          >
            <RefreshCcw
              aria-hidden="true"
              className={cn('h-3 w-3', historyLoading && 'animate-spin poc-spinner')}
            />
            {t('fuzzer.action.refreshHistory')}
          </Button>
        </div>
        {historyError !== null ? (
          <p role="alert" className="px-3 py-2 text-[10.5px] text-red-700">
            {t('fuzzer.error.loadHistory', { error: historyError })}
          </p>
        ) : history === null ? (
          <p className="px-3 py-2 text-[10.5px] text-muted-foreground">{t('fuzzer.history.loading')}</p>
        ) : history.length === 0 ? (
          <p className="px-3 py-2 text-[10.5px] text-muted-foreground">{t('fuzzer.history.empty')}</p>
        ) : (
          <ul className="max-h-[150px] divide-y divide-border overflow-y-auto">
            {history.map((item) => {
              const current = item.jobId === jobId
              return (
                <li
                  key={item.jobId}
                  data-testid="fuzzer-history-row"
                  data-job-id={item.jobId}
                  data-status={item.status}
                  onClick={() => openHistoryJob(item)}
                  className={cn(
                    'flex cursor-pointer flex-wrap items-center gap-2 px-3 py-1.5 text-[10.5px] transition-colors hover:bg-muted',
                    current && 'bg-accent-soft/50'
                  )}
                >
                  <span className="font-mono text-[9.5px] text-muted-foreground">
                    {item.jobId.slice(0, 8)}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground"
                    title={item.targetUrl}
                  >
                    {item.targetUrl}
                  </span>
                  {item.vulnId !== vuln.id ? (
                    <span className="rounded border border-border bg-sidebar px-1 py-0.5 text-[9px] text-muted-foreground">
                      {t('fuzzer.history.otherVuln')}
                    </span>
                  ) : null}
                  <span className={cn('rounded border px-1 py-0.5 font-mono text-[9px]', JOB_STATUS_TONE[item.status])}>
                    {t(`fuzzer.status.${item.status}`)}
                  </span>
                  <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">
                    {t('fuzzer.history.progress', { completed: item.completed, total: item.total })}
                  </span>
                  <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
                    {formatJobTime(item.createdAt)}
                  </span>
                  {current ? (
                    <span className="rounded border border-accent/40 bg-accent-soft px-1 py-0.5 text-[9px] text-accent">
                      {t('fuzzer.history.current')}
                    </span>
                  ) : null}
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="fuzzer-history-open"
                    aria-label={t('fuzzer.history.openAria', { jobId: item.jobId })}
                    onClick={(event) => {
                      event.stopPropagation()
                      openHistoryJob(item)
                    }}
                    className="h-5 px-1.5 text-[10px]"
                  >
                    {t('fuzzer.history.open')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <DialogPrimitive.Root
        open={confirmOpen}
        onOpenChange={(open) => {
          if (starting) return
          setConfirmOpen(open)
        }}
        modal={false}
      >
        <DialogPrimitive.Portal container={getPortalContainer()}>
          <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[70] bg-[hsl(224_18%_10%/0.3)]" />
          <DialogPrimitive.Content
            data-testid="fuzzer-confirm"
            className="fixed left-1/2 top-1/2 z-[70] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <div className="flex items-start gap-2">
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0">
                <DialogPrimitive.Title className="text-[16px] font-medium tracking-tight text-foreground">
                  {t('fuzzer.confirm.title')}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {t('fuzzer.confirm.description', { total: expected.total })}
                </DialogPrimitive.Description>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-sidebar/50 p-3 text-[11px]">
              <div className="col-span-2 flex flex-col gap-0.5">
                <dt className="text-[10px] text-muted-foreground">{t('fuzzer.confirm.origin')}</dt>
                <dd className="truncate font-mono text-[11px] text-foreground" title={originPreview}>
                  {originPreview === '' ? '-' : originPreview}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-[10px] text-muted-foreground">{t('fuzzer.confirm.total')}</dt>
                <dd className="font-mono text-[12px] font-medium tabular-nums text-foreground" data-total={expected.total}>
                  {expected.total}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-[10px] text-muted-foreground">{t('fuzzer.confirm.concurrency')}</dt>
                <dd className="font-mono text-[12px] tabular-nums text-foreground">{concurrency}</dd>
              </div>
              <div className="col-span-2 flex flex-col gap-0.5">
                <dt className="text-[10px] text-muted-foreground">{t('fuzzer.confirm.mode')}</dt>
                <dd className="text-[11px] text-foreground">{t(`fuzzer.attack.${mode}`)}</dd>
              </div>
            </dl>

            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10.5px] leading-relaxed text-amber-900">
              {t('fuzzer.confirm.risk')}
            </p>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={starting}
                onClick={() => setConfirmOpen(false)}
              >
                {t('fuzzer.action.cancel')}
              </Button>
              <Button
                size="sm"
                data-testid="fuzzer-confirm-start"
                disabled={starting}
                onClick={() => void confirmStart()}
                className="gap-1.5"
              >
                {starting ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin poc-spinner" />
                ) : (
                  <Play aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {starting
                  ? t('fuzzer.action.starting')
                  : t('fuzzer.confirm.start', { total: expected.total })}
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  )
}

/** Map the pure count error to a localised inline issue. */
function describeExpectedIssue(
  error: ExpectedCasesError,
  mode: FuzzMode,
  positions: number,
  payloadSets: string[][],
  total: number
): ValidationIssue | null {
  if (error === 'too_many_cases') {
    return { key: 'fuzzer.error.tooManyCases', params: { total, max: MAX_FUZZ_CASES } }
  }
  if (error === 'too_many_positions') {
    return { key: 'fuzzer.error.tooManyPositions', params: { max: MAX_FUZZ_POSITIONS } }
  }
  if (error === 'not_enough_sets') {
    return { key: 'fuzzer.error.notEnoughSets', params: { positions } }
  }
  if (error === 'empty_payload_set') {
    const count = usedPayloadSetCount(mode, positions)
    let emptyIndex = 0
    for (let index = 0; index < count; index += 1) {
      if ((payloadSets[index] ?? []).length === 0) {
        emptyIndex = index
        break
      }
    }
    return { key: 'fuzzer.error.emptyPayloadSet', params: { n: emptyIndex + 1 } }
  }
  if (error === 'unclosed_markers') return { key: 'fuzzer.error.unclosedMarkers' }
  return { key: 'fuzzer.error.noMarkers' }
}
