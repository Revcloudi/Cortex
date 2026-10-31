import { useState } from 'react'
import { Loader2, Plug } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { CopyButton } from '@renderer/components/common/CopyButton'
import { McpToolsTable } from '@renderer/components/mcp/McpToolsTable'
import { useI18n } from '@renderer/i18n'
import { getApi, IS_WEB_RUNTIME, toErrorMessage } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'

/**
 * MCP access page: one compact action row (connect agents / copy the init
 * command) plus the six-tool reference. No installer-time agent setup: the
 * configuration is written here, after the user has installed the app.
 */
export function McpPage() {
  const { t, lang } = useI18n()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  const connect = async (): Promise<void> => {
    const api = getApi()
    if (!api) {
      setMessage({ text: t('common.apiUnavailable'), error: true })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const info = await api.getSetupInfo()
      const agents = info.agents.filter((agent) => agent.detected).map((agent) => agent.id)
      if (agents.length === 0) {
        setMessage({ text: t('mcp.connect.none'), error: true })
        return
      }
      // In Web mode the configs are written on the host that runs `ctx web`,
      // not on this browser's machine, so ask before touching its disk.
      if (IS_WEB_RUNTIME && !window.confirm(t('mcp.connect.webConfirm'))) return
      const result = await api.runSetup({
        agents,
        skillLanguage: lang,
        uiLanguage: lang
      })
      if (result.success) {
        setMessage({ text: t('mcp.connect.done'), error: false })
      } else {
        setMessage({
          text: t('mcp.connect.failed', {
            error: result.warnings[0] ?? t('common.unknownError')
          }),
          error: true
        })
      }
    } catch (error) {
      setMessage({
        text: t('mcp.connect.failed', { error: toErrorMessage(error, t) }),
        error: true
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="mcp-page"
      className="mx-auto flex h-full w-full max-w-[1240px] flex-col px-8 py-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <code className="rounded-md border border-border bg-sidebar px-2.5 py-1.5 font-mono text-[11px] text-foreground">
            ctx init --yes
          </code>
          <CopyButton
            value="ctx init --yes"
            label={t('common.copy')}
            toastMessage={t('common.copied')}
          />
        </div>
        <Button size="sm" onClick={() => void connect()} disabled={busy}>
          {busy ? (
            <Loader2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plug aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          )}
          {busy ? t('mcp.connect.busy') : t('mcp.connect.button')}
        </Button>
      </div>

      {IS_WEB_RUNTIME ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('mcp.connect.webHint')}
        </p>
      ) : null}

      {message !== null ? (
        <p
          className={cn(
            'mt-2 text-[11.5px] leading-relaxed',
            message.error ? 'text-red-700' : 'text-emerald-700'
          )}
        >
          {message.text}
        </p>
      ) : null}

      <div className="mt-4 min-h-0 flex-1">
        <McpToolsTable />
      </div>
    </section>
  )
}
