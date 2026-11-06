# dsh-cortex（原版 Cortex UI 移植）

把本地 **Cortex** 桌面端工作台**原样移植**进 **DeepSeek Harness** 的原生全局面板：
漏洞看板、内网作战、**记忆星云（Nebula）知识图谱**、资产库、认知快照、复测实验室、MCP 接入。

- **1:1 移植**：直接复用 Cortex 原渲染层源码（React 19 源码 / Tailwind / Radix / lucide /
  react-markdown / three.js + ForceGraph），原 App 组件、页面、i18n、样式**未做视觉重设计**。
- **无 Electron 依赖**：数据由插件 Host 用 `node:sqlite` 直读 `~/.cortex/data.db`（schema v5），
  通过 `/cortex-api/cortex/**` 暴露给浏览器；Cortex 桌面端 / CLI / Web 均可关闭。
- **无 MCP 依赖**：不启动 Cortex MCP server，不注册 MCP 工具。
- 只监听 loopback（仅本机可访问）；凭据 secret 永不出库；不自动迁移数据库。

## 环境要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness | **0.2.2-rc.1**（实测；使用其 Client 模块加载器 / `slots` / `webServer`） |
| Node.js | **>= 22.19.0**（`node:sqlite`） |
| Cortex 数据库 | **schema v5**（`PRAGMA user_version = 5`） |
| 平台 React | DSH 页面提供 **React 18.3.1**；插件内置配套 `react-dom@18.3.1` 与 JSX runtime shim |

> schema 不是 v5 时：所有数据接口返回 `409 SCHEMA_INCOMPATIBLE`，界面显示不兼容提示，
> **不写库、不自动迁移**。

## 安装

Agent / 内置管理工具（推荐，DSH 维护 profile，不要手写 profile 的 `package.json` / `cordis.patch.yml`）：

```text
plugin_manager action=install_bundle target="C:\absolute\path\to\dsh-cortex"
```

或 DSH CLI：

```bash
dsh plugin --profile desktop add link:C:\absolute\path\to\dsh-cortex
```

发布到 registry 后：

```bash
dsh plugin add dsh-cortex
```

安装后左侧全局面板出现 **Cortex** 图标（`sidebar.panellist`，order 5，位于「插件 / 自动化任务」之间），
点击进入整页工作台。面板内部采用 **DSH 外壳适配布局**：顶部一行横向卡片导航（漏洞看板 / 内网作战 / 记忆星云 /
资产库 / 认知快照 / 漏洞复测，图标与激活色沿用原侧栏），右端为中英文切换；不再渲染原 236px
侧栏、Cortex 品牌与 data.db 卡片（DSH 左栏已承担会话卡片，避免出现两组左侧卡片）。
原 MCP 接入页已移除（插件本身不依赖 MCP）；Inter / JetBrains Mono 字体在文档层注入，
确保 Shadow DOM 内也能真正使用原始字体。
链接安装时重建 `client.js` 会被 DSH `client-hmr` 自动热替换，无需刷新页面；
Host 代码（`index.js` / `src/host/**`）变更需要 DSH 重载或插件 recomposition。

## 卸载

```text
plugin_manager action=remove_bundle target="dsh-cortex"
```

只移除插件注册，**不会删除** Cortex 数据库。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CORTEX_DB_PATH` | `~/.cortex/data.db` | Cortex SQLite 路径（可指向副本） |
| `CORTEX_DB_READONLY` | 未设置 | 设为 `1` 强制只读（状态修改 / 复测发送等写操作 403） |

## 页面（与原 UI 一致）

| 页面 | 说明 |
|---|---|
| 漏洞看板 | 漏洞列表 / 搜索 / severity·status·realm 过滤 / 分页 / 详情抽屉 / 状态流转 / 删除 / 导出报告 / 种子数据 |
| 内网作战 | 项目切换；footholds / hosts / services / credentials / pivots；凭据矩阵、子网热力图、Loot 解析 |
| 记忆星云 | 3D 知识图谱（three.js + ForceGraph3D）：漏洞 / 资产 / 泄露 / 快照 / 内网实体；2D 降级；节点检查器；范围选择 |
| 资产库 | 资产表 / 详情抽屉：技术栈、结构化接口（原始 HTTP 请求）、泄露信息、测试参数、关联漏洞 |
| 认知快照 | 项目 → 父/子会话；九字段、测试接口、关联漏洞、归档/恢复/删除 |
| 漏洞复测 | 原 Repeater 面板；Web 漏洞步骤、重定向、响应渲染；顶部状态修改 |
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
npm test               # node --test（195+ 用例：Host / 集成 / jsdom 忠实度 / manifest）
npm run smoke          # jsdom 忠实度冒烟（236px 侧栏 / 7 导航 / 数据渲染 / 0 console.error）
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
3. **schema 只认 v5**：不迁移、不写库。
4. **AI 配置页**：与 Cortex `ctx web` 一致隐藏（桌面端专属）。
5. **无浏览器控制**：交付验证覆盖 slot/HTTP/jsdom 结构 + 真实页面离屏挂载探针（7 页面 0 错误、
   Nebula canvas 已渲染）；无截图级像素比对。
6. **Nebula 3D**：真实页面 WebGL2 可用已实测；jsdom 无 WebGL，测试只断言懒加载路由与打包内容。
7. **删除/归档写操作**：按原 UI 行为实现，仅用合成 fixture 测试；真实库未做破坏性验证。
8. **未发布 npm**：`dsh plugin add dsh-cortex` 需先发布 registry（本机以 link 安装验证）。
