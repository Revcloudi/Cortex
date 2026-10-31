import { z } from 'zod'

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'] as const
export type Severity = (typeof SEVERITIES)[number]

export const VULN_STATUSES = ['Confirmed', 'Inconclusive', 'Retest_Passed'] as const
export type VulnStatus = (typeof VULN_STATUSES)[number]

export const SEVERITY_LABELS: Record<Severity, string> = {
  Critical: '严重',
  High: '高危',
  Medium: '中危',
  Low: '低危',
  Info: '信息'
}

export const STATUS_LABELS: Record<VulnStatus, string> = {
  Confirmed: '已确认',
  Inconclusive: '待定',
  Retest_Passed: '复测通过'
}

export const SEVERITY_RANK: Record<Severity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Info: 4
}

/**
 * One retest entry. `time_range` is the human-readable observation window,
 * e.g. `2026-01-02 10:00-10:04 (Asia/Shanghai)`; `conclusion` is Markdown and
 * is rendered by the UI. Retests are append-only: they must never overwrite the
 * original vulnerability fields.
 */
export const RetestResultSchema = z
  .object({
    time_range: z.string().trim().min(1, 'time_range 不能为空').max(200),
    conclusion: z.string().trim().min(1, '复测结论不能为空').max(50_000)
  })
  .strict()

export type RetestResult = z.infer<typeof RetestResultSchema>

export interface Vulnerability {
  /** Primary key, e.g. VULN-20241027-001. */
  id: string
  /** Target host and port, e.g. 10.0.0.5:8080 (no scheme). */
  host: string
  /** Initial entry point, e.g. /login. */
  entry_point: string
  vuln_name: string
  /** Short taxonomy label, e.g. SQLi, SSRF, Auth_Bypass. */
  vuln_type: string
  severity: Severity
  /** Concrete URL that triggers the vulnerability. */
  target_url: string
  description: string
  impact: string
  /** Affected endpoints / interfaces. */
  affected_interfaces: string[]
  /**
   * Reproduction notes as Markdown. Agents should use the localized Markdown
   * headings and bold labels required by the `vuln-db` skill, with fenced
   * `http` code blocks for raw requests and responses.
   */
  reproduction_steps: string
  remediation: string[]
  /** Encryption / signature flow notes, empty string when not applicable. */
  crypto_details: string
  /** Scope boundaries and what was deliberately not tested. */
  test_boundaries: string
  /** Append-only retest history; empty means not retested yet. */
  retest_results: RetestResult[]
  related_vuln_ids: string[]
  status: VulnStatus
  /** ISO-8601 timestamp. */
  created_at: string
}

const isoDateString = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'created_at 必须是合法的 ISO 时间字符串')

const hostString = z
  .string()
  .trim()
  .min(1, 'host 不能为空')
  .max(255)
  .refine((value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value), 'host 不能包含协议头（如 http://）')
  .refine((value) => !/\s/.test(value), 'host 不能包含空白字符')
  .refine((value) => !/[/?#]/.test(value), 'host 仅包含主机与端口，不能带路径或查询参数')
  .refine((value) => {
    const match = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/.exec(value)
    if (!match) return false
    const port = Number.parseInt(match[1] ?? '', 10)
    return port >= 1 && port <= 65535
  }, 'host 必须包含 1-65535 的端口，例如 10.0.0.5:8080')

/**
 * Schema for the payload an agent sends to `save_vulnerability`.
 * `id` is optional: when omitted the hub allocates the next
 * `VULN-YYYYMMDD-NNN` identifier. All array / object fields are validated
 * before they are ever serialised into SQLite.
 */
export const VulnerabilityPayloadSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'id 只能包含字母、数字、点、下划线和连字符')
      .optional(),
    host: hostString,
    entry_point: z.string().trim().max(4000).default(''),
    vuln_name: z.string().trim().min(1, 'vuln_name 不能为空').max(500),
    /** Optional taxonomy label; some older reports may omit it. */
    vuln_type: z.string().trim().min(1).max(100).default('Unclassified'),
    severity: z.enum(SEVERITIES),
    target_url: z.string().trim().min(1, 'target_url 不能为空').max(8000),
    description: z.string().max(50_000).default(''),
    impact: z.string().max(50_000).default(''),
    affected_interfaces: z.array(z.string().trim().min(1).max(4000)).max(500).default([]),
    reproduction_steps: z.string().max(500_000).default(''),
    remediation: z.array(z.string().trim().min(1).max(20_000)).max(200).default([]),
    crypto_details: z.string().max(50_000).default(''),
    test_boundaries: z.string().max(50_000).default(''),
    retest_results: z.array(RetestResultSchema).max(100).default([]),
    related_vuln_ids: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
    status: z.enum(VULN_STATUSES).default('Confirmed'),
    created_at: isoDateString.default(() => new Date().toISOString())
  })
  .strict()

