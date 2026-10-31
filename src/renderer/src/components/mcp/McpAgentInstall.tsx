import type { AppInfo } from '@shared/types'
import { buildAgentMcpSnippets, type AgentConfigFormat } from '@shared/mcpConfig'
import { CodeBlock } from '@renderer/components/common/CodeBlock'
import { SectionHeading } from '@renderer/components/common/SectionHeading'
import { useI18n } from '@renderer/i18n'

interface McpAgentInstallProps {
  info: AppInfo
}

const FORMAT_LABELS: Record<AgentConfigFormat, string> = {
  yaml: 'YAML',
  toml: 'TOML',
  json: 'JSON',
  shell: 'SHELL'
}

/**
 * Four agent config snippets built from the exact same stdio launch target the
 * CLI uses, so the GUI and `ctx init` can never drift apart.
 */
export function McpAgentInstall({ info }: McpAgentInstallProps) {
  const { t, lang } = useI18n()
  const snippets = buildAgentMcpSnippets({
    command: info.mcpRuntime.command,
    entry: info.mcpRuntime.entry
  })

  return (
    <section>
      <SectionHeading
        title={t('mcp.agents.title')}
        description={t('mcp.agents.description')}
        action={
          <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            {t('mcp.agents.clients', { count: snippets.length })}
          </span>
        }
      />

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {snippets.map((snippet) => (
          <article
            key={snippet.id}
            className="flex min-w-0 flex-col rounded-[10px] border border-border bg-background p-4"
          >
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[13.5px] font-medium tracking-tight text-foreground">
                  {snippet.name}
                </h3>
                <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <span className="shrink-0">{t('mcp.agents.configLocation')}</span>
                  <span className="break-all font-mono text-[10.5px] text-foreground">
                    {snippet.target}
                  </span>
                </p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  {snippet.description[lang]}
                </p>
              </div>
              <span className="inline-flex h-[22px] shrink-0 items-center rounded-full border border-border bg-secondary px-2 font-mono text-[9.5px] uppercase tracking-[0.08em] text-secondary-foreground">
                {FORMAT_LABELS[snippet.format]}
              </span>
            </header>

            <div className="mt-3">
              <CodeBlock
                label={`${snippet.name} · ${FORMAT_LABELS[snippet.format]}`}
                value={snippet.value}
                maxHeightClassName="max-h-[220px]"
                copyToast={t('mcp.agents.copyToast', { name: snippet.name })}
              />
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
