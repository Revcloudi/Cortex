#!/usr/bin/env node
/**
 * Materialize `runtime/` — the self-contained Node.js runtime that ships inside
 * the installer as `<install>/bin` on Windows (`Cortex.app/Contents/bin` on
 * macOS, via electron-builder `extraFiles`):
 *
 *   runtime/
 *     node.exe | node        <-- pinned official Node LTS (target platform/arch)
 *     mcp-stdio.cjs          <-- built stdio MCP bundle (out/mcp/stdio.cjs)
 *     ctx.cjs                <-- built CLI bundle (out/cli/ctx.cjs)
 *     ctx.cmd                <-- Windows wrapper: "%~dp0node.exe" "%~dp0ctx.cjs" %*
 *     ctx                    <-- macOS wrapper: exec node ctx.cjs "$@" (chmod +x)
 *     ctx-path.cjs           <-- installer-only Windows PATH helper
 *     skills/{zh,en}/*.skill.md
 *     node_modules/
 *       better-sqlite3/      <-- package.json + lib/ + prebuilds/<platform>-<arch>.node
 *
 * `better-sqlite3` v13 is Node-API (NAPI 10) based, so the same prebuilt `.node`
 * works in Electron and in the bundled Node runtime: no dual-ABI rebuild is
 * needed. The script verifies the native module actually loads from the bundled
 * runtime (host target only) before finishing.
 *
 * Usage:
 *   node scripts/build-runtime.mjs [--platform win32|darwin] [--arch x64|arm64]
 *                                  [--out <dir>] [--force]
 *
 * Defaults to the host platform/arch, output `runtime/`. One target per
 * invocation: CI builds each arch in its own job.
 *
 * Env: CTX_NODE_VERSION (legacy fallback: PDH_NODE_VERSION), default v24.22.2.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cacheDir = join(projectRoot, '.cache', 'node-runtime')
const SCRIPT_DIR = join(projectRoot, 'scripts')

const SUPPORTED_PLATFORMS = new Set(['win32', 'darwin'])
const SUPPORTED_ARCHS = new Set(['x64', 'arm64'])
const NODE_LTS_VERSION = 'v24.22.2'

function log(message) {
  console.log(`[build-runtime] ${message}`)
}

function fail(message) {
  console.error(`[build-runtime] 错误: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    platform: '',
    arch: '',
    out: '',
    force: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--platform':
        options.platform = argv[++index] ?? ''
        break
      case '--arch':
        options.arch = argv[++index] ?? ''
        break
      case '--out':
        options.out = argv[++index] ?? ''
        break
      case '--force':
        options.force = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        fail(`未知参数: ${arg}（可用: --platform --arch --out --force）`)
    }
  }
  return options
}

function usage() {
  console.log(`Cortex 运行时构建

用法:
  node scripts/build-runtime.mjs [--platform win32|darwin] [--arch x64|arm64]
                                 [--out <目录>] [--force]

默认:
  --platform  host (${process.platform})
  --arch      host (${process.arch})
  --out       <repo>/runtime
  Node        ${NODE_LTS_VERSION}（可用 CTX_NODE_VERSION 覆盖）
`)
}

/**
 * Refuse to delete anything that does not look like a runtime output directory:
 * an accidental `--out .` would otherwise wipe the repository.
 */
function prepareOutDir(outDir) {
  const resolvedOut = resolve(outDir)
  if (resolvedOut === dirname(resolvedOut)) fail(`拒绝使用文件系统根目录作为输出: ${resolvedOut}`)

  // Never delete the repository or one of its ancestors: `--out .` (or a
  // trailing-separator mismatch) must fail before rmSync touches anything.
  const relativeToProject = relative(resolvedOut, projectRoot)
  const outContainsProject =
    relativeToProject === '' || (!relativeToProject.startsWith('..') && !isAbsolute(relativeToProject))
  if (outContainsProject) {
    fail(`拒绝使用仓库根目录或其上级目录作为输出: ${resolvedOut}（请换 --out）`)
  }

  if (existsSync(resolvedOut) && readdirSync(resolvedOut).length > 0) {
    if (
      existsSync(join(resolvedOut, '.git')) ||
      (existsSync(join(resolvedOut, 'package.json')) && existsSync(join(resolvedOut, 'src')))
    ) {
      fail(`输出目录看起来是源码仓库: ${resolvedOut}（请换 --out）`)
    }
    const runtimeMarkers = [
      'ctx.cjs',
      'mcp-stdio.cjs',
      'node.exe',
      'node',
      'ctx.cmd',
      'ctx',
      'ctx-path.cjs',
      'skills',
      'node_modules'
    ]
    const looksLikeRuntime = runtimeMarkers.some((marker) => existsSync(join(resolvedOut, marker)))
    if (!looksLikeRuntime) {
      fail(`输出目录已存在且不像 runtime 产物: ${resolvedOut}（请换 --out 或手动清理）`)
    }
  }
  rmSync(resolvedOut, { recursive: true, force: true })
  mkdirSync(resolvedOut, { recursive: true })
}