export type VulnerabilityPayload = z.output<typeof VulnerabilityPayloadSchema>
export type VulnerabilityPayloadInput = z.input<typeof VulnerabilityPayloadSchema>

/** Full, validated vulnerability record as stored in SQLite. */
export const VulnerabilitySchema = VulnerabilityPayloadSchema.extend({
  id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
}).strict()

export const ASSET_STATUSES = ['Alive', 'Dead', 'WAF_Blocked'] as const
export type AssetStatus = (typeof ASSET_STATUSES)[number]

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  Alive: '存活',
  Dead: '不可达',
  WAF_Blocked: 'WAF 拦截'
}

export const LEAKED_INFO_TYPES = [
  'Credential',
  'API_Key',
  'Token',
  'PII',
  'Internal_IP',
  'Other'
] as const
export type LeakedInfoType = (typeof LEAKED_INFO_TYPES)[number]

export const LEAKED_INFO_TYPE_LABELS: Record<LeakedInfoType, string> = {
  Credential: '凭据',
  API_Key: 'API Key',
  Token: 'Token',
  PII: 'PII',
  Internal_IP: '内网 IP',
  Other: '其他'
}

/**
 * Asset identity may be a full URL (preferred), a bare host, or host:port.
 * A full URL preserves scheme, port and path so login pages and HTTP-only
 * systems remain distinguishable.
 */
export function normalizeAssetIdentifier(value: string): string {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString()
    } catch {
      return trimmed
    }
  }
  return trimmed.toLowerCase()
}

export function isValidAssetIdentifier(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 4_000) return false
  if (/\s/.test(trimmed)) return false

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname.length > 0
      )
    } catch {
      return false
    }
  }

  const match = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?(?:\/.*)?$/.exec(
    trimmed
  )
  if (!match) return false
  const portText = match[1]
  if (portText !== undefined) {
    const port = Number.parseInt(portText, 10)
    if (!Number.isFinite(port) || port < 1 || port > 65535) return false
  }
  return true
}

/** A pure host has no scheme, port, path or query string. */
export function isValidAssetHost(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  if (/\s/.test(trimmed)) return false
  return /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)$/.test(trimmed)
}

function isIpLiteralHost(host: string): boolean {
  const unwrapped = host.replace(/^\[/, '').replace(/\]$/, '')
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(unwrapped)) {
    return unwrapped.split('.').every((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) && value >= 0 && value <= 255
    })
  }
  return unwrapped.includes(':') && /^[0-9a-fA-F:.]+$/.test(unwrapped)
}

/**
 * Standalone IP/host:port targets belong to port scanning / service discovery,
 * not the web-asset context library. An IP is accepted only as part of a full
 * http(s) URL (an "IP link"), e.g. http://10.0.0.5:8080/login.
 */
export function isStandaloneIpIdentifier(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || /^https?:\/\//i.test(trimmed)) return false
  const host = deriveAssetHost(trimmed)
  return host.length > 0 && isIpLiteralHost(host)
}

