import type { ReactNode } from 'react'
import type { AppInfo } from '@shared/types'
import { MCP_TOOL_COUNT, MCP_TRANSPORT } from '@shared/ipc'
import { stdioCommandDisplay } from '@shared/mcpConfig'
import { Database } from 'lucide-react'
import { Card } from '@renderer/components/ui/card'
import { CopyButton } from '@renderer/components/common/CopyButton'
import { SectionHeading } from '@renderer/components/common/SectionHeading'
import { McpAgentInstall } from '@renderer/components/mcp/McpAgentInstall'
import { McpToolsTable } from '@renderer/components/mcp/McpToolsTable'
import { useDbInfo } from '@renderer/hooks/useDbInfo'
import { useI18n } from '@renderer/i18n'
import { formatBytes, formatDateTimeFull } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'

interface McpPageProps {
  info: AppInfo | null
}

function StatField({
  label,
  children,
  mono = false
}: {
  label: string
  children: ReactNode
  mono?: boolean
}) {
  return (
    <div className="min-w-0 bg-background px-5 py-3.5">
      <dt className="text-[10.5px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-1 truncate text-[12px] tabular-nums text-foreground',
          mono && 'font-mono text-[11.5px]'
        )}
      >
        {children}
      </dd>
    </div>
  )
}

export function McpPage({ info }: McpPageProps) {
  const { t } = useI18n()
  const { info: dbInfo, error: dbError } = useDbInfo()

  const runtime = info?.mcpRuntime ?? null
  const launchCommand = runtime ? stdioCommandDisplay(runtime) : null
  const modeLabel = runtime
    ? t(runtime.mode === 'installed' ? 'mcp.mode.installed' : 'mcp.mode.development')
    : null
  const databasePath = info?.dbPath ?? dbInfo?.dbPath ?? null
  const schemaVersion = info?.schemaVersion ?? dbInfo?.schemaVersion ?? null

  return (
    <section className="mx-auto w-full max-w-[1240px] px-8 py-6">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {t('mcp.page.eyebrow')}
        </p>
        <div className="mt-1 flex flex-wrap items-baseline gap-2.5">
          <h1 className="text-[18px] font-medium tracking-tight text-foreground">
            {t('mcp.page.title')}
          </h1>
          <span className="font-mono text-[11px] text-muted-foreground">
            {t('mcp.page.subtitle')}
          </span>
        </div>
        <p className="mt-1.5 max-w-[700px] text-[11.5px] leading-relaxed text-muted-foreground">
          {t('mcp.page.description')}
        </p>
      </header>

      <Card className="mt-5 overflow-hidden">
        <div className="px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-medium tracking-tight text-foreground">
              {t('mcp.stdio.title')}
            </h2>
            {modeLabel ? (
              <span className="inline-flex h-[22px] items-center rounded-full border border-accent/20 bg-accent-soft px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-accent">
                {modeLabel}
              </span>
            ) : null}
          </div>
          <p
            data-testid="mcp-transport"
            className="mt-1 text-[12px] leading-relaxed text-foreground"
          >
            {t('mcp.stdio.transport')}
          </p>
          <p className="mt-1 max-w-[680px] text-[11.5px] leading-relaxed text-muted-foreground">
            {t('mcp.stdio.note')}
          </p>

          <div className="mt-4 max-w-[760px]">
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {t('mcp.stdio.launchCommand')}
            </p>
            <div className="mt-1.5 flex items-start justify-between gap-2 rounded-md border border-border bg-sidebar px-3 py-2">
              <code className="min-w-0 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
                {launchCommand ?? t('mcp.stdio.loadingCommand')}
              </code>
              {launchCommand ? (
                <CopyButton
                  value={launchCommand}
                  label={t('mcp.stdio.copyCommand')}
                  toastMessage={t('mcp.stdio.copiedCommand')}
                />
              ) : null}
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3">
          <StatField label={t('mcp.stat.transport')} mono>
            {MCP_TRANSPORT}
          </StatField>
          <StatField label={t('mcp.stat.toolCount')}>
            {t('mcp.stat.toolCountValue', { count: MCP_TOOL_COUNT })}
          </StatField>
          <StatField label={t('mcp.stat.appVersion')} mono>
            {info ? `v${info.version}` : '—'}
          </StatField>
        </dl>
      </Card>

      <Card className="mt-4 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <Database
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0">
              <h2 className="text-[14px] font-medium tracking-tight text-foreground">
                {t('mcp.database.title')}
              </h2>
              <p className="mt-1 max-w-[700px] text-[11.5px] leading-relaxed text-muted-foreground">
                {t('mcp.database.description')}
              </p>
            </div>
          </div>
          <span className="inline-flex h-[22px] shrink-0 items-center rounded-full border border-border bg-secondary px-2 font-mono text-[10px] text-secondary-foreground">
            {t('mcp.database.schemaVersion', { version: schemaVersion ?? '—' })}
          </span>
        </div>

        <div className="border-t border-border px-5 py-3.5">
          <p className="text-[10.5px] text-muted-foreground">{t('mcp.database.file')}</p>
          <p className="mt-1 break-all font-mono text-[11.5px] leading-relaxed text-foreground">
            {databasePath ?? '—'}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
          <StatField label={t('mcp.database.mainSize')}>
            {dbInfo ? formatBytes(dbInfo.sizeBytes) : '—'}
          </StatField>
          <StatField label={t('mcp.database.walSize')}>
            {dbInfo ? formatBytes(dbInfo.walSizeBytes) : '—'}
          </StatField>
          <StatField label={t('mcp.database.lastModified')} mono>
            {formatDateTimeFull(dbInfo?.lastModifiedAt ?? null)}
          </StatField>
          <StatField label={t('mcp.database.fileStatus')}>
            {dbInfo ? (dbInfo.exists ? t('mcp.database.created') : t('mcp.database.notCreated')) : '—'}
          </StatField>
        </dl>

        {dbError ? (
          <p className="border-t border-amber-200/70 bg-amber-50 px-5 py-2.5 text-[11px] leading-relaxed text-amber-800">
            {t('mcp.database.readError', { error: dbError })}
          </p>
        ) : null}
      </Card>

      {info ? (
        <div className="mt-8">
          <McpAgentInstall info={info} />
        </div>
      ) : (
        <div className="mt-8">
          <SectionHeading
            title={t('mcp.agents.loadingHeading')}
            description={t('mcp.agents.loadingDescription')}
          />
          <div className="mt-4 rounded-[10px] border border-dashed border-border bg-background px-5 py-8 text-center text-[11.5px] leading-relaxed text-muted-foreground">
            {t('mcp.agents.loadingNote')}
          </div>
        </div>
      )}

      <div className="mt-8">
        <McpToolsTable />
      </div>

      <div className="mt-8 flex items-start gap-2 border-t border-border pt-4 text-[10.5px] leading-relaxed text-muted-foreground">
        <Database aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
        <p className="min-w-0">
          {t('mcp.database.footerPrefix')}{' '}
          <span className="break-all font-mono text-[10.5px] text-foreground">
            {databasePath ?? '—'}
          </span>{' '}
          {t('mcp.database.footerSuffix')}
        </p>
      </div>
    </section>
  )
}
