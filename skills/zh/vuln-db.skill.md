---
name: vuln-db
description: 【硬性】确认新漏洞时先 query_vulnerabilities({ host }) 查重再 save_vulnerability；复测只用 update_vulnerability 的 retest 追加 Markdown 结论，禁止用 save_vulnerability 覆盖原始证据；reproduction_steps 必须是标准 Markdown（### 步骤 N、**请求**、**响应**、**判据** + http 代码块）。
---

# 技能：漏洞发现与入库（Cortex）

Cortex 是本地 **stdio MCP Server**：由 Agent 自动拉起（`node <entry>`），无需启动桌面端；桌面端只是查看端，可随时开关。它不主动扫描，只负责把 Agent 确认的漏洞结构化保存到 SQLite，供人类在桌面端或终端查看。UI 会把 `reproduction_steps` 和复测结论渲染为 Markdown，并对 ```http / ```json 代码块做语法高亮、自动格式化其中的 JSON。

## 连接方式（stdio）

- **传输**：stdio，Agent 在自己的进程里拉起 MCP server，通过 stdin/stdout 交换 JSON-RPC；不监听端口、没有 HTTP 端点，桌面端不启动 MCP。
- **入口**：开发模式 `node <项目>/out/mcp/stdio.cjs`；Windows 安装版 `<install>\bin\node.exe` + `<install>\bin\mcp-stdio.cjs`（Server 名称 `cortex`，版本 `0.1.1`）。
- **数据库**：Windows `%USERPROFILE%\.cortex\data.db`，macOS/Linux `~/.cortex/data.db`，可用 `CTX_DB_PATH` 覆盖（旧版 `PDH_DB_PATH` 仍可用）；GUI / MCP / CLI 共用同一份文件。
- **验证链路**：调用一次只读工具即可，例如 `manage_snapshot({ "action": "list" })` 或 `query_vulnerabilities({ "host": "example.com:443" })`；工具存在且返回正常即说明 stdio 连接可用。

## 硬性规则（MUST，优先级高于本技能其余内容）

这是一个**执行门槛**，不是「建议调用」：

1. **确认一个新漏洞时，必须在回复用户之前完成入库。** 顺序固定：先 `query_vulnerabilities({ host })` 查重 → 再 `save_vulnerability` 写入。
2. **复测已有漏洞时，只调用 `update_vulnerability({ vuln_id, retest: { time_range, conclusion } })` 追加复测结果。** 不要把复测结论写进 `test_boundaries`，也不要用 `save_vulnerability` 重写描述、影响、复现步骤、修复建议等原始字段。
3. **状态流转只用 `update_vulnerability({ vuln_id, status })`**，不要用 `save_vulnerability` 重写整条记录来改状态。
4. 只写报告 / 只在对话里说「发现漏洞」但没有成功调用入库工具 = 任务未完成。
5. 证据不足但值得留痕的点，也要以 `status: "Inconclusive"` 入库，不得丢弃。
6. **MCP 不可用（工具缺失 / `server is disconnected` / stdio 进程起不来）→ 先运行 `ctx doctor`**：确认数据库路径、schema 版本与 MCP 入口（开发版 `node` + `out/mcp/stdio.cjs`，安装版 `<install>\bin\node.exe` + `<install>\bin\mcp-stdio.cjs`），确认 Agent 的 MCP 配置使用 `node <entry>`，然后**重启 Agent**（不是重启 GUI）。数据库忙或 schema 过旧时打开一次 GUI 或运行 `ctx doctor`。恢复后补录；**禁止静默跳过**，禁止用「无法连接」当借口直接结束。
7. 用户当轮明确说「不用入库 / 只是看看」时，以用户指令为准；除此之外没有例外。
8. 工具可能带命名空间：DSH 为 `mcp__cortex__save_vulnerability`，Codex/Claude 可能显示为 `cortex.save_vulnerability`。按实际暴露的名字调用同名工具，不要因为前缀不同而跳过。

## 触发条件

