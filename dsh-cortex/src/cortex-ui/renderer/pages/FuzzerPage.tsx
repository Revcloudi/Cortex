import { Zap } from 'lucide-react'
import { YakitSendPanel } from '@renderer/components/retest/YakitSendPanel'
import { useI18n } from '@renderer/i18n'

interface FuzzerPageProps {
  /**
   * Accepted for the routed-page contract only. The standalone Web Fuzzer never
   * loads vulnerabilities or findings, so this value intentionally drives nothing.
   */
  dataVersion?: number
}

/**
 * Dedicated Web Fuzzer page: a standalone Yakit-style manual HTTP sender with the
 * raw request editor on the left, the raw/JSON/render response viewer on the
 * right and both panes filling the available height.
 *
 * The page is independent of the vulnerability library: it never lists or loads
 * findings, needs no selected vulnerability, and renders the sender even when
 * there are zero vulnerabilities. The Host validates every outbound target on
 * its own.
 */
export function FuzzerPage(_props: FuzzerPageProps) {
  const { t } = useI18n()

  return (
    <div
      data-testid="fuzzer-page"
      className="mx-auto flex h-full min-h-0 w-full max-w-[1680px] flex-col px-6 py-4"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Zap aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" />
          <h1 className="truncate text-[19px] font-semibold tracking-tight text-foreground">
            {t('nav.fuzzer')}
          </h1>
        </div>
        <p className="max-w-[720px] text-right text-[10.5px] leading-relaxed text-muted-foreground">
          {t('fuzzer.page.description')}
        </p>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <YakitSendPanel />
      </div>
    </div>
  )
}
