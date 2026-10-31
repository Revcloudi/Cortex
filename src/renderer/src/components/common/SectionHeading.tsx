import type { ReactNode } from 'react'

interface SectionHeadingProps {
  title: string
  description?: string
  action?: ReactNode
}

/** Section header used on the MCP page: title + supporting sentence. */
export function SectionHeading({ title, description, action }: SectionHeadingProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[14px] font-medium tracking-tight text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-[560px] text-[11.5px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  )
}
