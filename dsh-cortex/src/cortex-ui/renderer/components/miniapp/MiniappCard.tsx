import type { MouseEvent as ReactMouseEvent } from 'react'
import { Archive, Download, FileSearch, FolderOpen, Loader2, ScanSearch } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { formatBytes, formatDateTime } from '@renderer/lib/format'
import type { MiniappRow, MiniappStatus } from '@renderer/lib/miniappApi'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

/** Quiet tinted chips matching the rest of the app's status badges. */
const STATUS_STYLES: Record<MiniappStatus, { badge: string; dot: string }> = {
  detected: {
    badge: 'border-sky-200/70 bg-sky-50 text-sky-700',
    dot: 'bg-sky-500'
  },
  decrypting: {
    badge: 'border-amber-200/70 bg-amber-50 text-amber-800',
    dot: 'bg-amber-500 animate-pulse'
  },
  unpacked: {
    badge: 'border-emerald-200/70 bg-emerald-50 text-emerald-700',
    dot: 'bg-emerald-500'
  },
  unsupported: {
    badge: 'border-orange-200/70 bg-orange-50 text-orange-700',
    dot: 'bg-orange-500'
  },
  failed: {
    badge: 'border-red-200/70 bg-red-50 text-red-700',
    dot: 'bg-red-500'
  }
}

export function MiniappStatusBadge({ status }: { status: MiniappStatus }) {
  const { t } = useI18n()
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.failed
  return (
    <Badge className={cn(style.badge, 'whitespace-nowrap')}>
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      {t(`miniapp.status.${status}`)}
    </Badge>
  )
}

export function MiniappFormatBadge({ format }: { format: string }) {
  const { t } = useI18n()
  const known = format === 'plain' || format === 'v1mmwx' || format === 'unknown'
  return (
    <Badge variant="outline" className="whitespace-nowrap font-mono text-[10px]">
      {t(`miniapp.format.${known ? format : 'unknown'}`)}
    </Badge>
  )
}

export type MiniappCardAction = 'unpack' | 'analyze' | 'import' | 'open'

interface MiniappCardProps {
  item: MiniappRow
  /** An unpack/analyze/import request for this source is in flight. */
  busy: boolean
  busyAction: MiniappCardAction | null
  onOpen: (item: MiniappRow) => void
  onUnpack: (item: MiniappRow) => void
  onAnalyze: (item: MiniappRow) => void
  onImport: (item: MiniappRow) => void
  onOpenDir: (item: MiniappRow) => void
}

/**
 * One detected wxapkg source row: identity, version/size/format/status plus the
 * five source actions. The row itself is a button-like surface that opens the
 * detail sheet; the action buttons stop propagation so they never race it.
 */
