import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'
import { useCopy } from '@renderer/hooks/useCopy'
import { Check, Copy } from 'lucide-react'

interface CopyButtonProps {
  value: string
  label: string
  toastMessage?: string
  tone?: 'light' | 'dark'
  className?: string
  testId?: string
}

/** Icon-only copy affordance with transient check state and a toast. */
export function CopyButton({
  value,
  label,
  toastMessage,
  tone = 'light',
  className,
  testId
}: CopyButtonProps) {
  const { t } = useI18n()
  const { copied, copy } = useCopy()
  const accessibleLabel = copied ? t('common.copied') : label

  return (
    <button
      type="button"
      data-testid={testId}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      onClick={(event) => {
        event.stopPropagation()
        void copy(value, toastMessage)
      }}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors duration-150',
        tone === 'dark'
          ? 'text-white/45 hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--code))]'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className
      )}
    >
      {copied ? (
        <Check aria-hidden="true" className={cn('h-3.5 w-3.5', tone === 'dark' && 'text-emerald-400')} />
      ) : (
        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
      )}
    </button>
  )
}
