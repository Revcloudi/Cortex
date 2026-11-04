import type { ZodError, ZodIssue } from 'zod'

/**
 * Agent-facing validation guidance for MCP tool input.
 *
 * Validation failures are a normal part of agent use: the model often guesses
 * the shape of a nested field. A bare "Invalid input" costs several tool calls
 * of trial and error, so every error names the offending path, explains the
 * expected type, shows a correct example and points at the matching skill.
 */

const TOOL_EXAMPLES: Record<string, string> = {
  save_vulnerability: `{
  "host": "probe.example.com",
  "vuln_name": "登录接口未授权访问",
  "severity": "High",
  "target_url": "https://probe.example.com/api/login",
  "affected_interfaces": ["POST /api/login"],
  "description": "未登录即可读取用户信息",
  "reproduction_steps": "### 步骤 1\\n发送 GET /api/user/1 ..."
}`,
  sync_asset_info: `{
  "host_port": "https://probe.example.com",
  "project_name": "Example SRC",
  "interfaces": [
    {
      "path": "/api/login",
      "method": "POST",
      "params": "username=admin&next=/home",
      "request": "POST /api/login HTTP/1.1\\nHost: probe.example.com\\n..."
    }
  ],
  "leaked_infos": [
    {
      "info_type": "Token",
      "value": "eyJ...",
      "source": "GET /api/login response body",
      "potential_impact": "可伪造会话"
    }
  ]
}`,
  manage_snapshot: `{
  "action": "save",
  "payload": {
    "project_name": "Example SRC",
    "target_hosts": ["probe.example.com:443"],
    "current_phase": "登录接口测试中",
    "unfinished_tasks": ["继续测试 IDOR"],
    "failed_paths": [],
    "tested_interfaces": [],
    "notes": "",
    "related_vuln_ids": [],
    "next_steps": "继续测试 IDOR"
  }
}`,
  query_vulnerabilities: `{ "host": "probe.example.com" } 或 { "vuln_id": "VULN-..." } 或 { "search": "登录", "realm": "internal" }`,
  query_asset_context: `{ "host_port": "https://probe.example.com", "include_internal": true } 或 { "project_name": "Example SRC", "include_internal": true, "include_credentials": true }`,
  update_vulnerability: `{ "vuln_id": "VULN-...", "status": "Retest_Passed" } 或 { "vuln_id": "VULN-...", "retest": { "time_range": "2026-11-02", "conclusion": "已修复" } }`,
  sync_internal_scope: `{
  "project_name": "Starport Portal 物流客户门户靶场",
  "mode": "merge",
  "footholds": [
    {
      "entry_host_port": "http://127.0.0.1:8080/",
      "entry_vuln_id": "VULN-20261102-008",
      "access_type": "rce",
      "privilege_level": "admin",
      "status": "established",
      "host_ids": ["IH-3F9A2C71B4D0"]
    }
  ],
  "hosts": [
    { "ip": "10.0.1.10", "hostname": "jump", "os": "linux", "subnet": "10.0.1.0/24", "state": "compromised", "source": "agent" }
  ],
  "services": [
    { "host_id": "IH-3F9A2C71B4D0", "port": 22, "protocol": "tcp", "service": "ssh", "state": "open" }
  ]
}`
}

