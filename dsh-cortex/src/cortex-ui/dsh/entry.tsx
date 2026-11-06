// Bundle entry for the ported Cortex UI. Built by esbuild into an IIFE global
// (`__DSH_CORTEX_UI__`); the DSH wrapper client.js mounts it inside a Shadow DOM
// so the original Tailwind stylesheet never touches the DSH shell.
import { createRoot } from 'react-dom/client'
import App from '../renderer/App'
import { setPortalContainer } from './portal'

export interface CortexUiHandle {
  destroy(): void
}

/**
 * Mount the original Cortex renderer into `host`.
 * `css` is the Tailwind build with fonts inlined as data URLs.
 */
export function mount(host: HTMLElement, css: string): CortexUiHandle {
  const shadow = host.attachShadow({ mode: 'open' })

  const styleElement = document.createElement('style')
  styleElement.setAttribute('data-dsh-cortex-ui', '')
  styleElement.textContent = css
  shadow.appendChild(styleElement)

  const rootElement = document.createElement('div')
  rootElement.className = 'dshc-cortex-root'
  rootElement.style.height = '100%'
  rootElement.style.width = '100%'
  rootElement.style.overflow = 'hidden'
  shadow.appendChild(rootElement)

  setPortalContainer(rootElement)
  document.documentElement.lang = document.documentElement.lang || 'zh-CN'

  const root = createRoot(rootElement)
  root.render(<App />)

  return {
    destroy() {
      try {
        root.unmount()
      } catch {
        /* already unmounted */
      }
      shadow.innerHTML = ''
    },
  }
}

/** Original logo mark for the DSH sidebar entry (data URL filled at build time). */
export { default as logoMarkUrl } from '../renderer/assets/logo-mark.svg'
