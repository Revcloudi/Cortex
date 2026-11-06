# dsh-cortex 实现报告（2026-11-06）

> 目标：在不依赖 Cortex 仓库代码、MCP、Cortex Web/桌面端进程的前提下，把本地 Cortex SQLite
> （schema v5）的漏洞 / 资产 / 内网 / 快照 / 复测能力，实现为 DSH 0.2.2-rc.1 的原生全局面板插件。
> 独立仓库：`C:\Users\slg13\Desktop\dsh-cortex`（与 `C:\Users\slg13\Desktop\Electron` 无任何引用关系）。

## 1. 结论摘要

| 验收项 | 结果 | 证据 |
|---|---|---|
| 安装后左侧出现 Cortex 入口，点击进入整页 | ✅ 已注册（视觉未截图，见限制） | `sidebar.panellist` occupant：`dsh-cortex / id=cortex / order=5 / active=true`；`main` occupant `key=cortex, active=true`；SSE 客户端图含 `dsh-cortex` bundle 条目（rev `a8a45f48f7ba`，HTTP 200，233,703 B，内容含最终页面） |
| 漏洞列表/筛选/分页/详情与 Cortex 数据一致 | ✅ | 实测 `verify-live.mjs` 与真实 DB 逐项对账：总数 13、web 9 / internal 4、severity 过滤、search、详情 `vuln_name` 一致、报告 Markdown |
| 状态修改后 Cortex 桌面端/CLI 能读到新状态 | ✅ | `PATCH /vulns/:id/status` → 直接用 `node:sqlite` 只读另一连接读 `~/.cortex/data.db` 断言新状态已落盘，随后恢复原值（44/44 通过） |
| 资产/内网/快照页面可打开，凭据 masked | ✅ | 接口 200；`internal` 响应全文无 `"secret"` 键；Host 单测断言原始 secret 字符串不出现在任何响应；真实 DB 的 internal 表为空 → 空态 |
| 复测步骤解析、302 跟随按钮、HTML 渲染 | ✅ | 8 个 jsdom 用例覆盖「2 个 ```http → 2 个步骤按钮」「默认不跟随」「3xx+Location → 跟随按钮」「`<iframe sandbox="" srcdoc>`」；Host 侧 `/retest/send` 对本地临时服务器实测 302 不跟随 / 跟随 / 5 跳上限 / 2MiB 截断 / allowlist 403 |
| 只读/旧 schema 明确提示且不写库 | ✅ | v4 fixture：`/health` 200 `compatible=false`，5 个数据路由 + 写操作 409，DB 的 `user_version` 与行内容逐字段不变；`CORTEX_DB_READONLY=1` / `readOnly:true`：写 403 `READ_ONLY`，行内容零变化；客户端 409 → schema 不兼容 StatePanel |
| 中文/英文、深浅主题、窄窗口 | ⚠️ 代码级通过 / 视觉未截图 | zh+en 字典 14 个覆盖全部页签与页面、key 对齐有测试；CSS 仅引用 `--dsw-alias-*` token（automated 审计 + 手工 grep，无硬编码颜色）；窄屏用 `useIsNarrow` + container query；真实 GUI 视觉无浏览器控制能力，见 §9 |
| 不依赖 MCP、Cortex Web/桌面端 | ✅ | 全仓库 grep 无 MCP、无 `Cortex` 进程调用；Host 只 `node:sqlite` 打开 `~/.cortex/data.db` |
| `npm pack` 完整；一键安装可复现 | ✅ 本机 link 安装；npm registry 发布未执行 | `npm pack --dry-run`：31 files / 576,229 B unpacked / 146,510 B tarball；`plugin_manager install_bundle` → `application: applied`；卸载后 profile 无残留依赖/行，重装再次 applied |

## 2. 交付物 / 文件清单

```
dsh-cortex/
├─ package.json               # 名称 dsh-cortex；dsh.bundle.patch + dsh.client(platform web)
├─ cordis.patch.yml           # - insert: [{ id: dsh-cortex, name: dsh-cortex }]
├─ index.js                   # Host 入口：name/inject=['webServer']/apply(ctx,config)
├─ client.js                  # 构建产物（window.__ModuleLoader__.load，id=dsh-cortex，~228 KiB）
├─ icon.svg                   # 128×128 原创图标
├─ locale/en.json, zh.json    # Plugin Manager 显示 meta.title/description
├─ src/host/                  # 8 文件
│  ├─ app.js                  # createCortexHost({config}) -> {handler, dispose}
│  ├─ db.js                   # node:sqlite 懒打开 + schema v5 guard + busy/FK + BEGIN IMMEDIATE 重试
│  ├─ dto.js                  # 行 → camelCase DTO；JSON 安全 parse；凭据脱敏
│  ├─ repository.js           # 参数化查询：vulns/assets/internal/snapshots/stats/report/retest
│  ├─ http.js                 # loopback peer+Host fence、同源写栅栏、body/query 上限、错误 envelope
│  ├─ router.js               # 17 条路由
│  ├─ reports.js              # Markdown 报告 + attachment
│  └─ retest.js               # SSRF-safe 出站（allowlist / 无重定向默认 / 5 跳 / 15s / 2MiB）
├─ src/client/                # 15 文件（CommonJS 源码，构建时打包）
│  ├─ index.js                # 插件入口：locale 注册 + sidebar.panellist + main + styles + teardown
│  ├─ styles.js               # 全部 --dsw-alias-* token CSS（含 reduced-motion / 窄屏 / 深色）
│  ├─ locales.js              # shell 字典 zh/en
│  ├─ ui/kit.js               # 自研 UI 原语（Button/Badge/Card/DataTable/Split/Modal/Tabs/Pager…）
│  ├─ ui/markdown.js          # 安全 Markdown 渲染（无 dangerouslySetInnerHTML）
│  ├─ lib/api.js              # 同源 fetch 封装 + ApiError + abortAll
│  ├─ lib/format.js           # 时间/字节/截断等
│  ├─ lib/httpparse.js        # reproduction_steps → ```http 请求步骤解析
│  └─ pages/{overview,vulns,assets,internal,snapshots,retest}.js
├─ scripts/                   # build-client / smoke-client / smoke-host / smoke-host-edge / verify-live / watch-events
├─ fixtures/                  # schema5.sql（真实 DDL）+ seed.json（合成数据）+ build.mjs
├─ test/                      # 174 个测试（host 96 / client 47 / manifest 8 / integration 15 / fixture 6 + …）
├─ docs/                      # dsh-api-confirmed.md / contracts.md / ui-kit.md / 本报告
├─ recon/                     # 实际 DB 只读侦察脚本（schema dump / 样本）
└─ README.md                  # 安装/配置/安全/限制/开发命令
```

## 3. 已确认并使用的 DSH API（全部实测，非记忆）

| API | 实际形态 | 验证来源 |
|---|---|---|
| DSH 版本 | `0.2.2-rc.1`（desktop runtime 同版本），Cordis 4.1.0 | `app.asar/package.json`、`dsh/package.json` |
| Host Node / `node:sqlite` | Node `24.21.0`，`DatabaseSync` 可用；`/health` 运行时再确认 `sqlite:true` | 运行时 `/health` 返回 |
| Host 插件导出 | `export const name/inject/Config?` + `export function apply(ctx, config)`；`inject=['webServer']` | 安装后 Loader row `fiberPhase: active` |
| 可选注入生命周期 | `ctx.inject(['webServer'], (web) => { ctx.effect(() => web.webServer.register(...), label) })` | 实测路由 200；真实插件 `dsh-src-ledger/lib/web.js` 同款 |
| `webServer.register` | `{ kind:'prefix', path:'/cortex-api', handler(req: IncomingMessage, res: ServerResponse) }` → disposer | inspect `Service.webServer`；实测 `/cortex-api/health` 200、安装前 404、卸载后 404 |
| Client 模块格式 | `window.__ModuleLoader__.load({ id:'dsh-cortex', factory:(require)=>{...} })`，返回 `{ name, inject:['slots','locale'], apply(ctx) }`，`require('react')` 唯一外部依赖 | SSE 客户端图 entry + slot occupants 均为 active；真实插件 `dsh-src-ledger/lib/client.js` 同款 |
| `sidebar.panellist` | list slot，注册 `{ name, id:'cortex', order:5, label:()=>string }`；图标组件 props `{size, active}`；id 同时寻址 main 面板 | inspect Slots：occupants `plugins(0) / dsh-cortex cortex(5) / schedules(10)` |
| `main` | keyed slot，注册 `{ name:'main', key:'cortex' }` | inspect Slots：main occupants 含 `dsh-cortex / key=cortex / active=true` |
| Theme tokens | 仅 14 个 `--dsw-alias-*` / `--dsw-specific-*`；插件全部通过 `var(...)` 使用，无硬编码颜色 | inspect `Theme.listTokens` |
| Locale | `ctx.locale.register(ns, locale, dict)` / `getLocale()` / `subscribe()`；基线 `['zh','en']` | 14 个 namespace 注册（shell + 6 页面 ×2 语言）；jsdom 断言 zh/en key 对齐 |
| Client builtins | `ctx/React/host/styles/console`；本插件仅用 React + `window.__ModuleLoader__`，`styles.insert` 用 `typeof styles` 特性探测并保留组件内 `<style>` 回退 | shell 测试：styles.insert 调用 1 次 + disposer；DOM 回退存在 |
| Client 加载/热更新 | Host 按 Loader entry 扫描 `dsh.client`；`/plugins/events` SSE 推送 graph 与 `rebuilt`；`client-hmr` 495ms 轮询 bundle 产物 | 实测 SSE：`rebuilt frame: id=dsh-cortex rev=39e3d54f9a89`；重建后 graph rev 更新且 HTTP 200 |
| 安装/卸载 | `plugin_manager install_bundle target=<绝对目录>` → `application: applied`；`remove_bundle target=dsh-cortex` → `applied` | 两次安装 + 一次卸载实测（§8） |
| 版本约束 | 本插件未声明 `engines.dsh`（避免误拒）；`engines.node >=22.19` | package.json |

## 4. 架构与数据流

```
DSH Web (React, client.js)
  │  同源 fetch('/cortex-api/...')，无 CORS，不接触 FS/DB
  ▼
