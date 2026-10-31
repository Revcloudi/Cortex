#!/usr/bin/env node
/**
 * Cortex — legacy one-command agent integration (deprecated compatibility entry).
 *
 * Usage:
 *   node scripts/install-agent.mjs <dsh|codex|claude|all>
 *
 * Prefer the unified `ctx init` command (`npm run agent:dsh|agent:codex|
 * agent:claude|agent:all` wrap it). This script is kept so existing workflows
 * that call `npm run install:agent` keep working; it writes the same stdio MCP
 * registration, skills and hard rules with Cortex branding and CORTEX markers,
 * migrating blocks left behind by pre-rename (`PENTEST-DATA-HUB`) installs.
 *
 * Each target performs three mandatory steps:
 *   1. Register the MCP server (DSH: cordis.patch.yml / Codex: config.toml / Claude: claude mcp add)
 *   2. Install the vuln-db / asset-context / snapshot skills into the agent's skills directory
 *   3. Write the hard rules for "vulnerability recording + asset sync + cognitive snapshots" into the agent's system-level instruction file
 *
 * Layout notes:
 * - The MCP server is **stdio-only** and launched directly by the agent:
 *   development `<node> <project>/out/mcp/stdio.cjs`; installed builds use
 *   `<install>\bin\node.exe` + `<install>\bin\mcp-stdio.cjs` on Windows and
 *   `Cortex.app/Contents/bin/node` + `Cortex.app/Contents/bin/mcp-stdio.cjs`
 *   on macOS. No resident desktop app, port or bridge script is needed.
 * - The shared database lives at `~/.cortex/data.db` (override with `CTX_DB_PATH`).
 * - Existing config is preserved: only marker-delimited blocks are appended or
 *   replaced, so repeated runs are idempotent.
 * - Set `CTX_INSTALL_HOME` (legacy fallback `PDH_INSTALL_HOME`) to a temporary
 *   home directory to test the install logic.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..')
const MCP_ENTRY = join(PROJECT_ROOT, 'out', 'mcp', 'stdio.cjs')
const CLI_ENTRY = join(PROJECT_ROOT, 'out', 'cli', 'ctx.cjs')
const SKILL_NAMES = ['vuln-db', 'asset-context', 'snapshot']
const SKILL_LANG = resolveSkillLang()
const SKILLS = SKILL_NAMES.map((name) => ({ name, source: resolveSkillSource(name) }))
const HOME = process.env.CTX_INSTALL_HOME || process.env.PDH_INSTALL_HOME || homedir()
const NODE = process.execPath

/** Markers written by Cortex 2.0 (`ctx init`, this script). */
/**
 * Marker banners written by Cortex 2.0. The trailing dashes are cosmetic: the
 * helpers match by *prefix*, because `ctx init` (src/cli/agents/markers.ts) and
 * this legacy script may render a different number of box-drawing dashes. An
 * exact-match comparison once produced a duplicate `mcp-cortex` entry when the
 * two implementations disagreed by one dash.
 */
const MCP_BEGIN_PREFIX = '# ── CORTEX BEGIN'
const MCP_END_PREFIX = '# ── CORTEX END'
const LEGACY_MCP_BEGIN_PREFIX = '# ── PENTEST-DATA-HUB BEGIN'
const LEGACY_MCP_END_PREFIX = '# ── PENTEST-DATA-HUB END'
const BEGIN = `${MCP_BEGIN_PREFIX} ─────────────────────────────────────────────`
const END = `${MCP_END_PREFIX} ───────────────────────────────────────────────`
const RULE_BEGIN = '<!-- CORTEX BEGIN -->'
const RULE_END = '<!-- CORTEX END -->'
const ASSET_RULE_BEGIN = '<!-- CORTEX-ASSET BEGIN -->'
const ASSET_RULE_END = '<!-- CORTEX-ASSET END -->'

/** Pre-rename markers, migrated in place when found. */
const LEGACY_RULE_BEGIN = '<!-- PENTEST-DATA-HUB BEGIN -->'
const LEGACY_RULE_END = '<!-- PENTEST-DATA-HUB END -->'
const LEGACY_ASSET_BEGIN = '<!-- PENTEST-ASSET BEGIN -->'
const LEGACY_ASSET_END = '<!-- PENTEST-ASSET END -->'

