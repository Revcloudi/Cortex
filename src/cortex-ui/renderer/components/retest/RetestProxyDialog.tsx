import { useEffect, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { PocConfigView } from '@shared/poc'
import { ProxySection } from '@renderer/components/poc/PocConfigPanel'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'

interface RetestProxyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Retest-scoped HTTP proxy configuration. Intentionally independent from any
 * global application proxy; only repeater traffic uses it.
 */
export function RetestProxyDialog({ open, onOpenChange }: RetestProxyDialogProps) {
  const { t } = useI18n()
  const [view, setView] = useState<PocConfigView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const api = getApi()
    if (!api) {
      setError(t('common.apiUnavailable'))
      return
    }
    setError(null)
    api.getPocConfig().then(
      (next) => {
        if (alive) setView(next)
      },
      (cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [open, t])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[85] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content className="sheet-content fixed left-1/2 top-1/2 z-[90] flex max-h-[88vh] w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-[15px] font-medium tracking-tight text-foreground">
                {t('retest.proxy.title')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t('retest.proxy.description')}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              aria-label={t('common.close')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            {error !== null ? (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
                {error}
              </p>
            ) : view === null ? (
              <p className="py-4 text-center text-[11.5px] text-muted-foreground">
                {t('common.loading')}
              </p>
            ) : (
              <ProxySection view={view} onSaved={setView} />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
