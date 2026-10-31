import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useI18n } from '@renderer/i18n'
import { copyText } from '@renderer/lib/clipboard'

interface UseCopyResult {
  copied: boolean
  copy: (text: string, successMessage?: string) => Promise<void>
}

/** Copy-to-clipboard with a transient `copied` state for check-icon feedback. */
export function useCopy(): UseCopyResult {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => window.clearTimeout(timer.current)
  }, [])

  const copy = useCallback(
    async (text: string, successMessage?: string) => {
      const ok = await copyText(text)
      if (!ok) {
        toast.error(t('ui.copy.failed'))
        return
      }
      setCopied(true)
      toast(successMessage ?? t('ui.copy.copiedToClipboard'))
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    },
    [t]
  )

  return { copied, copy }
}
