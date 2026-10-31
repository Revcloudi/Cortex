import { useState } from 'react'
import { Database, Loader2, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'
import { DATABASE_CHANGED_EVENT, getApi, toErrorMessage } from '@renderer/lib/api'

interface DatabasePickerProps {
  currentPath: string | null
  onClose: () => void
}

/**
 * Sidebar database chooser.
 *
 * The desktop app can attach any Cortex SQLite file for browsing; agents keep
 * using the default database. Switching re-registers the main-process IPC
 * handlers against the new `DatabaseService` and pushes `data:changed`.
 */
export function DatabasePicker({ currentPath, onClose }: DatabasePickerProps) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = async (action: 'choose' | 'reset'): Promise<void> => {
    const api = getApi()
    if (!api) {
      setError(t('common.apiUnavailable'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result =
        action === 'choose' ? await api.chooseDatabase() : await api.resetDatabase()
      if (result.cancelled) return
      if (result.error !== null) {
        setError(t('dbPicker.failed', { error: result.error }))
        return
      }
      window.dispatchEvent(new Event(DATABASE_CHANGED_EVENT))
      onClose()
    } catch (cause) {
      setError(t('dbPicker.failed', { error: toErrorMessage(cause, t) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('dbPicker.title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-6"
    >
      <div className="w-full max-w-[540px] rounded-[10px] border border-border bg-background shadow-[0_24px_80px_-24px_rgba(15,23,42,0.35)]">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <Database aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h2 className="text-[15px] font-medium tracking-tight text-foreground">
                {t('dbPicker.title')}
              </h2>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                {t('dbPicker.description')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('dbPicker.cancel')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-[10.5px] text-muted-foreground">{t('dbPicker.current')}</p>
          <p className="mt-1 break-all rounded-md border border-border bg-sidebar px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground">
            {currentPath ?? '—'}
          </p>
          {error !== null ? (
            <p className="mt-3 text-[11.5px] leading-relaxed text-red-700">{error}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('dbPicker.cancel')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void apply('reset')} disabled={busy}>
            {t('dbPicker.reset')}
          </Button>
          <Button size="sm" onClick={() => void apply('choose')} disabled={busy}>
            {busy ? <Loader2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {busy ? t('dbPicker.busy') : t('dbPicker.choose')}
          </Button>
        </div>
      </div>
    </div>
  )
}
