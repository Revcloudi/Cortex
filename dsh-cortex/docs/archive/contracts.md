# dsh-cortex 实现契约（Host / Client / 测试 / 文件所有权）

本文件是团队并行开发的唯一接口契约。**不要修改本文件**（Lead 维护）；实现有疑问先看本文件，再问 Lead。

## 0. 仓库与边界

- 仓库：`C:\Users\slg13\Desktop\dsh-cortex`（与 Cortex 仓库 `C:\Users\slg13\Desktop\Electron` **完全无关**）
- 禁止：import Cortex 源码、启动 Cortex Web/桌面进程、MCP、修改 DSH 安装目录、手写 profile 的 package.json/cordis.patch.yml、自动迁移 Cortex DB。
- Host 只通过 `node:sqlite` 只读/受限写 Cortex DB（schema v5）；浏览器只通过同源 `fetch('/cortex-api/...')`。
- 所有面向用户的 UI 文案中英双语；仅用 `--dsw-alias-*` / `--dsw-specific-*` 主题 token，不写死颜色。

## 1. 文件所有权（写文件前必须确认）

| 范围 | 所有者 | 说明 |
|---|---|---|
| `package.json` `cordis.patch.yml` `index.js` `icon.svg` `locale/*.json` `client.js`（构建产物） `scripts/**` `src/client/index.js` `src/client/styles.js` `src/client/lib/api.js` `src/client/lib/format.js` `src/client/lib/httpparse.js` `src/client/locales.js` `src/client/ui/kit.js` `docs/**` | **Lead** | 其它人只读 |
| `src/host/**`（除 `index.js`） | **host-api** | DB/仓库/路由/DTO/报告/复测发送 + `test/host/**` |
| `src/client/pages/vulns.js`、`src/client/lib/markdown.js` | **client-vulns** | 漏洞列表/详情/状态写/报告下载/Markdown 渲染 + `test/client/vulns.test.mjs` |
| `src/client/pages/overview.js`、`assets.js`、`internal.js`、`snapshots.js` | **client-aux** | 概览/资产/内网/快照 + `test/client/aux-pages.test.mjs` |
| `src/client/pages/retest.js` | **client-retest** | 复测页（解析步骤/发送/重定向/HTML iframe）+ `test/client/retest.test.mjs` |
| `fixtures/**`（除 Lead 生成的 schema5.sql 可改）、`README.md`、`test/manifest.test.mjs`、`test/client/shell.test.mjs`、`test/integration/**` | **qa-package** | 测试夹具/清单测试/安装与打包验证/README |

**client 页面文件是占位文件由 Lead 先建，对应 owner 覆盖实现。** 不要跨范围写文件。

## 2. Host 侧

### 2.1 入口约定（Lead 写 `index.js`）

```js
// src/host/app.js 必须导出：
export function createCortexHost({ config }) {
  return {
    handler(req, res): Promise<void> | void,  // 挂在 /cortex-api（prefix），完整 path 已在 req.url
    dispose(): Promise<void> | void,          // 关闭 DB 连接等
  }
}
```
`config`：`{ dbPath?: string, readOnly?: boolean, allowNetwork?: boolean }`（可选；v1 主要用环境变量 `CORTEX_DB_PATH`、`CORTEX_DB_READONLY=1`）。

### 2.2 DB 打开 / schema guard（`src/host/db.js`）

- `node:sqlite` 的 `DatabaseSync`；默认路径 `join(os.homedir(), '.cortex', 'data.db')`，`CORTEX_DB_PATH` 可覆盖。
- 打开参数：`{ readOnly: config.readOnly || env CORTEX_DB_READONLY==='1' }`。
- 打开后执行 `PRAGMA busy_timeout = 5000`、`PRAGMA foreign_keys = ON`；**不修改 journal_mode**。
- `PRAGMA user_version` 必须为 **5**：不是 5 → 返回兼容状态，所有数据接口 409，**绝不自动迁移、绝不写库**。
- 懒打开（首次请求时打开），失败不 throw 到进程；`health()` 返回 `{ available:false, error }`。
- 打开失败/文件被替换时：下次请求重试打开（最多一次），不崩溃。
- 日志：**禁止**输出 SQL、凭据、请求体、DB 绝对路径。错误信息给用户时也不含绝对路径。

### 2.3 Repository（`src/host/repository.js`）+ DTO（`src/host/dto.js`）

