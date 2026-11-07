/**
 * Agent tools for the local mini-program (wxapkg) workbench.
 *
 * Seven `cortex_*_miniapp*` tools let a DSH conversation drive the same local
 * pipeline as the UI: scan → list → unpack → overview → search/read → import
 * assets. They never return binary content, never execute unpacked code and
 * never send package data anywhere.
 */

import { badRequest } from '../http.js'
import {
  analyzeSourceRecord,
  fileForSource,
  importAssetsForSource,
  listMiniapps,
  miniappStore,
  requireSource,
  scan,
  searchSource,
  unpackSourceRecord,
} from './service.js'

const LOG = '[cortex]'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
}

const renderText = (_args, value) => [
  { type: 'text', text: String(value && value.text !== undefined ? value.text : value) },
]

/** Same definition style as the original Cortex tools (`cortex/tools.js`). */
function defineTool(name, description, properties, required, execute) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    execute: async (args) => {
      const result = await execute(args && typeof args === 'object' ? args : {})
      return { text: result.text }
    },
    presentCall: (args) => ({ card: 'generic', title: name, kind: 'other', rawInput: args }),
  }
}

function text(value) {
  return value === null || value === undefined ? '' : String(value)
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function failure(name, error) {
  const message = error instanceof Error ? error.message : String(error)
  return { text: `${LOG} ${name} failed: ${message}` }
}

function requireAppid(args) {
  const appid = text(args.appid).trim()
  if (appid.length === 0) throw badRequest('appid is required')
  return appid
}

/** @param {{holder:any, config:any, store?:any}} dataAccess */
export function createMiniappToolDefinitions({ holder } = {}) {
  const getStore = () => miniappStore()

  const scanTool = defineTool(
    'cortex_scan_miniapps',
    'Scan this machine for WeChat mini-program packages (wxapkg): WeChat 4.x xwechat cache, classic WeChat Files, devtools cache and saved custom roots. Read-only, local-only. Returns package/app counts and the detected apps. Run this first when the user asks about mini-program reversing; only authorized targets.',
    {
      force: { type: 'boolean', description: 'Rescan even when a scan already ran (scan is always read-only and safe)' },
    },
    [],
    async (args) => {
      try {
        const result = await scan(getStore())
        const lines = [
          `${LOG} miniapp scan complete: sources=${result.totalSources} apps=${result.appCount} packages=${result.totalPackages} added=${result.added} updated=${result.updated} unchanged=${result.unchanged}`,
        ]
        if (result.errors && result.errors.length > 0) {
          lines.push(`scan warnings: ${result.errors.length} skipped path(s) (permission/locked/limit)`)
        }
        for (const root of Array.isArray(result.roots) ? result.roots : []) {
          lines.push(
            `root: ${root.kind} ${root.path} => ${root.exists ? `${root.filesFound ?? 0} wxapkg file(s)` : 'missing'}`,
          )
        }
        lines.push(
          'note: only wxapkg packages cached on this PC are detectable; mini programs opened only on the phone have no local package. Use a custom scan root for exported packages.',
        )
        for (const item of result.miniapps.slice(0, 40)) {
          const kind = item.kind === 'plugin' ? '[插件] ' : item.kind === 'library' ? '[公共库] ' : ''
          lines.push(
            `${kind}${item.app_name ? `${item.app_name} · ` : ''}${item.appid}@${item.version || '-'} | ${item.status} | ${item.format} | ${formatBytes(item.size_bytes)} | files=${item.file_count} | versions=${item.version_count}${item.source_count > 1 ? ` | copies=${item.source_count}` : ''} | id=${item.id}`,
          )
        }
        if (result.miniapps.length > 40) lines.push(`… ${result.miniapps.length - 40} more; use cortex_list_miniapps`)
        if (result.miniapps.length === 0) {
          lines.push('No wxapkg packages found in the known roots. The user can add a custom scan root in the 小程序逆向 UI.')
        }
        return { text: lines.join('\n') }
      } catch (error) {
        return failure('scan', error)
      }
    },
  )

  const listTool = defineTool(
    'cortex_list_miniapps',
    'List detected mini-program packages from the local plugin database (appid, version, format, status, size, updated). Supports a substring search over appid/version/status. Call after cortex_scan_miniapps.',
    {
      search: { type: 'string', description: 'Substring match on appid/version/status/root kind' },
    },
    [],
    async (args) => {
      try {
        const listing = listMiniapps(getStore(), { search: text(args.search).trim() })
        const lines = [`${LOG} ${listing.total} miniapp sources · ${listing.appCount} apps`]
        for (const item of listing.miniapps) {
          const kind = item.kind === 'plugin' ? '[插件] ' : item.kind === 'library' ? '[公共库] ' : ''
          lines.push(
            `${kind}${item.app_name ? `${item.app_name} · ` : ''}${item.appid}@${item.version || '-'} | ${item.status} | ${item.format} | ${formatBytes(item.size_bytes)} | files=${item.file_count} | versions=${item.version_count}${item.source_count > 1 ? ` | copies=${item.source_count}` : ''} | analysis=${item.has_analysis ? 'yes' : 'no'} | id=${item.id}`,
          )
        }
        if (listing.total === 0) lines.push('No sources yet — run cortex_scan_miniapps first.')
        return { text: lines.join('\n') }
      } catch (error) {
        return failure('list', error)
      }
    },
  )

  const unpackTool = defineTool(
    'cortex_unpack_miniapp',
    'Decrypt (PC WeChat V1MMWX) and unpack one wxapkg source into the local workspace ~/.cortex/miniapps/<appid>/<version>/unpacked. Read-only on the WeChat cache; never executes unpacked code. Reports the real status: unpacked | unsupported (client format not supported) | failed. Omit version for the newest version.',
    {
      appid: { type: 'string', minLength: 1, maxLength: 64 },
      version: { type: 'string', maxLength: 64, description: 'Omit for the newest detected version' },
      force: { type: 'boolean', description: 'Re-unpack even when an unpacked workspace already exists' },
    },
    ['appid'],
    async (args) => {
      try {
        const source = requireSource(getStore(), requireAppid(args), text(args.version).trim())
        if (!source) {
          return { text: `${LOG} unpack failed: miniapp ${args.appid}${args.version ? `@${args.version}` : ''} not found — run cortex_scan_miniapps first` }
        }
        const result = await unpackSourceRecord({ store: getStore(), source, force: args.force === true })
        if (!result.ok) {
          return {
            text: [
              `${LOG} unpack ${source.appid}@${source.version || '-'} => ${result.status}`,
              `reason: ${result.error || 'unknown'}`,
              'The source is marked unsupported/failed in the local database; other packages are unaffected.',
            ].join('\n'),
          }
        }
        const manifest = result.manifest || {}
        const totals = (manifest && manifest.totals) || result.totals || {}
        return {
          text: [
            `${LOG} unpacked ${source.appid}@${source.version || '-'} (${result.cached ? 'cached' : 'fresh'})`,
            `workspace: ${result.unpackedPath}`,
            `packages: ${totals.packages ?? '-'} · files: ${totals.files ?? '-'} · bytes: ${formatBytes(totals.bytes)} · conflicts: ${totals.conflicts ?? 0} · skipped: ${totals.skipped ?? 0}`,
            `next: cortex_get_miniapp_overview {appid:"${source.appid}"${source.version ? `, version:"${source.version}"` : ''}}`,
          ].join('\n'),
        }
      } catch (error) {
        return failure('unpack', error)
      }
    },
  )

  const overviewTool = defineTool(
    'cortex_get_miniapp_overview',
    'Summarise an unpacked mini-program: pages, subpackages, business domains, endpoint candidates, hard-coded secret counts (masked) and candidate test parameters. Capped at ~8000 characters. Requires unpack first.',
    {
      appid: { type: 'string', minLength: 1, maxLength: 64 },
      version: { type: 'string', maxLength: 64, description: 'Omit for the newest detected version' },
    },
    ['appid'],
    async (args) => {
      try {
        const source = requireSource(getStore(), requireAppid(args), text(args.version).trim())
        if (!source) return { text: `${LOG} overview failed: miniapp not found — run cortex_scan_miniapps first` }
        if (source.status !== 'unpacked') {
          return {
            text: `${LOG} overview failed: ${source.appid}@${source.version || '-'} is not unpacked (status: ${source.status}). Call cortex_unpack_miniapp first.`,
          }
        }
        const result = analyzeSourceRecord({ store: getStore(), source })
        return { text: result.overviewText }
      } catch (error) {
        return failure('overview', error)
      }
    },
  )

  const readTool = defineTool(
    'cortex_read_miniapp_file',
    'Read a text slice of one unpacked mini-program file by workspace-relative path. Path must stay inside the unpacked workspace; binary files are rejected. Max 200 lines and 100 KiB per call; use offset to page. Never returns a whole package.',
    {
      appid: { type: 'string', minLength: 1, maxLength: 64 },
      version: { type: 'string', maxLength: 64 },
      path: { type: 'string', minLength: 1, maxLength: 4000, description: 'Relative path inside the unpacked workspace, e.g. "app-service.js"' },
      offset: { type: 'integer', minimum: 0, maximum: 10000000, description: '0-based line offset (default 0)' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max lines (default 120, hard cap 200)' },
    },
    ['appid', 'path'],
    async (args) => {
      try {
        const source = requireSource(getStore(), requireAppid(args), text(args.version).trim())
        if (!source) return { text: `${LOG} read failed: miniapp not found` }
        if (source.status !== 'unpacked') {
          return { text: `${LOG} read failed: ${source.appid}@${source.version || '-'} is not unpacked (status: ${source.status})` }
        }
        const relPath = text(args.path).trim()
        if (relPath.length === 0) return { text: `${LOG} read failed: path is required` }
        const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0
        const limit = Math.min(Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 120, 200)
        const result = fileForSource(source, relPath, { offset, limit })
        if (result.binary) {
          return { text: `${LOG} read ${relPath}: binary file (${formatBytes(result.size)}); text preview is not allowed. Use search for text files instead.` }
        }
        return {
          text: [
            `${LOG} ${source.appid}@${source.version || '-'} ${result.path} (${formatBytes(result.size)}, lines ${offset + 1}-${offset + (result.content ? result.content.split('\n').length : 0)} of ${result.totalLines}${result.truncated ? ', truncated' : ''})`,
            '```',
            result.content,
            '```',
          ].join('\n'),
        }
      } catch (error) {
        return failure('read', error)
      }
    },
  )

  const searchTool = defineTool(
    'cortex_search_miniapp',
    'Search text files of an unpacked mini-program (plain text or regular expression, optional glob filter) and return file:line matches with short context. Default 50 results, hard cap 200. Use it to locate endpoints/secrets before reading exact files.',
    {
      appid: { type: 'string', minLength: 1, maxLength: 64 },
      version: { type: 'string', maxLength: 64 },
      query: { type: 'string', minLength: 1, maxLength: 400 },
      regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression' },
      glob: { type: 'string', maxLength: 300, description: 'Simple glob against the relative path, e.g. "**/*.js"' },
      maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50' },
    },
    ['appid', 'query'],
    async (args) => {
      try {
        const source = requireSource(getStore(), requireAppid(args), text(args.version).trim())
        if (!source) return { text: `${LOG} search failed: miniapp not found` }
        if (source.status !== 'unpacked') {
          return { text: `${LOG} search failed: ${source.appid}@${source.version || '-'} is not unpacked (status: ${source.status})` }
        }
        const query = text(args.query)
        if (query.length === 0) return { text: `${LOG} search failed: query is required` }
        const result = searchSource(source, {
          query,
          regex: args.regex === true,
          glob: text(args.glob).trim(),
          maxResults: Math.min(Number.isInteger(args.maxResults) && args.maxResults > 0 ? args.maxResults : 50, 200),
        })
        const lines = [
          `${LOG} search "${query}"${args.regex ? ' (regex)' : ''}${args.glob ? ` glob=${args.glob}` : ''}: ${result.matches.length} match(es) in ${result.scanned} file(s)${result.truncated ? ' (truncated)' : ''}`,
        ]
        for (const match of result.matches) {
          lines.push(`${match.file}:${match.line}: ${match.text}`)
        }
        if (result.matches.length === 0) lines.push('No match.')
        return { text: lines.join('\n') }
      } catch (error) {
        return failure('search', error)
      }
    },
  )

  const importTool = defineTool(
    'cortex_import_miniapp_assets',
    'Import the domains, endpoint candidates, hard-coded secrets and candidate test parameters extracted from an unpacked mini-program into the existing Cortex asset library (canonical interfaces/leaked_infos/test_parameters, merge semantics). Secrets are stored locally but never printed. Returns real write counts; requires the Cortex data.db (schema v5).',
    {
      appid: { type: 'string', minLength: 1, maxLength: 64 },
      version: { type: 'string', maxLength: 64 },
      host_port: { type: 'string', maxLength: 4000, description: 'Optional explicit asset host_port; default is the most-used business domain (https preferred)' },
    },
    ['appid'],
    async (args) => {
      try {
        const source = requireSource(getStore(), requireAppid(args), text(args.version).trim())
        if (!source) return { text: `${LOG} import failed: miniapp not found` }
        if (source.status !== 'unpacked') {
          return { text: `${LOG} import failed: ${source.appid}@${source.version || '-'} is not unpacked (status: ${source.status})` }
        }
        const result = await importAssetsForSource({
          holder,
          store: getStore(),
          source,
          hostPort: text(args.host_port).trim() || undefined,
        })
        if (!result.ok) {
          return {
            text: [
              `${LOG} import failed: no usable business domain extracted from ${source.appid}`,
              ...result.warnings.map((warning) => `warning: ${warning}`),
            ].join('\n'),
          }
        }
        const asset = result.assets[0] || {}
        return {
          text: [
            `${LOG} imported ${source.appid}@${source.version || '-'} -> asset ${asset.host_port} (${asset.created ? 'created' : 'merged'}) project=${result.project}`,
            `stored: interfaces=${result.totals.interfaces} leaked_infos=${result.totals.leaks} test_parameters=${result.totals.parameters}`,
            ...result.warnings.map((warning) => `warning: ${warning}`),
          ].join('\n'),
        }
      } catch (error) {
        return failure('import', error)
      }
    },
  )

  return [scanTool, listTool, unpackTool, overviewTool, readTool, searchTool, importTool]
}
