![Cortex — 本地优先的 MCP 原生渗透测试数据中枢](assets/readme-hero.png)

# Cortex

Cortex：本地优先的渗透测试情报中枢。同一份 SQLite 记忆库同时服务于面向 Agent 的纯 stdio MCP server、面向终端的 ctx CLI 与面向人类的桌面看板。此外，本机或受信任内网还可通过浏览器 Web 端使用同一套看板。

[![README English](https://img.shields.io/badge/README-English-0f766e?style=flat-square)](README.md)
[![README 中文](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-f59e0b?style=flat-square)](README.zh-CN.md)
[![版本 0.1.1](https://img.shields.io/badge/version-0.1.1-2dd4bf?style=flat-square)](https://github.com/Revcloudi/Cortex/releases)
[![MCP 6 tools](https://img.shields.io/badge/MCP-6%20tools-0ea5e9?style=flat-square)](#mcp-接入)
[![平台](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20CLI%20%C2%B7%20Linux%20CLI-64748b?style=flat-square)](#cli-ctx)
[![Node >= 22.12](https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933?style=flat-square)](#环境要求)
[![License MIT](https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square)](LICENSE)

> **仅限授权测试。** Cortex 仅用于你拥有或已获得明确书面授权的系统；使用者需自行遵守相关法律、合同与测试范围约束。

**简体中文** · [English](README.md) · [Web 端（仅内网）](#web-端仅内网) · [Windows 桌面端](#windows-桌面端) · [CLI (ctx)](#cli-ctx) · [MCP 工具](#mcp-接入)

## Web 端（仅内网）

`ctx web` 用本机 HTTP 服务把同一套 React 界面提供到浏览器，读写与桌面端、CLI、MCP 完全相同的 SQLite 文件。定位是**本机或受信任内网的单用户**：没有账号体系、不支持多用户，也绝不做公网部署——不要把该端口暴露到互联网。

从源码构建并启动：

```bash
# 需要 Node.js >= 22.12
git clone git@github.com:Revcloudi/Cortex.git
cd Cortex
npm install
npm run build            # typecheck + Electron + MCP + CLI
npm run build:web        # Web 端 SPA（ctx web 必需）
npm run build:server     # Web 端 HTTP 服务端 bundle（ctx web 必需）
npm link                 # 可选：让 ctx 进入 PATH
ctx web
```

### 命令行参数

常用启动参数：

```bash
ctx web                                      # 默认 127.0.0.1:8787
ctx web --port 9000 --db /data/cortex.db     # 指定端口与数据库
ctx web --host 192.168.1.20 --allow-intranet # 仅限受信任内网（必须显式确认）
ctx web --no-open --json                     # 不打开浏览器；输出含 tokenUrls、dbPath、readOnly 等的 JSON
```

| 参数 | 说明 |
| --- | --- |
| `--port <port>` | 监听端口，默认 `8787` |
| `--host <host>` | 监听地址，默认 `127.0.0.1`；任何非回环地址还必须同时传 `--allow-intranet` |
| `--db <path>` | SQLite 文件，默认 `~/.cortex/data.db`（Windows：`%USERPROFILE%\.cortex\data.db`）或 `CTX_DB_PATH` |
| `--allow-intranet` | 显式允许非回环地址（仅限受信任内网） |
| `--no-open` | 不自动打开浏览器 |
| `--json` | 全局参数；输出机器可读 JSON（`tokenUrls`、`dbPath`、`readOnly`、`loopbackOnly`、`intranetAllowed`） |

### 登录方式

启动时会打印一到多个包含一次性 token 的登录链接（`http://…/?token=…`）。打开后服务端写入 `HttpOnly` + `SameSite=Strict` 会话 cookie（12 小时）并重定向，token 从地址栏消失；刷新页面仍保持登录，重启服务后旧链接立即失效。token 只存在于该链接中——不写日志、不落盘，也不接受其他查询参数传入。脚本可改用 `Authorization: Bearer <token>`。

### 安全红线

- 默认只监听回环地址（`127.0.0.1`）；绑定非回环地址必须显式传 `--allow-intranet`，且仅限**受信任内网**。
- 部署在服务器上时，防火墙 / 安全组只放行私网网段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`），绝不做端口映射、公网反向代理或隧道。
- 不把 SQLite 文件、token、日志放到任何公开目录。
- 把打印出来的登录链接当作密码：不要截图、分享或粘贴到聊天工具。token 不写日志；重启服务后旧链接失效并打印新链接。
- 所有 API 都要求会话 cookie 或 Bearer token；HTML 与静态资源同样需要鉴权。服务不开放 CORS，只接受同源请求；校验 `Host` 头防 DNS rebinding；写请求另外校验 `Origin` / `Referer` / `Sec-Fetch-Site`。
- 严格 CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`，API 响应带 `Cache-Control: no-store`；JSON 请求体上限 2 MB；按 IP 限流（约 300 请求 / 10 秒）；错误信息脱敏，请求日志不记录 token、cookie 或请求体。`/api/app`、`/api/db`、`/api/config` 只暴露数据库文件名，不暴露绝对路径。

### Web 端与桌面端的差异

- 浏览器里没有无边框窗口：最小化/最大化/关闭按钮隐藏。
- 数据库由服务端 `ctx web --db` 固定；侧边栏数据库行是只读展示，无法打开切换器。
- 报告导出由服务端返回 Markdown 内容、浏览器下载保存，服务端不落盘。
- 剪贴板使用 `navigator.clipboard`（含旧浏览器降级）；没有原生保存对话框。
- 「接入 Agent」与首次配置写入的是运行 `ctx web` 那台机器的 Agent 配置，而不是浏览器所在设备；Web 模式会先二次确认。
- Agent、CLI 或桌面端写入数据库后，前端通过 `GET /api/events`（SSE）自动刷新。
- SQLite 文件无写权限时服务以**只读模式**启动（`/api/config` 返回 `readOnly: true`），写接口返回 403 并给出明确提示。

### 可选：内网反向代理

如果内网 TLS 反向代理会保留自定义 `Host`，把该主机名加入显式允许列表；上游仍用 HTTP，并在代理层提供 TLS 与额外认证：

```bash
CTX_WEB_ALLOWED_HOSTS=cortex.corp.example ctx web
```

### 安装版

`npm run build:runtime` 会把 `out/web` 复制到 `<install>/bin/web/`、`out/server/web.cjs` 复制到 `<install>/bin/web-server.cjs`；`npm run dist:win` 会在打包前执行 `build:web` + `build:server`，因此重新构建的 Windows 安装包包含 Web 组件。缺少 Web 产物的 runtime 构建仍可用于 CLI/MCP（会打印警告）；半成品状态（有 SPA 但没有 server bundle）会明确失败。

> 设计取舍与完整安全清单见 [docs/WEB_SUPPORT_DEVELOPMENT_GUIDE.md](docs/WEB_SUPPORT_DEVELOPMENT_GUIDE.md)。

## Windows 桌面端

Windows 安装包由 GitHub Actions 发布到 Releases。当前版本：**cortex-v0.1.1**。macOS / Linux 请使用下面的 CLI 方式。

| 平台 | 下载 |
| --- | --- |
| Windows 10/11 x64 | [Cortex-0.1.1-setup.exe](https://github.com/Revcloudi/Cortex/releases/latest/download/Cortex-0.1.1-setup.exe) |

> 链接始终指向最新的 Cortex Release；完整列表见 [Releases 页面](https://github.com/Revcloudi/Cortex/releases)。安装包未做代码签名：Windows SmartScreen 可能提示（"更多信息 → 仍要运行"）。

### 安装后接入 Agent

安装器只负责安装 Cortex 和快捷方式。启动 Cortex，打开 **MCP 接入** 页面，然后任选其一：

- 点击 **接入 Agent**：自动检测本机 Agent，写入 MCP 配置与对应语言的 Skill（Skill 语言跟随界面语言），之后重启 Agent；或
- 在终端执行 `ctx init --yes`（显式指定可用 `ctx init --yes --agents dsh --skill-lang en`）。

卸载只删除程序，保留 `%USERPROFILE%\.cortex\data.db`。桌面端界面支持**中英文随时切换**；Skill 语言之后也可用 `ctx init --skill-lang` 修改。

## CLI (ctx)

Node 运行、不依赖 Electron，读取同一份 SQLite。所有命令支持 `--json`；退出码 0 成功、1 参数/IO 错误、2 数据不存在。先编译并验证命令可用：

```bash
# 需要 Node.js >= 22.12
git clone git@github.com:Revcloudi/Cortex.git
cd Cortex
npm install
npm run build            # typecheck + Electron + MCP + CLI
npm run build:web        # Web 端 SPA（使用 ctx web 时必需）
npm run build:server     # Web 端 HTTP 服务（使用 ctx web 时必需）
npm link                 # 让 `ctx` 进入 PATH；不 link 时用 node out/cli/ctx.cjs
ctx --version            # 验证命令可用
ctx doctor               # 检查数据库、MCP 运行时与 Agent 配置
```

`npm run build` 只构建桌面端、CLI 与 MCP；浏览器 Web 端是独立构建，使用 `ctx web` 前需要再执行 `npm run build:web` 和 `npm run build:server`（见 [Web 端（仅内网）](#web-端仅内网)）。

其他常用命令：

```bash
npm run dev          # Electron + Vite 开发模式
npm run typecheck    # Node + Web 两个 TS 项目
npm start            # 预览已构建的桌面端
npm run dist:win     # Windows 安装包（含内置 Node 运行时，产物在 release/ 下）
```

首次启动会在 `%USERPROFILE%\.cortex\data.db`（macOS/Linux：`~/.cortex/data.db`）创建数据库，可用 `CTX_DB_PATH` 覆盖。

| 命令 | 说明 |
| --- | --- |
| `ctx init [--dry-run] [--yes] [--agents dsh,codex,claude,cursor] [--skill-lang zh\|en]` | 检测 Agent、展示计划 diff、备份后写入 MCP 配置 + Skill + 系统规则 |
| `ctx doctor` | 检查数据库、schema、MCP/CLI 运行时、Agent 配置、GUI 安装与版本 |
| `ctx mcp print-config [agent]` | 打印 DSH / Codex / Claude Code / Cursor 的 stdio 配置片段 |
| `ctx vulns list [--severity] [--host] [--limit]` | 漏洞列表 |
| `ctx vulns get <id>` | 查看完整漏洞：描述/影响/接口/Markdown 复现步骤（含请求与响应）/修复建议/复测记录/状态 |
| `ctx vulns export <id[,id...]> [--out <dir>] [--all] [--severity …] [--host …] [--limit …]` | 导出与桌面端相同模板的 Markdown 报告；默认目录 `./cortex-reports` |
| `ctx assets list [--search] [--status]` | 资产列表 |
| `ctx assets get <host_port>` | 查看资产详情：完整接口（含原始请求）、敏感泄露与测试参数 |
| `ctx snapshots list [--keyword]` | 认知快照列表 |
| `ctx snapshots get <session_id>` | 查看单条会话 |
| `ctx search <keyword>` | 同时搜索漏洞 / 资产 / 快照 |
| `ctx open [--dev] [--path <exe>]` | 启动/聚焦桌面端（Windows 安装版或源码构建） |
| `ctx web [--port <port>] [--host <host>] [--db <path>] [--allow-intranet] [--no-open]` | 在浏览器中使用同一套看板（仅回环或受信任内网） |

## 日常使用

安装完成后，Cortex 就是每个测试任务的“记忆层”：

1. **漏洞挖掘过程通过 MCP 入库**：Agent 按已安装的 Skill/规则，把确认的漏洞、侦察到的资产上下文和当前任务快照写入本地 SQLite，不需要手工整理报告。
2. **Agent 随时可以读库**：开始新任务前先查已有资产上下文和漏洞记录，复用侦察成果、避免重复上报。
3. **人类在桌面端、终端或可选的浏览器 Web 端查看**：桌面端提供漏洞看板、资产库、认知快照和 Markdown 报告导出；`ctx` 提供漏洞/资产/会话查询、全文搜索、诊断和 Markdown 报告导出；`ctx web` 把同一套页面提供给本机或受信任内网的浏览器。
4. **新对话直接接着跑历史任务**：直接说“继续 Example Program 的 IDOR 验证任务”。Agent 会先 `manage_snapshot list`，按项目名、阶段或 `session_id` 找到匹配会话并 `load`，从未完成事项和下一步继续；如果匹配到多个会话，会先让你选择继续哪个或新建。

```text
你：继续「Example Program」的 IDOR 验证任务，把未完成的检查跑完
Agent：manage_snapshot(list) → manage_snapshot(load, SESS-...) →
       query_asset_context / query_vulnerabilities → 继续测试
```

## 功能

- 漏洞模型：Host、入口、类型、等级、URL、描述、影响、受影响接口、Markdown 复现步骤、修复建议、加解密说明、测试边界、只追加的复测历史、关联漏洞与状态流转。
- 资产上下文：完整 URL、项目、技术栈、结构化 `interfaces`（`path` / `method` / `params` / 原始请求）、敏感泄露、非密 `test_parameters` 与关联漏洞；旧版 `interface_dir` 自动规范化。
- 固定 6 个 MCP 工具：`save_vulnerability`、`query_vulnerabilities`、`update_vulnerability`、`sync_asset_info`、`query_asset_context`、`manage_snapshot`。
- `ctx init` 自动检测 Agent，幂等写入 MCP 配置、3 个 Skill 与系统级强制规则（带备份、`--dry-run`、JSON/TOML/YAML 校验）。
- 桌面端：漏洞看板（服务端过滤/分页）、资产库（接口浏览器）、认知快照（项目 → 子会话层级）、Markdown 报告导出、双语 MCP 接入页（一键「接入 Agent」+ 精简工具表）。
- 可选 Web 端（`ctx web`）：在本机或受信任内网的浏览器里使用同一套看板、资产库、快照与 MCP 页面；一次性 token 登录，无账号体系，默认只监听回环地址，共享数据库变更时通过 SSE 自动刷新。
- 侧边栏数据库按钮可切换到任意 Cortex SQLite 文件查看（仅桌面端；Agent 仍使用默认数据库）。
- 主进程用 chokidar 监听 SQLite 文件（`data.db`、`-wal`、`-shm`）并推送 `data:changed`，Agent 写入通常 1 秒内可见，且不丢失筛选与打开的详情。
- Skill 双语：`skills/zh/**` 与 `skills/en/**`，安装时选择。

## 环境要求

- CLI 与源码构建需要 Node.js **≥ 22.12**；Windows 桌面安装包内置 Node 运行时，最终用户无需安装 Node。
- 桌面端仅提供 Windows 10/11 x64；macOS/Linux 使用上面的仅 CLI 方式。

## MCP 接入

MCP Server 只使用 **stdio**：由 Agent 在自己的进程里拉起，不监听端口，桌面端也不启动 MCP。Server 名称 `cortex`，版本 `0.1.1`。

| 场景 | 启动命令 |
| --- | --- |
| 源码构建 | `node <repo>/out/mcp/stdio.cjs` |
| Windows 安装版 | `<install>\bin\node.exe <install>\bin\mcp-stdio.cjs` |

DeepSeek Harness（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: mcp-cortex
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: cortex
        transport: stdio
        command: "node"
        args:
          - "<repo>/out/mcp/stdio.cjs"
        toolCallTimeoutMs: 120000
```

Codex CLI（`~/.codex/config.toml`）：

```toml
[mcp_servers.cortex]
command = "node"
args = ["<repo>/out/mcp/stdio.cjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Claude Code：

```bash
claude mcp add --transport stdio cortex -- node <repo>/out/mcp/stdio.cjs
```

Cursor（`~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["<repo>/out/mcp/stdio.cjs"]
    }
  }
}
```

### 一键配置

```bash
npm run build
node out/cli/ctx.cjs init --dry-run                    # 只预览
node out/cli/ctx.cjs init --yes                        # 检测 Agent、备份后写入
node out/cli/ctx.cjs init --yes --agents dsh --skill-lang en
node out/cli/ctx.cjs doctor                            # 诊断配置与运行时
```

`ctx init` 会把已有文件备份为 `.bak-YYYYMMDD-HHmmss`，用 marker 幂等合并（旧的 `PENTEST` 标记会自动迁移），写入前校验 JSON / TOML / YAML，并安装所选语言的 Skill。重启对应 Agent（不是重启 GUI）后，用只读工具调用（如 `manage_snapshot({ "action": "list" })`）验证链路。

## Skill（双语）

```
skills/
  zh/  vuln-db.skill.md  asset-context.skill.md  snapshot.skill.md
  en/  vuln-db.skill.md  asset-context.skill.md  snapshot.skill.md
```

`ctx init` 把所选语言复制到 Agent 技能目录（`~/.agents/skills/<name>/SKILL.md`，以及 Codex / Claude Code 各自技能目录）。桌面端 MCP 页与安装器使用同一个生成器，配置不会漂移。

## 打包与发布

```bash
npm run dist:win           # 构建 + 内置运行时 → Windows x64 NSIS（release/Cortex-0.1.1-setup.exe）
npm run build:runtime      # 只生成 runtime/（手动/高级打包用）
```

安装布局（Windows 为 per-user）：

```text
%LOCALAPPDATA%\Programs\Cortex\
  Cortex.exe                                    Electron 壳
  resources/app.asar                            主进程 / preload / 渲染层构建产物
  bin\
    node.exe                                    内置 Node LTS 运行时
    mcp-stdio.cjs                               stdio MCP 入口
    ctx.cjs  ctx.cmd                            CLI 与包装脚本
    ctx-path.cjs                                安装器 PATH 助手
    web-server.cjs                              ctx web 的 HTTP 服务端 bundle
    web\                                        独立 Web 界面（index.html + 哈希资源）
    skills\{zh,en}\...                          ctx init 的 Skill 源
    node_modules\                               better-sqlite3（Node-API）
```

`.github/workflows/release.yml` 在 `v*` / `cortex-v*` tag 推送时构建 Windows 安装包并发布到 GitHub Releases。macOS/Linux 使用上面的 CLI 方式，因此不产出 macOS 安装包。

## 工程结构

```text
src/
  shared/      共享契约（类型、IPC、Zod schema、MCP 配置生成器）
  core/        Electron-free 数据库、路径、日志、版本
  mcp/         纯 stdio MCP Server 与 6 个工具
  cli/         ctx 命令与 Agent 配置写入
  server/      ctx web HTTP 服务端（鉴权、安全、静态 SPA、REST/SSE 路由）
  main/        Electron 主进程（IPC、文件监听、数据库切换，不启动 MCP）
  preload/     contextBridge API
  renderer/    React 界面 + 轻量 zh/en i18n（消息在 renderer/src/i18n）
skills/        双语 Agent Skill（zh / en）
scripts/       构建、运行时、打包与兼容安装脚本
build/         NSIS 自定义脚本
```

## 数据与并发

- 默认数据库：Windows `%USERPROFILE%\.cortex\data.db`，macOS/Linux `~/.cortex/data.db`；可用 `CTX_DB_PATH`（旧的 `PDH_DB_PATH` 仍兼容）覆盖。
- `PRAGMA journal_mode=WAL`、`busy_timeout=5000`、`synchronous=NORMAL`、`foreign_keys=ON`；写事务使用 `BEGIN IMMEDIATE` 并对 SQLITE_BUSY 有限重试；schema 版本记录在 `PRAGMA user_version`。
- 迁移在单个 immediate 事务中执行，多个 Agent 进程并发启动也只会成功迁移一次。
- 数据库为明文（含 `leaked_infos` 中的凭据），是本版本明确接受的权衡。

## 安全与工程约束

- **MCP 仅 stdio**：MCP Server 不监听端口，由 Agent 拉起并随其退出而销毁；stdout 只输出 JSON-RPC，日志写 stderr 或 `CTX_MCP_LOG`。可选的 Web 端（`ctx web`）是另一个需要 token 鉴权的 HTTP 服务，不启动就不存在，默认只监听回环地址，非回环必须显式传 `--allow-intranet`。
- **进程隔离**：`contextIsolation` + `sandbox`，关闭 `nodeIntegration`；桌面端渲染进程只通过 `window.api` 访问数据，主进程对每个 IPC 入参再次校验（浏览器 Web 端改用同源 HTTP，见 [Web 端（仅内网）](#web-端仅内网)）。
- **Zod 双层校验**：MCP 与 IPC 边界均校验；SQL 全部参数绑定。
- **并发**：WAL + busy timeout + immediate 事务 + 重试，避免瞬时锁冲突暴露为工具错误。

## License

MIT，见 [LICENSE](LICENSE)。
