import { Database, Languages } from 'lucide-react'
import { NAV_ITEMS, type AppPage } from '@renderer/lib/navigation'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useI18n } from '@renderer/i18n'
import logoMark from '@renderer/assets/logo-mark.svg'
import { cn } from '@renderer/lib/utils'

interface SidebarProps {
  page: AppPage
  onNavigate: (page: AppPage) => void
}

export function Sidebar({ page, onNavigate }: SidebarProps) {
  const { t, lang, setLang } = useI18n()
  const nextLang = lang === 'zh' ? 'en' : 'zh'
  const languageAction = nextLang === 'en' ? t('app.switchToEnglish') : t('app.switchToChinese')

  return (
    <aside className="flex w-[236px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <ProductMark />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium tracking-tight text-foreground">
            {t('app.name')}
          </p>
          <p className="truncate text-[10.5px] text-muted-foreground">{t('app.tagline')}</p>
        </div>
      </div>

      <nav aria-label={t('ui.sidebar.mainNav')} className="flex flex-col px-3 pt-3">
        <p className="px-2.5 pb-2 pt-2 text-[10.5px] font-medium text-muted-foreground">
          {t('nav.workbench')}
        </p>
        {NAV_ITEMS.map((item) => {
          const active = item.page === page
          const Icon = item.icon
          return (
            <button
              key={item.page}
              type="button"
              onClick={() => onNavigate(item.page)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
                active
                  ? 'font-medium text-accent'
                  : 'text-muted-foreground hover:text-foreground focus-visible:text-foreground'
              )}
            >
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-accent"
                />
              ) : null}
              <Icon
                aria-hidden="true"
                className="h-[15px] w-[15px] shrink-0"
                strokeWidth={active ? 2 : 1.75}
              />
              <span>{t(item.labelKey)}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto border-t border-border px-3 py-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              data-testid="db-indicator"
              tabIndex={0}
              className="flex h-8 w-full cursor-default select-none items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
            >
              <Database aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-[11.5px] font-medium text-foreground">
                {t('sidebar.databaseConnected')}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            <span>{t('sidebar.databaseHint')}</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="lang-toggle"
              onClick={() => setLang(nextLang)}
              aria-label={languageAction}
              className="mt-2 flex h-8 w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 text-left transition-colors duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
            >
              <Languages
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
              <span className="truncate text-[11.5px] font-medium text-foreground">
                {lang === 'zh' ? 'EN' : t('app.languageChinese')}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            <span>{languageAction}</span>
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  )
}

function ProductMark() {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-foreground"
    >
      <img src={logoMark} alt="" className="h-[15px] w-[15px]" />
    </span>
  )
}
