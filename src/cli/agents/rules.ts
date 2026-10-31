import type { AgentId, FilePlan } from './index'
import {
  ASSET_MARKERS,
  LEGACY_ASSET_MARKERS,
  LEGACY_RULE_MARKERS,
  RULE_MARKERS,
  blockDiffLines,
  capDiffLines,
  extractMarkerBlock,
  findMarkerRange,
  upsertMarkerBlock,
  type MarkerPair
} from './markers'

/**
 * System-level hard rules written into an agent's global instruction file
 * (`~/.dsh/AGENTS.md`, `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`).
 *
 * `ctx init` owns two marker-delimited blocks (`CORTEX` for the vulnerability
 * enforcement rules, `CORTEX-ASSET` for the asset/snapshot rules). This wording
 * is the single source of the 2.0 rules: the MCP server is **launched over
 * stdio by the agent**, so the SSE-era instructions ("start the desktop app
 * first", "restart DSH when disconnected", "MCP listening") are gone. Tool
 * duties, snapshot layering and asset/parameter rules are unchanged, only the
 * product/CLI/tool-prefix names are Cortex/`ctx`/`mcp__cortex__`.
 */

export const LEGACY_VULN_HEADING = '## 漏洞入库：确认即写库（硬性）'

export const ENFORCEMENT_RULE = `## Cortex 强制入库规则（硬性）

任何**确认的漏洞**或**复测得出新结论**，必须在回复用户之前完成入库：

1. 先调用 \`query_vulnerabilities({ host })\` 查重（新 host / 新测试必做）。
2. 再调用 \`save_vulnerability\` 写入；证据不足但值得留痕的结论以 \`status: "Inconclusive"\` 写入。
3. 需要完整漏洞记录时用 \`query_vulnerabilities({ vuln_id })\`。
4. 复测已有漏洞只用 \`update_vulnerability({ vuln_id, retest: { time_range, conclusion } })\` 追加 Markdown 结论，不要用 \`save_vulnerability\` 覆盖原始证据；只做状态流转用 \`update_vulnerability({ vuln_id, status })\`。
5. 未成功调用入库工具前，不得声称任务完成，不得只输出报告而不入库。
6. MCP 由 Agent 自动拉起（stdio），无需启动 GUI；GUI 只是查看端，可随时开关。工具缺失 / \`server is disconnected\` 时运行 \`ctx doctor\` 并重启 Agent（不是重启 GUI）；恢复后补录，**禁止静默跳过**。
7. 用户当轮明确说“不用入库 / 只是看看”时，以用户指令为准。

字段与 Markdown \`reproduction_steps\` 规范以技能 \`vuln-db\` 为准。`

