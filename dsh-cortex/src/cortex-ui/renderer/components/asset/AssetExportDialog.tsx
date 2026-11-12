import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AlertTriangle, Download, FolderOpen, Loader2, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import {
  exportProjectData,
  exportSelectedAssets,
  readRememberedExportDir,
  testDataExportErrorMessage,
  type TestDataExportFormat,
  type TestDataExportResult
} from '@renderer/lib/testDataExportApi'
import { getPortalContainer } from '../../../dsh/portal'
import { DirectoryPickerDialog } from '../vuln/DirectoryPickerDialog'

const STORAGE_KEY = 'cortex.export.dir'

interface AssetExportDialogProps {
  open: boolean
  /**
   * The originating bulk bar chooses the initial scope: the asset page's header
   * opens `project`, its batch bar opens `assets`, and the vulnerability batch
   * bar opens `vulns`.
   */
  mode: 'project' | 'assets' | 'vulns'
  projects: string[]
  initialProject?: string
  selectedAssetIds: string[]
  /** Selected vulnerability ids for the dashboard bulk export. */
  vulnIds?: string[]
  onOpenChange: (open: boolean) => void
  onExported: (result: TestDataExportResult) => void
}

function isAbsoluteLike(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.startsWith('~')) return true
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) return true
  return trimmed.startsWith('/')
}

