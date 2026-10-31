---
name: asset-context
description: 【硬性】完成 JS 审计、指纹识别、接口抓包等信息收集后，必须调用 sync_asset_info 把资产指纹、结构化接口（interfaces）、敏感泄露与关联漏洞沉淀到 Cortex；测试新资产前必须先 query_asset_context({ host_port }) 复用已有上下文。
---

# 技能：资产情报收集与入库（Asset Context）

Cortex 不仅存漏洞，也存“资产上下文”。资产上下文是后续测试、漏洞复测和新会话续测的核心记忆：结构化接口往往比单条漏洞更有价值，敏感泄露可能直接决定利用路径。

## 硬性规则（MUST）

1. **开始测试一个 Host / URL 前，先调用 `query_asset_context({ host_port })`**（或 `query_asset_context({ project_name })`）读取已有资产上下文，避免重复侦察、避免覆盖旧信息。
2. **完成一次信息收集后，必须调用 `sync_asset_info`** 把本次新增或变化的指纹、接口、泄露、关联漏洞同步入库。
3. **接口优先记录为结构化 `interfaces[]`**：先写 `path`；JS 审计 / 抓包确认后逐条补全 `method`、`params`、`request`。`request` 必须是**完整原始 HTTP 请求**（请求行、Host/headers、可选 body），不是路径，也不是 URL。旧版 `interface_dir: string[]` 仍被兼容：服务端读入/写入时规范化为 `{ path }`，不会报错，也不会丢数据；但新数据不要再只写纯路径数组。
4. **`host_port` 优先传完整 URL**（支持 `http://` / `https://`、端口、登录页/业务路径）；`host` 字段是纯 host（无端口、无协议头、无路径），可省略，由服务端从 URL 推导。不要只写一个无法定位系统的泛路径。
5. **单独的 IP / IP:端口 不支持入库**：本资产库面向 Web/HTTP 资产，不记录纯 IP 的端口扫描、服务发现、协议探测结果。IP 资产必须以完整 `http(s)://IP:端口/路径` 的 URL 形式记录（例如 `http://10.0.0.5:8080/login`）。
6. 不要用空数组/空字符串覆盖已有信息。先读取当前全量上下文，再判断：
   - 本次是完整快照 → `mode: "replace"`（默认）；
   - 本次只是增量发现 → `mode: "merge"`；合并时 `project_name` 仍需提供，未提供的 `auth_required` / `status` 会保留已有值，接口/泄露/关联漏洞按并集追加。
7. **`tech_stack` 用明确分隔符逐项书写**（英文逗号 `, `、中文逗号 `，`、英文分号 `; `、中文分号 `；`、顿号 `、` 或换行），每个技术独立，如 `Nginx, Spring Boot 3, Vue 3`；不要用省略号或一整串无分隔符拼接，界面会按这些分隔符拆成独立标签。
8. 发现敏感信息时逐条记录来源（JS 文件路径/行号、API、页面 URL）和**可执行的影响**，不要只写“泄露了 Key”。
9. 漏洞写入后，把新漏洞 ID 关联到对应资产（`related_vuln_ids`）；资产库也会按纯 host 自动关联同 Host 漏洞。
10. **MCP 不可用**（工具缺失 / `server is disconnected`）时先运行 `ctx doctor`：确认 Agent 以 stdio 拉起 MCP（开发版 `node <项目>/out/mcp/stdio.cjs`，安装版 `<install>\bin\node.exe` + `<install>\bin\mcp-stdio.cjs`）、数据库路径正确，然后**重启 Agent**（不是重启 GUI）；数据库忙 / schema 过旧时打开一次 GUI 或运行 `ctx doctor`。恢复后补录，禁止静默跳过；详见 `vuln-db` 技能的「MCP 连接故障排查」。
11. 用户当轮明确说“不用入库 / 只是看看”时，以用户指令为准。

## 资产入库价值门槛