/** Unmarked pre-2.0 registrations that cannot be edited safely. */
const LEGACY_MCP_TOKENS = [
  'mcp-pentest-data-hub',
  '[mcp_servers.pentest_data_hub]',
  'serverName: pentest_hub'
]

/** Heading used by installs from before the rule blocks were marker-managed. */
const LEGACY_VULN_HEADING = '## 漏洞入库：确认即写库（硬性）'

const MCP_MARKERS = { banner: true, beginPrefix: MCP_BEGIN_PREFIX, endPrefix: MCP_END_PREFIX }
const LEGACY_MCP_MARKERS = {
  banner: true,
  beginPrefix: LEGACY_MCP_BEGIN_PREFIX,
  endPrefix: LEGACY_MCP_END_PREFIX
}
const RULE_MARKERS = { begin: RULE_BEGIN, end: RULE_END }
const ASSET_MARKERS = { begin: ASSET_RULE_BEGIN, end: ASSET_RULE_END }
const LEGACY_RULE_MARKERS = { begin: LEGACY_RULE_BEGIN, end: LEGACY_RULE_END }
const LEGACY_ASSET_MARKERS = { begin: LEGACY_ASSET_BEGIN, end: LEGACY_ASSET_END }

const ENFORCEMENT_RULE = `## Cortex 强制入库规则（硬性）

任何**确认的漏洞**或**复测得出新结论**，必须在回复用户之前完成入库：

1. 先调用 \`query_vulnerabilities({ host })\` 查重（新 host / 新测试必做）。
2. 再调用 \`save_vulnerability\` 写入；证据不足但值得留痕的结论以 \`status: "Inconclusive"\` 写入。
3. 需要完整漏洞记录时用 \`query_vulnerabilities({ vuln_id })\`。
4. 复测已有漏洞只用 \`update_vulnerability({ vuln_id, retest: { time_range, conclusion } })\` 追加 Markdown 结论，不要用 \`save_vulnerability\` 覆盖原始证据；只做状态流转用 \`update_vulnerability({ vuln_id, status })\`。
5. 未成功调用入库工具前，不得声称任务完成，不得只输出报告而不入库。
6. MCP 不可用（工具缺失 / \`server is disconnected\`）时，运行 \`ctx doctor\` 检查 Agent 的 stdio MCP 配置并重启 Agent（不是重启 GUI），恢复后补录；**禁止静默跳过**。
7. 用户当轮明确说“不用入库 / 只是看看”时，以用户指令为准。

字段与 Markdown \`reproduction_steps\` 规范以技能 \`vuln-db\` 为准。`

