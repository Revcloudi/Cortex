import {
  MEMORY_GRAPH_DEFAULT_LIMITS,
  countNodeTypes,
  type HostNode,
  type LeakNode,
  type MemoryGraphData,
  type MemoryGraphMeta,
  type MemoryGraphScope,
  type NebulaLink,
  type NebulaNode,
  type SnapshotNode,
  type VulnNode
} from '@shared/graph'

/**
 * P1 mock graph — retained as an offline fixture/demo dataset only.
 *
 * P2 no longer renders it: `NebulaPage` now reads the real projection from
 * `buildMemoryGraph` through `getApi().getMemoryGraph(...)`. The fixture stays
 * useful for screenshots without a database and as a shape reference for the
 * real builder (same `MemoryGraphData` contract).
 *
 *   4 hosts (one orphan cluster), 9 vulns, 6 leaks, 4 snapshots, 26 links.
 *
 * Scope projections:
 *   - all:   every node + every directly stored link.
 *   - asset: one host + its vulns/leaks + snapshots that touched it, plus one
 *            hop of `related_vuln_ids`.
 *   - task:  one snapshot + its target hosts + their vulns/leaks + explicit
 *            `related_vuln_ids`, plus dashed `TASK_TOUCHED_HOST` fallback links
 *            for vulns on those hosts that the snapshot never linked explicitly.
 */

/** Mock target for the "current asset" scope (a stored host_port value). */
export const MOCK_ASSET_SCOPE_HOST_ID = '10.0.0.5:8080'
/** Mock target for the "current task" scope (a stored session_id value). */
export const MOCK_TASK_SCOPE_SNAPSHOT_ID = 'SESS-20261102-001'
export const MOCK_GENERATED_AT = '2026-11-02T11:40:00+08:00'

/* ------------------------------------------------------------------- nodes -- */

const HOST_NODES: HostNode[] = [
  {
    id: 'h1',
    type: 'host',
    name: '10.0.0.5:8080',
    host: '10.0.0.5:8080',
    project: 'Example SRC',
    val: 24,
    data: {
      host_port: '10.0.0.5:8080',
      host: '10.0.0.5',
      project_name: 'Example SRC',
      tech_stack: 'Vue 3, Spring Boot, Nginx, MySQL',
      status: 'Alive',
      interface_count: 42,
      leaked_count: 3,
      last_seen: '2026-11-02 09:14',
      test_parameters: ['id', 'orderId', 'tenantId', 'redirectUrl'],
      interfaces: ['/api/login', '/api/report/list', '/api/user/{id}', '/actuator/env']
    }
  },
  {
    id: 'h2',
    type: 'host',
    name: 'api.example.com:443',
    host: 'api.example.com:443',
    project: 'Example SRC',
    val: 20,
    data: {
      host_port: 'api.example.com:443',
      host: 'api.example.com',
      project_name: 'Example SRC',
      tech_stack: 'Next.js, Node.js, Cloudflare',
      status: 'Alive',
      interface_count: 28,
      leaked_count: 2,
      last_seen: '2026-11-02 10:02',
      test_parameters: ['userId', 'workspaceId', 'cursor'],
      interfaces: ['/api/auth/login', '/api/admin/users', '/api/billing/invoices']
    }
  },
  {
    id: 'h3',
    type: 'host',
    name: '192.168.1.10:8443',
    host: '192.168.1.10:8443',
    project: 'Example SRC',
    val: 16,
    data: {
      host_port: '192.168.1.10:8443',
      host: '192.168.1.10',
      project_name: 'Example SRC',
      tech_stack: 'Laravel 10, MySQL, Nginx',
      status: 'WAF_Blocked',
      interface_count: 16,
      leaked_count: 1,
      last_seen: '2026-11-01 18:37',
      test_parameters: ['ticketId', 'status', 'page'],
      interfaces: ['/login', '/tickets/{id}', '/storage/logs/laravel.log']
    }
  },
  {
    id: 'h4',
    type: 'host',
    name: 'orphan.example.com',
    host: 'orphan.example.com',
    project: 'Old Project',
    val: 8,
    data: {
      host_port: 'orphan.example.com',
      host: 'orphan.example.com',
      project_name: 'Old Project',
      tech_stack: 'WordPress 6.4, PHP 8.1',
      status: 'Dead',
      interface_count: 4,
      leaked_count: 0,
      last_seen: '2025-10-19 22:11',
      test_parameters: [],
      interfaces: ['/', '/wp-login.php']
    }
  }
]

