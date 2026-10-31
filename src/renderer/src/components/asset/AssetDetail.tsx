import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, Link2, Loader2, Network, ShieldAlert, Trash2, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import type {
  AssetContext,
  AssetInterface,
  LeakedInfo,
  VulnerabilityListItem
} from '@shared/types'
import { normalizeAssetInterfaces } from '@shared/types'
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetTitle
} from '@renderer/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import {
  AssetStatusBadge,
  LeakTypeBadge,
  SeverityBadge,
  StatusBadge
} from '@renderer/components/common/Badges'
import { CopyButton } from '@renderer/components/common/CopyButton'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { useCopy } from '@renderer/hooks/useCopy'
import {
  INTERFACE_METHOD_STYLES,
  buildInterfaceRequest,
  techStackTags
} from '@renderer/lib/assets'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import { formatDateTimeFull } from '@renderer/lib/format'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { DeleteAssetDialog } from './DeleteAssetDialog'
import { TestParameterList } from './TestParameterList'

interface AssetDetailProps {
  hostPort: string | null
  dataVersion: number
  onClose: () => void
  onOpenVuln: (vulnId: string) => void
  /** Called after the asset was deleted (parent closes the sheet + refreshes). */
  onDeleted: () => void
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-foreground/70">{label}</dt>
      <dd className="mt-1 text-[12.5px] leading-relaxed text-foreground">{children}</dd>
    </div>
  )
}

/** Muted placeholder chip used when the agent did not record a method. */
function MethodMissingBadge() {
  const { t } = useI18n()
  return (
    <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
      {t('asset.interface.methodMissing')}
    </Badge>
  )
}

/** Dark request surface matching the vulnerability detail HTTP blocks. */
function InterfaceRequestBlock({ request, raw }: { request: string; raw: boolean }) {
  const { t } = useI18n()
  return (
    <div
      data-testid="asset-interface-request"
      className="overflow-hidden rounded-md border border-white/10 bg-[hsl(var(--code))]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
          {raw ? t('asset.interface.rawRequest') : t('asset.interface.generatedRequest')}
        </span>
        <CopyButton
          value={request}
          label={t('asset.interface.copyRequest')}
          toastMessage={t('asset.interface.copyRequestToast')}
          tone="dark"
        />
      </div>
      <pre className="scrollbar-thin max-h-[260px] overflow-y-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-[11.5px] leading-[1.7] text-[hsl(220_15%_86%)]">
        {request}
      </pre>
    </div>
  )
}

interface InterfaceRowProps {
  host: string
  iface: AssetInterface
  expanded: boolean
  onToggle: () => void
}

/**
 * One flat interface row. Method and path form the outermost line (no prefix
 * group heading, no duplicate path); clicking the row reveals the complete HTTP
 * request — the captured raw request when present, otherwise a generated one.
 */
function InterfaceRow({ host, iface, expanded, onToggle }: InterfaceRowProps) {
  const { t } = useI18n()
  const params = iface.params?.trim() ?? ''
  const request = buildInterfaceRequest(host, iface)
  const raw = (iface.request?.trim().length ?? 0) > 0

  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        data-testid="asset-interface-row"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          'flex w-full items-start gap-3 px-1 py-3 text-left transition-colors duration-150 hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none',
          expanded && 'bg-sidebar'
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {iface.method ? (
              <Badge
                className={cn(
                  'shrink-0 font-mono text-[11px]',
                  INTERFACE_METHOD_STYLES[iface.method]
                )}
              >
                {iface.method}
              </Badge>
            ) : (
              <MethodMissingBadge />
            )}
            <code className="min-w-0 break-all font-mono text-[12.5px] leading-relaxed text-foreground">
              {iface.path}
            </code>
          </span>
          <span
            className={cn(
              'mt-1 block break-all text-[11.5px] leading-relaxed',
              params.length > 0 ? 'font-mono text-foreground/80' : 'text-muted-foreground'
            )}
          >
            {params.length > 0
              ? t('asset.interface.params', { params })
              : t('asset.interface.paramsMissing')}
          </span>
        </span>
        <span
          className={cn(
            'shrink-0 pt-0.5 text-[11px] font-medium',
            expanded ? 'text-foreground/60' : 'text-accent'
          )}
        >
          {expanded ? t('asset.interface.collapse') : t('asset.interface.viewRequest')}
        </span>
      </button>
      {expanded ? (
        <div className="px-1 pb-3">
          <InterfaceRequestBlock request={request} raw={raw} />
        </div>
      ) : null}
    </li>
  )
}

