import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Standalone browser build of the existing renderer.
 *
 * `electron-vite` builds `src/renderer` into `out/renderer` for the Electron
 * shell; this config reuses the exact same React entry (`src/renderer/index.html`)
 * but emits a plain SPA into `out/web` that the `ctx web` HTTP server serves
 * from disk. The only renderer-visible difference is the injected
 * `VITE_CORTEX_RUNTIME` marker, which makes `src/renderer/src/lib/api.ts` pick
 * the HTTP transport instead of `window.api` (Electron preload).
 *
 * Kept separate from `electron.vite.config.ts` on purpose: `npm run build`
 * (desktop) must stay byte-for-byte unchanged, and this build never touches
 * `out/main`, `out/preload` or `out/renderer`.
 *
 * Usage (from the repo root):
 *   npx vite build -c vite.web.config.ts
 *   npm run build:web
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  // `./assets/...` works both at `/` and under a sub-path mount; the SPA is
  // served from the server root, but relative URLs keep it portable.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  define: {
    // Compile-time runtime marker: 'web' → fetch/SSE transport, no Electron preload.
    'import.meta.env.VITE_CORTEX_RUNTIME': JSON.stringify('web')
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false
  }
})