export const ASSET_ENFORCEMENT_RULE = `## 资产上下文同步规则（硬性）

Cortex 通过 MCP 常驻 6 个工具（DSH 前缀为 \`mcp__cortex__\`）：

- 漏洞：\`save_vulnerability\` / \`query_vulnerabilities\` / \`update_vulnerability\`
- 资产：\`sync_asset_info\` / \`query_asset_context\`
- 认知快照：\`manage_snapshot\`

完成 JS 审计、指纹识别、接口抓包、目录扫描等信息收集后，必须把 Web 资产上下文沉淀到 Cortex：

1. 先调用 \`query_asset_context({ host_port })\`（或 \`{ project_name }\`）读取已有资产，避免重复侦察和覆盖旧信息。
2. 再调用 \`sync_asset_info\` 写入本次的指纹、接口、敏感泄露、测试参数与关联漏洞；完整快照用 \`mode: "replace"\`，增量发现用 \`mode: "merge"\`。
3. 接口优先写结构化 \`interfaces[]\`：\`path\` 必填，\`method\` / \`params\` / \`request\` 可选；\`request\` 必须是完整原始 HTTP 请求（请求行 + Host/headers + 可选 body），不是路径。JS 审计/抓包后逐条补全。旧版 \`interface_dir\` 字符串数组仅用于向后兼容，服务端会规范化为 \`{ path }\`，不会报错也不丢数据。
4. \`host_port\` 优先传完整 URL（支持 http/https、端口、登录页/业务路径）；\`host\` 是纯 host，可省略由服务端推导。单独 IP / IP:端口 的端口扫描、服务发现数据不支持入库，IP 资产必须使用完整 http(s) URL。
5. JS/CSS/图片等静态文件不是接口，只能作为泄露来源/证据记录，不要写进 \`interfaces\` 或 \`interface_dir\`。
6. \`tech_stack\` 用明确分隔符（\`,\` / \`，\` / \`;\` / \`；\` / \`、\` / 换行）逐项书写，每个技术独立，不要用一串省略号拼接。
7. 登录后从响应 / URL / JS 收集到的 id / orderId / tenantId 等**非密测试参数**写入 \`test_parameters\`（\`name\` / \`endpoint\` / \`location\` / \`values\` 只放 ≤50 个样例 + \`pattern\`，禁止整段数据），不要塞进 \`leaked_infos\`；密码 / Token / AK/SK / PII 仍入 \`leaked_infos\`。
8. 发现敏感信息必须逐条记录 \`source\` 与 \`potential_impact\`，不要只写“发现 Key”。
9. 漏洞写入后把漏洞 ID 关联到对应资产；MCP 由 Agent 自动拉起（stdio），无需启动 GUI；GUI 只是查看端，可随时开关。
10. 工具缺失 / \`server is disconnected\` 时运行 \`ctx doctor\` 并重启 Agent（不是重启 GUI）；MCP 不可用时禁止静默跳过。
11. 复测已有漏洞只用 \`update_vulnerability({ vuln_id, retest: { time_range, conclusion } })\` 追加 \`time_range\` + Markdown \`conclusion\`；不要用 \`save_vulnerability\` 覆盖原始描述、影响、复现步骤、修复建议或测试边界。

### 认知快照（硬性）

1. 新会话继续已有任务前，先用 \`manage_snapshot\` 的 \`list\` → \`load\` 恢复战术进度（先 list 项目会话，再 load 选中的子会话；一次只 load 一条完整会话），不要凭记忆假设上下文。
2. 阶段完成、上下文将满、会话结束或用户要求保存进度时，用 \`manage_snapshot\` 的 \`save\` 保存认知快照；大型 SRC 按「项目会话（root）→ 系统子会话（一层）」组织，子会话创建时传 \`parent_session_id\`，新建前先 \`list\` 确认项目。
3. 同一任务不要并行维护多个同级会话；同项目已有会话时，不带 \`session_id\` 的 \`save\` 会返回 \`SESSION_EXISTS\` 候选，必须让用户选择「继续已有会话」或「新建会话（force_new: true）」，禁止自行猜测；大型 SRC 按第 2 条用项目会话 + 系统子会话组织。
4. 价值门槛：只给 scope 内、HTTP 可达、有真实攻击面（登录 / API / 上传 / 后台 / SSO / 敏感数据）且有复用价值的目标入资产库 / 建子会话；不可达、停放页、默认页、纯静态 / CDN、重复域、越界目标不入库、不建会话，排除项汇总进项目会话 \`notes\` 的范围台账，禁止一个 host 建一个子会话。
5. 目标 Host 归属用 \`attach_assets\` 并入会话；已完成事项不要留在 \`unfinished_tasks\`（数组整体替换）。
6. 归档 / 取消归档 / 删除只在桌面端 UI 操作，Agent 不调用（MCP 无此 action）；归档会话默认不显示、不可 save / attach / restore，需提示用户在 UI 取消归档。
7. 细节证据分工：漏洞详情 / HTTP 报文 / 复现步骤 / 修复建议入漏洞库（\`save_vulnerability\`），接口目录 / 完整原始请求 / 技术栈 / 敏感泄露入资产库（\`sync_asset_info\`）；快照只放测试结论（\`tested_interfaces\`）、\`notes\` 备注与 \`related_vuln_ids\` 引用，大段报文/截图不要进快照（\`notes\` 只放路径引用），整体 payload ≤32,000 字符。
8. MCP 由 Agent 自动拉起（stdio），无需启动 GUI；工具缺失 / \`server is disconnected\` 时运行 \`ctx doctor\` 并重启 Agent（不是重启 GUI），禁止静默跳过。

字段规范以技能 \`asset-context\`、\`snapshot\` 为准；漏洞字段规范以 \`vuln-db\` 为准。`

