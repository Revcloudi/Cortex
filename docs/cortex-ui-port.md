# Cortex 原 UI → DSH 插件移植（最终版）

本文件记录「1:1 移植原 Cortex 渲染层（含知识星云）」的架构、平台适配、构建与验收。
完整交付报告见 [implementation-report.md](./implementation-report.md)。

## 目标（用户指定）

> 「完全不行，还不如直接按照原 UI 进行修改，先按照原 UI 进行一模一样的移植吧」+「包括知识星云模块」

因此：**复用原 Cortex 渲染层源码**，不做 DSH 风格重设计；只把数据层从 Electron IPC /
Cortex Web 换成插件 Host 的 `/cortex-api/cortex/**`。

## 目录

```
src/cortex-ui/renderer/    原 src/renderer/src 的逐字副本（98 文件：App/pages/components/nebula/i18n/assets）
src/cortex-ui/shared/      原 src/shared 的逐字副本（types/graph/internal/poc/repeater/web）
src/cortex-ui/graph/       原 src/core/graph/buildMemoryGraph.ts（逐字副本）
src/cortex-ui/dsh/         平台适配层（本插件新增）
src/cortex-ui/shims/       react / react-jsx-runtime shim（DSH 平台 React 18.3.1）
src/cortex-ui/tailwind.config.cjs
src/host/cortex/           插件 Host 的 CortexApi 兼容层 + Nebula 图适配器
```

## 与原渲染层的差异（5 处 + 新增适配层）

1. `renderer/lib/transport/index.ts`：`getApi()` 返回插件 `createCortexApi()`；`IS_WEB_RUNTIME=true`。
2. `renderer/components/ui/sheet.tsx`：`SheetPortal` 传入 `getPortalContainer()`；**Sheet 改为非 modal**
   （Radix 的 modal 滚动锁监听外层 document，跨 Shadow DOM 后事件 target 被重定向，会拦截滚轮；
   非 modal 保留 Esc/遮罩关闭，滚轮恢复原生滚动）。
3. `renderer/components/ui/select.tsx`：`SelectPrimitive.Portal` 传入 `getPortalContainer()`。
4. `renderer/components/ui/tooltip.tsx`：`TooltipPrimitive.Portal` 传入 `getPortalContainer()`。
5. `renderer/App.tsx`：外壳组合调整 —— 去掉 frameless 窗口 Titlebar 与本插件自己的 236px 侧栏，
   改为单个横向卡片行 `dsh/TopNav.tsx`（6 个导航项的图标/顺序/激活色/中英文切换）；
   数据库卡片与 **MCP 接入页**删除（插件不需要 MCP）。
6. `renderer/pages/NebulaPage.tsx`：全屏切换改为按 `document.fullscreenElement !== null` 判断
   （Shadow DOM 下引用相等不可靠，否则二次点击无法退出全屏）。
7. 字体注入：构建时把 `@font-face` 从面板 CSS 抽出，`apply()` 注入 `document.head`
   （Chromium 不加载 Shadow DOM 样式表里的 @font-face），卸载时移除。

其余均为新增：`dsh/{TopNav.tsx,entry.tsx,portal.ts,api.ts,sonner-shim.tsx,css-overrides.css,css-entry.css,wrapper.template.js}`、
`shims/{react.cjs,jsx-runtime.cjs,jsx-dev-runtime.cjs}`、`tailwind.config.cjs`。

## 2026-11-07 用户反馈修复

| 反馈 | 根因 | 修复 |
|---|---|---|
| 漏洞列表报 `severity must be one of …` | 原 UI 用字面量 `all` 表示"不过滤"，Host 严格枚举校验拒绝 | `/cortex/vulns` 与 `/cortex/assets` 接受 `severity/status=all`（等同缺省），非法值仍 400 |
| Markdown 排版与桌面端差很多 | 打包时漏掉原 `renderer/index.css`（`.markdown-body` 标题/列表/表格/行内码/代码块/动画等全在这里） | Tailwind 入口改为原 `renderer/index.css`；实测 `.markdown-body` 12.5px/21.25 行高、行内码底色恢复 |
| 漏洞详情无法滚轮上下滑动 | Radix Dialog 的 modal 滚动锁在 Shadow DOM 下无法识别滚轮目标 | Sheet 改非 modal；实测 drawer 可滚动区 1194 > 897、`body` 无 scroll-lock、`scrollTop` 可写 |
| 左侧出现两组卡片（DSH 对话卡 + 插件侧栏卡） | 移植保留原 236px 侧栏，与 DSH 左侧栏重复 | 删除插件内 236px 侧栏/品牌/标题栏，改为顶部一行横向导航卡（6 项）+ 右端语言切换；删除 data.db 卡片与 MCP 页 |
| 字体/代码字体与桌面版差距大 | Chromium 不加载 Shadow DOM 样式表里的 @font-face | 构建抽出 13 个 face，`apply()` 注入 document.head；实测 Inter/JetBrains 均加载 |
| 星云全屏按钮无法退出 | 内嵌 DSH 视图里 Browser Fullscreen API 的退出由宿主接管 | 改为页面内全屏覆盖层（`section[data-dsh-fullscreen]` fixed inset-0）+ Esc 恢复；探针验证 relative → fixed → relative |
| 星云默认不旋转 / 选节点后不恢复 | 旧版 motion 开关持久化键可能残留 "off" | 换 `cortex.nebula.motion.v2` 键，默认 ON；交互后 4s 恢复旋转（原逻辑） |
| 星云左侧命令栏初始展开 | 原页面默认展开 | 默认缩回（`hudCollapsed=true`，实测 `aria-hidden=true`、位移 -328px），可手动展开 |
| 漏洞复测页加载不到漏洞 | Retest 页请求 pageSize=200，cortex `/vulns` 上限仍为旧路由的 100 | cortex 路由上限提高到 500（旧路由不变）；实测列出 9 条 Web 漏洞 |
| 对话内非 MCP 访问 | 插件未注册 Agent 工具 | Host 注册 10 个 `cortex_*` 工具（列表/详情/状态/复测追加/资产/快照/内网/星云摘要）；非 MCP 读写验证 14/14 |


