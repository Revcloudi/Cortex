import { Check, Copy, FlaskConical, Link2 } from 'lucide-react'
import type { TestParameterCandidate } from '@shared/types'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { CopyButton } from '@renderer/components/common/CopyButton'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { useCopy } from '@renderer/hooks/useCopy'
import { testParameterValuesText } from '@renderer/lib/assets'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

interface TestParameterListProps {
  parameters: readonly TestParameterCandidate[]
  onOpenVuln: (vulnId: string) => void
}

/** Soft status chip for a seed that has / has not been used in an authz test. */
function TestedStatusBadge({ tested }: { tested: boolean }) {
  const { t } = useI18n()
  return tested ? (
    <Badge className="shrink-0 gap-1.5 border-emerald-200/70 bg-emerald-50 text-emerald-700">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      {t('asset.parameter.tested')}
    </Badge>
  ) : (
    <Badge className="shrink-0 gap-1.5 border-amber-200/70 bg-amber-50 text-amber-800">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      {t('asset.parameter.untested')}
    </Badge>
  )
}

interface ParameterFieldProps {
  label: string
  value: string
  mono?: boolean
  preserveLines?: boolean
}

/** Secondary line of a parameter card: 11px label above a readable value. */
function ParameterField({ label, value, mono = false, preserveLines = false }: ParameterFieldProps) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-foreground/70">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[11.5px] leading-relaxed text-foreground/80',
          preserveLines
            ? 'whitespace-pre-wrap break-words'
            : mono
              ? 'break-all font-mono'
              : 'break-words'
        )}
      >
        {value}
      </p>
    </div>
  )
}

function TestParameterCard({
  parameter,
  onOpenVuln
}: {
  parameter: TestParameterCandidate
  onOpenVuln: (vulnId: string) => void
}) {
  const { t, locationLabel } = useI18n()
  const { copied, copy } = useCopy()
  const valuesText = testParameterValuesText(parameter.values)

  return (
    <article
      data-testid="asset-test-parameter"
      className="min-w-0 rounded-[10px] border border-border bg-background"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Badge className="shrink-0 font-mono text-[11.5px]">{parameter.name}</Badge>
          <span className="font-mono text-[11px] text-foreground/60">
            {locationLabel(parameter.location)}
          </span>
          <TestedStatusBadge tested={parameter.tested} />
        </div>
        <Button
          variant="ghost"
          size="xs"
          data-testid="copy-test-parameter-values"
          disabled={valuesText.length === 0}
          className="shrink-0 gap-1.5 text-foreground/80"
          onClick={() => void copy(valuesText, t('asset.parameter.copyValuesToast'))}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3 w-3 text-emerald-600" />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3" />
          )}
          {copied ? t('common.copied') : t('asset.parameter.copyAll')}
        </Button>
      </header>

      <div className="space-y-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-foreground/70">
            {t('asset.parameter.endpoint')}
          </p>
          <div className="mt-0.5 flex items-start gap-1.5">
            <code className="min-w-0 break-all font-mono text-[12px] leading-relaxed text-foreground">
              {parameter.endpoint}
            </code>
            <CopyButton
              value={parameter.endpoint}
              label={t('asset.parameter.copyEndpoint')}
              toastMessage={t('asset.parameter.copyEndpointToast')}
              className="-mt-0.5"
            />
          </div>
        </div>

        <div className="min-w-0">
          <p className="text-[11px] font-medium text-foreground/70">
            {t('asset.parameter.values')}
            {parameter.values.length > 0 ? ` · ${parameter.values.length}` : ''}
          </p>
          {parameter.values.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {parameter.values.map((value, index) => (
                <span
                  key={`${value}-${index}`}
                  data-testid="asset-test-parameter-value"
                  className="inline-block max-w-full break-all rounded border border-border bg-sidebar px-1.5 py-0.5 font-mono text-[11.5px] leading-relaxed text-foreground/80"
                >
                  {value}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
              {t('asset.parameter.noValues')}
            </p>
          )}
        </div>

        {parameter.pattern ? (
          <ParameterField label={t('asset.parameter.pattern')} value={parameter.pattern} />
        ) : null}
        <ParameterField label={t('asset.parameter.source')} value={parameter.source} mono />
        {parameter.notes ? (
          <ParameterField
            label={t('asset.parameter.notes')}
            value={parameter.notes}
            preserveLines
          />
        ) : null}

        {parameter.related_vuln_ids.length > 0 ? (
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-foreground/70">
              {t('asset.parameter.relatedVulns')}
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {parameter.related_vuln_ids.map((vulnId) => (
                <Button
                  key={vulnId}
                  variant="outline"
                  size="xs"
                  data-testid="asset-test-parameter-vuln"
                  className="gap-1 font-mono text-[11.5px]"
                  onClick={() => onOpenVuln(vulnId)}
                >
                  <Link2 aria-hidden="true" className="h-3 w-3" />
                  {vulnId}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </article>
  )
}

/**
 * Fifth asset tab: harvested id / orderId / tenantId style seeds used for IDOR
 * and enumeration tests. Each card keeps endpoint, value sample and provenance
 * together; nothing is truncated and nothing scrolls horizontally.
 */
export function TestParameterList({ parameters, onOpenVuln }: TestParameterListProps) {
  const { t } = useI18n()
  return (
    <div data-testid="asset-test-parameters">
      {parameters.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title={t('asset.parameters.empty.title')}
          description={t('asset.parameters.empty.description')}
        />
      ) : (
        <div className="space-y-3">
          {parameters.map((parameter, index) => (
            <TestParameterCard
              key={`${parameter.name}-${parameter.endpoint}-${index}`}
              parameter={parameter}
              onOpenVuln={onOpenVuln}
            />
          ))}
        </div>
      )}
    </div>
  )
}
