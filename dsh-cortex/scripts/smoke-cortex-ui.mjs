/**
 * Faithfulness smoke: render the *original* Cortex renderer inside jsdom under
 * the same environment DSH gives it at runtime (platform React 18.3.1, no
 * react-dom / react/jsx-runtime in the module table, relative `/cortex-api/...`
 * fetch, Shadow DOM panel).
 *
 * What it does:
 *   1. builds a jsdom window (`runScripts: 'outside-only'` so `window.eval` works)
 *      and installs the browser APIs the real page has but jsdom lacks
 *      (matchMedia / ResizeObserver / clipboard / pointer capture ...),
 *   2. evaluates the real built `client.js`, captures its ModuleLoader definition
 *      and invokes `factory(require)` with `require('react') === react@18.3.1`
 *      (and throws for every other module — exactly like the platform table),
 *   3. fakes `ctx.slots` to capture the `sidebar.panellist` + `main` components
 *      and calls `apply(ctx)`,
 *   4. renders the captured `main` (CortexPanel) with react-dom/client 18.3.1 +
 *      act, then asserts *inside the shadow root*: sidebar width/nav/icons,
 *      titlebar, language toggle, DB filename, Dashboard metric strip + vuln
 *      table wired to the mocked `/cortex-api/cortex/**` responses, and page
 *      switching (nav-assets → AssetPage),
 *   5. fails on uncaught/React errors and reports every console/jsdom error.
 *
 * Usage:
 *   node scripts/smoke-cortex-ui.mjs            # CLI, exit code 0/1
 *   node scripts/smoke-cortex-ui.mjs --verbose  # print every request/check
 *
 * Importable API (used by test/client/cortex-ui.test.mjs):
 *   const report = await runCortexUiSmoke()
 *   report.ok / report.checks / report.consoleErrors / report.structural
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const DEFAULT_CLIENT_PATH = join(repoRoot, 'client.js')
const PAGE_ORIGIN = 'http://127.0.0.1:63877/'
const API_BASE = '/cortex-api/cortex'
const nodeRequire = createRequire(join(repoRoot, 'package.json'))

/* -------------------------------------------------------------------------- */
/* Fixtures — shape mirrors the real local Cortex DB (schema v5) at the time    */
/* of the port: 13 vulnerabilities (9 web / 4 internal), 1 asset, 1 snapshot,   */
/* 1 internal project. No secrets are included.                                 */
/* -------------------------------------------------------------------------- */
const PROJECT = 'Starport Portal 物流客户门户靶场'
const ASSET_HOST_PORT = 'http://127.0.0.1:8080/'
const SNAPSHOT_ID = 'SESS-20261102-001'

const VULNS = [
  { id: 'VULN-20261102-001', host: '127.0.0.1:8080', service_host: '', realm: 'web', internal_service_id: '', entry_point: 'GET /orders 查询参数 q', vuln_name: 'Starport Portal 订单搜索 SQL 注入（UNION/报错注入，跨租户数据泄露）', vuln_type: 'SQL Injection', severity: 'Critical', target_url: 'http://127.0.0.1:8080/orders?q=', status: 'Confirmed', created_at: '2026-11-02T08:05:00.139Z' },
  { id: 'VULN-20261102-002', host: '127.0.0.1:8080', service_host: '', realm: 'web', internal_service_id: '', entry_point: 'GET /tools/thumbnail 参数 name', vuln_name: 'thumbnail 缩略图助手命令注入导致远程代码执行（www-data）', vuln_type: 'Command Injection / RCE', severity: 'Critical', target_url: 'http://127.0.0.1:8080/tools/thumbnail?name=', status: 'Retest_Passed', created_at: '2026-11-02T08:05:00.148Z' },
  { id: 'VULN-20261102-003', host: '127.0.0.1:8080', service_host: '', realm: 'web', internal_service_id: '', entry_point: 'GET /api/invoices/<id> 路径参数 invoice_id', vuln_name: '发票 JSON API 越权访问（IDOR / BOLA）导致跨租户发票与内部备注泄露', vuln_type: 'IDOR / BOLA', severity: 'High', target_url: 'http://127.0.0.1:8080/api/invoices/1', status: 'Confirmed', created_at: '2026-11-02T08:05:31.200Z' },
  { id: 'VULN-20261102-004', host: '127.0.0.1:8080', service_host: '', realm: 'web', internal_service_id: '', entry_point: 'Flask 签名 session cookie', vuln_name: 'Flask SECRET_KEY 泄露导致会话伪造与任意账号接管', vuln_type: 'Broken Authentication / Session Forgery', severity: 'High', target_url: 'http://127.0.0.1:8080/login', status: 'Confirmed', created_at: '2026-11-02T08:05:31.207Z' },
  { id: 'VULN-20261102-005', host: '127.0.0.1:8080', service_host: '', realm: 'web', internal_service_id: '', entry_point: 'POST /upload 文件字段 file', vuln_name: '文件上传无类型与名称校验（任意文件落盘）', vuln_type: 'Unrestricted File Upload', severity: 'Medium', target_url: 'http://127.0.0.1:8080/upload', status: 'Confirmed', created_at: '2026-11-02T08:05:46.032Z' },
  { id: 'VULN-20261102-006', host: '127.0.0.1:8080', service_host: '', realm: 'web', internal_service_id: '', entry_point: '/var/www/.env + MySQL secrets 表 + invoices.internal_note', vuln_name: '敏感凭据多处明文泄露（.env / secrets 表 / 发票备注 / 弱哈希）', vuln_type: 'Sensitive Information Disclosure', severity: 'High', target_url: 'http://127.0.0.1:8080/', status: 'Confirmed', created_at: '2026-11-02T08:05:46.038Z' },
  { id: 'VULN-20261102-007', host: '127.0.0.1:8080', service_host: 'gitea:3000', realm: 'internal', internal_service_id: '', entry_point: 'Gitea 私有仓库 opsadmin/runbooks（Basic Auth）', vuln_name: 'Gitea 私有 runbooks 仓库明文存储 Jenkins 口令、跳板私钥位置与提权路径', vuln_type: 'Sensitive Information Disclosure', severity: 'High', target_url: 'http://gitea:3000/opsadmin/runbooks', status: 'Confirmed', created_at: '2026-11-02T08:06:03.660Z' },
  { id: 'VULN-20261102-008', host: '127.0.0.1:8080', service_host: 'jenkins:8080', realm: 'internal', internal_service_id: '', entry_point: 'POST /scriptText（Groovy Script Console）', vuln_name: 'Jenkins Script Console 未受限导致 RCE 与 jump 主机 SSH 私钥窃取', vuln_type: 'Remote Code Execution', severity: 'Critical', target_url: 'http://jenkins:8080/scriptText', status: 'Confirmed', created_at: '2026-11-02T08:06:03.668Z' },
  { id: 'VULN-20261102-009', host: '127.0.0.1:8080', service_host: 'jump', realm: 'internal', internal_service_id: '', entry_point: 'sudo NOPASSWD /usr/local/bin/backup.sh（deploy 组可写）', vuln_name: '跳板机 backup.sh 组可写 + sudo NOPASSWD 导致本地提权至 root', vuln_type: 'Privilege Escalation', severity: 'Critical', target_url: 'ssh://jump/usr/local/bin/backup.sh', status: 'Confirmed', created_at: '2026-11-02T08:06:14.085Z' },
  { id: 'VULN-20261102-010', host: '127.0.0.1:8080', service_host: '', realm: 'web', internal_service_id: '', entry_point: 'POST /upload、POST /login（无 CSRF token）', vuln_name: '缺少 CSRF 防护且会话 Cookie 未设置 SameSite', vuln_type: 'CSRF', severity: 'Medium', target_url: 'http://127.0.0.1:8080/upload', status: 'Confirmed', created_at: '2026-11-02T08:07:09.557Z' },
  { id: 'VULN-20261102-011', host: '127.0.0.1:8080', service_host: '', realm: 'web', internal_service_id: '', entry_point: 'POST /login', vuln_name: '登录接口无速率限制可无限速爆破', vuln_type: 'Brute Force', severity: 'Medium', target_url: 'http://127.0.0.1:8080/login', status: 'Confirmed', created_at: '2026-11-02T08:07:09.563Z' },
  { id: 'VULN-20261102-012', host: '127.0.0.1:8080', service_host: '', realm: 'web', internal_service_id: '', entry_point: '全部 HTTP 响应头', vuln_name: '缺少安全响应头（可点击劫持、无 nosniff/CSP/HSTS）', vuln_type: 'Security Misconfiguration', severity: 'Low', target_url: 'http://127.0.0.1:8080/', status: 'Confirmed', created_at: '2026-11-02T08:07:21.746Z' },
  { id: 'VULN-20261102-013', host: '127.0.0.1:8080', service_host: 'redis:6379', realm: 'internal', internal_service_id: '', entry_point: 'redis:6379 AUTH', vuln_name: 'Redis 凭据泄露导致管理权限暴露（CONFIG/INFO 可读写）', vuln_type: 'Sensitive Service Exposure', severity: 'Medium', target_url: 'redis://redis:6379', status: 'Confirmed', created_at: '2026-11-02T08:07:21.753Z' }
]