/** Derive the pure host from a URL / host:port / bare host. */
export function deriveAssetHost(value: string): string {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase()
    } catch {
      return ''
    }
  }

  const beforePath = trimmed.split(/[/?#]/, 1)[0] ?? trimmed
  if (beforePath.startsWith('[')) {
    const closing = beforePath.indexOf(']')
    return closing > 0 ? beforePath.slice(0, closing + 1).toLowerCase() : ''
  }
  const colon = beforePath.lastIndexOf(':')
  return (colon === -1 ? beforePath : beforePath.slice(0, colon)).toLowerCase()
}

/** Kept for older call sites; assets now accept URLs as identifiers too. */
export const normalizeAssetHostPort = normalizeAssetIdentifier
/** Kept for older call sites; this now validates full URLs as well. */
export const isValidAssetHostPort = isValidAssetIdentifier

/**
 * JS/CSS/images are evidence sources, not API interfaces. Keeping them out of
 * `interface_dir` prevents the asset drawer from presenting static frontend
 * files as callable endpoints.
 */
export function isLikelyStaticAssetPath(value: string): boolean {
  return /\.(?:js|mjs|cjs|css|scss|less|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)(?:$|[?#])/i.test(
    value.trim()
  )
}

const assetIdentifierSchema = z
  .string()
  .trim()
  .min(1, 'host_port 不能为空')
  .max(4_000)
  .refine(
    isValidAssetIdentifier,
    'host_port 必须是完整 URL（推荐）、host 或 host:port；不能包含空白字符'
  )
  .refine(
    (value) => !isStandaloneIpIdentifier(value),
    '单独的 IP / IP:端口不支持入库；IP 资产请传完整 http(s) URL，如 http://10.0.0.5:8080/login'
  )

const assetHostSchema = z
  .string()
  .trim()
  .min(1, 'host 不能为空')
  .max(255)
  .refine(isValidAssetHost, 'host 必须是纯 host，不含端口、协议头、路径或空白字符')

export const LeakedInfoSchema = z
  .object({
    info_type: z.enum(LEAKED_INFO_TYPES),
    value: z.string().trim().min(1, '泄露内容不能为空').max(20_000),
    source: z.string().trim().min(1, '泄露来源不能为空').max(8_000),
    potential_impact: z.string().trim().min(1, '潜在影响不能为空').max(10_000)
  })
  .strict()

export type LeakedInfo = z.infer<typeof LeakedInfoSchema>

export const TEST_PARAMETER_LOCATIONS = ['path', 'query', 'body', 'header', 'cookie'] as const
export type TestParameterLocation = (typeof TEST_PARAMETER_LOCATIONS)[number]

/**
 * Non-secret parameter seeds discovered while browsing/capturing traffic, e.g.
 * user ids, order numbers or tenant ids. They are deliberately kept separate
 * from `leaked_infos`: a bare id is not a secret, it is testing material for
 * IDOR / enumeration checks. `values` should only hold a small sample, while
 * `pattern` describes how to generate more candidates.
 */
export const TestParameterCandidateSchema = z
  .object({
    /** Parameter name, e.g. `id`, `userId`, `orderId`, `tenantId`. */
    name: z.string().trim().min(1, '参数名不能为空').max(100),
    /** Endpoint that consumes the parameter, e.g. `GET /api/v1/users/{id}`. */
    endpoint: z.string().trim().min(1, '接口不能为空').max(500),
    location: z.enum(TEST_PARAMETER_LOCATIONS),
    /** Small sample of observed candidate values (never a full data dump). */
    values: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    /** Enumeration rule, e.g. sequential numeric IDs (10000+) or `UUID v4`. */
    pattern: z.string().trim().max(500).optional(),
    /** Where the values were observed, e.g. response JSON / URL / JS bundle. */
    source: z.string().trim().min(1, '来源不能为空').max(1_000),
    /** Whether this seed has already been used in an authorization test. */
    tested: z.boolean().default(false),
    notes: z.string().trim().max(2_000).optional(),
    related_vuln_ids: z.array(z.string().trim().min(1).max(100)).max(100).default([])
  })
  .strict()

export type TestParameterCandidate = z.infer<typeof TestParameterCandidateSchema>

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD'
] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

/**
 * Structured description of one API endpoint.
 *
 * - `path` is mandatory and is the only field present in legacy databases.
 * - `method` / `params` / `request` are optional so `interface_dir` strings can
 *   be upgraded without inventing data.
 * - `request` is the complete raw HTTP request captured by the agent (request
 *   line + headers + optional body); the UI copies it verbatim.
 */
export const AssetInterfaceSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1, '接口 path 不能为空')
      .max(4_000)
      .refine(
        (value) => !isLikelyStaticAssetPath(value),
        '接口 path 只接受 API 接口路径；JS/CSS/图片等静态文件请记录到 leaked_infos.source'
      ),
    method: z.enum(HTTP_METHODS).optional(),
    /** Query string, form fields or JSON body summary, as captured by the agent. */
    params: z.string().trim().max(20_000).optional(),
    /** Complete raw HTTP request (request line, headers, body). */
    request: z.string().trim().max(200_000).optional()
  })
  .strict()

export type AssetInterface = z.infer<typeof AssetInterfaceSchema>

/**
 * Canonicalize mixed interface data coming from old and new clients.
 *
 * - Structured entries win over legacy path-only strings for the same path.
 * - `interface_dir` strings are normalized to `{ path }` (never throws).
 * - Static JS/CSS/image paths are dropped; empty values and duplicates removed.
 * - Entries without `method` are dropped once a structured entry for the same
 *   path carries a method, so an upgrade never shows the same endpoint twice.
 */
