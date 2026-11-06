# dsh-cortex（Cortex 的 DeepSeek Harness 插件）

把本地 **Cortex** 桌面端工作台**原样移植**进 **DeepSeek Harness** 的原生全局面板：
漏洞看板、内网作战、**记忆星云（Nebula）知识图谱**、资产库、认知快照、漏洞复测。
插件同时注册 **12 个原生 Agent 工具**，DSH 对话可直接读写同一份 Cortex SQLite，**不需要 MCP**。

- **1:1 移植**：直接复用 Cortex 原渲染层源码（React / Tailwind / Radix / lucide /
  react-markdown / three.js + ForceGraph），原 App 组件、页面、i18n、样式**未做视觉重设计**。
- **无 Electron 依赖**：数据由插件 Host 用 `node:sqlite` 直读 `~/.cortex/data.db`（schema v5），
  通过 `/cortex-api/cortex/**` 暴露给浏览器；Cortex 桌面端 / CLI / Web 均可关闭。
- **无 MCP 依赖**：内置 `cortex_*` Agent 工具 + 系统提示注入，替代原 MCP 工作流。
- 只监听 loopback（仅本机可访问）；凭据 secret 永不出库；不自动迁移数据库。

> 本插件是 Cortex 仓库的一部分（`dsh-cortex/`），与 Cortex 同源发布；Cortex 桌面端 / Web / CLI 的
> 安装方式见仓库根目录 [README](../README.md)（DSH 插件章节之后）。

## 环境要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness | **0.2.2-rc.1**（实测；使用其 Client 模块加载器 / `slots` / `webServer`） |
| Node.js | **>= 22.19.0**（`node:sqlite`） |
| Cortex 数据库 | **schema v5**（`PRAGMA user_version = 5`） |
| 平台 React | DSH 页面提供 **React 18.3.1**；插件内置配套 `react-dom@18.3.1` 与 JSX runtime shim |

> schema 不是 v5 时：所有数据接口返回 `409 SCHEMA_INCOMPATIBLE`，界面显示不兼容提示，
> **不写库、不自动迁移**。

## 在 DSH 中安装（推荐）

插件包名 **`@lievclouds/dsh-cortex`**，位于 Cortex 仓库 `dsh-cortex/`，与 Cortex 同源发布。
三种安装方式任选：

1. **DSH 插件市场（一键）**：打开 DSH 桌面端 → 插件 / Plugin Manager → 市场（Market）→ 搜索
   `dsh-cortex` → 安装。需要该版本已发布到 npm（发布流程见仓库
   [`.github/workflows/publish-dsh-cortex.yml`](../.github/workflows/publish-dsh-cortex.yml)）。
2. **DSH 命令（一行）**：

   ```bash
   dsh plugin --profile desktop add @lievclouds/dsh-cortex
   ```

3. **本仓库本地开发（link）**：

   ```bash
   dsh plugin --profile desktop add ./dsh-cortex
   ```

   也可使用 DSH Agent 的管理工具：`plugin_manager action=install_bundle target="<repo>/dsh-cortex"`。

安装后左侧全局面板出现 **Cortex** 图标（`sidebar.panellist`，order 5，位于「插件 / 自动化任务」之间），
点击进入整页工作台。面板内部采用 **DSH 外壳适配布局**：顶部一行横向卡片导航（漏洞看板 / 内网作战 /
记忆星云 / 资产库 / 认知快照 / 漏洞复测，图标与激活色沿用原侧栏），右端为中英文切换；不渲染原
236px 侧栏、Cortex 品牌与 data.db 卡片（DSH 左栏已承担会话卡片）。
原 MCP 接入页已移除；Inter / JetBrains Mono 字体在文档层注入，确保 Shadow DOM 内真正使用原始字体。
链接安装时重建 `client.js` 会被 DSH `client-hmr` 自动热替换，无需刷新页面；
Host 代码（`index.js` / `src/host/**`）变更需要 DSH 重载或插件 recomposition。

## 插件市场生态

仓库根目录的 `plugin-index.json` 是 **format 1** DSH 插件市场索引（官方校验器通过），在 DSH 中
「插件 → Discover → Add index source」填入：

```text
https://raw.githubusercontent.com/Revcloudi/Cortex/main/plugin-index.json
```

