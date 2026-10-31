import type { PentestDataHubApi } from '@shared/ipc'

/** Translator signature shared by `useI18n().t` and the fallbacks below. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * Stable English fallback for call sites that run before or outside the
 * `<I18nProvider>` (for example a hook called by the app shell itself).
 * User-visible UI should prefer `apiUnavailableMessage(t)`.
 */
export const API_UNAVAILABLE_MESSAGE =
  'Cannot reach the main-process API. Start the app through the Electron client.'

/** Localized "main-process API is missing" message, with an English fallback. */
export function apiUnavailableMessage(t?: Translate): string {
  return t ? t('common.apiUnavailable') : API_UNAVAILABLE_MESSAGE
}

/**
 * The renderer communicates with the main process only through `window.api`.
 * It is absent when the renderer runs outside Electron (for example `vite dev`
 * in a browser), so call sites guard on `null` and render an error state
 * instead of crashing.
 */
export function getApi(): PentestDataHubApi | null {
  if (typeof window === 'undefined') return null
  return typeof window.api === 'undefined' ? null : window.api
}

export function toErrorMessage(error: unknown, t?: Translate): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return t ? t('common.unknownError') : 'Unknown error'
}
