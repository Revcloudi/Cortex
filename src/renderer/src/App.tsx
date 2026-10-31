import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { Sidebar } from '@renderer/components/layout/Sidebar'
import { SetupWizard } from '@renderer/components/setup/SetupWizard'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { DashboardPage } from '@renderer/pages/DashboardPage'
import { AssetPage } from '@renderer/pages/AssetPage'
import { SnapshotPage } from '@renderer/pages/SnapshotPage'
import { McpPage } from '@renderer/pages/McpPage'
import { useAppInfo } from '@renderer/hooks/useAppInfo'
import { I18nProvider } from '@renderer/i18n'
import { getApi } from '@renderer/lib/api'
import type { AppPage } from '@renderer/lib/navigation'

export default function App() {
  const [page, setPage] = useState<AppPage>('dashboard')
  const [dataVersion, setDataVersion] = useState(0)
  const { info } = useAppInfo()

  useEffect(() => {
    const api = getApi()
    if (!api) return
    let timer: number | undefined
    const unsubscribe = api.onDataChanged(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setDataVersion((value) => value + 1), 120)
    })
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  return (
    <I18nProvider>
      <TooltipProvider delayDuration={200}>
        <div className="flex h-full overflow-hidden bg-canvas">
          <Sidebar page={page} onNavigate={setPage} databasePath={info?.dbPath ?? null} />

          <div className="flex min-w-0 flex-1 flex-col">
            <main className="min-h-0 flex-1 overflow-y-auto">
              {page === 'dashboard' ? (
                <DashboardPage dataVersion={dataVersion} onOpenMcp={() => setPage('mcp')} />
              ) : page === 'assets' ? (
                <AssetPage dataVersion={dataVersion} />
              ) : page === 'snapshots' ? (
                <SnapshotPage dataVersion={dataVersion} />
              ) : (
                <McpPage info={info} />
              )}
            </main>
          </div>

          <SetupWizard />

          <Toaster
            theme="light"
            position="bottom-left"
            offset={16}
            duration={1000}
            toastOptions={{
              style: {
                background: 'hsl(0 0% 100%)',
                color: 'hsl(224 18% 10%)',
                border: '1px solid hsl(220 14% 91%)',
                borderRadius: '10px',
                boxShadow:
                  '0 16px 40px -16px rgba(15, 23, 42, 0.22), 0 1px 3px rgba(15, 23, 42, 0.06)',
                fontSize: '12.5px',
                padding: '10px 12px'
              },
              classNames: {
                toast: 'font-sans',
                title: 'text-[12.5px] font-medium text-foreground',
                description: 'text-[11.5px] text-muted-foreground'
              }
            }}
          />
        </div>
      </TooltipProvider>
    </I18nProvider>
  )
}
