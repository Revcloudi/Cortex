# Cortex 原 UI 移植报告（2026-11-06，第二轮交付）

> 用户要求：放弃 DSH 风格重设计，**按 Cortex 原 UI 做 1:1 移植**，并**包含知识星云（Nebula）模块**。
> 交付仓库：`C:\Users\slg13\Desktop\dsh-cortex`（独立于 Cortex 仓库；Cortex 源码仅作为 vendor 复制进插件
> 并由插件自己的构建管线打包，运行时无任何 Cortex 仓库/进程依赖）。

## 1. 结论

原版 Cortex 工作台（App / Titlebar / 236px Sidebar / 漏洞看板 / 内网作战 / **记忆星云** / 资产库 /
认知快照 / MCP 接入 / 复测）现已**原样**运行在 DSH 0.2.2-rc.1 的主面板中：

- 左侧全局面板出现 **Cortex** 入口（`sidebar.panellist`，id `cortex`，order 5，active）；
- 主面板 `main` key `cortex` 挂载**未修改业务代码**的原 Cortex `<App/>`（Shadow DOM 内）；
- 数据来自插件 Host 直读 `~/.cortex/data.db`（schema v5），经 `/cortex-api/cortex/**` 提供；
- 知识星云使用原 `buildMemoryGraph.ts` 构建器 + `node:sqlite` 适配器，真实库图规模
  **30 nodes / 51 links（realm=all；web 26/47）**，真实 DSH 页面中 **canvas 已渲染、WebGL2 可用**；
- 全量测试 **195/195 通过**，jsdom 忠实度 **18/18**，真实页面离屏挂载巡视 **7 页面 0 错误**。

## 2. 平台事实（真实页面实测，非猜测）

用临时探针从运行中的 DSH 页面取回（`recon/dsh-client-diag.json`）：

| 事实 | 值 | 影响 |
|---|---|---|
| 页面 origin | `dsh-app://app/` | 绝对 `http://127.0.0.1:63877` 被 CORS 拒；**相对 `fetch('/cortex-api/...')` 返回 200**（DSH 代理到本机 webServer）→ 数据走同源相对路径 |
| 平台 React | **18.3.1**（非 19） | 原 UI 以 React 18 运行；hooks/组件兼容 |
| `require('react-dom')` / `react/jsx-runtime` | **不可用** | 插件内置 `react-dom@18.3.1` + JSX runtime shim，共享平台 React 实例 |
| CSP | 无 | 允许 Shadow DOM 内 `<style>` 注入 |
| WebGL2 | 可用（maxTexture 16384） | Nebula 3D 可渲染 |
| 视口 / 语言 | 1920×1032 / zh-CN / localStorage 可用 | 与原 UI 断点、i18n 行为一致 |

## 3. 移植方式

### 3.1 Vendor 原渲染层（未重写视觉）

```
src/cortex-ui/renderer/**   原 src/renderer/src 全部 98 个文件（App/pages/components/ui/nebula/i18n/assets）
src/cortex-ui/shared/**     原 src/shared（类型 + 运行时常量：graph/internal/types/poc/repeater…）
src/cortex-ui/graph/buildMemoryGraph.ts   原 core/graph 构建器（逐字复制）
```

原 App、页面、组件、i18n 文案、Tailwind 类名与样式**均未改动**。
仅 4 处平台适配（有据可查）：

1. `renderer/lib/transport/index.ts`：Electron 桥/`ctx web` HTTP → 插件 Host `/cortex-api/cortex/**`，`IS_WEB_RUNTIME=true`。
2. `renderer/components/ui/{sheet,select,tooltip}.tsx`：Radix Portal 容器 → Shadow DOM 内 `getPortalContainer()`。
3. `src/cortex-ui/dsh/**`：新增平台入口（Shadow DOM 挂载、CortexApi 传输、Sonner 兼容层、CSS 注入、ModuleLoader 包装）。
4. 未改 `index.css`（原生 Tailwind 样式在 Shadow root 内天然隔离）。

### 3.2 构建管线（`scripts/build-cortex-ui.mjs`）