/** Download one URL to `target` (Node 24 global fetch follows redirects). */
async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
  if (!response.ok || response.body === null) {
    throw new Error(`HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
}

async function ensureNodeArchive(archivePath, archiveName, urls, force) {
  if (existsSync(archivePath) && !force) {
    log(`复用已缓存的 Node 分发: ${archivePath}`)
    return
  }
  mkdirSync(dirname(archivePath), { recursive: true })
  let lastError = null
  for (const url of urls) {
    const partial = `${archivePath}.part`
    try {
      log(`下载 ${url}`)
      await download(url, partial)
      rmSync(archivePath, { force: true })
      renameSync(partial, archivePath)
      log(`已下载 ${archiveName} (${(statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB)`)
      return
    } catch (error) {
      lastError = error
      rmSync(partial, { force: true })
      log(`下载失败，尝试下一个镜像: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  fail(`无法下载 ${archiveName}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * Minimal tar.gz member reader: extract one regular file without creating any
 * other archive entry. Needed when a Windows host cross-builds the macOS
 * runtime — the macOS archive contains symlinks (`bin/npm`, `bin/npx`, ...)
 * that Windows cannot create, so a full extraction fails.
 */
function extractTarGzMember(archivePath, extractDir, memberPath) {
  let tarBuffer
  try {
    tarBuffer = gunzipSync(readFileSync(archivePath))
  } catch (error) {
    log(`内置 tar.gz 解析失败: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  let offset = 0
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) return false
    const readString = (start, length) => {
      const slice = header.subarray(start, start + length)
      const end = slice.indexOf(0)
      return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
    }
    const name = readString(0, 100)
    const prefix = readString(345, 155)
    const fullName = (prefix.length > 0 ? `${prefix}/${name}` : name).replace(/^\.\//, '')
    const sizeField = readString(124, 12).replace(/\0/g, '').trim()
    const size = sizeField.length > 0 ? Number.parseInt(sizeField, 8) : 0
    if (!Number.isFinite(size) || size < 0) return false
    const dataStart = offset + 512
    if (fullName === memberPath && (header[156] === 0 || header[156] === 48)) {
      const target = join(extractDir, memberPath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, tarBuffer.subarray(dataStart, dataStart + size))
      return true
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return false
}

function extractNodeArchive(archivePath, extractDir, platform, distDirName) {
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })

  // Selective extraction: only the Node executable, never the symlinked npm
  // shims that a full extraction would need to create.
  const member = platform === 'win32' ? `${distDirName}/node.exe` : `${distDirName}/bin/node`
  try {
    execFileSync('tar', ['-xf', archivePath, '-C', extractDir, member], { windowsHide: true })
    if (existsSync(join(extractDir, ...member.split('/')))) return
    log(`tar 未解出 ${member}，尝试其他方式`)
  } catch (error) {
    log(`tar 解压失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (platform === 'win32') {
    log('回退到 PowerShell Expand-Archive')
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
      ],
      { windowsHide: true }
    )
    return
  }

  if (process.platform !== 'win32') {
    log('回退到 gzip | tar 解压')
    execFileSync(
      'sh',
      ['-c', 'gzip -dc "$1" | tar -xf - -C "$2"', 'sh', archivePath, extractDir],
      { windowsHide: true }
    )
    return
  }

  log('回退到内置 tar.gz 解析器')
  if (!extractTarGzMember(archivePath, extractDir, member)) {
    fail(`解压 ${archivePath} 失败：未找到 ${member}`)
  }
}

function copyNodeBinary(sourceNode, outDir, platform) {
  const targetName = platform === 'win32' ? 'node.exe' : 'node'
  const target = join(outDir, targetName)
  copyFileSync(sourceNode, target)
  if (platform !== 'win32') chmodSync(target, 0o755)
  return target
}

function copyBetterSqlite3(outDir, platform, arch) {
  const source = join(projectRoot, 'node_modules', 'better-sqlite3')
  if (!existsSync(source)) fail('未找到 node_modules/better-sqlite3，请先 npm install')
  const target = join(outDir, 'node_modules', 'better-sqlite3')
  mkdirSync(join(target, 'prebuilds'), { recursive: true })
  copyFileSync(join(source, 'package.json'), join(target, 'package.json'))
  cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true })

  const prebuildName = `${platform === 'win32' ? 'win32' : 'darwin'}-${arch}.node`
  const prebuilt = join(source, 'prebuilds', prebuildName)
  if (!existsSync(prebuilt)) fail(`better-sqlite3 缺少 prebuilds/${prebuildName}`)
  copyFileSync(prebuilt, join(target, 'prebuilds', prebuildName))
}

function copyBundles(outDir, platform) {
  const mcpBundle = join(projectRoot, 'out', 'mcp', 'stdio.cjs')
  const cliBundle = join(projectRoot, 'out', 'cli', 'ctx.cjs')
  for (const [source, targetName, buildScript] of [
    [mcpBundle, 'mcp-stdio.cjs', 'npm run build:mcp'],
    [cliBundle, 'ctx.cjs', 'npm run build:cli']
  ]) {
    if (!existsSync(source)) fail(`缺少构建产物 ${source}，请先运行 ${buildScript}（或 npm run build）`)
    copyFileSync(source, join(outDir, targetName))
  }

  copyFileSync(join(SCRIPT_DIR, 'ctx-path.cjs'), join(outDir, 'ctx-path.cjs'))

  if (platform === 'win32') {
    writeFileSync(
      join(outDir, 'ctx.cmd'),
      ['@echo off', 'rem Cortex CLI (bundled runtime)', '"%~dp0node.exe" "%~dp0ctx.cjs" %*', ''].join(
        '\r\n'
      ),
      'utf8'
    )
  } else {
    const wrapper = join(outDir, 'ctx')
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        '# Cortex CLI (bundled runtime)',
        'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        'exec "$DIR/node" "$DIR/ctx.cjs" "$@"',
        ''
      ].join('\n'),
      'utf8'
    )
    chmodSync(wrapper, 0o755)
  }
}

function copySkills(outDir) {
  const source = join(projectRoot, 'skills')
  if (!existsSync(source)) fail(`未找到 skills/ 目录: ${source}`)
  const target = join(outDir, 'skills')
  cpSync(source, target, { recursive: true })

  const zhDir = join(target, 'zh')
  if (!existsSync(zhDir) || readdirSync(zhDir).filter((name) => name.endsWith('.skill.md')).length === 0) {
    fail(`skills/zh 缺少 .skill.md 文件: ${zhDir}`)
  }
  const enDir = join(target, 'en')
  const enCount = existsSync(enDir)
    ? readdirSync(enDir).filter((name) => name.endsWith('.skill.md')).length
    : 0
  if (enCount === 0) {
    log('警告: skills/en 尚无 .skill.md，安装器选择 English 时会回退到中文（由 skills 维护者补齐）')
  }
}

function probeEnv(extra = {}) {
  return { ...process.env, PATH: '', Path: '', ...extra }
}

function verifyRuntime(outDir, platform, arch, nodeBinary) {
  const runnableHost = platform === process.platform && arch === process.arch
  if (!runnableHost) {
    const files = readdirSync(outDir)
    for (const required of [platform === 'win32' ? 'node.exe' : 'node', 'mcp-stdio.cjs', 'ctx.cjs', 'ctx-path.cjs']) {
      if (!existsSync(join(outDir, required))) fail(`跨平台构建缺少 ${required}`)
    }
    const prebuild = join(outDir, 'node_modules', 'better-sqlite3', 'prebuilds', `${platform}-${arch}.node`)
    if (!existsSync(prebuild)) fail(`跨平台构建缺少 ${prebuild}`)
    log(
      `目标 ${platform}-${arch} 无法在 ${process.platform}-${process.arch} 主机上执行；已跳过运行自检（文件: ${files.length} 项）`
    )
    return
  }

  const version = spawnSync(nodeBinary, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    env: probeEnv()
  })
  if (version.status !== 0) fail(`内置 node 无法运行: ${version.stderr || version.error}`)
  const reported = (version.stdout || '').trim()
  if (reported !== expectedNodeVersion) {
    fail(`内置 node 版本 ${reported} 与期望 ${expectedNodeVersion} 不一致`)
  }
  log(`内置 Node 运行正常: ${reported}`)

  const sqliteProbe = spawnSync(
    nodeBinary,
    [
      '-e',
      "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.exec('select 1'); console.log('better-sqlite3 OK', process.versions.modules)"
    ],
    { cwd: outDir, encoding: 'utf8', windowsHide: true, env: probeEnv(), timeout: 60_000 }
  )
  if (sqliteProbe.status !== 0) {
    fail(`better-sqlite3 在运行时中加载失败: ${sqliteProbe.stderr || sqliteProbe.error}`)
  }
  log((sqliteProbe.stdout || '').trim())

  const cliProbe = spawnSync(nodeBinary, [join(outDir, 'ctx.cjs'), '--version'], {
    cwd: outDir,
    encoding: 'utf8',
    windowsHide: true,
    env: probeEnv(),
    timeout: 60_000
  })
  if (cliProbe.status !== 0) fail(`ctx --version 失败: ${cliProbe.stderr || cliProbe.error}`)
  const cliVersion = (cliProbe.stdout || '').trim().split('\n')[0]
  if (cliVersion.length === 0) fail('ctx --version 没有输出')
  log(`ctx 版本: ${cliVersion}`)

  const probeDb = join(cacheDir, 'runtime-probe.db')
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${probeDb}${suffix}`, { force: true })
  mkdirSync(cacheDir, { recursive: true })
  const mcpEntry = join(outDir, 'mcp-stdio.cjs')
  const mcpProbeSource = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, [${JSON.stringify(mcpEntry)}], { env: { ...process.env, CTX_DB_PATH: ${JSON.stringify(probeDb)}, PATH: '' } })`,
    "let out = ''",
    "child.stdout.on('data', (chunk) => { out += chunk })",
    "child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'runtime-probe', version: '1.0.0' } } }) + '\\n')",
    'setTimeout(() => {',
    '  child.kill()',
    '  try {',
    "    const line = out.split('\\n')[0]",
    '    const parsed = JSON.parse(line)',
    "    console.log('mcp initialize OK', parsed.result.serverInfo.name, parsed.result.serverInfo.version)",
    '    process.exit(0)',
    '  } catch (error) {',
    "    console.error('mcp probe failed:', out.slice(0, 500), error.message)",
    '    process.exit(1)',
    '  }',
    '}, 2500)'
  ].join('\n')
  const mcpProbe = spawnSync(nodeBinary, ['-e', mcpProbeSource], {
    cwd: outDir,
    encoding: 'utf8',
    windowsHide: true,
    env: probeEnv(),
    timeout: 20_000
  })
  if (mcpProbe.status !== 0) {
    fail(`stdio MCP 运行时自检失败: ${mcpProbe.stderr || mcpProbe.error}`)
  }
  log((mcpProbe.stdout || '').trim())
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${probeDb}${suffix}`, { force: true })
}

function dirSize(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size
  }
  return total
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  usage()
  process.exit(0)
}

const platform = (options.platform || process.platform).toLowerCase()
if (!SUPPORTED_PLATFORMS.has(platform)) {
  fail(`不支持的平台: ${platform}（可用: win32 | darwin）`)
}
const arch = (options.arch || process.arch).toLowerCase()
if (!SUPPORTED_ARCHS.has(arch)) {
  fail(`不支持的架构: ${arch}（可用: x64 | arm64）`)
}

const expectedNodeVersion = (() => {
  const raw = process.env.CTX_NODE_VERSION?.trim() || process.env.PDH_NODE_VERSION?.trim() || NODE_LTS_VERSION
  return raw.startsWith('v') ? raw : `v${raw}`
})()

const outDir = options.out ? resolve(process.cwd(), options.out) : join(projectRoot, 'runtime')
const distPlatform = platform === 'win32' ? 'win' : 'darwin'
const archiveExt = platform === 'win32' ? 'zip' : 'tar.gz'
const archiveName = `node-${expectedNodeVersion}-${distPlatform}-${arch}.${archiveExt}`
const distDirName = `node-${expectedNodeVersion}-${distPlatform}-${arch}`
const archivePath = join(cacheDir, archiveName)
const extractDir = join(cacheDir, `extract-${platform}-${arch}`)
const archiveUrls = [
  `https://cdn.npmmirror.com/binaries/node/${expectedNodeVersion}/${archiveName}`,
  `https://nodejs.org/dist/${expectedNodeVersion}/${archiveName}`
]

async function main() {
  log(`目标: ${platform}-${arch}，Node ${expectedNodeVersion}，输出 ${outDir}`)
  await ensureNodeArchive(archivePath, archiveName, archiveUrls, options.force)
  extractNodeArchive(archivePath, extractDir, platform, distDirName)

  const sourceNode =
    platform === 'win32'
      ? join(extractDir, distDirName, 'node.exe')
      : join(extractDir, distDirName, 'bin', 'node')
  if (!existsSync(sourceNode)) fail(`解压后未找到 Node 可执行文件: ${sourceNode}`)

  prepareOutDir(outDir)
  const nodeBinary = copyNodeBinary(sourceNode, outDir, platform)
  copyBundles(outDir, platform)
  copySkills(outDir)
  copyBetterSqlite3(outDir, platform, arch)

  verifyRuntime(outDir, platform, arch, nodeBinary)

  log(`runtime 就绪: ${readdirSync(outDir).join(', ')}`)
  log(`总大小 ${(dirSize(outDir) / 1024 / 1024).toFixed(1)} MB`)
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
})