/** One leaked-info card: type + copied value, source and impact, no truncation. */
function LeakCard({ leak }: { leak: LeakedInfo }) {
  const { t } = useI18n()
  const { copied, copy } = useCopy()

  return (
    <article className="rounded-[10px] border border-border bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <LeakTypeBadge type={leak.info_type} className="text-[11px]" />
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 gap-1.5 text-foreground/80"
          onClick={() => void copy(leak.value, t('asset.leak.copyToast'))}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3 w-3 text-emerald-600" />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3" />
          )}
          {copied ? t('common.copied') : t('asset.leak.copy')}
        </Button>
      </header>
      <div className="space-y-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-foreground/70">{t('asset.leak.value')}</p>
          <pre className="mt-1 whitespace-pre-wrap break-all rounded-md border border-border bg-sidebar px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground">
            {leak.value}
          </pre>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-foreground/70">{t('asset.leak.source')}</p>
          <p className="mt-0.5 break-all font-mono text-[11.5px] leading-relaxed text-foreground/80">
            {leak.source}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-foreground/70">{t('asset.leak.impact')}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/80">
            {leak.potential_impact}
          </p>
        </div>
      </div>
    </article>
  )
}

function SheetSkeleton() {
  return (
    <div aria-hidden="true" className="px-6 py-5">
      <Skeleton className="h-[22px] w-[58px] rounded-full" />
      <Skeleton className="mt-4 h-7 w-[64%]" />
      <Skeleton className="mt-2 h-4 w-[34%]" />
      <div className="mt-5 flex gap-5 border-t border-border pt-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="mt-5 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-[82%]" />
        <Skeleton className="h-3 w-[64%]" />
      </div>
      <Skeleton className="mt-6 h-32 w-full" />
    </div>
  )
}

/**
 * Asset inspector: floating sheet with four tabs, a flat interface list whose
 * rows expand into the complete HTTP request, and stacked leak cards. Leak values
 * are intentionally plaintext in this development build (no masking yet).
 */
