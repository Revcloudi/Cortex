import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { CopyButton } from './CopyButton'

interface CodeBlockProps {
  label: string
  value: string
  className?: string
  maxHeightClassName?: string
  copyToast?: string
  testId?: string
}

/**
 * Dark code surface for JSON config snippets. Mono type, horizontal scroll and
 * a capped height so long payloads never blow up the layout.
 */
export function CodeBlock({
  label,
  value,
  className,
  maxHeightClassName = 'max-h-[240px]',
  copyToast,
  testId
}: CodeBlockProps) {
  const { t } = useI18n()

  return (
    <div
      data-testid={testId}
      className={cn('overflow-hidden rounded-md border border-white/10 bg-[hsl(var(--code))]', className)}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[10px] tracking-[0.14em] text-white/45">{label}</span>
        <CopyButton
          value={value}
          label={t('ui.codeBlock.copy', { label })}
          toastMessage={copyToast ?? t('ui.codeBlock.copied', { label })}
          tone="dark"
        />
      </div>
      <pre
        className={cn(
          'scrollbar-thin overflow-auto whitespace-pre px-3 py-2.5 font-mono text-[11px] leading-[1.7] text-[hsl(220_15%_86%)]',
          maxHeightClassName
        )}
      >
        {value}
      </pre>
    </div>
  )
}
