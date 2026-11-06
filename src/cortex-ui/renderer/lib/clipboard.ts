import { getApi } from './api'

/**
 * Clipboard writes from the renderer. Electron's native clipboard bridge is
 * tried first because `navigator.clipboard` is unreliable under `file://`
 * (and requires transient user activation). The async Clipboard API and a
 * hidden-textarea fallback keep copy working outside the desktop shell.
 */
export async function copyText(text: string): Promise<boolean> {
  const api = getApi()
  if (api) {
    try {
      await api.writeClipboard(text)
      return true
    } catch {
    }
  }

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-9999px'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}