- 只入库**可达、在 scope 内、有真实攻击面**（登录 / API / 上传 / 后台 / SSO / 敏感数据）的 Web 资产；
- 不可达、停放页、默认页 / 欢迎页、纯静态站、CDN / 静态资源域、重复站、scope 外目标不写资产库；
- 排除项不逐个建记录：把原因 / 数量汇总进对应项目快照（`snapshot` 技能的 `manage_snapshot` 项目会话 `notes`）；
- 不要按子域批量入库；同一系统的多个域名合并到一个资产条目，避免资产 / 会话爆炸。

## 触发条件

- 完成 JS 审计、指纹识别、接口抓包、目录扫描、公开文档收集后；
- 发现新的接口路径 / method / 参数 / 原始请求、技术栈、敏感泄露、内网地址、WAF/鉴权行为后；
- 准备对某个 Host 开始测试前（先读资产上下文）；
- 复测完成、需要更新资产存活状态或关联新漏洞时。

## 字段规范

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `host_port` | string | 是 | **优先传完整 URL**：`https://example.com/login`、`http://10.0.0.5:8080/admin`、`https://example.com:8443/`。也接受 `host` / `host:port` / `host/path`；不能含空白。**单独 IP 或 IP:端口会被拒绝** |
| `host` | string | 否 | 纯 host：无端口、无协议头、无路径，如 `example.com`、`10.0.0.5`、`[::1]`。省略时服务端自动从 `host_port` 推导 |
| `project_name` | string | 是 | 项目名/系统名/APP名；不确定时先按页面 title 推断，不要编造 |
| `tech_stack` | string | 否 | 指纹信息，用 `, ` / `，` / `; ` / `；` / `、` / 换行分隔每个技术，如 `Nginx, Spring Boot 3, Vue 3`；界面按分隔符拆成独立标签 |
| `auth_required` | boolean | 否 | 核心功能是否需要登录态；默认 `false`，仅在有证据时填 `true` |
| `status` | enum | 否 | `Alive` / `Dead` / `WAF_Blocked`，默认 `Alive` |
| `interfaces` | object[] | 推荐 | **结构化接口列表**，字段见下表；新数据优先使用，最多 2000 条 |
| `interface_dir` | string[] | 否（兼容字段） | 旧版纯路径列表，仅为向后兼容保留；服务端会规范化为 `{ path }` 并与 `interfaces` 合并去重。新数据请写 `interfaces` |
| `leaked_infos` | object[] | 是 | 敏感泄露列表，字段见下 |
| `test_parameters` | object[] | 否 | **非密测试参数种子**（登录后流量里的 id / 订单号 / 租户号等，IDOR/枚举素材），字段见下；不要与 `leaked_infos` 混用 |
| `related_vuln_ids` | string[] | 否 | 关联漏洞 ID，必须已存在 |
| `last_seen` | string | 否 | 由服务端自动写入，Agent 不需要传 |

> 服务端会把 `interfaces` 与 `interface_dir` 一起规范化：纯路径 → `{ path }`；同一 `path` 已有结构化 method 时，旧的纯路径条目会被升级/去重；`interface_count` 与界面均按规范化后的结构化接口数量统计。JS/CSS/图片等静态路径在两者中都会被拒绝。

### `interfaces[]`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | API 路径，以 `/` 开头，去重；不要带域名/协议。**JS/CSS/图片等静态文件不是接口**，不要写入 |
| `method` | enum | 否 | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `OPTIONS` / `HEAD` |
| `params` | string | 否 | 查询参数、表单参数或 JSON body 摘要，如 `id=1001`、`{"page":1,"size":20}` |
| `request` | string | 否 | **完整原始 HTTP 请求**：请求行 + Host/headers + 可选 body；不是路径，也不是 URL |

抓包确认后逐条补全：