export interface RuleBlockSpec {
  markers: MarkerPair
  /** Pre-rename pair, upgraded in place on the first Cortex run. */
  legacyMarkers: MarkerPair
  body: string
}
export const VULN_RULE_SPEC: RuleBlockSpec = {
  markers: RULE_MARKERS,
  legacyMarkers: LEGACY_RULE_MARKERS,
  body: ENFORCEMENT_RULE
}
export const ASSET_RULE_SPEC: RuleBlockSpec = {
  markers: ASSET_MARKERS,
  legacyMarkers: LEGACY_ASSET_MARKERS,
  body: ASSET_ENFORCEMENT_RULE
}
export const RULE_SPECS: readonly RuleBlockSpec[] = [VULN_RULE_SPEC, ASSET_RULE_SPEC]

export function buildRuleBlock(spec: RuleBlockSpec): string {
  return `${spec.markers.begin}\n${spec.body}\n${spec.markers.end}`
}

/**
 * Remove the unmarked legacy vuln-db enforcement section written by
 * pre-marker installers. Once the managed block exists it owns that content;
 * the legacy copy would otherwise keep stale tool names next to fresh rules.
 * Kept pure and idempotent.
 */
export function removeLegacyVulnSection(content: string): string {
  const legacyStart = content.indexOf(LEGACY_VULN_HEADING)
  if (legacyStart === -1) return content

  const managed =
    findMarkerRange(content, RULE_MARKERS) ?? findMarkerRange(content, LEGACY_RULE_MARKERS)
  const insideManagedBlock =
    managed !== null && legacyStart > managed.start && legacyStart < managed.end
  if (insideManagedBlock) return content

  const rest = content.slice(legacyStart)
  const lines = rest.split('\n')
  let endOffset = rest.length
  let offset = 0
  for (let index = 1; index < lines.length; index += 1) {
    offset += (lines[index - 1] ?? '').length + 1
    const line = lines[index] ?? ''
    if (/^##\s+/.test(line) || /<!--\s*(?:CORTEX|PENTEST)[- ]/.test(line)) {
      endOffset = offset
      break
    }
  }

  return `${content.slice(0, legacyStart)}${content.slice(legacyStart + endOffset)}`
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/** Current rules file rewritten to own both marker blocks (legacy section removed). */
export function applyRules(content: string): string {
  let next = removeLegacyVulnSection(content)
  for (const spec of RULE_SPECS) {
    next = upsertMarkerBlock(next, buildRuleBlock(spec), spec.markers, {
      legacyMarkers: spec.legacyMarkers
    }).content
  }
  return next
}

export interface RuleFileOptions {
  agent: AgentId
  path: string
  exists: (filePath: string) => boolean
  readFile: (filePath: string) => string
}

/**
 * Plan the rules file for one agent: legacy cleanup + both marker blocks in a
 * single candidate, so a dry run can show the diff before anything is written.
 */
export function planRuleFile(options: RuleFileOptions): FilePlan {
  const existed = options.exists(options.path)
  const current = existed ? options.readFile(options.path) : ''
  const candidate = applyRules(current)

  if (existed && candidate === current) {
    return { agent: options.agent, kind: 'rule', path: options.path, status: 'skipped', detail: '内容已最新' }
  }

  const diffLines: string[] = []
  if (current.includes(LEGACY_VULN_HEADING) && !candidate.includes(LEGACY_VULN_HEADING)) {
    diffLines.push(`- ${LEGACY_VULN_HEADING}`)
  }
  for (const spec of RULE_SPECS) {
    const oldBlock =
      extractMarkerBlock(current, spec.markers) ??
      extractMarkerBlock(current, spec.legacyMarkers)
    diffLines.push(...blockDiffLines(oldBlock, buildRuleBlock(spec)))
  }

  return {
    agent: options.agent,
    kind: 'rule',
    path: options.path,
    status: existed ? 'updated' : 'created',
    diff: capDiffLines(diffLines, 80),
    content: candidate
  }
}