const FIELD_HINTS: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /(^|\.)host$/,
    hint: 'host 接受 host 或 host:port（如 "probe.example.com" 或 "probe.example.com:443"）；不要带协议头/路径。'
  },
  {
    pattern: /(^|\.)interfaces(\[\])?$/,
    hint: 'interfaces 是对象数组，每项至少 { "path": "/api/login" }，可带 method / params / request。'
  },
  {
    pattern: /(^|\.)interfaces\[\]\.params$/,
    hint: 'interfaces[].params 是字符串（如 "username=admin&next=/home"），不是数组或对象；完整报文放 interfaces[].request。'
  },
  {
    pattern: /(^|\.)interfaces\[\]\.request$/,
    hint: 'interfaces[].request 是完整原始 HTTP 报文（请求行 + headers + 可选 body）的字符串。'
  },
  {
    pattern: /(^|\.)leaked_infos(\[\])?$/,
    hint: 'leaked_infos 的字段是 info_type / value / source / potential_impact；不要用 type / content。'
  },
  {
    pattern: /(^|\.)test_parameters(\[\])?$/,
    hint: 'test_parameters 每项形如 { "name": "id", "endpoint": "GET /api/users/{id}", "location": "path", "values": ["1"], "source": "response JSON" }。'
  },
  {
    pattern: /(^|\.)payload$/,
    hint: 'manage_snapshot 的 payload 是九个字段对象：project_name / target_hosts / current_phase / unfinished_tasks / failed_paths / tested_interfaces / notes / related_vuln_ids / next_steps。'
  },
  {
    pattern: /(^|\.)reproduction_steps$/,
    hint: 'reproduction_steps 是 Markdown 字符串（### 步骤 N、**请求**、**响应**、**判据** + http 代码块）。'
  },
  {
    pattern: /(^|\.)affected_interfaces$/,
    hint: 'affected_interfaces 是字符串数组，例如 ["POST /api/login"]。'
  },
  {
    pattern: /(^|\.)remediation$/,
    hint: 'remediation 是字符串数组，例如 ["增加服务端鉴权"]。'
  },
  {
    pattern: /(^|\.)entry_host_port$/,
    hint: 'entry_host_port 是入口 Web 资产的 assets.host_port（完整 URL，如 "http://10.0.0.5:8080/"），不是内网 IP、不是 host:port。'
  },
  {
    pattern: /(^|\.)access_type$/,
    hint: 'access_type 枚举：rce | webshell | ssrf_proxy | credential | vpn | other。'
  },
  {
    pattern: /(^|\.)privilege_level$/,
    hint: 'privilege_level 枚举：user | admin | system | domain_admin | unknown。'
  },
  {
    pattern: /(^|\.)status$/,
    hint: 'status 取值随实体而定：漏洞用 Confirmed | Inconclusive | Retest_Passed；foothold/pivot 用 planned | established | degraded | lost；主机状态用 state（unknown | alive | compromised | unreachable | firewalled）。'
  },
  {
    pattern: /(^|\.)host_id$/,
    hint: 'host_id 必须是 hosts[] 中某个主机的 id（IH-...）；服务登记前先 sync hosts，再引用返回的 ids.hosts。'
  },
  {
    pattern: /(^|\.)foothold_id$/,
    hint: 'foothold_id 必须是 footholds[] 中某个 foothold 的 id（FH-...）；先 sync footholds 再登记 pivots。'
  },
  {
    pattern: /(^|\.)ip$/,
    hint: 'hosts[].ip 必须是合法 IPv4 / IPv6 字面量（如 "10.0.1.10"），不能写 CIDR、URL、host:port 或主机名；网段写 subnet（如 "10.0.1.0/24"）。'
  },
  {
    pattern: /(^|\.)port$/,
    hint: 'services[].port 是 1-65535 的整数（number，不是字符串）；service_host 里的 "ip:port" 才是字符串。'
  },
  {
    pattern: /(^|\.)hops(\[\])?$/,
    hint: 'hops 是数组，每项 { "ref_kind": "internal_host" | "internal_service", "ref_id": "IH-...", "label": "...", "via": "ssh:22" }。'
  },
  {
    pattern: /(^|\.)entry_vuln_id$/,
    hint: 'entry_vuln_id 是已在漏洞库登记的入口漏洞 ID（VULN-...），保存入口 RCE 后再登记 foothold。'
  }
]

function pathPart(part: PropertyKey): string | number {
  return typeof part === 'symbol' ? (part.description ?? String(part)) : part
}

function normalizePath(path: readonly PropertyKey[]): string {
  let result = ''
  for (const raw of path) {
    const part = pathPart(raw)
    if (typeof part === 'number') result += '[]'
    else result += result.length === 0 ? part : `.${part}`
  }
  return result
}

function readPath(value: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = value
  for (const raw of path) {
    const part = pathPart(raw)
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[part]
    } else {
      if (typeof current !== 'object' || current === null) return undefined
      current = (current as Record<string, unknown>)[part]
    }
  }
  return current
}

function describeType(value: unknown): string {
  if (value === undefined) return '缺失（undefined）'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组(${value.length} 项)`
  return typeof value
}

function issueHint(issue: ZodIssue): string | undefined {
  const path = normalizePath(issue.path)
  const direct = FIELD_HINTS.find((entry) => entry.pattern.test(path))
  if (direct !== undefined) return direct.hint
  return undefined
}

function formatIssue(issue: ZodIssue, args: unknown): string {
  const path = normalizePath(issue.path) || '(顶层参数)'
  const received = describeType(readPath(args, issue.path))
  const lines = [`- ${path}: ${issue.message}（收到 ${received}）`]
  const hint = issueHint(issue)
  if (hint !== undefined) lines.push(`  正确写法: ${hint}`)

  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as ZodIssue & { keys?: string[] }).keys ?? []
    if (keys.includes('type') || keys.includes('content')) {
      lines.push('  字段名提示: leaked_infos 使用 info_type / value，而不是 type / content。')
    }
  }
  return lines.join('\n')
}

/** Build the actionable text returned by a failing MCP tool call. */
export function formatMcpInputError(
  toolName: string,
  error: ZodError,
  args: unknown
): string {
  const issues = error.issues.slice(0, 8).map((issue) => formatIssue(issue, args))
  if (error.issues.length > 8) {
    issues.push(`- ……另有 ${error.issues.length - 8} 个字段校验错误`)
  }
  const example = TOOL_EXAMPLES[toolName]
  return [
    `参数校验失败（${toolName}）:`,
    ...issues,
    '',
    ...(example === undefined ? [] : ['正确调用示例:', example, '']),
    '提示: 字段规范见对应 skill（vuln-db / asset-context / snapshot / internal-ops）；先按示例修正后再重试。'
  ].join('\n')
}