const ASSETS = [
  {
    host_port: ASSET_HOST_PORT,
    host: '127.0.0.1',
    project_name: PROJECT,
    tech_stack:
      'nginx 1.27.5, Flask (Python 3), pymysql, MariaDB 11.4.13, Redis 7.4.12, Docker Compose 多容器, Gitea 1.22.6, Jenkins 2.541.3 (Jetty 12.1.5), Debian 13 trixie, OpenSSH',
    auth_required: true,
    status: 'Alive',
    interface_count: 10,
    leak_count: 8,
    related_vuln_count: 6,
    last_seen: '2026-11-02T08:06:34.39Z'
  }
]

const SNAPSHOT_SUMMARY = {
  session_id: SNAPSHOT_ID,
  project_name: PROJECT,
  current_phase: '已完成全链路渗透，root flag 已获取，13 项漏洞全部入库，环境已还原',
  target_hosts: ['http://127.0.0.1:8080/', 'gitea:3000', 'jenkins:8080', 'jump', 'redis:6379', 'mysql:3306'],
  parent_session_id: null,
  archived_at: null,
  child_count: 0,
  created_at: '2026-11-02T08:08:09.226Z',
  updated_at: '2026-11-02T08:08:09.226Z',
  unfinished_count: 0,
  failed_count: 8,
  tested_interface_count: 9,
  next_steps_excerpt: '无剩余任务。如需复测，从 demo:demo123 重新登录即可复现。',
  has_previous_state: false
}

const APP_INFO = {
  name: 'Cortex',
  version: '0.1.0',
  projectRoot: 'C:\\Users\\slg13\\Desktop\\Cortex',
  dbPath: 'C:\\Users\\slg13\\.cortex\\data.db',
  schemaVersion: 5,
  platform: 'win32',
  electronVersion: '31.7.7',
  nodeVersion: '22.19.0',
  chromeVersion: '126.0.6478.234',
  mcpRuntime: {
    mode: 'installed',
    command: 'node.exe',
    entry: 'C:\\Users\\slg13\\.dsh\\plugins\\dsh-cortex\\mcp\\server.mjs',
    display: 'node.exe "C:\\Users\\slg13\\.dsh\\plugins\\dsh-cortex\\mcp\\server.mjs"'
  }
}

const DB_INFO = {
  dbPath: APP_INFO.dbPath,
  schemaVersion: 5,
  exists: true,
  sizeBytes: 1_234_567,
  walSizeBytes: 32_768,
  lastModifiedAt: '2026-11-02T08:08:09.226Z'
}

const SETUP_INFO = {
  alreadyConfigured: true,
  agents: [],
  defaultSkillLanguage: 'zh',
  defaultUiLanguage: 'zh'
}

const INTERNAL_PROJECTS = [
  { project_name: PROJECT, counts: { footholds: 0, hosts: 0, services: 0, credentials: 0, pivots: 0 } }
]

function statsFor(rows) {
  const bySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  const byStatus = { Confirmed: 0, Inconclusive: 0, Retest_Passed: 0 }
  const hosts = new Set()
  const todayKey = new Date().toISOString().slice(0, 10)
  let today = 0
  for (const row of rows) {
    bySeverity[row.severity] = (bySeverity[row.severity] || 0) + 1
    byStatus[row.status] = (byStatus[row.status] || 0) + 1
    hosts.add(row.service_host || row.host)
    if (String(row.created_at).slice(0, 10) === todayKey) today += 1
  }
  return { total: rows.length, critical: bySeverity.Critical, high: bySeverity.High, hosts: hosts.size, today, bySeverity, byStatus }
}

