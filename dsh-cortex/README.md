# Cortex for DeepSeek Harness

在 DeepSeek Harness 内使用原版 Cortex 工作台：漏洞看板、内网作战、记忆星云图谱、资产库、认知快照、漏洞复测、Web Fuzzer 与小程序逆向（wxapkg 检测/解密/解包/分析/资产入库），内置 22 个 `cortex_*` Agent 工具，无需 MCP。

## 1.2.0 新增

- **项目 / 选中资产导出**：`cortex.export/v1` JSON、CSV、DefectDojo Generic Findings；默认脱敏（泄露值、Cookie、Authorization、Token、密钥类字段），CSV 防注入，可选 Markdown 证据文件；可写入用户选择的目录。
- **资产库多选**：复选列、全选当前筛选结果、批量导出与批量删除；删除只清理资产及 `asset_meta / asset_domains / miniapp_versions / asset_vuln_links`，漏洞记录保留。
- **独立 Web Fuzzer**：不再依赖漏洞记录，删除目标漏洞选择器；原始请求编辑器即唯一入口，发送请求不携带 `vulnId`；Host 使用独立的公网目标 SSRF 策略（拒绝本机/内网/link-local/metadata，重定向逐跳复检）。
- **响应渲染**：原始 / JSON / 渲染三视图；HTML 在 `sandbox=""` + CSP 的 iframe 中渲染，脚本、事件属性与 `javascript:` URL 会被移除；非 HTML 文本用安全 `<pre>`，二进制显示不可渲染提示；三种视图都保留状态行与响应头。
- 每个小程序仍按 appid 独立成资产（无 appid 时用包哈希），域名是关联关系而不是资产身份；数据库仍为 Cortex schema v5，不修改 `PRAGMA user_version`。

## 安装

```text
dsh plugin --profile desktop add @lievclouds/dsh-cortex   # 从 npm
dsh plugin --profile desktop add ./dsh-cortex             # 本地开发
```

要求 DeepSeek Harness ≥ 0.2.2-rc.1、Node.js ≥ 22.19，以及 Cortex schema v5 数据库（默认 `~/.cortex/data.db`，可用 `CORTEX_DB_PATH` 覆盖；`CORTEX_DB_READONLY=1` 为只读浏览）。

完整安装说明、安全模型、Agent 工具参考与架构见仓库根目录的 [README](https://github.com/Revcloudi/Cortex#dsh-plugin-recommended) 与 `docs/`。
