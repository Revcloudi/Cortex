# UI kit / shared client helpers（Lead 维护，页面作者只读使用）

所有模块通过 `require('../ui/kit.js')` 等相对路径引入（构建脚本打包，禁止 import DSH 包）。

## `ui/kit.js`

`h`（= `React.createElement`）、`React`、`cx(...classes)`。

- `Icon({name, size})`：16px 线性图标。name ∈ refresh/settings/search/close/chevron-right/chevron-down/warning/database/external/check/play/download/arrow-left/shield/server/network/layers。
- `Button({children, onClick, variant:'secondary'|'primary'|'ghost'|'danger', size:'sm', icon, disabled, title})`
- `IconButton({icon, title, onClick, 'aria-label'})`
- `Badge({tone:'neutral'|'brand'|'success'|'warn'|'error'|'idle', children, title})`
- `severityTone(severity)` / `statusTone(status)` / `realmTone(realm)` / `sevBadge(sev)` / `statusBadge(status)`
- `Card({title, subtitle, actions, children, flush, style, className})`
- `Section({title, subtitle, actions, children})`（无边框分组）
- `Toolbar({children, right})`
- `Spinner({label})` / `Empty({icon,title,hint,action})`
- `ErrorBox({error, t, onRetry, retryLabel})`、`describeError(error, t)`
- `Field({label, hint, children})` / `Input({value,onChange,placeholder,onKeyDown,type})` / `Select({value,onChange,options:[{value,label}],'aria-label'})`
- `DataTable({columns, rows, rowKey, onRowActivate, activeKey, empty, dense, ariaLabel, footer})`
  - column：`{key, label, width, align:'left'|'right', render(row,index), cellStyle, title}`
- `Split({list, detail, emptyDetail, breakpoint})`：宽屏左列表右详情，窄屏上下。
- `useIsNarrow(px)`：响应式布尔。
- `Tabs({items:[{id,label}], value, onChange, ariaLabel})`（方向键可用；本页内部的二级 tab 可用）
- `Pager({page, pages, total, pageSize, onPage, onPageSize, t})`
- `Modal({open, title, onClose, children, footer, closeLabel})`（Escape/焦点陷阱；不要 portal 到 body）
- `KeyValue({items:[[k,v],...], style})` / `Mono({children})` / `Pre({children})`

## `ui/markdown.js`

`Markdown({text, className, empty})`：安全渲染 Markdown（标题/段落/粗斜体/行内码/链接/有序无序列表/引用/表格/```代码块/分隔线），纯 React 元素，无 `dangerouslySetInnerHTML`。

## `lib/api.js`

`createApi()`（shell 已创建并作为 `props.api` 传入，页面不要自己 new）：
`api.get(path, query)` / `api.getText(path, query)` / `api.patch(path, body)` / `api.post(path, body)`；失败抛 `ApiError {status, code, message, details, retryable}`。
错误 code → 文案映射已在 `ErrorBox` 里处理；页面直接 `h(ErrorBox,{error:err, t, onRetry})`。

## `lib/format.js`

`fmtTime(iso, locale)` / `fmtDate` / `fmtRelative` / `bytes` / `truncate` / `asArray` / `asObject` / `prettifyKey` / `plural` / `joinMeta`。

## `lib/httpparse.js`

`parseHttpSteps(markdown, baseUrl)` → `[{index,title,method,url,target,headers,body,raw}]`；
`requestHeadersForSend(headers)`；`parseHttpBlock(raw, baseUrl)`。

## 样式约定

- 只用 `styles.js` 里的 `.dshc-*` class 与主题 token；不要新增全局 CSS，也不要写死颜色。
- 常用组合 class：`dshc-grid dshc-grid-4`、`dshc-grid dshc-grid-2`、`dshc-col`、`dshc-flex`、`dshc-flex-between`、`dshc-toolbar`、`dshc-muted`、`dshc-small`、`dshc-mono`、`dshc-break`、`dshc-nowrap`、`dshc-clamp2`、`dshc-card-body-flush`。
- 指标卡用 `h('div',{className:'dshc-metric'}, h('div',{className:'dshc-metric-value'}, n), h('div',{className:'dshc-metric-label'}, label))` 包在 `Card` 里。
