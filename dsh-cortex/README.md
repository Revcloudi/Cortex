# Cortex for DeepSeek Harness

在 DeepSeek Harness 内使用原版 Cortex 工作台：漏洞看板、内网作战、记忆星云图谱、资产库、认知快照、漏洞复测、Web Fuzzer 与小程序逆向（wxapkg 检测/解密/解包/分析/资产入库），内置 22 个 `cortex_*` Agent 工具，无需 MCP。

## 1.3.0 新增

- **客户端漏洞独立**：`client_type=android|ios|desktop`、`client_connection=usb|ssh|remote|emulator|wifi`；新增“客户端漏洞”页签。客户端漏洞不进入复测页面和记忆星图；USB/SSH 测试机连接记录为客户端上下文，不写入内网作战。
- **内网实体清理**：内网作战新增主机、服务、foothold、凭据、代理的逐条删除（带确认，级联清理依赖实体）。
- **资产系统名**：资产库主列改为“系统名”，可在资产详情编辑；项目名只用于关联/筛选，不再是主展示名称。小程序继续按 appid 独立成资产。
- **移除脱敏**：漏洞详情、资产泄露信息、凭据、Loot、导出、POC 文本均返回/写出原始值；CSV 仍保留公式注入转义。本地优先使用，请自行控制导出文件与日志的保存位置。
- **项目 / 选中资产导出**：`cortex.export/v1` JSON、CSV、DefectDojo Generic Findings，可选 Markdown 证据文件；可写入用户选择的目录。
- **资产库多选**：复选列、全选当前筛选结果、批量导出与批量删除；删除只清理资产及 sidecar，漏洞记录保留。
- **独立 Web Fuzzer**：不再依赖漏洞记录，无目标漏洞选择器；原始请求编辑器即唯一入口，发送请求不携带 `vulnId`；Host 使用独立的公网目标 SSRF 策略。
- **响应渲染**：原始 / JSON / 渲染三视图；HTML 在 `sandbox=""` + CSP 的 iframe 中渲染，状态行和响应头保留。
- 数据库仍为 Cortex schema v5；新字段通过 additive `ALTER TABLE` 补充，不修改 `PRAGMA user_version`。

## 安装

```text
dsh plugin --profile desktop add @lievclouds/dsh-cortex   # 从 npm
dsh plugin --profile desktop add ./dsh-cortex             # 本地开发
```

要求 DeepSeek Harness ≥ 0.2.2-rc.1、Node.js ≥ 22.19，以及 Cortex schema v5 数据库（默认 `~/.cortex/data.db`，可用 `CORTEX_DB_PATH` 覆盖；`CORTEX_DB_READONLY=1` 为只读浏览）。

完整安装说明、安全模型、Agent 工具参考与架构见仓库根目录的 [README](https://github.com/Revcloudi/Cortex#dsh-plugin-recommended) 与 `docs/`。
