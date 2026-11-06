import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { SnapshotSession } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import { useI18n } from '@renderer/i18n'

interface DeleteSnapshotDialogProps {
  open: boolean
  session: SnapshotSession | null
  onOpenChange: (open: boolean) => void
  /** Called after the server confirmed the delete (sheets are already closing). */
  onDeleted: () => void
}

/**
 * Focus-managed confirmation for deleting one snapshot session.
 *
 * Deleting a project session also removes its child sessions, so the cascade
 * count is spelled out before the destructive action. Vulnerability records and
 * asset-library entries referenced by the session are never touched.
 */
export function DeleteSnapshotDialog({
  open,
  session,
  onOpenChange,
  onDeleted
}: DeleteSnapshotDialogProps) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)

  if (!session) return null

  const cascadeCount = session.child_count

  const handleConfirm = async () => {
    if (pending) return
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }

    setPending(true)
    try {
      const result = await api.deleteSnapshot(session.session_id)
      toast(t('snapshot.delete.deleted', { count: result.deleted }))
      onDeleted()
    } catch (cause) {
      toast.error(toErrorMessage(cause, t))
    } finally {
      setPending(false)
    }
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[70] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <DialogPrimitive.Title className="text-[16px] font-medium tracking-tight text-foreground">
            {t('snapshot.delete.title')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {t('snapshot.delete.bodyLead')}{' '}
            <span className="break-all font-mono text-[11.5px] text-foreground">
              {session.project_name}
            </span>{' '}
            {t('snapshot.delete.bodyTail')}
            <span className="break-all font-mono text-[11.5px] text-foreground">
              {t('snapshot.delete.idOpen')}
              {session.session_id}
              {t('snapshot.delete.idClose')}
            </span>
            {t('snapshot.delete.bodyEnd')}
            {cascadeCount > 0 ? (
              <>
                {' '}
                {t('snapshot.delete.cascadeLead')}{' '}
                <span className="font-mono tabular-nums text-foreground">{cascadeCount}</span>{' '}
                {t('snapshot.delete.cascadeTail')}
              </>
            ) : null}{' '}
            {t('snapshot.delete.footnote')}
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
              data-testid="snapshot-delete-confirm"
              onClick={() => void handleConfirm()}
              disabled={pending}
            >
              {pending ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {pending ? t('snapshot.delete.deleting') : t('snapshot.delete.confirm')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