即可搜索 `Cortex` 一键安装（当前版本以 git commit + `dsh-cortex/` 子目录固定，npm 发布后可把
`source` 换成 `{ "type": "npm" }`）。想加入社区索引/awesome 列表，可向
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)、
[polang233/dsh-plugin-index](https://github.com/polang233/dsh-plugin-index)、
[Aily-DSH/dsh-plugin-index](https://github.com/Aily-DSH/dsh-plugin-index)、
[shutongX/dsh-plugins-index](https://github.com/shutongX/dsh-plugins-index)、
[dsh-plugin-lab/market](https://github.com/dsh-plugin-lab/market) 提交 format-1 条目 PR。

## 卸载

```text
plugin_manager action=remove_bundle target="dsh-cortex"
# 或 CLI：
dsh plugin --profile desktop remove @lievclouds/dsh-cortex
```

只移除插件注册，**不会删除** Cortex 数据库。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CORTEX_DB_PATH` | `~/.cortex/data.db` | Cortex SQLite 路径（可指向副本） |
| `CORTEX_DB_READONLY` | 未设置 | 设为 `1` 强制只读（状态修改 / 复测发送等写操作 403） |

## 对话内访问（非 MCP）

插件不再需要 MCP，也不需要手动写 skill 注入：Host 半边通过 `ctx.tools.register` 注册 12 个原生
Agent 工具，并通过 `ctx.systemPrompt.section` **自动注入使用说明**（常驻系统提示，作用等同原 MCP
skill 注入，但由插件自身维护）。对话里正常描述目标即可触发：

| 工具 | 说明 |
|---|---|
| `cortex_list_vulns` / `cortex_get_vuln` | 漏洞列表（realm/search/severity/status/分页）/ 完整证据 |
| `cortex_save_vuln` | 新增或更新漏洞（省略 id 自动分配 VULN-YYYYMMDD-NNN） |
| `cortex_update_vuln_status` | 更新漏洞状态（只改 status 列） |
| `cortex_append_retest` | 追加复测结论（append-only，不改原始证据） |
| `cortex_list_assets` / `cortex_get_asset` | 资产列表 / 详情（结构化接口、泄露、测试参数） |
| `cortex_sync_asset_info` | 同步资产上下文（mode=merge 增量 / replace 全量） |
| `cortex_list_snapshots` / `cortex_get_snapshot` | 认知快照列表 / 详情（九字段） |
| `cortex_internal_overview` | 内网作战范围汇总（footholds/hosts/services/credentials/pivots） |
| `cortex_graph_summary` | 记忆星云派生图规模与高连接节点 |

**提示词写法**（自然语言即可，明确「动作 + 对象」最稳）：

- 查询：`列出 Cortex 漏洞库里 127.0.0.1:8080 的所有高危漏洞`、`查一下 VULN-20261102-007 的详情`
- 写入：`把刚才确认的 SSRF 漏洞写入 Cortex：host 127.0.0.1:8080，severity High，target ...`
- 状态：`把 VULN-20261102-007 标记为已确认`
- 复测：`给 VULN-20261102-007 追加一条复测结论：2026-11-07 复测仍可复现，...`
- 资产：`把 127.0.0.1:8080 的接口/泄露/技术栈同步到资产库（merge）`
- 内网/星云：`汇总一下内网作战范围`、`星云图里哪些节点连接最多`
- 若模型没自动触发，可直接点名：`用 cortex_list_vulns 查 ...`

同一套能力也以 `/cortex-api/cortex/**` HTTP 路由暴露（loopback），
`node scripts/verify-agent-access.mjs` 可对运行中的 DSH 做非 MCP 读写验证。

> 旧的 `mcp__cortex__*` 工具仍可用但不再必需；插件工具与 MCP 共用同一 SQLite，
> 两套入口可混用（写入建议只走其中一套，避免重复记录）。

---

## 页面（与原 UI 一致）

| 页面 | 说明 |
|---|---|
| 漏洞看板 | 漏洞列表 / 搜索 / severity·status·realm 过滤 / 分页 / 详情抽屉 / 状态流转 / 删除 / 导出报告 / 种子数据 |
| 内网作战 | 项目切换；footholds / hosts / services / credentials / pivots；凭据矩阵、子网热力图、Loot 解析 |
| 记忆星云 | 3D 知识图谱（three.js + ForceGraph3D）：漏洞 / 资产 / 泄露 / 快照 / 内网实体；2D 降级；节点检查器；范围选择 |
| 资产库 | 资产表 / 详情抽屉：技术栈、结构化接口（原始 HTTP 请求）、泄露信息、测试参数、关联漏洞 |
| 认知快照 | 项目 → 父/子会话；九字段、测试接口、关联漏洞、归档/恢复/删除 |
| 漏洞复测 | 原 Repeater 面板；Web 漏洞列表、步骤、重定向、响应渲染；顶部状态修改 |
| AI 配置 | 桌面端专属；Web/DSH 运行时按原逻辑隐藏 |

> MCP 接入页已按需求移除：DSH 插件直接访问本地 SQLite，不需要 MCP。

## 架构

```
DSH Web (page, dsh-app://app/)
  └─ client.js  ← 原 Cortex App（Shadow DOM 内挂载，Tailwind 样式完全隔离）
       └─ fetch('/cortex-api/cortex/**')  ← 同源相对路径可用（DSH 代理到本机 webServer）
            └─ Host 插件（index.js → src/host/*）
                 ├─ 原 DSH 风格 REST：/cortex-api/health|stats|vulns|assets|internal|snapshots|reports
                 └─ 原 CortexApi 兼容层：/cortex-api/cortex/**（vulns/assets/snapshots/internal/graph/poc/repeater…）
                      ├─ node:sqlite 只读查询 ~/.cortex/data.db (schema v5)
                      └─ 记忆星云：原 buildMemoryGraph.ts（编译为 graph-builder.js） + node:sqlite 适配器
```

- 移植时的平台适配：React 18 shim、`react-dom@18.3.1` 内置、JSX runtime shim、Sonner→Shadow toast 兼容层、
  Radix Portal 重定向到 Shadow 容器、Tailwind 样式注入 Shadow root。
- **只改数据层**：`renderer/lib/transport/index.ts` 改为插件 API；原 App / pages / components 未改。

## 安全

- 仅 loopback peer + loopback Host；写操作同源校验（Origin / Sec-Fetch-Site / JSON）。
- 凭据 `secret` 永不序列化；内网凭据矩阵只显示 masked 值。
- 复测出站：origin allowlist、默认不跟随重定向（≤5 跳）、15s、2MiB 截断。
- 日志不含 SQL / 凭据 / 请求体 / 数据库绝对路径。

## 开发

```powershell
npm run build          # 重新编译记忆星云构建器 + 原 UI client.js（Tailwind + esbuild）
npm test               # node --test（204 用例：Host / 集成 / jsdom 忠实度 / manifest）
npm run smoke          # jsdom 忠实度冒烟（顶部导航行 / 6 导航 / 数据渲染 / 字体注入 / 0 console.error）
node scripts/build-cortex-ui.mjs     # 只重建 client.js
node scripts/build-host-graph.mjs    # 只重建 Nebula 图构建器
node scripts/verify-cortex-api.mjs   # 对运行中的 DSH 校验 /cortex-api/cortex/**
```

目录：

```
src/cortex-ui/renderer/   # 原 Cortex 渲染层（vendor，仅 4 处平台适配改动）
src/cortex-ui/shared/     # 原 shared 类型/契约（vendor）
src/cortex-ui/graph/      # 原 buildMemoryGraph.ts（vendor）
src/cortex-ui/dsh/        # 平台入口（Shadow DOM / API 传输 / sonner shim / wrapper）
src/host/                 # 插件 Host（原 REST + CortexApi 兼容层 + Nebula 图适配）
scripts/                  # 构建 / 冒烟 / 实测脚本
fixtures/ test/           # 合成 schema-v5 fixture 与测试
```

## 已知限制

1. **仅 loopback**：其他机器访问 403（页面显示「仅本机可用」）。
2. **DSH 版本适配面**：实测 DSH 0.2.2-rc.1 + Node 24.21.0；平台 React 18.3.1。
3. **schema 只认 v5**：不迁移、默认不创建数据库（`CORTEX_DB_PATH` 可指向副本）。
4. **AI 配置页**：与 Cortex `ctx web` 一致隐藏（桌面端专属）；MCP 接入页已移除。
5. **星云全屏**：优先 Browser Fullscreen API（Electron 真全屏，隐藏任务栏/窗口按钮）；API 被拒绝时
   降级为页内覆盖层，Esc / 右下角按钮退出。
6. **无浏览器控制**：交付验证覆盖 slot/HTTP/jsdom 结构 + 真实页面离屏挂载探针（7 页面 0 错误、
   Nebula canvas 已渲染）；无截图级像素比对。
7. **Nebula 3D**：真实页面 WebGL2 可用已实测；jsdom 无 WebGL，测试只断言懒加载路由与打包内容。
8. **删除/归档写操作**：按原 UI 行为实现，仅用合成 fixture 测试；真实库未做破坏性验证。
9. **npm 发布**：包名 `@lievclouds/dsh-cortex`。首次发布前，插件市场与 `dsh plugin add` 需等
   `npm publish` 完成；本地仓库可直接用安装方式 3（link）安装。