const VULN_NODES: VulnNode[] = [
  {
    id: 'v1',
    type: 'vuln',
    name: 'AJ-Report 默认口令 + 远程代码执行',
    host: '10.0.0.5:8080',
    project: 'Example SRC',
    severity: 'Critical',
    status: 'Confirmed',
    val: 16,
    data: {
      vuln_id: 'VULN-20261102-001',
      vuln_name: 'AJ-Report 默认口令 + 远程代码执行',
      vuln_type: 'Remote Code Execution',
      severity: 'Critical',
      status: 'Confirmed',
      host: '10.0.0.5:8080',
      target_url: 'https://10.0.0.5:8080/login',
      created_at: '2026-11-02 08:41',
      reproduction_steps:
        '### 步骤 1\n访问 `/login`，使用默认口令 `admin:123456` 登录成功。\n\n### 步骤 2\n在数据源管理页面提交 `jdbc:mysql://...`，触发 JDBC 反序列化。\n\n### 步骤 3\n请求 `/dataSetParam/verification` 回显 `whoami`，返回 `root`。\n\n**判据**：响应体包含命令执行结果，且 /tmp 目录出现验证文件。',
      related_vuln_ids: ['VULN-20261102-002']
    }
  },
  {
    id: 'v2',
    type: 'vuln',
    name: '报表接口 SQL 注入',
    host: '10.0.0.5:8080',
    project: 'Example SRC',
    severity: 'High',
    status: 'Confirmed',
    val: 13,
    data: {
      vuln_id: 'VULN-20261102-002',
      vuln_name: '报表接口 SQL 注入',
      vuln_type: 'SQL Injection',
      severity: 'High',
      status: 'Confirmed',
      host: '10.0.0.5:8080',
      target_url: 'https://10.0.0.5:8080/api/report/list?orderBy=create_time',
      created_at: '2026-11-02 09:02',
      reproduction_steps:
        '### 步骤 1\n`GET /api/report/list?orderBy=create_time` 正常返回 200。\n\n### 步骤 2\n将 `orderBy` 替换为 `create_time,(select sleep(5))`，响应延迟 5.2s。\n\n**判据**：布尔与时间盲注均可稳定复现，数据库账号为只读 `report_ro`。',
      related_vuln_ids: ['VULN-20261102-001', 'VULN-20261102-003']
    }
  },
  {
    id: 'v3',
    type: 'vuln',
    name: '用户资料越权读取（IDOR）',
    host: '10.0.0.5:8080',
    project: 'Example SRC',
    severity: 'Medium',
    status: 'Inconclusive',
    val: 10,
    data: {
      vuln_id: 'VULN-20261102-003',
      vuln_name: '用户资料越权读取（IDOR）',
      vuln_type: 'IDOR',
      severity: 'Medium',
      status: 'Inconclusive',
      host: '10.0.0.5:8080',
      target_url: 'https://10.0.0.5:8080/api/user/1024',
      created_at: '2026-11-02 10:16',
      reproduction_steps:
        '### 步骤 1\n普通账号登录后请求 `/api/user/{id}`，自身 id 返回 200。\n\n### 步骤 2\n改为相邻 id 后返回其他用户手机号后四位，但完整字段被接口脱敏。\n\n**判据**：可越权读取部分字段，影响面待与开发确认后定级。',
      related_vuln_ids: ['VULN-20261102-002']
    }
  },
  {
    id: 'v4',
    type: 'vuln',
    name: 'JWT 签名密钥硬编码',
    host: 'api.example.com:443',
    project: 'Example SRC',
    severity: 'High',
    status: 'Confirmed',
    val: 13,
    data: {
      vuln_id: 'VULN-20261102-004',
      vuln_name: 'JWT 签名密钥硬编码',
      vuln_type: 'Hardcoded Secret',
      severity: 'High',
      status: 'Confirmed',
      host: 'api.example.com:443',
      target_url: 'https://api.example.com/static/main.7fa3.js',
      created_at: '2026-11-02 09:31',
      reproduction_steps:
        '### 步骤 1\n下载 `main.7fa3.js`，全局搜索 `sign(` 找到打包进前端的密钥常量。\n\n### 步骤 2\n用该密钥签发 `sub=admin` 的 JWT，携带后请求 `/api/admin/users` 返回 200。\n\n**判据**：自签 token 被服务端接受，构成任意身份伪造。',
      related_vuln_ids: []
    }
  },
  {
    id: 'v5',
    type: 'vuln',
    name: 'CORS 反射任意 Origin',
    host: 'api.example.com:443',
    project: 'Example SRC',
    severity: 'Medium',
    status: 'Confirmed',
    val: 10,
    data: {
      vuln_id: 'VULN-20261102-005',
      vuln_name: 'CORS 反射任意 Origin',
      vuln_type: 'Misconfiguration',
      severity: 'Medium',
      status: 'Confirmed',
      host: 'api.example.com:443',
      target_url: 'https://api.example.com/api/auth/login',
      created_at: '2026-11-02 09:47',
      reproduction_steps:
        '### 步骤 1\n携带 `Origin: https://evil.example` 请求登录接口。\n\n### 步骤 2\n响应回显 `Access-Control-Allow-Origin: https://evil.example` 且 `Allow-Credentials: true`。\n\n**判据**：任意源可携带 Cookie 读取响应。',
      related_vuln_ids: []
    }
  },
  {
    id: 'v6',
    type: 'vuln',
    name: '静态目录列表未关闭',
    host: 'api.example.com:443',
    project: 'Example SRC',
    severity: 'Low',
    status: 'Confirmed',
    val: 7,
    data: {
      vuln_id: 'VULN-20261102-006',
      vuln_name: '静态目录列表未关闭',
      vuln_type: 'Information Disclosure',
      severity: 'Low',
      status: 'Confirmed',
      host: 'api.example.com:443',
      target_url: 'https://api.example.com/static/',
      created_at: '2026-11-02 09:55',
      reproduction_steps:
        '### 步骤 1\n访问 `/static/` 返回目录索引，暴露历史版本 bundle。\n\n**判据**：目录可枚举，且包含旧版本 sourcemap。',
      related_vuln_ids: []
    }
  },
  {
    id: 'v7',
    type: 'vuln',
    name: 'Laravel 调试模式泄露敏感配置',
    host: '192.168.1.10:8443',
    project: 'Example SRC',
    severity: 'Critical',
    status: 'Confirmed',
    val: 16,
    data: {
      vuln_id: 'VULN-20261106-001',
      vuln_name: 'Laravel 调试模式泄露敏感配置',
      vuln_type: 'Information Disclosure',
      severity: 'Critical',
      status: 'Confirmed',
      host: '192.168.1.10:8443',
      target_url: 'https://192.168.1.10:8443/login',
      created_at: '2026-11-01 17:12',
      reproduction_steps:
        '### 步骤 1\n访问 `/login` 并触发异常，`APP_DEBUG=true` 返回完整 Ignition 页面。\n\n### 步骤 2\n页面泄露 `.env` 关键项：数据库账号、`APP_KEY`、Redis 密码。\n\n**判据**：可读取真实凭据，直接扩大攻击面。',
      related_vuln_ids: ['VULN-20261106-002']
    }
  },
  {
    id: 'v8',
    type: 'vuln',
    name: '工单详情存储型 XSS',
    host: '192.168.1.10:8443',
    project: 'Example SRC',
    severity: 'High',
    status: 'Confirmed',
    val: 13,
    data: {
      vuln_id: 'VULN-20261106-002',
      vuln_name: '工单详情存储型 XSS',
      vuln_type: 'Stored XSS',
      severity: 'High',
      status: 'Confirmed',
      host: '192.168.1.10:8443',
      target_url: 'https://192.168.1.10:8443/tickets/8821',
      created_at: '2026-11-01 18:02',
      reproduction_steps:
        '### 步骤 1\n新建工单，将 `<img src=x onerror=alert(document.domain)>` 写入富文本描述。\n\n### 步骤 2\n客服账号打开工单详情即触发脚本。\n\n**判据**：脚本在客服会话上下文中执行，可读取后台页面数据。',
      related_vuln_ids: ['VULN-20261106-001']
    }
  },
  {
    id: 'v9',
    type: 'vuln',
    name: 'HTTPS 证书已过期',
    host: 'orphan.example.com',
    project: 'Old Project',
    severity: 'Info',
    status: 'Inconclusive',
    val: 5,
    data: {
      vuln_id: 'VULN-20251020-001',
      vuln_name: 'HTTPS 证书已过期',
      vuln_type: 'TLS Misconfiguration',
      severity: 'Info',
      status: 'Inconclusive',
      host: 'orphan.example.com',
      target_url: 'https://orphan.example.com/',
      created_at: '2025-10-19 22:20',
      reproduction_steps:
        '### 步骤 1\n浏览器访问提示证书已过期 312 天。\n\n**判据**：域名停放页，无业务功能，仅留档。',
      related_vuln_ids: []
    }
  }
]