- 所有 SQL 参数绑定；`pageSize ≤ 100`、`page ≥ 1`。
- JSON 列安全 parse，损坏回退 `[]`/`{}`；`auth_required` 0/1 → boolean；时间保持 ISO 字符串原样。
- `credentials.secret` **绝不返回 Client**；只返回 `secretMasked`（如 `••••` 或 `ab••••z` 形式）+ `secretLength`。
- 写操作：`BEGIN IMMEDIATE` + `SQLITE_BUSY` 重试（3 次，50/100/200ms）；只改 `status` 或向 `retest_results` **追加**（不覆盖原始证据、不改其它列）。
- 只读模式下所有写接口返回 403 `{code:'READ_ONLY'}`。

### 2.4 HTTP 路由（`src/host/router.js` / `src/host/http.js`）

注册 `{ kind:'prefix', path:'/cortex-api', handler }`。处理函数收到的 `req.url` 形如 `/cortex-api/vulns?...`。

**安全栅栏（全部接口）**：
1. loopback peer：`req.socket.remoteAddress` ∈ {`127.0.0.1`,`::1`,`::ffff:127.0.0.1`}，否则 403 `{code:'FORBIDDEN_PEER'}`。
2. loopback Host header：`host` 去掉端口后 ∈ {`127.0.0.1`,`localhost`,`::1`,`[::1]`}，否则 403 `{code:'FORBIDDEN_HOST'}`。
3. 写操作（PATCH/POST）：Origin 缺省或为回环 origin；`Sec-Fetch-Site` ∈ {`same-origin`,`none`}（缺省视为 none）；`Content-Type: application/json`；否则 403。
4. 不返回 CORS 头；OPTIONS → 405。

**错误格式**：`{ error: string（人类可读，可中文/英文）, code: string, details?: any }`
- 400 `BAD_REQUEST`（参数非法）、403 `READ_ONLY`/`FORBIDDEN_*`、404 `NOT_FOUND`、405 `METHOD_NOT_ALLOWED`、409 `SCHEMA_INCOMPATIBLE`、502 `UPSTREAM_ERROR`/`UPSTREAM_TIMEOUT`。
- 未捕获异常 → 500 `{code:'INTERNAL', error:'internal error'}`（不泄露堆栈/路径/SQL）。

**响应**：`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`；报告接口 `text/markdown; charset=utf-8`。
请求体上限 1MB；查询参数长度上限 200（search 400）。

### 2.5 接口清单（v1 必须全部实现）

```
GET  /health
GET  /stats?realm=web|internal|all（缺省 all）
GET  /vulns?realm=&search=&severity=&status=&page=&pageSize=
GET  /vulns/:id
PATCH /vulns/:id/status        body { status: 'Confirmed'|'Inconclusive'|'Retest_Passed' }
POST /vulns/:id/retest         body { timeRange: string(≤200), conclusion: string(≤50000, Markdown) }  // append-only
GET  /assets?search=&status=&page=&pageSize=
GET  /assets/:hostPort         // 路径参数是 encodeURIComponent 的 host_port（可能含 / :）
GET  /internal/projects
GET  /internal/overview?project=
GET  /internal/graph?project=
GET  /snapshots?project=&includeArchived=0|1&page=&pageSize=
GET  /snapshots/:sessionId
GET  /reports/:vulnId          // Markdown 报告（Content-Disposition: attachment; filename="VULN-....md"）
POST /retest/send              // SSRF-safe 出站 HTTP，body 见下
```

DTO（字段名 camelCase；**所有字段都要有**，缺省用 null/[]/0）：

