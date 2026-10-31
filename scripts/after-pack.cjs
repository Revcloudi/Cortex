#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const { cpSync, existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

/**
 * electron-builder afterPack hook for Cortex.
 *
 * The agent runtime is shipped with `extraFiles: runtime → bin` so it lands in
 * `<install>/bin` on Windows and `Cortex.app/Contents/bin` on macOS. Builder
 * deliberately strips nested `node_modules` from `extraFiles`, so the bundled
 * `better-sqlite3` (Node-API prebuild) would silently disappear from the
 * packaged app. This hook:
 *
 *   1. asserts the required runtime artifacts exist in `bin/`;
 *   2. restores `runtime/node_modules` into `bin/node_modules`;
 *   3. self-checks that the bundled Node can load the native addon (host
 *      target only — a cross-built runtime cannot be executed here).
 */
const ARCH_NAMES = { 1: 'x64', 3: 'arm64', 4: 'universal' }

module.exports = async function afterPack(context) {
  const projectRoot = context.packager.projectDir
  const platform = context.electronPlatformName
  const productFilename = context.packager.appInfo.productFilename
  const appOutDir = context.appOutDir

  const binDir =
    platform === 'darwin'
      ? join(appOutDir, `${productFilename}.app`, 'Contents', 'bin')
      : join(appOutDir, 'bin')

  if (!existsSync(binDir)) {
    throw new Error(
      `[afterPack] 安装目录缺少 bin/: ${binDir}\n请确认 electron-builder.yml 的 extraFiles(runtime → bin) 与 npm run build:runtime`
    )
  }

  const nodeName = platform === 'win32' ? 'node.exe' : 'node'
  const requiredArtifacts = ['mcp-stdio.cjs', 'ctx.cjs', 'ctx-path.cjs', nodeName]
  if (platform === 'win32') requiredArtifacts.push('ctx.cmd')
  else requiredArtifacts.push('ctx')
  for (const artifact of requiredArtifacts) {
    if (!existsSync(join(binDir, artifact))) {
      throw new Error(`[afterPack] 安装目录缺少 bin/${artifact}；请先运行 npm run build:runtime`)
    }
  }
  if (!existsSync(join(binDir, 'skills'))) {
    throw new Error('[afterPack] 安装目录缺少 bin/skills；请先运行 npm run build:runtime')
  }

  const source = join(projectRoot, 'runtime', 'node_modules')
  if (!existsSync(source)) {
    throw new Error('[afterPack] runtime/node_modules 缺失；请先运行 npm run build:runtime')
  }
  const target = join(binDir, 'node_modules')
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })

  const archName = ARCH_NAMES[context.arch] ?? process.arch
  const prebuild = join(binDir, 'node_modules', 'better-sqlite3', 'prebuilds', `${platform}-${archName}.node`)
  if (!existsSync(prebuild)) {
    const prebuildDir = join(binDir, 'node_modules', 'better-sqlite3', 'prebuilds')
    const available = existsSync(prebuildDir) ? readdirSync(prebuildDir).join(', ') : '（目录缺失）'
    throw new Error(
      `[afterPack] bin/node_modules/better-sqlite3 缺少 ${platform}-${archName}.node（现有: ${available}）；` +
        'runtime/ 与打包目标架构不一致，请按目标平台重新运行 build:runtime'
    )
  }
  console.log(`[afterPack] 已恢复 bin/node_modules（better-sqlite3 ${platform}-${archName} Node-API prebuild）`)

  if (platform !== process.platform || archName !== process.arch) {
    console.log(
      `[afterPack] 目标 ${platform}-${archName} 与主机 ${process.platform}-${process.arch} 不同，跳过运行自检`
    )
    return
  }

  const nodeBinary = join(binDir, nodeName)
  const probe = spawnSync(
    nodeBinary,
    [
      '-e',
      "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.exec('select 1'); console.log('better-sqlite3 OK', process.versions.modules)"
    ],
    {
      cwd: binDir,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PATH: '', Path: '' },
      timeout: 60_000
    }
  )
  if (probe.status !== 0) {
    throw new Error(
      `[afterPack] 打包后的内置 Node 无法加载 better-sqlite3: ${probe.stderr || probe.error}`
    )
  }
  console.log(`[afterPack] 运行时自检: ${(probe.stdout || '').trim()}`)
}