const ASSET_ENFORCEMENT_RULE = `## 资产上下文同步规则（硬性）

Cortex 通过 MCP 常驻 6 个工具（DSH 前缀为 \`mcp__cortex__\`）：

- 漏洞：\`save_vulnerability\` / \`query_vulnerabilities\` / \`update_vulnerability\`
- 资产：\`sync_asset_info\` / \`query_asset_context\`
- 认知快照：\`manage_snapshot\`

完成 JS 审计、指纹识别、接口抓包、目录扫描等信息收集后，必须把 Web 资产上下文沉淀到 Cortex（\`~/.cortex/data.db\`）：

1. 先调用 \`query_asset_context({ host_port })\`（或 \`{ project_name }\`）读取已有资产，避免重复侦察和覆盖旧信息。
2. 再调用 \`sync_asset_info\` 写入本次的指纹、接口、敏感泄露、测试参数与关联漏洞；完整快照用 \`mode: "replace"\`，增量发现用 \`mode: "merge"\`。
3. 接口优先写结构化 \`interfaces[]\`：\`path\` 必填，\`method\` / \`params\` / \`request\` 可选；\`request\` 必须是完整原始 HTTP 请求（请求行 + Host/headers + 可选 body），不是路径。JS 审计/抓包后逐条补全。旧版 \`interface_dir\` 字符串数组仅用于向后兼容，服务端会规范化为 \`{ path }\`，不会报错也不丢数据。
4. \`host_port\` 优先传完整 URL（支持 http/https、端口、登录页/业务路径）；\`host\` 是纯 host，可省略由服务端推导。单独 IP / IP:端口 的端口扫描、服务发现数据不支持入库，IP 资产必须使用完整 http(s) URL。
5. JS/CSS/图片等静态文件不是接口，只能作为泄露来源/证据记录，不要写进 \`interfaces\` 或 \`interface_dir\`。
6. \`tech_stack\` 用明确分隔符（\`,\` / \`，\` / \`;\` / \`；\` / \`、\` / 换行）逐项书写，每个技术独立，不要用一串省略号拼接。
7. 登录后从响应 / URL / JS 收集到的 id / orderId / tenantId 等**非密测试参数**写入 \`test_parameters\`（\`name\` / \`endpoint\` / \`location\` / \`values\` 只放 ≤50 个样例 + \`pattern\`，禁止整段数据），不要塞进 \`leaked_infos\`；密码 / Token / AK/SK / PII 仍入 \`leaked_infos\`。
8. 发现敏感信息必须逐条记录 \`source\` 与 \`potential_impact\`，不要只写“发现 Key”。
9. 漏洞写入后把漏洞 ID 关联到对应资产；MCP 由 Agent 自动拉起（stdio），无需启动 GUI；若工具缺失或显示 \`server is disconnected\`，运行 \`ctx doctor\` 检查配置并重启 Agent。
10. 若 \`cortex\` 显示 \`server is disconnected\`，先运行 \`ctx doctor\` 检查 Agent 的 stdio MCP 配置（开发：\`out/mcp/stdio.cjs\`，Windows 安装版：\`<install>\\bin\\mcp-stdio.cjs\`，macOS 安装版：\`Cortex.app/Contents/bin/mcp-stdio.cjs\`），再重启 DSH（不只是新开对话）；不需要启动/重启桌面端。
11. 复测已有漏洞只用 \`update_vulnerability({ vuln_id, retest: { time_range, conclusion } })\` 追加 \`time_range\` + Markdown \`conclusion\`；不要用 \`save_vulnerability\` 覆盖原始描述、影响、复现步骤、修复建议或测试边界。

### 认知快照（硬性）

1. 新会话继续已有任务前，先用 \`manage_snapshot\` 的 \`list\` → \`load\` 恢复战术进度（先 list 项目会话，再 load 选中的子会话；一次只 load 一条完整会话），不要凭记忆假设上下文。
2. 阶段完成、上下文将满、会话结束或用户要求保存进度时，用 \`manage_snapshot\` 的 \`save\` 保存认知快照；大型 SRC 按「项目会话（root）→ 系统子会话（一层）」组织，子会话创建时传 \`parent_session_id\`，新建前先 \`list\` 确认项目。
3. 同一任务不要并行维护多个同级会话；同项目已有会话时，不带 \`session_id\` 的 \`save\` 会返回 \`SESSION_EXISTS\` 候选，必须让用户选择「继续已有会话」或「新建会话（force_new: true）」，禁止自行猜测；大型 SRC 按第 2 条用项目会话 + 系统子会话组织。
4. 价值门槛：只给 scope 内、HTTP 可达、有真实攻击面（登录 / API / 上传 / 后台 / SSO / 敏感数据）且有复用价值的目标入资产库 / 建子会话；不可达、停放页、默认页、纯静态 / CDN、重复域、越界目标不入库、不建会话，排除项汇总进项目会话 \`notes\` 的范围台账，禁止一个 host 建一个子会话。
5. 目标 Host 归属用 \`attach_assets\` 并入会话；已完成事项不要留在 \`unfinished_tasks\`（数组整体替换）。
6. 归档 / 取消归档 / 删除只在桌面端 UI 操作，Agent 不调用（MCP 无此 action）；归档会话默认不显示、不可 save / attach / restore，需提示用户在 UI 取消归档。
7. 细节证据分工：漏洞详情 / HTTP 报文 / 复现步骤 / 修复建议入漏洞库（\`save_vulnerability\`），接口目录 / 完整原始请求 / 技术栈 / 敏感泄露入资产库（\`sync_asset_info\`）；快照只放测试结论（\`tested_interfaces\`）、\`notes\` 备注与 \`related_vuln_ids\` 引用，大段报文/截图不要进快照（\`notes\` 只放路径引用），整体 payload ≤32,000 字符。
8. MCP 由 Agent 自动拉起（stdio），无需启动 GUI；MCP 不可用时运行 \`ctx doctor\` 检查配置并重启 Agent，禁止静默跳过。

字段规范以技能 \`asset-context\`、\`snapshot\` 为准；漏洞字段规范以 \`vuln-db\` 为准。`

