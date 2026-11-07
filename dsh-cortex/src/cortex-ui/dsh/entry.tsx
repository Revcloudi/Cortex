// Bundle entry for the ported Cortex UI. Built by esbuild into an IIFE global
// (`__DSH_CORTEX_UI__`); the DSH wrapper client.js mounts it inside a Shadow DOM
// so the original Tailwind stylesheet never touches the DSH shell.
import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../renderer/App'
import { setPortalContainer } from './portal'

export interface CortexUiHandle {
  destroy(): void
}

interface BoundaryState {
  error: Error | null
}

/**
 * Last line of defence: a render crash in any page used to unmount the whole
 * React tree and leave a blank white panel. Show the error and a reload button
 * instead so the failure is visible and recoverable.
 */
class CortexErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[dsh-cortex] Cortex renderer crashed', error)
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          height: '100%',
          padding: 24,
          fontFamily: 'Inter, "Microsoft YaHei UI", sans-serif',
          fontSize: 13,
          color: '#334155',
          background: '#f8fafc',
        }}
      >
        <strong style={{ fontSize: 15 }}>Cortex 面板渲染失败</strong>
        <pre
          style={{
            maxWidth: '90%',
            maxHeight: '40vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            fontSize: 11.5,
            padding: 10,
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            background: '#ffffff',
            color: '#b91c1c',
          }}
        >
          {String(this.state.error.message || this.state.error)}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: '6px 14px',
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            background: '#ffffff',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          重新加载页面
        </button>
      </div>
    )
  }
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
  root.render(
    <CortexErrorBoundary>
      <App />
    </CortexErrorBoundary>,
  )

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
