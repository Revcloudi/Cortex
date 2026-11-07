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
  // The mini-program scanner also looks for WeChat's `Documents\xwechat_files`
  // data directory on other drives. This is opt-in so tests and embedders with
  // a synthetic env stay hermetic.
  if (process.env.CORTEX_MINIAPP_EXTRA_DRIVES === undefined) {
    process.env.CORTEX_MINIAPP_EXTRA_DRIVES = '1'
  }
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
            '## Cortex (dsh-cortex plugin, always active)',
            'This plugin is installed and injects this guide automatically: the cortex_* tools below are available in every conversation without a skill or an MCP server.',
            'When the user asks for ANY authorized penetration-testing work (渗透测试 / SRC / 漏洞挖掘 / 安全评估 / 资产与接口侦察 / 内网横向 / 漏洞复测), use the Cortex tools proactively instead of relying on memory:',
            '- Reuse memory first: `cortex_list_snapshots` + `cortex_get_snapshot` for task progress, `cortex_list_vulns` + `cortex_get_asset` for existing findings/assets; `cortex_list_assets` before repeating recon.',
            '- Persist confirmed findings: dedupe with `cortex_list_vulns`, then `cortex_save_vuln` (reproduction_steps in Markdown).',
            '- Persist recon context: `cortex_sync_asset_info` (mode=merge) for fingerprints, interfaces (canonical fields path/method/params/request), leaked_infos (info_type/value/source/potential_impact) and test_parameters (name/endpoint/location/values/source); aliases are normalized but the canonical shape is preferred.',
            '- Status / retest: `cortex_update_vuln_status`, `cortex_append_retest` (append-only, never overwrite original evidence).',
            '- Task progress (认知快照): at task milestones, before context compaction and at session end call `cortex_save_snapshot` (project, phase, targets, unfinished tasks, failed paths, tested interfaces, notes, next steps); pass session_id to update an existing snapshot.',
            '- Project names: reuse the existing project string exactly (list the assets or the audit first). Variants such as `Example SRC` and `Example_SRC` are merged defensively, but do not invent a new spelling.',
            '- Data completeness is mandatory: before finishing a phase call `cortex_audit_completeness`, then fill every gap — every asset must carry interfaces (path/method/params/request), leaked_infos (info_type/value/source/potential_impact) and test_parameters (name/endpoint/location/values/source); every confirmed finding must be saved with Markdown reproduction_steps; internal hosts/services/footholds/credentials/pivots go through `cortex_sync_internal_scope`.',
            '- Summaries / audit: `cortex_internal_overview`, `cortex_graph_summary`, `cortex_audit_completeness`.',
            '- Mini-program reversing (小程序逆向 / wxapkg): when the user asks about a WeChat mini program, scan first with `cortex_scan_miniapps`, then `cortex_list_miniapps` → `cortex_unpack_miniapp` → `cortex_get_miniapp_overview` → `cortex_search_miniapp` / `cortex_read_miniapp_file`; persist extracted domains/interfaces/secrets/test parameters with `cortex_import_miniapp_assets`. Only authorized packages; package content stays local; never execute unpacked JS/HTML. Report the real unpack status (unpacked / unsupported / failed) instead of assuming success.',
            'Do not skip these calls merely because no skill was loaded. If a tool call fails, report the failure; never claim a record was saved without a successful result.',
            'Examples: “列出 Cortex 里的高危漏洞”, “把刚才确认的漏洞写入 Cortex”, “把 127.0.0.1:8080 的接口同步到资产库”, “把 VULN-… 标记为已确认并追加复测结论”.',
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
