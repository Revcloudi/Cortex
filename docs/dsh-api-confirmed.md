# 已确认的 DSH API 清单（2026-11-06，实测自本机 DSH，禁止凭记忆改）

> 依据：`cordis-plugin-development` 技能 + `cordis_inspect_query`（host Service / client Slots / Theme / Builtin）+ 已安装真实插件
> `dsh-src-ledger`（`C:\Users\slg13\Desktop\AI\System\dsh-src-ledger`）的源码验证 + `resources\app.asar` 内包版本。

## 运行环境

| 项 | 值 | 验证方式 |
|---|---|---|
| DSH 版本 | `0.2.2-rc.1`（desktop shell 同版本） | `app.asar/package.json`、`app.asar/dsh/package.json` |
| Host Node | `24.21.0`（`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`） | 直接执行 `--version` |
| `node:sqlite` | **可用**，`DatabaseSync` / `StatementSync` 存在 | 用该 node.exe 实测 `require('node:sqlite')` |
| Cordis | `@deepseek-ai/cordis 4.1.0` | dsh 运行时 package.json |
| Web GUI | `http://127.0.0.1:63877`（本机 loopback） | runtime context |
| 当前 profile | `desktop`（`$DSH_PROFILE_DIR=C:\Users\slg13\.dsh\profiles\desktop`） | 环境变量 |
| Cortex DB | `C:\Users\slg13\.cortex\data.db`，`PRAGMA user_version=5`，`journal_mode=wal` | `recon/inspect-db.mjs` 只读实测 |

## Host 半边（已确认）

1. 插件入口导出（三选一，采用 apply 形式）：
   ```js
   export const name = 'dsh-cortex'          // 或与包名不同也可以，但保持 'dsh-cortex'
   export const inject = ['webServer']       // 硬依赖；也可不声明而在 apply 内 ctx.inject([...]) 
   export function apply(ctx, config) {}
   ```
2. 可选注入 + 生命周期（真实插件 `dsh-src-ledger/lib/web.js` 的写法）：
   ```js
   ctx.inject(['webServer'], (web) => {
     ctx.effect(() => {
       const dispose = web.webServer.register({ kind: 'prefix', path: '/cortex-api', handler: (req, res) => {} })
       return () => dispose()
     }, 'dsh-cortex: /cortex-api')
   })
   ```
3. `webServer.register(route)` 签名（inspect `Service.webServer`）：
   - `{ kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`
   - 返回 disposer；重复 `(kind,path)` 会 throw。
   - **handler 是原生 Node HTTP**（`req.headers`、`req.socket.remoteAddress`），不是 WHATWG Request/Response。
4. 其它可用 Host 服务：`webServer.getOrigin()`、`ctx.get(name)`、`ctx.effect(fn, label)`。
5. `Config` schema 需 `@deepseek-ai/schemastery`（真实插件如此），但该包不在 profile `node_modules`，由 DSH loader 解析。**v1 不导出 Config**（降低风险），配置走环境变量 + 行内 `config` 透传（若 loader 允许）。
6. 安装：`plugin_manager action=install_bundle target=<包绝对目录>`（本机 → 链接安装）；不要手写 profile 的 package.json / cordis.patch.yml。

## Client 半边（已确认）

模块格式（真实插件 `dsh-src-ledger/lib/client.js` 验证）：
```js
window.__ModuleLoader__.load({
  id: 'dsh-cortex',                       // 必须等于包名
  factory: (require) => {
    const react = require('react')        // 唯一可 require 的运行时（浏览器模块表）
    const h = react.createElement
    // ...模块代码/自研 bundle...
    return module.exports                 // { name, inject: ['slots','locale'], apply(ctx) }
  },
})
```
- 可用 builtins（inspect `Builtin.listBuiltins`）：`ctx`（Restricted Cordis Context：`get/on/provide/effect`）、`React`、`host.call`（包私有 RPC，本插件不用）、`styles.insert(css)`、`console.*`。**禁止 require 任何 DSH Client 包**（React 除外）。

### slot 注册（inspect `Slots.listSubTree`，2026-11-06 实测）

- `sidebar.panellist`（list, root）registration：`{ name:'sidebar.panellist', id:'cortex', order?: number, label?: string|(()=>string) }`
  - ownerProps：`{ size: number, active: boolean }`（图标组件 props）
  - 现有 occupant：`plugins` order 0、`schedules` order 10 → 本插件取 `order: 5`
  - id 同时是 main 面板的寻址键（“Each list id addresses the matching main panel”）
- `main`（keyed, root）registration：`{ name:'main', key:'cortex' }`；ownerProps 为空，另有 standardProps 钩子（`useRemoteAccess` 等，本插件不用）
- 注册写法：
  ```js
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: 'cortex', order: 5, label: () => t('panel.title') }, CortexPanelIcon))
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: 'cortex' }, CortexPage))
  ```
  `ctx.slots.inject(ownerKey, cb)` 的注册随声明生命周期自动释放；插件卸载时 ctx effect 级联释放。**不要写 DOM、不要替换 root**。
- 建议 `ctx.slots.register` 用 try/catch guard（真实插件做法），避免 slot entry crash 白屏。