- 确认一个**新漏洞** → 调用 `save_vulnerability`。
- 开始测试新 Host 前 → 调用 `query_vulnerabilities({ host })` 查历史结论（查重）。
- 需要完整漏洞细节 → 调用 `query_vulnerabilities({ vuln_id })`。
- **复测已有漏洞 → 调用 `update_vulnerability({ vuln_id, retest: { time_range, conclusion } })`**，只追加复测；同一调用可带 `status`，也可以只流转状态。
- 浏览 / 过滤 / 分页取数 → `query_vulnerabilities({ search?, severity?, status?, page?, pageSize? })`。

## 字段规范

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 否 | 省略时自动分配 `VULN-YYYYMMDD-NNN`；相同 ID 会覆盖旧记录 |
| `host` | string | 是 | 必须带端口，如 `opcenter.example.com:443`；不带协议头/路径 |
| `vuln_name` | string | 是 | 漏洞名称 |
| `vuln_type` | string | 否 | 如 `SQLi` / `SSRF` / `Arbitrary_File_Download`；省略 = `Unclassified`（UI 显示「未分类」） |
| `severity` | enum | 是 | `Critical` / `High` / `Medium` / `Low` / `Info` |
| `target_url` | string | 是 | 触发漏洞的 URL |
| `entry_point` | string | 否 | 初始入口，如 URL 或 `/login` |
| `description` | string | 否 | 成因、接口、参数、前置条件 |
| `impact` | string | 否 | 实际危害与影响范围 |
| `affected_interfaces` | string[] | 否 | 受影响接口/URL 列表（UI 用无序列表渲染，长 URL 自动换行） |
| `reproduction_steps` | string | 否 | **标准 Markdown 字符串**，格式见下节；不要传数组 |
| `remediation` | string[] | 否 | 修复建议（UI 用无序列表渲染） |
| `crypto_details` | string | 否 | 加密/签名算法、密钥来源、流程；无则填 `"无"` 或空串 |
| `test_boundaries` | string | 否 | 测试边界与未作事项；**不要写复测结论** |
| `retest_results` | object[] | 否 | 复测历史，由 `update_vulnerability` 的 `retest` 追加；每项 `{ time_range, conclusion }`。`conclusion` 是 Markdown |
| `related_vuln_ids` | string[] | 否 | 组合攻击的前置漏洞 ID |
| `status` | enum | 否 | `Confirmed`（默认）/ `Inconclusive` / `Retest_Passed` |
| `created_at` | string | 否 | ISO 8601；省略时服务端自动填当前时间 |

## reproduction_steps 规范（重点）

`reproduction_steps` 是**一个 Markdown 字符串**，不是 JSON 数组。必须使用以下结构，UI 才能正确渲染与高亮：

````markdown
### 步骤 1：匿名请求下载接口，取得 file_id=10 的预签名下载地址

**请求**
```http
GET /api/v1/files/download?file_id=10 HTTP/1.1
Host: opcenter.example.com
Accept: */*
```

**响应**
```http
HTTP/1.1 200 OK
content-type: application/json

{"code":0,"data":{"file_url":"https://files.oss.example.com/..."},"message":"成功"}
```

**判据**：未携带任何会话凭据的请求返回 200，仍下发学生文件「示例组.rar」的 OSS 预签名下载地址。

### 步骤 2：使用预签名地址下载文件内容

**请求**
```http
GET /example-bucket%2Fsample-group.rar HTTP/1.1
Host: files.oss.example.com
Range: bytes=0-1023
```

**响应**
```http
HTTP/1.1 206 Partial Content
content-range: bytes 0-1023/1048576

Rar!\x1a\x07\x01\x00m\xee+a\r\x01\x05\t
```

**判据**：预签名地址真实可用，返回学生作业压缩包原始内容（RAR 魔数、总大小 1,048,576 字节）。
````

硬性要求：

