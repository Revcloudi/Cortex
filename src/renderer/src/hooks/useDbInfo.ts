import { useEffect, useState } from 'react'
import type { DatabaseInfo } from '@shared/types'
import { useI18n } from '@renderer/i18n'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'

interface UseDbInfoResult {
  info: DatabaseInfo | null
  error: string | null
}

/**
 * One-shot on-disk database snapshot for the MCP page.
 *
 * Nothing polls: the main process watches the SQLite files and pushes
 * `data:changed`, so the renderer only needs the file metadata once per mount.
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
    api.getDatabaseInfo().then(
      (next) => {
        if (alive) setInfo(next)
      },
      (cause: unknown) => {
        if (alive) setError(toErrorMessage(cause, t))
      }
    )
    return () => {
      alive = false
    }
  }, [t])

  return { info, error }
}
