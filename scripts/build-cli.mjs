#!/usr/bin/env node
/**
 * Build the `ctx` CLI bundle: `out/cli/ctx.cjs` (+ a development `ctx.cmd`
 * wrapper that runs it with the developer's `node`).
 *
 * The installed build ships this bundle as `<install>/bin/ctx.cjs` next to a
 * private Node runtime (`node.exe` on Windows, `node` on macOS) and the shipped
 * wrappers created by `scripts/build-runtime.mjs`. The bundle itself needs no
 * Electron and no dev dependencies: `better-sqlite3` stays external and resolves
 * from the adjacent `node_modules` of the installed runtime.
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = join(projectRoot, 'src', 'cli', 'bin.ts')
const outfile = join(projectRoot, 'out', 'cli', 'ctx.cjs')

mkdirSync(dirname(outfile), { recursive: true })

// Drop bundles from the pre-rename build so an incremental `out/` never ships
// a stale `phub.cjs` next to the new CLI.
for (const stale of ['phub.cjs', 'phub.cjs.map', 'phub.cmd']) {
  rmSync(join(projectRoot, 'out', 'cli', stale), { force: true })
}

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

const wrapper = join(projectRoot, 'out', 'cli', 'ctx.cmd')
writeFileSync(
  wrapper,
  ['@echo off', 'rem Cortex CLI (development build)', 'node "%~dp0ctx.cjs" %*', ''].join('\r\n'),
  'utf8'
)

console.log(`[build-cli] wrote ${outfile}`)
console.log(`[build-cli] wrote ${wrapper}`)
