import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Archive,
  Check,
  Copy,
  Download,
  FolderOpen,
  Loader2,
  Pencil,
  ScanSearch,
  Search,
  Unplug,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetTitle
} from '@renderer/components/ui/sheet'
import { CopyButton } from '@renderer/components/common/CopyButton'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { MiniappFormatBadge, MiniappStatusBadge } from '@renderer/components/miniapp/MiniappCard'
import { FileTree } from '@renderer/components/miniapp/FileTree'
import { useCopy } from '@renderer/hooks/useCopy'
import {
  MiniappApiError,
  analyzeMiniapp,
  getMiniapp,
  importMiniappAssets,
  openMiniappDir,
  readMiniappFile,
  renameMiniapp,
  searchMiniappFiles,
  toMiniappErrorMessage,
  unpackMiniapp,
  type MiniappAnalysis,
  type MiniappDetailResponse,
  type MiniappFileResponse,
  type MiniappImportResponse,
  type MiniappSearchResponse
} from '@renderer/lib/miniappApi'
import { formatBytes, formatDateTime, formatDateTimeFull } from '@renderer/lib/format'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

const PREVIEW_LINES = 200

type DetailTab = 'overview' | 'files' | 'search'
type DetailAction = 'unpack' | 'analyze' | 'import' | 'open'

interface MiniappDetailProps {
  miniappId: string | null
  onClose: () => void
  /** Notify the page that list-level fields (status/has_analysis) changed. */
  onChanged: () => void
}

function countOf(analysis: MiniappAnalysis | null, key: 'pages' | 'subPackages' | 'domains' | 'endpoints' | 'secrets' | 'parameters'): number {
  if (analysis === null) return 0
  const value = analysis[key]
  return Array.isArray(value) ? value.length : 0
}

/**
 * Right-hand inspector for one mini-program source: extracted overview, lazy
 * source tree + text preview and regex/glob search over the unpacked files.
 * Everything is read-only; the only mutations are the explicit unpack /
 * analyze / import / open actions.
 */