```ts
VulnSummary { id, host, vulnName, vulnType, severity, status, realm, serviceHost, targetUrl, entryPoint,
              createdAt, retestCount, latestRetestAt: string|null }
VulnDetail extends VulnSummary {
  description, impact, affectedInterfaces: string[], reproductionSteps, remediation: string[],
  cryptoDetails, testBoundaries, retestResults: {timeRange:string, conclusion:string}[],
  relatedVulnIds: string[], internalServiceId
}
GET /vulns/:id -> { vuln: VulnDetail, related: VulnSummary[] }
GET /vulns -> { items: VulnSummary[], total, page, pageSize, pages, filters: {severities,statuses,realms} }

Stats -> {
  counts: { web:int, internal:int, total:int },
  bySeverity: { Critical:int, High:int, Medium:int, Low:int, Info:int },
  byStatus: { Confirmed:int, Inconclusive:int, Retest_Passed:int },
  hosts: int,            // distinct vulnerabilities.host + assets.host_port 去重
  assets: int,
  projects: string[],
  recent: VulnSummary[]  // 最近 8 条，created_at DESC
}
GET /health -> {
  ok: boolean,
  plugin: 'dsh-cortex', version: string, dsh: { version: '0.2.2-rc.1' },
  sqlite: true,
  db: { available: boolean, schemaVersion: number|null, compatible: boolean, readOnly: boolean,
        busy: boolean, dbFile: 'data.db', error: string|null },
  server: { loopbackOnly: true, time: string }
}

AssetSummary { hostPort, host, projectName, techStack, authRequired, status, lastSeen,
               interfaceCount, vulnCount }
AssetDetail extends AssetSummary {
  interfaces: {path, method?, params?, request?}[],   // request 是完整原始 HTTP 文本，可空
  interfaceDir: string[],
  leakedInfos: {infoType, value, source, potentialImpact}[],
  testParameters: {name, endpoint, location, values: string[], pattern?, source, tested, notes?, relatedVulnIds?: string[]}[],
  relatedVulnIds: string[]
}
GET /assets -> { items: AssetSummary[], total, page, pageSize, pages, projects: string[] }
GET /assets/:hostPort -> { asset: AssetDetail, related: VulnSummary[] }

InternalOverview { project, footholds: Foothold[], hosts: InternalHost[], services: InternalService[],
                   credentials: CredentialMasked[], pivots: Pivot[], stats: {footholds,hosts,services,credentials,pivots} }
Foothold { id, entryHostPort, entryVulnId, accessType, privilegeLevel, status, evidence, notes,
           establishedAt, lastVerifiedAt, hostIds: string[] }
InternalHost { id, ip, hostname, os, subnet, state, source, confidence, lastSeen }
InternalService { id, hostId, port, protocol, service, banner, state, source, lastSeen }
CredentialMasked { id, type, username, domain, source, hostId, serviceId, confidence, status, notes,
                   secretMasked: string, secretLength: number }   // 绝无 secret 原文
Pivot { id, footholdId, kind, localHost, localPort, localProtocol, tool, status, notes,
        establishedAt, lastVerifiedAt, hops: {seq,refKind,refId,label,via}[], reachableSubnets: string[] }
GET /internal/projects -> { projects: { projectName, footholds, hosts, services, credentials, pivots }[] }
GET /internal/overview?project= -> InternalOverview（project 缺省取第一个项目）
GET /internal/graph?project= -> { nodes: {id,kind:'foothold'|'host'|'service'|'credential'|'pivot',label,sub?}[],
                                  edges: {from,to,kind}[] }

SnapshotSummary { sessionId, projectName, currentPhase, targetHosts: string[], parentSessionId: string|null,
                  archivedAt: string|null, createdAt, updatedAt, nextSteps, relatedVulnIds: string[], childCount }
GET /snapshots?project=&includeArchived -> { projects: string[], sessions: SnapshotSummary[] }
SnapshotDetail extends SnapshotSummary {
  unfinishedTasks: string[], failedPaths: string[],
  testedInterfaces: {target, method, result}[],
  notes, nextSteps, previousState: object|null, relatedVulnIds: string[]
}
GET /snapshots/:sessionId -> { session: SnapshotDetail, children: SnapshotSummary[], relatedVulns: VulnSummary[] }
GET /snapshots/... 404 时 NOT_FOUND

POST /retest/send body {
  vulnId: string,                  // 必填；用于 origin allowlist 与审计（只读查询）
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS'（大写）,
  url: string,                     // http/https 绝对 URL
  headers: Record<string,string>,  // 可选；禁止 Host/Content-Length/Connection
  body: string,                    // 可选（≤256KB）
  followRedirects: boolean         // 默认 false
}
-> { status, statusText, url, finalUrl, headers: Record<string,string>, body: string,
     bodyBytes: number, bodyTruncated: boolean, contentType: string, durationMs,
     redirects: {url,status,location}[] }
```
**出站安全**：默认不跟随重定向；`followRedirects=true` 时最多 5 跳、每跳都重新校验 allowlist。超时 15s；响应体 ≤2MB（超出截断并标记）；拒绝非 http(s)、带 userinfo 的 URL、指向 169.254.169.254/元数据地址的 URL。
**allowlist**（origin allowlist）：允许的 origin 集合 = 该漏洞 `target_url` origin ∪ 该漏洞 `host` 对应资产（`assets.host_port`/`host`）的 origin ∪ 该漏洞 `service_host` 的 origin。不在集合 → 403 `{code:'ORIGIN_NOT_ALLOWED', details:{allowed:[...]}}`。
日志不输出请求头/体/凭据。

