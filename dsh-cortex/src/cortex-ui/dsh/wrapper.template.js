/**
 * dsh-cortex client bundle — Cortex original UI port for DeepSeek Harness.
 *
 * GENERATED FILE: built by scripts/build-cortex-ui.mjs from
 * src/cortex-ui/**. Do not edit; run `node scripts/build-cortex-ui.mjs`.
 *
 * The Cortex renderer (React + Tailwind) is mounted into a Shadow DOM so its
 * stylesheet cannot leak into the DSH shell. DSH provides React 18.3.1 through
 * the platform module table; the bundled UI shares that instance.
 */
window.__ModuleLoader__.load({
  id: __CORTEX_PACKAGE_NAME__,
  factory: (require) => {
    'use strict'
    const React = require('react')
    globalThis.__DSH_CORTEX_REACT__ = React

    const UI_CSS = __CORTEX_UI_STYLES__
    const FONT_FACES_CSS = __CORTEX_FONT_FACES__
    const LOGO_DATA_URL = __CORTEX_LOGO_DATA_URL__
    const PROBE_ENABLED = __CORTEX_UI_PROBE_FLAG__
    globalThis.__DSH_CORTEX_CSS__ = UI_CSS

    /*__CORTEX_UI_PROBE__*/

    /*
     * Chromium ignores @font-face rules that live inside a Shadow DOM
     * stylesheet, so the inlined Inter / JetBrains Mono faces are injected into
     * document.head once (fonts are document-level and then also apply inside
     * the shadow tree). The element is removed when the plugin unloads.
     */
    let fontStyleElement = null
    function installFontFaces() {
      if (fontStyleElement || !FONT_FACES_CSS) return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-cortex-fonts', '')
      style.textContent = FONT_FACES_CSS
      document.head.appendChild(style)
      fontStyleElement = style
    }
    function uninstallFontFaces() {
      if (!fontStyleElement) return
      try {
        fontStyleElement.remove()
      } catch (error) {
        /* ignore */
      }
      fontStyleElement = null
    }

    /* ---- vendored Cortex renderer (esbuild IIFE, exposes __DSH_CORTEX_UI__) ---- */
    __CORTEX_UI_BUNDLE__
    /* -------------------------------------------------------------------------- */

    const ui = globalThis.__DSH_CORTEX_UI__
    if (!ui || typeof ui.mount !== 'function') {
      throw new Error('[dsh-cortex] Cortex UI bundle did not initialize')
    }

    /** Original Cortex product mark (white glyph on the dark rounded square). */
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      const inner = Math.max(8, Math.round(size * 0.56))
      return React.createElement(
        'span',
        {
          'aria-hidden': true,
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            borderRadius: Math.round(size * 0.26),
            background: 'hsl(224 18% 10%)',
            flex: 'none',
          },
        },
        React.createElement('img', {
          src: LOGO_DATA_URL,
          width: inner,
          height: inner,
          alt: '',
          draggable: false,
          style: { display: 'block', objectFit: 'contain' },
        }),
      )
    }

    /** Mounts the unmodified Cortex App inside this DSH panel. */
    function CortexPanel() {
      const hostRef = React.useRef(null)
      React.useEffect(() => {
        const host = hostRef.current
        if (!host || typeof host.attachShadow !== 'function') return undefined
        let handle = null
        try {
          handle = ui.mount(host, UI_CSS)
        } catch (error) {
          console.error('[dsh-cortex] Cortex UI mount failed', error)
        }
        return () => {
          if (!handle) return
          try {
            handle.destroy()
          } catch (error) {
            console.error('[dsh-cortex] Cortex UI unmount failed', error)
          }
        }
      }, [])
      return React.createElement('div', {
        ref: hostRef,
        style: { height: '100%', width: '100%', minHeight: 0, overflow: 'hidden' },
      })
    }

    function apply(ctx) {
      try {
        ctx.effect(() => {
          installFontFaces()
          return () => uninstallFontFaces()
        }, 'dsh-cortex: document font faces')
      } catch (error) {
        console.error('[dsh-cortex] font-face install failed', error)
      }
      try {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'cortex', order: 5, label: () => 'Cortex' },
            PanelIcon,
          ),
        )
      } catch (error) {
        console.error('[dsh-cortex] sidebar.panellist registration failed', error)
      }
      try {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'cortex' }, CortexPanel))
      } catch (error) {
        console.error('[dsh-cortex] main panel registration failed', error)
      }
      if (PROBE_ENABLED) {
        try {
          window.setTimeout(runAcceptanceProbe, 1500)
        } catch (error) {
          /* probe optional */
        }
      }
    }

    return { name: 'dsh-cortex', inject: ['slots'], apply }
  },
})
