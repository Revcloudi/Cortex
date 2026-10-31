import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useI18n } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'
import logoMark from '@renderer/assets/logo-mark.svg'

/**
 * Custom window chrome for the frameless desktop window.
 *
 * The whole bar is a drag region; the three controls opt out with
 * `app-no-drag`. Maximize/restore state is pushed by the main process so the
 * middle icon stays in sync when the user maximizes from the taskbar or snaps
 * the window.
 */
export function Titlebar() {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const api = getApi()
    if (!api) return
    void api.isWindowMaximized().then(setMaximized)
    return api.onWindowMaximizedChanged(setMaximized)
  }, [])

  const minimize = (): void => {
    void getApi()?.minimizeWindow()
  }
  const toggleMaximize = (): void => {
    void getApi()?.toggleMaximizeWindow().then(setMaximized)
  }
  const close = (): void => {
    void getApi()?.closeWindow()
  }

  return (
    <header
      className="app-drag flex h-9 shrink-0 select-none items-center justify-between border-b border-border bg-sidebar pl-3"
      onDoubleClick={(event) => {
        if (event.target === event.currentTarget) toggleMaximize()
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <img src={logoMark} alt="" className="h-3 w-3 opacity-60" />
        <span className="truncate text-[11px] font-medium tracking-tight text-muted-foreground">
          {t('app.name')}
        </span>
      </div>

      <div className="app-no-drag flex h-full items-stretch">
        <button
          type="button"
          onClick={minimize}
          aria-label={t('window.minimize')}
          title={t('window.minimize')}
          className="flex w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
        >
          <Minus aria-hidden="true" className="h-[14px] w-[14px]" />
        </button>
        <button
          type="button"
          onClick={toggleMaximize}
          aria-label={maximized ? t('window.restore') : t('window.maximize')}
          title={maximized ? t('window.restore') : t('window.maximize')}
          className="flex w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
        >
          {maximized ? (
            <Copy aria-hidden="true" className="h-[13px] w-[13px]" />
          ) : (
            <Square aria-hidden="true" className="h-[12px] w-[12px]" />
          )}
        </button>
        <button
          type="button"
          onClick={close}
          aria-label={t('window.close')}
          title={t('window.close')}
          className="flex w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white focus-visible:bg-red-600 focus-visible:text-white focus-visible:outline-none"
        >
          <X aria-hidden="true" className="h-[14px] w-[14px]" />
        </button>
      </div>
    </header>
  )
}
