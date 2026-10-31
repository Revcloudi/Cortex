import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { CAC } from 'cac'
import { readSchemaVersion } from '../../core/db/DatabaseService'
import { ensureDbDirectory, hardenDatabasePermissions, resolveDbPath } from '../../core/paths'
import { CORTEX_VERSION } from '../../core/version'
import { DATABASE_SCHEMA_VERSION } from '../../shared/types'
import { WEB_DEFAULT_HOST, WEB_DEFAULT_PORT, isLoopbackHost } from '../../shared/web'
import type { WebServerHandle, WebServerOptions } from '../../server/types'
import { createCliContext, type CliContext } from '../context'
import { CliError } from '../errors'
import { resolveCliRuntime, type CliRuntime } from '../runtime'
import { launchDetached } from './open'

/**
 * `ctx web` — start the local/intranet Cortex Web UI.
 *
 * The HTTP server lives in a separately built bundle (`out/server/web.cjs` in a
 * source checkout, `<install>/bin/web-server.cjs` for installers) so the `ctx`
 * CLI bundle stays small and the server can be launched in a plain Node process
 * that shares the same SQLite file as the desktop app, the stdio MCP server and
 * the other CLI commands.
 *
 * Defaults are deliberately conservative: bind 127.0.0.1:8787, print a one-time
 * token URL, and refuse any non-loopback bind unless `--allow-intranet` is
 * passed (the operator is then responsible for firewall/private-CIDR rules).
 */

const SERVER_BUNDLE_NAME = 'web-server.cjs'
const WEB_ASSETS_DIR_NAME = 'web'
const DEFAULT_PORT = WEB_DEFAULT_PORT
const DEFAULT_HOST = WEB_DEFAULT_HOST

interface WebServerBundle {
  startWebServer(options: WebServerOptions): Promise<WebServerHandle>
}

export interface WebPaths {
  serverEntry: string
  webRoot: string
}

/** Locate the server bundle + built SPA for the current checkout/install layout. */
export function resolveWebPaths(runtime: CliRuntime): WebPaths {
  if (runtime.mode === 'installed') {
    const binDir = dirname(runtime.cliEntry)
    return {
      serverEntry: join(binDir, SERVER_BUNDLE_NAME),
      webRoot: join(binDir, WEB_ASSETS_DIR_NAME)
    }
  }
  return {
    serverEntry: join(runtime.root, 'out', 'server', 'web.cjs'),
    webRoot: join(runtime.root, 'out', 'web')
  }
}

/** Load the separately bundled HTTP server (CommonJS) on demand. */
export function loadWebServerBundle(serverEntry: string): WebServerBundle {
  if (!existsSync(serverEntry)) {
    throw new CliError(
      [
        `未找到 Web 服务端构建产物：${serverEntry}`,
        '请先在仓库根目录运行：npm run build:server',
        '（安装版缺少该文件时请重新安装或运行 npm run build:runtime 重新打包。）'
      ].join('\n'),
      1
    )
  }
  const requireFromBundle = createRequire(__filename)
  const loaded = requireFromBundle(serverEntry) as Partial<WebServerBundle>
  if (typeof loaded.startWebServer !== 'function') {
    throw new CliError(`Web 服务端入口无效（缺少 startWebServer 导出）：${serverEntry}`, 1)
  }
  return { startWebServer: loaded.startWebServer }
}

function parsePort(raw: string | number | undefined): number {
  if (raw === undefined) return DEFAULT_PORT
  const value = typeof raw === 'number' ? raw : Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new CliError(`无效的端口：${String(raw)}（应为 1-65535 的整数）`, 1)
  }
  return value
}

/** Refuse an unsafe bind before any file/service is touched. */
function resolveHost(raw: string | undefined, allowIntranet: boolean | undefined): string {
  const host = (raw ?? DEFAULT_HOST).trim() || DEFAULT_HOST
  if (isLoopbackHost(host)) return host
  if (allowIntranet !== true) {
    throw new CliError(
      [
        `拒绝绑定非回环地址 ${host}：Web 端默认只允许本机访问。`,
        '如确需在受信任的内网中访问，请同时传入 --allow-intranet，',
        '并用防火墙/安全组仅放行私网 CIDR；绝不要把端口映射或反向代理到公网。'
      ].join(''),
      1
    )
  }
  return host
}

/** Schema guard mirrors `openDatabase` in src/cli/context.ts. */
function assertDatabaseSchema(dbPath: string): void {
  const version = readSchemaVersion(dbPath)
  if (version === null) return // missing file: the server creates a fresh empty library
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new CliError(
      `数据库 schema 版本（v${version}）高于当前 ctx 支持的版本（v${DATABASE_SCHEMA_VERSION}）：请更新 Cortex 后再试。`,
      1
    )
  }
  if (version < DATABASE_SCHEMA_VERSION) {
    throw new CliError(
      `数据库 schema 版本过旧（v${version} < v${DATABASE_SCHEMA_VERSION}）：请先启动桌面端完成迁移，或运行 ctx doctor 查看详情。`,
      1
    )
  }
}

/** Open the printed login URL in the operator's default browser (best effort). */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') launchDetached('cmd.exe', ['/c', 'start', '', url])
    else if (process.platform === 'darwin') launchDetached('open', [url])
    else launchDetached('xdg-open', [url])
  } catch {
    // A missing browser/desktop session is not an error: the URL is printed.
  }
}

