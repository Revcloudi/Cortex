# dsh-cortex

把本地 **Cortex**（漏洞库 / 资产库 / 内网作战 / 认知快照）搬进 **DeepSeek Harness** 的原生面板插件。
Host 半边用 `node:sqlite` 直接读取本地 Cortex SQLite（schema v5），浏览器半边通过同源
`fetch('/cortex-api/...')` 渲染 6 个页签：概览、漏洞、资产、内网、快照、复测。

- **不需要**启动 Cortex 桌面端 / CLI / Web 进程，也**不依赖 MCP**；
- **不修改** Cortex 数据库结构，**不自动迁移**，schema 不是 v5 时只读拒绝；
- 只监听 loopback，仅本机可用；凭据 secret **永不出库**；
- 全部 UI 中英双语，跟随 DSH 语言设置。

---

## 环境要求（Compatibility）

| 项 | 要求 | 说明 |
|---|---|---|
| DeepSeek Harness | **0.2.2-rc.1** | 依赖其 Client 模块加载器、`slots` / `locale` 服务与 `webServer.register(prefix)` |
| Node.js | **>= 22.19.0** | 依赖内置 `node:sqlite`（`DatabaseSync`） |
| Cortex 数据库 | **schema v5** | `PRAGMA user_version` 必须为 `5` |
| 操作系统 | 无特殊要求 | 仅 127.0.0.1 本机访问 |

> ⚠️ **只读保障**：如果 `PRAGMA user_version` 不是 5（例如 v4 或未来 v6），插件**不会自动迁移、不会写库**，
> 所有数据接口返回 `409 { code: "SCHEMA_INCOMPATIBLE" }`，界面显示“schema 不兼容”提示。

---

## 安装（Install）

### 方式 A：本机目录 / 链接安装（开发与内测）

在 DSH 中让 Agent 调用内置管理工具（推荐，由 DSH 维护 profile，不要手写 profile 的 `package.json` / `cordis.patch.yml`）：

```text
plugin_manager action=install_bundle target="C:\absolute\path\to\dsh-cortex"
```

或使用 DSH CLI：

```bash
dsh plugin --profile desktop add link:C:\absolute\path\to\dsh-cortex
```

### 方式 B：发布后从 registry 安装

```bash
dsh plugin add dsh-cortex
```

安装后重启 / 重载 DSH，侧边栏出现 Cortex 图标（`sidebar.panellist` 中 `order: 5`），
主面板注册 `main` key `cortex`。

### 卸载（Uninstall）

```text
plugin_manager action=remove_bundle target="dsh-cortex"
```

或：

```bash
dsh plugin remove dsh-cortex
```

卸载只移除插件注册；**不会删除**你的 Cortex 数据库。

---

## 配置（Configuration）

v1 以环境变量为主（在启动 DSH 的 shell / 桌面端环境中设置）：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CORTEX_DB_PATH` | `~/.cortex/data.db`（Windows：`%USERPROFILE%\.cortex\data.db`） | Cortex SQLite 文件路径；可指向副本做演练 |
| `CORTEX_DB_READONLY` | 未设置 | 设为 `1` 时强制只读：PATCH 状态、POST 复测追加、`/retest/send` 全部返回 `403 READ_ONLY` |

```powershell
# Windows PowerShell 示例
$env:CORTEX_DB_PATH = "C:\Users\me\.cortex\data.db"
$env:CORTEX_DB_READONLY = "1"     # 可选：只读模式
```

可选的行内配置（bundle patch 的 insert 行允许时，由 DSH loader 透传到 `apply(ctx, config)`）：

```yaml
# cordis.patch.yml（本仓库已内置，通常无需修改）
- insert:
    - id: dsh-cortex
      name: 'dsh-cortex'
      config:
        dbPath: 'C:\Users\me\.cortex\data.db'   # 可选，等价于 CORTEX_DB_PATH
        readOnly: false                          # 可选，等价于 CORTEX_DB_READONLY
