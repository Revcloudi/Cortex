import * as DialogPrimitive from '@radix-ui/react-dialog'
import { FileInput, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { parseCurlCommand, type CurlParseErrorCode } from '@renderer/lib/curl'
import { useI18n } from '@renderer/i18n'
import { getPortalContainer } from '../../../dsh/portal'

interface CurlImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Receives the raw HTTP request text to replace the editor content. */
  onApply: (raw: string) => void
}

/**
 * Paste a curl command and turn it into the raw request editor format.
 * Parsing is offline and best effort; unsupported options are ignored.
 */
export function CurlImportDialog({
  open,
  onOpenChange,
  onApply
}: CurlImportDialogProps) {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
  }, [open])

  const errorMessage = (code: CurlParseErrorCode): string => {
    switch (code) {
      case 'empty':
        return t('retest.repeater.curl.empty')
      case 'no-url':
        return t('retest.repeater.curl.noUrl')
      case 'unterminated-quote':
        return t('retest.repeater.curl.unterminatedQuote')
    }
  }

  const apply = (): void => {
    if (busy) return
    setBusy(true)
    try {
      const result = parseCurlCommand(input)
      if (!result.ok) {
        setError(errorMessage(result.code))
        return
      }
      setError(null)
      onApply(result.raw)
      toast.success(t('retest.repeater.curl.applied'))
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal container={getPortalContainer()}>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[70] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content
          data-testid="repeater-curl-dialog"
          className="fixed left-1/2 top-1/2 z-[70] w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div className="flex items-start gap-2">
            <FileInput
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-[14px] font-medium tracking-tight text-foreground">
                {t('retest.repeater.curl.importTitle')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                {t('retest.repeater.curl.importDescription')}
              </DialogPrimitive.Description>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.close')}
              onClick={() => onOpenChange(false)}
              className="ml-auto shrink-0"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>

          <label
            htmlFor="repeater-curl-input"
            className="mt-4 block text-[10.5px] font-medium text-foreground"
          >
            {t('retest.repeater.curl.inputLabel')}
          </label>
          <textarea
            id="repeater-curl-input"
            data-testid="repeater-curl-input"
            aria-label={t('retest.repeater.curl.inputLabel')}
            value={input}
            spellCheck={false}
            autoFocus
            onChange={(event) => {
              setInput(event.target.value)
              if (error !== null) setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                apply()
              }
            }}
            placeholder={t('retest.repeater.curl.inputPlaceholder')}
            className="mt-1.5 min-h-[170px] w-full resize-y rounded-lg border border-border bg-[hsl(var(--code))] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[hsl(220_14%_92%)] caret-[hsl(174_77%_45%)] placeholder:text-[hsl(220_10%_62%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
            {t('retest.repeater.curl.importHint')}
          </p>
          {error !== null ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-red-700"
            >
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              data-testid="repeater-curl-parse"
              disabled={busy}
              onClick={apply}
              className="gap-1.5"
            >
              {busy ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileInput aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {t('retest.repeater.curl.parse')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
