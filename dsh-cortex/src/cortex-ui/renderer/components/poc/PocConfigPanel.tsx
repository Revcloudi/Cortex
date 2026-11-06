import { useEffect, useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  Check,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import {
  POC_CREDENTIAL_FIELD_LABELS,
  POC_LIMITS,
  POC_PRESET_LIST,
  POC_PRESETS,
  type PocConfigView,
  type PocCredentialField,
  type PocExecutionLimits,
  type PocPresetId,
  type PocProviderView
} from '@shared/poc'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { usePocErrorMessage } from '@renderer/components/poc/usePocErrorMessage'
import { getApi } from '@renderer/lib/api'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

interface PocConfigPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialConfig: PocConfigView | null
  onConfigChanged: (config: PocConfigView) => void
  /** 'model' hides the retest proxy/limits sections (main-page AI config card). */
  mode?: 'full' | 'model'
  title?: string
}

/**
 * Desktop-only retest lab settings.
 *
 * Write-only semantics: API keys / proxy passwords are entered here, sent once
 * over IPC and never read back. The view only exposes `configured` flags. The
 * panel is the only place where a model is selected — the backend has no
 * built-in default model.
 */
export function PocConfigPanel({
  open,
  onOpenChange,
  initialConfig,
  onConfigChanged,
  mode = 'full',
  title
}: PocConfigPanelProps) {
  const { t } = useI18n()
  const formatError = usePocErrorMessage()
  const [view, setView] = useState<PocConfigView | null>(initialConfig)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)

  const applyView = (next: PocConfigView): void => {
    setView(next)
    onConfigChanged(next)
  }

  // Read the authoritative config every time the dialog opens (and reload on
  // explicit request) so a stale page-level copy never hides saved providers.
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError(null)
    const api = getApi()
    if (!api) {
      setError(t('common.apiUnavailable'))
      setLoading(false)
      return
    }
    api.getPocConfig().then(
      (next) => {
        if (!alive) return
        applyView(next)
        setLoading(false)
      },
      (cause: unknown) => {
        if (!alive) return
        setError(t('retest.config.loadFailed', { error: formatError(cause) }))
        setLoading(false)
      }
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks are stable enough
  }, [open])

  useEffect(() => {
    if (!open) {
      setEditingId(null)
      setError(null)
      setLoading(false)
    }
  }, [open])

  const currentView = view
  const editingProvider =
    editingId !== null && editingId !== 'new' && currentView !== null
      ? currentView.providers.find((provider) => provider.id === editingId) ?? null
      : null

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[85] bg-[hsl(224_18%_10%/0.3)]" />
        <DialogPrimitive.Content
          data-testid="retest-config-panel"
          className="fixed left-1/2 top-1/2 z-[85] flex max-h-[calc(100vh-2.5rem)] w-[min(900px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-[16px] font-medium tracking-tight text-foreground">
                {title ?? t('retest.config.title')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {title ?? t('retest.config.title')}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              aria-label={t('retest.config.close')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {loading && currentView === null ? (
              <div className="flex items-center gap-2 py-10 text-[12px] text-muted-foreground">
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin poc-spinner" />
                {t('retest.config.loading')}
              </div>
            ) : error !== null && currentView === null ? (
              <div className="flex flex-col items-start gap-2 py-8">
                <p role="alert" className="text-[12px] text-red-700">{error}</p>
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  {t('common.close')}
                </Button>
              </div>
            ) : currentView === null ? null : (
              <div className="flex flex-col gap-5">
                {error !== null ? (
                  <p role="alert" className="rounded-md border border-red-200/80 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
                    {error}
                  </p>
                ) : null}

                {currentView.permissionWarning !== null &&
                currentView.permissionWarning.trim() !== '' ? (
                  <div className="flex items-start gap-2 rounded-md border border-amber-200/80 bg-amber-50 px-2.5 py-1.5">
                    <ShieldAlert
                      aria-hidden="true"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700"
                    />
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium text-amber-900">
                        {t('retest.config.meta.permissionTitle')}
                      </p>
                      <p className="mt-0.5 break-words text-[10px] leading-relaxed text-amber-800">
                        {currentView.permissionWarning}
                      </p>
                    </div>
                  </div>
                ) : null}

                <ProvidersSection
                  view={currentView}
                  editingId={editingId}
                  onEditingIdChange={setEditingId}
                  onViewChanged={(next, message) => {
                    applyView(next)
                    if (message !== null) toast.success(message)
                    setEditingId(null)
                  }}
                  onError={(message) => toast.error(message)}
                />

                {editingId !== null ? (
                  <ProviderForm
                    key={editingId}
                    view={currentView}
                    provider={editingProvider}
                    onSaved={(next, message) => {
                      applyView(next)
                      toast.success(message)
                      setEditingId(null)
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : null}

                {mode === 'full' ? (
                  <>
                    <ProxySection view={currentView} onSaved={applyView} />
                    <LimitsSection view={currentView} onSaved={applyView} />
                  </>
                ) : null}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/* ------------------------------------------------------------------------- */
/* Provider list                                                             */
/* ------------------------------------------------------------------------- */

export function ProvidersSection({
  view,
  editingId,
  onEditingIdChange,
  onViewChanged,
  onError
}: {
  view: PocConfigView
  editingId: string | 'new' | null
  onEditingIdChange: (id: string | 'new' | null) => void
  onViewChanged: (next: PocConfigView, message: string | null) => void
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const formatError = usePocErrorMessage()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const setActive = async (provider: PocProviderView): Promise<void> => {
    const api = getApi()
    if (!api) return
    setBusyId(provider.id)
    try {
      const next = await api.savePocConfig({ activeProviderId: provider.id })
      onViewChanged(next, t('retest.config.provider.activated'))
    } catch (cause) {
      onError(t('retest.config.provider.activateFailed', { error: formatError(cause) }))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (provider: PocProviderView): Promise<void> => {
    if (confirmDeleteId !== provider.id) {
      setConfirmDeleteId(provider.id)
      return
    }
    const api = getApi()
    if (!api) return
    setBusyId(provider.id)
    try {
      const next = await api.removePocProvider(provider.id)
      onViewChanged(next, t('retest.config.provider.removed'))
      if (editingId === provider.id) onEditingIdChange(null)
      setConfirmDeleteId(null)
    } catch (cause) {
      onError(t('retest.config.provider.removeFailed', { error: formatError(cause) }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section aria-labelledby="poc-config-providers-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="poc-config-providers-heading"
            className="text-[12.5px] font-medium tracking-tight text-foreground"
          >
            {t('retest.config.section.providers')}
          </h3>
        </div>
        <Button
          variant="outline"
          size="sm"
          data-testid="retest-provider-add"
          onClick={() => onEditingIdChange(editingId === 'new' ? null : 'new')}
          className="gap-1.5"
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          {t('retest.config.provider.add')}
        </Button>
      </div>

      {view.providers.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-border bg-sidebar px-4 py-6">
          <p className="text-[12px] font-medium text-foreground">{t('retest.config.provider.empty')}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t('retest.config.provider.emptyHint')}
          </p>
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {view.providers.map((provider) => {
            const active = provider.id === view.activeProviderId
            const preset = POC_PRESETS[provider.preset]
            const label = provider.label.trim() !== '' ? provider.label : preset.label
            const confirming = confirmDeleteId === provider.id
            return (
              <li
                key={provider.id}
                data-testid="retest-provider-row"
                data-provider-id={provider.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5',
                  active ? 'border-accent/40 bg-accent-soft' : 'border-border bg-background'
                )}
              >
                <input
                  type="radio"
                  name="poc-active-provider"
                  checked={active}
                  disabled={busyId !== null}
                  onChange={() => void setActive(provider)}
                  aria-label={t('retest.config.provider.radioAria', { label })}
                  className="h-3.5 w-3.5 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] font-medium text-foreground">{label}</span>
                    <span className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[9.5px] text-muted-foreground">
                      {preset.id}
                    </span>
                    {active ? (
                      <span className="rounded-full border border-accent/30 bg-background px-1.5 py-0.5 text-[9.5px] font-medium text-accent">
                        {t('retest.config.provider.active')}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground">
                    <span className="font-mono">
                      {provider.model.trim() === ''
                        ? t('retest.config.provider.modelEmpty')
                        : provider.model}
                    </span>
                    {provider.baseUrl.trim() !== '' ? (
                      <span className="max-w-[280px] truncate font-mono text-[10px]" title={provider.baseUrl}>
                        {provider.baseUrl}
                      </span>
                    ) : null}
                    {provider.configured ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <Check aria-hidden="true" className="h-3 w-3" />
                        {t('retest.config.provider.configured')}
                      </span>
                    ) : provider.missingCredentials.length > 0 ? (
                      <span className="inline-flex items-center gap-1 text-amber-800">
                        <ShieldAlert aria-hidden="true" className="h-3 w-3" />
                        {t('retest.config.provider.missingCredentials', {
                          fields: provider.missingCredentials.join(', ')
                        })}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!active ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void setActive(provider)}
                      disabled={busyId !== null}
                      aria-label={t('retest.config.provider.setActiveAria', { label })}
                      className="text-[10.5px]"
                    >
                      {t('retest.config.provider.setActive')}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onEditingIdChange(editingId === provider.id ? null : provider.id)}
                    aria-label={t('retest.config.provider.editAria', { label })}
                    title={t('retest.config.provider.editTitle')}
                  >
                    <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void remove(provider)}
                    disabled={busyId !== null}
                    aria-label={t('retest.config.provider.deleteAria', { label })}
                    title={confirming ? t('retest.config.provider.deleteConfirm') : t('common.delete')}
                    className={cn(
                      'gap-1 text-[10.5px]',
                      confirming && 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-50 hover:text-red-800'
                    )}
                  >
                    {busyId === provider.id ? (
                      <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin poc-spinner" />
                    ) : (
                      <Trash2 aria-hidden="true" className="h-3 w-3" />
                    )}
                    {confirming ? t('retest.config.provider.deleteConfirm') : null}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------- */
/* Provider form (add / edit)                                                */
/* ------------------------------------------------------------------------- */

export function ProviderForm({
  view,
  provider,
  onSaved,
  onCancel
}: {
  view: PocConfigView
  provider: PocProviderView | null
  onSaved: (next: PocConfigView, message: string) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const formatError = usePocErrorMessage()
  const editing = provider !== null
  const [preset, setPreset] = useState<PocPresetId>(provider?.preset ?? 'deepseek')
  const [baseUrl, setBaseUrl] = useState(
    provider?.baseUrl ?? POC_PRESETS[provider?.preset ?? 'deepseek'].defaultBaseUrl
  )
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({})
  const [credentialsDirty, setCredentialsDirty] = useState(false)
  const [model, setModel] = useState(provider?.model ?? '')
  const [timeoutMs, setTimeoutMs] = useState(String(provider?.timeoutMs ?? 60_000))
  const [setActive, setSetActive] = useState(
    provider === null ? view.providers.length === 0 : provider.id === view.activeProviderId
  )
  const [querying, setQuerying] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [queryWarning, setQueryWarning] = useState<string | null>(null)
  const [models, setModels] = useState<{ id: string; label?: string; ownedBy?: string }[] | null>(null)
  const [modelFilter, setModelFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const presetDefinition = POC_PRESETS[preset]
  const requiredFields: readonly PocCredentialField[] = presetDefinition.credentialFields
  const baseUrlRequired = presetDefinition.defaultBaseUrl === ''
  const typedCredentialsComplete = requiredFields.every(
    (field) => (credentialValues[field] ?? '').trim() !== ''
  )
  const savedBaseUrl =
    provider !== null
      ? provider.baseUrl.trim() !== ''
        ? provider.baseUrl.trim()
        : POC_PRESETS[provider.preset].defaultBaseUrl.trim()
      : ''
  // A saved provider keeps its write-only credentials: discovery may reuse them
  // only while preset/base URL stay untouched. Any change needs re-entry because
  // the renderer can never read the saved key back.
  const savedCredentialsUsable =
    editing &&
    !credentialsDirty &&
    provider !== null &&
    provider.missingCredentials.length === 0 &&
    preset === provider.preset &&
    baseUrl.trim() === savedBaseUrl
  const credentialsUsable = typedCredentialsComplete || savedCredentialsUsable
  const canQuery =
    !querying &&
    presetDefinition.modelDiscovery !== 'manual' &&
    baseUrl.trim() !== '' &&
    credentialsUsable
  const credentialConfigured = (field: PocCredentialField): boolean =>
    editing && provider !== null && !provider.missingCredentials.includes(field)
  const modelRequired = model.trim() === ''
  const saveDisabled =
    saving ||
    modelRequired ||
    (baseUrlRequired && baseUrl.trim() === '') ||
    timeoutMs.trim() === '' ||
    !credentialsUsable

  const queryModels = async (): Promise<void> => {
    if (!canQuery) return
    const api = getApi()
    if (!api) return
    setQuerying(true)
    setQueryError(null)
    setQueryWarning(null)
    try {
      const result = await api.listPocModels({
        ...(editing && !credentialsDirty && provider !== null ? { providerId: provider.id } : {}),
        preset,
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
        ...(credentialsDirty && typedCredentialsComplete
          ? {
              credentials: Object.fromEntries(
                requiredFields.map((field) => [field, (credentialValues[field] ?? '').trim()])
              )
            }
          : {})
      })
      setModels(result.models)
      const warning =
        result.warning !== undefined && result.warning.trim() !== '' ? result.warning : null
      if (result.models.length === 0 || result.source === 'manual') {
        setQueryWarning(warning ?? t('retest.config.provider.formQueryEmpty'))
      } else {
        setQueryWarning(warning)
        toast.success(t('retest.config.provider.formQuerySuccess', { count: result.models.length }))
      }
      setModelFilter('')
    } catch (cause) {
      setModels([])
      setQueryError(t('retest.config.provider.formQueryFailed', { error: formatError(cause) }))
    } finally {
      setQuerying(false)
    }
  }

  const invalidateModel = (): void => {
    setModel('')
    setModels(null)
    setModelFilter('')
    setQueryError(null)
    setQueryWarning(null)
  }

  const updateCredential = (field: PocCredentialField, value: string): void => {
    setCredentialValues((previous) => ({ ...previous, [field]: value }))
    setCredentialsDirty(true)
    invalidateModel()
  }

  const changePreset = (next: PocPresetId): void => {
    setPreset(next)
    setBaseUrl(POC_PRESETS[next].defaultBaseUrl)
    invalidateModel()
  }

  const changeBaseUrl = (next: string): void => {
    setBaseUrl(next)
    invalidateModel()
  }

  const save = async (): Promise<void> => {
    if (saveDisabled) return
    const api = getApi()
    if (!api) return
    const parsedTimeout = Number(timeoutMs)
    if (!Number.isFinite(parsedTimeout)) {
      setSaveError(t('retest.config.limits.numberError'))
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const credentials = Object.fromEntries(
        requiredFields
          .map((field) => [field, (credentialValues[field] ?? '').trim()] as const)
          .filter(([, value]) => value !== '')
      )
      const next = await api.upsertPocProvider({
        ...(editing && provider !== null ? { id: provider.id } : {}),
        preset,
        label:
          provider !== null && provider.label.trim() !== ''
            ? provider.label
            : presetDefinition.label,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
        timeoutMs: parsedTimeout,
        setActive
      })
      onSaved(next, t('retest.config.provider.saved'))
    } catch (cause) {
      setSaveError(t('retest.config.provider.saveFailed', { error: formatError(cause) }))
    } finally {
      setSaving(false)
    }
  }

  const filteredModels = useMemo(() => {
    const list = models ?? []
    const needle = modelFilter.trim().toLowerCase()
    if (needle === '') return list
    return list.filter(
      (option) =>
        option.id.toLowerCase().includes(needle) ||
        (option.label ?? '').toLowerCase().includes(needle) ||
        (option.ownedBy ?? '').toLowerCase().includes(needle)
    )
  }, [models, modelFilter])
  const shownModels = filteredModels.slice(0, POC_LIMITS.maxModels)

  return (
    <section
      data-testid="retest-provider-form"
      aria-labelledby="poc-provider-form-heading"
      className="rounded-lg border border-accent/30 bg-background"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
        <h3 id="poc-provider-form-heading" className="text-[12px] font-medium text-foreground">
          {editing ? t('retest.config.provider.editTitle') : t('retest.config.provider.addTitle')}
        </h3>
        <Button variant="ghost" size="xs" onClick={onCancel} className="text-[10.5px]">
          {t('retest.config.provider.formCancel')}
        </Button>
      </div>

      <div className="flex flex-col gap-3 px-3.5 py-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="poc-provider-preset" className="text-[11px] font-medium text-foreground">
              {t('retest.config.provider.formPreset')}
            </label>
            <Select
              value={preset}
              onValueChange={(next) => changePreset(next as PocPresetId)}
              disabled={saving}
            >
              <SelectTrigger
                id="poc-provider-preset"
                data-testid="retest-preset-select"
                aria-label={t('retest.config.provider.formPresetAria')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POC_PRESET_LIST.map((definition) => (
                  <SelectItem key={definition.id} value={definition.id}>
                    {definition.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] leading-relaxed text-muted-foreground">{presetDefinition.hint}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="poc-provider-base-url" className="text-[11px] font-medium text-foreground">
              {t('retest.config.provider.formBaseUrl')}
              {baseUrlRequired ? <span aria-hidden="true" className="ml-1 text-red-600">*</span> : null}
            </label>
            <Input
              id="poc-provider-base-url"
              data-testid="retest-baseurl"
              value={baseUrl}
              onChange={(event) => changeBaseUrl(event.target.value)}
              placeholder={
                baseUrlRequired
                  ? t('retest.config.provider.formBaseUrlExample')
                  : t('retest.config.provider.formBaseUrlPlaceholder')
              }
              disabled={saving}
              spellCheck={false}
              className="font-mono text-[11.5px]"
            />
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {baseUrlRequired
                ? t('retest.config.provider.formBaseUrlRequired')
                : t('retest.config.provider.formBaseUrlHint')}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium text-foreground">
            {t('retest.config.provider.formCredentials')}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {requiredFields.map((field) => (
              <div key={field} className="flex flex-col gap-1">
                <label
                  htmlFor={`poc-credential-${field}`}
                  className="text-[10.5px] text-muted-foreground"
                >
                  {POC_CREDENTIAL_FIELD_LABELS[field]}
                </label>
                <Input
                  id={`poc-credential-${field}`}
                  data-testid={`retest-credential-${field}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={credentialValues[field] ?? ''}
                  onChange={(event) => updateCredential(field, event.target.value)}
                  disabled={saving}
                  placeholder={
                    credentialConfigured(field)
                      ? t('retest.config.provider.formCredentialConfigured')
                      : t('retest.config.provider.formCredentialPlaceholder', {
                          field: POC_CREDENTIAL_FIELD_LABELS[field]
                        })
                  }
                />
              </div>
            ))}
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {t('retest.config.provider.formCredentialHint')}
          </p>
          {credentialsDirty ? (
            <p className="text-[10px] font-medium text-amber-800">
              {t('retest.config.provider.formCredentialsChanged')}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-sidebar px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-medium text-foreground">
              {t('retest.config.provider.formModelSection')}
            </p>
            <Button
              variant="outline"
              size="xs"
              data-testid="retest-query-models"
              onClick={() => void queryModels()}
              disabled={!canQuery}
              title={
                presetDefinition.modelDiscovery === 'manual'
                  ? t('retest.config.provider.formQueryManual')
                  : canQuery
                    ? t('retest.config.provider.formQueryHint')
                    : t('retest.config.provider.formQueryDisabledHint')
              }
              className="gap-1 text-[10.5px]"
            >
              {querying ? (
                <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin poc-spinner" />
              ) : (
                <RefreshCw aria-hidden="true" className="h-3 w-3" />
              )}
              {querying ? t('retest.config.provider.formQuerying') : t('retest.config.provider.formQuery')}
            </Button>
            {querying ? null : (
              <span className="text-[9.5px] text-muted-foreground">
                {presetDefinition.modelDiscovery === 'manual'
                  ? t('retest.config.provider.formQueryManual')
                  : t('retest.config.provider.formQueryHint')}
              </span>
            )}
          </div>

          {queryError !== null ? (
            <p role="alert" className="text-[10.5px] text-red-700">{queryError}</p>
          ) : null}
          {queryWarning !== null ? (
            <p role="status" className="text-[10.5px] leading-relaxed text-amber-800">{queryWarning}</p>
          ) : null}

          {models !== null && models.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] text-muted-foreground">
                {t('retest.config.provider.formModelsTitle', { count: models.length })}
              </p>
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  data-testid="retest-model-search"
                  aria-label={t('retest.config.provider.formModelsFilter')}
                  value={modelFilter}
                  onChange={(event) => setModelFilter(event.target.value)}
                  placeholder={t('retest.config.provider.formModelsFilterPlaceholder')}
                  disabled={saving}
                  className="h-7 pl-8 text-[11px]"
                />
              </div>
              <ul
                aria-label={t('retest.config.provider.formModelsTitle', { count: models.length })}
                className="max-h-[170px] overflow-y-auto rounded-md border border-border bg-background p-1"
              >
                {shownModels.length === 0 ? (
                  <li className="px-2 py-1.5 text-[10.5px] text-muted-foreground">
                    {t('retest.config.provider.formModelsEmpty')}
                  </li>
                ) : (
                  shownModels.map((option) => {
                    const selected = option.id === model
                    return (
                      <li key={option.id} className="list-none">
                        <button
                          type="button"
                          data-testid="retest-model-option"
                          aria-pressed={selected}
                          onClick={() => setModel(option.id)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                            selected ? 'bg-accent-soft text-foreground' : 'hover:bg-muted'
                          )}
                        >
                          {selected ? (
                            <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-accent" />
                          ) : (
                            <span aria-hidden="true" className="h-3 w-3 shrink-0" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">
                            {option.label !== undefined && option.label.trim() !== ''
                              ? option.label
                              : option.id}
                          </span>
                          {option.ownedBy !== undefined ? (
                            <span className="shrink-0 text-[9.5px] text-muted-foreground">
                              {option.ownedBy}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    )
                  })
                )}
              </ul>
              {filteredModels.length > shownModels.length ? (
                <p className="text-[9.5px] text-muted-foreground">
                  {t('retest.config.provider.formModelsCapped', {
                    shown: shownModels.length,
                    total: filteredModels.length
                  })}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <label htmlFor="poc-manual-model" className="text-[10.5px] text-muted-foreground">
              {t('retest.config.provider.formManualModel')}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                id="poc-manual-model"
                data-testid="retest-manual-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={t('retest.config.provider.formManualModelPlaceholder')}
                disabled={saving}
                spellCheck={false}
                aria-invalid={modelRequired}
                className="font-mono text-[11.5px]"
              />
              {model !== '' ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setModel('')}
                  aria-label={t('retest.config.provider.formModelClear')}
                  title={t('retest.config.provider.formModelClear')}
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
            {model !== '' ? (
              <p className="text-[10px] text-emerald-700">
                {t('retest.config.provider.formModelSelected')}:{' '}
                <span className="font-mono">{model}</span>
              </p>
            ) : (
              <p className="text-[10px] leading-relaxed text-amber-800">
                {t('retest.config.provider.formModelRequired')}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="poc-provider-timeout" className="text-[11px] font-medium text-foreground">
              {t('retest.config.provider.formTimeout')}
            </label>
            <Input
              id="poc-provider-timeout"
              type="number"
              min={1_000}
              max={300_000}
              step={1_000}
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(event.target.value)}
              disabled={saving}
              className="font-mono text-[11.5px]"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <label htmlFor="poc-provider-set-active" className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Checkbox
              id="poc-provider-set-active"
              checked={setActive}
              onChange={(event) => setSetActive(event.target.checked)}
              disabled={saving}
            />
            {t('retest.config.provider.formSetActive')}
          </label>
          <div className="flex items-center gap-1.5">
            {saveError !== null ? (
              <p role="alert" className="mr-2 max-w-[320px] text-[10.5px] text-red-700">{saveError}</p>
            ) : !credentialsUsable ? (
              <p className="mr-2 max-w-[260px] text-[10.5px] text-amber-800">
                {t('retest.config.provider.formCredentialsRequired')}
              </p>
            ) : null}
            <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              data-testid="retest-provider-save"
              onClick={() => void save()}
              disabled={saveDisabled}
              title={modelRequired ? t('retest.config.provider.formModelRequired') : undefined}
              className="gap-1.5"
            >
              {saving ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin poc-spinner" /> : null}
              {saving ? t('retest.config.provider.formSaving') : t('retest.config.provider.formSave')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------------- */
/* Proxy                                                                     */
/* ------------------------------------------------------------------------- */

export function ProxySection({
  view,
  onSaved
}: {
  view: PocConfigView
  onSaved: (next: PocConfigView) => void
}) {
  const { t } = useI18n()
  const formatError = usePocErrorMessage()
  const [enabled, setEnabled] = useState(view.proxy.enabled)
  const [url, setUrl] = useState(view.proxy.url)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [caPath, setCaPath] = useState('')
  const [allowInsecureTls, setAllowInsecureTls] = useState(view.proxy.allowInsecureTls)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setEnabled(view.proxy.enabled)
    setUrl(view.proxy.url)
    setAllowInsecureTls(view.proxy.allowInsecureTls)
  }, [view.proxy.enabled, view.proxy.url, view.proxy.allowInsecureTls])

  const save = async (): Promise<void> => {
    const api = getApi()
    if (!api) return
    if (enabled && url.trim() === '') {
      setError(t('retest.config.proxy.urlRequired'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const next = await api.savePocConfig({
        proxy: {
          enabled,
          url: url.trim(),
          ...(username.trim() === '' ? {} : { username: username.trim() }),
          ...(password === '' ? {} : { password }),
          ...(caPath.trim() === '' ? {} : { caPath: caPath.trim() }),
          allowInsecureTls
        }
      })
      setPassword('')
      setCaPath('')
      onSaved(next)
      toast.success(t('retest.config.proxy.saved'))
    } catch (cause) {
      setError(t('retest.config.proxy.saveFailed', { error: formatError(cause) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="poc-config-proxy-heading" className="rounded-lg border border-border bg-background">
      <div className="border-b border-border px-3.5 py-2.5">
        <h3 id="poc-config-proxy-heading" className="text-[12px] font-medium text-foreground">
          {t('retest.config.section.proxy')}
        </h3>
      </div>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <label htmlFor="poc-proxy-enabled" className="flex items-center gap-2 text-[11.5px] text-foreground">
          <Checkbox
            id="poc-proxy-enabled"
            data-testid="retest-proxy-enabled"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={saving}
            aria-label={t('retest.config.proxy.enabledAria')}
          />
          {t('retest.config.proxy.enabled')}
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="poc-proxy-url" className="text-[10.5px] text-muted-foreground">
              {t('retest.config.proxy.url')}
            </label>
            <Input
              id="poc-proxy-url"
              data-testid="retest-proxy-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('retest.config.proxy.urlPlaceholder')}
              disabled={saving}
              spellCheck={false}
              className="font-mono text-[11.5px]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="poc-proxy-username" className="text-[10.5px] text-muted-foreground">
              {t('retest.config.proxy.username')}
            </label>
            <Input
              id="poc-proxy-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t('retest.config.proxy.usernamePlaceholder')}
              disabled={saving}
              autoComplete="off"
              className="font-mono text-[11.5px]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="poc-proxy-password" className="text-[10.5px] text-muted-foreground">
              {t('retest.config.proxy.password')}
            </label>
            <Input
              id="poc-proxy-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('retest.config.proxy.passwordPlaceholderConfigured')}
              disabled={saving}
              className="font-mono text-[11.5px]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="poc-proxy-ca-path" className="text-[10.5px] text-muted-foreground">
              {t('retest.config.proxy.caPath')}
            </label>
            <Input
              id="poc-proxy-ca-path"
              value={caPath}
              onChange={(event) => setCaPath(event.target.value)}
              placeholder={
                view.proxy.caConfigured
                  ? t('retest.config.proxy.caConfigured')
                  : t('retest.config.proxy.caPathPlaceholder')
              }
              disabled={saving}
              spellCheck={false}
              className="font-mono text-[11.5px]"
            />
          </div>
        </div>

        <label
          htmlFor="poc-proxy-insecure"
          className="flex items-start gap-2 text-[11.5px] text-foreground"
        >
          <Checkbox
            id="poc-proxy-insecure"
            checked={allowInsecureTls}
            onChange={(event) => setAllowInsecureTls(event.target.checked)}
            disabled={saving}
            aria-label={t('retest.config.proxy.insecureAria')}
            className="mt-0.5"
          />
          {t('retest.config.proxy.insecure')}
        </label>
        {allowInsecureTls ? (
          <p role="alert" className="rounded-md border border-red-200/80 bg-red-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-red-700">
            {t('retest.config.proxy.insecureWarning')}
          </p>
        ) : null}

        {error !== null ? (
          <p role="alert" className="text-[10.5px] text-red-700">{error}</p>
        ) : null}

        <div className="flex justify-end border-t border-border pt-3">
          <Button
            size="sm"
            data-testid="retest-proxy-save"
            onClick={() => void save()}
            disabled={saving}
            className="gap-1.5"
          >
            {saving ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin poc-spinner" /> : null}
            {saving ? t('retest.config.proxy.saving') : t('retest.config.proxy.save')}
          </Button>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------------- */
/* Execution limits                                                          */
/* ------------------------------------------------------------------------- */

const LIMIT_FIELDS: ReadonlyArray<{ key: keyof PocExecutionLimits; labelKey: string }> = [
  { key: 'totalTimeoutMs', labelKey: 'retest.config.limits.totalTimeout' },
  { key: 'requestTimeoutMs', labelKey: 'retest.config.limits.requestTimeout' },
  { key: 'maxRequests', labelKey: 'retest.config.limits.maxRequests' },
  { key: 'maxResponseBytes', labelKey: 'retest.config.limits.maxResponseBytes' },
  { key: 'maxCodeBytes', labelKey: 'retest.config.limits.maxCodeBytes' }
]

function LimitsSection({
  view,
  onSaved
}: {
  view: PocConfigView
  onSaved: (next: PocConfigView) => void
}) {
  const { t } = useI18n()
  const formatError = usePocErrorMessage()
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(LIMIT_FIELDS.map((field) => [field.key, String(view.limits[field.key])]))
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const api = getApi()
    if (!api) return
    const execution: Partial<PocExecutionLimits> = {}
    for (const field of LIMIT_FIELDS) {
      const raw = (draft[field.key] ?? '').trim()
      const parsed = Number(raw)
      if (raw === '' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        setError(`${t('retest.config.limits.numberError')}: ${t(field.labelKey)}`)
        return
      }
      execution[field.key] = parsed
    }
    setSaving(true)
    setError(null)
    try {
      const next = await api.savePocConfig({ execution })
      onSaved(next)
      toast.success(t('retest.config.limits.saved'))
    } catch (cause) {
      setError(t('retest.config.limits.saveFailed', { error: formatError(cause) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="poc-config-limits-heading" className="rounded-lg border border-border bg-background">
      <div className="border-b border-border px-3.5 py-2.5">
        <h3 id="poc-config-limits-heading" className="text-[12px] font-medium text-foreground">
          {t('retest.config.section.limits')}
        </h3>
      </div>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {LIMIT_FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label
                htmlFor={`poc-limit-${field.key}`}
                className="text-[10.5px] text-muted-foreground"
              >
                {t(field.labelKey)}
              </label>
              <Input
                id={`poc-limit-${field.key}`}
                data-testid={`retest-limit-${field.key}`}
                type="number"
                min={1}
                step={1}
                value={draft[field.key] ?? ''}
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, [field.key]: event.target.value }))
                }
                disabled={saving}
                className="font-mono text-[11.5px]"
              />
            </div>
          ))}
        </div>
        {error !== null ? (
          <p role="alert" className="text-[10.5px] text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end border-t border-border pt-3">
          <Button
            size="sm"
            data-testid="retest-limits-save"
            onClick={() => void save()}
            disabled={saving}
            className="gap-1.5"
          >
            {saving ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin poc-spinner" /> : null}
            {saving ? t('retest.config.limits.saving') : t('retest.config.limits.save')}
          </Button>
        </div>
      </div>
    </section>
  )
}