```json
{
  "path": "/api/v1/files/download",
  "method": "POST",
  "params": "id=1001&format=pdf",
  "request": "POST /api/v1/files/download HTTP/1.1\nHost: opcenter.example.com\nContent-Type: application/x-www-form-urlencoded\nCookie: session=<redacted>\n\nid=1001&format=pdf"
}
```

只确认了路径、尚未抓到请求时，可以只写 `path`：

```json
{ "path": "/api/v1/user/info" }
```

### `leaked_infos[]`

| 字段 | 说明 |
| --- | --- |
| `info_type` | `Credential` / `API_Key` / `Token` / `PII` / `Internal_IP` / `Other` |
| `value` | 具体泄露内容：密码明文、AK/SK、JWT、内网地址等；只存实际值，不要粘贴整段 JS |
| `source` | 精确来源，如 `https://target.example.com/main.js:182` |
| `potential_impact` | 结合专业知识描述可利用性，如“泄露阿里云 AK，可尝试接管 OSS” |

> 当前为开发测试阶段：资产库会明文展示泄露值，不做加密和脱敏。请勿在真实生产环境中滥用；后续会评估加密存储与敏感字段控制。

### `test_parameters[]`（测试参数，非密）

登录后从流量/响应/URL/JS 收集的 **id、订单号、租户号、UUID** 等是 IDOR / 枚举测试素材，但**不是秘密**：单独存 `test_parameters`，不要塞进 `leaked_infos`；密码、Token、AK/SK、PII 仍走 `leaked_infos`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 参数名，如 `id` / `orderId` / `tenantId`（≤100） |
| `endpoint` | string | 使用该参数的接口，如 `GET /api/v1/users/{id}`（≤500） |
| `location` | enum | `path` / `query` / `body` / `header` / `cookie` |
| `values` | string[] | **只放 ≤50 个样例**（每个 ≤200），禁止整段 dump |
| `pattern` | string | 可选，枚举规律：`自增数字 100000+`、`UUID v4`、`前缀 + 6 位数字`（≤500） |
| `source` | string | 来源：响应 JSON / URL / JS（如 `app.js:182`，≤1000） |
| `tested` | boolean | 是否已用于授权测试，默认 false，测试后更新 |
| `notes` | string | 可选，测试结论 / 边界（≤2000） |
| `related_vuln_ids` | string[] | 确认越权后关联漏洞 ID（≤100） |

```json
{
  "name": "orderId",
  "endpoint": "GET /api/v1/orders/{orderId}",
  "location": "path",
  "values": ["100234", "100235", "100236", "100237"],
  "pattern": "自增数字 100000+",
  "source": "response JSON /api/v1/orders",
  "tested": true,
  "notes": "替换 orderId 返回他人订单，已确认 IDOR",
  "related_vuln_ids": ["VULN-20261031-001"]
}
```

- 每个参数一条记录；测试后用 `sync_asset_info` 更新 `tested` / `notes` / `related_vuln_ids`（`mode: "merge"` 时按 `endpoint` + `name` + `location` 去重，`values` 取并集、`tested` 取 OR）；
- 快照 `tested_interfaces` 只写结论，不重复候选值。

## interfaces 与静态资源（重要）

- `interfaces[].path` 只记录**可调用的 API 接口/路由**，例如 `/api/v1/user`、`/api/admin/login`、`/download/report`。
- JS 文件、CSS、图片、字体、source map 等静态资源**不是接口**，不能写进 `interfaces`（兼容字段 `interface_dir` 同样不允许）。
- 在 JS 中发现敏感信息时，把 JS 的 URL/行号写进对应 `leaked_infos[].source`；把 JS 中提取出的 API 路径写入 `interfaces`，并尽量通过抓包补全 `method` / `params` / `request`。
- `request` 里可以引用从 JS 或抓包还原出的真实报文，但不要粘贴整段 JS 代码，也不要把静态资源 URL 当成请求记录。
- 不要因为某个路径以 `.js` 结尾就把它当作接口；若确实需要保留该文件作为证据，使用 `leaked_infos.source` 或备注。

