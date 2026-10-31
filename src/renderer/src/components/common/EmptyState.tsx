import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  className?: string
  children?: ReactNode
}

export function EmptyState({ icon: Icon, title, description, className, children }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-16 text-center', className)}>
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
        <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
      </div>
      <h3 className="mt-4 text-[13.5px] font-medium text-foreground">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-[360px] text-[12px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {children ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  )
}