```
Tailwind CLI（原 config 等价内容，content=renderer+dsh）
  → esbuild CSS（@fontsource Inter/JetBrains 字体内联为 dataURL，最终 459 KiB）
esbuild IIFE（React shim + react-dom 18.3.1 + Radix + lucide + react-markdown + remark-gfm +
             react-syntax-highlighter + three + force-graph + sonner-shim + zod）
  → UI bundle 3022 KiB
组合 → client.js 3486 KiB（window.__ModuleLoader__.load；Shadow DOM 挂载；无任何探针代码）
```

- 已修复的关键兼容 bug：esbuild IIFE 的 `globalName` 在 ModuleLoader factory 内是函数作用域，
  改为 `globalName: DSH_CORTEX_UI_IIFE` + footer `globalThis.__DSH_CORTEX_UI__ = ...`，否则 UI 永远不挂载。
- `node scripts/build-host-graph.mjs`：把原 `buildMemoryGraph.ts` 编译为 Host 可用的 ESM
  （重映射 `../../shared/*`、bundle zod），产出 `src/host/cortex/graph-builder.js`。

### 3.3 数据层（唯一被改造的部分）

| 层 | 文件 | 说明 |
|---|---|---|
| 浏览器传输 | `src/cortex-ui/dsh/api.ts` | 原 `CortexApi` 40+ 方法 → `/cortex-api/cortex/**` 1:1 映射；`onDataChanged` 用 `/rev` 轮询 |
| Host 路由 | `src/host/cortex/index.js` + `router.js` | `/cortex-api/cortex/**` 优先于旧路由表委托；重新实现 loopback/同源栅栏、错误 envelope |
| REST 兼容层 | `vulns.js` `assets.js` `snapshots.js` `misc.js` `repeater.js` | 返回**原 shared TS 类型**的 JSON；写操作：status/删除/归档/恢复/credential-trial 追加；`/poc/**`、`/setup/run` 安全 stub |
| 记忆星云 | `graph.js` + `graph-adapter.js` + `graph-builder.js` | 原构建器逐字复用；适配器实现其 16 个 DB 方法（含 `listGraphInternalEntryAssets`）；`/internal/*`、`/loot` 原契约形状 |
| 凭据 | graph-adapter / dto | 复用 Cortex `maskSecret` 语义；`secret` 永不回传（测试断言） |

记忆星云实测（真实 `~/.cortex/data.db`，只读）：

| scope / realm | 节点 / 边 | 组成 |
|---|---|---|
| all / web（默认） | 26 / 47 | project1 target6 host1 vuln9 leak8 snapshot1 |
| all / all | **30 / 51** | vuln13（9 web + 4 internal），无 foothold 行 → routes 0 |
| all / internal | 4 / 0 | 4 条 internal realm 漏洞（真实库无内网实体，与原桌面端一致） |
| asset scope | 200 | `http://127.0.0.1:8080/` 邻域 |
| task scope | 200 | `SESS-20261102-001` 快照邻域 |

## 4. 验证证据

| 验证 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `node --test` | **195 / 195 pass**（Host 155、集成 15、客户端 jsdom 11、manifest 8、fixture 6） |
| Host 套件 | `node --test "test/host/**/*.test.mjs"` | 155 / 155 |
| 原 UI jsdom 忠实度 | `node scripts/smoke-cortex-ui.mjs` | **18 / 18**：236px `aside`、7 导航 + 原 lucide 图标、Titlebar、语言切换、Dashboard 指标 9/2/1/0、9 行漏洞、资产页 1 行、其它页面挂载、0 console.error |
| 真实页面离屏巡视 | 临时探针（已移除） | **7 页面 0 错误**：dashboard/internal/nebula/assets/snapshots/mcp/retest 全部渲染；**nebula canvas=1**；internal 5 行表、assets 1 行、snapshots 1 行、mcp 7 行 |
| 真实 API | `node scripts/verify-cortex-api.mjs` | **25 / 25**：rev/stats/vulns(13)/detail/assets(1)/asset detail interfaces/snapshots/db·app info/graph(30/51)/internal projects·overview（无 secret） |
| 安装 | `plugin_manager install_bundle` | `application:"applied"`；slot occupant `dsh-cortex/cortex(5, active)`；profile `link:` 依赖 |
| 卸载/重装（最终版复验） | `remove_bundle` → `install_bundle` | 卸载后：profile `dependencies` 恢复原状（无 `dsh-cortex`）、bundles 列表移除、`cordis.patch.yml` 无残留、`/cortex-api/cortex/rev` → 404；重装后：`applied`、live API 25/25、client bundle 3,570,002 B 正常下发、slot active |
| 热更新 | `client-hmr` | 重建 client.js → 页面收到 `rebuilt frame` 并热替换（已实测） |
| 2026-11-07 反馈修复（真实页面离屏探针） | — | 漏洞列表 9 行真实数据（`all` 过滤修复）；无 `<aside>`、仅 1 个 header；顶部卡片行 48px、7 导航；语言切换位于行右端（x 1848–1908）；`data.db` 卡片已移除；详情抽屉可滚动区 1194>897 且无 scroll-lock；`.markdown-body` 12.5px/21.25 行高 + 行内码底色恢复；0 console 错误 |