const LEAK_NODES: LeakNode[] = [
  {
    id: 'l1',
    type: 'leak',
    name: 'DB_Password',
    host: '10.0.0.5:8080',
    project: 'Example SRC',
    val: 8,
    data: {
      info_type: 'Credential',
      value: 'postgres:Str0ngP@ssw0rd!',
      source: 'GET /api/config 响应体（未鉴权）',
      potential_impact: '可直连业务数据库，读取全量报表与用户数据。',
      host: '10.0.0.5:8080'
    }
  },
  {
    id: 'l2',
    type: 'leak',
    name: 'admin_access_token',
    host: '10.0.0.5:8080',
    project: 'Example SRC',
    val: 7,
    data: {
      info_type: 'Token',
      value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJTVVBFUl9BRE1JTiJ9.7f3c…',
      source: 'localStorage.access_token（登录后写入）',
      potential_impact: '管理员会话可被复用，直接接管后台。',
      host: '10.0.0.5:8080'
    }
  },
  {
    id: 'l3',
    type: 'leak',
    name: 'Internal_IPs',
    host: '10.0.0.5:8080',
    project: 'Example SRC',
    val: 6,
    data: {
      info_type: 'Internal_IP',
      value: '10.0.0.5, 10.0.0.12, 10.0.0.23, 10.0.1.0/24',
      source: 'GET /actuator/env（未鉴权）',
      potential_impact: '内网拓扑与网段暴露，可横向定位数据库与 Redis。',
      host: '10.0.0.5:8080'
    }
  },
  {
    id: 'l4',
    type: 'leak',
    name: 'Billing_API_Key',
    host: 'api.example.com:443',
    project: 'Example SRC',
    val: 8,
    data: {
      info_type: 'API_Key',
      value: 'sk-live-4f2c8a91d7b3e6f0a2c5d8e1',
      source: '前端 bundle main.7fa3.js 内联常量',
      potential_impact: '可调用第三方计费接口，造成费用损失或数据篡改。',
      host: 'api.example.com:443'
    }
  },
  {
    id: 'l5',
    type: 'leak',
    name: 'Admin_PII',
    host: 'api.example.com:443',
    project: 'Example SRC',
    val: 7,
    data: {
      info_type: 'PII',
      value: '+86 138****2210 / ops@example.com（共 128 条）',
      source: 'GET /api/admin/users 未授权响应',
      potential_impact: '管理员个人信息批量泄露，且接口无鉴权可继续翻页。',
      host: 'api.example.com:443'
    }
  },
  {
    id: 'l6',
    type: 'leak',
    name: 'Log_Paths',
    host: '192.168.1.10:8443',
    project: 'Example SRC',
    val: 6,
    data: {
      info_type: 'Other',
      value: '/srv/app/storage/logs/laravel-2026-11-01.log',
      source: 'Laravel Ignition 异常页堆栈',
      potential_impact: '日志路径与框架结构暴露，为后续 LFI / 日志投毒提供入口。',
      host: '192.168.1.10:8443'
    }
  }
]

