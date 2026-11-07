import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Database, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useI18n } from '@renderer/i18n'
import {
  DatabaseApiError,
  configureDatabase,
  getDatabaseStatus,
  probeDatabase,
  type DatabaseStatus,
  type ProbeFailure
} from '@renderer/lib/databaseApi'

interface DatabaseGateProps {
  children: ReactNode
}

type GateState =
  | { kind: 'checking' }
  | { kind: 'ready'; readOnly: boolean }
  | { kind: 'error'; failure: ProbeFailure; database: DatabaseStatus | null }

/**
 * Turns a non-functional page set into one actionable setup screen when the
 * Host cannot open a Cortex database. This is the common failure mode of a Web
 * DSH server that runs on another machine / user and therefore cannot see the
 * operator's `~/.cortex/data.db`.
 */
export function DatabaseGate({ children }: DatabaseGateProps) {
  const { t } = useI18n()
  const [state, setState] = useState<GateState>({ kind: 'checking' })
  const [path, setPath] = useState('~/.cortex/data.db')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const check = useCallback(async (): Promise<void> => {
    setState({ kind: 'checking' })
    setActionError(null)
    const probe = await probeDatabase()
    const database = await getDatabaseStatus().catch(() => null)
    if (probe.ok) {
      setState({
        kind: 'ready',
        readOnly: database !== null && (database.readOnly || database.readOnlyFallback)
      })
    } else {
      setState({ kind: 'error', failure: probe.failure, database })
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  const apply = async (value: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      const database = await configureDatabase(value)
      if (database.compatible && database.schemaVersion === 5) {
        setState({ kind: 'ready', readOnly: database.readOnly || database.readOnlyFallback })
      } else {
        const failure: ProbeFailure = {
          message:
            database.openError ??
            t('dbGate.failed', { error: database.openError ?? `schema v${database.schemaVersion}` }),
          detail: database.openError,
          code: 'INCOMPATIBLE'
        }
        setState({ kind: 'error', failure, database })
      }
    } catch (cause) {
      if (cause instanceof DatabaseApiError && (cause.status === 404 || cause.code === 'NOT_FOUND')) {
        setActionError(t('dbGate.unsupported'))
      } else {
        setActionError(
          t('dbGate.applyFailed', {
            error: cause instanceof Error ? cause.message : String(cause)
          })
        )
      }
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'checking') {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          {t('dbGate.checking')}
        </div>
      </div>
    )
  }

  if (state.kind === 'ready') {
    return (
      <>
        {state.readOnly ? (
          <div
            role="status"
            className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900"
          >
            {t('dbGate.readOnly')}
          </div>
        ) : null}
        {children}
      </>
    )
  }

  const database = state.database
  const failure = state.failure
  const schemaLine =
    database !== null && database.schemaVersion > 0
      ? t('dbGate.schema', { version: database.schemaVersion })
      : '—'

  return (
    <div data-testid="db-gate" className="flex min-h-full w-full items-start justify-center px-4 py-10">
      <div className="w-full max-w-[600px] rounded-xl border border-border bg-background p-5 shadow-panel">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-sidebar text-muted-foreground">
            <Database aria-hidden="true" className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
              {t('dbGate.title')}
            </h2>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
              {t('dbGate.description')}
            </p>
          </div>
        </div>

        <div
          data-testid="db-gate-error"
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700"
        >
          <p>{t('dbGate.failed', { error: failure.message })}</p>
          {failure.detail !== null && failure.detail !== failure.message ? (
            <p data-testid="db-gate-detail" className="mt-1 font-mono text-[10.5px] opacity-80">
              {failure.detail}
            </p>
          ) : null}
          {database !== null && database.schemaVersion > 0 && database.schemaVersion !== 5 ? (
            <p className="mt-1">{t('dbGate.incompatible', { version: database.schemaVersion })}</p>
          ) : null}
        </div>

        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[10.5px]">
          <dt className="text-muted-foreground">{t('dbGate.current')}</dt>
          <dd className="min-w-0 truncate font-mono text-foreground">
            {database !== null && database.dbPath !== '' ? database.dbPath : t('dbGate.none')}
          </dd>
          <dt className="text-muted-foreground">{t('dbGate.schemaLabel')}</dt>
          <dd className="font-mono text-foreground">{schemaLine}</dd>
          <dt className="text-muted-foreground">{t('dbGate.fileLabel')}</dt>
          <dd className="text-foreground">
            {database?.exists === true ? t('dbGate.exists') : t('dbGate.missing')}
          </dd>
        </dl>

        <label htmlFor="db-gate-path" className="mt-4 block text-[10.5px] font-medium text-foreground">
          {t('dbGate.pathLabel')}
        </label>
        <Input
          id="db-gate-path"
          data-testid="db-gate-path"
          value={path}
          spellCheck={false}
          onChange={(event) => setPath(event.target.value)}
          placeholder={t('dbGate.pathPlaceholder')}
          className="mt-1.5 h-9 font-mono text-[11px]"
        />
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">{t('dbGate.hint')}</p>
        {actionError !== null ? (
          <p role="alert" className="mt-2 text-[11px] leading-relaxed text-red-700">
            {actionError}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" data-testid="db-gate-retry" disabled={busy} onClick={() => void check()}>
            <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            {t('dbGate.retry')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="db-gate-reset"
            disabled={busy}
            onClick={() => {
              setPath('~/.cortex/data.db')
              void apply('')
            }}
          >
            {t('dbGate.reset')}
          </Button>
          <Button
            size="sm"
            data-testid="db-gate-apply"
            disabled={busy}
            onClick={() => void apply(path)}
          >
            {busy ? <Loader2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {busy ? t('dbGate.applying') : t('dbGate.apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}
