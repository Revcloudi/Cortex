import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import type { AgentId, SetupInfo, SetupRunResult, SkillLanguage } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { useI18n } from '@renderer/i18n'
import { getApi, toErrorMessage } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'

const SETUP_DONE_KEY = 'cortex.setupDone'

const AGENT_LABEL_KEYS: Record<AgentId, string> = {
  dsh: 'setup.agent.dsh',
  codex: 'setup.agent.codex',
  claude: 'setup.agent.claude',
  cursor: 'setup.agent.cursor'
}

interface SetupWizardProps {
  forceOpen?: boolean
}

/**
 * First-run setup dialog.
 *
 * The Windows NSIS installer already asks for agents and skill language and runs
 * `ctx init` during installation, so this dialog normally only appears for
 * source builds, macOS DMG installs and users who skipped the installer prompt.
 * It reuses the exact same project logic (`runSetup` -> `ctx init` internals).
 */
export function SetupWizard({ forceOpen = false }: SetupWizardProps) {
  const { t, lang } = useI18n()
  const [info, setInfo] = useState<SetupInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AgentId[]>([])
  const [skillLanguage, setSkillLanguage] = useState<SkillLanguage>('zh')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SetupRunResult | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (forceOpen) {
      setVisible(true)
    } else if (window.localStorage.getItem(SETUP_DONE_KEY) === '1') {
      return
    }
    const api = getApi()
    if (!api) return
    let alive = true
    api.getSetupInfo().then(
      (next) => {
        if (!alive) return
        setInfo(next)
        setSelected(next.agents.filter((agent) => agent.detected).map((agent) => agent.id))
        setSkillLanguage(next.defaultSkillLanguage)
        setVisible(forceOpen || !next.alreadyConfigured)
      },
      (error: unknown) => {
        if (alive) setLoadError(toErrorMessage(error))
      }
    )
    return () => {
      alive = false
    }
  }, [forceOpen])

  if (!visible || dismissed) return null

  const toggleAgent = (agentId: AgentId): void => {
    setSelected((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]
    )
  }

  const finish = (): void => {
    window.localStorage.setItem(SETUP_DONE_KEY, '1')
    setDismissed(true)
  }

  const submit = async (): Promise<void> => {
    setSubmitError(null)
    if (selected.length === 0) {
      setSubmitError(t('setup.noAgents'))
      return
    }
    const api = getApi()
    if (!api) {
      setSubmitError(t('common.apiUnavailable'))
      return
    }
    setBusy(true)
    try {
      const outcome = await api.runSetup({ agents: selected, skillLanguage, uiLanguage: lang })
      setResult(outcome)
      if (outcome.success) window.localStorage.setItem(SETUP_DONE_KEY, '1')
    } catch (error) {
      setSubmitError(toErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('setup.title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/25 p-6 backdrop-blur-[1px]"
    >
      <div className="w-full max-w-[560px] rounded-[12px] border border-border bg-background shadow-[0_24px_80px_-24px_rgba(15,23,42,0.35)]">
        <div className="border-b border-border px-6 py-5">
          <h2 className="text-[17px] font-medium tracking-tight text-foreground">
            {t('setup.title')}
          </h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
            {t('setup.description')}
          </p>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
          {info === null && loadError === null ? (
            <p className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              {t('setup.loading')}
            </p>
          ) : loadError !== null ? (
            <p className="py-4 text-[12px] text-red-700">{loadError}</p>
          ) : (
            info !== null && (
              <>
                <section>
                  <h3 className="text-[12px] font-medium text-foreground">
                    {t('setup.agentsTitle')}
                  </h3>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t('setup.agentsHint')}
                  </p>
                  <div className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {info.agents.map((agent) => {
                      const checked = selected.includes(agent.id)
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => toggleAgent(agent.id)}
                          aria-pressed={checked}
                          className={cn(
                            'flex items-start gap-2.5 rounded-[8px] border px-3 py-2 text-left transition-colors',
                            checked
                              ? 'border-accent/40 bg-accent-soft/60'
                              : 'border-border bg-background hover:bg-sidebar'
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                              checked
                                ? 'border-accent bg-accent text-accent-foreground'
                                : 'border-border bg-background'
                            )}
                          >
                            {checked ? <Check aria-hidden="true" className="h-3 w-3" /> : null}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[12px] font-medium text-foreground">
                              {t(AGENT_LABEL_KEYS[agent.id])}
                            </span>
                            <span className="block text-[10.5px] text-muted-foreground">
                              {agent.detected ? t('setup.detected') : t('setup.notDetected')}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section className="mt-5">
                  <h3 className="text-[12px] font-medium text-foreground">
                    {t('setup.skillLanguageTitle')}
                  </h3>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t('setup.skillLanguageHint')}
                  </p>
                  <div className="mt-2.5 flex gap-1.5">
                    {(['zh', 'en'] as const).map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        onClick={() => setSkillLanguage(candidate)}
                        aria-pressed={skillLanguage === candidate}
                        className={cn(
                          'rounded-[8px] border px-3 py-1.5 text-[12px] transition-colors',
                          skillLanguage === candidate
                            ? 'border-accent/40 bg-accent-soft/60 font-medium text-accent'
                            : 'border-border bg-background text-muted-foreground hover:bg-sidebar'
                        )}
                      >
                        {candidate === 'zh' ? t('setup.skillZh') : t('setup.skillEn')}
                      </button>
                    ))}
                  </div>
                </section>

                {result !== null ? (
                  <div className="mt-5 rounded-[8px] border border-emerald-200/70 bg-emerald-50 px-3 py-2.5">
                    <p className="text-[12px] font-medium text-emerald-800">{t('setup.success')}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-emerald-700">
                      {t('setup.successHint')}
                    </p>
                    <ul className="mt-2 space-y-0.5">
                      {result.actions
                        .filter((action) => action.status !== 'skipped')
                        .slice(0, 8)
                        .map((action) => (
                          <li
                            key={`${action.path}-${action.kind}`}
                            className="break-all font-mono text-[10px] text-emerald-800/90"
                          >
                            {action.status === 'manual-required'
                              ? `${t('setup.manualRequired')}: `
                              : ''}
                            {action.path}
                          </li>
                        ))}
                    </ul>
                    {result.warnings.length > 0 ? (
                      <ul className="mt-2 space-y-0.5">
                        {result.warnings.map((warning) => (
                          <li key={warning} className="text-[10.5px] leading-relaxed text-amber-800">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                {submitError !== null ? (
                  <p className="mt-4 text-[11.5px] leading-relaxed text-red-700">{submitError}</p>
                ) : null}
              </>
            )
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          {result !== null ? (
            <Button size="sm" onClick={finish}>
              {t('setup.close')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={finish} disabled={busy}>
                {t('setup.skip')}
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={busy || info === null}>
                {busy ? (
                  <Loader2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {busy ? t('setup.applying') : t('setup.apply')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
