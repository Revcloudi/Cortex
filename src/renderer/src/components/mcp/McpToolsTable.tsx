import { MCP_TOOL_DOCS } from '@shared/ipc'
import { SectionHeading } from '@renderer/components/common/SectionHeading'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

const thBase =
  'sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-left text-[10.5px] font-medium text-muted-foreground'

export function McpToolsTable() {
  const { t, lang } = useI18n()

  return (
    <section>
      <SectionHeading
        title={t('mcp.tools.title')}
        description={t('mcp.tools.description')}
        action={
          <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            {t('mcp.tools.count', { count: MCP_TOOL_DOCS.length })}
          </span>
        }
      />

      <div className="mt-3 rounded-[10px] border border-border bg-background">
        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-separate border-spacing-0 text-left">
          <caption className="sr-only">{t('mcp.tools.caption')}</caption>
          <thead className="sticky top-0 z-10">
            <tr>
              <th scope="col" className={cn(thBase, 'w-[26%] pl-4')}>
                {t('mcp.tools.columnTool')}
              </th>
              <th scope="col" className={cn(thBase, 'w-[36%]')}>
                {t('mcp.tools.columnPurpose')}
              </th>
              <th scope="col" className={cn(thBase, 'hidden w-[21%] lg:table-cell')}>
                {t('mcp.tools.columnInput')}
              </th>
              <th scope="col" className={cn(thBase, 'hidden w-[17%] pr-4 lg:table-cell')}>
                {t('mcp.tools.columnReturns')}
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
                  className="align-top transition-colors duration-150 hover:bg-sidebar focus-within:bg-sidebar focus-visible:bg-sidebar"
                >
                  <td className={cn('px-3 py-3 pl-4 align-top', cellBorder)}>
                    <p className="truncate font-mono text-[12px] font-medium text-foreground">
                      {tool.name}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {tool.title[lang]}
                    </p>
                  </td>
                  <td
                    className={cn(
                      'px-3 py-3 align-top text-[12px] leading-relaxed text-muted-foreground',
                      cellBorder
                    )}
                  >
                    {tool.description[lang]}
                  </td>
                  <td
                    className={cn(
                      'hidden px-3 py-3 align-top lg:table-cell',
                      cellBorder
                    )}
                  >
                    <code className="block break-words font-mono text-[10.5px] leading-relaxed text-foreground">
                      {tool.input[lang]}
                    </code>
                  </td>
                  <td className={cn('hidden px-3 py-3 pr-4 align-top lg:table-cell', cellBorder)}>
                    <code className="block break-words font-mono text-[10.5px] leading-relaxed text-muted-foreground">
                      {tool.returns[lang]}
                    </code>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </section>
  )
}