const SNAPSHOT_NODES: SnapshotNode[] = [
  {
    id: 's1',
    type: 'snapshot',
    name: 'Example SRC / 登录接口测试',
    project: 'Example SRC',
    val: 18,
    data: {
      session_id: 'SESS-20261102-001',
      project_name: 'Example SRC',
      current_phase: '登录接口测试中',
      target_hosts: ['10.0.0.5:8080', 'api.example.com:443'],
      related_vuln_ids: ['VULN-20261102-001'],
      parent_session_id: null,
      unfinished_tasks: ['验证 /api/user/{id} 越权范围', '补充 SQL 注入 WAF 绕过测试'],
      next_steps: '继续测试 IDOR 与文件上传；确认 JWT 密钥是否可伪造管理员。',
      updated_at: '2026-11-02 11:40'
    }
  },
  {
    id: 's2',
    type: 'snapshot',
    name: 'Example SRC / 工单系统',
    project: 'Example SRC',
    val: 16,
    data: {
      session_id: 'SESS-20261101-002',
      project_name: 'Example SRC',
      current_phase: '工单系统收尾',
      target_hosts: ['192.168.1.10:8443'],
      related_vuln_ids: ['VULN-20261106-001'],
      parent_session_id: null,
      unfinished_tasks: ['等待开发确认 XSS 修复方式'],
      next_steps: '导出 Ignition 泄露的配置项作为证据，整理报告。',
      updated_at: '2026-11-01 19:05'
    }
  },
  {
    id: 's3',
    type: 'snapshot',
    name: 'Example SRC / 收尾',
    project: 'Example SRC',
    val: 13,
    data: {
      session_id: 'SESS-20261102-003',
      project_name: 'Example SRC',
      current_phase: '报告整理',
      target_hosts: ['10.0.0.5:8080', 'api.example.com:443'],
      related_vuln_ids: [],
      parent_session_id: 'SESS-20261102-001',
      unfinished_tasks: [],
      next_steps: '补充复现步骤截图，等待开发确认修复计划。',
      updated_at: '2026-11-02 11:52'
    }
  },
  {
    id: 's4',
    type: 'snapshot',
    name: '旧项目归档',
    project: 'Old Project',
    val: 8,
    data: {
      session_id: 'SESS-20251019-004',
      project_name: 'Old Project',
      current_phase: '已归档',
      target_hosts: ['api.example.com:443'],
      related_vuln_ids: [],
      parent_session_id: null,
      unfinished_tasks: [],
      next_steps: '无；域名已停放，仅保留历史记录。',
      updated_at: '2025-10-19 22:30'
    }
  }
]