### 2.6 报告 Markdown（`src/host/reports.js`）

`GET /reports/:vulnId` 生成完整 Markdown 报告，结构：
```
# {vuln_name}

- 漏洞 ID / Host / 入口 / 类型 / 严重级别 / 状态 / 时间
## 描述
## 影响
## 受影响接口
## 复现步骤
## 复测记录（如有）
## 修复建议
## 测试边界 / 加密细节（如有）
## 关联漏洞
```
只读查询，404 同其它接口。

### 2.7 测试（host-api 负责 `test/host/**`）

- 用 `fixtures/schema5.sql`（qa-package 维护）建临时 DB，覆盖：JSON 损坏回退、分页上限、状态修改、复测 append 保留历史、schema≠5 时 409 且不写、只读模式写拒绝、凭据无 secret、loopback fence（peer/Host/Origin）、错误格式。
- 路由测试用 `node:http` 起临时 127.0.0.1 服务（真实 `handler`），`fetch` 断言；不得连接真实 `~/.cortex/data.db` 做写测试（读可）。
- 运行：`node --test test/host/`。

## 3. Client 侧

### 3.1 构建

- 源码：`src/client/**`（CommonJS 风格，`require('react')` + 相对 `require('./x')`）；**禁止** import 任何 DSH Client 包。
- 构建：`node scripts/build-client.mjs` → 产出根目录 `client.js`（`window.__ModuleLoader__.load({id:'dsh-cortex', factory})`）。不要手改 `client.js`。
- `src/client/index.js`（Lead）导出模块对象 `{ name, inject: ['slots','locale'], apply(ctx) }`。
- `apply` 中：
  - 注册 locale 字典（shell + 每个 page 的 messages，namespace `dsh-cortex.<pageId>`）；
  - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name:'sidebar.panellist', id:'cortex', order:5, label: () => t('panel.title')}, PanelIcon))`
  - `ctx.slots.inject('main', () => ctx.slots.register({name:'main', key:'cortex'}, CortexPage))`
  - `ctx.effect(() => { styles.insert(CSS); return unsubscribe/abort ... })`
- 卸载：abort 所有 fetch、退订 locale。

### 3.2 页面模块契约（pages/*.js）

每个页面导出（CJS）：
```js
module.exports = {
  id: 'vulns',                                  // 与 shell tab id 一致
  messages: { zh: {...}, en: {...} },            // 扁平 key → 文案，值内可用 {name} 占位（自行 replace）
  Component,                                    // function Component(props)
}
```
Component props（只读使用，不得改 shell 内部状态结构）：
```js
{
  api,        // lib/api.js 的 ApiClient：get(path, params?) / getText(path) / patch(path, body) / post(path, body)
              // 全部返回 Promise；失败 throw ApiError { status, code, message, details }
  t,          // (key, vars?) => string；本页 namespace，带 {var} 插值，locale 切换后自动取新值
  locale,     // 'zh' | 'en' | 其它
  nav,        // { tab, params, go(tabId, params?) }  // 切换主页面 tab
  app,        // { health, refreshHealth(), reloadAll(), version }  // shell 只读快照
  toast,      // (message, tone?: 'info'|'ok'|'error') => void
}
```
- 页面自己管理加载/空/错误/部分数据 UI（用 `ui/kit.js` 的 `Empty`/`ErrorBox`/`Spinner`/`DataTable`/`Card`/`Badge`/`Split`/`Modal`/`Field` 等）。
- 所有可见文案走 `t()`；不要把中文硬编码在 JSX 文本里。
- 只用 `ui/kit.js` 导出的 `S.*`（token 样式对象）与主题 token；不写死颜色。
- 键盘可访问：可点击行/按钮用 `<button>`；详情面板 Escape 关闭；表格行支持 Enter 打开。
- 窄屏（<720px）：列表与详情改为上下布局（`Split` 已处理）。
- 禁止 `document.*` 写 DOM、禁止全局 CSS 选择器、禁止 import DSH 包。

### 3.3 共享 shell（Lead 实现 src/client/index.js）

- 顶部：`Cortex` 标题 + DB/schema 状态徽标 + 刷新按钮 + 设置（弹窗显示只读/DB 状态/版本/仅本机访问说明）+ 语言（跟随 DSH，不单独切换）。
- 横向页签：`overview | vulns | assets | internal | snapshots | retest`（顺序固定，role=tablist，左右方向键切换）。
- 全局状态：health 加载 / 不可用（含非本机访问 403）/ schema 不兼容（409）/ 只读 / 正常；顶部 banner + 页面级 ErrorBox。
- 刷新：`app.refreshHealth()` + `nav` 递增 `rev` 让页面重取？页面统一用 `useEffect([rev])` 自取数据，shell 提供 `app.reloadAll()` 递增内部 revision 并通过 `app.rev` 传给页面（props 增加 `rev: number`）。
- 页面切换保留各页状态（不卸载已访问页？简化：只挂载当前页，切走卸载；可接受）。

### 3.4 页面功能要求

- **overview**：Web/内网漏洞计数、严重级别/状态分布条、Host 数、资产数、项目、最近漏洞（点击跳 vulns 详情）。
- **vulns**：搜索 + severity/status/realm 筛选 + 分页（pageSize 20/50/100）；列表列：ID/名称/Host/级别/状态/Realm/时间；详情：描述、影响、Markdown 复现、修复、复测历史、关联漏洞；状态可改（PATCH）；报告 Markdown 下载（`<a href="/cortex-api/reports/:id" download>`）；“去复测”按钮 `nav.go('retest',{vulnId})`。
- **assets**：搜索 + 状态筛选 + 分页；列表；详情：技术栈、结构化接口（path/method/params/request 可展开）、泄露信息（infoType/value/source/potentialImpact）、测试参数、关联漏洞。
- **internal**：项目选择器；stats + footholds/hosts/services/credentials/pivots 表格；credential 只显示 `${username} · ${secretMasked} (len N)`；P1 可选关系图（无则列出 edges）。
- **snapshots**：项目选择器 + includeArchived 开关；项目 → 父/子会话树/列表；详情显示九字段 + testedInterfaces 表 + relatedVulns；P0 只读。
- **retest**：只列 Web 漏洞（realm=web）；选择漏洞后从 `reproductionSteps` 解析所有 ```http 请求块 → 顶部「步骤1/步骤2…」按钮；点击发送（默认不跟随重定向）；3xx+Location 时显示「跟随重定向」按钮；响应体 原文/HTML 切换（HTML 用 `<iframe sandbox="" srcdoc={...}>` 渲染）；顶部可改漏洞状态并显示结果。

