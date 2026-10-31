import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import {
  apiUnavailableMessage,
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
 * `t` is optional because the app shell calls this hook above `<I18nProvider>`;
 * without a translator the message falls back to stable English. Pass
 * `useI18n().t` when the hook renders inside the provider.
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
    api.getAppInfo().then(
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
