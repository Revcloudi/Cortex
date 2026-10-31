/**
 * Shared IPC contract module. IMPORTANT: keep this module free of runtime
 * imports of third-party packages. The preload script imports it under
 * `sandbox: true`, where only `electron` can be required. IPC validation
 * schemas live in `src/main/ipc/schemas.ts`.
 */

/** Product identity shared by the main process, renderer and CLI. */
export const CORTEX_APP_NAME = 'Cortex'
export const CORTEX_APP_ID = 'com.cortex.app'

/**
 * MCP transport contract. Cortex only speaks stdio: the agent starts
 * `<node> <entry>` itself and both ends share the local SQLite file. There is no
 * listening port, so the UI never shows a "server running" state.
 */
export const MCP_TRANSPORT = 'stdio'
export const MCP_SERVER_NAME = 'cortex'
export const MCP_TOOL_COUNT = 6

export const IPC_CHANNELS = {
  listVulnerabilities: 'vulns:list',
  getVulnerability: 'vulns:get',
  getStats: 'vulns:stats',
  updateVulnerabilityStatus: 'vulns:update-status',
  deleteVulnerability: 'vulns:delete',
  deleteVulnerabilities: 'vulns:delete-many',
  exportVulnerabilities: 'vulns:export',
  listAssets: 'assets:list',
  getAssetDetail: 'assets:get',
  getAssetRelatedVulnerabilities: 'assets:related-vulns',
  deleteAsset: 'assets:delete',
  listSnapshots: 'snapshots:list',
  getSnapshot: 'snapshots:get',
  restoreSnapshotPrevious: 'snapshots:restore-previous',
  archiveSnapshot: 'snapshots:archive',
  deleteSnapshot: 'snapshots:delete',
  getDatabaseInfo: 'db:info',
  getAppInfo: 'app:info',
  getSetupInfo: 'setup:info',
  runSetup: 'setup:run',
  seedDemoData: 'demo:seed',
  writeClipboard: 'clipboard:write',
  dataChanged: 'data:changed'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

import type {
  AppInfo,
  AssetContext,
  AssetFilters,
  AssetListItem,
  DashboardStats,
  DatabaseInfo,
  DeleteAssetResult,
  DeleteSnapshotResult,
  DeleteVulnResult,
  DeleteVulnsResult,
  ExportReportsResult,
  LocalizedText,
  PaginatedVulnerabilities,
  SeedDemoResult,
  SetupInfo,
  SetupRunRequest,
  SetupRunResult,
  Severity,
  SnapshotListFilters,
  SnapshotListResult,
  SnapshotSession,
  UpdateVulnStatusRequest,
  VulnListQuery,
  Vulnerability,
  VulnerabilityListItem,
  VulnStatus
} from './types'

export interface CortexApi {
  /** Server-side paginated + filtered vulnerability list. */
  listVulnerabilities(filters?: VulnListQuery): Promise<PaginatedVulnerabilities>
  getVulnerability(id: string): Promise<Vulnerability | null>
  getStats(): Promise<DashboardStats>
  updateVulnerabilityStatus(input: UpdateVulnStatusRequest): Promise<Vulnerability>
  deleteVulnerability(id: string): Promise<DeleteVulnResult>
  deleteVulnerabilities(ids: string[]): Promise<DeleteVulnsResult>
  /** Export one or more vulnerability reports as Markdown (save file / pick directory). */
  exportVulnerabilities(ids: string[]): Promise<ExportReportsResult>
  listAssets(filters?: AssetFilters): Promise<AssetListItem[]>
  getAssetDetail(hostPort: string): Promise<AssetContext | null>
  getAssetRelatedVulnerabilities(hostPort: string): Promise<VulnerabilityListItem[]>
  /** Permanently delete one asset context row; vulnerability records stay untouched. */
  deleteAsset(hostPort: string): Promise<DeleteAssetResult>
  /** Compact cognitive-snapshot session list (never contains full task arrays). */
  listSnapshots(filters?: SnapshotListFilters): Promise<SnapshotListResult>
  /** Read exactly one snapshot session, or null when it does not exist. */
  getSnapshot(sessionId: string): Promise<SnapshotSession | null>
  /** Archive / unarchive a session (project sessions cascade to their children). */
  archiveSnapshot(sessionId: string, archived: boolean): Promise<SnapshotSession>
  /** Permanently delete a session and its child sessions. */
  deleteSnapshot(sessionId: string): Promise<DeleteSnapshotResult>
  /** One-step rollback of the latest overwrite (restores previous_state). */
  restoreSnapshotPrevious(sessionId: string): Promise<SnapshotSession>
  /** Read-only database status for the MCP page / doctor view. */
  getDatabaseInfo(): Promise<DatabaseInfo>
  getAppInfo(): Promise<AppInfo>
  /** Agent detection + first-run setup state for the setup wizard. */
  getSetupInfo(): Promise<SetupInfo>
  /** Write agent MCP configs, skills and rules with the chosen options. */
  runSetup(request: SetupRunRequest): Promise<SetupRunResult>
  seedDemoData(): Promise<SeedDemoResult>
  /** Write text through Electron's native clipboard (renderer clipboard APIs are unreliable under file://). */
  writeClipboard(text: string): Promise<void>
  /** Subscribe to data-change notifications pushed by the main process. */
  onDataChanged(callback: () => void): () => void
}

/** @deprecated Pre-rename alias; use `CortexApi`. */
export type PentestDataHubApi = CortexApi

export interface McpToolDoc {
  name: string
  title: LocalizedText
  description: LocalizedText
  input: LocalizedText
  returns: LocalizedText
}

export const MCP_TOOL_DOCS: readonly McpToolDoc[] = [
  {
    name: 'save_vulnerability',
    title: { zh: '写入 / 覆盖漏洞', en: 'Save / overwrite a vulnerability' },
    description: {
      zh: '将 Agent 发现的漏洞持久化。相同 ID 已存在时整条覆盖，未提供 ID 时自动分配 VULN-YYYYMMDD-NNN。复测已有漏洞请用 update_vulnerability 的 retest 参数，避免覆盖原始证据。',
      en: 'Persist a vulnerability found by the agent. An existing ID is replaced in full; without an ID a VULN-YYYYMMDD-NNN identifier is allocated. Use update_vulnerability with retest to append retest history instead of rewriting the original evidence.'
    },
    input: {
      zh: '完整 Vulnerability 对象（zod 严格校验；reproduction_steps 为 Markdown 文本）',
      en: 'Full Vulnerability object (strict zod validation; reproduction_steps is Markdown text)'
    },
    returns: { zh: '{ success: true, id, created }', en: '{ success: true, id, created }' }
  },
  {
    name: 'query_vulnerabilities',
    title: {
      zh: '查询漏洞（全文 / Host / 过滤列表）',
      en: 'Query vulnerabilities (full text / host / filtered list)'
    },
    description: {
      zh: '只读查询入口：传 vuln_id 返回单条完整记录；传 host 返回该 Host 的紧凑摘要列表；传 search / severity / status 返回分页列表。用于测前侦察、查重、复测前回顾与报告取数。',
      en: 'Read-only entry point: vuln_id returns one full record, host returns compact summaries for that host, and search / severity / status return a paginated list. Used for pre-test recon, deduplication, retest review and report data.'
    },
    input: {
      zh: '{ vuln_id?, host?, search?, severity?, status?, page?, pageSize? }（vuln_id 优先，其次 host，否则按过滤条件分页）',
      en: '{ vuln_id?, host?, search?, severity?, status?, page?, pageSize? } (vuln_id first, then host, otherwise filtered pagination)'
    },
    returns: {
      zh: 'vuln_id: 完整 Vulnerability；host: { host, total, items[] }；过滤: { items[], total, page, pageSize }',
      en: 'vuln_id: full Vulnerability; host: { host, total, items[] }; filters: { items[], total, page, pageSize }'
    }
  },
  {
    name: 'update_vulnerability',
    title: { zh: '状态流转 / 追加复测', en: 'Status transition / append retest' },
    description: {
      zh: '安全更新已有漏洞：status 状态流转，和/或通过 retest 追加一条复测（只追加，不修改描述、影响、复现步骤、修复建议、测试边界等原始字段）。status 与 retest 至少提供一个。',
      en: 'Safely update an existing vulnerability: change status and/or append one retest via retest. Only appends; never rewrites description, impact, reproduction steps, remediation or test boundaries. Provide at least one of status and retest.'
    },
    input: {
      zh: '{ vuln_id: string, status?: "Confirmed" | "Inconclusive" | "Retest_Passed", retest?: { time_range: string, conclusion: Markdown string } }',
      en: '{ vuln_id: string, status?: "Confirmed" | "Inconclusive" | "Retest_Passed", retest?: { time_range: string, conclusion: Markdown string } }'
    },
    returns: {
      zh: '{ success: true, id, status, retest_index? }',
      en: '{ success: true, id, status, retest_index? }'
    }
  },
  {
    name: 'sync_asset_info',
    title: { zh: '同步资产上下文', en: 'Sync asset context' },
    description: {
      zh: '将侦察到的指纹、接口、敏感泄露、测试参数和关联漏洞写入资产库。host_port 优先传完整 URL（支持 http/https、端口和路径）；单独的 IP / IP:端口不支持入库。host 字段为纯 host，可省略由服务端推导。接口优先用结构化 interfaces[]：path 必填，method / params / request 可选，request 为完整原始 HTTP 请求；旧版 interface_dir 字符串数组仍兼容并规范化为 { path }。JS/CSS/图片等静态文件不是接口。test_parameters[] 记录登录后从响应/URL/JS 收集的非密测试参数种子（id/orderId/tenantId 等，values 只放少量样例+pattern，禁止密码/Token/PII）。先读取已有资产，再选择 replace（完整快照）或 merge（增量合并）。',
      en: 'Persist reconnaissance fingerprints, interfaces, leaked information, test parameters and related vulnerabilities into the asset library. Prefer full URLs for host_port (http/https, port, path); bare IP / IP:port scan data is not accepted. host is a plain host and may be omitted. Prefer structured interfaces[] (path required; method / params / raw request optional); legacy interface_dir arrays are normalized to { path }. Static JS/CSS/images are not interfaces. test_parameters[] records non-secret seeds collected after login (id / orderId / tenantId, a few sample values plus a pattern; never passwords/tokens/PII). Read the existing asset first, then choose replace (full snapshot) or merge (incremental).'
    },
    input: {
      zh: 'AssetContextPayload（含 interfaces[]、test_parameters[] 与兼容的 interface_dir[]）+ { mode?: "replace" | "merge" }',
      en: 'AssetContextPayload (interfaces[], test_parameters[], compatible interface_dir[]) + { mode?: "replace" | "merge" }'
    },
    returns: {
      zh: '{ success: true, host_port, created, mode, message }',
      en: '{ success: true, host_port, created, mode, message }'
    }
  },
  {
    name: 'query_asset_context',
    title: { zh: '查询资产上下文', en: 'Query asset context' },
    description: {
      zh: '只读查询入口，二选一：传 host_port 返回该资产的完整上下文（项目名、技术栈、interfaces[]、test_parameters[]、敏感泄露、关联漏洞）；传 project_name 模糊查询返回资产数组。开始测试前用于复用已有侦察成果。',
      en: 'Read-only lookup, one of two modes: host_port returns the full asset context (project, tech stack, interfaces[], test_parameters[], leaked info, related vulnerabilities); project_name performs a fuzzy lookup and returns an asset array. Use it before testing to reuse existing recon.'
    },
    input: {
      zh: '{ host_port?: string, project_name?: string }（二选一）',
      en: '{ host_port?: string, project_name?: string } (one of them)'
    },
    returns: {
      zh: 'host_port: 完整 AssetContext；project_name: AssetContext[]',
      en: 'host_port: full AssetContext; project_name: AssetContext[]'
    }
  },
  {
    name: 'manage_snapshot',
    title: { zh: '管理认知快照会话', en: 'Manage cognitive snapshot sessions' },
    description: {
      zh: '单任务单会话的认知快照：保存战术进度、未完成线索、失败路径与下一步，新会话可恢复上下文。action=save（创建/局部更新，会话已存在时先让用户选择继续或新建）、load（按 session_id 读取一条完整会话）、list（返回摘要，供选择会话）、attach_assets（把 hosts 并入会话目标资产）、restore_previous（回滚上一次覆盖）。',
      en: 'One cognitive snapshot per task: tactical progress, unfinished leads, failed paths and next steps can be restored in a new session. action=save (create/partial update; ask the user to continue or create a new session when one exists), load (one full session by session_id), list (summaries for selection), attach_assets (merge hosts into the session targets), restore_previous (roll back the latest overwrite).'
    },
    input: {
      zh: '{ action: "save" | "load" | "list" | "attach_assets" | "restore_previous", session_id?, payload?: { project_name, target_hosts, current_phase, unfinished_tasks, failed_paths, next_steps }, force_new?, base_updated_at?, keyword?, hosts?, limit? }',
      en: '{ action: "save" | "load" | "list" | "attach_assets" | "restore_previous", session_id?, payload?: { project_name, target_hosts, current_phase, unfinished_tasks, failed_paths, next_steps }, force_new?, base_updated_at?, keyword?, hosts?, limit? }'
    },
    returns: {
      zh: 'save: { success, action, created, session } | { success:false, requires_choice:true, candidates[] }；load/attach_assets/restore_previous: { success, action, session }；list: { success, action, total, items[] }',
      en: 'save: { success, action, created, session } | { success:false, requires_choice:true, candidates[] }; load/attach_assets/restore_previous: { success, action, session }; list: { success, action, total, items[] }'
    }
  }
] as const

export type { Severity, VulnStatus }
