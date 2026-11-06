/**
 * Host half of the dsh-cortex bundle.
 *
 * Exposes the Cortex workbench under the internal `/cortex-api` prefix route.
 * Data is read directly from the local Cortex SQLite database (schema v5) with
 * `node:sqlite`; there is no dependency on the Cortex desktop/CLI/Web process,
 * on MCP, or on any Cortex source code.
 */
import { createCortexHost } from './src/host/app.js'

export const name = 'dsh-cortex'

/** The browser HTTP carrier is a hard dependency for the internal API route. */
export const inject = ['webServer']

export function apply(ctx, config) {
  let host
  try {
    host = createCortexHost({ config })
  } catch (err) {
    // Never let configuration/DB bootstrap failure take down the Host.
    // No sensitive data is logged here.
    console.warn(`[dsh-cortex] host bootstrap failed: ${String(err && err.message ? err.message : err).slice(0, 200)}`)
    return
  }

  ctx.inject(['webServer'], (web) => {
    ctx.effect(() => {
      const disposeRoute = web.webServer.register({
        kind: 'prefix',
        path: '/cortex-api',
        handler: (req, res) => host.handler(req, res),
      })
      return () => {
        try {
          disposeRoute()
        } catch {
          /* already disposed */
        }
        try {
          void host.dispose()
        } catch {
          /* ignore */
        }
      }
    }, 'dsh-cortex: /cortex-api route')
  })
}
