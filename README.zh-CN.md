![Cortex — 本地优先的 MCP 原生渗透测试数据中枢](assets/readme-hero.png)

# Cortex

本地优先、MCP 原生的授权渗透测试数据中枢：同一份 SQLite 记忆库同时服务于 **纯 stdio MCP Server**（Agent）、**`ctx` CLI**（终端）与 **Windows 桌面端**（人类）。

[![README English](https://img.shields.io/badge/README-English-0f766e?style=flat-square)](README.md)
[![README 中文](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-f59e0b?style=flat-square)](README.zh-CN.md)
[![版本 0.1.1](https://img.shields.io/badge/version-0.1.1-2dd4bf?style=flat-square)](https://github.com/Revcloudi/Cortex/releases)
[![MCP 6 tools](https://img.shields.io/badge/MCP-6%20tools-0ea5e9?style=flat-square)](#mcp-接入)
[![平台](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20CLI%20%C2%B7%20Linux%20CLI-64748b?style=flat-square)](#仅安装-climacos--linux--windows)
[![Node >= 22.12](https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933?style=flat-square)](#环境要求)
[![License MIT](https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square)](LICENSE)

> **仅限授权测试。** Cortex 仅用于你拥有或已获得明确书面授权的系统；使用者需自行遵守相关法律、合同与测试范围约束。

**简体中文** · [English](README.md) · [仅安装 CLI](#仅安装-climacos--linux--windows) · [Windows 桌面端](#windows-桌面端) · [使用示例](#使用示例) · [MCP 工具](#mcp-接入)

## 仅安装 CLI（macOS / Linux / Windows）

`ctx` CLI 是纯 Node.js，macOS / Linux 与 Windows 同源，不需要桌面端或安装包：

```bash
# 需要 Node.js >= 22.12
git clone git@github.com:Revcloudi/Cortex.git
cd Cortex
npm install
npm run build
npm link            # 让 `ctx` 进入 PATH；不 link 时用 node out/cli/ctx.cjs
ctx --version
ctx init --yes      # 为检测到的 Agent 写入 MCP 配置 + 双语 Skill
ctx doctor          # 检查数据库、MCP 运行时与 Agent 配置
```

CLI 与桌面端共享同一份 SQLite 数据库（macOS/Linux 为 `~/.cortex/data.db`，Windows 为 `%USERPROFILE%\.cortex\data.db`）。MCP 是纯 stdio，由 Agent 自行拉起，macOS/Linux 无需安装桌面端。

## Windows 桌面端

Windows 安装包由 GitHub Actions 发布到 Releases。当前版本：**cortex-v0.1.1**。macOS / Linux 请使用上面的 CLI-only 安装方式。

| 平台 | 下载 |
| --- | --- |
| Windows 10/11 x64 | [Cortex-0.1.1-setup.exe](https://github.com/Revcloudi/Cortex/releases/latest/download/Cortex-0.1.1-setup.exe) |

> 链接始终指向最新的 Cortex Release；完整列表见 [Releases 页面](https://github.com/Revcloudi/Cortex/releases)。安装包未做代码签名：Windows SmartScreen 可能提示（"更多信息 → 仍要运行"）。

### 安装时会询问

**Windows（NSIS 安装器）** 会依次询问：

1. **接入哪些 Agent**：DeepSeek Harness / Codex CLI / Claude Code / Cursor（多选，检测到的客户端默认勾选）；
2. **Skill 语言**：中文 / English（安装对应语言的 `vuln-db` / `asset-context` / `snapshot` Skill）；
3. 可选：是否把 `bin` 加入当前用户 PATH。

随后安装器会用这些选择非交互执行 `ctx init`；如果安装时跳过配置，首次启动也会显示同样的欢迎对话框。卸载只删除程序，保留 `%USERPROFILE%\.cortex\data.db`。

桌面端界面支持**中英文随时切换**（侧边栏底部），选择会被记住。Skill 语言只影响写入 Agent 的文件，之后仍可用 `ctx init --skill-lang` 修改。

## 功能

- 漏洞模型：Host、入口、类型、等级、URL、描述、影响、受影响接口、Markdown 复现步骤、修复建议、加解密说明、测试边界、只追加的复测历史、关联漏洞与状态流转。
- 资产上下文：完整 URL、项目、技术栈、结构化 `interfaces`（`path` / `method` / `params` / 原始请求）、敏感泄露、非密 `test_parameters` 与关联漏洞；旧版 `interface_dir` 自动规范化。
- 固定 6 个 MCP 工具：`save_vulnerability`、`query_vulnerabilities`、`update_vulnerability`、`sync_asset_info`、`query_asset_context`、`manage_snapshot`。
- `ctx init` 自动检测 Agent，幂等写入 MCP 配置、3 个 Skill 与系统级强制规则（带备份、`--dry-run`、JSON/TOML/YAML 校验）。
- 桌面端：漏洞看板（服务端过滤/分页）、资产库（接口浏览器）、认知快照（项目 → 子会话层级）、Markdown 报告导出、双语 MCP 接入页（启动命令 + 精简工具表）。
- 侧边栏数据库按钮可切换到任意 Cortex SQLite 文件查看（仅桌面端；Agent 仍使用默认数据库）。
- 主进程用 chokidar 监听 SQLite 文件（`data.db`、`-wal`、`-shm`）并推送 `data:changed`，Agent 写入通常 1 秒内可见，且不丢失筛选与打开的详情。
- Skill 双语：`skills/zh/**` 与 `skills/en/**`，安装时选择。

## 环境要求

- CLI 与源码构建需要 Node.js **≥ 22.12**；Windows 桌面安装包内置 Node 运行时，最终用户无需安装 Node。
- 桌面端仅提供 Windows 10/11 x64；macOS/Linux 使用上面的仅 CLI 方式。

## 从源码构建

```bash
git clone git@github.com:Revcloudi/Cortex.git
cd Cortex
npm install
npm run build       # typecheck + Electron + MCP + CLI 构建
npm run dev         # Electron + Vite 开发模式
```

常用命令：

```bash
npm run typecheck   # Node + Web 两个 TS 项目
npm run build:mcp   # out/mcp/stdio.cjs（Agent 拉起的 stdio MCP 入口）
npm run build:cli   # out/cli/ctx.cjs + out/cli/ctx.cmd
npm start           # preview 构建产物
```

首次启动会在 `%USERPROFILE%\.cortex\data.db`（macOS/Linux：`~/.cortex/data.db`）创建数据库，可用 `CTX_DB_PATH` 覆盖。

### 打开桌面端

- 开发模式：`npm run dev`
- 已构建：`npm start`（link 过 CLI 后可 `ctx open`）
- 安装包：`npm run dist:win`（会一并构建内置 Node 运行时）；产物在 `release/` 下。

### 让 `ctx` 成为全局命令

执行 `npm run build` 之后：

```bash
npm link        # 在 npm 全局 bin 注册 ctx 命令（标准 Node 安装已在其 PATH 中）
ctx --version
```

不执行 link 时：`node out/cli/ctx.cjs --version` 或 `npm run ctx -- --version`。

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

## 使用示例

MCP 走 **stdio JSON-RPC**，没有可 curl 的 HTTP 端点。执行 `ctx init` 后由 Agent 拉起 MCP 并调用 6 个工具；桌面端与 `ctx` 读取同一份 SQLite，Agent 写入后 GUI/CLI 立即能看到。

| 工具 | 什么时候用 |
| --- | --- |
| `query_asset_context` | 测试资产前：复用项目名、技术栈、接口、泄露与测试参数。 |
| `sync_asset_info` | 侦察/JS 审计/抓包后：写入指纹、结构化接口、敏感泄露与非密测试参数。 |
| `query_vulnerabilities` | 保存前查重，或回顾已有漏洞记录。 |
| `save_vulnerability` | 写入确认漏洞（含 Markdown 复现步骤）。 |
| `update_vulnerability` | 状态流转，或追加复测结论而不覆盖原始证据。 |
| `manage_snapshot` | 保存/恢复当前任务的战术状态（“会话记忆”）。 |

### 1. 复用侦察成果并写入资产上下文

先让 Agent 读取已有记忆（DSH 中工具名是 `mcp__cortex__*`，其他客户端用不带前缀的名字）：

```text
query_asset_context({ "host_port": "https://app.example.com/login" })
query_asset_context({ "project_name": "示例项目" })
```

侦察完成后写入本次结果（`sync_asset_info` 参数）：

```json
{
  "mode": "merge",
  "host_port": "https://app.example.com/login",
  "project_name": "示例项目",
  "tech_stack": "Nginx, Spring Boot, Vue",
  "interfaces": [
    {
      "path": "/api/v1/files/download",
      "method": "GET",
      "params": "file_id=1",
      "request": "GET /api/v1/files/download?file_id=1 HTTP/1.1\r\nHost: app.example.com\r\n"
    }
  ],
  "test_parameters": [
    {
      "name": "file_id",
      "endpoint": "GET /api/v1/files/download?id={id}",
      "location": "query",
      "values": ["1", "2", "3"],
      "pattern": "自增整数"
    }
  ]
}
```

规则：`host_port` 优先传完整 URL；`mode: "replace"` 写完整快照，`mode: "merge"` 增量合并；JS/CSS/图片只作为证据，不是接口。

### 2. 查重、写入与复测

```text
query_vulnerabilities({ "host": "app.example.com:443" })
```

新漏洞调用 `save_vulnerability`（字段含 `vuln_name`、`host`、`severity`、`target_url`、`description`、`impact`、Markdown 格式的 `reproduction_steps`、`remediation`、`status` 等）。复测已有漏洞时只追加：

````text
update_vulnerability({
  "vuln_id": "VULN-20260101-001",
  "retest": {
    "time_range": "2026-01-02 10:00–10:04",
    "conclusion": "### 复测结论\n\n- **结果**：仍可复现\n\n```http\nGET /api/v1/files/download?file_id=1 HTTP/1.1\nHost: app.example.com\n```"
  }
})
````

不要用 `save_vulnerability` 覆盖原始证据；复测和状态流转都用 `update_vulnerability`。

### 3. 会话记忆（认知快照）

快照与漏洞/资产存在同一个 SQLite 数据库里，Agent 重启后仍可恢复。新会话开始时：

```text
manage_snapshot({ "action": "list" })
manage_snapshot({ "action": "load", "session_id": "SESS-20260101-001" })
```

阶段完成 / 上下文将满 / 会话结束前保存：

```json
{
  "action": "save",
  "payload": {
    "project_name": "示例项目",
    "target_hosts": ["app.example.com"],
    "current_phase": "IDOR 验证",
    "unfinished_tasks": ["验证 /api/v1/orders/{id} 是否能读租户 B 数据"],
    "failed_paths": ["/admin 需要 SSO"],
    "next_steps": "枚举下载接口的 file_id"
  }
}
```

- 项目会话可挂**一层**子会话（`parent_session_id`）；同一任务只维护一个活跃会话。
- 同项目已有会话时，`save` 会返回 `SESSION_EXISTS` + 候选，必须让用户选择「继续已有会话」或 `force_new: true`，不要自行猜测。
- `attach_assets({ "hosts": ["app.example.com"] })` 把目标并入会话；`restore_previous` 回滚一次覆盖。
- 快照只放结论/战术状态（`notes`、`tested_interfaces`、`related_vuln_ids`），不要放大段 HTTP 报文/截图；payload ≤32,000 字符，`notes` 只用路径引用证据。
- 归档会话在数据库中只读；需要复用时先在桌面端取消归档。

### 4. 查看与交接

- 桌面端：漏洞看板、资产库、认知快照（项目 → 子会话）、Markdown 导出；侧边栏数据库按钮可打开其它 SQLite 文件查看。
- CLI：`ctx vulns list --severity High`、`ctx assets get app.example.com`、`ctx snapshots list`、`ctx search 支付`、`ctx doctor`。

## CLI（ctx）

Node 运行、不依赖 Electron，读取同一份 SQLite。所有命令支持 `--json`；退出码 0 成功、1 参数/IO 错误、2 数据不存在。

| 命令 | 说明 |
| --- | --- |
| `ctx init [--dry-run] [--yes] [--agents dsh,codex,claude,cursor] [--skill-lang zh\|en]` | 检测 Agent、展示计划 diff、备份后写入 MCP 配置 + Skill + 系统规则 |
| `ctx doctor` | 检查数据库、schema、MCP/CLI 运行时、Agent 配置、GUI 安装与版本 |
| `ctx mcp print-config [agent]` | 打印 DSH / Codex / Claude Code / Cursor 的 stdio 配置片段 |
| `ctx vulns list [--severity] [--host] [--limit]` | 漏洞列表 |
| `ctx vulns get <id>` | 查看完整漏洞 |
| `ctx assets list [--search] [--status]` | 资产列表 |
| `ctx assets get <host_port>` | 查看资产上下文 |
| `ctx snapshots list [--keyword]` | 认知快照列表 |
| `ctx snapshots get <session_id>` | 查看单条会话 |
| `ctx search <keyword>` | 同时搜索漏洞 / 资产 / 快照 |
| `ctx open [--dev] [--path <exe>]` | 启动/聚焦桌面端（Windows 安装版或源码构建） |

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
    skills\{zh,en}\...                          ctx init 的 Skill 源
    node_modules\                               better-sqlite3（Node-API）
```

`.github/workflows/release.yml` 在 `v*` / `cortex-v*` tag 推送时构建 Windows 安装包并发布到 GitHub Releases。macOS/Linux 使用上面的 CLI-only 方式，因此不产出 macOS 安装包。

## 工程结构

```text
src/
  shared/      共享契约（类型、IPC、Zod schema、MCP 配置生成器）
  core/        Electron-free 数据库、路径、日志、版本
  mcp/         纯 stdio MCP Server 与 6 个工具
  cli/         ctx 命令与 Agent 配置写入
  main/        Electron 主进程（IPC、文件监听、首次启动向导，不启动 MCP）
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

- **仅 stdio**：不监听端口、没有 HTTP 端点；MCP 进程随 Agent 退出而销毁。stdout 只输出 JSON-RPC，日志写 stderr 或 `CTX_MCP_LOG`。
- **进程隔离**：`contextIsolation` + `sandbox`，关闭 `nodeIntegration`；渲染进程只通过 `window.api` 访问数据，主进程对每个 IPC 入参再次校验。
- **Zod 双层校验**：MCP 与 IPC 边界均校验；SQL 全部参数绑定。
- **并发**：WAL + busy timeout + immediate 事务 + 重试，避免瞬时锁冲突暴露为工具错误。

## License

MIT，见 [LICENSE](LICENSE)。
