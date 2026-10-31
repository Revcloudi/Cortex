#!/usr/bin/env node
/**
 * Build the pure stdio MCP server bundle: `out/mcp/stdio.cjs`.
 *
 * The output name is intentionally unchanged by the Cortex rebrand: installed
 * builds ship it as `<install>/bin/mcp-stdio.cjs`, and existing agent configs
 * point at that path.
 *
 * The bundle is a self-contained CommonJS file except for the one native module
 * (`better-sqlite3`, Node-API based, resolved from node_modules). Running it
 * needs no Electron and no build tooling:
 *
 *   node out/mcp/stdio.cjs
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = join(projectRoot, 'src', 'mcp', 'stdio.ts')
const outfile = join(projectRoot, 'out', 'mcp', 'stdio.cjs')

mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['better-sqlite3'],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' }
})

console.log(`[build-mcp] wrote ${outfile}`)
