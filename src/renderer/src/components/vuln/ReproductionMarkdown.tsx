import { memo, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import http from 'react-syntax-highlighter/dist/esm/languages/prism/http'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { CopyButton } from '@renderer/components/common/CopyButton'
import { useI18n } from '@renderer/i18n'

SyntaxHighlighter.registerLanguage('http', http)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('shell', bash)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)

interface CodeBlockProps extends ComponentPropsWithoutRef<'code'> {
  children?: ReactNode
}

/** Pretty-print a JSON payload when it is valid JSON; otherwise return null. */
function prettyJson(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return null
  }
}

/**
 * Format JSON bodies inside Markdown fenced `http` blocks without touching the
 * request line / headers. Agents usually paste single-line JSON responses
 * (`{"code":0,...}`); showing it indented makes evidence far easier to read.
 */
function formatHttpBlock(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n$/, '')
  const bodyStart = normalized.indexOf('\n\n')
  if (bodyStart === -1) {
    return prettyJson(normalized) ?? normalized
  }
  const head = normalized.slice(0, bodyStart)
  const body = normalized.slice(bodyStart + 2)
  const formattedBody = prettyJson(body)
  return formattedBody === null ? normalized : `${head}\n\n${formattedBody}`
}

function formatCode(raw: string, language: string | undefined): string {
  if (language === 'json' || language === 'jsonc') return prettyJson(raw) ?? raw
  if (language === 'http' || language === 'https') return formatHttpBlock(raw)
  return raw
}

function HighlightedCode({ className, children }: CodeBlockProps) {
  const { t } = useI18n()
  const language = /language-([\w-]+)/.exec(className ?? '')?.[1]
  const raw = formatCode(String(children).replace(/\n$/, ''), language)

  if (!language) {
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px] text-foreground">
        {children}
      </code>
    )
  }

  return (
    <div className="my-3 w-full min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[hsl(var(--code))]">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/45">
          {language}
        </span>
        <CopyButton
          value={raw}
          label={t('vuln.copy.codeBlock')}
          toastMessage={t('vuln.copy.codeBlockDone')}
          tone="dark"
        />
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        wrapLongLines
        customStyle={{
          margin: 0,
          padding: '12px 14px',
          background: 'transparent',
          fontSize: '11.5px',
          lineHeight: 1.7,
          fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", monospace',
          width: '100%',
          maxWidth: '100%',
          overflowX: 'hidden',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere'
        }}
        codeTagProps={{
          style: {
            fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere'
          }
        }}
      >
        {raw}
      </SyntaxHighlighter>
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => (
    <HighlightedCode className={className}>{children}</HighlightedCode>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2 break-all">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table>{children}</table>
    </div>
  )
}

/** Renders the Markdown `reproduction_steps` content, including highlighted HTTP blocks. */
export const ReproductionMarkdown = memo(function ReproductionMarkdown({
  markdown
}: {
  markdown: string
}) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
})
