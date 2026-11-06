import { MCP_TOOL_DOCS } from '@shared/ipc'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

const thBase =
  'border-b border-border bg-background px-3 py-2 text-left text-[10.5px] font-medium text-muted-foreground'

/**
 * Compact tool reference: one line per tool. Full input/return schemas are
 * intentionally omitted so the MCP page fits on a single screen.
 */
export function McpToolsTable() {
  const { t, lang } = useI18n()

  return (
    <section className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-medium tracking-tight text-foreground">
          {t('mcp.tools.title')}
        </h2>
        <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          {t('mcp.tools.count', { count: MCP_TOOL_DOCS.length })}
        </span>
      </div>

      <div className="mt-2 overflow-hidden rounded-[10px] border border-border bg-background">
        <table className="w-full table-fixed border-separate border-spacing-0 text-left">
          <caption className="sr-only">{t('mcp.tools.caption')}</caption>
          <thead>
            <tr>
              <th scope="col" className={cn(thBase, 'w-[42%] pl-4')}>
                {t('mcp.tools.columnTool')}
              </th>
              <th scope="col" className={cn(thBase, 'pr-4')}>
                {t('mcp.tools.columnPurpose')}
              </th>
            </tr>
          </thead>
          <tbody>
            {MCP_TOOL_DOCS.map((tool, index) => {
              const last = index === MCP_TOOL_DOCS.length - 1
              const cellBorder = last ? '' : 'border-b border-border'
              return (
                <tr
                  key={tool.name}
                  className="transition-colors duration-150 hover:bg-sidebar"
                >
                  <td className={cn('px-3 py-2.5 pl-4', cellBorder)}>
                    <span className="block truncate font-mono text-[12px] font-medium text-foreground">
                      {tool.name}
                    </span>
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2.5 pr-4 text-[12px] leading-relaxed text-muted-foreground',
                      cellBorder
                    )}
                  >
                    {tool.title[lang]}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