## 单独 IP 为什么不入库

- 资产库是 Web 资产标识（`host_port`），不是网络扫描结果表：纯 IP、IP:端口、开放端口/服务指纹（如 `10.0.0.5:22`）不写入。
- 该 IP 上有 Web 服务时记录完整 URL（`http://10.0.0.5:8080/login`）+ `project_name` + `interfaces`；纯 IP 扫描结果留在扫描器里，不要伪装成 Web 资产入库。

## 推荐工作流

### 1. 召回（测试前）

按完整 URL 读取单个资产：

```json
query_asset_context({ "host_port": "https://opcenter.example.com/login" })
```

不记得具体 URL 时，按项目名模糊查询，返回 `AssetContext[]`：

```json
query_asset_context({ "project_name": "示例云课堂" })
```

`host_port` 与 `project_name` 二选一。如果返回已有接口（含 method / params / request）、技术栈、历史泄露，先复用，不要重复抓取。

### 2. 收集（实时）

从 JS、接口响应、抓包流量、页面、公开文档中收集：

- 指纹与技术栈（每个技术独立，用分隔符分开）；
- 接口 `path`、`method`、参数（query / form / JSON body）；
- 原始 HTTP 请求（请求行 + headers + body），用于补全 `request`；
- 前端硬编码凭据、AK/SK、Token、内网 IP；
- 是否需要登录态、是否被 WAF 拦截。

### 3. 决策（AI 自主判断）

将“已有资产上下文”和“本次实时发现”对比，由模型判断：

- 哪些字段需要修改；
- 哪些接口是新增，哪些接口需要从纯路径升级为结构化条目（补 method / params / request）；
- 哪些泄露是新增；
- 哪些旧信息已失效；
- 是否需要关联新漏洞。

### 4. 入库

完整快照（推荐在读取全量后使用）：

```json
sync_asset_info({
  "host_port": "https://opcenter.example.com/login",
  "host": "opcenter.example.com",
  "project_name": "示例云课堂",
  "tech_stack": "Nginx, Spring Boot 3, Vue 3",
  "auth_required": false,
  "status": "Alive",
  "interfaces": [
    {
      "path": "/api/v1/files/download",
      "method": "POST",
      "params": "id=1001&format=pdf",
      "request": "POST /api/v1/files/download HTTP/1.1\nHost: opcenter.example.com\nContent-Type: application/x-www-form-urlencoded\nCookie: session=<redacted>\n\nid=1001&format=pdf"
    },
    {
      "path": "/api/v1/user/info",
      "method": "GET",
      "params": "id=1001"
    },
    {
      "path": "/api/v1/report/legacy/export"
    }
  ],
  "leaked_infos": [
    {
      "info_type": "API_Key",
      "value": "LTAI5tFakeExampleKey000000",
      "source": "https://static.example.com/main.js:182",
      "potential_impact": "疑似阿里云 STS 凭证，可用于调用 OSS/STS API"
    }
  ],
  "related_vuln_ids": ["VULN-20260101-001"],
  "mode": "replace"
})
```

- 前两条为结构化条目（含完整 `request` / 参数）；
- 最后一条只记录 `path`：对应旧数据或“只看到路径、尚未抓包”的接口，后续抓到请求后再补全。

只补充新增发现（`interfaces` 与兼容字段 `interface_dir` 可同时出现）：

```json
sync_asset_info({
  "host_port": "https://opcenter.example.com/login",
  "project_name": "示例云课堂",
  "interfaces": [
    { "path": "/api/v1/new/export", "method": "POST", "params": "taskId=88" }
  ],
  "interface_dir": ["/api/v1/legacy/notify"],
  "mode": "merge"
})
```

`interface_dir` 是旧版写法：服务端会把它规范化为 `{ "path": "/api/v1/legacy/notify" }` 后与 `interfaces` 合并，不会报错；新数据建议直接写 `interfaces`。

