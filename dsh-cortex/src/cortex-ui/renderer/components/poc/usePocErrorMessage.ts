import { useCallback } from 'react'
import { useI18n } from '@renderer/i18n'

/** Format an IPC/API failure and strip the machine-readable POC_* prefix. */
export function usePocErrorMessage(): (cause: unknown) => string {
  const { t } = useI18n()
  return useCallback(
    (cause: unknown) => {
      const raw = cause instanceof Error ? cause.message : String(cause ?? '')
      const cleaned = raw
        .replace(/^Invalid[^:]*:\s*/i, '')
        .replace(/^POC_[A-Z_]+:\s*/, '')
        .trim()
      return cleaned === '' ? t('common.unknownError') : cleaned
    },
    [t]
  )
}
