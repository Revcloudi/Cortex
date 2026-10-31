# Cortex Web 支持开发文档与提示词

本文档面向后续新会话，用于给 Cortex 增加 **Web 页面支持**。Web 端的定位是：

> 在**内网/本机**中通过浏览器访问同一份 Cortex SQLite 数据库；部署在公网服务器时，只开放内网访问端口，**绝不把该端口暴露到公网**。

当前状态：**Web 端已实现（Phase W1–W4 完成，见 §10“实现状态与差异”）**。桌面端（Electron + 自定义无边框窗口）和 `ctx` CLI 保持完整功能；本文件其余章节保留为原始设计、安全约束、接口映射与验收清单，实际落地结果、验收证据和与计划的差异以 §10 为准。

---

## 1. 目标与非目标

### 目标

- 新增 `ctx web` 命令：启动一个本地 HTTP 服务，提供 React Web UI 与 REST/SSE API。
- 复用现有 React 页面（漏洞看板、资产库、认知快照、MCP 接入）和 `core` 数据库层，不复制业务逻辑。
- 与桌面端读写**同一份 SQLite**（默认 `~/.cortex/data.db`，可用 `CTX_DB_PATH` 覆盖）。
- 仅支持单用户、单实例、本机或内网访问；默认监听 `127.0.0.1`。
- 浏览器能力差异用安全降级实现：报告导出走下载、数据库切换只读/受限、剪贴板用浏览器 API、窗口按钮在 Web 模式隐藏。

### 非目标（本轮不做）

- 不做远程多用户、账号体系、角色权限、团队共享。
- 不做公网部署的登录注册、OAuth、SSO。
- 不做实时协作、WebSocket 双向编辑。
- 不把数据库、日志、备份、测试、基准/基线数据提交到 Git。

---

## 2. 安全红线（必须遵守）

1. **默认只监听回环地址**：`127.0.0.1:8787`。服务启动时打印本机地址与一次性 token。
2. **默认拒绝公网绑定**：`--host 0.0.0.0` 必须同时传 `--allow-intranet`，且启动日志醒目标注“仅限内网”；没有该开关时直接拒绝。
3. **公网服务器部署要求**：
   - 只允许内网网段访问（Windows 防火墙 / iptables / 云安全组仅放行私网 CIDR，例如 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）；
   - 不配置端口映射 / 反向代理到公网，不把端口暴露到 Internet；
   - 推荐通过内网 IP 访问，或使用带 TLS + 额外认证的内网反向代理；
   - 不将 SQLite 文件、`CTX_DB_PATH`、token、日志放入任何公开目录。
