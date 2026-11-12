import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Clock, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  clearRepeaterHistory,
  listRepeaterHistory,
  type RepeaterHistoryEntry
} from '@renderer/lib/repeaterStoreApi'
import { statusTone } from '@renderer/lib/retestResponse'
import { cn } from '@renderer/lib/utils'
import { useI18n } from '@renderer/i18n'
import { getPortalContainer } from '../../../dsh/portal'

interface RepeaterHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Restore both the raw request and the captured response into the editor. */
  onRestore: (item: RepeaterHistoryEntry) => void
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

/**
 * Recent single-Repeater sends (host keeps the newest 50; this asks for 20).
 * Entries are newest first and clicking one restores request + response.
 */
export function RepeaterHistoryDialog({
  open,
  onOpenChange,
  onRestore
}: RepeaterHistoryDialogProps) {
  const { t } = useI18n()
  const [items, setItems] = useState<RepeaterHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await listRepeaterHistory(20)
      setItems(Array.isArray(next) ? next : [])
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  const clearHistory = async (): Promise<void> => {
    if (clearing) return
    setClearing(true)
    try {
      await clearRepeaterHistory()
      setItems([])
      toast.success(t('retest.repeater.history.cleared'))
    } catch (cause) {
      toast.error(
        t('retest.repeater.history.clearFailed', { error: describeError(cause) })
      )
    } finally {
      setClearing(false)
    }
  }

  const restore = (item: RepeaterHistoryEntry): void => {
    onRestore(item)
    onOpenChange(false)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal container={getPortalContainer()}>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[70] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content
          data-testid="repeater-history-dialog"
          className="fixed left-1/2 top-1/2 z-[70] flex max-h-[min(80vh,620px)] w-[min(600px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Clock aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            <DialogPrimitive.Title className="text-[14px] font-medium tracking-tight text-foreground">
              {t('retest.repeater.history.title')}
            </DialogPrimitive.Title>
            {loaded && error === null ? (
              <span className="rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[9.5px] tabular-nums text-muted-foreground">
                {items.length}
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('retest.repeater.history.refresh')}
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={cn('h-3.5 w-3.5', loading && 'animate-spin')}
                />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('common.close')}
                onClick={() => onOpenChange(false)}
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <DialogPrimitive.Description className="sr-only">
            {t('retest.repeater.history.description')}
          </DialogPrimitive.Description>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading && items.length === 0 ? (
              <p className="flex h-[200px] items-center justify-center gap-2 text-[11.5px] text-muted-foreground">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                {t('retest.repeater.history.loading')}
              </p>
            ) : error !== null ? (
              <div className="flex h-[200px] flex-col items-center justify-center gap-2 px-6 text-center">
                <p role="alert" className="text-[11px] leading-relaxed text-red-700">
                  {t('retest.repeater.history.error', { error })}
                </p>
                <Button variant="outline" size="xs" onClick={() => void load()}>
                  {t('common.retry')}
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-[200px] flex-col items-center justify-center gap-1.5 text-center">
                <Clock aria-hidden="true" className="h-5 w-5 text-muted-foreground/60" />
                <p className="text-[11.5px] text-muted-foreground">
                  {t('retest.repeater.history.empty')}
                </p>
                <p className="text-[10px] text-muted-foreground/80">
                  {t('retest.repeater.history.emptyHint')}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => {
                  const status = item.response === null ? null : item.response.status
                  const time = formatTime(item.createdAt)
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        data-testid="repeater-history-item"
                        onClick={() => restore(item)}
                        aria-label={t('retest.repeater.history.itemAria', {
                          method: item.request.method,
                          url: item.request.url,
                          status: status === null ? t('retest.repeater.history.noResponse') : status,
                          time
                        })}
                        title={item.request.url}
                        className="flex w-full flex-col gap-1 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-sidebar focus-visible:border-accent/50 focus-visible:bg-accent-soft/40 focus-visible:outline-none"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-foreground">
                            {item.request.method}
                          </span>
                          {status === null ? (
                            <span className="shrink-0 text-[9.5px] text-muted-foreground">
                              {t('retest.repeater.history.noResponse')}
                            </span>
                          ) : (
                            <span
                              className={cn(
                                'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9.5px] tabular-nums',
                                statusTone(status)
                              )}
                            >
                              {status}
                            </span>
                          )}
                          <span className="truncate font-mono text-[10.5px] text-foreground">
                            {item.request.url}
                          </span>
                          <span className="ml-auto shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground">
                            {time}
                          </span>
                        </span>
                        <span className="flex items-center gap-2 text-[9.5px] text-muted-foreground">
                          <span className="truncate font-mono">
                            {item.vulnId.trim() === ''
                              ? t('retest.repeater.history.noVuln')
                              : item.vulnId}
                          </span>
                          <span className="ml-auto shrink-0">
                            {t('retest.repeater.history.restore')}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
            <span className="text-[9.5px] text-muted-foreground">
              {t('retest.repeater.history.footerHint')}
            </span>
            <Button
              variant="outline"
              size="xs"
              data-testid="repeater-history-clear"
              disabled={items.length === 0 || loading || clearing}
              onClick={() => void clearHistory()}
              className="shrink-0 gap-1 text-muted-foreground"
            >
              {clearing ? (
                <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 aria-hidden="true" className="h-3 w-3" />
              )}
              {t('retest.repeater.history.clear')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
