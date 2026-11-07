/**
 * Shared fixtures for the host-half tests.
 *
 * Every test builds its own temporary SQLite database from
 * `fixtures/schema5.sql` (never the live `~/.cortex/data.db`) and talks to a
 * real loopback `node:http` server wired to `createCortexHost()`. Temp dirs are
 * removed explicitly by each test file.
 */

import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createCortexHost } from '../../src/host/app.js'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const SCHEMA_PATH = join(REPO_ROOT, 'fixtures', 'schema5.sql')

// Tests must never depend on (or write to) the operator's live Cortex DB.
delete process.env.CORTEX_DB_PATH
delete process.env.CORTEX_DB_READONLY

// Repeater history/favorites state also lives on disk (CORTEX_REPEATER_DIR).
// Point it at one temp root per test process and remove it best-effort on
// exit, so a `node --test` run never writes into the operator's ~/.cortex.
if (!process.env.CORTEX_REPEATER_DIR) {
  const repeaterDir = mkdtempSync(join(tmpdir(), 'dsh-cortex-repeater-'))
  process.env.CORTEX_REPEATER_DIR = repeaterDir
  process.on('exit', () => {
    try {
      rmSync(repeaterDir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  })
}

/** @returns {string} */
export function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-cortex-host-'))
}

/** @param {string} dir */
export function cleanupDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
}

const VULN_COLUMNS = [
  'id',
  'host',
  'entry_point',
  'vuln_name',
  'vuln_type',
  'severity',
  'target_url',
  'description',
  'impact',
  'affected_interfaces',
  'reproduction_steps',
  'remediation',
  'crypto_details',
  'test_boundaries',
  'retest_results',
  'related_vuln_ids',
  'status',
  'created_at',
  'service_host',
  'realm',
  'internal_service_id',
]

export const VULN_DEFAULTS = {
  entry_point: '',
  description: '',
  impact: '',
  affected_interfaces: '[]',
  reproduction_steps: '',
  remediation: '[]',
  crypto_details: '',
  test_boundaries: '',
  retest_results: '[]',
  related_vuln_ids: '[]',
  status: 'Confirmed',
  created_at: '2026-01-01T00:00:00.000Z',
  service_host: '',
  realm: 'web',
  internal_service_id: '',
}

/** @param {DatabaseSync} db @param {Record<string, any>} row */
export function insertVuln(db, row) {
  const record = { ...VULN_DEFAULTS, ...row }
  const placeholders = VULN_COLUMNS.map(() => '?').join(', ')
  db.prepare(
    `INSERT INTO vulnerabilities (${VULN_COLUMNS.join(', ')}) VALUES (${placeholders})`,
  ).run(...VULN_COLUMNS.map((column) => record[column]))
  return record
}

