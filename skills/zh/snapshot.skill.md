---
name: snapshot
description: 【硬性】新会话继续任务前先用 manage_snapshot 的 list → load（项目会话 → 子会话）恢复战术进度；阶段完成/上下文将满/会话结束前 save；只给有价值可达目标建子会话；归档/删除只在桌面端操作。
---

# 技能：认知快照（Cognitive Snapshot）

Cortex 的认知快照保存任务的战术进度：项目 / 目标 Host / 阶段、未完成任务、失败路径、下一步，以及结构化接口测试矩阵 `tested_interfaces`、Markdown 备注 `notes`、关联漏洞引用 `related_vuln_ids`。快照只记**战术进度 + 测试结论**，不重复存储漏洞证据与原始报文。

只通过一个工具 `manage_snapshot` 操作（DSH：`mcp__cortex__manage_snapshot`），`action` = `save` / `load` / `list` / `attach_assets` / `restore_previous`；工具总数仍为 6 个。会话不保留历史版本，只保留一版 `previous_state` 供单步回滚；同一项目最多一层子会话，同一任务不要并行维护多个同级会话。

## 层级：项目会话 → 子会话（只一层）

| 层级 | 用途 | 创建方式 |
| --- | --- | --- |
| 项目会话（root） | 大型 SRC / 项目根：范围、排除台账、总进度 | `save` 不带 `parent_session_id` |
| 子会话（child） | 一个系统 / 子项目：独立战术进度 | `save` + `parent_session_id: <root session_id>` |

- 只允许一层：子会话不能再建子会话；`parent_session_id` 只在创建时传，父子关系创建后不改。
- 新建子会话前先 `list({ keyword, roots_only: true })` 确认项目会话；同项目已有会话时按 `SESSION_EXISTS` 让用户选择。
- `load` 项目会话返回 `session` + `children`（子会话摘要）：Agent 把 `children` 摘要给用户选，再 `load` 选中的子会话。

## 价值门槛（防止资产 / 会话爆炸）

只有同时满足 4 条的 Web 资产才 `sync_asset_info` 入库、才建子会话：

1. 在授权 scope 内；2. HTTP 可达（真实页面 / 接口）；3. 有真实业务或攻击面（登录 / API / 上传 / 后台 / SSO / 敏感数据）；4. 有复用或测试价值（后续还会测试 / 交接）。

不符合的一律不入资产库、不建子会话：不可达、停放页、默认页 / 欢迎页、纯静态站、CDN / 静态资源域、重复域（同一系统）、scope 外目标。

- 排除项不逐个建记录：在**项目会话的 `notes`** 维护「范围台账」，汇总原因 / 数量 / 待验证项；
- 绝不是一个 host 建一个子会话；同一系统的多个域名合并到同一个子会话 / 资产条目；
- 资产入库与上游规范以 `asset-context` 技能为准。

## 触发条件

- 新会话 / 新对话继续任务前 → `list` → `load` 恢复；
- 阶段完成、上下文将满、会话结束、用户要求保存进度 → `save`；
- 任务目标、Host、失败路径、下一步实质变化 → `save`；
- 新的有效目标 Host 需要并入 → `attach_assets`；
- 覆盖错了 / 状态异常 → `restore_previous` 单步回滚。

## 硬性规则（MUST，优先级高于本技能其余内容）