export function MiniappCard({
  item,
  busy,
  busyAction,
  onOpen,
  onUnpack,
  onAnalyze,
  onImport,
  onOpenDir
}: MiniappCardProps) {
  const { t } = useI18n()
  const unpacked = item.status === 'unpacked'
  const error = (item.error ?? '').trim()
  const failed = item.status === 'unsupported' || item.status === 'failed'
  const versionLabel =
    (item.version ?? '').trim().length > 0
      ? t('miniapp.card.version', { version: item.version })
      : t('miniapp.card.noVersion')
  const versionCount = item.version_count ?? 1
  const appName = (item.app_name ?? '').trim()
  const title = appName.length > 0 ? appName : item.appid

  const stop = (event: ReactMouseEvent) => event.stopPropagation()
  const run = (event: ReactMouseEvent, handler: (item: MiniappRow) => void) => {
    event.stopPropagation()
    handler(item)
  }

  return (
    <li className="border-b border-border last:border-b-0">
      <div
        data-testid="miniapp-row"
        data-miniapp-id={item.id}
        data-status={item.status}
        role="button"
        tabIndex={0}
        aria-label={title}
        onClick={() => onOpen(item)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen(item)
          }
        }}
        className="flex cursor-pointer flex-col gap-2 px-4 py-3 transition-colors duration-150 hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-[12.5px] font-medium text-foreground">{title}</span>
          <MiniappStatusBadge status={item.status} />
          <MiniappFormatBadge format={item.format} />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted-foreground">
          {appName.length > 0 && item.appid !== title ? (
            <span className="truncate">{item.appid}</span>
          ) : null}
          <span className="tabular-nums">{versionLabel}</span>
          {versionCount > 1 ? (
            <span className="tabular-nums">{t('miniapp.card.versions', { count: versionCount })}</span>
          ) : null}
          <span className="tabular-nums">{formatBytes(item.size_bytes)}</span>
          {item.file_count > 0 ? (
            <span className="tabular-nums">{t('miniapp.card.files', { count: item.file_count })}</span>
          ) : null}
          <span className="tabular-nums">{t('miniapp.card.updated', { time: formatDateTime(item.updated_at) })}</span>
          <span className="min-w-0 truncate" title={item.package_dir}>
            {item.root_kind}
          </span>
        </div>

        {failed && error.length > 0 ? (
          <p role="alert" className="break-all rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[10.5px] leading-relaxed text-red-700">
            {t('miniapp.card.errorLabel', { error })}
          </p>
        ) : null}

        <div
          className="flex flex-wrap items-center gap-1.5"
          onClick={stop}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Button
            variant="outline"
            size="xs"
            data-testid="miniapp-unpack"
            data-miniapp-id={item.id}
            disabled={busy}
            onClick={(event) => run(event, onUnpack)}
            className="gap-1.5"
          >
            {busy && busyAction === 'unpack' ? (
              <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            ) : (
              <Archive aria-hidden="true" className="h-3 w-3" />
            )}
            {busy && busyAction === 'unpack'
              ? t('miniapp.action.unpacking')
              : t('miniapp.action.unpack')}
          </Button>
          <Button
            variant="outline"
            size="xs"
            data-testid="miniapp-browse"
            data-miniapp-id={item.id}
            disabled={!unpacked}
            onClick={(event) => run(event, onOpen)}
            className="gap-1.5"
          >
            <FileSearch aria-hidden="true" className="h-3 w-3" />
            {t('miniapp.action.browse')}
          </Button>
          <Button
            variant="outline"
            size="xs"
            data-testid="miniapp-analyze"
            data-miniapp-id={item.id}
            disabled={!unpacked || busy}
            onClick={(event) => run(event, onAnalyze)}
            className="gap-1.5"
          >
            {busy && busyAction === 'analyze' ? (
              <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            ) : (
              <ScanSearch aria-hidden="true" className="h-3 w-3" />
            )}
            {busy && busyAction === 'analyze'
              ? t('miniapp.action.analyzing')
              : t('miniapp.action.analyze')}
          </Button>
          <Button
            variant="outline"
            size="xs"
            data-testid="miniapp-import"
            data-miniapp-id={item.id}
            disabled={!unpacked || busy}
            onClick={(event) => run(event, onImport)}
            className="gap-1.5"
          >
            {busy && busyAction === 'import' ? (
              <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            ) : (
              <Download aria-hidden="true" className="h-3 w-3" />
            )}
            {busy && busyAction === 'import'
              ? t('miniapp.action.importing')
              : t('miniapp.action.import')}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            data-testid="miniapp-open"
            data-miniapp-id={item.id}
            disabled={!unpacked || busy}
            onClick={(event) => run(event, onOpenDir)}
            className="gap-1.5"
          >
            {busy && busyAction === 'open' ? (
              <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            ) : (
              <FolderOpen aria-hidden="true" className="h-3 w-3" />
            )}
            {busy && busyAction === 'open'
              ? t('miniapp.action.opening')
              : t('miniapp.action.openDir')}
          </Button>
        </div>
      </div>
    </li>
  )
}
