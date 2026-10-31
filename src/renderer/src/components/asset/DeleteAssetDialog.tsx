import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'

interface DeleteAssetDialogProps {
  open: boolean
  hostPort: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/**
 * Focus-managed confirmation for deleting one asset context.
 *
 * Only the asset-library row is removed: vulnerability records and snapshot
 * sessions keep their own data and references.
 */
export function DeleteAssetDialog({
  open,
  hostPort,
  pending,
  onOpenChange,
  onConfirm
}: DeleteAssetDialogProps) {
  const { t } = useI18n()

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[70] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <DialogPrimitive.Title className="text-[16px] font-medium tracking-tight text-foreground">
            {t('asset.delete.title')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {t('asset.delete.descriptionBefore')}{' '}
            <span className="break-all font-mono text-[11.5px] text-foreground">{hostPort}</span>{' '}
            {t('asset.delete.descriptionAfter')}
          </DialogPrimitive.Description>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="asset-delete-confirm"
              onClick={onConfirm}
              disabled={pending}
            >
              {pending ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {pending ? t('asset.delete.deleting') : t('asset.delete.confirm')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
