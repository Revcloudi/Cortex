import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Inbox, RefreshCw, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import {
  DEFAULT_VULN_PAGE_SIZE,
  type InternalGraphData,
  type InternalOverview,
  type InternalProjectSummary,
  type LootImport,
  type VulnerabilityListItem,
  type VulnPageSize
} from '@shared/types'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { VulnDetail } from '@renderer/components/vuln/VulnDetail'
import { CredentialMatrix, type CredentialTrialInput } from '@renderer/components/internal/CredentialMatrix'
import { InternalOverviewCards } from '@renderer/components/internal/InternalOverviewCards'
import { InternalVulnList } from '@renderer/components/internal/InternalVulnList'
import { LootPanel } from '@renderer/components/internal/LootPanel'
import { RouteView } from '@renderer/components/internal/RouteView'
import { SubnetHeatmap } from '@renderer/components/internal/SubnetHeatmap'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import { useI18n } from '@renderer/i18n'

interface InternalPageProps {
  dataVersion: number
  /** Render without the page-level outer frame (used inside the dashboard tab). */
  embedded?: boolean
  /** Only used when embedded: navigate to the dedicated internal operations page. */
  onOpenPage?: () => void
}

const READ_ONLY_PATTERN = /read.?only|readonly|403|EROFS/i

function BodySkeleton() {
  return (
    <div className="mt-4 space-y-3" aria-hidden="true">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border sm:grid-cols-4 xl:grid-cols-7">
        {[0, 1, 2, 3, 4, 5, 6].map((index) => (
          <div key={index} className="flex flex-col bg-background px-4 py-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-5 w-10" />
            <Skeleton className="mt-2 h-2.5 w-20" />
          </div>
        ))}
        <div aria-hidden="true" className="bg-background xl:hidden" />
      </div>
      <Skeleton className="h-[140px] w-full rounded-[10px]" />
      <Skeleton className="h-[200px] w-full rounded-[10px]" />
    </div>
  )
}

/**
 * 内网作战 / Internal operations page.
 *
 * Owns the project selection and all data loading (overview, graph, loot, the
 * paginated internal vulnerability list) and composes the focused view
 * components. Every write action is a local, explicit user action: recording a
 * credential trial or importing a loot file — nothing is auto-executed.
 */