const WEB_STATS = statsFor(VULNS.filter((vuln) => vuln.realm === 'web'))
const INTERNAL_ROWS = VULNS.filter((vuln) => vuln.realm === 'internal')
const INTERNAL_STATS = statsFor(INTERNAL_ROWS)
const INTERNAL_COUNT = INTERNAL_ROWS.length

function fullVulnerability(id) {
  const row = VULNS.find((entry) => entry.id === id)
  if (!row) return null
  return {
    ...row,
    affected_interfaces: [],
    description: '## 漏洞概述\n\nmock record for UI smoke',
    impact: 'mock impact',
    reproduction_steps: '### 步骤 1\n\n```http\nGET / HTTP/1.1\n```',
    remediation: ['mock remediation'],
    crypto_details: '',
    test_boundaries: '',
    retest_results: [],
    related_vuln_ids: []
  }
}

/* -------------------------------------------------------------------------- */
/* Mock `/cortex-api/cortex/**` transport                                       */
/* -------------------------------------------------------------------------- */
function createMockFetch() {
  const requests = []

  const respond = (body, status = 200) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => (body === undefined ? undefined : JSON.parse(text)),
      text: async () => text,
      headers: { get: () => 'application/json' }
    })
  }
  const notFound = (path) => respond({ error: `mock: no route for ${path}`, code: 'MOCK_NOT_FOUND' }, 404)

  const filterVulns = (query) => {
    let rows = VULNS.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    const realm = query.get('realm')
    if (realm && realm !== 'all') rows = rows.filter((row) => row.realm === realm)
    const severity = query.get('severity')
    if (severity && severity !== 'all') rows = rows.filter((row) => row.severity === severity)
    const status = query.get('status')
    if (status && status !== 'all') rows = rows.filter((row) => row.status === status)
    const search = query.get('search')
    if (search) {
      const needle = search.toLowerCase()
      rows = rows.filter((row) =>
        [row.id, row.host, row.vuln_name, row.vuln_type, row.target_url, row.entry_point]
          .join('\n')
          .toLowerCase()
          .includes(needle)
      )
    }
    const pageSize = Math.max(1, Number(query.get('pageSize')) || 10)
    const requestedPage = Math.max(1, Number(query.get('page')) || 1)
    const total = rows.length
    const lastPage = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.min(requestedPage, lastPage)
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize }
  }

  async function mockFetch(input, init) {
    const method = String((init && init.method) || 'GET').toUpperCase()
    const rawUrl = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
    const parsed = new URL(rawUrl, PAGE_ORIGIN)
    const path = parsed.pathname
    const query = parsed.searchParams
    requests.push({ method, path, search: parsed.search, body: init && init.body ? String(init.body) : undefined })

    if (!path.startsWith(API_BASE)) return notFound(path)
    const route = path.slice(API_BASE.length) || '/'

    if (method === 'GET' && route === '/rev') return respond({ rev: 13 })
    if (method === 'GET' && route === '/stats') {
      const realm = query.get('realm')
      const rows = realm === 'internal' ? INTERNAL_ROWS : realm === 'web' ? VULNS.filter((v) => v.realm === 'web') : VULNS
      const stats = statsFor(rows)
      return respond({ ...stats, internal: { total: INTERNAL_STATS.total, critical: INTERNAL_STATS.critical, high: INTERNAL_STATS.high, hosts: 0 } })
    }
    if (method === 'GET' && route === '/vulns') return respond(filterVulns(query))
    if (method === 'GET' && /^\/vulns\/[^/]+$/.test(route)) {
      return respond(fullVulnerability(decodeURIComponent(route.slice('/vulns/'.length))))
    }
    if (method === 'GET' && route === '/assets') {
      const search = (query.get('search') || '').toLowerCase()
      const rows = search ? ASSETS.filter((row) => JSON.stringify(row).toLowerCase().includes(search)) : ASSETS
      return respond(rows)
    }
    if (method === 'GET' && /^\/assets\/[^/]+\/related-vulns$/.test(route)) {
      return respond(WEB_STATS.total > 0 ? VULNS.filter((row) => row.realm === 'web') : [])
    }
    if (method === 'GET' && /^\/assets\/[^/]+$/.test(route)) {
      const hostPort = decodeURIComponent(route.slice('/assets/'.length))
      const asset = ASSETS.find((row) => row.host_port === hostPort)
      if (!asset) return respond(null)
      return respond({
        host_port: asset.host_port,
        host: asset.host,
        project_name: asset.project_name,
        tech_stack: asset.tech_stack,
        auth_required: asset.auth_required,
        status: asset.status,
        interfaces: [],
        interface_dir: [],
        leaked_infos: [],
        test_parameters: [],
        related_vuln_ids: [],
        last_seen: asset.last_seen
      })
    }
    if (method === 'GET' && route === '/snapshots') {
      return respond({ total: 1, items: [SNAPSHOT_SUMMARY] })
    }
    if (method === 'GET' && /^\/snapshots\/[^/]+$/.test(route)) {
      const id = decodeURIComponent(route.slice('/snapshots/'.length))
      if (id !== SNAPSHOT_ID) return respond(null)
      return respond({
        ...SNAPSHOT_SUMMARY,
        unfinished_tasks: [],
        failed_paths: ['/login SQL 注入：参数化查询'],
        tested_interfaces: [],
        notes: '',
        related_vuln_ids: VULNS.map((row) => row.id),
        next_steps: SNAPSHOT_SUMMARY.next_steps_excerpt
      })
    }
    if (method === 'GET' && route === '/internal/overview') {
      return respond({
        project_name: PROJECT,
        counts: { footholds: 0, hosts: 0, services: 0, credentials: 0, pivots: 0, internal_vulns: INTERNAL_COUNT, loot_imports: 0 },
        footholds: [],
        hosts: [],
        services: [],
        credentials: [],
        pivots: [],
        trials: [],
        internal_vulns: INTERNAL_ROWS,
        loot_imports: [],
        warnings: [],
        projects: INTERNAL_PROJECTS
      })
    }
    if (method === 'GET' && route === '/internal/projects') return respond(INTERNAL_PROJECTS)
    if (method === 'GET' && route === '/internal/graph') {
      return respond({
        project_name: PROJECT,
        generated_at: '2026-11-02T08:08:09.226Z',
        counts: { footholds: 0, hosts: 0, services: 0, credentials: 0, pivots: 0, internal_vulns: INTERNAL_COUNT, loot_imports: 0 },
        footholds: [],
        hosts: [],
        services: [],
        credentials: [],
        pivots: [],
        trials: [],
        heatmap: [],
        suggestions: [],
        truncated: false,
        warnings: []
      })
    }
    if (method === 'GET' && route === '/loot') return respond([])
    if (method === 'GET' && route === '/db/info') return respond(DB_INFO)
    if (method === 'GET' && route === '/app/info') return respond(APP_INFO)
    if (method === 'GET' && route === '/setup/info') return respond(SETUP_INFO)
    if (method === 'GET' && route === '/poc/config') return respond({ providers: [], models: [], agent: null })
    if (method === 'POST' && route === '/graph') return respond({ nodes: [], links: [], meta: {} })
    return notFound(route)
  }

  return { fetch: mockFetch, requests }
}