function rememberedDirectory(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Project-level test-data export: format, scope (project vs selected assets),
 * evidence, redaction and the real output directory. Defaults to redacted; the
 * raw-secret option is an explicit, warned choice. The Host returns the actual
 * saved paths so the toast can point at a real file.
 */
export function AssetExportDialog({
  open,
  mode,
  projects,
  initialProject,
  selectedAssetIds,
  vulnIds = [],
  onOpenChange,
  onExported
}: AssetExportDialogProps) {
  const { t } = useI18n()
  const [scope, setScope] = useState<'project' | 'selected' | 'vulns'>('project')
  const [project, setProject] = useState('')
  const [format, setFormat] = useState<TestDataExportFormat>('json')
  const [includeEvidence, setIncludeEvidence] = useState(false)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [directory, setDirectory] = useState('')
  const [invalidDirectory, setInvalidDirectory] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const availableProjects = [...new Set([initialProject ?? '', ...projects].filter(Boolean))]
    setScope(mode === 'assets' ? 'selected' : mode === 'vulns' ? 'vulns' : 'project')
    setProject(initialProject ?? availableProjects[0] ?? '')
    setFormat('json')
    setIncludeEvidence(false)
    setIncludeSecrets(false)
    setInvalidDirectory(false)
    setError(null)
    setPending(false)
    setPickerOpen(false)
    const stored = rememberedDirectory()
    setDirectory(stored)
    void readRememberedExportDir().then((hostDir) => {
      if (hostDir.length === 0) return
      setDirectory(hostDir)
      try {
        window.localStorage.setItem(STORAGE_KEY, hostDir)
      } catch {
        /* localStorage may be unavailable */
      }
    })
    // Only reset when the dialog opens or its intended scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode])

  useEffect(() => {
    if (scope !== 'project' && format === 'defectdojo') setFormat('json')
  }, [scope, format])

  const availableProjects = [...new Set([initialProject ?? '', ...projects].filter(Boolean))]
  const projectOptions = availableProjects.length > 0 ? availableProjects : [project].filter(Boolean)
  const selectedCount = selectedAssetIds.length
  const canSubmit =
    !pending &&
    (scope === 'vulns'
      ? vulnIds.length > 0
      : scope === 'selected'
        ? selectedCount > 0
        : project.trim().length > 0)

  const confirm = async (): Promise<void> => {
    if (!canSubmit) {
      setError(
        scope === 'vulns'
          ? t('asset.export.noVulnSelection')
          : scope === 'selected'
            ? t('asset.export.noSelection')
            : t('asset.export.projectRequired')
      )
      return
    }
    const trimmed = directory.trim()
    if (trimmed !== '' && !isAbsoluteLike(trimmed)) {
      setInvalidDirectory(true)
      return
    }
    setPending(true)
    setError(null)
    try {
      const options = {
        project_name: project.trim() || undefined,
        format,
        include_evidence: includeEvidence,
        include_secrets: includeSecrets,
        ...(trimmed === '' ? {} : { output_dir: trimmed })
      }
      const result =
        scope === 'vulns'
          ? await exportSelectedAssets({ ...options, vuln_ids: vulnIds })
          : scope === 'selected'
            ? await exportSelectedAssets({ ...options, asset_ids: selectedAssetIds })
            : await exportProjectData(options)
      try {
        if (trimmed !== '') window.localStorage.setItem(STORAGE_KEY, trimmed)
      } catch {
        /* localStorage may be unavailable */
      }
      onExported(result)
      onOpenChange(false)
    } catch (cause) {
      const message = testDataExportErrorMessage(cause)
      setError(
        message === 'READ_ONLY' || /read-only/i.test(message)
          ? t('asset.export.readOnly')
          : t('asset.export.failed', { error: message })
      )
    } finally {
      setPending(false)
    }
  }

  const formats: Array<{ value: TestDataExportFormat; label: string; testId: string }> = [
    { value: 'json', label: t('asset.export.formatJson'), testId: 'asset-export-format-json' },
    { value: 'csv', label: t('asset.export.formatCsv'), testId: 'asset-export-format-csv' },
    {
      value: 'defectdojo',
      label: t('asset.export.formatDefectDojo'),
      testId: 'asset-export-format-defectdojo'
    }
  ]

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
        <DialogPrimitive.Portal container={getPortalContainer()}>
          <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-[70] bg-[hsl(224_18%_10%/0.3)]" />
          <DialogPrimitive.Content
            data-testid="asset-export-dialog"
            onInteractOutside={(event) => {
              if (pickerOpen) event.preventDefault()
            }}
            onEscapeKeyDown={(event) => {
              if (pickerOpen) event.preventDefault()
            }}
            className="fixed left-1/2 top-1/2 z-[70] w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 shadow-panel focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <DialogPrimitive.Title className="text-[16px] font-medium tracking-tight text-foreground">
              {t('asset.export.title')}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
              {t('asset.export.description')}
            </DialogPrimitive.Description>

            {/* scope */}
            <div className="mt-4">
              <p className="text-[11.5px] font-medium text-foreground">{t('asset.export.scopeLabel')}</p>
              <div className="mt-1.5 inline-flex rounded-md border border-border bg-muted p-0.5">
                <button
                  type="button"
                  role="radio"
                  aria-checked={scope === 'project'}
                  data-testid="asset-export-scope-project"
                  disabled={pending || availableProjects.length === 0}
                  onClick={() => setScope('project')}
                  className={cn(
                    'h-7 rounded px-2.5 text-[11.5px] transition-colors disabled:opacity-50',
                    scope === 'project'
                      ? 'bg-background font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t('asset.export.scopeProject')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={scope === 'selected'}
                  data-testid="asset-export-scope-selected"
                  disabled={pending || selectedCount === 0}
                  onClick={() => setScope('selected')}
                  className={cn(
                    'h-7 rounded px-2.5 text-[11.5px] transition-colors disabled:opacity-50',
                    scope === 'selected'
                      ? 'bg-background font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t('asset.export.scopeSelected', { count: selectedCount })}
                </button>
                {vulnIds.length > 0 ? (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scope === 'vulns'}
                    data-testid="asset-export-scope-vulns"
                    disabled={pending}
                    onClick={() => setScope('vulns')}
                    className={cn(
                      'h-7 rounded px-2.5 text-[11.5px] transition-colors disabled:opacity-50',
                      scope === 'vulns'
                        ? 'bg-background font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t('asset.export.scopeVulns', { count: vulnIds.length })}
                  </button>
                ) : null}
              </div>
            </div>

            {/* project (not relevant when only selected findings are exported) */}
            {scope !== 'vulns' ? (
              <label className="mt-4 block text-[11.5px] font-medium text-foreground">
                {t('asset.export.projectLabel')}
                <select
                  data-testid="asset-export-project"
                  value={project}
                  disabled={pending || projectOptions.length === 0}
                  onChange={(event) => setProject(event.target.value)}
                  className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {projectOptions.length === 0 ? (
                    <option value="">{t('asset.export.noProjects')}</option>
                  ) : (
                    projectOptions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))
                  )}
                </select>
              </label>
            ) : null}

            {/* format */}
            <div className="mt-4">
              <p className="text-[11.5px] font-medium text-foreground">{t('asset.export.formatLabel')}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('asset.export.formatLabel')}>
                {formats.map((item) => {
                  const disabled = pending || (scope !== 'project' && item.value === 'defectdojo')
                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="radio"
                      aria-checked={format === item.value}
                      data-testid={item.testId}
                      disabled={disabled}
                      title={
                        scope !== 'project' && item.value === 'defectdojo'
                          ? t('asset.export.defectDojoProjectOnly')
                          : undefined
                      }
                      onClick={() => setFormat(item.value)}
                      className={cn(
                        'h-8 rounded-md border px-2.5 text-[11.5px] transition-colors disabled:opacity-45',
                        format === item.value
                          ? 'border-accent/50 bg-accent-soft font-medium text-accent'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {item.label}
                    </button>
                  )
                })}
              </div>
              {scope !== 'project' ? (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {t('asset.export.defectDojoProjectOnly')}
                </p>
              ) : null}
            </div>

            {/* options */}
            <div className="mt-4 space-y-2 rounded-lg border border-border bg-sidebar/60 px-3 py-2.5">
              <label className="flex cursor-pointer items-start gap-2 text-[11.5px] text-foreground">
                <Checkbox
                  data-testid="asset-export-evidence"
                  checked={includeEvidence}
                  disabled={pending}
                  onChange={(event) => setIncludeEvidence(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  {t('asset.export.evidenceLabel')}
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    {t('asset.export.evidenceHint')}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-[11.5px] text-foreground">
                <Checkbox
                  data-testid="asset-export-secrets"
                  checked={includeSecrets}
                  disabled={pending}
                  onChange={(event) => setIncludeSecrets(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  {t('asset.export.secretsLabel')}
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    {t('asset.export.secretsHint')}
                  </span>
                </span>
              </label>
              <div className="flex items-start gap-1.5 text-[10.5px] text-emerald-700">
                <ShieldCheck aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{t('asset.export.redactionNote')}</span>
              </div>
              {includeSecrets ? (
                <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[10.5px] leading-relaxed text-red-700">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{t('asset.export.secretsWarning')}</span>
                </div>
              ) : null}
            </div>

            {/* output directory */}
            <label
              htmlFor="asset-export-dir"
              className="mt-4 flex items-center gap-1.5 text-[11.5px] font-medium text-foreground"
            >
              <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              {t('asset.export.dirLabel')}
            </label>
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                id="asset-export-dir"
                data-testid="asset-export-output-dir"
                value={directory}
                spellCheck={false}
                disabled={pending}
                placeholder={t('asset.export.dirPlaceholder')}
                onChange={(event) => {
                  setDirectory(event.target.value)
                  if (invalidDirectory) setInvalidDirectory(false)
                }}
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button
                variant="outline"
                size="sm"
                data-testid="asset-export-browse"
                disabled={pending}
                onClick={() => setPickerOpen(true)}
                className="h-9 shrink-0 gap-1.5"
              >
                <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
                {t('asset.export.browse')}
              </Button>
            </div>
            {invalidDirectory ? (
              <p className="mt-1.5 text-[10.5px] text-red-700">{t('asset.export.dirInvalid')}</p>
            ) : null}

            {error !== null ? (
              <p
                role="alert"
                data-testid="asset-export-error"
                className="mt-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-red-700"
              >
                {error}
              </p>
            ) : null}

            <div className="mt-5 flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">
                {scope === 'vulns'
                  ? t('asset.export.vulnsFootnote', { count: vulnIds.length })
                  : scope === 'selected'
                    ? t('asset.export.selectedFootnote', { count: selectedCount })
                    : t('asset.export.projectFootnote', { project })}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  data-testid="asset-export-confirm"
                  onClick={() => void confirm()}
                  disabled={!canSubmit}
                  className="gap-1.5"
                >
                  {pending ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {pending ? t('asset.export.exporting') : t('asset.export.confirm')}
                </Button>
              </div>
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
          setInvalidDirectory(false)
          setPickerOpen(false)
        }}
      />
    </>
  )
}
