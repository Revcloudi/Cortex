import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ShieldAlert } from 'lucide-react'
import type { PocConfigView } from '@shared/poc'
import {
  ProviderForm,
  ProvidersSection
} from '@renderer/components/poc/PocConfigPanel'
import { usePocErrorMessage } from '@renderer/components/poc/usePocErrorMessage'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'

/**
 * Inline AI provider configuration. Moved out of the retest lab dialog and into
 * its own main-area page so the model settings live with the rest of the app.
 * The retest proxy is intentionally absent here; it lives on the retest page.
 */
export function AiConfigPage() {
  const { t } = useI18n()
  const formatError = usePocErrorMessage()
  const [view, setView] = useState<PocConfigView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)

  useEffect(() => {
    const api = getApi()
    if (!api) {
      setError(t('common.apiUnavailable'))
      return
    }
    let alive = true
    api.getPocConfig().then(
      (next) => {
        if (!alive) return
        setView(next)
        setError(next.permissionWarning)
      },
      (cause: unknown) => {
        if (alive) setError(formatError(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [formatError, t])

  const editingProvider =
    editingId !== null && editingId !== 'new' && view !== null
      ? view.providers.find((provider) => provider.id === editingId) ?? null
      : null

  return (
    <div data-testid="ai-config-page" className="mx-auto flex h-full min-h-0 w-full max-w-[1040px] flex-col px-8 py-4">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t('retest.aiConfig.eyebrow')}
          </p>
          <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight text-foreground">
            {t('retest.aiConfig.nav')}
          </h1>
          <p className="mt-1 text-[11.5px] text-muted-foreground">{t('retest.aiConfig.description')}</p>
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {error !== null && view === null ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-700">
            {error}
          </p>
        ) : view === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {error !== null ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-200/80 bg-amber-50 px-2.5 py-1.5">
                <ShieldAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
                <p className="min-w-0 break-words text-[10.5px] leading-relaxed text-amber-900">{error}</p>
              </div>
            ) : null}
            <ProvidersSection
              view={view}
              editingId={editingId}
              onEditingIdChange={setEditingId}
              onViewChanged={(next, message) => {
                setView(next)
                setError(next.permissionWarning)
                if (message !== null) toast.success(message)
                setEditingId(null)
              }}
              onError={(message) => toast.error(message)}
            />
            {editingId !== null ? (
              <ProviderForm
                key={editingId}
                view={view}
                provider={editingProvider}
                onSaved={(next, message) => {
                  setView(next)
                  setError(next.permissionWarning)
                  toast.success(message)
                  setEditingId(null)
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
