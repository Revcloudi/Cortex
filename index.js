/**
 * Host half of the dsh-cortex bundle.
 *
 * Exposes the Cortex workbench under the internal `/cortex-api` prefix route.
 * Data is read directly from the local Cortex SQLite database (schema v5) with
 * `node:sqlite`; there is no dependency on the Cortex desktop/CLI/Web process,
 * on MCP, or on any Cortex source code.
 */
import { createCortexHost } from './src/host/app.js'
import { registerCortexTools } from './src/host/cortex/tools.js'

export const name = 'dsh-cortex'

/** The browser HTTP carrier is a hard dependency for the internal API route. */
export const inject = ['webServer', 'tools']

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

  // Agent tools: conversations can read/update the Cortex database without MCP.
  ctx.inject(['tools'], (child) => {
    child.effect(() => {
      return registerCortexTools(child.tools, host.dataAccess)
    }, 'dsh-cortex: agent tools (non-MCP Cortex access)')
  })

  // Tell the model the plugin exists and when to call its tools, replacing the
  // old MCP-skill injection. Kept short so it costs little prompt budget.
  ctx.inject(['systemPrompt'], (child) => {
    child.effect(
      () =>
        child.systemPrompt.section({
          name: 'dsh-cortex.tools',
          order: 500,
          text: [
            '## Cortex (dsh-cortex plugin, no MCP needed)',
            'The local Cortex database (schema v5) is available through native tools. The old `mcp__cortex__*` servers/skills are not required; prefer the `cortex_*` tools whenever the user mentions Cortex, 漏洞库/漏洞, 资产, 快照, 内网作战 or 记忆星云.',
            '- Cortex findings: `cortex_list_vulns` / `cortex_get_vuln`; save with `cortex_save_vuln` (dedupe by host first).',
            '- Status / retest: `cortex_update_vuln_status`, `cortex_append_retest` (append-only, never overwrite original evidence).',
            '- Assets: `cortex_list_assets`, `cortex_get_asset`, `cortex_sync_asset_info` (fingerprints, interfaces, leaks, test parameters).',
            '- Snapshots / internal / nebula: `cortex_list_snapshots`, `cortex_get_snapshot`, `cortex_internal_overview`, `cortex_graph_summary`.',
            'Examples that should call the tools: “列出 Cortex 里的高危漏洞”, “把刚才确认的漏洞写入 Cortex”, “把 127.0.0.1:8080 的接口同步到资产库”, “把 VULN-… 标记为已确认并追加复测结论”.',
            'If a tools call fails, report the failure; never claim a record was stored without a successful result.',
          ].join('\n'),
        }),
      'dsh-cortex: usage prompt',
    )
  })

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
