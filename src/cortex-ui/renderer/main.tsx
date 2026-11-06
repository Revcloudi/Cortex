import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

/**
 * Web UI typography scale.
 *
 * The renderer uses a compact 10–13px type scale designed for the desktop
 * window. In a browser (especially on a 1080p/2K monitor at 100% zoom) those
 * sizes read as tiny, so the Web runtime gets a viewport-derived multiplier
 * applied to every text size (CSS variables in index.css). The desktop app is
 * intentionally left untouched.
 */
function applyWebTypeScale(): void {
  if (import.meta.env.VITE_CORTEX_RUNTIME !== 'web') return
  const root = document.documentElement
  root.classList.add('web-runtime')
  const scale = Math.min(1.3, Math.max(1.1, window.innerWidth / 1600))
  root.style.setProperty('--web-type-scale', scale.toFixed(3))
}

applyWebTypeScale()
window.addEventListener('resize', applyWebTypeScale)

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
