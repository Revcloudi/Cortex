import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Loader2, Save, Star, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { RepeaterSendResult } from '@shared/repeater'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  deleteRepeaterCollection,
  listRepeaterCollections,
  saveRepeaterCollection,
  type RepeaterCollectionEntry
} from '@renderer/lib/repeaterStoreApi'
import { useI18n } from '@renderer/i18n'
import { getPortalContainer } from '../../../dsh/portal'

interface RepeaterCollectionsDialogProps {
  open: boolean
  /** Saving/loading needs a selected finding; actions are disabled without it. */
  vulnId: string | null
  /** Current editor text, stored verbatim so loading restores the exact bytes. */
  raw: string
  /** Parsed current request, `null` when the editor content cannot be parsed. */
  request: RepeaterSendResult['request'] | null
  /** Last response for the current request, if any. */
  response: RepeaterSendResult['response'] | null
  onOpenChange: (open: boolean) => void
  onLoad: (item: RepeaterCollectionEntry) => void
}

const NAME_MAX = 80

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

/**
 * Named request library for the single Repeater. A favorite keeps the raw
 * editor text plus the parsed request/response so loading it restores the whole
 * workbench state.
 */
export function RepeaterCollectionsDialog({
  open,
  vulnId,
  raw,
  request,
  response,
  onOpenChange,
  onLoad
}: RepeaterCollectionsDialogProps) {
  const { t } = useI18n()
  const [items, setItems] = useState<RepeaterCollectionEntry[]>([])
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await listRepeaterCollections()
      setItems(Array.isArray(next) ? next : [])
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  const canSave = vulnId !== null && request !== null && !saving

  const save = async (): Promise<void> => {
    if (!canSave || vulnId === null || request === null) return
    const trimmed = name.trim()
    if (trimmed === '' || trimmed.length > NAME_MAX) {
      setNameError(t('retest.repeater.favorites.nameInvalid'))
      return
    }
    setSaving(true)
    setNameError(null)
    try {
      await saveRepeaterCollection({
        name: trimmed,
        vulnId,
        raw,
        request,
        ...(response === null ? {} : { response })
      })
      setName('')
      toast.success(t('retest.repeater.favorites.saved'))
      await load()
    } catch (cause) {
      toast.error(
        t('retest.repeater.favorites.saveFailed', { error: describeError(cause) })
      )
    } finally {
      setSaving(false)
    }
  }

  const loadItem = (item: RepeaterCollectionEntry): void => {
    if (vulnId === null) return
    onLoad(item)
    onOpenChange(false)
  }

  const remove = async (item: RepeaterCollectionEntry): Promise<void> => {
    if (vulnId === null || deletingId !== null) return
    setDeletingId(item.id)
    try {
      await deleteRepeaterCollection(item.id)
      toast.success(t('retest.repeater.favorites.deleted'))
      await load()
    } catch (cause) {
      toast.error(
        t('retest.repeater.favorites.deleteFailed', { error: describeError(cause) })
      )
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal container={getPortalContainer()}>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[70] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content
          data-testid="repeater-collections-dialog"
          className="fixed left-1/2 top-1/2 z-[70] flex max-h-[min(82vh,660px)] w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Star aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            <DialogPrimitive.Title className="text-[14px] font-medium tracking-tight text-foreground">
              {t('retest.repeater.favorites.title')}
            </DialogPrimitive.Title>
            <span className="rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[9.5px] tabular-nums text-muted-foreground">
              {items.length}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.close')}
              onClick={() => onOpenChange(false)}
              className="ml-auto"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>
          <DialogPrimitive.Description className="sr-only">
            {t('retest.repeater.favorites.description')}
          </DialogPrimitive.Description>

          <div className="border-b border-border px-4 py-3">
            <label
              htmlFor="repeater-collection-name"
              className="text-[10.5px] font-medium text-foreground"
            >
              {t('retest.repeater.favorites.nameLabel')}
            </label>
            <div className="mt-1.5 flex items-center gap-1.5">
              <Input
                id="repeater-collection-name"
                data-testid="repeater-favorite-name"
                value={name}
                maxLength={NAME_MAX}
                spellCheck={false}
                disabled={saving || vulnId === null}
                placeholder={t('retest.repeater.favorites.namePlaceholder')}
                onChange={(event) => {
                  setName(event.target.value)
                  if (nameError !== null) setNameError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save()
                }}
                className="h-8 min-w-0 flex-1 font-mono text-[11.5px]"
              />
              <Button
                size="sm"
                data-testid="repeater-favorite-save"
                disabled={!canSave}
                onClick={() => void save()}
                className="h-8 shrink-0 gap-1"
              >
                {saving ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {saving
                  ? t('retest.repeater.favorites.saving')
                  : t('retest.repeater.favorites.save')}
              </Button>
            </div>
            {nameError !== null ? (
              <p role="alert" className="mt-1.5 text-[10.5px] text-red-700">
                {nameError}
              </p>
            ) : request === null ? (
              <p className="mt-1.5 text-[10px] leading-relaxed text-amber-800">
                {t('retest.repeater.favorites.invalidRequest')}
              </p>
            ) : (
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                {t('retest.repeater.favorites.saveHint')}
              </p>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading && items.length === 0 ? (
              <p className="flex h-[180px] items-center justify-center gap-2 text-[11.5px] text-muted-foreground">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                {t('retest.repeater.favorites.loading')}
              </p>
            ) : error !== null ? (
              <div className="flex h-[180px] flex-col items-center justify-center gap-2 px-6 text-center">
                <p role="alert" className="text-[11px] leading-relaxed text-red-700">
                  {t('retest.repeater.favorites.error', { error })}
                </p>
                <Button variant="outline" size="xs" onClick={() => void load()}>
                  {t('common.retry')}
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-[180px] flex-col items-center justify-center gap-1.5 text-center">
                <Star aria-hidden="true" className="h-5 w-5 text-muted-foreground/60" />
                <p className="text-[11.5px] text-muted-foreground">
                  {t('retest.repeater.favorites.empty')}
                </p>
                <p className="text-[10px] text-muted-foreground/80">
                  {t('retest.repeater.favorites.emptyHint')}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-stretch gap-1 rounded-md border border-transparent hover:border-border hover:bg-sidebar"
                  >
                    <button
                      type="button"
                      data-testid="repeater-collections-item"
                      data-collection-id={item.id}
                      disabled={vulnId === null}
                      onClick={() => loadItem(item)}
                      aria-label={t('retest.repeater.favorites.loadAria', {
                        name: item.name
                      })}
                      title={item.request.url}
                      className="flex min-w-0 flex-1 flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:bg-accent-soft/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Star
                          aria-hidden="true"
                          className="h-3 w-3 shrink-0 text-accent"
                        />
                        <span className="truncate text-[11.5px] font-medium text-foreground">
                          {item.name}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground">
                          {formatTime(item.createdAt)}
                        </span>
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-[9.5px] text-muted-foreground">
                        <span className="shrink-0 rounded border border-border bg-background px-1 py-0.5 font-mono">
                          {item.request.method}
                        </span>
                        <span className="truncate font-mono">{item.request.url}</span>
                        {item.response === null ? null : (
                          <span className="ml-auto shrink-0 font-mono tabular-nums">
                            {item.response.status}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid="repeater-collection-delete"
                      data-collection-id={item.id}
                      disabled={vulnId === null || deletingId !== null}
                      onClick={() => void remove(item)}
                      aria-label={t('retest.repeater.favorites.deleteAria', {
                        name: item.name
                      })}
                      className="my-1 flex w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {deletingId === item.id ? (
                        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
            <span className="text-[9.5px] text-muted-foreground">
              {t('retest.repeater.favorites.footerHint')}
            </span>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