const args = process.argv.slice(2)
const target = (args[0] || '').toLowerCase()
const validTargets = new Set(['dsh', 'codex', 'claude', 'all'])

if (!validTargets.has(target)) {
  console.error('用法: node scripts/install-agent.mjs <dsh|codex|claude|all>')
  console.error('推荐: ctx init（安装版）或 npm run agent:dsh | agent:codex | agent:claude | agent:all')
  process.exit(1)
}

/** Skill language: `CTX_SKILL_LANG` then legacy `PDH_SKILL_LANG`, default `zh`. */
function resolveSkillLang() {
  const raw = (process.env.CTX_SKILL_LANG || process.env.PDH_SKILL_LANG || 'zh').trim().toLowerCase()
  if (raw === 'zh' || raw === 'en') return raw
  console.warn(`[install-agent] 未知技能语言 "${raw}"，回退 zh`)
  return 'zh'
}

/** `skills/<lang>/<name>.skill.md`, falling back to `skills/zh` when empty. */
function resolveSkillSource(name) {
  const preferred = join(PROJECT_ROOT, 'skills', SKILL_LANG, `${name}.skill.md`)
  if (existsSync(preferred)) return preferred
  const fallback = join(PROJECT_ROOT, 'skills', 'zh', `${name}.skill.md`)
  if (existsSync(fallback)) {
    console.warn(`[install-agent] ${SKILL_LANG} 技能缺失，回退中文: ${preferred}`)
    return fallback
  }
  return preferred
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * Locate a marker-managed block. `banner` markers match by line prefix (the
 * trailing dashes are cosmetic), HTML comment markers match exactly.
 */
function findMarkerRange(content, markers) {
  if (markers.banner === true) {
    const start = content.indexOf(markers.beginPrefix)
    if (start === -1) return null
    const endMarker = content.indexOf(markers.endPrefix, start + markers.beginPrefix.length)
    if (endMarker === -1) return null
    const lineEnd = content.indexOf('\n', endMarker)
    return { start, end: lineEnd === -1 ? content.length : lineEnd }
  }
  const start = content.indexOf(markers.begin)
  if (start === -1) return null
  const finish = content.indexOf(markers.end, start + markers.begin.length)
  if (finish === -1) return null
  return { start, end: finish + markers.end.length }
}

function hasMarkerPair(content, markers) {
  return findMarkerRange(content, markers) !== null
}

function appendBlock(path, block, markers) {
  const current = readText(path)
  if (hasMarkerPair(current, markers)) return { path, status: 'skipped' }
  ensureDir(dirname(path))
  const separator = current.length > 0 && !current.endsWith('\n') ? '\n\n' : '\n'
  writeFileSync(path, `${current}${separator}${block.trim()}\n`, 'utf8')
  return { path, status: 'written' }
}

/** Replace an existing marker-delimited block, or append it if absent. */
function replaceBlock(path, block, markers) {
  const current = readText(path)
  const range = findMarkerRange(current, markers)
  if (range === null) return appendBlock(path, block, markers)
  ensureDir(dirname(path))
  const next = `${current.slice(0, range.start)}${block.trim()}${current.slice(range.end)}`
  writeFileSync(path, next, 'utf8')
  return { path, status: 'updated' }
}

/** Delete a marker-managed block (used to clean up migrated PENTEST leftovers). */
function removeMarkerBlock(path, markers) {
  const current = readText(path)
  const range = findMarkerRange(current, markers)
  if (range === null) return false
  const next = `${current.slice(0, range.start)}${current.slice(range.end)}`
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  writeFileSync(path, next.length > 0 ? `${next}\n` : '', 'utf8')
  return true
}

/**
 * Collapse extra copies of the same managed block. Two implementations (this
 * legacy script and `ctx init`) may have written slightly different marker
 * banners before marker matching became prefix-based; only the first block is
 * kept so a YAML/TOML file never carries two registrations for one server id.
 */
function removeDuplicateManagedBlocks(path, markers) {
  let removed = 0
  for (let guard = 0; guard < 5; guard += 1) {
    const current = readText(path)
    const first = findMarkerRange(current, markers)
    if (first === null) break
    const second = findMarkerRange(current.slice(first.end), markers)
    if (second === null) break
    const from = first.end + second.start
    const to = first.end + second.end
    const next = `${current.slice(0, from)}${current.slice(to)}`.replace(/\n{3,}/g, '\n\n')
    writeFileSync(path, next, 'utf8')
    removed += 1
  }
  return removed
}

/**
 * Idempotent marker-block upsert with pre-rename migration.
 *
 * - a CORTEX block is replaced in place (and stale PENTEST/duplicate blocks removed);
 * - a PENTEST marker block from an older install is replaced by the CORTEX
 *   block, so upgrades do not duplicate entries;
 * - an unmarked pre-2.0 MCP registration is reported as manual work instead of
 *   producing a duplicate YAML/TOML entry.
 */
function upsertManagedBlock(path, block, markers, legacyMarkers, legacyTokens = []) {
  const current = readText(path)
  if (hasMarkerPair(current, markers)) {
    const result = replaceBlock(path, block, markers)
    const removedLegacy = legacyMarkers !== undefined && removeMarkerBlock(path, legacyMarkers)
    const removedDuplicates = removeDuplicateManagedBlocks(path, markers)
    if (removedLegacy || removedDuplicates > 0) {
      const parts = []
      if (removedLegacy) parts.push('移除旧 PENTEST 标记块')
      if (removedDuplicates > 0) parts.push(`合并 ${removedDuplicates} 个重复 CORTEX 块`)
      return { path, status: 'migrated', detail: parts.join('；') }
    }
    return result
  }
  if (legacyMarkers !== undefined && hasMarkerPair(current, legacyMarkers)) {
    const result = replaceBlock(path, block, legacyMarkers)
    removeDuplicateManagedBlocks(path, markers)
    return { path, status: 'migrated', detail: '已把旧 PENTEST 标记块迁移为 CORTEX 标记块' }
  }
  if (legacyTokens.length > 0 && legacyTokens.some((token) => current.includes(token))) {
    return {
      path,
      status: 'manual-required',
      detail: '检测到未带 CORTEX 标记的旧 MCP 条目，请删除旧条目后重跑本脚本'
    }
  }
  const result = appendBlock(path, block, markers)
  removeDuplicateManagedBlocks(path, markers)
  return result
}

function installSkillSet(extraRoot) {
  const targets = []
  for (const skill of SKILLS) {
    if (!existsSync(skill.source)) {
      throw new Error(`找不到技能文件: ${skill.source}`)
    }
    const content = readFileSync(skill.source, 'utf8')
    const paths = [join(HOME, '.agents', 'skills', skill.name, 'SKILL.md')]
    if (extraRoot) paths.push(join(extraRoot, skill.name, 'SKILL.md'))
    for (const targetPath of paths) {
      ensureDir(dirname(targetPath))
      writeFileSync(targetPath, content, 'utf8')
    }
    targets.push(...paths)
  }
  return targets
}

function enforcementBlocks() {
  return [
    {
      path: null,
      block: `${RULE_BEGIN}\n${ENFORCEMENT_RULE}\n${RULE_END}`,
      markers: RULE_MARKERS,
      legacyMarkers: LEGACY_RULE_MARKERS
    },
    {
      path: null,
      block: `${ASSET_RULE_BEGIN}\n${ASSET_ENFORCEMENT_RULE}\n${ASSET_RULE_END}`,
      markers: ASSET_MARKERS,
      legacyMarkers: LEGACY_ASSET_MARKERS
    }
  ]
}

/**
 * Remove the unmarked "漏洞入库" section written by older installers. Once a
 * marker-managed rule block exists it owns that content; leaving the legacy copy
 * behind would keep stale tool names next to the fresh rules. Idempotent.
 */
function removeLegacyVulnSection(path) {
  const current = readText(path)
  const legacyStart = current.indexOf(LEGACY_VULN_HEADING)
  if (legacyStart === -1) return

  const markerStart = current.indexOf(RULE_BEGIN)
  const markerEnd = current.indexOf(RULE_END)
  const insideManagedBlock =
    markerStart !== -1 &&
    legacyStart > markerStart &&
    (markerEnd === -1 || legacyStart < markerEnd)
  if (insideManagedBlock) return

  const rest = current.slice(legacyStart)
  const lines = rest.split('\n')
  let endOffset = rest.length
  let offset = 0
  for (let index = 1; index < lines.length; index += 1) {
    offset += lines[index - 1].length + 1
    const line = lines[index]
    if (/^##\s+/.test(line) || line.includes('<!-- CORTEX') || line.includes('<!-- PENTEST-')) {
      endOffset = offset
      break
    }
  }

  const next = `${current.slice(0, legacyStart)}${current.slice(legacyStart + endOffset)}`
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  if (next !== current) writeFileSync(path, `${next}\n`, 'utf8')
}

function installRules(path) {
  const blocks = enforcementBlocks()
  removeLegacyVulnSection(path)
  return blocks.map((entry) =>
    upsertManagedBlock(entry.path ?? path, entry.block, entry.markers, entry.legacyMarkers)
  )
}

function yamlPath(value) {
  return `'${String(value).replace(/\\/g, '/').replace(/'/g, "''")}'`
}

function installDsh() {
  const sandboxHome = process.env.CTX_INSTALL_HOME || process.env.PDH_INSTALL_HOME
  const dshHome = sandboxHome ? join(HOME, '.dsh') : process.env.DSH_HOME || join(HOME, '.dsh')
  const profilesRoot = join(dshHome, 'profiles')
  let profile = process.env.DSH_PROFILE || 'desktop'
  if (!existsSync(join(profilesRoot, profile))) {
    const first = existsSync(profilesRoot)
      ? readdirSync(profilesRoot, { withFileTypes: true }).find((entry) => entry.isDirectory())?.name
      : undefined
    if (first) profile = first
  }
  const patchPath = join(profilesRoot, profile, 'cordis.patch.yml')
  const mcpBlock = `${BEGIN}
# Cortex 2.0：纯 stdio MCP，由 DSH 直接拉起（无端口、无桥接、无需先开 GUI）。
# 工具名形如 mcp__cortex__save_vulnerability；数据库 ~/.cortex/data.db。
- insert:
    - id: mcp-cortex
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: cortex
        transport: stdio
        command: ${yamlPath(NODE)}
        args:
          - ${yamlPath(MCP_ENTRY)}
        cwd: ${yamlPath(PROJECT_ROOT)}
        toolCallTimeoutMs: 120000
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 60
${END}`

  const mcp = upsertManagedBlock(patchPath, mcpBlock, MCP_MARKERS, LEGACY_MCP_MARKERS, LEGACY_MCP_TOKENS)
  const ruleFile = join(dshHome, 'AGENTS.md')
  const rules = installRules(ruleFile)
  const skills = installSkillSet()
  return { mcp, rules, skills, restart: '重启 DSH（dsh web / 桌面端）后生效（GUI 无需先启动）' }
}

function installCodex() {
  const codexHome = process.env.CODEX_HOME || join(HOME, '.codex')
  const configPath = join(codexHome, 'config.toml')
  const mcpBlock = `${BEGIN}
# Cortex 2.0：纯 stdio MCP，由 Codex 直接拉起；数据库 ~/.cortex/data.db。
[mcp_servers.cortex]
command = ${JSON.stringify(String(NODE).replace(/\\/g, '/'))}
args = [${JSON.stringify(String(MCP_ENTRY).replace(/\\/g, '/'))}]
startup_timeout_sec = 20
tool_timeout_sec = 120
${END}`
  const mcp = upsertManagedBlock(configPath, mcpBlock, MCP_MARKERS, LEGACY_MCP_MARKERS, LEGACY_MCP_TOKENS)

  const skills = installSkillSet(join(codexHome, 'skills'))
  const rulesPath = join(codexHome, 'AGENTS.md')
  const rules = installRules(rulesPath)
  return {
    mcp,
    rules,
    skills,
    restart: '重启 Codex CLI 后生效'
  }
}

function runClaudeCli(args) {
  return spawnSync(process.platform === 'win32' ? 'claude.cmd' : 'claude', args, {
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
}

function installClaude() {
  // Remove both the current registration and the pre-rename one, then add fresh.
  for (const name of ['cortex', 'pentest-data-hub']) {
    if (runClaudeCli(['mcp', 'get', name]).status === 0) {
      runClaudeCli(['mcp', 'remove', name])
    }
  }
  const addArgs = ['mcp', 'add', '--transport', 'stdio', 'cortex', '--', String(NODE), String(MCP_ENTRY)]
  const result = runClaudeCli(addArgs)
  let mcp
  if (result.status === 0) {
    mcp = { path: 'claude mcp add', status: 'written', detail: '已以 stdio 注册到 Claude Code（serverName: cortex）' }
  } else if (result.error) {
    mcp = {
      path: 'claude mcp add',
      status: 'cli-missing',
      detail:
        '未检测到 Claude Code CLI：请先安装（npm install -g @anthropic-ai/claude-code），再运行 npm run agent:claude。Skill 与规则已写入。'
    }
  } else {
    mcp = {
      path: 'claude mcp add',
      status: 'manual-required',
      detail: `${(result.stderr || '').trim() || `请手动执行 claude mcp add --transport stdio cortex -- "${NODE}" "${MCP_ENTRY}"`}`
    }
  }

  const claudeHome = process.env.CLAUDE_HOME || join(HOME, '.claude')
  const skills = installSkillSet(join(claudeHome, 'skills'))
  const rulesPath = join(claudeHome, 'CLAUDE.md')
  const rules = installRules(rulesPath)
  return {
    mcp,
    rules,
    skills,
    restart: '重启 Claude Code 后生效'
  }
}

function printResult(name, result) {
  console.log(`\n=== ${name} ===`)
  console.log(`MCP:  ${result.mcp.path} (${result.mcp.status})`)
  if (result.mcp.detail) console.log(`      ${result.mcp.detail}`)
  for (const rule of result.rules) console.log(`规则: ${rule.path} (${rule.status})`)
  for (const skill of result.skills) console.log(`技能: ${skill}`)
  console.log(`提示: ${result.restart}`)
}

try {
  console.log(
    `[install-agent] 兼容入口（已废弃）：推荐使用 \`ctx init\`；技能语言=${SKILL_LANG}，数据库=~/.cortex/data.db`
  )
  if (target === 'dsh' || target === 'all') printResult('DeepSeek Harness', installDsh())
  if (target === 'codex' || target === 'all') printResult('Codex', installCodex())
  if (target === 'claude' || target === 'all') printResult('Claude Code', installClaude())

  console.log('\n=== 验证 ===')
  const mcpReady = existsSync(MCP_ENTRY)
  const cliReady = existsSync(CLI_ENTRY)
  console.log(`stdio MCP 入口: ${mcpReady ? '就绪' : '缺失'} (${MCP_ENTRY})`)
  console.log(`ctx CLI 入口:   ${cliReady ? '就绪' : '缺失'} (${CLI_ENTRY})`)
  if (!mcpReady) console.log('缺失时请先执行: npm run build:mcp')
  if (!cliReady) console.log('缺失时请先执行: npm run build:cli')
  console.log(
    '提示: 本脚本是 2.0 的兼容入口；推荐使用 `ctx init`（Windows 安装版 %LOCALAPPDATA%\\Programs\\Cortex\\bin\\ctx.cmd，macOS Cortex.app/Contents/bin/ctx）。'
  )
  console.log(
    '快捷命令: npm run install:agent（旧入口）/ npm run agent:dsh | agent:codex | agent:claude | agent:all'
  )
  console.log('\n下一步：重启对应 Agent，使其加载新的 stdio MCP Server / Skill / 强制规则；GUI 无需先启动。')
} catch (error) {
  console.error(`安装失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