## 4. 测试与验收

- `node --test test/`（qa 汇总；host 测试与 client 测试分开可跑）。
- client 测试：用 jsdom + 自研 bundle 加载（`test/client/shell.test.mjs` 由 qa 写）；mock fetch。
- manifest 测试：`package.json` exports/files/dsh.client/locale/icon 存在且可解析；`npm pack` 文件清单包含 `client.js`、`index.js`、`src/**`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`。
- 安装验证（Lead 执行）：`plugin_manager install_bundle` → `application: applied`；`cordis_inspect_query` 确认 `sidebar.panellist` 有 `cortex` occupant、`main` 有 `cortex` occupant；`curl http://127.0.0.1:63877/cortex-api/health` 200 且 `schemaVersion:5`。
- 已知限制必须如实写入 README/报告：loopback only、DSH 版本、schema v5、快照 v1 只读、无浏览器可视化验证。

## 5. 常用命令

```powershell
# 构建 client
node scripts/build-client.mjs
# 跑全部测试（Node 24：目录参数会被当成模块，必须用默认递归发现或 glob）
node --test
node --test "test/host/**/*.test.mjs"
# 本地冒烟（不依赖 DSH 安装）
node scripts/smoke-client.mjs
node scripts/smoke-host.mjs
node scripts/smoke-host-edge.mjs --live
# 已安装后对运行中的 DSH 做端到端校验（--write 会做状态改回环）
node scripts/verify-live.mjs --write
node scripts/watch-events.mjs 3000   # 读取 client 插件 SSE 图，验证 HMR rebuilt
```
