import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ArrowUp, Folder, FolderCheck, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { getPortalContainer } from '../../../dsh/portal'

interface DirectoryListing {
  path: string
  parent: string | null
  directories: Array<{ name: string; path: string }>
  home: string
}

interface DirectoryPickerDialogProps {
  open: boolean
  initialPath?: string
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
}

async function listDirectories(path: string): Promise<DirectoryListing> {
  const query = path.trim() === '' ? '' : `?path=${encodeURIComponent(path.trim())}`
  const response = await fetch(`/cortex-api/cortex/fs/list${query}`)
  const payload = (await response.json().catch(() => null)) as
    | (DirectoryListing & { error?: string })
    | null
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`)
  }
  return payload as DirectoryListing
}

/**
 * Server-backed folder picker: the browser cannot reveal absolute directory
 * paths for a text export dialog, so the Host lists folders and this dialog
 * returns the chosen absolute path.
 */
export function DirectoryPickerDialog({
  open,
  initialPath = '',
  onOpenChange,
  onSelect
}: DirectoryPickerDialogProps) {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [directories, setDirectories] = useState<Array<{ name: string; path: string }>>([])
  const [manual, setManual] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (target: string) => {
      setLoading(true)
      setError(null)
      try {
        const listing = await listDirectories(target)
        setCurrent(listing.path)
        setParent(listing.parent)
        setDirectories(listing.directories)
        setManual(listing.path)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    if (!open) return
    void load(initialPath)
    // Only reload when the dialog opens; user navigation is handled locally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal container={getPortalContainer()}>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[80] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content
          data-testid="directory-picker-dialog"
          className="fixed left-1/2 top-1/2 z-[80] flex w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-background p-5 shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <DialogPrimitive.Title className="text-[16px] font-medium tracking-tight text-foreground">
            {t('vuln.dirPicker.title')}
          </DialogPrimitive.Title>

          <div className="mt-3 flex items-center gap-1.5">
            <input
              data-testid="directory-picker-path"
              value={manual}
              spellCheck={false}
              onChange={(event) => setManual(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void load(manual)
              }}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-[11.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              variant="outline"
              size="xs"
              onClick={() => void load(manual)}
              disabled={loading}
              className="h-8 gap-1 px-2.5"
            >
              {t('vuln.dirPicker.go')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              data-testid="directory-picker-up"
              onClick={() => {
                if (parent !== null) void load(parent)
              }}
              disabled={loading || parent === null}
              className="h-8 gap-1 px-2.5"
            >
              <ArrowUp aria-hidden="true" className="h-3 w-3" />
              {t('vuln.dirPicker.up')}
            </Button>
          </div>

          <div className="mt-3 max-h-[320px] min-h-[180px] overflow-y-auto rounded-lg border border-border">
            {loading ? (
              <p className="flex h-[180px] items-center justify-center gap-2 text-[11.5px] text-muted-foreground">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                {t('vuln.dirPicker.loading')}
              </p>
            ) : error !== null ? (
              <p className="p-3 text-[11.5px] text-red-700">
                {t('vuln.dirPicker.error', { error })}
              </p>
            ) : directories.length === 0 ? (
              <p className="flex h-[180px] items-center justify-center text-[11.5px] text-muted-foreground">
                {t('vuln.dirPicker.empty')}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {directories.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      data-testid="directory-picker-entry"
                      onClick={() => void load(entry.path)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                        'hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none'
                      )}
                    >
                      <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                      <span className="truncate text-[12px] text-foreground">{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground" title={current}>
              {current}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                data-testid="directory-picker-select"
                disabled={loading || error !== null || current === ''}
                onClick={() => onSelect(current)}
                className="gap-1.5"
              >
                <FolderCheck aria-hidden="true" className="h-3.5 w-3.5" />
                {t('vuln.dirPicker.select')}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