1. **层级合规**：项目会话是根；子会话创建时必须带 `parent_session_id`，只一层。新建前先 `list` 确认项目，不重复建同名会话。
2. **价值门槛**：只给「scope 内 + 可达 + 有攻击面 + 有复用价值」的 Web 资产入库 / 建子会话；排除项记入项目会话 `notes` 的范围台账，**不逐个建记录**，绝不按 host 建子会话。
3. **创建时 9 个字段全填**（`project_name` / `target_hosts` / `current_phase` / `unfinished_tasks` / `failed_paths` / `tested_interfaces` / `notes` / `related_vuln_ids` / `next_steps`）；数组 / 备注可空，但 key 不能省。
4. **更新用 `session_id` + 只传变化字段**；未传保持不变；数组整体替换（`[]` 清空）。
5. **`SESSION_EXISTS` 必须让用户选择**：返回 `{ success: false, requires_choice: true, code: "SESSION_EXISTS", candidates }`；把候选展示给用户，选「继续已有会话（save + session_id）」或「新建（save + force_new: true）」，禁止自行猜测。
6. **恢复流程**：`list`（`keyword` / `roots_only`）→ `load(project)` 看 `children` → 用户选子会话 → `load(child)`。**一次只 load 一条完整会话**，不要批量 load。
7. **归档 / 删除只由用户在桌面端操作**（MCP 无此 action，Agent 不能删除）。归档会话默认不出现在 `list`（`include_archived: true` 才显示，`load` 仍可查看）；归档会话不可 `save` / `attach_assets` / `restore_previous`，需提示用户在 UI 取消归档。
8. **职责分工**：漏洞详情 / HTTP 报文 / 复现步骤 / 修复建议 → `save_vulnerability`；接口目录 / 完整原始请求 / 技术栈 / 敏感泄露 → `sync_asset_info`；快照只放测试结论（`tested_interfaces`）、备注（`notes`）、关联 ID（`related_vuln_ids`）。大段报文、截图不进快照。
9. **payload 上限**：整体序列化 ≤32,000 字符；`tested_interfaces` ≤50 条（`target` ≤300 / `method` ≤300 / `result` ≤500）、`notes` ≤8,000 字符、`related_vuln_ids` ≤100 个。超限先压缩 `notes`、精简矩阵。
10. **资产归属用 `attach_assets`**（去重并入 `target_hosts`），不要用 save 重写别处的会话。
11. **回滚只用 `restore_previous`**（单步，执行前向用户确认；回滚后 `previous_state` 清空，不能连续回滚）。
12. **乐观锁**：更新传 `base_updated_at`（本次修改基于的 `updated_at`）；返回 `STALE` 说明会话已变，必须先重新 `load` 再改。
13. **MCP 不可用**（工具缺失 / `server is disconnected`）→ 先运行 `ctx doctor`，确认 Agent 以 stdio 拉起 MCP（开发版 `node <项目>/out/mcp/stdio.cjs`，安装版 `<install>\bin\node.exe` + `mcp-stdio.cjs`）、数据库路径正确，然后**重启 Agent**（不是重启 GUI）；数据库忙 / schema 过旧时打开一次 GUI 或运行 `ctx doctor`。禁止假装已保存 / 静默跳过；用户明确说不用保存时从其指令。

## 字段规范（payload）

创建时 9 个字段全填（数组 / 备注可为空，但不能省略 key）：

| 字段 | 类型 | 上限 | 说明 |
| --- | --- | --- | --- |
| `project_name` | string | 1–120 | 项目 / 系统名，用于定位会话 |
| `target_hosts` | string[] | 1–50 个，每个 ≤255 | 本任务目标 Host；后续用 `attach_assets` 追加 |
| `current_phase` | string | ≤200 | 当前阶段，如「JS 接口审计」「越权验证」 |
| `unfinished_tasks` | string[] | ≤20 条，每条 ≤500 | 未完成事项，已完成项移除 |
| `failed_paths` | string[] | ≤20 条，每条 ≤500 | 已验证失败 / 不可行路径，避免重复踩坑 |
| `tested_interfaces` | object[] | ≤50 条 | 测试矩阵 `{ target, method, result }`：target ≤300 必填，method ≤300，result ≤500；只记结论 |
| `notes` | string（Markdown） | ≤8,000 字符 | 命令、payload、响应片段、JS 线索、观察、范围台账 |
| `related_vuln_ids` | string[] | ≤100 个 | 引用漏洞库已入库的 ID，不抄写证据 |
| `next_steps` | string | ≤2000 | 下一步计划，可含 Markdown 列表 |

> 整体上限：payload 序列化后 ≤32,000 字符（服务端拒绝超限）。`tested_interfaces` 是**测试矩阵**而非接口清单：接口路径 / method / 原始请求的权威记录在资产库。