```

> `config.allowNetwork` 为预留字段，v1 不开放：出站复测始终受 allowlist + SSRF 防护约束。

---

## 数据与安全模型（Data & Security Model）

**数据流**：Cortex SQLite(schema v5) ──`node:sqlite` 只读/受限写──> Host 插件（`/cortex-api`）──同源 fetch──> 浏览器面板

- **无 Cortex 进程、无 MCP 依赖**：Host 直接以 `DatabaseSync` 打开数据库文件；打开参数
  `readOnly` + `PRAGMA busy_timeout=5000` + `PRAGMA foreign_keys=ON`；**不修改** `journal_mode`；
  本机 Cortex 正在运行时通常仍可只读并发（WAL）。
- **写入面极小**：仅允许两种写操作 —— ① 修改漏洞 `status`；② 向 `retest_results` **追加**一条复测记录。
  复测追加使用 `BEGIN IMMEDIATE` + `SQLITE_BUSY` 重试（3 次），**绝不覆盖**原始证据与其它列。
- **凭据脱敏**：`credentials.secret` 永不返回浏览器；接口只暴露 `secretMasked`（如 `••••` / `ab••••z`）与
  `secretLength`，在 CI 集成测试中会扫描所有响应原文断言 secret 不出现。
- **loopback 栅栏**（所有接口）：① peer 必须是 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`；② `Host` 头必须是
  loopback；③ 写操作校验 Origin 为 loopback 或缺省、`Sec-Fetch-Site` 为 `same-origin`/`none`、
  `Content-Type: application/json`；④ 不返回 CORS 头，`OPTIONS` 直接 405。
- **错误与日志**：错误统一 `{ error, code, details? }`，不泄露堆栈 / SQL / 数据库绝对路径；日志不输出 SQL、凭据、请求体。
- **复测出站（`POST /retest/send`）**：仅 http(s)；默认**不跟随重定向**（手动开启后最多 5 跳，每跳重新校验）；
  目标 origin 必须在 allowlist（漏洞 `target_url` ∪ 对应资产 origin ∪ `service_host` origin）；
  拒绝 userinfo URL、云元数据地址（`169.254.169.254` 等）；15s 超时、响应体 ≤2MB 截断。
- **报告下载**：`GET /cortex-api/reports/:vulnId` 返回 Markdown，`Content-Disposition: attachment`，
  文件名 `VULN-....md`，可离线归档。

---

## 功能页面（Pages）

| 页签 | 内容 |
|---|---|
| **概览 Overview** | Web / 内网漏洞计数、严重级别与状态分布、Host 数、资产数、项目列表、最近漏洞（可点击跳转详情） |
| **漏洞 Vulns** | 搜索 + severity/status/realm 筛选 + 分页；列表与详情（描述、影响、Markdown 复现步骤、修复建议、复测历史、关联漏洞）；修改状态；下载 Markdown 报告；“去复测” |
| **资产 Assets** | 搜索 + 状态筛选 + 分页；详情展示技术栈、结构化接口（path/method/params/原始 HTTP 请求可展开）、泄露信息、测试参数、关联漏洞 |
| **内网 Internal** | 项目选择器；footholds / hosts / services / credentials / pivots 表格与 stats；凭据只显示 `username · secretMasked (len N)`；关系图（graph 接口的 nodes/edges） |
| **快照 Snapshots** | 项目选择器 + includeArchived 开关；父/子会话树；详情九字段 + testedInterfaces + 关联漏洞（v1 只读） |
| **复测 Retest** | 仅 Web 漏洞；从复现步骤解析多个 ```http 请求块 → 步骤按钮逐个发送；默认不跟随重定向，3xx 时提供“跟随重定向”；响应原文 / 沙箱 iframe HTML 切换；可顺带修改漏洞状态 |

界面只使用 DSH 主题 token（`--dsw-alias-*` / `--dsw-specific-*`），不写死颜色，自动适配浅色/深色主题。

---

## 已知限制（Known Limits）

1. **仅 loopback**：非本机访问（peer / Host / Origin 非回环）一律 403；不支持局域网共享。
2. **仅 schema v5**：不做自动迁移；其它版本只读拒绝（409 SCHEMA_INCOMPATIBLE）。
3. **快照 v1 只读**：只展示 session 九字段与关联漏洞，不提供创建 / 更新 / 归档操作（请在 Cortex 桌面端操作）。
4. **复测仅 Web 漏洞**：`realm=internal` 的漏洞不出现在复测页；复测发送受 allowlist 限制，不能对任意地址发起请求。
5. **无浏览器可视化验证**：交付验证只覆盖 slot 注册 / HTTP 接口 / jsdom 渲染冒烟；本环境没有浏览器控制能力，**没有**在真实 DSH GUI 中做截图级视觉验证。
6. **凭据只读脱敏**：不提供展示/复制明文 secret 的入口，也不支持在插件内试密码。
7. **Cortex 运行中并发写**：插件自身写操作用 `BEGIN IMMEDIATE` 重试，但若 Cortex 长时间持有写锁，修改状态可能返回 `503/BUSY`（重试后仍失败则提示稍后再试）。

---

## 开发（Development）

```bash
# 依赖（仅测试/构建需要；生产环境由 DSH 提供 React）
npm install