function printBanner(
  context: CliContext,
  handle: WebServerHandle,
  dbPath: string,
  allowIntranet: boolean
): void {
  const lines: string[] = [
    `Cortex Web v${CORTEX_VERSION} 已启动`,
    '',
    `  监听地址: ${handle.accessUrls.join('  ')}`,
    ...handle.tokenUrls.map((url) => `  完整访问链接: ${url}`),
    '  在浏览器打开上面的完整访问链接即可进入 Web 端；刷新页面保持登录，重启服务后旧链接失效。',
    `  数据库  : ${dbPath}${handle.readOnly ? '（只读：无写权限，写入请求会返回 403）' : ''}`,
    '',
    '安全提示:',
    '  - 完整访问链接包含一次性 token，只会打印在本机终端，请勿截图、分享或粘贴到聊天工具。',
    '  - 按 Ctrl+C 停止服务；服务停止后旧链接立即失效，重启后请使用新链接。',
    '  - 默认只监听回环地址；公网服务器必须用防火墙/安全组仅放行私网 CIDR，',
    '    禁止端口映射或反向代理到公网，禁止把数据库/token/日志放到公开目录。'
  ]
  if (allowIntranet) {
    lines.push(
      '',
      '  [安全警告] 已允许非回环地址访问：仅限受信任内网使用，',
      '  请确认防火墙/安全组没有对公网开放该端口。'
    )
  }
  for (const line of lines) context.stdout(line)
}

export interface RunWebDeps {
  runtime?: CliRuntime
  /** Injected in verification scripts; omitted in normal runs. */
  loadServer?: (serverEntry: string) => WebServerBundle
  openBrowser?: (url: string) => void
}

export async function runWeb(
  options: {
    port?: string | number
    host?: string
    db?: string
    allowIntranet?: boolean
    open?: boolean
  },
  context: CliContext,
  deps: RunWebDeps = {}
): Promise<void> {
  const allowIntranet = options.allowIntranet === true
  const port = parsePort(options.port)
  const host = resolveHost(options.host, allowIntranet)
  const dbPath =
    options.db !== undefined && options.db.trim().length > 0
      ? resolve(context.cwd, options.db.trim())
      : resolveDbPath({ env: context.env, homeDir: context.homeDir })

  const runtime = deps.runtime ?? resolveCliRuntime({ env: context.env })
  const paths = resolveWebPaths(runtime)

  if (!existsSync(join(paths.webRoot, 'index.html'))) {
    throw new CliError(
      [
        `未找到 Web 前端构建产物：${join(paths.webRoot, 'index.html')}`,
        '请先在仓库根目录运行：npm run build:web && npm run build:server',
        '（安装版缺少该目录时请重新安装或运行 npm run build:runtime 重新打包。）'
      ].join('\n'),
      1
    )
  }

  assertDatabaseSchema(dbPath)
  ensureDbDirectory(dbPath)
  hardenDatabasePermissions(dbPath)

  const bundle = (deps.loadServer ?? loadWebServerBundle)(paths.serverEntry)
  const allowedHosts = (context.env['CTX_WEB_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const handle = await bundle.startWebServer({
    host,
    port,
    dbPath,
    webRoot: paths.webRoot,
    allowIntranet,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    log: (message: string) => {
      if (context.json) context.stderr(message)
      else context.stdout(message)
    }
  })

  const shutdown = async (code: number): Promise<void> => {
    try {
      await handle.close()
    } finally {
      process.exit(code)
    }
  }
  process.once('SIGINT', () => void shutdown(0))
  process.once('SIGTERM', () => void shutdown(0))

  if (context.json) {
    context.stdout(
      JSON.stringify(
        {
          host: handle.host,
          port: handle.port,
          origin: handle.origin,
          tokenUrls: handle.tokenUrls,
          accessUrls: handle.accessUrls,
          dbPath: handle.dbPath,
          readOnly: handle.readOnly,
          loopbackOnly: handle.config.loopbackOnly,
          intranetAllowed: handle.config.intranetAllowed
        },
        null,
        2
      )
    )
  } else {
    printBanner(context, handle, dbPath, allowIntranet)
  }

  if (options.open !== false && isLoopbackHost(host)) {
    ;(deps.openBrowser ?? openBrowser)(handle.tokenUrl)
  }
}

export function registerWebCommand(cli: CAC): void {
  cli
    .command('web', '启动本机/内网 Cortex Web UI（默认 127.0.0.1:8787）')
    .option('--port <port>', `监听端口（默认 ${DEFAULT_PORT}）`)
    .option('--host <host>', `监听地址（默认 ${DEFAULT_HOST}；非回环地址必须同时传 --allow-intranet）`)
    .option('--db <path>', '指定 SQLite 数据库路径（默认 ~/.cortex/data.db 或 CTX_DB_PATH）')
    .option('--allow-intranet', '允许绑定非回环地址（仅限受信任内网）')
    .option('--no-open', '不自动打开浏览器（默认在回环地址启动时自动打开）')
    .action(async (options: RunWebOptions) => {
      await runWeb(options, createCliContext())
    })
}

interface RunWebOptions {
  port?: string
  host?: string
  db?: string
  allowIntranet?: boolean
  open?: boolean
}