1. 每个步骤用 `### 步骤 N：<动作描述>` 作为标题，N 从 1 开始。
2. 每个步骤必须包含 `**请求**`、`**响应**`（无响应时写 `**响应**：无直接回显，见带外证据`）、`**判据**` 三段。
3. 原始请求/响应必须放在 ```` ```http ```` 代码块中；纯 JSON 也可用 ```` ```json ````。不要用普通文本代替代码块。
4. 请求块至少包含请求行、`Host` 与关键 headers；响应块包含状态行、`content-type` 与关键 body。
5. JSON body 可以保持单行；UI 会自动格式化缩进（不需要在 Markdown 里手工排版）。
6. `**判据**` 必须写确定性证据（状态码 + 关键字段 + 实际效果），不要写「疑似」「可能」。
7. 不要把 `reproduction_steps` 写成 JSON 数组或对象；旧版数组结构会被 Schema 拒绝。

## 复测结果规范（重点）

复测已有漏洞时，**不要**再次调用 `save_vulnerability` 全量覆盖；使用 `update_vulnerability` 的 `retest` 追加：

```json
update_vulnerability({
  "vuln_id": "VULN-20260101-001",
  "status": "Retest_Passed",
  "retest": {
    "time_range": "2026-01-02 11:03–11:07（Asia/Shanghai）",
    "conclusion": "### 复测结论\n\n- **结果**：仍可复现\n- **关键证据**：未携带凭据仍返回 200 与预签名地址\n\n```http\nGET /api/v1/... HTTP/1.1\nHost: opcenter.example.com\n```"
  }
})
```

规则：

1. `retest.time_range` 使用可读的本机时间范围，推荐 `YYYY-MM-DD HH:mm–HH:mm（Asia/Shanghai）`。
2. `retest.conclusion` 必须由模型直接输出 **Markdown**：标题、列表、加粗、表格、```http / ```json 代码块都可以；UI 统一渲染 Markdown。建议以 `### 复测结论` 开头，不要自己写「第一次复测 / 第二次复测」标题，UI 会自动生成序号。
3. UI 会按追加顺序显示「第一次复测」「第二次复测」……；时间单独一行，结论正文缩进两格，不需要在 Markdown 里手工加空格。
4. 复测只向 `retest_results` 追加，不能修改 `description`、`impact`、`reproduction_steps`、`remediation`、`test_boundaries` 等原始字段；`retest` 与 `status` 至少提供一个，可以同时传。
5. 返回 `{ success, id, status, retest_index? }`；`retest_index` 从 0 开始，仅在本次调用传了 `retest` 时返回。
6. 只改状态时调用 `update_vulnerability({ vuln_id, status })`，不要为了改状态重写整条记录。
7. 未复测的漏洞由 UI 显示「未复测」，不要为了占位而写空复测记录。

## 保存示例（字段结构）