const ALL_NODES: NebulaNode[] = [
  ...HOST_NODES,
  ...VULN_NODES,
  ...LEAK_NODES,
  ...SNAPSHOT_NODES
]

/* ------------------------------------------------------------------- links -- */

const LINKS: NebulaLink[] = [
  // Host → Vuln (9)
  { source: 'h1', target: 'v1', relation: 'HAS_VULN' },
  { source: 'h1', target: 'v2', relation: 'HAS_VULN' },
  { source: 'h1', target: 'v3', relation: 'HAS_VULN' },
  { source: 'h2', target: 'v4', relation: 'HAS_VULN' },
  { source: 'h2', target: 'v5', relation: 'HAS_VULN' },
  { source: 'h2', target: 'v6', relation: 'HAS_VULN' },
  { source: 'h3', target: 'v7', relation: 'HAS_VULN' },
  { source: 'h3', target: 'v8', relation: 'HAS_VULN' },
  { source: 'h4', target: 'v9', relation: 'HAS_VULN' },

  // Host → Leak (6)
  { source: 'h1', target: 'l1', relation: 'LEAKED' },
  { source: 'h1', target: 'l2', relation: 'LEAKED' },
  { source: 'h1', target: 'l3', relation: 'LEAKED' },
  { source: 'h2', target: 'l4', relation: 'LEAKED' },
  { source: 'h2', target: 'l5', relation: 'LEAKED' },
  { source: 'h3', target: 'l6', relation: 'LEAKED' },

  // Vuln ↔ Vuln (3, from related_vuln_ids)
  { source: 'v1', target: 'v2', relation: 'RELATED_VULN' },
  { source: 'v2', target: 'v3', relation: 'RELATED_VULN' },
  { source: 'v7', target: 'v8', relation: 'RELATED_VULN' },

  // Snapshot → target host (6, derived by host_port matching)
  { source: 's1', target: 'h1', relation: 'SNAPSHOT_TARGETS', derived: true },
  { source: 's1', target: 'h2', relation: 'SNAPSHOT_TARGETS', derived: true },
  { source: 's2', target: 'h3', relation: 'SNAPSHOT_TARGETS', derived: true },
  { source: 's3', target: 'h1', relation: 'SNAPSHOT_TARGETS', derived: true },
  { source: 's3', target: 'h2', relation: 'SNAPSHOT_TARGETS', derived: true },
  { source: 's4', target: 'h2', relation: 'SNAPSHOT_TARGETS', derived: true },

  // Snapshot → explicitly linked vuln (2, from related_vuln_ids)
  { source: 's1', target: 'v1', relation: 'SNAPSHOT_VULN' },
  { source: 's2', target: 'v7', relation: 'SNAPSHOT_VULN' }
]