# 构建浏览器半边 → client.js（生成物，不要手改）
npm run build          # 等价：node scripts/build-client.mjs
```

> **开发热更新（HMR）**：以 `link:` / 本机目录方式安装时，DSH 的 client-hmr 会对链接后的
> `client.js` 做 stat 轮询 —— 重新 `npm run build` 后浏览器端的 Cortex 面板会被**热替换**，
> 通常无需手动刷新页面。Host 半边（`index.js` / `src/host/**`）的改动不属于 client HMR 范围，
> 需要重载 DSH 才生效。

```bash
# 全部测试（manifest / client / host / integration，默认递归发现 *.test.mjs）
node --test            # 等价于 npm test

# 单独跑（Node 24 建议显式 glob；直接把目录传给 --test 会被当成模块而报错）
node --test test/manifest.test.mjs
node --test test/client/shell.test.mjs
node --test "test/host/**/*.test.mjs"
node --test "test/integration/**/*.test.mjs"
node --test fixtures/build-schema.test.mjs
```

测试全部使用**临时夹具数据库**（`fixtures/build.mjs` 的 `createFixtureDb()` 由 `fixtures/schema5.sql` + `fixtures/seed.json` 生成），
不会读写你真实的 `~/.cortex/data.db`。冒烟脚本：

```bash
node scripts/smoke-client.mjs
node scripts/smoke-host.mjs       # 自带临时 fixture DB，起 127.0.0.1 临时服务
```

---

## 文件布局（Layout）

```
dsh-cortex/
├─ index.js                  # Host 入口（apply / inject webServer → /cortex-api）
├─ client.js                 # 浏览器 bundle（node scripts/build-client.mjs 生成，勿手改）
├─ cordis.patch.yml          # bundle patch：insert id/name = dsh-cortex
├─ icon.svg                  # 侧边栏图标
├─ locale/{en,zh}.json       # bundle 元信息（meta.title / meta.description）
├─ src/
│  ├─ host/                  # DB / repository / DTO / router / security / reports / retest-send
│  └─ client/                # CommonJS 客户端源码：index.js(shell) / pages/ / ui/ / lib/ / styles.js
├─ fixtures/
│  ├─ schema5.sql            # 真实 Cortex schema v5 DDL（测试夹具）
│  ├─ seed.json              # 合成种子数据（全 example.test + RFC 5737 地址，假凭据）
│  └─ build.mjs              # createFixtureDb(dbPath, opts) 同步建库
├─ test/                     # manifest / client / host / integration 测试
├─ scripts/                  # build-client.mjs / smoke-client.mjs / smoke-host.mjs
├─ docs/                     # contracts.md / dsh-api-confirmed.md（团队契约）
└─ recon/                    # 只读侦察脚本（dump-schema / inspect-db）
```

### `/cortex-api` 接口一览

```text
GET  /cortex-api/health
GET  /cortex-api/stats?realm=web|internal|all
GET  /cortex-api/vulns?realm=&search=&severity=&status=&page=&pageSize=
GET  /cortex-api/vulns/:id
PATCH /cortex-api/vulns/:id/status          # { status }
POST /cortex-api/vulns/:id/retest           # { timeRange, conclusion }（append-only）
GET  /cortex-api/assets?search=&status=&page=&pageSize=
GET  /cortex-api/assets/:hostPort
GET  /cortex-api/internal/projects
GET  /cortex-api/internal/overview?project=
GET  /cortex-api/internal/graph?project=
GET  /cortex-api/snapshots?project=&includeArchived=0|1&page=&pageSize=
GET  /cortex-api/snapshots/:sessionId
GET  /cortex-api/reports/:vulnId            # text/markdown attachment
POST /cortex-api/retest/send                # SSRF-safe 出站 HTTP
```

---

## License

MIT（见 `package.json`）。Cortex 数据库与数据归你所有；本插件不采集、不上传任何数据。