/** @param {DatabaseSync} db @param {Record<string, any>} row */
export function insertAsset(db, row) {
  const record = {
    host: '',
    tech_stack: '',
    auth_required: 0,
    status: 'Alive',
    interfaces: '[]',
    interface_dir: '[]',
    leaked_infos: '[]',
    test_parameters: '[]',
    related_vuln_ids: '[]',
    last_seen: '2026-01-01T00:00:00.000Z',
    ...row,
  }
  db.prepare(
    `INSERT INTO assets (host_port, host, project_name, tech_stack, auth_required, status,
       interfaces, interface_dir, leaked_infos, test_parameters, related_vuln_ids, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.host_port,
    record.host,
    record.project_name,
    record.tech_stack,
    record.auth_required,
    record.status,
    record.interfaces,
    record.interface_dir,
    record.leaked_infos,
    record.test_parameters,
    record.related_vuln_ids,
    record.last_seen,
  )
  return record
}

/** @param {DatabaseSync} db @param {Record<string, any>} row */
export function insertSnapshot(db, row) {
  const record = {
    target_hosts: '[]',
    current_phase: '',
    unfinished_tasks: '[]',
    failed_paths: '[]',
    tested_interfaces: '[]',
    notes: '',
    related_vuln_ids: '[]',
    next_steps: '',
    previous_state: null,
    parent_session_id: null,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...row,
  }
  db.prepare(
    `INSERT INTO snapshot_sessions (session_id, project_name, target_hosts, current_phase,
       unfinished_tasks, failed_paths, tested_interfaces, notes, related_vuln_ids, next_steps,
       previous_state, parent_session_id, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.session_id,
    record.project_name,
    record.target_hosts,
    record.current_phase,
    record.unfinished_tasks,
    record.failed_paths,
    record.tested_interfaces,
    record.notes,
    record.related_vuln_ids,
    record.next_steps,
    record.previous_state,
    record.parent_session_id,
    record.archived_at,
    record.created_at,
    record.updated_at,
  )
  return record
}

/** Insert the standard fixture dataset used by most host tests. */
export function seedDatabase(db) {
  insertVuln(db, {
    id: 'VULN-20260101-001',
    host: '127.0.0.1:8080',
    entry_point: '/login',
    vuln_name: 'SQL 注入导致跨租户数据泄露',
    vuln_type: 'SQLi',
    severity: 'Critical',
    target_url: 'http://127.0.0.1:8080/login',
    description: '## 漏洞概述\n\n/orders 的 q 参数存在 SQL 注入。',
    impact: '可读取 customers / secrets 全表。',
    affected_interfaces: JSON.stringify(['/orders?q=', '/login']),
    reproduction_steps: '### 步骤 1\n\n```http\nGET /orders?q=1 HTTP/1.1\nHost: 127.0.0.1:8080\n```',
    remediation: JSON.stringify(['使用参数化查询', '部署 WAF']),
    crypto_details: '无',
    test_boundaries: '仅测试只读注入，未执行写操作。',
    retest_results: JSON.stringify([
      { time_range: '2026-01-02 10:00-10:04 (Asia/Shanghai)', conclusion: '### 复测 1\n\n仍可注入。' },
    ]),
    related_vuln_ids: JSON.stringify(['VULN-20260101-002', 'VULN-20260101-004']),
    status: 'Confirmed',
    created_at: '2026-01-01T00:00:01.000Z',
  })
  insertVuln(db, {
    id: 'VULN-20260101-002',
    host: '127.0.0.1:8080',
    entry_point: '全部响应头',
    vuln_name: '缺少安全响应头',
    vuln_type: 'Security Misconfiguration',
    severity: 'Low',
    target_url: 'http://127.0.0.1:8080/',
    description: '缺少 CSP / X-Frame-Options。',
    impact: '点击劫持风险。',
    affected_interfaces: 'not-json',
    remediation: '[broken',
    retest_results: '{"broken":true}',
    related_vuln_ids: 'null',
    status: 'Retest_Passed',
    created_at: '2026-01-01T00:00:02.000Z',
  })
  insertVuln(db, {
    id: 'VULN-20260101-003',
    host: '127.0.0.1:8080',
    entry_point: 'redis:6379 AUTH',
    vuln_name: 'Redis 未授权访问',
    vuln_type: 'Sensitive Service Exposure',
    severity: 'High',
    target_url: 'redis://10.0.0.5:6379',
    description: 'Redis 未设置口令。',
    impact: '可读写 Redis 数据。',
    service_host: '10.0.0.5:6379',
    realm: 'internal',
    internal_service_id: 'IS-1',
    status: 'Confirmed',
    created_at: '2026-01-01T00:00:03.000Z',
  })
  insertVuln(db, {
    id: 'VULN-20260101-004',
    host: '127.0.0.1:8080',
    entry_point: '/api/invoices/1',
    vuln_name: 'IDOR 越权读取发票',
    vuln_type: 'IDOR',
    severity: 'Medium',
    target_url: 'http://127.0.0.1:8080/api/invoices/1',
    description: 'invoice id 可遍历。',
    impact: '跨租户发票泄露。',
    related_vuln_ids: JSON.stringify(['VULN-20260101-001']),
    status: 'Inconclusive',
    created_at: '2026-01-01T00:00:04.000Z',
  })

  insertAsset(db, {
    host_port: 'http://127.0.0.1:8080/',
    host: '127.0.0.1',
    project_name: 'Project Alpha',
    tech_stack: 'nginx 1.27.5, Flask (Python 3)',
    auth_required: 1,
    status: 'Alive',
    interfaces: JSON.stringify([
      {
        path: '/login',
        method: 'POST',
        params: 'username,password',
        request: 'POST /login HTTP/1.1\nHost: 127.0.0.1:8080\n\nusername=demo',
      },
      { path: '/orders', method: 'GET' },
    ]),
    interface_dir: JSON.stringify(['/login', '/orders']),
    leaked_infos: JSON.stringify([
      {
        info_type: 'Credential',
        value: 'DB_PASSWORD=SecretLeakValue!',
        source: '/var/www/.env',
        potential_impact: '直连 MariaDB',
      },
    ]),
    test_parameters: JSON.stringify([
      {
        name: 'invoice_id',
        endpoint: '/api/invoices/<id>',
        location: 'path',
        values: ['1', '2', '3'],
        pattern: '自增整数',
        source: '/invoices 页面',
        tested: true,
        notes: 'IDOR 已确认',
        related_vuln_ids: ['VULN-20260101-004'],
      },
    ]),
    related_vuln_ids: JSON.stringify(['VULN-20260101-001', 'VULN-20260101-003']),
    last_seen: '2026-01-02T00:00:00.000Z',
  })
  insertAsset(db, {
    host_port: 'https://beta.example.test:8443/app',
    host: 'beta.example.test',
    project_name: 'Project Beta',
    tech_stack: 'React',
    auth_required: 0,
    status: 'Dead',
    interfaces: 'corrupt-json',
    related_vuln_ids: '[]',
    last_seen: '2025-12-31T00:00:00.000Z',
  })

  db.prepare(
    `INSERT INTO internal_hosts (id, project_name, ip, hostname, os, subnet, state, source, confidence, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('IH-1', 'Project Alpha', '10.0.0.5', 'db1', 'Debian 12', '10.0.0.0/24', 'alive', 'agent', 'high', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  db.prepare(
    `INSERT INTO internal_hosts (id, project_name, ip, hostname, os, subnet, state, source, confidence, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('IH-2', 'Project Alpha', '10.0.0.6', 'app2', '', '10.0.0.0/24', 'compromised', 'agent', 'medium', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  db.prepare(
    `INSERT INTO internal_services (id, project_name, host_id, port, protocol, service, banner, state, source, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('IS-1', 'Project Alpha', 'IH-1', 6379, 'tcp', 'redis', 'redis 7.4', 'open', 'agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  db.prepare(
    `INSERT INTO internal_services (id, project_name, host_id, port, protocol, service, banner, state, source, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('IS-2', 'Project Alpha', 'IH-2', 8080, 'tcp', 'http', 'internal api', 'open', 'agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

  db.prepare(
    `INSERT INTO footholds (id, project_name, entry_host_port, entry_vuln_id, access_type, privilege_level, status, evidence, notes, established_at, last_verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('FH-1', 'Project Alpha', 'http://127.0.0.1:8080/', 'VULN-20260101-003', 'rce', 'user', 'established', 'www-data shell', '经命令注入进入', '2026-01-01T02:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-01T02:00:00.000Z', '2026-01-02T00:00:00.000Z')
  db.prepare(
    `INSERT INTO footholds (id, project_name, entry_host_port, entry_vuln_id, access_type, privilege_level, status, evidence, notes, established_at, last_verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('FH-2', 'Project Alpha', 'http://127.0.0.1:8080/', 'VULN-20260101-001', 'credential', 'unknown', 'planned', '', '', '', '', '2026-01-01T03:00:00.000Z', '2026-01-01T03:00:00.000Z')

  db.prepare(
    'INSERT INTO foothold_hosts (foothold_id, internal_host_id, discovered_at, notes) VALUES (?, ?, ?, ?)',
  ).run('FH-1', 'IH-1', '2026-01-01T02:10:00.000Z', 'db1 可达')
  db.prepare(
    'INSERT INTO foothold_hosts (foothold_id, internal_host_id, discovered_at, notes) VALUES (?, ?, ?, ?)',
  ).run('FH-1', 'IH-2', '2026-01-01T02:20:00.000Z', '')

  db.prepare(
    `INSERT INTO credentials (id, project_name, type, username, domain, secret, source, host_id, service_id, confidence, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('CR-1', 'Project Alpha', 'password', 'admin', 'CORP', 'SuperSecretValue!42', '.env 泄露', 'IH-1', null, 'high', 'valid', '已登录', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  db.prepare(
    `INSERT INTO credentials (id, project_name, type, username, domain, secret, source, host_id, service_id, confidence, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('CR-2', 'Project Alpha', 'ssh_key', 'deploy', '', 'ssh-private-key-material', 'loot 导入', 'IH-2', 'IS-2', 'medium', 'untested', '', '2026-01-01T00:10:00.000Z', '2026-01-01T00:10:00.000Z')

  db.prepare(
    `INSERT INTO pivots (id, project_name, foothold_id, kind, local_host, local_port, local_protocol, tool, status, notes, established_at, last_verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('PV-1', 'Project Alpha', 'FH-1', 'proxy', '127.0.0.1', 1080, 'socks5', 'chisel', 'established', 'socks 代理', '2026-01-01T02:30:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-01T02:30:00.000Z', '2026-01-02T00:00:00.000Z')
  db.prepare('INSERT INTO pivot_hops (pivot_id, seq, ref_kind, ref_id, label, via) VALUES (?, ?, ?, ?, ?, ?)').run('PV-1', 0, 'internal_host', 'IH-1', 'db1', 'foothold')
  db.prepare('INSERT INTO pivot_hops (pivot_id, seq, ref_kind, ref_id, label, via) VALUES (?, ?, ?, ?, ?, ?)').run('PV-1', 1, 'internal_service', 'IS-1', 'redis', 'socks')
  db.prepare('INSERT INTO pivot_reachability (pivot_id, cidr, note) VALUES (?, ?, ?)').run('PV-1', '10.0.0.0/24', '内网段')

  insertSnapshot(db, {
    session_id: 'SESS-20260101-001',
    project_name: 'Project Alpha',
    target_hosts: JSON.stringify(['http://127.0.0.1:8080/']),
    current_phase: '侦察阶段',
    unfinished_tasks: JSON.stringify(['提取 /orders 参数']),
    failed_paths: JSON.stringify(['XSS 不可注入']),
    tested_interfaces: JSON.stringify([
      { target: '/orders?q=', method: 'UNION 注入', result: '泄露 users 表' },
    ]),
    notes: '# 备注\n\n进入内网 db1。',
    related_vuln_ids: JSON.stringify(['VULN-20260101-001']),
    next_steps: '复测 SQL 注入',
    created_at: '2026-01-01T01:00:00.000Z',
    updated_at: '2026-01-01T05:00:00.000Z',
  })
  insertSnapshot(db, {
    session_id: 'SESS-20260101-002',
    project_name: 'Project Alpha',
    target_hosts: JSON.stringify([]),
    current_phase: '利用阶段',
    notes: '子会话',
    parent_session_id: 'SESS-20260101-001',
    created_at: '2026-01-01T06:00:00.000Z',
    updated_at: '2026-01-01T07:00:00.000Z',
  })
  insertSnapshot(db, {
    session_id: 'SESS-20260101-003',
    project_name: 'Project Beta',
    current_phase: '归档会话',
    archived_at: '2026-01-03T00:00:00.000Z',
    created_at: '2025-12-01T00:00:00.000Z',
    updated_at: '2025-12-02T00:00:00.000Z',
  })
}

/**
 * Create a temp database from the schema v5 fixture.
 * @param {{schemaVersion?:number, seed?:boolean}} [options]
 */
export function createTestDb(options = {}) {
  const schemaVersion = options.schemaVersion ?? 5
  const seed = options.seed ?? true
  const dir = makeTempDir()
  const dbPath = join(dir, 'data.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
    if (schemaVersion !== 5) db.exec(`PRAGMA user_version = ${Number(schemaVersion)}`)
    if (seed) seedDatabase(db)
  } finally {
    db.close()
  }
  return { dir, dbPath }
}

/** Open a raw connection for direct assertions (caller closes it). */
export function openRawDb(dbPath) {
  return new DatabaseSync(dbPath)
}

/**
 * Start a real loopback HTTP server wired to the plugin handler.
 * @param {{dbPath:string, readOnly?:boolean, allowNetwork?:boolean, keepAlive?:boolean}} options
 */
export async function startTestHost(options) {
  const host = createCortexHost({
    config: {
      dbPath: options.dbPath,
      readOnly: options.readOnly === true,
      allowNetwork: options.allowNetwork === false ? false : true,
    },
  })
  const server = http.createServer((req, res) => {
    void host.handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    host,
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    /** @param {string} path @param {Record<string, any>} [opts] */
    request(path, opts = {}) {
      return httpRequest({ port, path, ...opts })
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await host.dispose()
    },
  }
}

/**
 * Minimal promise-based HTTP client used by the tests.
 * @param {{port:number, path?:string, method?:string, headers?:Record<string,string>,
 *          body?:any, rawBody?:Buffer|string}} options
 */
export function httpRequest(options) {
  const {
    port,
    path = '/',
    method = 'GET',
    headers = {},
    body,
    rawBody,
  } = options
  return new Promise((resolve, reject) => {
    /** @type {Record<string,string>} */
    const finalHeaders = { ...headers }
    let payload
    if (rawBody !== undefined) {
      payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody))
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body))
      if (!hasHeader(finalHeaders, 'content-type')) finalHeaders['content-type'] = 'application/json'
    }
    if (payload) finalHeaders['content-length'] = String(payload.length)

    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: finalHeaders },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          const text = buffer.toString('utf8')
          let json = null
          if (String(res.headers['content-type'] || '').includes('application/json')) {
            try {
              json = JSON.parse(text)
            } catch {
              json = null
            }
          }
          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            headers: res.headers,
            text,
            buffer,
            json,
          })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** @param {Record<string,string>} headers @param {string} name */
function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name)
}

/** In-memory ServerResponse double for handler-level fence tests. */
export function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = { ...(headers || {}) }
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      }
      this.writableEnded = true
    },
  }
}

/**
 * Invoke the host handler with a fake request/response pair (for fence tests
 * that cannot be triggered through a real loopback socket).
 * @param {ReturnType<typeof createCortexHost>} host
 * @param {{method?:string, url?:string, headers?:Record<string,string>, socket?:{remoteAddress:string}}} req
 */
export async function invokeFake(host, req) {
  const res = fakeResponse()
  await host.handler(
    {
      method: req.method ?? 'GET',
      url: req.url ?? '/cortex-api/health',
      headers: req.headers ?? {},
      socket: req.socket ?? { remoteAddress: '127.0.0.1' },
    },
    res,
  )
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { res, json }
}
