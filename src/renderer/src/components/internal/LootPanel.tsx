import { useEffect, useState } from 'react'
import { AlertTriangle, FileUp, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { LootImport } from '@shared/types'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { apiUnavailableMessage, getApi, IS_WEB_RUNTIME, toErrorMessage } from '@renderer/lib/api'
import { formatDateTimeFull } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { InternalPanel } from './InternalPanel'
import { INTERNAL_TD, INTERNAL_TH, LOOT_STATUS_STYLES } from './internalUi'

interface LootPanelProps {
  projectName: string
  loot: LootImport[] | null
  loading: boolean
  error: string | null
  onRetry: () => void
  /** Called after a successful import so the page refreshes related data. */
  onImported: () => void
}

function LootSkeleton() {
  const { t } = useI18n()
  return (
    <div className="space-y-2 px-4 py-3" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
      <span role="status" className="sr-only">
        {t('internal.loot.loading')}
      </span>
    </div>
  )
}

/**
 * Loot import panel (§8.4). Files are parsed locally: only the filename, hash
 * and summary are persisted. In Web mode the import form is replaced by a hint
 * that loot import is desktop / CLI only (the HTTP upload endpoint is not part
 * of this UI scope).
 */
export function LootPanel({
  projectName,
  loot,
  loading,
  error,
  onRetry,
  onImported
}: LootPanelProps) {
  const { t } = useI18n()
  const [filePath, setFilePath] = useState('')
  const [entryHost, setEntryHost] = useState('')
  const [importing, setImporting] = useState(false)

  // Never carry a half-filled path across projects.
  useEffect(() => {
    setFilePath('')
    setEntryHost('')
  }, [projectName])

  const handleImport = async (): Promise<void> => {
    if (IS_WEB_RUNTIME) return
    const trimmedPath = filePath.trim()
    if (trimmedPath.length === 0) {
      toast.error(t('internal.loot.formRequired'))
      return
    }
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }
    setImporting(true)
    try {
      const result = await api.importLoot({
        project_name: projectName,
        entry_host_port: entryHost.trim(),
        file_path: trimmedPath
      })
      toast.success(t('internal.loot.toast.imported', { filename: result.filename }))
      setFilePath('')
      setEntryHost('')
      onImported()
    } catch (cause) {
      toast.error(t('internal.loot.toast.failed', { error: toErrorMessage(cause, t) }))
    } finally {
      setImporting(false)
    }
  }

  const actions = (
    <Button
      variant="ghost"
      size="icon-sm"
      data-testid="internal-loot-refresh"
      aria-label={t('common.refresh')}
      title={t('common.refresh')}
      onClick={onRetry}
    >
      <RefreshCw strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
    </Button>
  )

  return (
    <InternalPanel
      testId="internal-loot"
      title={t('internal.loot.title')}
      count={loot !== null && loot.length > 0 ? loot.length : undefined}
      actions={actions}
    >
      {IS_WEB_RUNTIME ? (
        <div
          data-testid="internal-loot-web-hint"
          className="flex items-start gap-2 border-b border-border bg-muted/40 px-4 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground"
        >
          <AlertTriangle
            strokeWidth={1.75} aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600"
          />
          <span className="break-all font-mono text-[11px]">{t('internal.loot.webHint')}</span>
        </div>
      ) : (
        <form
          data-testid="internal-loot-form"
          className="flex flex-wrap items-end gap-2.5 border-b border-border px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            void handleImport()
          }}
        >
          <label className="flex min-w-[280px] flex-1 flex-col gap-1">
            <span className="text-[10.5px] font-medium text-foreground/70">
              {t('internal.loot.fileLabel')}
            </span>
            <Input
              data-testid="internal-loot-file"
              value={filePath}
              onChange={(event) => setFilePath(event.target.value)}
              placeholder={t('internal.loot.filePlaceholder')}
              aria-label={t('internal.loot.importAria')}
              disabled={importing}
              className="h-8 font-mono text-[11.5px]"
            />
          </label>
          <label className="flex w-full max-w-[300px] flex-col gap-1">
            <span className="text-[10.5px] font-medium text-foreground/70">
              {t('internal.loot.entryLabel')}
            </span>
            <Input
              data-testid="internal-loot-entry"
              value={entryHost}
              onChange={(event) => setEntryHost(event.target.value)}
              placeholder={t('internal.loot.entryPlaceholder')}
              disabled={importing}
              className="h-8 font-mono text-[11.5px]"
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            data-testid="internal-loot-import"
            disabled={importing}
            className="gap-1.5"
          >
            {importing ? (
              <Loader2 strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileUp strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {importing ? t('internal.loot.importing') : t('internal.loot.import')}
          </Button>
        </form>
      )}

      {loot === null && loading ? (
        <LootSkeleton />
      ) : loot === null ? (
        <EmptyState
          icon={AlertTriangle}
          title={t('internal.loot.loadError')}
          description={error ?? undefined}
        >
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </EmptyState>
      ) : loot.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title={t('internal.loot.empty.title')}
          description={t('internal.loot.empty.description')}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-separate border-spacing-0 text-left">
            <caption className="sr-only">{t('internal.loot.title')}</caption>
            <thead>
              <tr>
                <th scope="col" className={INTERNAL_TH}>
                  {t('internal.loot.columns.filename')}
                </th>
                <th scope="col" className={cn(INTERNAL_TH, 'w-[132px]')}>
                  {t('internal.loot.columns.format')}
                </th>
                <th scope="col" className={cn(INTERNAL_TH, 'w-[104px]')}>
                  {t('internal.loot.columns.status')}
                </th>
                <th scope="col" className={cn(INTERNAL_TH, 'w-[240px]')}>
                  {t('internal.loot.columns.summary')}
                </th>
                <th scope="col" className={cn(INTERNAL_TH, 'hidden w-[200px] xl:table-cell')}>
                  {t('internal.loot.columns.entry')}
                </th>
                <th scope="col" className={cn(INTERNAL_TH, 'w-[112px]')}>
                  {t('internal.loot.columns.createdAt')}
                </th>
              </tr>
            </thead>
            <tbody>
              {loot.map((row) => {
                const warnings = row.summary.warnings.length
                return (
                  <tr
                    key={row.id}
                    data-testid="internal-loot-row"
                    data-status={row.status}
                    data-loot-id={row.id}
                  >
                    <td className={INTERNAL_TD}>
                      <span
                        className="block truncate font-mono text-[11.5px] text-foreground"
                        title={row.filename}
                      >
                        {row.filename}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                        {row.sha256 ? row.sha256.slice(0, 16) : row.parser || '—'}
                      </span>
                      {row.error.trim().length > 0 ? (
                        <span className="mt-1 block break-all text-[10.5px] text-red-700">
                          {t('internal.loot.error', { error: row.error })}
                        </span>
                      ) : null}
                    </td>
                    <td className={INTERNAL_TD}>
                      <span className="font-mono text-[10.5px] text-muted-foreground">
                        {row.format || t('internal.loot.format.unknown')}
                      </span>
                    </td>
                    <td className={INTERNAL_TD}>
                      <span
                        className={cn(
                          'inline-flex h-[20px] items-center rounded-full border px-1.5 text-[10.5px] font-medium',
                          LOOT_STATUS_STYLES[row.status]
                        )}
                      >
                        {t(`internal.loot.status.${row.status}`)}
                      </span>
                    </td>
                    <td className={INTERNAL_TD}>
                      <span className="block font-mono text-[10.5px] tabular-nums text-foreground/80">
                        {t('internal.loot.summary', {
                          hosts: row.summary.hosts,
                          services: row.summary.services,
                          credentials: row.summary.credentials
                        })}
                      </span>
                      {warnings > 0 || row.summary.needs_review > 0 ? (
                        <span className="mt-0.5 block text-[10px] text-amber-800/80">
                          {t('internal.loot.summaryWarnings', {
                            count: warnings + row.summary.needs_review
                          })}
                        </span>
                      ) : null}
                    </td>
                    <td className={cn(INTERNAL_TD, 'hidden xl:table-cell')}>
                      <span
                        className="block truncate font-mono text-[10.5px] text-muted-foreground"
                        title={row.entry_host_port || undefined}
                      >
                        {row.entry_host_port || t('internal.loot.entryNotRecorded')}
                      </span>
                    </td>
                    <td className={INTERNAL_TD}>
                      <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                        {formatDateTimeFull(row.created_at)}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </InternalPanel>
  )
}