### 5. 关联漏洞

确认漏洞后：

1. 先 `query_vulnerabilities({ host })` 查重，再 `save_vulnerability` 入库；
2. 再 `sync_asset_info` 把新漏洞 ID 写入 `related_vuln_ids`；
3. 资产库的「关联漏洞」Tab 会展示同 Host 自动匹配 + 显式关联的漏洞。

## 常见错误

- ❌ 把单独 IP / IP:端口（如 `10.0.0.5`、`10.0.0.5:22`）当资产入库；IP 必须写成完整 http(s) URL；
- ❌ 把 `main.js`、`app.css`、`logo.png` 等静态资源写进 `interfaces` / `interface_dir`；
- ❌ 只写纯路径却不补 `method` / `params` / `request`（新数据应优先 `interfaces`，抓包确认后逐条补全）；
- ❌ `request` 只写路径或 URL（它必须是完整原始 HTTP 请求：请求行 + Host/headers + 可选 body）；
- ❌ `tech_stack` 用省略号或一整串无分隔符拼接（界面无法拆成独立标签）；
- ❌ 只写主机名却无法定位具体 Web 入口（请优先记录完整 URL + 路径）；
- ❌ 用空 `interfaces` / `interface_dir` 覆盖已有接口；
- ❌ 编造 AK/SK、Token 或未验证的泄露；
- ❌ `potential_impact` 只重复 value，不写可利用性；
- ❌ 把密码 / Token / AK / PII 写进 `test_parameters`（属于 `leaked_infos`），或把普通 id / 订单号当敏感泄露、把整段响应塞进 `values`（只放 ≤50 个样例 + `pattern`）；
- ❌ 漏洞写入后忘记关联资产。

## 安装到 Agent

推荐用 `ctx init` 一次完成 MCP 配置 + 三个 Skill + 系统级规则（`--dry-run` 只预览，`--agents` 指定客户端）：

```powershell
ctx init
ctx init --dry-run
ctx init --agents dsh,claude,codex,cursor
```

- DSH：Skill 安装到 `~/.agents/skills/asset-context/SKILL.md`，硬性规则写入 `~/.dsh/AGENTS.md`；
- Codex：Skill 安装到 `~/.codex/skills/asset-context/SKILL.md` 与共享 `.agents/skills`，规则写入 `~/.codex/AGENTS.md`；
- Claude Code：Skill 安装到 `~/.claude/skills/asset-context/SKILL.md`，规则写入 `~/.claude/CLAUDE.md`；
- Cursor：MCP 配置写入 `~/.cursor/mcp.json` 的 `mcpServers`（stdio），由 `ctx init` 按客户端能力处理。
- MCP 由 Agent 自动拉起（stdio），无需启动桌面端；GUI 只是查看端，可随时开关。
- 数据库：Windows `%USERPROFILE%\.cortex\data.db`，macOS/Linux `~/.cortex/data.db`；可用 `CTX_DB_PATH` 覆盖（旧版 `PDH_DB_PATH` 仍可用）。
- 需要手工配置时，用 `ctx mcp print-config <agent>` 打印与 GUI「MCP 接入」页一致的 stdio 配置片段。

### 安装后自检

1. 重启 Agent；在工具列表中确认存在 6 个工具：`save_vulnerability`、`query_vulnerabilities`、`update_vulnerability`、`sync_asset_info`、`query_asset_context`、`manage_snapshot`。
2. 让 Agent 执行一次 `query_asset_context`、`query_vulnerabilities` 与 `manage_snapshot({ action: "list" })`（只读）确认链路通畅。
3. 完成一次资产侦察后，确认 Agent 主动调用 `sync_asset_info`；再次用 `query_asset_context({ host_port })` 读取时能看到结构化接口与敏感泄露。
4. 工具缺失或连接断开时运行 `ctx doctor`，按提示修正配置后重启 Agent。
