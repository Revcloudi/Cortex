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
  query_vulnerabilities: `{ "host": "probe.example.com" } 或 { "vuln_id": "VULN-..." } 或 { "search": "登录" }`,
  query_asset_context: `{ "host_port": "https://probe.example.com" } 或 { "project_name": "Example SRC" }`,
  update_vulnerability: `{ "vuln_id": "VULN-...", "status": "Retest_Passed" } 或 { "vuln_id": "VULN-...", "retest": { "time_range": "2026-11-02", "conclusion": "已修复" } }`
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
    '提示: 字段规范见对应 skill（vuln-db / asset-context / snapshot）；先按示例修正后再重试。'
  ].join('\n')
}
