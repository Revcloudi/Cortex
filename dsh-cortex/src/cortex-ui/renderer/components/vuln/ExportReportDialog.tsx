import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Download, FolderOpen, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'
import { getPortalContainer } from '../../../dsh/portal'

const STORAGE_KEY = 'cortex.export.dir'

function isAbsoluteLike(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.startsWith('~')) return true
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) return true
  return trimmed.startsWith('/')
}

interface ExportReportDialogProps {
  open: boolean
  /** Number of reports being exported, for the title/confirm label. */
  count: number
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (outputDir: string | undefined) => void
}

/**
 * Export-path picker. The DSH WebView cannot open a native directory picker, so
 * the user types an absolute directory (or leaves it empty for the default
 * `~/.cortex/exports/<timestamp>/`); the Host writes the Markdown there.
 */
export function ExportReportDialog({
  open,
  count,
  pending,
  onOpenChange,
  onConfirm
}: ExportReportDialogProps) {
  const { t } = useI18n()
  const [directory, setDirectory] = useState('')
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (!open) return
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? ''
    setDirectory(stored)
    setInvalid(false)
  }, [open])

  const confirm = (): void => {
    const trimmed = directory.trim()
    if (trimmed !== '' && !isAbsoluteLike(trimmed)) {
      setInvalid(true)
      return
    }
    if (trimmed !== '') window.localStorage.setItem(STORAGE_KEY, trimmed)
    else window.localStorage.removeItem(STORAGE_KEY)
    onConfirm(trimmed === '' ? undefined : trimmed)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal container={getPortalContainer()}>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[70] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content
          data-testid="export-report-dialog"
          className="fixed left-1/2 top-1/2 z-[70] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <DialogPrimitive.Title className="text-[16px] font-medium tracking-tight text-foreground">
            {t('vuln.export.title')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {t('vuln.export.description', { count })}
          </DialogPrimitive.Description>

          <label
            htmlFor="export-output-dir"
            className="mt-4 flex items-center gap-1.5 text-[11.5px] font-medium text-foreground"
          >
            <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            {t('vuln.export.dirLabel')}
          </label>
          <input
            id="export-output-dir"
            data-testid="export-output-dir"
            value={directory}
            spellCheck={false}
            disabled={pending}
            placeholder={t('vuln.export.dirPlaceholder')}
            onChange={(event) => {
              setDirectory(event.target.value)
              if (invalid) setInvalid(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') confirm()
            }}
            className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[11.5px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className={invalid ? 'mt-1.5 text-[10.5px] text-red-700' : 'mt-1.5 text-[10.5px] text-muted-foreground'}>
            {invalid ? t('vuln.export.dirInvalid') : t('vuln.export.dirHint')}
          </p>

          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={confirm} disabled={pending} className="gap-1.5">
              {pending ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {pending ? t('vuln.detail.exporting') : t('vuln.export.confirm')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