```json
{
  "host": "opcenter.example.com:443",
  "vuln_name": "示例云课堂学生管理系统 任意文件下载",
  "severity": "High",
  "target_url": "https://www.example.com/",
  "entry_point": "https://www.example.com/",
  "description": "团队项目下载接口只校验 file_id 为整数，缺少身份认证与资源归属校验。",
  "impact": "未授权批量下载学生团队项目作业文件，file_id 可枚举。",
  "affected_interfaces": [
    "https://opcenter.example.com/api/v1/files/download?file_id=10"
  ],
  "reproduction_steps": "### 步骤 1：匿名请求下载接口\n\n**请求**\n```http\nGET /api/v1/files/download?file_id=10 HTTP/1.1\nHost: opcenter.example.com\n```\n\n**响应**\n```http\nHTTP/1.1 200 OK\n\n{\"code\":0}\n```\n\n**判据**：未携带凭据仍返回 200 与预签名地址。",
  "remediation": ["补齐身份认证与资源归属校验", "file_id 改为 UUID 并限流"],
  "crypto_details": "无",
  "test_boundaries": "仅枚举少量 file_id 的元数据，未批量下载。",
  "related_vuln_ids": [],
  "status": "Confirmed"
}
```

## 查询

- `query_vulnerabilities({ host: "opcenter.example.com:443" })` → `{ host, total, items: [{ vuln_id, vuln_name, severity, target_url }] }`，用于测前快速回顾与查重。
- `query_vulnerabilities({ vuln_id: "VULN-20260101-001" })` → 完整记录，包含 Markdown `reproduction_steps` 与 `retest_results`。
- `query_vulnerabilities({ search?, severity?, status?, page?, pageSize? })` → 分页列表 `{ items, total, page, pageSize }`，用于浏览、过滤与报告取数。
- 三种模式优先级：`vuln_id` 优先，其次 `host`，都没有时按过滤条件分页；至少提供 `vuln_id` / `host` / `search` / `severity` / `status` 之一。
- `update_vulnerability({ vuln_id, retest: { time_range, conclusion } })` → 追加复测结果，返回 `retest_index`。
- `update_vulnerability({ vuln_id, status })` → 状态流转。

## 错误处理

- 参数校验失败返回 `isError: true` 与字段路径（例如 `host: host 必须包含 1-65535 的端口`），按提示修正后重试。
- `reproduction_steps` 传数组会报类型错误；改传 Markdown 字符串。
- `query_vulnerabilities` / `update_vulnerability` 未找到 ID 时，先用 `query_vulnerabilities({ host })` 或 `{ search }` 确认正确 ID。
- 写入返回 `{ success: true, id, created }`；`created: false` 表示同 ID 覆盖，客户端可能提示确认。
- `update_vulnerability` 的 `status` 与 `retest` 至少提供一个；复测返回的 `retest_index` 从 0 开始。

## MCP 连接故障排查（DSH / Codex / Claude Code 通用）

stdio MCP 由 Agent 拉起，不存在「服务是否在线」的前置条件；连接问题通常来自配置、入口文件或数据库：

1. 运行 `ctx doctor`：检查数据库路径 / 目录可写 / schema 版本 / WAL 大小、MCP 入口（开发版 `node` + `out/mcp/stdio.cjs`，安装版 `<install>\bin\node.exe` + `<install>\bin\mcp-stdio.cjs`）与各 Agent 配置是否存在且有效。
2. 检查 Agent 配置确实使用 stdio：`command` 指向 Node（开发模式用系统 `node`，安装版用 `<install>\bin\node.exe`），`args` 指向 `mcp-stdio.cjs` / `out/mcp/stdio.cjs` 绝对路径；开发模式先 `npm run build:mcp` 生成入口文件。
3. 修改配置后**重启 Agent**（MCP client 在 Agent 启动时初始化）；**重启 GUI 不会修复 MCP 连接**，GUI 可以随时开关。
4. 数据库忙 / schema 过旧：打开一次 GUI 让主进程完成迁移，或运行 `ctx doctor` 查看详情；只读 CLI 命令不会替你迁移。
5. 仍失败时设置 `CTX_MCP_LOG=<日志路径>` 后重启 Agent，查看 stderr / 日志文件里的启动错误；也可运行 `node scripts/mcp-stdio-smoke.mjs` 单独验证入口。
6. 工具名带命名空间（DSH `mcp__cortex__*`，其他客户端可能显示为 `cortex.*`），按实际暴露的名字调用；`ctx mcp print-config dsh|codex|claude|cursor|workbuddy|zcode` 可打印官方 stdio 配置片段。

## 安装到 Agent（含强制化）

**只注册 MCP 通常不够**：Agent 客户端不会仅因为工具存在就强制调用它。必须同时安装三层：

1. **MCP server**：以 stdio 启动，让 6 个工具可见（3 个漏洞工具 + 2 个资产工具 + 1 个认知快照工具）；
2. **Skill**：把本文件与 `asset-context`、`snapshot` 安装到 Agent 的技能目录，提供漏洞字段、Markdown、复测与资产上下文规范；
3. **系统级硬性规则**：把「确认漏洞必须入库 + 侦察后同步资产 + 认知快照」写进 Agent 的全局指令文件（DSH `AGENTS.md`、Codex `AGENTS.md`、Claude `CLAUDE.md`、ZCode `AGENTS.md`；WorkBuddy 无全局规则文件）。

### 推荐：`ctx init` 一条命令

```powershell
ctx init                          # 检测本机 Agent，展示文件与 diff，备份后幂等写入
ctx init --dry-run                # 只展示将修改的文件，不写任何文件
ctx init --agents dsh,claude      # 只处理指定 Agent（dsh / claude / codex / cursor / workbuddy / zcode）
```

`ctx init` 会安装 MCP 配置、三个 Skill 与系统级规则，备份为 `.bak-YYYYMMDD-HHmmss`，校验写入后的 JSON/TOML/YAML 可解析，最后提示重启 Agent。安装完成后运行 `ctx doctor` 自检。

也可以运行 `ctx mcp print-config <agent>` 打印配置片段，或在 MCP 接入页点击「接入 Agent」自动写入。

### 各 Agent 的安装落点

| Agent | MCP 配置 | Skill 目录 | 系统级强制规则 |
| --- | --- | --- | --- |
| DeepSeek Harness | `~/.dsh/profiles/<profile>/cordis.patch.yml` 中 `@deepseek-ai/dsh-mcp-client`（stdio：`node` + `<entry>`） | `~/.agents/skills/vuln-db/SKILL.md` | `~/.dsh/AGENTS.md` |
| Codex CLI | `~/.codex/config.toml` 的 `[mcp_servers.cortex]`（stdio） | `~/.codex/skills/vuln-db/SKILL.md` 与 `~/.agents/skills/vuln-db/SKILL.md` | `~/.codex/AGENTS.md` |
| Claude Code | `claude mcp add --transport stdio cortex -- <node> <entry>` | `~/.claude/skills/vuln-db/SKILL.md` 与 `~/.agents/skills/vuln-db/SKILL.md` | `~/.claude/CLAUDE.md` |
| Cursor | `~/.cursor/mcp.json` 的 `mcpServers`（stdio） | 由 `ctx init` 按客户端能力安装 | — |
| WorkBuddy | `~/.workbuddy/mcp.json` 的 `mcpServers`（stdio） | 在 WorkBuddy「设置 → 技能」中从 `~/.agents/skills` 导入 | — |
| ZCode | `~/.zcode/cli/config.json` 的 `mcp.servers`（stdio） | `~/.zcode/skills/vuln-db/SKILL.md` | `~/.zcode/AGENTS.md` |

> stdio MCP 由 Agent 拉起，桌面端不需要常驻；关闭 GUI 不影响 MCP 读写。修改配置或安装 Skill / 规则后重启对应 Agent 生效。

### 安装后自检

1. 重启 Agent；在工具列表中确认存在 6 个工具：`save_vulnerability`、`query_vulnerabilities`、`update_vulnerability`、`sync_asset_info`、`query_asset_context`、`manage_snapshot`。
2. 让 Agent 执行一次 `query_vulnerabilities`、`query_asset_context` 与 `manage_snapshot({ action: "list" })`（只读）确认链路通畅。
3. 确认一个测试漏洞，观察 Agent 是否在回复前主动调用 `save_vulnerability`；若仍不调用，检查系统级规则文件是否被 Agent 实际加载（不同客户端的规则文件路径不同）。资产侦察完成后同理应调用 `sync_asset_info`；复测时只用 `update_vulnerability` 追加。
4. 工具缺失或连接断开时运行 `ctx doctor`，按「MCP 连接故障排查」逐项检查后重启 Agent。

### 手动安装（任选）

- 通用 stdio MCP 配置（Cursor 等客户端可直接使用；安装版把 `command` 换成 `<install>\bin\node.exe`，入口换成 `<install>\bin\mcp-stdio.cjs`）：
  ```json
  {
    "mcpServers": {
      "cortex": {
        "command": "node",
        "args": ["<项目>/out/mcp/stdio.cjs"]
      }
    }
  }
  ```
- 手动安装 Skill：把本文件复制到上表对应 Skill 目录。
- 手动强制规则：把本文件开头的「硬性规则（MUST）」整段追加到对应 Agent 的全局指令文件（DSH `~/.dsh/AGENTS.md`、Codex `~/.codex/AGENTS.md`、Claude `~/.claude/CLAUDE.md`、ZCode `~/.zcode/AGENTS.md`；WorkBuddy 无全局规则文件）。
- 数据位置：Windows `%USERPROFILE%\.cortex\data.db`，macOS/Linux `~/.cortex/data.db`；需要隔离多库时设置 `CTX_DB_PATH`（旧版 `PDH_DB_PATH` 仍可用）。
