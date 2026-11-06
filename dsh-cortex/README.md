# Cortex for DeepSeek Harness

在 DeepSeek Harness 内使用原版 **Cortex** 工作台：漏洞看板、内网作战、记忆星云图谱、资产库、认知快照与漏洞复测，
并内置 **12 个原生 Agent 工具**（`cortex_*`），直接读写本地 Cortex SQLite（schema v5），不需要 MCP。

## 安装

DSH 插件市场搜索 **`@lievclouds/dsh-cortex`** 安装；或直接执行：

```text
dsh plugin --profile desktop add @lievclouds/dsh-cortex   # 从 npm 安装
dsh plugin --profile desktop add ./dsh-cortex             # 本仓库本地开发
```

安装后刷新页面，DSH 左侧面板会出现 Cortex 图标。

## 环境要求

- DeepSeek Harness ≥ 0.2.2-rc.1
- Node.js ≥ 22.19（DSH 桌面端已内置）
- Cortex 数据库 schema v5（默认 `~/.cortex/data.db`，只读打开、不迁移）

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CORTEX_DB_PATH` | `~/.cortex/data.db` | Cortex SQLite 路径（可指向副本） |
| `CORTEX_DB_READONLY` | 未设置 | 设为 `1` 强制只读 |

## 对话内使用

插件会自动注册 12 个 `cortex_*` 工具并注入简短使用说明，直接用自然语言即可，例如：

- `列出 Cortex 里的高危漏洞`
- `把刚才确认的漏洞写入 Cortex`
- `把 VULN-… 标记为已确认并追加复测结论`

## 更多

安装细节、架构、安全模型与开发说明见 Cortex 仓库：
<https://github.com/Revcloudi/Cortex>
