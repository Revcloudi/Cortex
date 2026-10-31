# Cortex

Cortex 是一个本地优先的渗透测试数据中枢：同一份 SQLite 记忆库同时服务于 **纯 stdio MCP Server**（Agent）、**`ctx` CLI**（终端）与 **Electron 桌面端**（人类）。它不是扫描器——Agent 负责写入确认过的漏洞、侦察到的资产上下文与任务认知快照，人类负责检索、过滤、复测与交接。

English docs: [README.md](README.md)

## 下载与安装

安装包由 GitHub Actions 发布到 Releases。当前版本：**cortex-v0.1.1**。

| 平台 | 下载 |
| --- | --- |
| Windows 10/11 x64 | [Cortex-0.1.1-setup.exe](https://github.com/Revcloudi/Cortex/releases/latest/download/Cortex-0.1.1-setup.exe) |
| macOS Apple Silicon（arm64） | [Cortex-0.1.1-arm64.dmg](https://github.com/Revcloudi/Cortex/releases/latest/download/Cortex-0.1.1-arm64.dmg) |
| macOS Intel（x64） | [Cortex-0.1.1-x64.dmg](https://github.com/Revcloudi/Cortex/releases/latest/download/Cortex-0.1.1-x64.dmg) |

> 链接始终指向最新的 Cortex Release；完整列表见 [Releases 页面](https://github.com/Revcloudi/Cortex/releases)。当前构建未做代码签名：Windows SmartScreen 可能提示（"更多信息 → 仍要运行"），macOS 首次打开请右键 → 打开，或执行一次 `xattr -dr com.apple.quarantine "/Applications/Cortex.app"`。

### 安装时会询问

**Windows（NSIS 安装器）** 会依次询问：

1. **接入哪些 Agent**：DeepSeek Harness / Codex CLI / Claude Code / Cursor（多选，检测到的客户端默认勾选）；
2. **Skill 语言**：中文 / English（安装对应语言的 `vuln-db` / `asset-context` / `snapshot` Skill）；
3. 可选：是否把 `bin` 加入当前用户 PATH。

随后安装器会用这些选择非交互执行 `ctx init`。卸载只删除程序，保留 `%USERPROFILE%\.cortex\data.db`。

**macOS（DMG）** 把 Cortex 拖入 Applications 即可。DMG 没有安装向导，因此同样的选择（Agent、Skill 语言、界面语言）放在应用**首次启动的欢迎对话框**里；Windows 安装时跳过配置也会在首次启动看到该对话框。

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

- 源码构建需要 Node.js **≥ 22.12**；Windows 安装包与 macOS DMG 内置 Node 运行时，最终用户无需安装 Node。
- 打包产物：Windows 10/11 x64，或 macOS 12+（arm64 / x64）。

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
- 安装包：`npm run dist:win`（Windows）/ `npm run dist:mac`（macOS 或 CI），两者都会内置 Node 运行时；产物在 `release/` 下。

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
| macOS 安装版 | `/Applications/Cortex.app/Contents/bin/node /Applications/Cortex.app/Contents/bin/mcp-stdio.cjs` |

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
| `ctx open [--dev] [--path <exe>]` | 启动/聚焦桌面端（Windows 安装版、macOS App 或源码构建） |

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
npm run dist:mac           # 构建 + 内置运行时 → macOS dmg（必须在 macOS 或 CI 构建）
npm run build:runtime      # 只生成 runtime/（手动/高级打包用）
```

安装布局（Windows 为 per-user）：

```text
Windows: %LOCALAPPDATA%\Programs\Cortex\      macOS: /Applications/Cortex.app/Contents/
  Cortex.exe                                    MacOS/Cortex
  resources/app.asar                            resources/app.asar
  bin\                                          bin/
    node.exe | node                             内置 Node LTS 运行时
    mcp-stdio.cjs                               stdio MCP 入口
    ctx.cjs  ctx.cmd | ctx                      CLI 与包装脚本
    ctx-path.cjs                                安装器 PATH 助手
    skills\{zh,en}\...                          ctx init 的 Skill 源
    node_modules\                               better-sqlite3（Node-API）
```

`.github/workflows/release.yml` 在 `v*` / `cortex-v*` tag 推送时构建 Windows + macOS（arm64/x64），并把**三个安装包**（Windows x64 setup、macOS arm64 dmg、macOS x64 dmg）上传到 GitHub Releases。macOS 构建未签名（无 Apple 开发者证书），因此需要上面的 Gatekeeper 说明。

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
