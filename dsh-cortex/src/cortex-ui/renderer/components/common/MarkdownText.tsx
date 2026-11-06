import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@renderer/lib/utils'

interface MarkdownTextProps {
  content: string
  className?: string
  /** Tight spacing for use inside list items / inline metadata blocks. */
  compact?: boolean
}

/**
 * Turn inline numbered sequences such as `1. Recon 2. Craft request 3. Verify response`
 * into a Markdown ordered list so each item is rendered on its own line. Text
 * that already uses line breaks is left untouched.
 */
function normalizeNumberedSequence(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (/(?:^|\s)\d{1,2}[.、]\s*/.exec(line) === null) return line
      const markers = line.match(/(?:^|\s)\d{1,2}[.、]\s*/g)
      if (!markers || markers.length < 2) return line

      const firstIndex = line.search(/\d{1,2}[.、]\s/)
      if (firstIndex === -1) return line
      const prefix = line.slice(0, firstIndex).trimEnd()
      const list = line
        .slice(firstIndex)
        .replace(/\s+(?=\d{1,2}[.、]\s*)/g, '\n')
      return prefix ? `${prefix}\n\n${list}` : list
    })
    .join('\n')
}

/**
 * Shared Markdown renderer for prose fields (description, impact, remediation,
 * crypto, test boundaries). Reproduction evidence uses the richer renderer with
 * syntax highlighting.
 */
export const MarkdownText = memo(function MarkdownText({
  content,
  className,
  compact = false
}: MarkdownTextProps) {
  if (!content.trim()) return null
  return (
    <div className={cn('markdown-body', compact && 'markdown-body--compact', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizeNumberedSequence(content)}
      </ReactMarkdown>
    </div>
  )
})