会话返回字段：`session_id`、`parent_session_id`（root 为 null）、`archived_at`（null = 未归档）、`child_count`、`has_previous_state`、`created_at` / `updated_at` + 全部 payload 字段。

摘要（`list` 项 / `children`）不含完整数组：`session_id`、`project_name`、`current_phase`、`target_hosts`、`parent_session_id`、`archived_at`、`child_count`、`unfinished_count`、`failed_count`、`tested_interface_count`、`next_steps_excerpt`、`has_previous_state`。

## `list` 参数与恢复

| 参数 | 说明 |
| --- | --- |
| `keyword` | 模糊筛选项目 / 阶段 |
| `roots_only` | 只返回项目会话（root） |
| `parent_session_id` | 只返回某个项目会话的子会话 |
| `include_archived` | 含已归档会话（默认 false，归档隐藏） |
| `limit` | 1–50 |

恢复顺序：`list` → `load(project)` → 看 `children` 摘要 → 用户选子会话 → `load(child)`；一次只 load 一条完整会话，不要把同项目的所有子会话都 load 进上下文。

## 局部更新语义

- 字段缺失（`undefined`）→ 保持原值；数组整体替换：`unfinished_tasks` / `failed_paths` / `tested_interfaces` / `related_vuln_ids` 传 `[]` 清空，`target_hosts` 至少保留 1 个；字符串 `notes` / `current_phase` / `next_steps` 整体替换。
- 严格对象，不允许未知字段；每次 save 重新校验整体 ≤32,000 字符；覆盖前上一版进 `previous_state`（仅一版）。
- 追加测试记录要先把旧数组一起传回（先 `load` 再改）；`parent_session_id` 只在创建时传。

## 示例

创建子会话（项目会话同理，省略 `parent_session_id`）：

```json
manage_snapshot({
  "action": "save",
  "parent_session_id": "SESS-20260101-001",
  "payload": {
    "project_name": "示例云课堂-opcenter",
    "target_hosts": ["opcenter.example.com"],
    "current_phase": "越权验证",
    "unfinished_tasks": ["未验证下载接口 file_id 枚举范围"],
    "failed_paths": ["/api/v1/login 的 SQL 注入（参数化查询，已排除）"],
    "tested_interfaces": [
      {
        "target": "POST /api/v1/.../download/cooperation/project/",
        "method": "未带 Cookie，枚举 file_id 1–60",
        "result": "200，返回他人项目预签名地址，已入库 VULN-20261031-001"
      }
    ],
    "notes": "### 线索\n- 完整报文见漏洞库 VULN-20261031-001\n- admin 子域 302 → SSO，待验证",
    "related_vuln_ids": ["VULN-20261031-001"],
    "next_steps": "1. 复核 file_id 枚举范围\n2. 测试 admin 子域鉴权"
  }
})
```

返回 `{ "success": true, "action": "save", "created": true, "session": { "session_id": "...", "parent_session_id": "SESS-20260101-001", "...": "..." } }`。

局部更新：

```json
manage_snapshot({
  "action": "save",
  "session_id": "SESS-20260101-002",
  "base_updated_at": "2026-01-02T05:20:00.000Z",
  "payload": { "current_phase": "越权验证", "next_steps": "1. 测试 admin 子域鉴权" }
})
```

未传字段保持原值；`tested_interfaces` / `related_vuln_ids` 是整体替换（追加须带上旧条目）。返回 `created: false`。

常用调用：

| 目的 | 调用 | 返回 |
| --- | --- | --- |
| 列出项目会话 | `list({ keyword, roots_only: true })` | `{ total, items[] }` |
| 列出子会话 | `list({ parent_session_id })` | `{ total, items[] }` |
| 读取项目会话 | `load({ session_id: root })` | `{ session, children[] }` |
| 读取子会话 | `load({ session_id: child })` | `{ session }`（一次一条） |
| 资产并入会话 | `attach_assets({ session_id, hosts })` | `{ session }`（target_hosts 去重合并） |
| 回滚上一次覆盖 | `restore_previous({ session_id })` | `{ session }`（has_previous_state → false） |

