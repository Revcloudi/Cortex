import { useEffect, useState } from 'react'
import type { DatabaseInfo } from '@shared/types'
import { useI18n } from '@renderer/i18n'
import {
  apiUnavailableMessage,
  DATABASE_CHANGED_EVENT,
  getApi,
  toErrorMessage
} from '@renderer/lib/api'

interface UseDbInfoResult {
  info: DatabaseInfo | null
  error: string | null
}

/**
 * On-disk database snapshot for the MCP page.
 *
 * Refetches when the sidebar switches the desktop database; otherwise nothing
 * polls because the main process pushes `data:changed` on file writes.
 */
export function useDbInfo(): UseDbInfoResult {
  const { t } = useI18n()
  const [info, setInfo] = useState<DatabaseInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const api = getApi()
    if (!api) {
      setError(apiUnavailableMessage(t))
      return
    }
    let alive = true
    const load = (): void => {
      api.getDatabaseInfo().then(
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