### 2026-11-07 第二轮反馈修复（字体 / 全屏 / MCP）

5. **字体与桌面版差异大（UI 字体 + 代码字体）**：`@font-face` 规则打包在 Shadow DOM 样式表里，
   Chromium **不会**把它们注册进文档字体集（实测 `document.fonts` 无 face、`Inter Variable`
   文本宽度等于 Segoe UI 回退宽度）。修复：构建时把 `@font-face` 抽出，插件 `apply` 时注入
   `document.head`（文档级字体对 Shadow 内容同样生效），卸载时移除。
   实测：head 字体样式 13 个 face、Inter/JetBrains 各 `load()` 成功；宽度 Inter 130.09 vs
   Segoe 122.28、JetBrains 115.2 vs Consolas 105.56 → 真正加载。
6. **星云全屏按钮无法退出（初版尝试，已被第 9 条取代）**：`document.fullscreenElement` 在 Shadow DOM 下可能
   不是 section 元素，原逻辑按引用相等判断导致第二次点击又发 `requestFullscreen`。改为“有全屏元素即退出”
   后仍受宿主接管影响，最终改用页内全屏覆盖层（第 9 条）。
7. **移除 MCP 接入**：导航项、Dashboard 空态入口与页面路由全部删除（插件直接读 SQLite，不需要 MCP）；
   顶部卡片行现为 6 项，左侧历史实体不再出现。实测 `navCount=6`、`hasMcpEntry=false`。
8. **星云默认旋转恢复**：motion 开关此前持久化到 `cortex.nebula.motion`，历史 "off" 值会让默认不旋转；
   改用 `cortex.nebula.motion.v2` 新键（默认 ON）。原逻辑里交互（含点节点）后 4s 自动恢复旋转。
   实测 `motion-toggle aria-pressed=true`、新键为空（默认开）。
9. **星云全屏最终方案**：内嵌 DSH 视图里 Browser Fullscreen API 的退出被宿主接管，改用**页面内全屏覆盖层**
   （`section[data-dsh-fullscreen]` → fixed inset-0，z-index 拉高）+ Esc/再次点击恢复；进入全屏时自动收起
   左侧命令栏，并把工具栏移到**右下角**（避开 DSH/Electron 原生窗口按钮所在的右上角，保证退出按钮可点）。
   实测：`relative → fixed(0,0,1920×1032) → relative`；全屏态 `aria-hidden=true`、工具栏 right 1902/bottom 1014。
13. **全屏"看起来不对"**：旧页面仍缓存了原生 Fullscreen API 版本（左侧命令栏展开即旧构建特征）。刷新页面后
   即为第 9 条的页内覆盖层：默认收起左栏、覆盖内容区、右下角可退出；DSH 原生窗口按钮/任务栏属于
   Electron 外壳，插件无法覆盖（若需要真正的系统全屏请用 DSH/系统快捷键）。
10. **漏洞复测页加载不到漏洞**：Retest 页请求 `pageSize=200`，而 cortex `/vulns` 沿用了旧路由 100 的上限 →
    400 `pageSize must be between 1 and 100`。修复：cortex 路由上限提高到 500（旧 DSH 风格路由仍保持 100）；
    实测 retest 页真实列出 9 条 Web 漏洞，无错误。
11. **星云左侧命令栏默认缩回**：`hudCollapsed` 初始值改为 `true`；实测 `aria-hidden=true`、`transform` 位移
    -328px（完全滑出画布），需要时点左侧箭头展开。