export function normalizeAssetInterfaces(
  interfaces: readonly AssetInterface[] | undefined | null,
  interfaceDir: readonly string[] | undefined | null = []
): AssetInterface[] {
  const result: AssetInterface[] = []
  const seen = new Set<string>()
  const pathsWithMethod = new Set<string>()

  const add = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return
    const candidate = raw as Record<string, unknown>
    if (typeof candidate.path !== 'string') return
    const path = candidate.path.trim()
    if (path.length === 0 || isLikelyStaticAssetPath(path)) return

    const method =
      typeof candidate.method === 'string' &&
      (HTTP_METHODS as readonly string[]).includes(candidate.method)
        ? (candidate.method as HttpMethod)
        : undefined
    const params = typeof candidate.params === 'string' ? candidate.params.trim() : ''
    const request = typeof candidate.request === 'string' ? candidate.request.trim() : ''

    const key = `${method ?? '*'}\u0000${path}`
    if (seen.has(key)) return
    seen.add(key)
    if (method) pathsWithMethod.add(path)
    result.push({
      path,
      ...(method ? { method } : {}),
      ...(params ? { params } : {}),
      ...(request ? { request } : {})
    })
  }

  for (const item of interfaces ?? []) add(item)

  const normalized = result.filter(
    (item) => item.method !== undefined || !pathsWithMethod.has(item.path)
  )

  for (const raw of interfaceDir ?? []) {
    if (typeof raw !== 'string') continue
    const path = raw.trim()
    if (path.length === 0 || isLikelyStaticAssetPath(path)) continue
    if (normalized.some((item) => item.path === path)) continue
    const key = `*\u0000${path}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ path })
  }

  return normalized
}

/** Derive the legacy `interface_dir` string array from structured interfaces. */
export function interfaceDirFromInterfaces(
  interfaces: readonly AssetInterface[] | undefined | null
): string[] {
  const paths = new Set<string>()
  for (const item of interfaces ?? []) {
    const path = item.path.trim()
    if (path.length > 0) paths.add(path)
  }
  return [...paths]
}

/**
 * Payload accepted by `sync_asset_info`. `last_seen` is intentionally optional
 * on input: the hub owns that timestamp. `host` is optional on input too — the
 * server derives it from the URL when omitted.
 */
export const AssetContextPayloadSchema = z
  .object({
    host_port: assetIdentifierSchema,
    host: assetHostSchema.optional(),
    project_name: z.string().trim().min(1, 'project_name 不能为空').max(120),
    tech_stack: z.string().trim().max(1_000).optional(),
    auth_required: z.boolean().default(false),
    status: z.enum(ASSET_STATUSES).default('Alive'),
    /**
     * Structured endpoint registry: method / params / raw request per path.
     * Preferred over `interface_dir`, which is kept for backwards compatibility.
     */
    interfaces: z.array(AssetInterfaceSchema).max(2_000).default([]),
    /** Legacy path-only list; normalized to `{ path }` on read/write. */
    interface_dir: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(4_000)
          .refine(
            (value) => !isLikelyStaticAssetPath(value),
            'interface_dir 只接受 API 接口路径；JS/CSS/图片等静态文件路径请记录到 leaked_infos.source'
          )
      )
      .max(2_000)
      .default([]),
    leaked_infos: z.array(LeakedInfoSchema).max(200).default([]),
    /** Non-secret testing material: ids / order numbers / tenant ids etc. */
    test_parameters: z.array(TestParameterCandidateSchema).max(100).default([]),
    related_vuln_ids: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
    last_seen: z.string().trim().min(1).max(64).optional()
  })
  .strict()

export type AssetContextPayload = z.infer<typeof AssetContextPayloadSchema>

/** Full asset record returned by the database / UI, with derived host + last_seen. */
export const AssetContextSchema = AssetContextPayloadSchema.extend({
  host: assetHostSchema,
  last_seen: z.string().trim().min(1).max(64)
}).strict()

export type AssetContext = z.infer<typeof AssetContextSchema>

export type AssetSyncMode = 'replace' | 'merge'

/** Input surface for the `sync_asset_info` MCP tool. */
export const SyncAssetInfoInputSchema = AssetContextPayloadSchema.extend({
  mode: z.enum(['replace', 'merge']).default('replace')
}).strict()

export type SyncAssetInfoInput = z.infer<typeof SyncAssetInfoInputSchema>

/** Compact asset row used by the asset library table. */
export interface AssetListItem {
  /** Full URL (preferred) or host:port identifier. */
  host_port: string
  /** Pure host derived from host_port. */
  host: string
  project_name: string
  tech_stack: string
  auth_required: boolean
  status: AssetStatus
  interface_count: number
  leak_count: number
  related_vuln_count: number
  last_seen: string
}

export interface AssetFilters {
  search?: string
  status?: AssetStatus | 'all'
}

export interface SyncAssetResult {
  success: true
  host_port: string
  host: string
  created: boolean
  mode: AssetSyncMode
  message: string
}

/** Result of deleting one asset context row (vulnerabilities are not touched). */
export interface DeleteAssetResult {
  deleted: boolean
}

export const SNAPSHOT_ACTIONS = [
  'save',
  'load',
  'list',
  'attach_assets',
  'restore_previous'
] as const
export type SnapshotAction = (typeof SNAPSHOT_ACTIONS)[number]

/** Server-owned id format, e.g. SESS-20260101-001. */
export const SNAPSHOT_SESSION_ID_PATTERN = /^SESS-\d{8}-\d{3}$/

/**
 * Overall ceiling of the serialized cognitive payload. Field level caps alone
 * can still add up; the handler/database rejects a snapshot above this size so a
 * single `load` can never flood the next session's context.
 */
export const SNAPSHOT_MAX_PAYLOAD_CHARS = 32_000

/**
 * One interface test record. `target` should look like `POST /api/login` or a
 * full URL; `method` is the attempted technique/payload summary; `result` is
 * the observed outcome.
 */
export const SnapshotTestedInterfaceSchema = z
  .object({
    target: z.string().trim().min(1, 'target 不能为空').max(300),
    method: z.string().trim().max(300),
    result: z.string().trim().max(500)
  })
  .strict()

export type SnapshotTestedInterface = z.infer<typeof SnapshotTestedInterfaceSchema>

/**
 * Full cognitive state of one task/session.
 *
 * Responsibility split (enforced by the snapshot skill):
 * - Detailed evidence (HTTP request/response, reproduction steps, remediation)
 *   belongs to the vulnerability library (`save_vulnerability`); the snapshot
 *   only references ids via `related_vuln_ids`.
 * - Interface inventory / raw requests / fingerprints belong to the asset
 *   library (`sync_asset_info`); `tested_interfaces` only stores test outcomes.
 * - `notes` is the Markdown overflow for commands, payloads, observations and
 *   JS clues that do not fit a structured field.
 *
 * Every field is required when a session is first created so the agent cannot
 * silently drop a key part of its context.
 */
export const SnapshotPayloadSchema = z
  .object({
    project_name: z.string().trim().min(1, 'project_name 不能为空').max(120),
    target_hosts: z
      .array(z.string().trim().min(1, 'target_hosts 不能为空').max(255))
      .min(1, 'target_hosts 至少需要 1 个 Host')
      .max(50),
    current_phase: z.string().trim().max(200),
    unfinished_tasks: z
      .array(z.string().trim().min(1, '未完成任务不能为空').max(500))
      .max(20),
    failed_paths: z.array(z.string().trim().min(1, '失败路径不能为空').max(500)).max(20),
    /** Structured interface test matrix: what was tested, how, and the result. */
    tested_interfaces: z.array(SnapshotTestedInterfaceSchema).max(50),
    /** Markdown overflow: commands, payloads, observations, JS clues. */
    notes: z.string().max(8_000),
    /** References to stored vulnerabilities; full evidence stays in the library. */
    related_vuln_ids: z.array(z.string().trim().min(1).max(100)).max(100),
    next_steps: z.string().trim().max(2_000)
  })
  .strict()

export type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>

/** Partial payload used for in-place updates (`undefined` field = keep value). */
export const SnapshotSavePayloadSchema = SnapshotPayloadSchema.partial()
export type SnapshotSavePayload = z.infer<typeof SnapshotSavePayloadSchema>

/** Full session row returned by the DB / UI / MCP tools. */
export const SnapshotSessionSchema = SnapshotPayloadSchema.extend({
  session_id: z.string().trim().min(1).max(100),
  /** Root (project/campaign) sessions have null; child sessions point at their project. */
  parent_session_id: z.string().trim().min(1).max(100).nullable(),
  /** Null while active; ISO timestamp once the session (and its children) is archived. */
  archived_at: z.string().trim().min(1).max(64).nullable(),
  /** Number of direct child sessions (sub-systems); 0 for leaf sessions. */
  child_count: z.number().int().nonnegative(),
  created_at: z.string().trim().min(1).max(64),
  updated_at: z.string().trim().min(1).max(64),
  /** True when a single-step rollback (`restore_previous`) is available. */
  has_previous_state: z.boolean()
}).strict()

export type SnapshotSession = z.infer<typeof SnapshotSessionSchema>

/** Compact row used by the session list (never contains full arrays). */
export const SnapshotSummarySchema = z
  .object({
    session_id: z.string().trim().min(1).max(100),
    project_name: z.string().trim().min(1).max(120),
    current_phase: z.string().trim().max(200),
    target_hosts: z.array(z.string().trim().min(1).max(255)).max(50),
    parent_session_id: z.string().trim().min(1).max(100).nullable(),
    archived_at: z.string().trim().min(1).max(64).nullable(),
    child_count: z.number().int().nonnegative(),
    created_at: z.string().trim().min(1).max(64),
    updated_at: z.string().trim().min(1).max(64),
    unfinished_count: z.number().int().nonnegative(),
    failed_count: z.number().int().nonnegative(),
    tested_interface_count: z.number().int().nonnegative(),
    next_steps_excerpt: z.string().max(300),
    has_previous_state: z.boolean()
  })
  .strict()

export type SnapshotSummary = z.infer<typeof SnapshotSummarySchema>

export interface SnapshotListFilters {
  keyword?: string
  /** Only root/project sessions (no children) when true. */
  rootsOnly?: boolean
  /** Only direct children of this project session. */
  parentSessionId?: string
  /** Archived sessions are hidden by default. */
  includeArchived?: boolean
  limit?: number
}

export interface SnapshotListResult {
  total: number
  items: SnapshotSummary[]
}

/** Result of the desktop-only delete action (cascade includes child sessions). */
export interface DeleteSnapshotResult {
  deleted: number
}

/**
 * MCP input envelope for the single `manage_snapshot` tool.
 *
 * Action-specific requirements are enforced in the handler so the tool
 * definition stays compact while still advertising the payload shape:
 * - save: `payload` required; creation needs all fields, update accepts partial;
 *   `parent_session_id` only on creation, one level only (project → system)
 * - load: `session_id` required; children summaries are returned for project sessions
 * - list: optional `keyword` / `roots_only` / `parent_session_id` / `include_archived`
 * - attach_assets: `session_id` + non-empty `hosts` required
 * - restore_previous: `session_id` required
 */
export const ManageSnapshotInputSchema = z
  .object({
    action: z.enum(SNAPSHOT_ACTIONS),
    session_id: z.string().trim().min(1).max(100).optional(),
    payload: SnapshotSavePayloadSchema.optional(),
    /** Create a new session even when the same project already has one. */
    force_new: z.boolean().optional(),
    /** Optimistic concurrency token: the `updated_at` the agent based its edit on. */
    base_updated_at: z.string().trim().min(1).max(64).optional(),
    /** Create a child (system) session under a root project session; also a list filter for children. */
    parent_session_id: z.string().trim().min(1).max(100).optional(),
    /** list: only root/project sessions. */
    roots_only: z.boolean().optional(),
    /** list: include archived sessions (hidden by default). */
    include_archived: z.boolean().optional(),
    keyword: z.string().trim().max(200).optional(),
    hosts: z
      .array(z.string().trim().min(1).max(255))
      .min(1, 'hosts 至少需要 1 个 Host')
      .max(50)
      .optional(),
    limit: z.number().int().min(1).max(50).optional()
  })
  .strict()

export type ManageSnapshotInput = z.infer<typeof ManageSnapshotInputSchema>

export interface SnapshotSaveResult {
  success: true
  action: 'save'
  created: boolean
  session: SnapshotSession
}

/** Returned when `save` finds an existing session for the project and needs a user choice. */
export interface SnapshotChoiceResult {
  success: false
  action: 'save'
  requires_choice: true
  code: 'SESSION_EXISTS'
  candidates: SnapshotSummary[]
}

export type ManageSnapshotResult =
  | SnapshotSaveResult
  | SnapshotChoiceResult
  | {
      success: true
      action: 'load'
      session: SnapshotSession
      /** Direct child sessions (summaries only) when loading a project session. */
      children: SnapshotSummary[]
    }
  | { success: true; action: 'list'; total: number; items: SnapshotSummary[] }
  | { success: true; action: 'attach_assets'; session: SnapshotSession }
  | { success: true; action: 'restore_previous'; session: SnapshotSession }

export const SaveVulnerabilityInputSchema = VulnerabilityPayloadSchema

/**
 * Unified read tool input. Mode precedence:
 * 1. `vuln_id` → one full record
 * 2. `host` → compact summaries for that host (case-insensitive)
 * 3. otherwise → filtered, paginated compact list
 */
export const QueryVulnerabilitiesInputSchema = z
  .object({
    vuln_id: z.string().trim().min(1, 'vuln_id 不能为空').max(100).optional(),
    host: z.string().trim().min(1, 'host 不能为空').max(255).optional(),
    search: z.string().trim().max(500).optional(),
    severity: z.enum(SEVERITIES).optional(),
    status: z.enum(VULN_STATUSES).optional(),
    page: z.number().int().min(1).max(100_000).optional(),
    pageSize: z.number().int().min(1).max(200).optional()
  })
  .strict()
  .refine(
    (value) =>
      value.vuln_id !== undefined ||
      value.host !== undefined ||
      (value.search !== undefined && value.search.length > 0) ||
      value.severity !== undefined ||
      value.status !== undefined,
    { message: '至少提供 vuln_id、host、search、severity、status 之一', path: ['vuln_id'] }
  )

export type QueryVulnerabilitiesInput = z.infer<typeof QueryVulnerabilitiesInputSchema>

/**
 * Unified safe write tool: status transition and/or append-only retest.
 * `retest` only carries `time_range` + Markdown `conclusion`, so this tool can
 * never overwrite the original vulnerability evidence.
 */
export const UpdateVulnerabilityInputSchema = z
  .object({
    vuln_id: z.string().trim().min(1, 'vuln_id 不能为空').max(100),
    status: z.enum(VULN_STATUSES).optional(),
    retest: RetestResultSchema.optional()
  })
  .strict()
  .refine((value) => value.status !== undefined || value.retest !== undefined, {
    message: 'status 与 retest 至少提供一个',
    path: ['status']
  })

export type UpdateVulnerabilityInput = z.infer<typeof UpdateVulnerabilityInputSchema>

const assetHostPortLookupSchema = z
  .string()
  .trim()
  .min(1, 'host_port 不能为空')
  .max(4_000)
  .refine(
    isValidAssetIdentifier,
    'host_port 必须是完整 URL（推荐）、host 或 host:port；不能包含空白字符'
  )

/** Exactly one selector chooses the asset query mode. */
export const QueryAssetContextInputSchema = z
  .object({
    host_port: assetHostPortLookupSchema.optional(),
    project_name: z.string().trim().min(1, 'project_name 不能为空').max(120).optional()
  })
  .strict()
  .refine(
    (value) => (value.host_port === undefined) !== (value.project_name === undefined),
    { message: 'host_port 与 project_name 必须且只能提供一个', path: ['host_port'] }
  )

export type QueryAssetContextInput = z.infer<typeof QueryAssetContextInputSchema>

export interface SaveVulnerabilityResult {
  success: true
  id: string
  /** True when a new row was created, false when an existing row was replaced. */
  created: boolean
}

/** Compact row returned by `query_vulnerabilities` host mode. */
export interface VulnSummary {
  vuln_id: string
  vuln_name: string
  severity: Severity
  target_url: string
}

/** Host-mode result of `query_vulnerabilities`. */
export interface VulnHostQueryResult {
  host: string
  total: number
  items: VulnSummary[]
}

/** Result of `update_vulnerability`; `retest_index` is set only for retests. */
export interface UpdateVulnerabilityResult {
  success: true
  id: string
  status: VulnStatus
  retest_index?: number
}

/** Compact row used by the renderer table. */
export interface VulnerabilityListItem {
  id: string
  host: string
  entry_point: string
  vuln_name: string
  vuln_type: string
  severity: Severity
  target_url: string
  status: VulnStatus
  created_at: string
}

export interface DashboardStats {
  total: number
  critical: number
  high: number
  hosts: number
  today: number
  bySeverity: Record<Severity, number>
  byStatus: Record<VulnStatus, number>
}

export interface VulnFilters {
  /** Case-insensitive match against host, name, id, type and target URL. */
  search?: string
  severity?: Severity | 'all'
  status?: VulnStatus | 'all'
}

/** Page sizes offered by the vulnerability dashboard. */
export const VULN_PAGE_SIZE_OPTIONS = [10, 20, 50] as const
export type VulnPageSize = (typeof VULN_PAGE_SIZE_OPTIONS)[number]
export const DEFAULT_VULN_PAGE_SIZE: VulnPageSize = 10

/** Filters + server-side pagination accepted by `listVulnerabilities`. */
export interface VulnListQuery extends VulnFilters {
  /** 1-based page number; clamped to the last page when out of range. */
  page?: number
  /** Rows per page. The UI only offers 10 / 20 / 50. */
  pageSize?: number
}

/** Server-side paginated vulnerability list (filtered total, not page size). */
export interface PaginatedVulnerabilities {
  items: VulnerabilityListItem[]
  /** Total rows matching the filters. */
  total: number
  /** Effective page after clamping to `[1, ceil(total / pageSize)]`. */
  page: number
  pageSize: number
}

export interface UpdateVulnStatusRequest {
  id: string
  status: VulnStatus
}

export interface DeleteVulnResult {
  deleted: boolean
}

export interface DeleteVulnsResult {
  deleted: number
}

export interface ExportReportsResult {
  cancelled: boolean
  /** Absolute paths of the written Markdown files. */
  files: string[]
}

export interface SeedDemoResult {
  inserted: number
}

/** Current on-disk schema version; bump when DatabaseService.migrate changes. */
export const DATABASE_SCHEMA_VERSION = 2

export interface DatabaseInfo {
  dbPath: string
  /** `PRAGMA user_version` of the open database. */
  schemaVersion: number
  /** False when the on-disk file does not exist yet (always true for `:memory:`). */
  exists: boolean
  /** Main database file size in bytes (0 for `:memory:`). */
  sizeBytes: number
  /** WAL file size in bytes (0 when absent). */
  walSizeBytes: number
  /** Latest mtime across the database + WAL files, ISO-8601, null when unknown. */
  lastModifiedAt: string | null
}

export type McpRuntimeMode = 'development' | 'installed'

/**
 * How this build runs the stdio MCP server. The GUI renders copy-paste agent
 * configs from it; the CLI computes the same shape from its own location.
 */
export interface McpRuntimeInfo {
  mode: McpRuntimeMode
  /** Executable that launches the stdio server (`node.exe` in installed builds). */
  command: string
  /** Absolute path of the bundled/built stdio MCP entry script. */
  entry: string
  /** Human-readable command line for docs / copy buttons. */
  display: string
}

export interface AppInfo {
  name: string
  version: string
  /** Electron app path; in the source workspace this is the project root. */
  projectRoot: string
  dbPath: string
  /** Current on-disk schema version (`PRAGMA user_version`). */
  schemaVersion: number
  platform: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  /** stdio MCP entry point used by the agent configs shown in the UI. */
  mcpRuntime: McpRuntimeInfo
}

/** Result of the desktop database-picker actions. */
export interface DatabaseSwitchResult {
  cancelled: boolean
  /** Human-readable error when the chosen file could not be opened. */
  error: string | null
  /** Database path currently attached after the switch. */
  dbPath: string | null
  appInfo: AppInfo | null
}

/* -------------------------------------------------------------------------- */
/*  First-run setup wizard / installer-driven agent configuration             */
/* -------------------------------------------------------------------------- */

export type AgentId = 'dsh' | 'codex' | 'claude' | 'cursor' | 'workbuddy' | 'zcode'
export type SkillLanguage = 'zh' | 'en'
export type UiLanguage = 'zh' | 'en'

export interface SetupAgentOption {
  id: AgentId
  /** Display name, e.g. "DeepSeek Harness". */
  name: string
  /** Short localized description shown in the wizard. */
  description: LocalizedText
  /** Whether an installation/config for this agent was detected. */
  detected: boolean
}

export interface LocalizedText {
  zh: string
  en: string
}

export interface SetupInfo {
  /** True when at least one agent already points at Cortex. */
  alreadyConfigured: boolean
  agents: SetupAgentOption[]
  defaultSkillLanguage: SkillLanguage
  defaultUiLanguage: UiLanguage
}

export interface SetupRunRequest {
  agents: AgentId[]
  skillLanguage: SkillLanguage
  uiLanguage: UiLanguage
}

export interface SetupActionSummary {
  agent?: AgentId
  kind: 'mcp' | 'skill' | 'rule'
  path: string
  status: 'created' | 'updated' | 'skipped' | 'manual-required' | 'failed'
  detail?: string
}

export interface SetupRunResult {
  success: boolean
  actions: SetupActionSummary[]
  warnings: string[]
  restartHint: string
}