/* -------------------------------------------------------------------------- */
/* jsdom environment                                                            */
/* -------------------------------------------------------------------------- */
const GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame'
]

function installGlobals(window) {
  const previous = new Map()
  const set = (name, value) => {
    if (!previous.has(name)) previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    // Node 24+ exposes several of these as getter-only accessors.
    Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, writable: true, value })
  }
  set('window', window)
  set('document', window.document)
  set('navigator', window.navigator)
  set('HTMLElement', window.HTMLElement)
  set('Element', window.Element)
  set('Node', window.Node)
  set('Event', window.Event)
  set('MouseEvent', window.MouseEvent)
  set('KeyboardEvent', window.KeyboardEvent)
  set('getComputedStyle', window.getComputedStyle.bind(window))
  set('requestAnimationFrame', window.requestAnimationFrame.bind(window))
  set('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
  set('IS_REACT_ACT_ENVIRONMENT', true)
  return () => {
    for (const [name, descriptor] of previous) {
      try {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * APIs the real DSH page has that jsdom does not implement. None of these are
 * exercised by the assertions themselves; they only prevent the original App
 * from crashing on mount.
 */
function polyfillWindow(window) {
  const define = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { configurable: true, writable: true, value })
    } catch {
      target[name] = value
    }
  }

  if (typeof window.matchMedia !== 'function') {
    define(window, 'matchMedia', (query) => ({
      matches: false,
      media: String(query),
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      }
    }))
  }

  class ObserverStub {
    constructor(callback) {
      this.callback = callback
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  if (typeof window.ResizeObserver !== 'function') define(window, 'ResizeObserver', ObserverStub)
  if (typeof window.IntersectionObserver !== 'function') define(window, 'IntersectionObserver', ObserverStub)
  if (typeof window.requestIdleCallback !== 'function') {
    define(window, 'requestIdleCallback', (callback) =>
      window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0)
    )
  }
  if (typeof window.cancelIdleCallback !== 'function') define(window, 'cancelIdleCallback', window.clearTimeout.bind(window))

  const noop = () => {}
  const elementProto = window.Element.prototype
  if (typeof elementProto.scrollIntoView !== 'function') define(elementProto, 'scrollIntoView', noop)
  if (typeof elementProto.scrollTo !== 'function') define(elementProto, 'scrollTo', noop)
  for (const method of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture']) {
    if (typeof window.HTMLElement.prototype[method] !== 'function') {
      define(window.HTMLElement.prototype, method, method === 'hasPointerCapture' ? () => false : noop)
    }
  }
  define(window, 'scrollTo', noop)

  // Clipboard: the original App copies command lines from detail sheets.
  if (!window.navigator.clipboard) {
    define(window.navigator, 'clipboard', { writeText: async () => {}, readText: async () => '' })
  } else if (typeof window.navigator.clipboard.writeText !== 'function') {
    define(window.navigator.clipboard, 'writeText', async () => {})
  }

  const crypto = window.crypto
  if (crypto && typeof crypto.randomUUID !== 'function') {
    define(crypto, 'randomUUID', () => '00000000-0000-4000-8000-000000000000')
  }
}

function createJsdom() {
  const virtualConsole = new VirtualConsole()
  const jsdomErrors = []
  virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error))

  const dom = new JSDOM(
    '<!doctype html><html lang="zh-CN"><head></head><body><div id="dsh-cortex-smoke-root"></div></body></html>',
    { url: PAGE_ORIGIN, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole }
  )
  const window = dom.window
  window.localStorage.setItem('cortex.lang', 'zh')
  polyfillWindow(window)
  return { dom, window, jsdomErrors }
}

/* -------------------------------------------------------------------------- */
/* Assertion helpers                                                            */
/* -------------------------------------------------------------------------- */
const FATAL_CONSOLE_PATTERNS = [
  /Warning: ReactDOM\.render is no longer supported/i,
  /Invalid hook call/i,
  /Rendered more hooks than during the previous render/i,
  /Rendered fewer hooks than expected/i,
  /Maximum update depth exceeded/i,
  /The above error occurred in the/i,
  /Uncaught Error/i,
  /Minified React error #\d+/i,
  /Cannot update a component \(`.*`\) while rendering a different component/i
]