/* ------------------------------------------------------------------- indexes -- */

const HOSTS_BY_HOST_PORT = new Map(
  HOST_NODES.map((node) => [node.data.host_port, node] as const)
)
const VULNS_BY_VULN_ID = new Map(VULN_NODES.map((node) => [node.data.vuln_id, node] as const))
const VULNS_BY_HOST = new Map<string, VulnNode[]>()
const LEAKS_BY_HOST = new Map<string, LeakNode[]>()
const SNAPSHOTS_BY_HOST = new Map<string, SnapshotNode[]>()

for (const node of VULN_NODES) {
  const bucket = VULNS_BY_HOST.get(node.host) ?? []
  bucket.push(node)
  VULNS_BY_HOST.set(node.host, bucket)
}
for (const node of LEAK_NODES) {
  const bucket = LEAKS_BY_HOST.get(node.host) ?? []
  bucket.push(node)
  LEAKS_BY_HOST.set(node.host, bucket)
}
for (const node of SNAPSHOT_NODES) {
  for (const hostPort of node.data.target_hosts) {
    if (!HOSTS_BY_HOST_PORT.has(hostPort)) continue
    const bucket = SNAPSHOTS_BY_HOST.get(hostPort) ?? []
    bucket.push(node)
    SNAPSHOTS_BY_HOST.set(hostPort, bucket)
  }
}

/* --------------------------------------------------------------- projection -- */

function buildMeta(scope: MemoryGraphScope, nodes: NebulaNode[], extra: Partial<MemoryGraphMeta> = {}): MemoryGraphMeta {
  return {
    scope,
    counts: countNodeTypes(nodes),
    truncated: false,
    limits: MEMORY_GRAPH_DEFAULT_LIMITS,
    generatedAt: MOCK_GENERATED_AT,
    unresolvedTargets: [],
    ...extra
  }
}

function project(scope: MemoryGraphScope, nodeIds: Set<string>): MemoryGraphData {
  const nodes = ALL_NODES.filter((node) => nodeIds.has(node.id))
  const links = LINKS.filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target))
  return { nodes, links, meta: buildMeta(scope, nodes) }
}

function allGraph(): MemoryGraphData {
  const nodes = [...ALL_NODES]
  return {
    nodes,
    links: [...LINKS],
    meta: buildMeta({ kind: 'all' }, nodes)
  }
}

