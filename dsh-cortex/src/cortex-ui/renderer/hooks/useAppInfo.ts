import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import {
  apiUnavailableMessage,
  DATABASE_CHANGED_EVENT,
  getApi,
  toErrorMessage,
  type Translate
} from '@renderer/lib/api'

interface UseAppInfoResult {
  info: AppInfo | null
  error: string | null
}

/**
 * One-shot app metadata (version, db path, bundled MCP defaults).
 *
 * Refetches when the sidebar switches the desktop database. `t` is optional
 * because the app shell calls this hook above `<I18nProvider>`; without a
 * translator the message falls back to stable English.
 */
export function useAppInfo(t?: Translate): UseAppInfoResult {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const api = getApi()
    if (!api) {
      setError(apiUnavailableMessage(t))
      return
    }
    let alive = true
    const load = (): void => {
      api.getAppInfo().then(
        (next) => {
          if (!alive) return
          setInfo(next)
          setError(null)
        },
        (cause: unknown) => {
          if (alive) setError(toErrorMessage(cause, t))
        }
      )
    }
    load()
    const onDatabaseChanged = (): void => load()
    window.addEventListener(DATABASE_CHANGED_EVENT, onDatabaseChanged)
    return () => {
      alive = false
      window.removeEventListener(DATABASE_CHANGED_EVENT, onDatabaseChanged)
    }
  }, [t])

  return { info, error }
}