export function MiniappDetail({ miniappId, onClose, onChanged }: MiniappDetailProps) {
  const { t } = useI18n()
  const { copy } = useCopy()
  const [detail, setDetail] = useState<MiniappDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrySeq, setRetrySeq] = useState(0)
  const [tab, setTab] = useState<DetailTab>('overview')
  const [action, setAction] = useState<DetailAction | null>(null)
  const [importResult, setImportResult] = useState<MiniappImportResponse | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [renamePending, setRenamePending] = useState(false)

  const [preview, setPreview] = useState<MiniappFileResponse | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewOffset, setPreviewOffset] = useState(0)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchRegex, setSearchRegex] = useState(false)
  const [searchGlob, setSearchGlob] = useState('')
  const [searchMax, setSearchMax] = useState('50')
  const [searchResults, setSearchResults] = useState<MiniappSearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // New source (or reopening the same one) starts from a clean inspector.
  useEffect(() => {
    setDetail(null)
    setError(null)
    setTab('overview')
    setAction(null)
    setImportResult(null)
    setPreview(null)
    setPreviewPath(null)
    setPreviewOffset(0)
    setPreviewError(null)
    setPreviewLoading(false)
    setSearchQuery('')
    setSearchRegex(false)
    setSearchGlob('')
    setSearchMax('50')
    setSearchResults(null)
    setSearchError(null)
    setRenaming(false)
    setNameDraft('')
    setRenamePending(false)
  }, [miniappId])

  useEffect(() => {
    if (miniappId === null) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    setDetail(null)
    getMiniapp(miniappId).then(
      (result) => {
        if (!alive) return
        setDetail(result)
        setTab(result.miniapp.status === 'unpacked' ? 'files' : 'overview')
        setLoading(false)
      },
      (cause: unknown) => {
        if (!alive) return
        setError(toMiniappErrorMessage(cause))
        setLoading(false)
      }
    )
    return () => {
      alive = false
    }
  }, [miniappId, retrySeq])

  const loadFile = useCallback(
    async (path: string, offset: number) => {
      if (miniappId === null) return
      setPreviewPath(path)
      setPreviewOffset(offset)
      setPreviewLoading(true)
      setPreviewError(null)
      try {
        const result = await readMiniappFile(miniappId, path, offset, PREVIEW_LINES)
        setPreview(result)
        if (result.binary) setPreviewError(t('miniapp.file.binary'))
      } catch (cause) {
        setPreview(null)
        setPreviewError(
          cause instanceof MiniappApiError && cause.code === 'BINARY_FILE'
            ? t('miniapp.file.binary')
            : t('miniapp.file.loadError', { error: toMiniappErrorMessage(cause) })
        )
      } finally {
        setPreviewLoading(false)
      }
    },
    [miniappId, t]
  )

  const runSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (miniappId === null) return
    const query = searchQuery.trim()
    if (query.length === 0) {
      setSearchResults(null)
      setSearchError(null)
      return
    }
    setSearching(true)
    setSearchError(null)
    try {
      const result = await searchMiniappFiles(miniappId, {
        query,
        regex: searchRegex,
        glob: searchGlob.trim(),
        maxResults: Number.parseInt(searchMax, 10) || 50
      })
      setSearchResults(result)
    } catch (cause) {
      setSearchResults(null)
      setSearchError(t('miniapp.search.error', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setSearching(false)
    }
  }

  const refreshDetail = (next: MiniappDetailResponse): void => {
    setDetail(next)
  }

  const handleAnalyze = async () => {
    if (miniappId === null || detail === null || action !== null) return
    setAction('analyze')
    try {
      const result = await analyzeMiniapp(miniappId)
      refreshDetail({
        ...detail,
        analysis: result.analysis,
        overviewText: result.overviewText,
        extractedCounts: result.counts
      })
      setTab('overview')
      toast.success(
        t('miniapp.toast.analyzed', {
          pages: result.analysis?.pages.length ?? 0,
          endpoints: result.counts.endpoints,
          secrets: result.counts.secrets
        })
      )
      onChanged()
    } catch (cause) {
      toast.error(t('miniapp.toast.analyzeFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setAction(null)
    }
  }

  const handleImport = async () => {
    if (miniappId === null || detail === null || action !== null) return
    setAction('import')
    try {
      const result = await importMiniappAssets(miniappId, {})
      setImportResult(result)
      if (result.ok) {
        toast.success(t('miniapp.toast.imported', { ...result.totals }))
      } else {
        toast.warning(t('miniapp.toast.importWarnings', { warnings: result.warnings.join('; ') }))
      }
      onChanged()
    } catch (cause) {
      toast.error(t('miniapp.toast.importFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setAction(null)
    }
  }

  const handleUnpack = async () => {
    if (miniappId === null || detail === null || action !== null) return
    setAction('unpack')
    try {
      const result = await unpackMiniapp(miniappId)
      if (result.ok) {
        toast.success(t('miniapp.toast.unpacked', { appid: detail.miniapp.appid }))
      } else if (result.status === 'unsupported') {
        toast.error(t('miniapp.toast.unpackUnsupported', { error: result.error }))
      } else {
        toast.error(t('miniapp.toast.unpackFailed', { error: result.error }))
      }
      onChanged()
      setRetrySeq((value) => value + 1)
    } catch (cause) {
      toast.error(t('miniapp.toast.unpackFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setAction(null)
    }
  }

  const handleOpenDir = async () => {
    if (miniappId === null || action !== null) return
    setAction('open')
    try {
      const result = await openMiniappDir(miniappId)
      toast.success(t('miniapp.toast.opened', { path: result.path }))
    } catch (cause) {
      toast.error(t('miniapp.toast.openFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setAction(null)
    }
  }

  const handleRename = async () => {
    if (miniappId === null || detail === null || renamePending) return
    setRenamePending(true)
    try {
      const result = await renameMiniapp(miniappId, nameDraft)
      setDetail((current) =>
        current === null ? current : { ...current, miniapp: { ...current.miniapp, ...result.miniapp } }
      )
      setRenaming(false)
      onChanged()
      toast.success(t('miniapp.detail.renamed'))
    } catch (cause) {
      toast.error(t('miniapp.detail.renameFailed', { error: toMiniappErrorMessage(cause) }))
    } finally {
      setRenamePending(false)
    }
  }

  const analysis = detail?.analysis ?? null
  const unpacked = detail?.miniapp.status === 'unpacked'
  const overviewText = detail?.overviewText ?? ''
  const versions = detail?.miniapp.versions ?? []
  const versionCount = versions.length > 0 ? versions.length : (detail?.miniapp.version_count ?? 1)
  const counts: Array<{ key: string; label: string; value: number }> = [
    { key: 'pages', label: t('miniapp.detail.count.pages'), value: countOf(analysis, 'pages') },
    { key: 'subPackages', label: t('miniapp.detail.count.subPackages'), value: countOf(analysis, 'subPackages') },
    { key: 'domains', label: t('miniapp.detail.count.domains'), value: countOf(analysis, 'domains') },
    { key: 'endpoints', label: t('miniapp.detail.count.endpoints'), value: countOf(analysis, 'endpoints') },
    { key: 'secrets', label: t('miniapp.detail.count.secrets'), value: countOf(analysis, 'secrets') },
    { key: 'parameters', label: t('miniapp.detail.count.parameters'), value: countOf(analysis, 'parameters') }
  ]

  return (
    <Sheet
      open={miniappId !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <SheetContent
        data-testid="miniapp-detail"
        className="w-[min(60rem,calc(100vw-1.75rem))]"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {t('miniapp.detail.eyebrow')}
          </span>
          <div className="flex items-center gap-1">
            {detail !== null && unpacked ? (
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="miniapp-detail-open-dir"
                aria-label={t('miniapp.action.openDir')}
                title={t('miniapp.action.openDir')}
                disabled={action !== null}
                onClick={() => void handleOpenDir()}
                className="text-muted-foreground"
              >
                {action === 'open' ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
                )}
              </Button>
            ) : null}
            <SheetCloseButton />
          </div>
        </div>

        {loading && detail === null ? (
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="mt-2 h-24 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : error !== null && detail === null ? (
          <EmptyState
            icon={Unplug}
            title={t('miniapp.detail.loadError')}
            description={error}
            className="my-auto"
          >
            <Button variant="outline" size="sm" onClick={() => setRetrySeq((value) => value + 1)}>
              {t('common.retry')}
            </Button>
          </EmptyState>
        ) : detail !== null ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border px-6 pb-4 pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  {renaming ? (
                    <form
                      className="flex flex-wrap items-center gap-1.5"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void handleRename()
                      }}
                    >
                      <Input
                        autoFocus
                        value={nameDraft}
                        maxLength={60}
                        onChange={(event) => setNameDraft(event.target.value)}
                        placeholder={t('miniapp.detail.renamePlaceholder')}
                        aria-label={t('miniapp.detail.rename')}
                        className="h-8 w-[260px] max-w-full text-[13px]"
                      />
                      <Button
                        type="submit"
                        variant="outline"
                        size="icon-sm"
                        disabled={renamePending}
                        aria-label={t('miniapp.detail.renameSave')}
                      >
                        {renamePending ? (
                          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check aria-hidden="true" className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setRenaming(false)}
                        aria-label={t('common.cancel')}
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                    </form>
                  ) : (
                    <div className="flex min-w-0 items-center gap-1.5">
                      <SheetTitle className="break-all text-[19px] font-medium tracking-tight text-foreground">
                        {(detail.miniapp.app_name ?? '').trim().length > 0
                          ? detail.miniapp.app_name
                          : detail.miniapp.appid}
                      </SheetTitle>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0"
                        aria-label={t('miniapp.detail.rename')}
                        onClick={() => {
                          setNameDraft((detail.miniapp.app_name ?? '').trim())
                          setRenaming(true)
                        }}
                      >
                        <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                  <p className="mt-1 break-all font-mono text-[11.5px] text-muted-foreground">
                    {detail.miniapp.appid}
                  </p>
                </div>
                <CopyButton
                  value={detail.miniapp.appid}
                  label={t('common.copy')}
                  toastMessage={t('common.copied')}
                  className="mt-0.5"
                />
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <MiniappStatusBadge status={detail.miniapp.status} />
                <MiniappFormatBadge format={detail.miniapp.format} />
                <span className="font-mono text-[11px] tabular-nums text-foreground/70">
                  {(detail.miniapp.version ?? '').trim().length > 0
                    ? t('miniapp.card.version', { version: detail.miniapp.version })
                    : t('miniapp.card.noVersion')}
                </span>
                {versionCount > 1 ? (
                  <span className="font-mono text-[11px] tabular-nums text-foreground/70">
                    {t('miniapp.card.versions', { count: versionCount })}
                  </span>
                ) : null}
                <span className="font-mono text-[11px] tabular-nums text-foreground/70">
                  {formatBytes(detail.miniapp.size_bytes)}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-foreground/70">
                  {t('miniapp.card.updated', { time: formatDateTime(detail.miniapp.updated_at) })}
                </span>
              </div>

              {(detail.miniapp.error ?? '').trim().length > 0 ? (
                <p
                  role="alert"
                  className="mt-2 break-all rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-700"
                >
                  {t('miniapp.card.errorLabel', { error: detail.miniapp.error })}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {!unpacked ? (
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="miniapp-detail-unpack"
                    disabled={action !== null}
                    onClick={() => void handleUnpack()}
                    className="gap-1.5"
                  >
                    {action === 'unpack' ? (
                      <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                    ) : (
                      <Archive aria-hidden="true" className="h-3 w-3" />
                    )}
                    {action === 'unpack'
                      ? t('miniapp.action.unpacking')
                      : t('miniapp.action.unpack')}
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="xs"
                      data-testid="miniapp-detail-analyze"
                      disabled={action !== null}
                      onClick={() => void handleAnalyze()}
                      className="gap-1.5"
                    >
                      {action === 'analyze' ? (
                        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                      ) : (
                        <ScanSearch aria-hidden="true" className="h-3 w-3" />
                      )}
                      {action === 'analyze'
                        ? t('miniapp.detail.generating')
                        : t('miniapp.detail.generate')}
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      data-testid="miniapp-detail-import"
                      disabled={action !== null || analysis === null}
                      onClick={() => void handleImport()}
                      className="gap-1.5"
                    >
                      {action === 'import' ? (
                        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                      ) : (
                        <Download aria-hidden="true" className="h-3 w-3" />
                      )}
                      {action === 'import'
                        ? t('miniapp.detail.importing')
                        : t('miniapp.detail.importAssets')}
                    </Button>
                  </>
                )}
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="miniapp-copy-summary"
                  disabled={overviewText.trim().length === 0 || action !== null}
                  onClick={() => void copy(overviewText, t('miniapp.detail.copiedSummary'))}
                  className="gap-1.5"
                >
                  <Copy aria-hidden="true" className="h-3 w-3" />
                  {t('miniapp.detail.copySummary')}
                </Button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-6 pt-3">
              <Tabs value={tab} onValueChange={(value) => setTab(value as DetailTab)} className="flex min-h-0 flex-1 flex-col">
                <TabsList className="h-auto w-full flex-wrap justify-start gap-5 border-b border-border bg-transparent p-0">
                  <TabsTrigger
                    value="overview"
                    data-testid="miniapp-tab-overview"
                    className="h-8 rounded-none border-b-2 border-transparent px-0 text-[12.5px] data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    {t('miniapp.detail.tab.overview')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="files"
                    data-testid="miniapp-tab-files"
                    disabled={!unpacked}
                    className="h-8 rounded-none border-b-2 border-transparent px-0 text-[12.5px] data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    {t('miniapp.detail.tab.files')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="search"
                    data-testid="miniapp-tab-search"
                    disabled={!unpacked}
                    className="h-8 rounded-none border-b-2 border-transparent px-0 text-[12.5px] data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    {t('miniapp.detail.tab.search')}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1 focus-visible:outline-none [scrollbar-gutter:stable]">
                  {analysis === null ? (
                    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                      <p className="text-[13px] font-medium text-foreground">
                        {t('miniapp.detail.overview.analysisMissing')}
                      </p>
                      <p className="mx-auto mt-1.5 max-w-[420px] text-[11.5px] leading-relaxed text-muted-foreground">
                        {t('miniapp.detail.overview.analysisMissingHint')}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4 gap-1.5"
                        disabled={!unpacked || action !== null}
                        onClick={() => void handleAnalyze()}
                      >
                        {action === 'analyze' ? (
                          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ScanSearch aria-hidden="true" className="h-3.5 w-3.5" />
                        )}
                        {action === 'analyze'
                          ? t('miniapp.detail.generating')
                          : t('miniapp.detail.generate')}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {counts.map((entry) => (
                          <div
                            key={entry.key}
                            data-testid={`miniapp-count-${entry.key}`}
                            className="rounded-lg border border-border bg-background px-3 py-2"
                          >
                            <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                              {entry.label}
                            </p>
                            <p className="mt-0.5 font-mono text-[17px] tabular-nums text-foreground">
                              {entry.value}
                            </p>
                          </div>
                        ))}
                      </div>

                      <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                        {t('miniapp.detail.overview.filesSummary', {
                          text: analysis.files.text,
                          binary: analysis.files.binary,
                          size: formatBytes(analysis.files.bytes)
                        })}
                      </p>

                      {analysis.largestFiles.length > 0 ? (
                        <section className="mt-5">
                          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                            {t('miniapp.detail.overview.largestFiles')}
                          </h3>
                          <ul className="mt-2 overflow-hidden rounded-md border border-border">
                            {analysis.largestFiles.map((file) => (
                              <li
                                key={file.path}
                                className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-[11.5px] last:border-b-0"
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTab('files')
                                    void loadFile(file.path, 0)
                                  }}
                                  className="min-w-0 flex-1 truncate text-left font-mono text-foreground hover:text-accent focus-visible:text-accent focus-visible:outline-none"
                                  title={file.path}
                                >
                                  {file.path}
                                </button>
                                <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                                  {formatBytes(file.size)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}

                      {analysis.warnings.length > 0 ? (
                        <section className="mt-5">
                          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                            {t('miniapp.detail.overview.warnings')}
                          </h3>
                          <ul className="mt-2 space-y-1">
                            {analysis.warnings.map((warning, index) => (
                              <li
                                key={`${index}-${warning}`}
                                className="break-all text-[11.5px] leading-relaxed text-amber-800"
                              >
                                {warning}
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </>
                  )}

                  {importResult !== null ? (
                    <section
                      data-testid="miniapp-import-result"
                      className={cn(
                        'mt-5 rounded-lg border px-3 py-2.5',
                        importResult.ok
                          ? 'border-emerald-200 bg-emerald-50'
                          : 'border-amber-200 bg-amber-50'
                      )}
                    >
                      <p
                        className={cn(
                          'text-[11.5px] font-medium',
                          importResult.ok ? 'text-emerald-800' : 'text-amber-800'
                        )}
                      >
                        {t('miniapp.detail.importResult.title')}
                      </p>
                      <p
                        className={cn(
                          'mt-1 text-[11px]',
                          importResult.ok ? 'text-emerald-900/80' : 'text-amber-900/80'
                        )}
                      >
                        {t('miniapp.detail.importResult.project', { project: importResult.project })}
                      </p>
                      <p
                        className={cn(
                          'mt-0.5 font-mono text-[11px] tabular-nums',
                          importResult.ok ? 'text-emerald-900/80' : 'text-amber-900/80'
                        )}
                      >
                        {t('miniapp.detail.importResult.totals', { ...importResult.totals })}
                      </p>
                      {importResult.warnings.length > 0 ? (
                        <p className="mt-1 break-all text-[11px] text-amber-800">
                          {t('miniapp.detail.importResult.warnings', {
                            warnings: importResult.warnings.join('; ')
                          })}
                        </p>
                      ) : null}
                    </section>
                  ) : null}

                  {versions.length > 1 ? (
                    <section className="mt-5">
                      <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        {t('miniapp.detail.overview.versions')}
                      </h3>
                      <ul className="mt-2 overflow-hidden rounded-md border border-border">
                        {versions.map((version) => (
                          <li
                            key={version.id}
                            className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] last:border-b-0"
                          >
                            <span className="font-mono tabular-nums text-foreground">
                              {(version.version ?? '').trim().length > 0
                                ? t('miniapp.card.version', { version: version.version })
                                : t('miniapp.card.noVersion')}
                            </span>
                            <MiniappStatusBadge status={version.status} />
                            <MiniappFormatBadge format={version.format} />
                            <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted-foreground">
                              {t('miniapp.detail.versionMeta', {
                                status: t(`miniapp.status.${version.status}`),
                                format: version.format,
                                size: formatBytes(version.size_bytes),
                                files: version.file_count,
                                time: formatDateTime(version.updated_at)
                              })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  <section className="mt-5">
                    <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                      {t('miniapp.detail.overview.heading')}
                    </h3>
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[11.5px] sm:grid-cols-[auto,1fr]">
                      <dt className="text-muted-foreground">{t('miniapp.detail.meta.rootKind')}</dt>
                      <dd className="font-mono text-foreground">{detail.miniapp.root_kind}</dd>
                      <dt className="text-muted-foreground">{t('miniapp.detail.meta.packageDir')}</dt>
                      <dd className="break-all font-mono text-foreground">{detail.miniapp.package_dir}</dd>
                      {(detail.miniapp.unpacked_path ?? '').trim().length > 0 ? (
                        <>
                          <dt className="text-muted-foreground">{t('miniapp.detail.meta.unpackedPath')}</dt>
                          <dd className="break-all font-mono text-foreground">
                            {detail.miniapp.unpacked_path}
                          </dd>
                        </>
                      ) : null}
                      <dt className="text-muted-foreground">{t('miniapp.detail.meta.format')}</dt>
                      <dd className="font-mono text-foreground">{detail.miniapp.format}</dd>
                      <dt className="text-muted-foreground">{t('miniapp.detail.meta.updated')}</dt>
                      <dd className="font-mono text-foreground">
                        {formatDateTimeFull(detail.miniapp.updated_at)}
                      </dd>
                    </dl>
                  </section>
                </TabsContent>

                <TabsContent value="files" className="mt-4 min-h-0 flex-1 focus-visible:outline-none">
                  <div className="flex h-full min-h-0 flex-1 gap-3">
                    {detail.miniapp.id ? (
                      <div className="flex w-[260px] shrink-0 flex-col">
                        <FileTree
                          key={detail.miniapp.id}
                          miniappId={detail.miniapp.id}
                          onOpenFile={(path) => void loadFile(path, 0)}
                        />
                      </div>
                    ) : null}

                    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-background">
                      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
                          {previewPath ?? t('miniapp.file.previewTitle')}
                        </span>
                        {preview !== null ? (
                          <>
                            {preview.formatted ? (
                              <span className="shrink-0 rounded border border-border bg-secondary px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground">
                                {t('miniapp.file.formatted')}
                              </span>
                            ) : null}
                            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                              {t('miniapp.file.totalLines', { count: preview.totalLines })}
                            </span>
                            <CopyButton
                              value={preview.content}
                              label={t('common.copy')}
                              toastMessage={t('common.copied')}
                            />
                          </>
                        ) : null}
                      </div>
                      <div className="min-h-0 flex-1 overflow-auto">
                        {previewLoading ? (
                          <div className="flex flex-col gap-2 p-3">
                            <Skeleton className="h-3 w-2/3" />
                            <Skeleton className="h-3 w-full" />
                            <Skeleton className="h-3 w-5/6" />
                          </div>
                        ) : previewError !== null ? (
                          <p className="p-3 text-[11.5px] leading-relaxed text-red-700">{previewError}</p>
                        ) : preview !== null ? (
                          <pre
                            data-testid="miniapp-file-preview"
                            className={cn(
                              'whitespace-pre px-3 py-2 font-mono text-[11px] leading-[1.65] text-foreground',
                              preview.binary && 'text-muted-foreground'
                            )}
                          >
                            {preview.content}
                          </pre>
                        ) : (
                          <p className="p-3 text-[11.5px] text-muted-foreground">
                            {t('miniapp.file.selectPrompt')}
                          </p>
                        )}
                      </div>
                      {preview !== null && preview.truncated ? (
                        <div className={cn('flex shrink-0 items-center gap-2 border-t border-border px-3 py-2')}>
                          <span className="text-[10.5px] text-muted-foreground">
                            {t('miniapp.file.truncated', { lines: PREVIEW_LINES })}
                          </span>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="ml-auto"
                            disabled={previewLoading}
                            onClick={() => void loadFile(preview.path, previewOffset + PREVIEW_LINES)}
                          >
                            {t('miniapp.file.loadMore')}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="search" className="mt-4 flex min-h-0 flex-1 flex-col focus-visible:outline-none">
                  <form onSubmit={(event) => void runSearch(event)} className="flex flex-wrap items-end gap-2">
                    <div className="relative min-w-[200px] flex-1">
                      <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                      />
                      <Input
                        data-testid="miniapp-search-query"
                        aria-label={t('miniapp.search.queryAria')}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder={t('miniapp.search.queryPlaceholder')}
                        className="h-8 pl-8 text-[11.5px]"
                      />
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={searchRegex}
                      data-testid="miniapp-search-regex"
                      onClick={() => setSearchRegex((value) => !value)}
                      className={cn(
                        'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] transition-colors',
                        searchRegex
                          ? 'border-accent bg-accent-soft font-medium text-accent'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted'
                      )}
                    >
                      {t('miniapp.search.regex')}
                    </button>
                    <Input
                      data-testid="miniapp-search-glob"
                      aria-label={t('miniapp.search.glob')}
                      value={searchGlob}
                      onChange={(event) => setSearchGlob(event.target.value)}
                      placeholder={t('miniapp.search.globPlaceholder')}
                      className="h-8 w-[160px] font-mono text-[11px]"
                    />
                    <label className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                      {t('miniapp.search.maxResults')}
                      <Input
                        data-testid="miniapp-search-max"
                        type="number"
                        min={1}
                        max={200}
                        value={searchMax}
                        onChange={(event) => setSearchMax(event.target.value)}
                        className="h-8 w-[68px] text-[11px]"
                      />
                    </label>
                    <Button
                      type="submit"
                      variant="outline"
                      size="sm"
                      data-testid="miniapp-search-submit"
                      disabled={searching || searchQuery.trim().length === 0}
                      className="gap-1.5"
                    >
                      {searching ? (
                        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Search aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                      {searching ? t('miniapp.search.searching') : t('miniapp.search.submit')}
                    </Button>
                  </form>

                  <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                    {searchError !== null ? (
                    <p role="alert" className="mt-3 text-[11.5px] text-red-700">
                      {searchError}
                    </p>
                  ) : searchResults === null ? (
                    <p className="mt-3 text-[11.5px] text-muted-foreground">
                      {t('miniapp.search.empty')}
                    </p>
                  ) : (
                    <>
                      <p className="mt-3 font-mono text-[10.5px] text-muted-foreground">
                        {t('miniapp.search.summary', {
                          count: searchResults.matches.length,
                          scanned: searchResults.scanned
                        })}
                        {searchResults.truncated ? ` ${t('miniapp.search.truncated')}` : ''}
                      </p>
                      {searchResults.matches.length === 0 ? (
                        <p className="mt-2 text-[11.5px] text-muted-foreground">
                          {t('miniapp.search.noResults')}
                        </p>
                      ) : (
                        <ul className="mt-2 overflow-hidden rounded-md border border-border">
                          {searchResults.matches.map((match, index) => (
                            <li key={`${match.file}:${match.line}:${index}`} className="border-b border-border last:border-b-0">
                              <button
                                type="button"
                                data-testid="miniapp-search-result"
                                aria-label={t('miniapp.search.resultAria', {
                                  file: match.file,
                                  line: match.line
                                })}
                                onClick={() => {
                                  setTab('files')
                                  void loadFile(match.file, Math.max(0, match.line - 1))
                                }}
                                className="flex w-full items-baseline gap-3 px-3 py-1.5 text-left transition-colors hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none"
                              >
                                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                                  {match.file}:{match.line}
                                </span>
                                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                                  {match.text}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
