#!/usr/bin/env node
/**
 * Build the `ctx web` HTTP server bundle: `out/server/web.cjs`.
 *
 * The installed desktop build ships this bundle as `<install>/bin/web-server.cjs`
 * (next to `ctx.cjs` / `mcp-stdio.cjs`) and the SPA as `<install>/bin/web/`; the
 * `ctx` CLI resolves both relative to its own directory, so the same layout works
 * in the repository (`out/`) and in a packaged install (`runtime/`).
 *
 * Like the CLI and stdio MCP bundles it is self-contained CommonJS except for the
 * one native module (`better-sqlite3`, Node-API based), which resolves from the
 * adjacent `node_modules` of the bundled runtime. `fsevents` stays external too:
 * it is an optional macOS-only watcher dependency that esbuild cannot resolve on
 * Windows/Linux.
 *
 * Usage (from the repo root):
 *   node scripts/build-web-server.mjs
 *   npm run build:server
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = join(projectRoot, 'src', 'server', 'index.ts')
const outfile = join(projectRoot, 'out', 'server', 'web.cjs')

mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['better-sqlite3', 'fsevents'],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' }
})

console.log(`[build-server] wrote ${outfile}`)
