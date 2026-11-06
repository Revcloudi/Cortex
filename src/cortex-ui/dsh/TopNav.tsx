import { Languages } from 'lucide-react'
import { NAV_ITEMS, type AppPage } from '@renderer/lib/navigation'
import { useI18n } from '@renderer/i18n'
import { IS_WEB_RUNTIME } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'

interface TopNavProps {
  page: AppPage
  onNavigate: (page: AppPage) => void
}

/**
 * DSH adaptation of the original Cortex sidebar.
 *
 * DeepSeek Harness already owns a left column of conversation cards, so the
 * ported app's own 236px card column produced two stacked card rails. The
 * workbench entries now live in one horizontal card row above the content
 * (same labels, icons, order and active colour as the original sidebar), and the
 * language switch sits at the row's right edge. The database card is dropped:
 * the Host owns exactly one database and DSH users do not switch it.
 */
export function TopNav({ page, onNavigate }: TopNavProps) {
  const { t, lang, setLang } = useI18n()
  const nextLang = lang === 'zh' ? 'en' : 'zh'
  const languageAction = nextLang === 'en' ? t('app.switchToEnglish') : t('app.switchToChinese')
  const items = NAV_ITEMS.filter(
    (item) => item.page !== 'mcp' && (!IS_WEB_RUNTIME || item.page !== 'ai-config')
  )

  return (
    <header
      data-testid="cortex-topnav"
      className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-3"
    >
      <nav aria-label={t('ui.sidebar.mainNav')} className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {items.map((item) => {
          const active = item.page === page
          const Icon = item.icon
          return (
            <button
              key={item.page}
              type="button"
              data-testid={`nav-${item.page}`}
              onClick={() => onNavigate(item.page)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-[12.5px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar',
                active
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
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

      <div className="ml-auto flex shrink-0 items-center pl-2">
        <button
          type="button"
          data-testid="lang-toggle"
          onClick={() => setLang(nextLang)}
          aria-label={languageAction}
          title={languageAction}
          className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-[12px] font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
        >
          <Languages aria-hidden="true" className="h-[14px] w-[14px] shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span>{lang === 'zh' ? 'EN' : t('app.languageChinese')}</span>
        </button>
      </div>
    </header>
  )
}
