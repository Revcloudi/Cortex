import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AssetStatus,
  Severity,
  TestParameterLocation,
  UiLanguage,
  VulnStatus
} from '@shared/types'
import { messages } from './messages'

export type Lang = UiLanguage
export type MessageParams = Record<string, string | number>

export interface I18nContextValue {
  lang: Lang
  setLang(lang: Lang): void
  t(key: string, params?: MessageParams): string
  severityLabel(severity: Severity): string
  statusLabel(status: VulnStatus): string
  assetStatusLabel(status: AssetStatus): string
  locationLabel(location: TestParameterLocation): string
}

const STORAGE_KEY = 'cortex.lang'

function detectInitialLanguage(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
  }
  const navigatorLanguage = typeof navigator === 'undefined' ? '' : navigator.language
  return navigatorLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function translate(lang: Lang, key: string, params?: MessageParams): string {
  const template = messages[lang][key] ?? messages.zh[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    params[name] === undefined ? `{${name}}` : String(params[name])
  )
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectInitialLanguage())

  useEffect(() => {
    document.documentElement.lang = lang
    try {
      window.localStorage.setItem(STORAGE_KEY, lang)
    } catch {
    }
  }, [lang])

  const setLang = useCallback((next: Lang) => setLangState(next), [])
  const t = useCallback((key: string, params?: MessageParams) => translate(lang, key, params), [lang])

  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      setLang,
      t,
      severityLabel: (severity: Severity) => t(`label.severity.${severity}`),
      statusLabel: (status: VulnStatus) => t(`label.status.${status}`),
      assetStatusLabel: (status: AssetStatus) => t(`label.assetStatus.${status}`),
      locationLabel: (location: TestParameterLocation) => t(`label.location.${location}`)
    }),
    [lang, setLang, t]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext)
  if (value === null) throw new Error('useI18n must be used inside <I18nProvider>')
  return value
}
