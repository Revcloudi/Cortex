# Cortex Web 支持开发文档与提示词

本文档面向后续新会话，用于给 Cortex 增加 **Web 页面支持**。Web 端的定位是：

> 在**内网/本机**中通过浏览器访问同一份 Cortex SQLite 数据库；部署在公网服务器时，只开放内网访问端口，**绝不把该端口暴露到公网**。

当前状态：Web 端尚未实现。桌面端（Electron + 自定义无边框窗口）和 `ctx` CLI 已是完整功能；本文件是实现计划、安全约束、接口映射、验收清单和提示词的唯一依据。

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