function assetGraph(hostPort: string): MemoryGraphData {
  const host = HOST_NODES.find((node) => node.data.host_port === hostPort)
  if (!host) {
    return { nodes: [], links: [], meta: buildMeta({ kind: 'asset', hostPort }, []) }
  }
  const ids = new Set<string>([host.id])
  const hostVulns = VULNS_BY_HOST.get(host.data.host_port) ?? []
  for (const vuln of hostVulns) ids.add(vuln.id)
  for (const leak of LEAKS_BY_HOST.get(host.data.host_port) ?? []) ids.add(leak.id)
  for (const snapshot of SNAPSHOTS_BY_HOST.get(host.data.host_port) ?? []) ids.add(snapshot.id)
  // One hop of explicitly related vulns, regardless of their host.
  for (const vuln of hostVulns) {
    for (const relatedVulnId of vuln.data.related_vuln_ids) {
      const related = VULNS_BY_VULN_ID.get(relatedVulnId)
      if (related) ids.add(related.id)
    }
  }
  return project({ kind: 'asset', hostPort }, ids)
}

function taskGraph(sessionId: string): MemoryGraphData {
  const snapshot = SNAPSHOT_NODES.find((node) => node.data.session_id === sessionId)
  if (!snapshot) {
    return { nodes: [], links: [], meta: buildMeta({ kind: 'task', sessionId }, []) }
  }
  const ids = new Set<string>([snapshot.id])
  const unresolvedTargets: string[] = []
  const targetVulns: VulnNode[] = []

  for (const hostPort of snapshot.data.target_hosts) {
    const host = HOSTS_BY_HOST_PORT.get(hostPort)
    if (!host) {
      unresolvedTargets.push(hostPort)
      continue
    }
    ids.add(host.id)
    const vulns = VULNS_BY_HOST.get(hostPort) ?? []
    for (const vuln of vulns) {
      ids.add(vuln.id)
      targetVulns.push(vuln)
    }
    for (const leak of LEAKS_BY_HOST.get(hostPort) ?? []) ids.add(leak.id)
  }

  // Explicitly related vulns may live on any host.
  for (const vulnId of snapshot.data.related_vuln_ids) {
    const vuln = VULNS_BY_VULN_ID.get(vulnId)
    if (vuln) {
      ids.add(vuln.id)
      if (!targetVulns.includes(vuln)) targetVulns.push(vuln)
    }
  }

  // One hop of related vulns for everything already in scope.
  for (const vuln of targetVulns) {
    for (const relatedVulnId of vuln.data.related_vuln_ids) {
      const related = VULNS_BY_VULN_ID.get(relatedVulnId)
      if (related) ids.add(related.id)
    }
  }

  const base = project({ kind: 'task', sessionId }, ids)
  const explicitVulnIds = new Set(
    snapshot.data.related_vuln_ids
      .map((vulnId) => VULNS_BY_VULN_ID.get(vulnId)?.id)
      .filter((id): id is string => id !== undefined)
  )
  // P2 fallback: the snapshot touched these hosts, so their vulns are related
  // even without an explicit `related_vuln_ids` entry. Dashed + fainter.
  const derivedLinks: NebulaLink[] = base.nodes
    .filter((node): node is VulnNode => node.type === 'vuln')
    .filter((node) => !explicitVulnIds.has(node.id))
    .filter((node) => base.nodes.some((host) => host.type === 'host' && host.host === node.host))
    .map((node) => ({
      source: snapshot.id,
      target: node.id,
      relation: 'TASK_TOUCHED_HOST' as const,
      derived: true
    }))

  return {
    nodes: base.nodes,
    links: [...base.links, ...derivedLinks],
    meta: buildMeta({ kind: 'task', sessionId }, base.nodes, { unresolvedTargets })
  }
}

/**
 * P1 fixture data source, kept for offline demos. The live page uses
 * `buildMemoryGraph` (via `getApi().getMemoryGraph`) instead.
 */
export function mockGraph(scope: MemoryGraphScope): MemoryGraphData {
  switch (scope.kind) {
    case 'all':
      return allGraph()
    case 'asset':
      return assetGraph(scope.hostPort)
    case 'task':
      return taskGraph(scope.sessionId)
  }
}
