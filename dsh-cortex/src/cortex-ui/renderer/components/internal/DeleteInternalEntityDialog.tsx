import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'
import { getPortalContainer } from '../../../dsh/portal'

interface DeleteInternalEntityDialogProps {
  open: boolean
  label: string
  kind: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/** Confirmation for deleting one internal-scope entity (host/service/etc.). */
export function DeleteInternalEntityDialog({
  open,
  label,
  kind,
  pending,
  onOpenChange,
  onConfirm
}: DeleteInternalEntityDialogProps) {
  const { t } = useI18n()

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal container={getPortalContainer()}>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[70] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content
          data-testid="internal-delete-dialog"
          className="fixed left-1/2 top-1/2 z-[70] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <DialogPrimitive.Title className="text-[16px] font-medium tracking-tight text-foreground">
            {t('internal.delete.title', { kind })}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1.5 break-words text-[12.5px] leading-relaxed text-muted-foreground">
            {t('internal.delete.description', { label })}
          </DialogPrimitive.Description>
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-900">
            {t('internal.delete.warning')}
          </p>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="internal-delete-confirm"
              onClick={onConfirm}
              disabled={pending}
            >
              {pending ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {pending ? t('internal.delete.deleting') : t('internal.delete.confirm')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