### Theme（inspect `Theme.listTokens`，只允许用这些 CSS 变量）

`--dsw-alias-bg-base` `--dsw-alias-bg-layer-1` `--dsw-alias-bg-layer-2` `--dsw-alias-bg-overlay`
`--dsw-alias-border-l1` `--dsw-alias-border-l2` `--dsw-alias-brand-primary`
`--dsw-alias-label-primary` `--dsw-alias-label-secondary`
`--dsw-alias-state-error-primary` `--dsw-alias-state-idle-primary` `--dsw-alias-state-success-primary` `--dsw-alias-state-warn-primary`
`--dsw-specific-sidebar-fill`
（均需 light/dark 双值，用 `var(...)` 自动适配，禁止写死颜色。）

### Locale（inspect client `Service.locale`）

- 基线 locale id：**`["zh", "en"]`**（`@deepseek-ai/dsh-client-locale/lib/index.js` 的 `LOCALE_IDS`）。
- 注册：`ctx.locale.register(ns: string, locale: string, dict: Record<string,string>)`（untyped 单 locale 形式，返回 disposer）；或 `ctx.locale.register(ns, { zh: {...}, en: {...} })`。
- 读取：`ctx.locale.getLocale(): { active, locales, revision }`；`ctx.locale.subscribe(fn)`；`ctx.locale.bind(ns)` 返回按 key 翻译的函数（active locale 在调用时读取）。
- UI 文案必须走 locale 服务；中文/英文都要有。

## Cortex DB（只读实测，schema v5）

- 表：`vulnerabilities` `assets` `internal_hosts` `internal_services` `footholds` `foothold_hosts` `pivots` `pivot_hops` `pivot_reachability` `credentials` `credential_trials` `snapshot_sessions` `loot_imports`
- 关键列见 `recon/inspect-db.mjs` 输出 / 本文附录。时间均为 ISO 字符串；JSON 列是 TEXT，需安全 parse。
- 真实数据：13 条漏洞（web 9 / internal 4）、1 条 asset、1 条 snapshot；`internal_*`、`credentials`、`pivots` 当前为空（UI 需空态）。

## 本机已安装真实插件可作参考（不是 Cortex 仓库）

- `C:\Users\slg13\Desktop\AI\System\dsh-src-ledger`（profile 里有 junction；当前未在 patch 中启用）
  - `package.json`（bundle patch + dsh.client + exports/files 完整示例）
  - `lib/web.js`（webServer.register + loopback fence 的**当前版本正确写法**）
  - `lib/client.js`（`window.__ModuleLoader__.load` + slots 注册的**当前版本正确写法**）

## 附录：安装后实测确认（2026-11-06 21:14–21:22，本机 DSH 0.2.2-rc.1）

以下为**运行时真实观测**（均已纳入实现；详见 `docs/implementation-report.md` §8）：

1. **安装结果**：`plugin_manager install_bundle target="C:\Users\slg13\Desktop\dsh-cortex"`
   → `{"stage":"enable","target":"dsh-cortex","enabled":true,"application":"applied","warnings":[]}`；
   profile 记录 `"dsh-cortex": "link:C:/Users/slg13/Desktop/dsh-cortex"`，bundles 追加 `dsh-cortex`。
2. **slot 落地**：`sidebar.panellist` occupants 实际为
   `[tk:plugins(order 0), dsh-cortex:cortex(order 5, active), tk:schedules(order 10)]`；
   `main` occupants 增加 `dsh-cortex: key=cortex (active=true)`。
3. **Host 路由**：`GET /cortex-api/health` → 200，`schemaVersion:5`、`compatible:true`、`sqlite:true`、
   `dbFile:"data.db"`、`loopbackOnly:true`；安装前/卸载后同路径 404。
4. **浏览器产物**：`/plugins/events` SSE graph 条目
   `{id:"dsh-cortex", rev:"a8a45f48f7ba", url:"plugins/??dsh-cortex/client.js&rev=a8a45f48f7ba",
   inject:["@deepseek-ai/dsh-client-ui-sidebar","@deepseek-ai/dsh-client-locale"]}`；
   `GET` 该 url → 200、233,703 B（= 本地构建 233,636 B + 67 B sourceMappingURL），含最终页面代码。
5. **客户端热更新链路**：重建 `client.js` 后，SSE 实际收到
   `rebuilt frame: id=dsh-cortex rev=<new>`；随后 graph 条目 rev 更新。结论：链接安装下修 client 半
   可被 `dsh-client-hmr` 自动热替换，无需页面刷新；Host 半改动需 recomposition/DSH 重载。
6. **卸载干净**：`remove_bundle` → `applied`；profile 的 `dependencies`/`dsh.profile.bundles` 均恢复原状，
   `cordis.patch.yml` 无 `dsh-cortex`，路由 404，重装后再次 `applied` 且 44/44 e2e 通过。
   （浏览器内已加载的插件实例在 DSH 下一次 graph revision 时移除；属 DSH 生命周期，非 profile 残留。）
7. **`node --test <dir>` 不可用**：Node 24.21.0 把位置参数当 glob，无目录递归。正确形式：
   `node --test`（默认递归发现）或 `node --test "test/host/**/*.test.mjs"`；package.json scripts 已按此修正。
