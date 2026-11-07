import { lazy, Suspense, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Toaster } from 'sonner'
import { TopNav } from '../dsh/TopNav'
import { DatabaseGate } from '@renderer/components/layout/DatabaseGate'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { DashboardPage } from '@renderer/pages/DashboardPage'
import { InternalPage } from '@renderer/pages/InternalPage'
import { AssetPage } from '@renderer/pages/AssetPage'
import { SnapshotPage } from '@renderer/pages/SnapshotPage'
import { AiConfigPage } from '@renderer/pages/AiConfigPage'
import { I18nProvider, useI18n } from '@renderer/i18n'
import { getApi, IS_WEB_RUNTIME } from '@renderer/lib/api'
import type { AppDetailTarget, AppPage } from '@renderer/lib/navigation'

/**
 * The nebula page pulls in Three.js via react-force-graph-3d; it must stay out
 * of the first-screen bundle, so it is the only lazily loaded page.
 */
const NebulaPage = lazy(async () => {
  const module = await import('@renderer/pages/NebulaPage')
  return { default: module.NebulaPage }
})

/**
 * The desktop-only re-test lab owns a syntax highlighter; like the nebula page
 * it must not inflate the first-screen bundle (and never loads in `ctx web`).
 */
const RetestPage = lazy(async () => {
  const module = await import('@renderer/pages/RetestPage')
  return { default: module.RetestPage }
})

/**
 * The dedicated Web Fuzzer page stays out of the first-screen bundle for the
 * same reason as the retest lab: it is a desktop-only workbench.
 */
const FuzzerPage = lazy(async () => {
  const module = await import('@renderer/pages/FuzzerPage')
  return { default: module.FuzzerPage }
})

/**
 * Mini-program reverse engineering is desktop-only too (it reads local WeChat
 * caches through the Host), so it stays out of the first-screen bundle.
 */
const MiniappPage = lazy(async () => {
  const module = await import('@renderer/pages/MiniappPage')
  return { default: module.MiniappPage }
})

export default function App() {
  const [page, setPage] = useState<AppPage>('dashboard')
  const [dataVersion, setDataVersion] = useState(0)
  /** Cross-page deep link opened by the nebula inspector. */
  const [detailTarget, setDetailTarget] = useState<AppDetailTarget | null>(null)

  const navigate = (next: AppPage): void => {
    setDetailTarget(null)
    setPage(next)
  }

  const openDetail = (target: AppDetailTarget): void => {
    setDetailTarget(target)
    setPage(target.page)
  }

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
        <div className="flex h-full flex-col overflow-hidden bg-canvas">
          {/* DSH shell adaptation: one horizontal card row replaces the cloned
              left card column and the frameless-window titlebar. */}
          <TopNav page={page} onNavigate={navigate} />

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <main className="min-h-0 flex-1 overflow-y-auto">
              <DatabaseGate>
                {page === 'dashboard' ? (
                  <DashboardPage
                    dataVersion={dataVersion}
                    onOpenInternal={() => navigate('internal')}
                    initialVulnId={detailTarget?.kind === 'vuln' ? detailTarget.id : null}
                  />
                ) : page === 'internal' ? (
                  <InternalPage dataVersion={dataVersion} />
                ) : page === 'assets' ? (
                  <AssetPage
                    dataVersion={dataVersion}
                    initialHostPort={detailTarget?.kind === 'asset' ? detailTarget.id : null}
                  />
                ) : page === 'snapshots' ? (
                  <SnapshotPage
                    dataVersion={dataVersion}
                    initialSessionId={detailTarget?.kind === 'snapshot' ? detailTarget.id : null}
                  />
                ) : page === 'nebula' ? (
                  <Suspense fallback={<NebulaPageFallback />}>
                    <NebulaPage dataVersion={dataVersion} onOpenDetail={openDetail} />
                  </Suspense>
                ) : page === 'retest' ? (
                  <Suspense fallback={<RetestPageFallback />}>
                    <RetestPage dataVersion={dataVersion} />
                  </Suspense>
                ) : page === 'fuzzer' ? (
                  <Suspense fallback={<RetestPageFallback />}>
                    <FuzzerPage dataVersion={dataVersion} />
                  </Suspense>
                ) : page === 'miniapps' ? (
                  <Suspense fallback={<MiniappPageFallback />}>
                    <MiniappPage dataVersion={dataVersion} />
                  </Suspense>
                ) : page === 'ai-config' && !IS_WEB_RUNTIME ? (
                  <AiConfigPage />
                ) : null}
              </DatabaseGate>
            </main>
          </div>

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

/**
 * Suspense fallback for the lazy nebula chunk. Dark background so going from
 * the click to the first canvas frame never flashes the light shell.
 */
function NebulaPageFallback() {
  const { t } = useI18n()
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#06080f]">
      <div className="flex items-center gap-2.5 text-[12px] text-white/45">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        {t('nebula.loading')}
      </div>
    </div>
  )
}

/** Light-weight fallback while the desktop-only re-test chunk loads. */
function RetestPageFallback() {
  const { t } = useI18n()
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        {t('common.loading')}
      </div>
    </div>
  )
}

/** Light-weight fallback while the desktop-only mini-program chunk loads. */
function MiniappPageFallback() {
  const { t } = useI18n()
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        {t('common.loading')}
      </div>
    </div>
  )
}
