/** Translator signature shared by `useI18n().t` and the fallbacks below. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * Stable English fallback for call sites that run before or outside the
 * `<I18nProvider>` (for example a hook called by the app shell itself).
 * User-visible UI should prefer `apiUnavailableMessage(t)`.
 */
export const API_UNAVAILABLE_MESSAGE =
  'Cannot reach the main-process API. Start the app through the Electron client.'

/** Fired after the sidebar switches the desktop database (renderer-side only). */
export const DATABASE_CHANGED_EVENT = 'cortex:database-changed'

/** Localized "main-process API is missing" message, with an English fallback. */
export function apiUnavailableMessage(t?: Translate): string {
  return t ? t('common.apiUnavailable') : API_UNAVAILABLE_MESSAGE
}

/**
 * Transport selection lives in `./transport`:
 * - Electron desktop → the preload bridge (`window.api`);
 * - `ctx web` browser build → same-origin fetch + SSE (`createHttpApi`).
 *
 * Re-exported here so every existing call site keeps importing `getApi` from
 * `@renderer/lib/api`, and the desktop behavior is unchanged.
 */
export { getApi, IS_WEB_RUNTIME } from './transport'

export function toErrorMessage(error: unknown, t?: Translate): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return t ? t('common.unknownError') : 'Unknown error'
}