`SESSION_EXISTS` 处理：不带 `session_id` 创建且同项目已有会话时返回

```json
{ "success": false, "requires_choice": true, "code": "SESSION_EXISTS", "candidates": [{ "session_id": "SESS-20260101-001", "project_name": "示例云课堂", "current_phase": "越权验证", "...": "..." }] }
```

把 `candidates` 展示给用户，选「继续已有会话（save + session_id）」或「新建（save + force_new: true）」；不得自行猜测。

## 保存前 checklist

- [ ] 层级正确：项目会话是根，子会话带 `parent_session_id`（只一层）；
- [ ] 只对达到价值门槛的资产建子会话 / 入库；排除项已写进项目 `notes` 范围台账；
- [ ] `unfinished_tasks` / `failed_paths` / `next_steps` 是当前真实状态，已完成项已移除；
- [ ] 漏洞证据 / 接口原始请求 / 敏感泄露已分别入漏洞库、资产库，快照未重复大段内容；
- [ ] `tested_interfaces` 只写结论（target / method / result），未贴完整报文；
- [ ] `related_vuln_ids` 已先 `save_vulnerability` 入库；
- [ ] 整体 payload ≤32,000 字符（超限先压缩 `notes`）；
- [ ] 更新带 `base_updated_at`，且基于最新 `load`；保存后记下 `session_id`。

## 常见错误

- ❌ 给子会话再建子会话（只允许一层）；子会话创建漏传 `parent_session_id`；
- ❌ 一个 host 建一个子会话 / 逐个入库不可达、停放页、默认页、CDN、重复域、越界目标（应合并或只记范围台账）；
- ❌ 收到 `SESSION_EXISTS` 后自行选 candidate 继续（必须让用户选）；
- ❌ 用 `save` + `session_id` 把别的项目的进度写进已有会话（新任务应新建会话）；
- ❌ 在 Agent 侧尝试归档 / 删除会话（MCP 无此 action，只能提示用户在桌面端操作）；
- ❌ 对归档会话 `save` / `attach_assets` / `restore_previous`（先提示用户在 UI 取消归档）；
- ❌ 每轮对话都 save、把已完成事项留在 `unfinished_tasks`、`STALE` 后不重新 `load` 就重试；
- ❌ 把完整 HTTP 报文 / 截图塞进 `tested_interfaces` 或 `notes`、或引用漏洞后又抄复现步骤（撑爆 32,000 上限）；
- ❌ 用快照代替漏洞 / 资产入库（仍走 `save_vulnerability` / `sync_asset_info`）。

## 安装到 Agent

推荐用 `ctx init` 一条命令完成 MCP 配置 + 三个 Skill + 系统规则（幂等、自动备份、`--dry-run` 只预览）；也可以在 MCP 接入页点击「接入 Agent」按钮。落点：`~/.agents/skills/snapshot/SKILL.md`（DSH / Codex / Claude 各自技能目录见 README），硬性规则写入对应全局指令文件；Cursor 等客户端可用 `ctx mcp print-config cursor` 打印的 stdio 配置。

stdio MCP 由 Agent 自动拉起，无需启动 GUI；GUI 只是查看端，归档 / 删除仍在桌面端操作。数据库：Windows `%USERPROFILE%\.cortex\data.db`，macOS/Linux `~/.cortex/data.db`（`CTX_DB_PATH` 可覆盖，旧版 `PDH_DB_PATH` 仍可用）。

安装后自检：工具列表确认 6 个工具（`save_vulnerability`、`query_vulnerabilities`、`update_vulnerability`、`sync_asset_info`、`query_asset_context`、`manage_snapshot`）；执行一次 `manage_snapshot({ action: "list" })` 与只读查询确认链路；保存一次测试快照后，新会话能 `list` → `load` 恢复，`parent_session_id` / `children` / `restore_previous` 行为正常。工具缺失或连接断开时运行 `ctx doctor`，修正配置后重启 Agent。
