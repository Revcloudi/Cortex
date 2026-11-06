import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

interface InternalPanelProps {
  /** kebab-case test id, e.g. `internal-heatmap`. */
  testId: string
  title: ReactNode
  description?: ReactNode
  /** Right-aligned header content (badges, refresh buttons, filters). */
  actions?: ReactNode
  /** Trailing count rendered next to the title in mono/tabular. */
  count?: number
  children: ReactNode
  className?: string
  bodyClassName?: string
}

/**
 * Shared hairline panel for the internal operations views: the same
 * `rounded-[10px] border border-border bg-background` surface as the vuln and
 * asset tables, with a compact header row.
 */
export function InternalPanel({
  testId,
  title,
  description,
  actions,
  count,
  children,
  className,
  bodyClassName
}: InternalPanelProps) {
  return (
    <section
      data-testid={testId}
      className={cn('min-w-0 rounded-[10px] border border-border bg-background', className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="flex items-baseline gap-2 text-[12.5px] font-medium text-foreground">
            {title}
            {count !== undefined ? (
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {count}
              </span>
            ) : null}
          </h2>
          {description !== undefined ? (
            <p className="mt-0.5 max-w-[860px] text-[11px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions !== undefined ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </header>
      <div className={cn('min-w-0', bodyClassName)}>{children}</div>
    </section>
  )
}
