import type { AppInfo } from '@shared/types'
import { stdioCommandDisplay } from '@shared/mcpConfig'
import { Database } from 'lucide-react'
import { CopyButton } from '@renderer/components/common/CopyButton'
import { McpToolsTable } from '@renderer/components/mcp/McpToolsTable'
import { useI18n } from '@renderer/i18n'

interface McpPageProps {
  info: AppInfo | null
}

/**
 * MCP access page: one-screen summary with the launch command, the database
 * file and the six tools. Agent setup snippets live in `ctx init` / docs; the
 * page deliberately fits without scrolling.
 */
export function McpPage({ info }: McpPageProps) {
  const { t } = useI18n()

  const runtime = info?.mcpRuntime ?? null
  const launchCommand = runtime ? stdioCommandDisplay(runtime) : null

  return (
    <section className="mx-auto flex h-full w-full max-w-[1240px] flex-col gap-4 px-8 py-6">
      <div
        data-testid="mcp-transport"
        className="rounded-[10px] border border-border bg-background px-5 py-4"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {t('mcp.stdio.launchCommand')}
        </p>
        <div className="mt-2 flex items-start justify-between gap-2 rounded-md border border-border bg-sidebar px-3 py-2">
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

      <div className="flex items-start gap-2.5 rounded-[10px] border border-border bg-background px-5 py-3.5">
        <Database aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-[10.5px] text-muted-foreground">{t('mcp.database.file')}</p>
          <p className="mt-0.5 break-all font-mono text-[11.5px] leading-relaxed text-foreground">
            {info?.dbPath ?? '—'}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <McpToolsTable />
      </div>
    </section>
  )
}
