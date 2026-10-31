import type { ReactNode } from 'react'
import type { Vulnerability } from '@shared/types'
import { ChevronRight } from 'lucide-react'
import { MarkdownText } from '@renderer/components/common/MarkdownText'
import { useI18n } from '@renderer/i18n'
import { prefetchVulnerability } from '@renderer/lib/vulnPreload'
import { cn } from '@renderer/lib/utils'

function MetaLabel({ children }: { children: ReactNode }) {
  const { lang } = useI18n()

  return (
    <h3
      className={cn(
        'shrink-0 pt-px text-[10.5px] font-medium text-muted-foreground',
        // Two-character Chinese labels fit the original 40px column; English
        // labels need a wider fixed column so all rows stay aligned.
        lang === 'zh' ? 'w-10' : 'w-16'
      )}
    >
      {children}
    </h3>
  )
}

function FieldBlock({ label, text }: { label: string; text: string }) {
  const { t } = useI18n()

  return (
    <div className="flex gap-3">
      <MetaLabel>{label}</MetaLabel>
      <div className="min-w-0 flex-1">
        {text ? (
          <MarkdownText content={text} compact />
        ) : (
          <p className="text-[11.5px] text-muted-foreground">{t('vuln.summary.notRecorded')}</p>
        )}
      </div>
    </div>
  )
}

interface VulnSummaryProps {
  vuln: Vulnerability
  onOpenRelated: (id: string) => void
}

/**
 * Vulnerability summary: Markdown description and impact, aligned interface
 * list, and related findings. No clamping; all content is visible immediately.
 */
export function VulnSummary({ vuln, onOpenRelated }: VulnSummaryProps) {
  const { t } = useI18n()

  return (
    <div className="space-y-3">
      <FieldBlock label={t('vuln.summary.description')} text={vuln.description} />
      <FieldBlock label={t('vuln.summary.impact')} text={vuln.impact} />

      <div className="flex gap-3">
        <MetaLabel>{t('vuln.summary.interfaces')}</MetaLabel>
        <div className="min-w-0 flex-1">
          {vuln.affected_interfaces.length > 0 ? (
            <ul className="space-y-1">
              {vuln.affected_interfaces.map((iface) => (
                <li
                  key={iface}
                  className="break-all font-mono text-[10.5px] leading-relaxed text-foreground"
                >
                  {iface}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11.5px] text-muted-foreground">{t('vuln.summary.notRecorded')}</p>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <MetaLabel>{t('vuln.summary.related')}</MetaLabel>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {vuln.related_vuln_ids.length > 0 ? (
            vuln.related_vuln_ids.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onOpenRelated(id)}
                onMouseEnter={() => prefetchVulnerability(id)}
                onFocus={() => prefetchVulnerability(id)}
                className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10.5px] text-foreground transition-colors duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                title={t('vuln.summary.openRelated')}
              >
                {id}
                <ChevronRight aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
              </button>
            ))
          ) : (
            <p className="text-[11.5px] text-muted-foreground">{t('vuln.summary.noRelated')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
