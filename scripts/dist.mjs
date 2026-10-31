#!/usr/bin/env node
/**
 * One-command Cortex Windows release build.
 *
 * Usage:
 *   node scripts/dist.mjs --win
 *
 * Windows (`--win`):
 *   1. `npm run build`        typecheck + Electron bundles + MCP bundle + CLI bundle
 *   2. `npm run build:web`    standalone browser SPA -> out/web (served by `ctx web`)
 *   3. `npm run build:server` `ctx web` HTTP server bundle -> out/server/web.cjs
 *   4. build-runtime          self-contained runtime/ (node.exe + ctx/mcp + web + native sqlite)
 *   5. electron-builder       NSIS installer `release/Cortex-<version>-setup.exe`
 *
 * Only Windows desktop artifacts are released; macOS/Linux are CLI-only (see
 * README) and install from source.
 *
 * Mirrors are configurable so builds work behind the GFW:
 *   ELECTRON_MIRROR, ELECTRON_BUILDER_BINARIES_MIRROR
 * (defaults to npmmirror; override with your own values when needed).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const argv = process.argv.slice(2)
const RELEASE_DIR = join(projectRoot, 'release')

function fail(message) {
  console.error(`[dist] 错误: ${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[dist] ${message}`)
}

function usage() {
  console.log(`Cortex 发布构建

用法:
  node scripts/dist.mjs --win

说明:
  --win    Windows x64 NSIS 安装包 → release/Cortex-<version>-setup.exe`)
}

if (argv.includes('--help') || argv.includes('-h')) {
  usage()
  process.exit(0)
}

if (!argv.includes('--win')) {
  usage()
  fail('请指定 --win（macOS/Linux 仅提供 CLI，从源码安装）')
}

const MIRROR_ENV = {
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??
    'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

function run(command, args, extraEnv = {}) {
  log(`${command} ${args.join(' ')}`)
  const useShell = process.platform === 'win32' && /\.cmd$/i.test(command)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: useShell
  })
  if (result.error) {
    fail(`${command} 启动失败: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} 失败 (exit ${result.status ?? 'unknown'})`)
  }
}

function localBin(name) {
  const binary = join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
  if (!existsSync(binary)) fail(`未找到 ${name}，请先 npm install`)
  return binary
}

run(npmCommand, ['run', 'build'])
// Web support ships inside the installer too: SPA (out/web) + HTTP server bundle.
// build-runtime copies them into runtime/web/ and runtime/web-server.cjs.
run(npmCommand, ['run', 'build:web'])
run(npmCommand, ['run', 'build:server'])

run(process.execPath, [
  join(projectRoot, 'scripts', 'build-runtime.mjs'),
  '--platform',
  'win32',
  '--arch',
  'x64'
])
run(localBin('electron-builder'), ['--win', 'nsis', '--x64'], MIRROR_ENV)

if (existsSync(RELEASE_DIR)) {
  const artifacts = readdirSync(RELEASE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(exe|blockmap)$/i.test(entry.name))
    .map((entry) => {
      const size = statSync(join(RELEASE_DIR, entry.name)).size
      return `  ${entry.name}  ${(size / 1024 / 1024).toFixed(1)} MB`
    })
  if (artifacts.length > 0) {
    log('产物:')
    console.log(artifacts.join('\n'))
  }
}

log(`完成，产物位于 ${RELEASE_DIR}`)