export function InternalPage({ dataVersion, embedded = false, onOpenPage }: InternalPageProps) {
  const { t } = useI18n()

  const [projects, setProjects] = useState<InternalProjectSummary[] | null>(null)
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [projectName, setProjectName] = useState<string | null>(null)

  const [overview, setOverview] = useState<InternalOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState<string | null>(null)

  const [graph, setGraph] = useState<InternalGraphData | null>(null)
  const [graphLoading, setGraphLoading] = useState(true)
  const [graphError, setGraphError] = useState<string | null>(null)

  const [loot, setLoot] = useState<LootImport[] | null>(null)
  const [lootLoading, setLootLoading] = useState(true)
  const [lootError, setLootError] = useState<string | null>(null)

  const [vulnItems, setVulnItems] = useState<VulnerabilityListItem[] | null>(null)
  const [vulnTotal, setVulnTotal] = useState(0)
  const [vulnPage, setVulnPage] = useState(1)
  const [vulnPageSize, setVulnPageSize] = useState<VulnPageSize>(DEFAULT_VULN_PAGE_SIZE)
  const [vulnLoading, setVulnLoading] = useState(true)
  const [vulnError, setVulnError] = useState<string | null>(null)

  const [reloadSeq, setReloadSeq] = useState(0)
  const [vulnReloadSeq, setVulnReloadSeq] = useState(0)
  const [readOnly, setReadOnly] = useState(false)
  const [selectedVulnId, setSelectedVulnId] = useState<string | null>(null)

  const markReadOnlyIfNeeded = useCallback((message: string) => {
    if (READ_ONLY_PATTERN.test(message)) setReadOnly(true)
  }, [])

  /* ------------------------------------------------------------- projects -- */
  useEffect(() => {
    const api = getApi()
    if (!api) {
      setProjectsError(apiUnavailableMessage(t))
      setProjectsLoading(false)
      return
    }
    let alive = true
    setProjectsLoading(true)
    void (async () => {
      try {
        const list = await api.getInternalProjects()
        if (!alive) return
        setProjects(list)
        setProjectsError(null)
        // Enter the loading state in the same commit that selects the project so
        // no panel flashes its empty state before the first fetch resolves.
        setOverviewLoading(true)
        setGraphLoading(true)
        setLootLoading(true)
        setProjectName((previous) => {
          if (previous !== null && list.some((entry) => entry.project_name === previous)) {
            return previous
          }
          return list[0]?.project_name ?? null
        })
      } catch (cause) {
        if (alive) setProjectsError(toErrorMessage(cause, t))
      } finally {
        if (alive) setProjectsLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [t, dataVersion, reloadSeq])

  /* ------------------------------------------------------------- overview -- */
  useEffect(() => {
    if (projectName === null) {
      setOverview(null)
      setOverviewLoading(false)
      setOverviewError(null)
      return
    }
    const api = getApi()
    if (!api) {
      setOverviewError(apiUnavailableMessage(t))
      setOverviewLoading(false)
      return
    }
    let alive = true
    setOverviewLoading(true)
    void (async () => {
      try {
        const next = await api.getInternalOverview({ project_name: projectName })
        if (!alive) return
        setOverview(next)
        setOverviewError(null)
      } catch (cause) {
        if (alive) setOverviewError(toErrorMessage(cause, t))
      } finally {
        if (alive) setOverviewLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [projectName, dataVersion, reloadSeq, t])

  /* ---------------------------------------------------------------- graph -- */
  useEffect(() => {
    if (projectName === null) {
      setGraph(null)
      setGraphLoading(false)
      setGraphError(null)
      return
    }
    const api = getApi()
    if (!api) {
      setGraphError(apiUnavailableMessage(t))
      setGraphLoading(false)
      return
    }
    let alive = true
    setGraphLoading(true)
    void (async () => {
      try {
        const next = await api.getInternalGraph({ project_name: projectName })
        if (!alive) return
        setGraph(next)
        setGraphError(null)
      } catch (cause) {
        if (alive) setGraphError(toErrorMessage(cause, t))
      } finally {
        if (alive) setGraphLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [projectName, dataVersion, reloadSeq, t])

  /* ----------------------------------------------------------------- loot -- */
  useEffect(() => {
    if (projectName === null) {
      setLoot(null)
      setLootLoading(false)
      setLootError(null)
      return
    }
    const api = getApi()
    if (!api) {
      setLootError(apiUnavailableMessage(t))
      setLootLoading(false)
      return
    }
    let alive = true
    setLootLoading(true)
    void (async () => {
      try {
        const next = await api.listLootImports({ project_name: projectName })
        if (!alive) return
        setLoot(next)
        setLootError(null)
      } catch (cause) {
        if (alive) setLootError(toErrorMessage(cause, t))
      } finally {
        if (alive) setLootLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [projectName, dataVersion, reloadSeq, t])

  /* ------------------------------------------------- internal vuln list -- */
  useEffect(() => {
    const api = getApi()
    if (!api) {
      setVulnError(apiUnavailableMessage(t))
      setVulnLoading(false)
      return
    }
    let alive = true
    setVulnLoading(true)
    void (async () => {
      try {
        const result = await api.listVulnerabilities({
          realm: 'internal',
          page: vulnPage,
          pageSize: vulnPageSize
        })
        if (!alive) return
        setVulnItems(result.items)
        setVulnTotal(result.total)
        if (result.page !== vulnPage) setVulnPage(result.page)
        setVulnError(null)
      } catch (cause) {
        if (alive) setVulnError(toErrorMessage(cause, t))
      } finally {
        if (alive) setVulnLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [vulnPage, vulnPageSize, dataVersion, vulnReloadSeq, t])

  const refresh = useCallback(() => {
    setReloadSeq((value) => value + 1)
    setVulnReloadSeq((value) => value + 1)
  }, [])

  const handleProjectChange = (next: string): void => {
    setProjectName(next)
    setOverview(null)
    setGraph(null)
    setLoot(null)
    setSelectedVulnId(null)
    setOverviewLoading(true)
    setGraphLoading(true)
    setLootLoading(true)
  }

  const handleRecordTrial = useCallback(
    async (input: CredentialTrialInput): Promise<void> => {
      const api = getApi()
      if (!api) {
        toast.error(apiUnavailableMessage(t))
        return
      }
      try {
        await api.recordCredentialTrial({
          credential_id: input.credentialId,
          service_id: input.serviceId,
          action: input.action,
          status: input.status
        })
        toast.success(
          t('internal.toast.trialSaved', {
            status: t(`internal.trialStatus.${input.status}`)
          })
        )
        setReloadSeq((value) => value + 1)
      } catch (cause) {
        const message = toErrorMessage(cause, t)
        markReadOnlyIfNeeded(message)
        toast.error(t('internal.toast.trialFailed', { error: message }))
      }
    },
    [t, markReadOnlyIfNeeded]
  )

  const handleLootImported = useCallback(() => {
    // One refresh cycle updates the loot table and the overview loot counter.
    setReloadSeq((value) => value + 1)
  }, [])

  const handleVulnPageChange = useCallback((next: number) => setVulnPage(next), [])
  const handleVulnPageSizeChange = useCallback((next: VulnPageSize) => {
    setVulnPageSize(next)
    setVulnPage(1)
  }, [])

  const warnings = [...new Set([...(overview?.warnings ?? []), ...(graph?.warnings ?? [])])]
  const truncated = graph?.truncated === true
  const dataError =
    overviewError !== null && overview !== null
      ? overviewError
      : graphError !== null && graph !== null
        ? graphError
        : null

  const header = (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {t('internal.page.eyebrow')}
        </p>
        <div className="mt-1 flex flex-wrap items-baseline gap-2.5">
          <h1 className="text-[18px] font-medium tracking-tight text-foreground">
            {t('internal.page.title')}
          </h1>
          <span className="font-mono text-[11px] tabular-nums text-foreground/70">
            {overview === null
              ? '—'
              : t('internal.page.stats', {
                  footholds: overview.counts.footholds,
                  hosts: overview.counts.hosts,
                  services: overview.counts.services,
                  pivots: overview.counts.pivots
                })}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">{t('internal.page.projectLabel')}</span>
        <Select
          value={projectName ?? undefined}
          onValueChange={handleProjectChange}
          disabled={projects === null || projects.length === 0}
        >
          <SelectTrigger
            data-testid="internal-project-select"
            aria-label={t('internal.page.projectAria')}
            className="h-8 w-[240px] text-[12px]"
          >
            <SelectValue placeholder={t('internal.page.projectPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {(projects ?? []).map((project) => (
              <SelectItem key={project.project_name} value={project.project_name}>
                {project.project_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="internal-refresh"
          aria-label={t('internal.page.refresh')}
          title={t('internal.page.refresh')}
          onClick={refresh}
        >
          <RefreshCw strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        {embedded && onOpenPage !== undefined ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="internal-open-page"
            onClick={onOpenPage}
            className="gap-1.5"
          >
            <ArrowUpRight strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
            {t('internal.page.open')}
          </Button>
        ) : null}
      </div>
    </header>
  )

  const projectsSkeleton = projects === null && projectsLoading
  const projectsFailed = projects === null && projectsError !== null
  const noProjects = projects !== null && projects.length === 0

  return (
    <section
      data-testid="internal-page"
      data-embedded={embedded ? 'true' : undefined}
      className={embedded ? 'w-full pb-4' : 'mx-auto w-full max-w-[1440px] px-8 py-5'}
    >
      {header}

      {projectsSkeleton ? (
        <BodySkeleton />
      ) : projectsFailed ? (
        <EmptyState
          icon={Unplug}
          title={t('internal.page.projectsLoadError')}
          description={projectsError ?? undefined}
        >
          <Button variant="outline" size="sm" onClick={refresh}>
            {t('common.retry')}
          </Button>
        </EmptyState>
      ) : noProjects ? (
        <div className="mt-4 space-y-3">
          {/*
           * A legacy v2 database can carry internal-realm vulnerabilities while
           * having no normalized foothold/host/service entities yet. Never hide
           * those findings behind the "no project" empty state: the realm-wide
           * internal vulnerability list loads independently of the project.
           */}
          <EmptyState
            icon={Inbox}
            title={t('internal.page.noProjects.title')}
            description={t('internal.page.noProjects.description')}
          >
            <Button variant="outline" size="sm" onClick={refresh} className="gap-1.5">
              <RefreshCw strokeWidth={1.75} aria-hidden="true" className="h-3.5 w-3.5" />
              {t('common.refresh')}
            </Button>
          </EmptyState>
          <InternalVulnList
            items={vulnItems}
            total={vulnTotal}
            page={vulnPage}
            pageSize={vulnPageSize}
            loading={vulnLoading}
            error={vulnError}
            onPageChange={handleVulnPageChange}
            onPageSizeChange={handleVulnPageSizeChange}
            onOpenVuln={setSelectedVulnId}
            onRetry={refresh}
          />
        </div>
      ) : projectName === null ? (
        <EmptyState
          icon={Inbox}
          title={t('internal.page.empty.title')}
          description={t('internal.page.empty.description')}
        />
      ) : (
        <div className="mt-4 space-y-3">
          {readOnly ? (
            <div
              data-testid="internal-readonly-banner"
              className="flex items-start gap-2 rounded-[10px] border border-amber-300/80 bg-amber-50 px-4 py-2 text-[11.5px] leading-relaxed text-amber-900"
            >
              <span className="mt-0.5 shrink-0 rounded-full border border-amber-400/80 bg-background px-1.5 text-[9.5px] font-medium">
                {t('internal.page.readonlyBadge')}
              </span>
              <span>{t('internal.page.readonlyHint')}</span>
            </div>
          ) : null}

          {warnings.length > 0 || truncated ? (
            <div
              data-testid="internal-warnings"
              className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-[10px] border border-border bg-muted/40 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground"
            >
              <span className="font-medium text-foreground/70">{t('internal.page.warnings')}</span>
              {truncated ? (
                <span className="text-amber-800">{t('internal.page.truncated')}</span>
              ) : null}
              {warnings.slice(0, 6).map((warning) => (
                <span key={warning} className="break-all">
                  {warning}
                </span>
              ))}
            </div>
          ) : null}

          {dataError !== null ? (
            <div className="flex items-center justify-between gap-3 rounded-[10px] border border-red-200/70 bg-red-50 px-4 py-1.5 text-[11.5px] text-red-700">
              <span className="flex min-w-0 items-center gap-2">
                <AlertTriangle
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0"
                />
                <span className="truncate">{dataError}</span>
              </span>
              <button
                type="button"
                onClick={refresh}
                className="shrink-0 underline underline-offset-2 hover:text-red-800"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : null}

          <InternalOverviewCards
            overview={overview}
            loading={overviewLoading}
            error={overviewError}
            onRetry={refresh}
          />

          <InternalVulnList
            items={vulnItems}
            total={vulnTotal}
            page={vulnPage}
            pageSize={vulnPageSize}
            loading={vulnLoading}
            error={vulnError}
            onPageChange={handleVulnPageChange}
            onPageSizeChange={handleVulnPageSizeChange}
            onOpenVuln={setSelectedVulnId}
            onRetry={refresh}
          />

          <SubnetHeatmap
            buckets={graph?.heatmap ?? []}
            loading={graphLoading}
            error={graphError}
            onRetry={refresh}
          />

          <CredentialMatrix
            graph={graph}
            loading={graphLoading}
            error={graphError}
            onRetry={refresh}
            onRecordTrial={handleRecordTrial}
          />

          <RouteView
            pivots={graph?.pivots ?? []}
            footholds={graph?.footholds ?? []}
            loading={graphLoading}
            error={graphError}
            onRetry={refresh}
          />

          <LootPanel
            projectName={projectName}
            loot={loot}
            loading={lootLoading}
            error={lootError}
            onRetry={refresh}
            onImported={handleLootImported}
          />
        </div>
      )}

      <VulnDetail
        vulnId={selectedVulnId}
        dataVersion={dataVersion + vulnReloadSeq + reloadSeq}
        onClose={() => setSelectedVulnId(null)}
        onChanged={() => setVulnReloadSeq((value) => value + 1)}
        onOpenRelated={setSelectedVulnId}
      />
    </section>
  )
}