4. **所有 API 都要鉴权**：启动时生成随机 token（32 字节），首屏用 query token 换取 `HttpOnly` + `SameSite=Strict` cookie；无 token 一律 401。
5. **不开放 CORS**：只接受同源请求；校验 `Origin`/`Referer`；拒绝跨站 preflight。
6. **安全响应头**：严格 CSP（`default-src 'self'`、`script-src 'self'`、`connect-src 'self'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`Cache-Control: no-store` 用于 API。
7. **输入校验**：复用 `src/shared/types.ts` 的 zod schema，每个 API 入参在服务端二次校验。
8. **限流与体积限制**：请求体上限（如 2 MB）、简单 IP 级速率限制、错误信息不回显内部路径/SQL。
9. **日志只写服务端本地**：不记录 token、Cookie、漏洞正文中的凭据；`CTX_WEB_LOG` 可选。
10. **测试/基线不入库**：不新增 `tests/`、`bench/`、`baseline/`、日志、截图或下载产物；验证只做本地手工/命令检查。

---

## 3. 架构设计

### 3.1 进程与目录

```text
ctx web [--port 8787] [--host 127.0.0.1] [--db <path>] [--allow-intranet]
  └─ Node HTTP server (src/server/*)
       ├─ /                静态 Web 构建（out/web）
       ├─ /api/*           REST（复用 core + shared schema）
       ├─ /api/events      SSE（data:changed）
       └─ same SQLite      DatabaseService（core）
```

- `src/server/index.ts`：HTTP 服务器、静态资源、鉴权、CSP、路由挂载、优雅退出。
- `src/server/auth.ts`：token 生成、cookie 校验、Origin 校验、限流。
- `src/server/routes.ts`：API 路由表与 zod 校验，函数签名与桌面 IPC handler 对齐。
- `src/server/static.ts`：SPA fallback（`/`、任意前端路由回 `index.html`），禁止越权读文件。
- `src/cli/commands/web.ts`：`ctx web` 命令，复用 `resolveDbPath()`、`ensureDbDirectory()`、`DatabaseService`。
- `vite.web.config.ts`：独立的 Vite 构建配置，输出 `out/web`，用相对 base，注入 Web 运行标记。
- 浏览器与桌面端共用渲染层：`src/renderer/src/lib/api.ts` 增加 transport 选择（`window.api` → Electron IPC；否则 fetch/SSE HTTP client）。

### 3.2 前端 API 适配层

保持现有 `CortexApi` 接口不变，新增：

```text
src/renderer/src/lib/transport/
  index.ts         根据环境导出 CortexApi 实现
  httpClient.ts    fetch + SSE，同源、credentials: 'include'
```

- `onDataChanged` 在 Web 端用 `EventSource('/api/events')` 实现。
- 导出报告：调用 `/api/export/vulns` 返回 Markdown 内容，浏览器触发 Blob 下载；不落服务器磁盘。
- 数据库选择：Web 模式隐藏“选择数据库”按钮，或仅允许服务端 `--db` 配置（不提供任意路径切换）。
- 剪贴板：优先 `navigator.clipboard`，降级 `document.execCommand('copy')`。
- 窗口控制（最小化/最大化/关闭）：Web 模式隐藏 `Titlebar` 右侧按钮，只保留品牌与拖拽区（浏览器无拖拽语义）。
- `Web` 模式通过构建变量 `import.meta.env.VITE_CORTEX_RUNTIME === 'web'` 或运行时 `window.api === undefined` 判断。

### 3.3 API 映射（与现有 IPC 对齐）

| 方法 | 路径 | 对应 IPC / 功能 |
| --- | --- | --- |
| GET | `/api/vulns` | `listVulnerabilities` |
| GET | `/api/vulns/:id` | `getVulnerability` |
| PATCH | `/api/vulns/:id/status` | `updateVulnerabilityStatus` |
| DELETE | `/api/vulns/:id` | `deleteVulnerability` |
| POST | `/api/vulns/delete` | `deleteVulnerabilities` |
| POST | `/api/vulns/export` | `exportVulnerabilities`（返回文件内容，不写服务器） |
| GET | `/api/assets` | `listAssets` |
| GET | `/api/assets/:hostPort` | `getAssetDetail`（hostPort 需 URL encoding） |
| GET | `/api/assets/:hostPort/related` | `getAssetRelatedVulnerabilities` |
| DELETE | `/api/assets/:hostPort` | `deleteAsset` |
| GET | `/api/snapshots` | `listSnapshots` |
| GET | `/api/snapshots/:id` | `getSnapshot` |
| POST | `/api/snapshots/:id/restore` | `restoreSnapshotPrevious` |
| POST | `/api/snapshots/:id/archive` | `archiveSnapshot` |
| DELETE | `/api/snapshots/:id` | `deleteSnapshot` |
| GET | `/api/stats` | `getStats` |
| GET | `/api/db` | `getDatabaseInfo` |
| GET | `/api/app` | `getAppInfo` |
| GET | `/api/setup` / POST `/api/setup` | `getSetupInfo` / `runSetup`（Web 端需确认允许本机配置写入） |
| POST | `/api/demo/seed` | `seedDemoData` |
| GET | `/api/events` | SSE `data:changed` |
| GET | `/api/config` | Web 端有效配置（只回显 db 文件名、版本、是否只读等，不泄露完整路径） |

> 返回结构必须与桌面端 `CortexApi` 完全一致，避免前端两套类型。

### 3.4 数据库并发

- Web 与桌面端/Agent 可能同时访问同一 SQLite：保持 WAL、busy_timeout、`BEGIN IMMEDIATE`、重试策略不变。
- Web 服务只创建**一个** `DatabaseService` 实例；所有请求共享。
- 文件监听使用现有 chokidar watcher，变更时通过 SSE 广播 `data:changed`。
- 服务启动前检查数据库文件存在（只读查看模式可创建空库）；无写权限时降级为只读并明确提示。

---

## 4. 分阶段实施清单

### Phase W0：准备（半天）

1. 阅读 `src/shared/ipc.ts`、`src/shared/types.ts`、`src/core/**`、`src/renderer/src/lib/api.ts`。
2. 新增 `docs/` 已存在（本文件）；不新增测试/基线。
3. 保留桌面端行为不变；所有 Web 代码用 `src/server/**`、`vite.web.config.ts`、`src/cli/commands/web.ts` 隔离。

### Phase W1：HTTP 服务与鉴权（1–2 天）

- 实现 `src/server/index.ts`、`auth.ts`、`static.ts`、`routes.ts` 骨架。
- `ctx web` 启动服务，默认 `127.0.0.1:8787`；打印 token URL。
- 实现 `/api/events`、`/api/app`、`/api/db`、`/api/stats`、`/api/vulns`。
- 安全头部、Origin 校验、token/cookie、请求体限制。

### Phase W2：前端 Web 模式（2–3 天）

- `vite.web.config.ts` 构建 `out/web`。
- `lib/api.ts` 增加 transport 选择与 HTTP client、SSE。
- 隐藏桌面专属 UI（窗口按钮、数据库切换、原生导出对话框）。
- Web 首屏 token 换取 cookie 的引导页（`?token=...` → 立即 replace 去掉 query）。

### Phase W3：剩余 API 与浏览器降级（2–3 天）

- assets / snapshots / export / setup / seed 全量对齐。
- 报告下载、剪贴板降级、只读模式提示、错误 toast。
- `ctx web --db <path>` 指定数据库；只允许服务端配置。

### Phase W4：文档与验收（1 天）

- 更新 `README.md` / `README.zh-CN.md`：如何启动 Web、只内网访问的安全说明。
- 更新本文件“已实现/差异”章节（如有）。
- 手工验收（见 §6）；不提交测试文件。

---

## 5. 构建与运行

```bash
# 构建 Web 静态资源 + server bundle
npm run build:web        # 新增脚本：vite build -c vite.web.config.ts
npm run build:server     # 新增脚本：esbuild src/server/index.ts → out/server/web.cjs
npm run build            # 桌面构建保持不变

# 本机访问（推荐）
ctx web                       # http://127.0.0.1:8787，自动打开 token URL

# 内网服务器访问（必须同时满足防火墙仅放行内网）
ctx web --host 192.168.1.20 --allow-intranet --port 8787
```

> 公网服务器上**不要**做端口映射/反代到公网；仅在内网网段访问。若使用反向代理，必须加 TLS + 额外认证，并继续只监听内网。

---

## 6. 验收清单（手工，不提交测试/基线文件）

> 实现完成后已按本清单完成本地手工验收，结果与证据见 §10.4；下列清单保留为原始验收要求。

- [ ] `ctx web` 默认只监听 `127.0.0.1`；无 token 的 API 返回 401。
- [ ] 浏览器打开 token URL 后进入看板；刷新后仍保持登录（cookie）。
- [ ] 漏洞列表筛选/分页/详情/状态流转/删除与桌面端一致。
- [ ] 资产列表/详情/删除、快照会话/恢复/归档/删除与桌面端一致。
- [ ] 报告导出在浏览器触发下载，服务器不落盘。
- [ ] Agent 写入数据库后，SSE 在 1 秒内刷新 UI。
- [ ] Web 页面无窗口按钮/无数据库任意路径切换；不出现 Electron 专属报错。
- [ ] 安全头、Origin 校验、请求体限制、token 日志不泄露。
- [ ] 公网服务器仅内网可访问；端口扫描/外网访问失败。
- [ ] 不新增 `tests/`、`bench/`、`baseline/`、日志、截图等文件。

---

## 7. 给新会话的提示词

### 7.1 完整实现提示词（复制到新会话开头）

```text
你是 Cortex 项目的开发 Agent。请先阅读仓库根目录的 README、docs/WEB_SUPPORT_DEVELOPMENT_GUIDE.md、src/shared/ipc.ts、src/shared/types.ts、src/core/**、src/renderer/src/lib/api.ts，然后按文档 Phase W1–W4 实现 Web 页面支持。

硬性要求：
1. Web 端定位：本机/内网单用户，复用同一份 SQLite；默认只监听 127.0.0.1:8787；公网服务器部署只允许内网端口访问，绝不暴露到公网；必须实现 token 鉴权、Origin 校验、CSP、请求体限制、SSE。
2. 不复制业务逻辑：服务端复用 core/DatabaseService 与 shared zod schema；前端复用现有 React 页面与 CortexApi 接口，只增加 transport 适配层。
3. 桌面端现有功能/UI/构建不能被破坏；Web 代码放在 src/server/**、vite.web.config.ts、src/cli/commands/web.ts 等隔离区域。
4. 不新增任何 tests/、bench/、baseline/、日志、截图、下载产物或测试数据文件；手工验收即可。
5. 不修改 release/、tag、GitHub Release；不提交 out/、node_modules/、runtime/、release/、日志。
6. 每完成一个 Phase，先运行 npm run typecheck、npm run build 验证；Web 端按文档手工验收。
7. 最终提交前必须向用户确认：先展示 git status / git diff --stat / 变更摘要，问“是否提交最终版本到 GitHub？”，只有用户明确同意才 git add / commit / push。
8. 提交信息用英文、简洁；只提交源码、文档、配置；不要提交测试/基线/日志/构建产物。
9. 如果安全或架构上有冲突，以本提示词与文档的安全红线为准，先停下来向用户说明。
```

### 7.2 分阶段继续提示词

```text
继续 Cortex Web 支持，当前完成到 Phase W__。请先 git status / 查看 docs/WEB_SUPPORT_DEVELOPMENT_GUIDE.md 的验收清单，只做本阶段的剩余项，不扩散范围。完成后给出变更摘要、手工验收结果与下一步，等待我确认后再提交。
```

### 7.3 GitHub 提交流程提示词

```text
请把当前已完成且验收通过的改动提交到 GitHub（远端 ssh git@github.com:Revcloudi/Cortex.git，分支 main）。要求：
1. 先 git status；只 stage 源码/文档/配置，不提交 out/、node_modules/、runtime/、release/、*.log、tests/、bench/、baseline/、截图、下载产物。
2. 展示 git diff --stat 与将要提交的文件清单给我确认。
3. 我确认后才 commit + push；commit message 用英文，说明做了什么。
4. 不创建 tag、不修改 Release、不推送构建产物。
```

---

## 8. GitHub 提交规范（新会话必读）

- 远端：`ssh git@github.com:Revcloudi/Cortex.git`，默认分支 `main`（SSH 已配置好）。
- 提交前：
  ```bash
  git status
  git diff --stat
  git ls-files | grep -Ei '(^|/)(tests?|bench|baseline|logs?)/|\.(log|baseline|bak)$' || true
  ```
- 只提交：`src/**`、`scripts/**`、`skills/**`、`build/**`、`assets/**`、`.github/**`、README、配置文件、`docs/**`（不含生成物）。
- 不提交：`out/`、`node_modules/`、`runtime/`、`release/`、`*.log`、`tests/`、`bench/`、`baseline/`、截图、下载文件、数据库副本。
- 不创建/移动 tag，不修改 GitHub Release，除非用户明确要求。
- **最终版本提交必须向用户确认**：先给 diff 摘要与文件列表，用户确认后再 `git commit` + `git push`。
- 推送后汇报 commit hash、远端分支与提交文件数；不要把日志/测试/基线文件带入提交。

---

## 9. 当前桌面端约束（避免 Web 改造破坏已有行为）

- 6 个 MCP 工具和字段语义不变；Web 端不新增 MCP 工具。
- 数据库路径默认 `~/.cortex/data.db`（Windows `%USERPROFILE%\.cortex\data.db`），`CTX_DB_PATH` 可覆盖。
- 桌面端无边框窗口、自定义标题栏、MCP 页“接入 Agent”按钮、`ctx init` 流程保持不变。
- 报告 Markdown 模板统一使用 `src/main/export/markdownReport.ts`（如需挪到 shared，保持导入兼容）。
- 任何 UI 改动都要在中英文之间保持文案一致；Web 模式要隐藏不可用的桌面操作。

---

## 10. 实现状态（W1–W4）与差异

> 本节是实际落地结果，用于覆盖上文计划中的“待实现”语境；安全红线与接口语义仍以 §2–§4 为准。以下内容均可在当前源码树中核对，没有新增测试/基准/日志/截图文件。

### 10.1 已实现（对应 Phase W1–W4）

| 计划项 | 落地实现 |
| --- | --- |
| HTTP 入口 | `src/server/index.ts`：鉴权、安全头、Host/Origin 校验、SSE、静态 SPA、REST 分发、错误映射、优雅退出（SIGINT/SIGTERM）、只读降级、token URL 生成 |
| 鉴权 | `src/server/auth.ts`：每次启动生成 32 字节随机 token（base64url）；`GET /?token=…` 一次性换取 `HttpOnly` + `SameSite=Strict` cookie（12 小时）；`Authorization: Bearer` 供脚本使用；SHA-256 + `timingSafeEqual` 常量时间比较；token 只接受来自一次性 bootstrap URL |
| 安全与限流 | `src/server/security.ts`：严格 CSP、`nosniff`、`no-referrer`、`DENY`（含 `Permissions-Policy`、COOP/CORP）；Host 允许列表（DNS rebinding 防护，`CTX_WEB_ALLOWED_HOSTS` 显式扩展）；Origin/Referer/Sec-Fetch-Site 写请求校验；2 MB JSON 体积上限；固定窗口按 IP 限流（默认 300 请求 / 10 秒）；JSON/HTML 错误响应统一脱敏 |
| 静态资源 | `src/server/static.ts`：解码 + 规范化后确认路径不逃逸 `webRoot`；MIME 表；`assets/` 哈希文件长缓存；SPA fallback 只对无扩展名路径生效，缺失哈希资源返回 404；目录列表永不输出；构建缺失时返回说明页（503） |
| REST API | `src/server/routes.ts`：22 个路由（见 §10.2），复用 `src/main/ipc/schemas.ts` 的 zod 校验、`DatabaseService` 与 `notifyDataChanged` 语义，返回结构与桌面 `CortexApi` 一致 |
| SSE | `GET /api/events`：`data: changed` 帧 + 25 秒心跳，最多 20 个并发客户端；复用桌面端 chokidar watcher（`src/main/watcher.ts`） |
| `ctx web` CLI | `src/cli/commands/web.ts`：`--port` / `--host` / `--db` / `--allow-intranet` / `--no-open` 与全局 `--json`；默认 `127.0.0.1:8787`；非回环必须 `--allow-intranet`；回环地址启动时打开 token URL；打印 token 链接与安全提示；Ctrl+C 停止后链接失效 |
| 前端 transport | `src/renderer/src/lib/transport/index.ts` + `httpClient.ts`：同源 `fetch` + `EventSource` 的 `CortexApi` 实现；`VITE_CORTEX_RUNTIME === 'web'` 由 `vite.web.config.ts` 注入；桌面端继续走 `window.api`，两种 transport 共用同一 `CortexApi` 契约 |
| Web 模式 UI 降级 | `Titlebar` 隐藏窗口按钮；`Sidebar` 数据库行改为只读展示；报告导出改为浏览器下载；剪贴板用 `navigator.clipboard`（含 `execCommand` 降级）；MCP「接入 Agent」在 Web 模式二次确认（配置写入运行 `ctx web` 的主机）；`src/shared/web.ts` 集中 Web 契约与 `WEB_API_PATHS` |
| 构建脚本 | `vite.web.config.ts`（`out/web`，`base: './'`，复用根目录 Tailwind/PostCSS 配置，注入运行时标记）；`scripts/build-web-server.mjs`（esbuild → `out/server/web.cjs`，cjs/node22，external `better-sqlite3` / `fsevents`）；`package.json` 新增 `build:web`、`build:server` |
| 安装版集成 | `scripts/build-runtime.mjs`：`out/web → runtime/web`、`out/server/web.cjs → runtime/web-server.cjs`；Web 产物缺失时仅警告（CLI/MCP runtime 仍可用），半成品（有 `out/web` 无 server bundle）明确失败；`scripts/dist.mjs` 在 `npm run build` 之后、build-runtime 之前执行 `build:web` + `build:server` |
| 只读降级 | `DatabaseService` 新增 `readonly` 选项：SQLite 文件无写权限时以只读打开（不执行迁移、不改 `journal_mode`），`/api/config` 返回 `readOnly: true`，写请求由 `SQLITE_READONLY` 映射为 403 并给出明确提示 |
| 配置复用 | `src/cli/setupInfo.ts` 抽出 electron-free 的 setup 实现，`src/server/setup.ts` 复用 `ctx init` 逻辑，`src/main/ipc/setup.ts` 变为薄包装；`src/shared/markdownReport.ts` 承接报告模板 |
| 打包资源 | 安装版 `<install>/bin/web-server.cjs` + `<install>/bin/web/` 与源码布局（`out/server/web.cjs` + `out/web`）由 CLI 自动识别 |

### 10.2 API 路由状态

全部 22 个 REST 端点均已实现（方法、路径、返回结构与桌面 IPC 对齐；入参在服务端用同一套 zod schema 二次校验）：

| 方法 | 路径 | 对应桌面 IPC | 状态 |
| --- | --- | --- | --- |
| GET | `/api/vulns` | `listVulnerabilities` | 已实现 |
| GET | `/api/vulns/:id` | `getVulnerability` | 已实现 |
| PATCH | `/api/vulns/:id/status` | `updateVulnerabilityStatus` | 已实现 |
| DELETE | `/api/vulns/:id` | `deleteVulnerability` | 已实现 |
| POST | `/api/vulns/delete` | `deleteVulnerabilities` | 已实现 |
| POST | `/api/vulns/export` | `exportVulnerabilities` | 已实现，返回 `{ files: [{ filename, content }] }` Markdown，由浏览器下载，服务端不落盘 |
| GET | `/api/assets` | `listAssets` | 已实现 |
| GET | `/api/assets/:hostPort` | `getAssetDetail`（hostPort 需 URL encoding） | 已实现 |
| GET | `/api/assets/:hostPort/related` | `getAssetRelatedVulnerabilities` | 已实现 |
| DELETE | `/api/assets/:hostPort` | `deleteAsset` | 已实现 |
| GET | `/api/snapshots` | `listSnapshots` | 已实现 |
| GET | `/api/snapshots/:id` | `getSnapshot` | 已实现 |
| POST | `/api/snapshots/:id/restore` | `restoreSnapshotPrevious` | 已实现 |
| POST | `/api/snapshots/:id/archive` | `archiveSnapshot` | 已实现 |
| DELETE | `/api/snapshots/:id` | `deleteSnapshot` | 已实现 |
| GET | `/api/stats` | `getStats` | 已实现 |
| GET | `/api/db` | `getDatabaseInfo` | 已实现（`dbPath` 仅返回文件名） |
| GET | `/api/app` | `getAppInfo` | 已实现（清理绝对路径与 Electron 专用字段） |
| GET | `/api/config` | Web 专用 | 已实现（文件名、schema 版本、只读、监听信息，无绝对路径/token） |
| GET | `/api/setup` | `getSetupInfo` | 已实现 |
| POST | `/api/setup` | `runSetup` | 已实现（写入运行 `ctx web` 的主机，UI 先二次确认） |
| POST | `/api/demo/seed` | `seedDemoData` | 已实现 |
| GET | `/api/events` | 桌面 `data:changed` 推送 | 已实现（SSE，`data: changed` + 心跳，上限 20 连接） |

### 10.3 安全控制落地清单

- 默认仅监听 `127.0.0.1:8787`；非回环地址必须 `--allow-intranet`，CLI 与服务端两层都会拒绝未授权的绑定。
- 所有 API 都要求 token：会话 cookie（`HttpOnly` + `SameSite=Strict`，12 小时）或 `Authorization: Bearer`；HTML 与静态资源同样需要鉴权，无 token 的 HTML 请求返回说明页、API 返回 401。
- 一次性 bootstrap：`GET /?token=…` 校验后 303 重定向并种 cookie，token 不再出现在地址栏/历史/Referer；服务重启后旧链接失效。
- 无 CORS、拒绝 `OPTIONS` preflight、只接受同源请求；`Host` 头必须命中允许列表（回环 + 绑定地址 + 本机网卡地址，`--allow-intranet` 时加入本机各接口地址；可用 `CTX_WEB_ALLOWED_HOSTS` 显式补充），否则 421。
- 写请求（POST/PUT/PATCH/DELETE）额外校验 `Origin` / `Referer` / `Sec-Fetch-Site`；缺 Origin/Referer 时必须用 Bearer token。
- 安全响应头：严格 CSP（`default-src 'self'`、`script-src 'self'`、`connect-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'self'`、`frame-ancestors 'none'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`Permissions-Policy`、COOP/CORP；API 响应 `Cache-Control: no-store`。
- 请求体上限 2 MB（声明长度或流式累计均校验，超限 413）；按客户端 IP 固定窗口限流（默认 300 请求 / 10 秒，超限 429）。
- 错误信息脱敏：zod 校验错误只保留字段级说明，`DatabaseError` 按 NOT_FOUND/INVALID_INPUT/STALE 映射为 404/400/409，其余内部错误一律 500 通用文案；日志不记录 token、cookie、请求体。
- 静态资源路径穿越防护（解码 + 规范化后必须仍在 `webRoot` 内、拒绝空字节、不生成目录列表）。
- `/api/app`、`/api/db`、`/api/config` 只暴露数据库文件名等非敏感信息，不泄露绝对路径、token 或日志位置。
- 只读降级：SQLite 无写权限时只读打开，写接口 403；服务端不假装写入成功。

### 10.4 手工验收结果（本地，命令级 + 浏览器）

- `npm run typecheck`（node + web）、`npm run build`、`npm run build:web`、`npm run build:server` 全部通过；`out/web/index.html` 与哈希资源、`out/server/web.cjs` 正常产出（相对 `./assets/...` 路径，Tailwind 样式生效）。
- `ctx web` 能加载 `out/server/web.cjs` 与 `out/web` 并启动；启动打印 token 登录链接；浏览器打开后经 303 重定向写入会话 cookie 并进入看板，刷新保持登录；无 token 访问 HTML/API 返回 401。
- 安全校验实测：异常 `Host` → 421；跨源/缺 Origin 的写请求 → 403；超 2 MB body → 413；超频请求 → 429；安全响应头与 `Cache-Control: no-store` 均在响应中。
- 22 个 REST 端点按桌面 `CortexApi` 契约逐项验证；漏洞筛选/分页/详情/状态流转/删除、资产列表/详情/删除、快照列表/恢复/归档/删除、统计、db/app/config、setup、demo seed 行为与桌面端一致。
- 报告导出返回 Markdown 内容并触发浏览器下载，服务器不写文件；Agent/CLI/桌面端写入数据库后，SSE 在约 1 秒内刷新 UI。
- 浏览器手工验证页面渲染：窗口按钮隐藏、无数据库切换器、数据库行只读展示、MCP 页有 Web 模式提示与二次确认（验证截图未提交入库）。
- 只读数据库降级与写接口 403 提示验证通过。
- 未新增 `tests/`、`bench/`、`baseline/`、日志、截图或下载产物；验收为本地手工/命令检查。

### 10.5 与计划的差异 / 已知限制

1. **CSP meta 保留**：`src/renderer/index.html` 仍带 Electron 用的 CSP `<meta>`（未改动），Web 构建也保留它；Web 端以服务端响应头的严格 CSP 为权威，两者同时生效时取交集（同源 fetch/SSE 不受影响）。
2. **无 Web 热更新**：改前端后需重新 `npm run build:web`；`npm run dev` 仍是 Electron 模式，Web 端未接入 Vite dev server/HMR。
3. **单用户定位**：无账号/角色/权限体系，不做多用户或公网登录；token 每次启动随机生成且不持久化，服务重启后旧链接失效。
4. **反向代理**：默认 Host 允许列表只含回环、绑定地址与本机接口地址；内网 TLS 反代若保留自定义 Host，需用 `CTX_WEB_ALLOWED_HOSTS` 显式加入，并自行提供 TLS 与额外认证，上游保持 HTTP。
5. **安装版依赖重新打包**：`ctx web` 需要安装包内 `bin/web-server.cjs` 与 `bin/web/`；`npm run dist:win` / `npm run build:runtime` 已包含该逻辑，但**已发布的旧安装包不含 Web 组件**，需重新打包发布。runtime 构建缺少 Web 产物时仍成功（警告），半成品（有 SPA 无 server bundle）会失败。
6. **CLI 不接受 `--port 0`**：`--port` 仅允许 1–65535（服务端内部支持系统分配端口，但 CLI 未暴露）。
7. **导出不落盘**：`POST /api/vulns/export` 返回 Markdown JSON，由浏览器逐份下载（与 §3.2 的目标一致），不再提供服务器端目录参数。
8. **静态资源规则**：SPA fallback 只对无扩展名路径生效；缺失的哈希资源返回 404 而不是回退 `index.html`。
9. **只读模式前提**：只有已存在但不可写的数据库文件才走只读降级；不存在的路径会创建新库（有写权限时）。
10. **未引入新依赖**：Vite、React、Tailwind、esbuild 等均为既有依赖；未新增 `tests/`、`bench/`、`baseline/`、日志/截图/下载产物。

### 10.6 相关文件

新增：`src/server/{index,auth,security,static,routes,setup,types,errors}.ts`、`src/cli/commands/web.ts`、`src/cli/setupInfo.ts`、`src/shared/web.ts`、`src/renderer/src/lib/transport/{index,httpClient}.ts`、`vite.web.config.ts`、`scripts/build-web-server.mjs`。

修改：`src/cli/index.ts`（注册 `ctx web`）、`src/core/db/DatabaseService.ts`（只读选项）、`src/shared/markdownReport.ts` + `src/main/export/markdownReport.ts`（报告模板下沉）、`src/main/ipc/setup.ts`（复用 electron-free setup）、渲染层若干文件（transport 选择与 Web 模式降级）、`package.json`（`build:web` / `build:server`）、`scripts/build-runtime.mjs`（安装版复制）、`scripts/dist.mjs`（发布顺序）、`tsconfig.node.json`（纳入 `vite.web.config.ts` 与 `src/server/**`）、README 与本文档。