## 运行时结构

```
DSH main slot (key=cortex)
  └─ CortexPanel（wrapper.template.js，平台 React 18.3.1）
       └─ host.attachShadow() → <style>{Tailwind 全量 CSS（字体已内联）}</style>
            └─ .dshc-cortex-root → ReactDOM.createRoot（内置 react-dom@18.3.1）→ 原 Cortex <App/>
                  ├─ TopNav（DSH 适配：7 个横向导航卡 + 右端中英文切换，替代原 236px 侧栏）
                  └─ main（原页面：漏洞看板/内网作战/记忆星云/资产库/认知快照/MCP/复测）
                       └─ lib/transport → fetch('/cortex-api/cortex/**') → Host 插件
```

- 平台 React 18.3.1 由 `require('react')` 注入 `globalThis.__DSH_CORTEX_REACT__`，所有 vendor 模块经
  `shims/react.cjs` 共享同一实例；`react-dom` / JSX runtime 由 bundle 自带并 shim 到该实例。
- Shadow DOM 保证原 Tailwind（含 preflight）不会污染 DSH 外壳；Radix 弹层、Sonner toast 均在 Shadow 内。
- `client-hmr` 对链接安装的 `client.js` 做 stat-poll，重建后浏览器端自动热替换（已实测）。

## 构建

```powershell
node scripts/build-host-graph.mjs   # 原 buildMemoryGraph.ts → src/host/cortex/graph-builder.js（ESM, zod 已打包）
node scripts/build-cortex-ui.mjs    # Tailwind + esbuild → client.js（约 3.49 MiB，含 three/force-graph/字体）
npm test                            # node --test（195 用例）
npm run smoke                       # jsdom 忠实度 18 项
node scripts/verify-cortex-api.mjs  # 对运行中的 DSH 实测 /cortex-api/cortex/**（25 项）
```

## 数据层

- 原 DSH 风格 REST（`/cortex-api/health|stats|vulns|...`）保留以兼容旧脚本与测试。
- 新增 `/cortex-api/cortex/**`：严格返回 `src/cortex-ui/shared/*` 中声明的原类型 JSON。
  端点与 `src/cortex-ui/dsh/api.ts` 的方法一一对应（vulns/stats/assets/snapshots/internal/loot/graph/
  db·app info/poc stub/repeater send/rev）。
- 记忆星云：`graph-adapter.js` 用 `node:sqlite` 实现原 `DatabaseService` 中被 `buildMemoryGraph.ts`
  调用的 16 个只读方法；`graph.js` 校验 `MemoryGraphQuery` 后调用原构建器。
- 安全：loopback peer+Host 栅栏、写操作同源校验、凭据 `secret` 永不回传、无 CORS、错误信封统一。

## 验收证据（2026-11-06）

- `node --test`：**195/195**；`npm run smoke`：**18/18**；`verify-cortex-api`：**25/25**。
- 真实 DSH 页面离屏巡视（临时探针，交付前已移除）：236px 侧栏、7 导航（含「记忆星云」）、
  Titlebar、Dashboard/内网/星云/资产/快照/MCP/复测 **7 页面全部渲染，0 错误**，
  **nebula canvas=1（WebGL2）**。
- 真实库 Nebula 图：all/web 26 nodes/47 links，all/all **30/51**，internal 4/0；只读连接，库未被修改。

## 已知限制

1. 无浏览器控制 → 无截图级像素比对（以真实页面离屏挂载 + jsdom 结构断言替代）。
2. jsdom 无 WebGL2 → Nebula 在单测中只验证懒加载/打包；真实页面已实测 canvas 渲染。
3. 删除/归档/导出等写操作按原 UI 实现但只在 fixture 上验证，未对真实库做破坏性操作。
4. AI 配置页按原 Web 运行时逻辑隐藏；桌面窗口按钮隐藏；数据库选择器只读。
5. 未执行 `npm publish`。