12. **对话内非 MCP 访问**：Host 通过 `ctx.tools.register` 注册 10 个 Agent 工具（漏洞列表/详情/状态更新/
    复测追加/资产/快照/内网/星云摘要），对话不再依赖 MCP。单测 7/7；本地用真实入口注册到 fake registry
    验证 10 个工具；对运行中 DSH 的 `/cortex-api/cortex/**` 做非 MCP 读写验证 **14/14**（含真实状态修改
    后恢复、资产/快照/内网/星云读取）。运行 `node scripts/verify-agent-access.mjs` 可复验。

1. **漏洞列表加载失败**（`severity must be one of …`）：原 UI 用字面量 `all` 表示不过滤，
   Host 枚举校验拒绝 → `/cortex/vulns`、`/cortex/assets` 现接受 `severity/status=all` 等同缺省。
2. **Markdown 排版与桌面端差异大**：打包漏掉原 `renderer/index.css`（`.markdown-body` 全部排版），
   Tailwind 入口已改为该文件；实测标题/列表/表格/行内码/代码块样式恢复。
3. **漏洞详情无法滚轮滚动**：Radix Dialog modal 滚动锁在 Shadow DOM 下拦截滚轮（事件 target 被重定向），
   Sheet 改为非 modal（保留 Esc/遮罩关闭），实测抽屉可滚动且无 `body` scroll-lock。
4. **左侧出现两组卡片**（DSH 对话卡 + 插件侧栏卡）：删除插件内 236px 侧栏、Cortex 品牌与标题栏、
   data.db 卡片；改为顶部一行横向导航卡（原 6 项图标/顺序/激活色）+ 右端中英文切换；原 MCP 页移除。
| 只读保护 | graph/nebula 测试 | live DB 仅 readOnly 连接；测试全部使用临时 fixture；未做真实库破坏性写 |

## 5. 与原桌面端的差异清单（诚实）

**一致**：侧栏（236px、品牌区、7 导航项与图标、语言/数据库脚注）、Titlebar 品牌行、
Dashboard（指标条、漏洞/内网看板、严重度分布、漏洞表）、资产页、内网页、快照页、MCP 页、
复测页、**记忆星云页面与 3D 启动**、中文 i18n、Tailwind token/间距/阴影。

**有意差异**（沿用原 `ctx web` 运行时行为）：
- 无窗口最小化/最大化/关闭按钮（DSH 内本就没有 frameless 窗口）；数据库选择器为只读展示；
- AI 配置页隐藏（原 Web 运行时同样隐藏）；`ctx init` 等桌面安装动作在 MCP 页显示原始 Web 提示。
- Sonner toast → 等价 Shadow DOM toast 兼容层（视觉接近，非逐像素）；
- Radix 弹层容器指向 Shadow root（视觉一致，DOM 位置不同）。

**限制**：
- 无浏览器控制能力 → 无截图级像素比对；以「真实页面离屏挂载巡视 + jsdom 结构断言」替代；
- jsdom 无 WebGL2，Nebula 在 jsdom 中只断言路由/打包内容（真实页面已实测 canvas 渲染）；
- 删除/归档/导出等写操作按原 UI 实现并在 fixture 上测试，真实库未做破坏性操作；
- `npm publish` 未执行（需用户账号）；本机以 link 安装验证，发布后 `dsh plugin add dsh-cortex` 可一键安装。

## 6. 文件清单（新增/变更）

```
src/cortex-ui/            原 UI vendor（renderer 98 + shared + graph builder）
src/cortex-ui/dsh/        entry.tsx / portal.ts / api.ts / sonner-shim.tsx / css-*.css / wrapper.template.js / tailwind config
src/host/cortex/          index.js vulns.js assets.js snapshots.js misc.js repeater.js graph.js internal.js
                          graph-adapter.js graph-builder.js(生成) shared/*(生成)
scripts/                  build-cortex-ui.mjs build-host-graph.mjs smoke-cortex-ui.mjs verify-cortex-api.mjs
                          watch-events.mjs verify-live.mjs
test/                     host/{...,cortex-api.test.mjs,cortex-nebula.test.mjs} client/{cortex-ui,shell}.test.mjs manifest.test.mjs
docs/                     cortex-ui-port.md implementation-report.md dsh-api-confirmed.md archive/(旧 DSH 风格文档)
旧 DSH 风格实现           已移出仓库到 C:\Users\slg13\Desktop\dsh-cortex-legacy-ui（不参与构建/测试/发布）
```