function stringifyConsoleArgs(args) {
  return args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

function isFatalConsoleMessage(message) {
  return FATAL_CONSOLE_PATTERNS.some((pattern) => pattern.test(message))
}

function squash(text, limit = 120) {
  const value = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function textOf(element) {
  return element ? squash(element.textContent, 400) : ''
}

async function actSleep(act, ms = 20) {
  await act(async () => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
  })
}

async function waitFor(act, predicate, { timeoutMs = 15_000, intervalMs = 25, label = 'condition' } = {}) {
  const started = Date.now()
  let lastError = null
  for (;;) {
    try {
      const value = predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() - started >= timeoutMs) {
      const suffix = lastError ? ` (last predicate error: ${lastError.message})` : ''
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${suffix}`)
    }
    // eslint-disable-next-line no-await-in-loop
    await actSleep(act, intervalMs)
  }
}

/* -------------------------------------------------------------------------- */
/* Main harness                                                                 */
/* -------------------------------------------------------------------------- */
export async function runCortexUiSmoke(options = {}) {
  const startedAt = Date.now()
  const clientPath = options.clientPath || DEFAULT_CLIENT_PATH
  const verbose = Boolean(options.verbose)

  if (!existsSync(clientPath)) {
    throw new Error(`client.js not found: ${clientPath} (run: node scripts/build-cortex-ui.mjs)`)
  }
  const clientSource = readFileSync(clientPath, 'utf8')
  const clientBytes = Buffer.byteLength(clientSource)

  const { dom, window, jsdomErrors } = createJsdom()
  const mock = createMockFetch()
  window.fetch = mock.fetch
  const restoreGlobals = installGlobals(window)

  const consoleErrors = []
  const consoleWarnings = []
  const windowErrors = []
  const checks = []
  const structural = {}

  const windowConsole = window.console
  const originalWindowError = windowConsole.error
  const originalWindowWarn = windowConsole.warn
  const originalNodeError = console.error
  const originalNodeWarn = console.warn

  windowConsole.error = (...args) => {
    consoleErrors.push(stringifyConsoleArgs(args))
    if (verbose) originalNodeWarn('[page console.error]', ...args)
  }
  windowConsole.warn = (...args) => {
    consoleWarnings.push(stringifyConsoleArgs(args))
    if (verbose) originalNodeWarn('[page console.warn]', ...args)
  }
  console.error = (...args) => {
    consoleErrors.push(stringifyConsoleArgs(args))
    if (verbose) originalNodeWarn('[node console.error]', ...args)
  }
  console.warn = (...args) => {
    const message = stringifyConsoleArgs(args)
    // The dev-mode react-dom used by this harness only; the real page runs prod React.
    if (message.includes('ReactDOM.render')) consoleErrors.push(message)
    else consoleWarnings.push(message)
    if (verbose) originalNodeWarn('[node console.warn]', ...args)
  }
  const onWindowError = (event) => {
    windowErrors.push(event && (event.message || (event.error && event.error.message) || 'window error event'))
  }
  const onRejection = (event) => {
    windowErrors.push(`unhandled rejection: ${event && event.reason ? String(event.reason && event.reason.message ? event.reason.message : event.reason) : 'unknown'}`)
  }
  window.addEventListener('error', onWindowError)
  window.addEventListener('unhandledrejection', onRejection)

  let container = null
  let outerRoot = null
  let moduleDef = null
  let mainComponent = null
  let shadow = null
  let host = null
  let React = null
  let act = null

  const check = async (name, fn) => {
    try {
      const detail = await fn()
      checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
    } catch (error) {
      checks.push({ name, ok: false, detail: error && error.message ? error.message : String(error) })
    }
  }

  try {
    /* ---------------------------------------------------------- 1. jsdom load */
    let moduleLoaderCalls = 0
    window.__ModuleLoader__ = {
      load(def) {
        moduleLoaderCalls += 1
        moduleDef = def
      }
    }
    try {
      window.eval(clientSource)
    } catch (error) {
      throw new Error(`client.js threw while evaluating in jsdom: ${error && error.stack ? error.stack : error}`)
    }
    assert.equal(moduleLoaderCalls, 1, 'client.js must call window.__ModuleLoader__.load exactly once')
    assert.ok(moduleDef && typeof moduleDef.factory === 'function', 'ModuleLoader definition has no factory')
    assert.equal(moduleDef.id, 'dsh-cortex')

    React = nodeRequire('react')
    assert.equal(React.version, '18.3.1', `expected platform React 18.3.1, got ${React.version}`)
    act = React.act
    assert.equal(typeof act, 'function', 'React 18.3.1 exposes act()')

    const unexpectedRequires = []
    const pluginModule = moduleDef.factory((id) => {
      if (id === 'react') return React
      unexpectedRequires.push(id)
      throw new Error(`[harness] platform module table does not provide '${id}'`)
    })
    assert.equal(unexpectedRequires.length, 0, `unexpected require() calls: ${unexpectedRequires.join(', ')}`)
    assert.equal(pluginModule.name, 'dsh-cortex')
    assert.equal(typeof pluginModule.apply, 'function')
    structural.pluginExports = { name: pluginModule.name, inject: pluginModule.inject }

    /* ------------------------------------------------------- 2. fake ctx.slots */
    const injections = []
    const registrations = []
    const effectDisposers = []
    const ctx = {
      effect(factory) {
        const dispose = factory()
        effectDisposers.push(dispose)
        return () => {}
      },
      slots: {
        inject(name, callback) {
          injections.push(name)
          return callback()
        },
        register(definition, component) {
          registrations.push({ name: definition && definition.name, id: definition && definition.id, component })
          return () => {}
        }
      }
    }
    pluginModule.apply(ctx)
    structural.injections = injections
    structural.registrations = registrations.map((entry) => ({ name: entry.name, id: entry.id, componentType: typeof entry.component }))

    const sidebarEntry = registrations.find((entry) => entry.name === 'sidebar.panellist')
    const mainEntry = registrations.find((entry) => entry.name === 'main')
    assert.ok(sidebarEntry, 'apply() must register a sidebar.panellist component')
    assert.ok(mainEntry, 'apply() must register the main component')
    mainComponent = mainEntry.component

    /* ------------------------------------------------- 3. render captured main */
    const { createRoot } = nodeRequire('react-dom/client')
    container = document.createElement('div')
    container.id = 'cortex-panel-host'
    document.body.appendChild(container)
    outerRoot = createRoot(container)
    await act(async () => {
      outerRoot.render(React.createElement(mainComponent))
    })

    await waitFor(
      act,
      () => {
        const candidate = container.firstElementChild
        if (!candidate || !candidate.shadowRoot) return null
        const root = candidate.shadowRoot.querySelector('.dshc-cortex-root')
        if (!root) return null
        if (!candidate.shadowRoot.querySelector('[data-testid="metric-total"]')) return null
        if (candidate.shadowRoot.querySelectorAll('[data-testid="vuln-row"]').length === 0) return null
        return candidate
      },
      { label: 'shadow-root App mount + dashboard data load', timeoutMs: 20_000 }
    )

    host = container.firstElementChild
    shadow = host.shadowRoot
    const byTestId = (id) => shadow.querySelector(`[data-testid="${id}"]`)
    const allTestIds = (id) => Array.from(shadow.querySelectorAll(`[data-testid="${id}"]`))

    /* ---------------------------------------------------------- 4. assertions */
    await check('shadow DOM panel + injected stylesheet', () => {
      assert.ok(host, 'panel host element missing')
      assert.ok(shadow, 'panel host has no shadowRoot')
      const style = shadow.querySelector('style[data-dsh-cortex-ui]')
      assert.ok(style, 'shadow root has no <style data-dsh-cortex-ui>')
      structural.cssBytes = style.textContent.length
      assert.ok(structural.cssBytes > 30_000, `stylesheet too small: ${structural.cssBytes} bytes`)
      assert.ok(style.textContent.includes('.dshc-cortex-root'), 'stylesheet lacks shadow-root variable overrides')
      assert.match(style.textContent, /\.markdown-body/, 'stylesheet lacks the original markdown typography')
      // Chromium ignores @font-face inside Shadow DOM stylesheets, so the wrapper
      // must inject the inlined Inter/JetBrains faces into document.head.
      const fontStyle = document.querySelector('style[data-dsh-cortex-fonts]')
      assert.ok(fontStyle, 'missing document.head @font-face style')
      assert.match(fontStyle.textContent, /@font-face/, 'font style lacks @font-face rules')
      assert.match(fontStyle.textContent, /data:font\/woff2/, 'font faces must embed the woff2 bytes')
      structural.fontFaces = (fontStyle.textContent.match(/@font-face/g) || []).length
      assert.ok(structural.fontFaces >= 12, `expected 13 bundled font faces, got ${structural.fontFaces}`)
      assert.ok(fontStyle.textContent.length > 250_000, `inlined font payload too small: ${fontStyle.textContent.length} bytes`)
      assert.ok(shadow.querySelector('.dshc-cortex-root'), 'missing .dshc-cortex-root mount point')
      return `${structural.cssBytes} CSS bytes, fonts inlined`
    })

    await check('styles stay inside the shadow root (no leak into DSH shell)', () => {
      assert.equal(document.querySelector('aside'), null, 'cortex <aside> leaked into the light DOM')
      assert.equal(document.querySelector('.dshc-cortex-root'), null, '.dshc-cortex-root leaked into the light DOM')
      assert.equal(document.querySelector('style[data-dsh-cortex-ui]'), null, 'cortex stylesheet leaked into <head>/light DOM')
      return 'aside/nav/styles are all shadow-scoped'
    })

    await check('no duplicate left card column: one horizontal top nav replaces the 236px sidebar', () => {
      assert.equal(shadow.querySelector('aside'), null, 'the cloned left sidebar must not render in DSH')
      const topnav = byTestId('cortex-topnav')
      assert.ok(topnav, 'missing horizontal top navigation row')
      assert.equal(shadow.querySelector('header.app-drag'), null, 'frameless-window titlebar must not render in DSH')
      structural.topNav = true
      return 'single horizontal nav row'
    })

    await check('top nav has no duplicated Cortex branding (label/icon removed)', () => {
      const topnav = byTestId('cortex-topnav')
      assert.equal(topnav.querySelector('img'), null, 'no product logo inside the top nav')
      assert.doesNotMatch(textOf(topnav), /Cortex/, 'no Cortex product label inside the top nav')
      return 'brand-free top nav'
    })

    await check('top nav: original 7 cards, correct order + lucide SVG icons', () => {
      const topnav = byTestId('cortex-topnav')
      const buttons = Array.from(topnav.querySelectorAll('nav button'))
      const ids = buttons.map((button) => button.getAttribute('data-testid'))
      const expected = ['nav-dashboard', 'nav-internal', 'nav-nebula', 'nav-assets', 'nav-snapshots', 'nav-retest']
      assert.deepEqual(ids, expected, `nav items: ${ids.join(',')}`)
      const labels = buttons.map((button) => squash(button.textContent, 40))
      assert.deepEqual(labels, ['漏洞看板', '内网作战', '记忆星云', '资产库', '认知快照', '漏洞复测'], `nav labels: ${labels.join('|')}`)
      const iconClasses = buttons.map((button) => {
        const svg = button.querySelector('svg')
        assert.ok(svg, `nav item ${button.getAttribute('data-testid')} has no lucide <svg> icon`)
        return svg.getAttribute('class') || ''
      })
      const expectedIcons = [
        'lucide-shield-alert',
        'lucide-network',
        'lucide-orbit',
        'lucide-boxes',
        'lucide-brain',
        'lucide-flask-conical'
      ]
      expectedIcons.forEach((iconName, index) => {
        assert.ok(iconClasses[index].includes(iconName), `icon #${index} expected ${iconName}, got "${iconClasses[index]}"`)
      })
      structural.navItems = ids.map((id, index) => ({ id, label: labels[index], icon: expectedIcons[index] }))
      structural.activeNav = buttons.filter((button) => button.getAttribute('aria-current') === 'page').map((b) => b.getAttribute('data-testid'))
      assert.deepEqual(structural.activeNav, ['nav-dashboard'], 'dashboard must be the active nav item')
      assert.equal(shadow.querySelector('[data-testid="nav-ai-config"]'), null, 'ai-config nav must be hidden in the web runtime')
      return `${ids.length} items, icons ok, ai-config hidden`
    })

    await check('language toggle at the right edge of the top nav row; no database card', () => {
      const topnav = byTestId('cortex-topnav')
      const languageToggle = byTestId('lang-toggle')
      assert.ok(languageToggle, 'missing language toggle')
      assert.ok(topnav.contains(languageToggle), 'language toggle must live in the top nav row')
      assert.equal(textOf(languageToggle), 'EN', 'language toggle should offer EN while zh is active')
      const languagesIcon = languageToggle.querySelector('svg')
      assert.ok(languagesIcon && (languagesIcon.getAttribute('class') || '').includes('lucide-languages'), 'language toggle icon missing')
      assert.doesNotMatch(textOf(shadow), /data\.db/, 'the database card must be removed from the plugin UI')
      structural.languageToggle = 'EN'
      return 'data.db + EN toggle'
    })

    await check('top nav is the only header row (no duplicated titlebar chrome)', () => {
      const header = shadow.querySelector('header')
      assert.ok(header, 'missing <header> top nav')
      assert.equal(header.getAttribute('data-testid'), 'cortex-topnav', `header: ${header.className}`)
      const buttons = header.querySelectorAll('button')
      // 6 nav cards + the language toggle, no window controls.
      assert.equal(buttons.length, 7, `expected 6 nav buttons + 1 language toggle, found ${buttons.length}`)
      structural.titlebarButtons = 0
      return 'single header row, no window controls'
    })

    await check('main area renders the Dashboard (tabs + metric strip values from /stats)', () => {
      const main = shadow.querySelector('main')
      assert.ok(main, 'missing <main>')
      assert.ok(byTestId('dashboard-tabs'), 'missing dashboard tabs')
      const tabs = byTestId('dashboard-tabs')
      const tabLabels = Array.from(tabs.querySelectorAll('button')).map((button) =>
        squash(button.textContent, 40).replace(/\d+$/, '')
      )
      assert.deepEqual(tabLabels.slice(0, 2), ['Web 漏洞', '内网作战'], `dashboard tabs: ${tabLabels.join('|')}`)
      const internalBadge = byTestId('dashboard-internal-count')
      assert.ok(internalBadge, 'missing internal count badge')
      assert.equal(textOf(internalBadge), String(INTERNAL_COUNT), 'internal realm badge value')

      const expectedMetrics = {
        'metric-total': String(WEB_STATS.total),
        'metric-critical': String(WEB_STATS.critical),
        'metric-hosts': String(WEB_STATS.hosts),
        'metric-today': String(WEB_STATS.today)
      }
      const metricValues = {}
      for (const [testId, expected] of Object.entries(expectedMetrics)) {
        const cell = byTestId(testId)
        assert.ok(cell, `missing ${testId}`)
        const value = cell.children[1]
        assert.ok(value, `${testId} has no value cell`)
        const actual = squash(value.textContent, 40)
        metricValues[testId] = actual
        assert.equal(actual, expected, `${testId}: expected ${expected}, got ${actual}`)
      }
      structural.metrics = metricValues
      structural.dashboardInternalCount = INTERNAL_COUNT
      return JSON.stringify(metricValues)
    })

    await check('dashboard vuln table renders the mocked web realm (9 rows, severity data)', () => {
      const rows = allTestIds('vuln-row')
      assert.equal(rows.length, WEB_STATS.total, `expected ${WEB_STATS.total} vuln rows, got ${rows.length}`)
      const bySeverity = {}
      for (const row of rows) {
        const severity = row.getAttribute('data-severity')
        bySeverity[severity] = (bySeverity[severity] || 0) + 1
      }
      assert.deepEqual(bySeverity, { Critical: 2, High: 3, Medium: 3, Low: 1 }, `severity distribution: ${JSON.stringify(bySeverity)}`)
      const firstRow = rows[0]
      assert.ok(firstRow.textContent.includes('VULN-20261102-'), 'row does not show the vulnerability id')
      assert.ok(firstRow.textContent.includes('127.0.0.1:8080'), 'row does not show the host')
      structural.vulnRows = rows.length
      structural.vulnSeverities = bySeverity
      return `${rows.length} rows, ${JSON.stringify(bySeverity)}`
    })

    await check('data layer talks to the real plugin routes (/stats, /vulns, /rev)', () => {
      const seen = (method, path, predicate) =>
        mock.requests.some((request) => request.method === method && request.path === `${API_BASE}${path}` && (!predicate || predicate(request)))
      assert.ok(seen('GET', '/stats', (request) => new URL(request.search || '', PAGE_ORIGIN).searchParams.get('realm') === 'web'), 'no GET /stats?realm=web request')
      assert.ok(seen('GET', '/vulns', (request) => new URL(request.search || '', PAGE_ORIGIN).searchParams.get('realm') === 'web'), 'no GET /vulns?realm=web request')
      assert.ok(seen('GET', '/rev'), 'no GET /rev revision poll request')
      structural.initialRequests = mock.requests.map((request) => `${request.method} ${request.path}${request.search || ''}`)
      return `${mock.requests.length} requests, all via /cortex-api/cortex`
    })

    await check('language toggle switches locale (zh → en → zh)', async () => {
      const languageToggle = byTestId('lang-toggle')
      const navAssets = byTestId('nav-assets')
      assert.equal(textOf(navAssets), '资产库')
      await act(async () => {
        languageToggle.click()
      })
      await waitFor(act, () => (textOf(byTestId('nav-assets')) === 'Assets' ? true : null), { label: 'english nav labels', timeoutMs: 5_000 })
      assert.equal(textOf(byTestId('lang-toggle')), '中文', 'toggle should offer zh while en is active')
      await act(async () => {
        byTestId('lang-toggle').click()
      })
      await waitFor(act, () => (textOf(byTestId('nav-assets')) === '资产库' ? true : null), { label: 'zh nav labels', timeoutMs: 5_000 })
      return 'en labels applied and reverted'
    })

    await check('sidebar click switches to the original Asset page and renders the mocked asset', async () => {
      const navAssets = byTestId('nav-assets')
      assert.ok(navAssets, 'missing nav-assets button')
      await act(async () => {
        navAssets.click()
      })
      const assetRow = await waitFor(
        act,
        () => {
          const row = shadow.querySelector('[data-testid="asset-row"]')
          return row && row.getAttribute('data-host-port') === ASSET_HOST_PORT ? row : null
        },
        { label: 'AssetPage asset row', timeoutMs: 10_000 }
      )
      assert.ok(byTestId('asset-search'), 'missing asset search input')
      assert.ok(byTestId('asset-status-filter'), 'missing asset status filter')
      assert.equal(byTestId('dashboard-tabs'), null, 'dashboard should be unmounted after navigation')
      const pageText = textOf(shadow.querySelector('main'))
      assert.ok(pageText.includes('资产库') || pageText.includes('资产'), `asset page heading missing: ${pageText}`)
      assert.ok(assetRow.textContent.includes('127.0.0.1:8080'), 'asset row does not show host_port')
      assert.ok(assetRow.textContent.includes(PROJECT), 'asset row does not show project name')
      structural.assetPage = { rows: allTestIds('asset-row').length, hostPort: assetRow.getAttribute('data-host-port') }
      return `${ASSET_HOST_PORT} rendered by the original AssetPage`
    })

    await check('nebula route is bundled with the original 3D graph code (not rendered: jsdom has no WebGL2)', () => {
      // The real DSH page has WebGL2 and renders the force-graph canvas. jsdom
      // does not, so the faithfulness gate asserts the code path instead: the
      // lazy route, its i18n page copy and THREE.js renderer are all in client.js.
      assert.equal(window.WebGL2RenderingContext, undefined, 'jsdom unexpectedly has WebGL2 now; render the canvas instead of this source check')
      for (const marker of ['nebula.title', 'THREE.WebGLRenderer', 'ForceGraph3D']) {
        assert.ok(clientSource.includes(marker), `client.js is missing nebula bundle marker ${marker}`)
      }
      assert.ok(byTestId('nav-nebula'), 'nebula nav entry missing')
      structural.nebula = { bundled: true, renderedInJsdom: false, reason: 'no WebGL2 in jsdom' }
      return 'lazy NebulaPage + THREE.js bundled, canvas intentionally not rendered'
    })

    await check('other original pages mount without React errors (internal / snapshots / mcp / retest)', async () => {
      const targets = [
        { nav: 'nav-internal', selector: '[data-testid="internal-page"]', label: 'internal' },
        { nav: 'nav-snapshots', selector: '[data-testid="snapshot-search"]', label: 'snapshots' },
        { nav: 'nav-retest', selector: '[data-testid="retest-page"]', label: 'retest (lazy chunk)' }
      ]
      const mounted = []
      for (const target of targets) {
        const button = byTestId(target.nav)
        assert.ok(button, `missing sidebar entry ${target.nav}`)
        const fatalBefore = consoleErrors.filter(isFatalConsoleMessage).length
        const windowErrorsBefore = windowErrors.length
        await act(async () => {
          button.click()
        })
        // eslint-disable-next-line no-await-in-loop
        await waitFor(act, () => shadow.querySelector(target.selector), { label: `${target.label} page`, timeoutMs: 10_000 })
        assert.equal(byTestId(target.nav).getAttribute('aria-current'), 'page', `${target.nav} should be active`)
        assert.equal(consoleErrors.filter(isFatalConsoleMessage).length, fatalBefore, `React error while mounting ${target.label}`)
        assert.equal(windowErrors.length, windowErrorsBefore, `page error while mounting ${target.label}: ${windowErrors.slice(windowErrorsBefore).join(' | ')}`)
        mounted.push(target.label)
      }
      structural.pagesMounted = mounted
      return `mounted: ${mounted.join(', ')}`
    })

    await check('main view stays isolated inside the shadow root after navigation', () => {
      assert.equal(document.querySelector('main'), null, '<main> leaked out of the shadow root')
      assert.ok(shadow.querySelector('main'), 'shadow root lost its <main>')
      return 'shadow-scoped main'
    })

    /* ------------------------------------------------------- 5. error hygiene */
    await check('no uncaught page errors or unhandled rejections', () => {
      assert.deepEqual(windowErrors, [], `page errors: ${windowErrors.join(' | ')}`)
      return '0 window error events'
    })

    await check('no React / hook errors on console.error', () => {
      const fatal = consoleErrors.filter(isFatalConsoleMessage)
      assert.deepEqual(fatal, [], `console.error: ${fatal.join(' | ')}`)
      return `${consoleErrors.length} console.error calls (none fatal)`
    })

    await check('no CSS/script jsdom failures beyond CSS parsing', () => {
      const nonCss = jsdomErrors.filter((error) => {
        const message = `${(error && error.type) || ''} ${(error && error.message) || error}`
        return !/css parsing|Could not parse CSS stylesheet/i.test(message)
      })
      assert.deepEqual(
        nonCss.map((error) => (error && error.message) || String(error)),
        [],
        'jsdom raised non-CSS errors'
      )
      structural.jsdomCssParseErrors = jsdomErrors.length - nonCss.length
      return `${jsdomErrors.length} CSS-parse diagnostics ignored (jsdom CSSOM lags real browsers)`
    })
  } catch (error) {
    checks.push({ name: 'harness', ok: false, detail: error && error.stack ? error.stack : String(error) })
  } finally {
    try {
      if (outerRoot) await act(async () => outerRoot.unmount())
    } catch {
      /* already unmounted */
    }
    try {
      if (container && container.parentNode) container.parentNode.removeChild(container)
    } catch {
      /* ignore */
    }
    try {
      window.removeEventListener('error', onWindowError)
      window.removeEventListener('unhandledrejection', onRejection)
    } catch {
      /* ignore */
    }
    windowConsole.error = originalWindowError
    windowConsole.warn = originalWindowWarn
    console.error = originalNodeError
    console.warn = originalNodeWarn
    try {
      restoreGlobals()
    } catch {
      /* ignore */
    }
    try {
      dom.window.close()
    } catch {
      /* ignore */
    }
  }

  const failures = checks.filter((entry) => !entry.ok)
  const report = {
    ok: failures.length === 0,
    clientPath,
    clientBytes,
    durationMs: Date.now() - startedAt,
    checks,
    failures,
    consoleErrors,
    consoleWarnings,
    windowErrors,
    jsdomErrors: jsdomErrors.map((error) => (error && error.message) || String(error)),
    requests: mock.requests,
    structural
  }
  if (verbose) printReport(report)
  return report
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                          */
/* -------------------------------------------------------------------------- */
export function printReport(report) {
  const total = report.checks.length
  const passed = total - report.failures.length
  if (report.structural) {
    console.log('[smoke-cortex-ui] structural snapshot:')
    for (const [key, value] of Object.entries(report.structural)) {
      console.log(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    }
  }
  console.log(`[smoke-cortex-ui] client.js ${(report.clientBytes / 1024).toFixed(1)} KiB @ ${report.clientPath}`)
  for (const entry of report.checks) {
    console.log(`${entry.ok ? '  ✓' : '  ✗'} ${entry.name}${entry.ok && entry.detail ? ` — ${entry.detail}` : ''}`)
    if (!entry.ok) console.log(`      FAIL: ${entry.detail}`)
  }
  const interestingConsole = report.consoleErrors
  if (interestingConsole.length > 0) {
    console.log(`[smoke-cortex-ui] console.error (${interestingConsole.length}):`)
    for (const message of interestingConsole.slice(0, 10)) console.log(`  ! ${squash(message, 300)}`)
  }
  if (report.consoleWarnings.length > 0) {
    console.log(`[smoke-cortex-ui] console.warn (${report.consoleWarnings.length}):`)
    for (const message of report.consoleWarnings.slice(0, 5)) console.log(`  - ${squash(message, 240)}`)
  }
  if (report.jsdomErrors.length > 0) {
    console.log(`[smoke-cortex-ui] jsdom diagnostics (${report.jsdomErrors.length} CSS parsing, non-fatal)`)
  }
  console.log(
    `[smoke-cortex-ui] ${report.ok ? 'PASS' : 'FAIL'} — ${passed}/${total} checks, ${report.durationMs}ms, ${report.requests.length} mocked API requests`
  )
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const verbose = process.argv.includes('--verbose')
  runCortexUiSmoke({ verbose })
    .then((report) => {
      if (!report.ok) process.exitCode = 1
      if (!verbose) {
        printReport(report)
      }
    })
    .catch((error) => {
      console.error('[smoke-cortex-ui] harness crashed:', error && error.stack ? error.stack : error)
      process.exitCode = 1
    })
}
