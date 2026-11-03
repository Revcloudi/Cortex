#!/usr/bin/env node
/**
 * Run a child build command with a project-local temp directory.
 *
 * Why this exists
 * ---------------
 * On Windows, esbuild's large `transform` results (used by Vite's
 * `esbuild-transpile` chunk step) are written to `os.tmpdir()` and then deleted
 * by the esbuild service. Antivirus / search indexers can hold that file open,
 * so the delete fails with:
 *
 *   [vite:esbuild-transpile] remove C:\Users\...\Temp\esbuild-...: Access is denied.
 *
 * The build itself is fine; only the temp-file cleanup fails. Redirecting
 * `TEMP` / `TMP` / `TMPDIR` for the child process to an ignored directory inside
 * the repository makes the whole pipeline reliable without touching the user's
 * system temp settings or requiring a wrapper dependency.
 *
 * Usage (npm scripts only — never interactive):
 *   node scripts/run-with-local-temp.mjs vite build -c vite.web.config.ts
 *   node scripts/run-with-local-temp.mjs electron-vite build
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const localTemp = join(projectRoot, '.cache', 'tmp')
const [command, ...args] = process.argv.slice(2)

if (command === undefined || command.length === 0) {
  console.error('[local-temp] usage: node scripts/run-with-local-temp.mjs <command> [...args]')
  process.exit(2)
}

mkdirSync(localTemp, { recursive: true })

const result = spawnSync(command, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    TEMP: localTemp,
    TMP: localTemp,
    TMPDIR: localTemp
  },
  // Windows needs cmd.exe to resolve `vite.cmd` / `electron-vite.cmd` from
  // node_modules/.bin (which npm puts on PATH for scripts).
  shell: process.platform === 'win32'
})

if (result.error !== undefined) {
  console.error(`[local-temp] failed to start ${command}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