Host 插件 index.js ── ctx.inject(['webServer']) ── webServer.register({kind:'prefix', path:'/cortex-api'})
  ▼
router.js ── http.js（loopback peer+Host fence / 同源写栅栏 / 校验 / 错误映射）
  ▼
repository.js + dto.js ── db.js（node:sqlite DatabaseSync，PRAGMA user_version 必须 5）
  ▼
%USERPROFILE%\.cortex\data.db  （Cortex 桌面端/CLI 可同时打开，WAL + busy_timeout=5000）
```

- **只读为主**：所有列表/详情/统计/报告/复测发送均为读；写只有两种：
  1. `PATCH /vulns/:id/status` 只更新 `status` 列；
  2. `POST /vulns/:id/retest` **仅追加** `retest_results`（Cortex 严格 `{time_range, conclusion}`，保留历史）。
- **无 Cortex 进程依赖**：Cortex GUI/CLI/Web 关闭时仍工作（本机验证时 DSH 独立运行）。
- **不自动迁移**：`user_version !== 5` → `/health` 200 + `db.compatible=false`；数据接口 409；写操作 409/403；DB 零写入。

## 5. API（内部 `/cortex-api`，全部实测）

`GET /health`、`GET /stats?realm=`、`GET /vulns?realm&search&severity&status&page&pageSize`、
`GET /vulns/:id`、`PATCH /vulns/:id/status`、`POST /vulns/:id/retest`、`GET /assets?search&status&page&pageSize`、
`GET /assets/:hostPort`、`GET /internal/projects`、`GET /internal/overview?project=`、`GET /internal/graph?project=`、
`GET /snapshots?project&includeArchived&page&pageSize`、`GET /snapshots/:sessionId`、
`GET /reports/:vulnId`（`text/markdown` + attachment）、`POST /retest/send`。

错误统一 `{ error, code, details? }`：400 `BAD_REQUEST`、403 `FORBIDDEN_PEER/HOST/ORIGIN/CONTENT_TYPE`、`READ_ONLY`、
404 `NOT_FOUND`、405 `METHOD_NOT_ALLOWED`、409 `SCHEMA_INCOMPATIBLE`、502 `UPSTREAM_ERROR/UPSTREAM_TIMEOUT`。
`pageSize ≤ 100`、`search ≤ 400`、body ≤ 1 MiB；无 CORS 头；OPTIONS → 405。

## 6. 安全模型（已由测试覆盖）

- **网络**：只接受 loopback peer（`127.0.0.1/::1/::ffff:127.0.0.1`）+ loopback Host header；其他机器访问 → 403，页面显示「仅本机可用」。
- **写栅栏**：Origin 缺省或回环 + `Sec-Fetch-Site: same-origin|none` + `application/json`；跨站写 403。
- **凭据**：`credentials.secret` 永不序列化；只返回 `secretMasked`（如 `ab••••z`）与 `secretLength`；测试在 11 份原始响应中扫描 secret 均为 0 命中。
- **日志**：不含 SQL、请求体、凭据、DB 绝对路径；`/health` 只返回文件名 `data.db`。
- **复测出站**：只允许该漏洞 `target_url` / `host` / 关联资产 / `service_host` 的 origin；`http(s)`；拒绝 userinfo、169.254 元数据段；默认不跟随重定向，跟随时 ≤5 跳且逐跳重新校验；15s/跳超时；响应 2MiB 截断；请求体 ≤256 KiB；禁 `Host/Content-Length/Connection` 等头。
- **写事务**：`BEGIN IMMEDIATE` + `SQLITE_BUSY` 重试 3 次（50/100/200ms），与 Cortex 桌面端并发写不互相破坏。

## 7. 测试与验证结果（全部在 Node 24.21.0 实跑）

| 套件 | 命令 | 结果 |
|---|---|---|
| 全量 | `node --test` | **174 tests / 174 pass / 0 fail**（28 suites） |
| Host | `node --test "test/host/**/*.test.mjs"` | **96 / 96** |
| Client | `node --test "test/client/*.test.mjs"` | **47 / 47** |
| Manifest / pack | `node --test test/manifest.test.mjs` | **8 / 8**（含 `npm pack --dry-run --json` 文件清单断言） |
| Fixture | `node --test fixtures/build-schema.test.mjs` | **6 / 6** |
| Host 集成 | `node --test test/integration/host-api.test.mjs` | **15 / 15**（真实 127.0.0.1 HTTP + 真实 `createCortexHost` + 临时 fixture DB） |
| Host 冒烟 | `node scripts/smoke-host.mjs` | **37 / 37** |
| Host 边界 | `node scripts/smoke-host-edge.mjs --live` | v4/schema、只读、缺库、env 覆盖、真实 DB 只读 **23 / 23** |
| Client 冒烟 | `node scripts/smoke-client.mjs` | OK（14 locale、6 页、两个 slot） |
| **真实安装 e2e** | `node scripts/verify-live.mjs --write` | **44 / 44**（真实 DB 数据对账 + 状态写落盘/恢复 + 栅栏） |

`npm pack --dry-run`：**31 files / 576,229 B unpacked / 146,510 B tarball**，含 `index.js`、`client.js`、
`src/**`（client 15 + host 8）、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`；
不含 `test/ fixtures/ recon/ scripts/ docs/ node_modules/`。

## 8. 本机安装 / 卸载实测记录

1. `plugin_manager { action: "install_bundle", target: "C:\\Users\\slg13\\Desktop\\dsh-cortex" }`
   → `stage:"enable"`, `application:"applied"`, `warnings:[]`, pnpm exit 0，profile 增加
   `"dsh-cortex": "link:C:/Users/slg13/Desktop/dsh-cortex"` 且 bundles 末尾追加 `dsh-cortex`。
2. 安装后 `cordis_inspect_query`：`sidebar.panellist` occupants = `plugins(0) / **dsh-cortex:cortex(order 5, active)** / schedules(10)`；
   `main` occupants 含 `**dsh-cortex: key=cortex, active**`。
3. `GET http://127.0.0.1:63877/cortex-api/health` → `200`
   `{"ok":true,"plugin":"dsh-cortex","version":"0.1.0","dsh":{"version":"0.2.2-rc.1"},"sqlite":true,
   "db":{"available":true,"schemaVersion":5,"compatible":true,"readOnly":false,"dbFile":"data.db"},
   "server":{"loopbackOnly":true}}`。
4. `/plugins/events` SSE 客户端图：`dsh-cortex` entry，`url=plugins/??dsh-cortex/client.js&rev=a8a45f48f7ba`，
   HTTP 200，233,703 B（含最终页面与 sourceMappingURL 尾注），说明浏览器加载的是最终构建。
5. 重建 `client.js` 后 SSE 收到 `rebuilt frame: id=dsh-cortex rev=...` → 打开的 DSH 页面会**无需刷新热替换**客户端插件
   （Host 侧文件 `index.js/src/host/**` 变更需 DSH 重载/recomposition）。
6. `plugin_manager { action: "remove_bundle", target: "dsh-cortex" }` → `application:"applied"`；
   profile `package.json` 恢复原状（无 `dsh-cortex` 依赖/ bundles 项）、`cordis.patch.yml` 无残留、`/cortex-api/health` → 404。
7. 再次 `install_bundle` → `applied`，health 200、44/44 e2e 再次通过 —— 卸载/重装可重复，无残留状态。
   （注：卸载瞬间浏览器已加载的插件实例要到页面下次 rev 刷新才移除，这是 DSH Client 图的生命周期行为，非 profile 残留。）

## 9. 已知限制（如实声明）

1. **仅 loopback**：插件第一版只服务本机 DSH Web UI；其他机器访问返回 403（页面显示「仅本机可用」）。
2. **DSH 版本适配面**：只在本机 `DSH 0.2.2-rc.1` + Node 24.21.0 实测；未声明 `engines.dsh`。
   Client 依赖的 `slots/locale/webServer` API 为该版本实测形态，其他版本需复验。
3. **schema 只认 v5**：v4/v6 不迁移、不写库，只显示不兼容；需升级 Cortex 或改插件版本。
4. **快照 v1 只读**：不提供保存/恢复（避免与 Cortex 会话纪律/`force_new` 语义冲突）；后续可加确认式 P1。
5. **复测 P1 未做 raw 编辑器**：不提供发送前手改 headers/body 的编辑器（规格中的可选项）。
6. **快照列表客户端未分页**：Host 返回全量 sessions（默认 pageSize 20）；真实数据 1 条，暂不影响。
7. **视觉验证限制**：本环境无浏览器控制能力，未做真实 DSH GUI 的截图级验证。
   已验证的是：slot 注册与 active 状态、SSE 客户端图 + 打包产物内容、jsdom 全页面渲染与交互、
   HTTP 端到端、主题 token 唯一性与深浅色变量存在性。**未截图 ≠ 未实现**，但视觉/窄屏仍需人工过目。
8. **未发布 npm**：一键安装 `dsh plugin add dsh-cortex` 需要先把包发布到 registry（用户账号操作）；
   本机已用 link 方式完整验证安装/卸载/热更新。registry 上 `dsh-cortex` 名称是否可用未查询。
9. **写操作范围**：仅 `status` 与 `retest_results` 追加；不做删除/批量编辑/快照写。
10. **真实 DB 的 internal 表为空**：内网页当前显示空态（逻辑与合成 fixture 已覆盖全量表格与 masked 凭据）。

## 10. 发布步骤（用户侧）

```powershell
cd C:\Users\slg13\Desktop\dsh-cortex
npm test                          # 174/174
node scripts/build-client.mjs     # 构建 client.js（发布前必须最新）
npm pack --dry-run                # 检查 31 个文件
npm login                         # 用户账号
npm publish                       # 发布 @version 0.1.0
dsh plugin add dsh-cortex         # 一键安装（其它机器/其它 profile 同样可用）
```

## 11. 边界自检（对照任务禁止事项）

- ✅ 未 import 任何 Cortex 仓库模块/React/Tailwind 代码；全仓库只依赖 Node 内置模块与 `react`（浏览器模块表）。
- ✅ 未启动/调用 Cortex MCP server，未注册任何 MCP 工具；工具列表中无新增 MCP。
- ✅ 未调用 Cortex `ctx web` HTTP server；Host 只读 SQLite。
- ✅ 未修改 Cortex 仓库、未改 DSH 安装目录；安装/卸载只通过 `plugin_manager`（profile 由其维护）。
- ✅ 未把 `credentials.secret` 发给浏览器或写入日志。
- ✅ 未自动迁移 Cortex DB；写只限 status 与 retest 追加（且真实 DB 上做的是改回环）。
- ✅ 未修改 DSH 原文件/其他插件/DOM 根系；UI 只通过 slot 贡献，`<style>` 在插件根节点内。
