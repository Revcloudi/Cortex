import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Download, FolderOpen, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ExportReportFormat } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { getPortalContainer } from '../../../dsh/portal'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'

const STORAGE_KEY = 'cortex.export.dir'
const FORMAT_KEY = 'cortex.export.format'

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
  onConfirm: (outputDir: string | undefined, format: ExportReportFormat) => void
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
  const [format, setFormat] = useState<ExportReportFormat>('md')
  const [invalid, setInvalid] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? ''
    const storedFormat = window.localStorage.getItem(FORMAT_KEY)
    setDirectory(stored)
    setFormat(storedFormat === 'docx' || storedFormat === 'pdf' ? storedFormat : 'md')
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
    window.localStorage.setItem(FORMAT_KEY, format)
    onConfirm(trimmed === '' ? undefined : trimmed, format)
  }

  const formats: Array<{ value: ExportReportFormat; label: string; testId: string }> = [
    { value: 'md', label: t('vuln.export.formatMd'), testId: 'export-format-md' },
    { value: 'docx', label: t('vuln.export.formatDocx'), testId: 'export-format-docx' },
    { value: 'pdf', label: t('vuln.export.formatPdf'), testId: 'export-format-pdf' },
  ]

  return (
    <>
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
            <DialogPrimitive.Description className="sr-only">
              {t('vuln.export.title')}
            </DialogPrimitive.Description>

            <div className="mt-4">
              <p className="text-[11.5px] font-medium text-foreground">{t('vuln.export.formatLabel')}</p>
              <div
                role="radiogroup"
                aria-label={t('vuln.export.formatLabel')}
                className="mt-1.5 inline-flex rounded-md border border-border bg-muted p-0.5"
              >
                {formats.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={format === item.value}
                    data-testid={item.testId}
                    disabled={pending}
                    onClick={() => setFormat(item.value)}
                    className={cn(
                      'h-7 rounded px-2.5 text-[11.5px] transition-colors',
                      format === item.value
                        ? 'bg-background font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <label
              htmlFor="export-output-dir"
              className="mt-4 flex items-center gap-1.5 text-[11.5px] font-medium text-foreground"
            >
              <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              {t('vuln.export.dirLabel')}
            </label>
            <div className="mt-1.5 flex items-center gap-1.5">
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
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-[11.5px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button
                variant="outline"
                size="sm"
                data-testid="export-browse-dir"
                disabled={pending}
                onClick={() => setPickerOpen(true)}
                className="h-9 shrink-0 gap-1.5"
              >
                <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
                {t('vuln.export.browse')}
              </Button>
            </div>
            {invalid ? (
              <p className="mt-1.5 text-[10.5px] text-red-700">{t('vuln.export.dirInvalid')}</p>
            ) : null}

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

      <DirectoryPickerDialog
        open={pickerOpen}
        initialPath={directory}
        onOpenChange={setPickerOpen}
        onSelect={(path) => {
          setDirectory(path)
          setInvalid(false)
          setPickerOpen(false)
        }}
      />
    </>
  )
}