export function AssetDetail({
  hostPort,
  dataVersion,
  onClose,
  onOpenVuln,
  onDeleted
}: AssetDetailProps) {
  const { t } = useI18n()
  const [asset, setAsset] = useState<AssetContext | null>(null)
  const [related, setRelated] = useState<VulnerabilityListItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [activeTab, setActiveTab] = useState('overview')
  const [expandedInterfaceKey, setExpandedInterfaceKey] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const open = hostPort !== null

  useEffect(() => {
    if (!hostPort) return
    const api = getApi()
    if (!api) {
      setError(apiUnavailableMessage(t))
      setLoading(false)
      return
    }

    let alive = true
    setLoading(true)
    setRelatedLoading(true)
    setError(null)
    setActiveTab('overview')
    setExpandedInterfaceKey(null)

    api.getAssetDetail(hostPort).then(
      (next) => {
        if (!alive) return
        if (next === null) {
          setAsset(null)
          setError(t('asset.detail.notFound', { host: hostPort }))
        } else {
          setAsset(next)
          setError(null)
        }
      },
      (cause: unknown) => {
        if (alive) setError(toErrorMessage(cause, t))
      }
    ).finally(() => {
      if (alive) setLoading(false)
    })

    api.getAssetRelatedVulnerabilities(hostPort).then(
      (next) => {
        if (alive) setRelated(next)
      },
      () => {
        if (alive) setRelated([])
      }
    ).finally(() => {
      if (alive) setRelatedLoading(false)
    })

    return () => {
      alive = false
    }
  }, [hostPort, dataVersion, retryKey])

  const interfaces = asset
    ? (asset.interfaces ?? normalizeAssetInterfaces([], asset.interface_dir))
    : []
  const testParameters = asset?.test_parameters ?? []
  const tags = asset ? techStackTags(asset.tech_stack) : []

  const handleDelete = async (): Promise<void> => {
    if (!asset) return
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }
    setDeleting(true)
    try {
      const result = await api.deleteAsset(asset.host_port)
      setDeleteOpen(false)
      if (result.deleted) {
        toast.success(t('asset.detail.deleted'))
      } else {
        toast(t('asset.detail.alreadyDeleted'))
      }
      onDeleted()
    } catch (cause) {
      toast.error(t('asset.detail.deleteFailed', { error: toErrorMessage(cause, t) }))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <SheetContent data-testid="asset-sheet">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {t('asset.page.eyebrow')}
          </span>
          <div className="flex items-center gap-1">
            {asset !== null ? (
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="asset-delete"
                aria-label={t('asset.detail.delete')}
                title={t('asset.detail.delete')}
                onClick={() => setDeleteOpen(true)}
                disabled={deleting}
                className="text-muted-foreground hover:bg-red-50 hover:text-destructive focus-visible:bg-red-50 focus-visible:text-destructive"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <SheetCloseButton />
          </div>
        </div>

        {loading && asset === null ? (
          <SheetSkeleton />
        ) : error !== null && asset === null ? (
          <EmptyState
            icon={Unplug}
            title={t('asset.detail.loadError')}
            description={error}
            className="my-auto"
          >
            <Button variant="outline" size="sm" onClick={() => setRetryKey((value) => value + 1)}>
              {t('common.retry')}
            </Button>
          </EmptyState>
        ) : asset !== null ? (
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
            <div className="border-b border-border px-6 pb-5 pt-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <SheetTitle className="break-all font-mono text-[21px] font-medium tracking-tight">
                    {asset.host_port}
                  </SheetTitle>
                  <SheetDescription className="mt-1.5 break-all text-[12.5px] text-foreground/70">
                    {t('asset.detail.projectHost', {
                      project: asset.project_name,
                      host: asset.host
                    })}
                  </SheetDescription>
                </div>
                <CopyButton
                  value={asset.host_port}
                  label={t('asset.detail.copyUrl')}
                  toastMessage={t('asset.detail.copyUrlToast')}
                  className="mt-0.5"
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <AssetStatusBadge status={asset.status} />
                <span className="inline-flex h-[22px] items-center rounded-full border border-border bg-background px-2 text-[11px] text-foreground/70">
                  {asset.auth_required
                    ? t('asset.detail.authRequired')
                    : t('asset.detail.authNotMarked')}
                </span>
                <span className="font-mono text-[12.5px] tabular-nums text-foreground/70">
                  {t('asset.detail.updatedAt', { time: formatDateTimeFull(asset.last_seen) })}
                </span>
              </div>
            </div>

            <div className="px-6 pt-4">
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="h-auto w-full justify-start gap-5 border-b border-border bg-transparent p-0">
                  <TabsTrigger
                    value="overview"
                    data-testid="asset-tab-overview"
                    className="h-8 rounded-none border-b-2 border-transparent px-0 text-[12.5px] data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    {t('asset.tab.overview')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="interfaces"
                    data-testid="asset-tab-interfaces"
                    className="h-8 rounded-none border-b-2 border-transparent px-0 text-[12.5px] data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    {t('asset.tab.interfaces')}
                    <span className="ml-1 font-mono text-[11px] tabular-nums text-foreground/60">
                      {interfaces.length}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="parameters"
                    data-testid="asset-tab-parameters"
                    className="h-8 rounded-none border-b-2 border-transparent px-0 text-[12.5px] data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    {t('asset.tab.parameters')}
                    <span className="ml-1 font-mono text-[11px] tabular-nums text-foreground/60">
                      {testParameters.length}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="leaks"
                    data-testid="asset-tab-leaks"
                    className="h-8 rounded-none border-b-2 border-transparent px-0 text-[12.5px] data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    {t('asset.tab.leaks')}
                    <span className="ml-1 font-mono text-[11px] tabular-nums text-foreground/60">
                      {asset.leaked_infos.length}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="related"
                    data-testid="asset-tab-related"
                    className="h-8 rounded-none border-b-2 border-transparent px-0 text-[12.5px] data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    {t('asset.tab.related')}
                    <span className="ml-1 font-mono text-[11px] tabular-nums text-foreground/60">
                      {related?.length ?? asset.related_vuln_ids.length}
                    </span>
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="pt-5">
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
                    <MetaItem label={t('asset.field.project')}>{asset.project_name}</MetaItem>
                    <MetaItem label={t('common.host')}>
                      <span className="font-mono text-[12.5px]">{asset.host}</span>
                    </MetaItem>
                    <MetaItem label={t('asset.field.url')}>
                      <code className="break-all font-mono text-[12.5px] text-foreground">
                        {asset.host_port}
                      </code>
                    </MetaItem>
                    <MetaItem label={t('asset.field.status')}>
                      <AssetStatusBadge status={asset.status} />
                    </MetaItem>
                    <MetaItem label={t('asset.field.authRequired')}>
                      <span>
                        {asset.auth_required
                          ? t('asset.detail.authRequiredYes')
                          : t('asset.detail.authRequiredNo')}
                      </span>
                    </MetaItem>
                    <MetaItem label={t('asset.field.lastUpdated')}>
                      <span className="font-mono tabular-nums">
                        {formatDateTimeFull(asset.last_seen)}
                      </span>
                    </MetaItem>
                    <MetaItem label={t('asset.field.techStack')}>
                      {tags.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {tags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-block max-w-full break-words rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[11px] leading-relaxed text-foreground/75"
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t('asset.value.notRecorded')}</span>
                      )}
                    </MetaItem>
                    <MetaItem label={t('asset.field.intelligence')}>
                      <span className="font-mono tabular-nums">
                        {t('asset.field.intelligenceValue', {
                          interfaces: interfaces.length,
                          leaks: asset.leaked_infos.length,
                          vulns: related?.length ?? asset.related_vuln_ids.length
                        })}
                      </span>
                    </MetaItem>
                  </dl>
                </TabsContent>

                <TabsContent value="interfaces" className="pt-4">
                  {interfaces.length === 0 ? (
                    <EmptyState
                      icon={Network}
                      title={t('asset.interfaces.empty.title')}
                      description={t('asset.interfaces.empty.description')}
                    />
                  ) : (
                    <ul data-testid="asset-interface-list">
                      {interfaces.map((iface, index) => {
                        const key = `${iface.method ?? '*'}\u0000${iface.path}\u0000${index}`
                        return (
                          <InterfaceRow
                            key={key}
                            host={asset.host}
                            iface={iface}
                            expanded={expandedInterfaceKey === key}
                            onToggle={() =>
                              setExpandedInterfaceKey((previous) =>
                                previous === key ? null : key
                              )
                            }
                          />
                        )
                      })}
                    </ul>
                  )}
                </TabsContent>

                <TabsContent value="parameters" className="pt-4">
                  <TestParameterList parameters={testParameters} onOpenVuln={onOpenVuln} />
                </TabsContent>

                <TabsContent value="leaks" className="pt-4">
                  {asset.leaked_infos.length === 0 ? (
                    <EmptyState
                      icon={ShieldAlert}
                      title={t('asset.leaks.empty.title')}
                      description={t('asset.leaks.empty.description')}
                    />
                  ) : (
                    <div className="space-y-3">
                      {asset.leaked_infos.map((leak, index) => (
                        <LeakCard key={`${leak.info_type}-${leak.source}-${index}`} leak={leak} />
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="related" className="pt-4">
                  {relatedLoading && related === null ? (
                    <div className="space-y-2 py-2">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  ) : related === null || related.length === 0 ? (
                    <EmptyState
                      icon={Link2}
                      title={t('asset.related.empty.title')}
                      description={t('asset.related.empty.description')}
                    />
                  ) : (
                    <ul className="-mt-2">
                      {related.map((vuln) => (
                        <li key={vuln.id}>
                          <button
                            type="button"
                            data-testid="asset-related-vuln"
                            onClick={() => onOpenVuln(vuln.id)}
                            className="group flex w-full items-start gap-3 border-b border-border px-1 py-3 text-left transition-colors last:border-b-0 hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none"
                          >
                            <span className="mt-0.5 shrink-0">
                              <SeverityBadge severity={vuln.severity} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12.5px] font-medium text-foreground group-hover:text-accent">
                                {vuln.vuln_name}
                              </span>
                              <span className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[12.5px] text-foreground/70">
                                <span>{vuln.id}</span>
                                <span>{vuln.host}</span>
                                <StatusBadge status={vuln.status} />
                              </span>
                            </span>
                            <span className="shrink-0 pt-0.5 text-[11.5px] text-foreground/60">
                              {t('asset.related.open')}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
              </Tabs>
            </div>

            <div className="h-4" />
          </div>
        ) : null}

        {loading && asset !== null ? (
          <div className="flex items-center gap-2 border-t border-border px-6 py-2 text-[11.5px] text-foreground/60">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {t('asset.detail.refreshing')}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>

    <DeleteAssetDialog
      open={deleteOpen}
      hostPort={asset?.host_port ?? hostPort ?? ''}
      pending={deleting}
      onOpenChange={(next) => {
        if (!next && !deleting) setDeleteOpen(false)
      }}
      onConfirm={() => void handleDelete()}
    />
    </>
  )
}
