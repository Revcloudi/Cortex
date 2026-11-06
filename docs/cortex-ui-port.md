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

## 与原渲染层的唯一差异（4 处 + 新增适配层）

1. `renderer/lib/transport/index.ts`：`getApi()` 返回插件 `createCortexApi()`；`IS_WEB_RUNTIME=true`。
2. `renderer/components/ui/sheet.tsx`：`SheetPortal` 传入 `getPortalContainer()`。
3. `renderer/components/ui/select.tsx`：`SelectPrimitive.Portal` 传入 `getPortalContainer()`。
4. `renderer/components/ui/tooltip.tsx`：`TooltipPrimitive.Portal` 传入 `getPortalContainer()`。

其余均为新增：`dsh/{entry.tsx,portal.ts,api.ts,sonner-shim.tsx,css-overrides.css,css-entry.css,wrapper.template.js}`、
`shims/{react.cjs,jsx-runtime.cjs,jsx-dev-runtime.cjs}`、`tailwind.config.cjs`。

## 运行时结构

```
DSH main slot (key=cortex)
  └─ CortexPanel（wrapper.template.js，平台 React 18.3.1）
       └─ host.attachShadow() → <style>{Tailwind 全量 CSS（字体已内联）}</style>
            └─ .dshc-cortex-root → ReactDOM.createRoot（内置 react-dom@18.3.1）→ 原 Cortex <App/>
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
