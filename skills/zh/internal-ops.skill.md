---
name: internal-ops
description: 【硬性】Web 入口被拿下后用 sync_internal_scope 登记 foothold / 内网主机 / 服务 / 凭据 / pivot（schema v3）；内网漏洞仍走 save_vulnerability（realm="internal" + service_host + internal_service_id）；顺序为入口漏洞 → foothold → hosts/services → credentials → pivots；凭据脱敏、Loot 仅本地解析、Cortex 不主动扫描/登录/利用。
---

# 技能：内网作战域（Internal Operations）

Cortex 把 **Web 资产**（`assets`，`host_port` 是 URL）与**内网作战域**逻辑隔离：foothold、内网主机 / 服务 / 凭据 / pivot 有自己的实体与 ID，但**不作为顶层 Web 资产**。两者唯一的桥是 **Foothold**——入口 Web 资产 + 初始访问方式（RCE / webshell / SSRF 代理 / 凭据 / VPN）。主漏洞库默认只看 Web 漏洞（`realm='web'`），内网漏洞进入独立的「内网作战」页。

内网作战域通过 **1 个新 MCP 工具** `sync_internal_scope` 写入（Cortex 的 MCP 工具总数为 **7 个**），读取走 `query_asset_context` 的 `include_internal` / `include_credentials` 与 `query_vulnerabilities` 的 `realm` 过滤；内网漏洞仍走 `save_vulnerability`；Loot 只走 CLI / 桌面端本地解析。Cortex **不主动扫描、不自动登录、不自动利用**：热力图、凭据矩阵、路由图全部由 Agent 上报的数据派生。

## 硬性规则（MUST，优先级高于本技能其余内容）

1. **顺序固定**：`query_asset_context({ host_port })` 看已有上下文 → `save_vulnerability` 保存入口 RCE / 初始访问（`realm="web"`）→ `sync_internal_scope` 登记 foothold（带 `entry_vuln_id`）→ hosts（拿到 `IH-*`）→ services（用返回的 `IH-*` 作 `host_id`）→ credentials → pivots → 需要时再 `save_vulnerability` 写内网漏洞（`realm="internal"` + `service_host` + `internal_service_id`）。
2. **RCE ≠ 失陷**：入口 RCE 只是漏洞记录；必须再用 foothold 记录访问类型、权限级别、状态、证据与时间。没有 foothold 的内网实体没有归属。
3. **多入口、多路径**：同一个入口资产可以有多条 foothold（不同 access_type），同一台内网主机也可以被多个 foothold 到达；不要强制单一 parent。内网主机是 **project 级**实体，同 IP 只应有一条（按 `(project_name, ip)` 去重），新入口复用已有 `IH-*`，不要重复造主机。
4. **内网漏洞仍走 `save_vulnerability`**：`realm="internal"`；`host` 填**入口 Web 资产**（host 形式，把入口 `host_port` 去掉协议头/路径，如入口 `http://10.0.0.5:8080/` 传 `10.0.0.5:8080`）；`service_host` 填实际内网服务 `ip:port` 或人类可读标签；`internal_service_id` 填 `IS-*`。`realm="internal"` 时 `service_host` 或 `internal_service_id` 至少要有一个；`internal_service_id` 必须属于同一 project（不存在会报错并提示先 `sync_internal_scope`）。Web 漏洞 `realm` 省略或传 `"web"`。
5. **复测只追加**：内网漏洞复测同样用 `update_vulnerability({ vuln_id, retest: { time_range, conclusion } })`，禁止用 `save_vulnerability` 覆盖原始证据。
6. **Pivot 随隧道状态更新**：隧道建立 / 降级 / 断开都要 `sync_internal_scope` 更新同一条 pivot（带 `id`），保持 `status` 与 `local_endpoint` / `hops` / `reachable_subnets` 真实；路由视图完全依赖这份数据。路由数据不存代理密码 / 密钥。
7. **凭据高敏**：`secret` 只写不读——工具只返回脱敏的 `secret_preview` 与 `secret_length`，绝不返回原文；不要把 secret 写进 `notes` / `evidence` / 日志 / 对话；不要自动登录或爆破（`credential_trials` 由人工尝试后记录）。
8. **Loot 文件视为不可信输入**：只用 CLI `ctx loot import`（或桌面端「内网作战 → Loot」面板）本地解析；不执行文件内容、不联网、受限文件大小 / 条目数；解析结果写入同一套内网表，凭据以 `status: "untested"` 写入、导入记录标记 `needs_review`，复核后再当事实使用；原始文件只留文件名 / 哈希 / 摘要。
9. **`project_name` 与资产库 / 快照完全一致**：内网实体、入口资产、漏洞归属、快照使用同一个 `project_name`，否则内网页、热力图和记忆星云会分裂成多个项目。
10. **不猜测拓扑**：只登记 Agent 实际观察或通过授权手段取得的数据；扫描器原始输出先筛选再入库；不要用 `sync_internal_scope` 存 Web 资产（走 `sync_asset_info`）或漏洞（走 `save_vulnerability`）。
11. **MCP 不可用**（工具缺失 / `server is disconnected`）→ 先运行 `ctx doctor`，再重启 Agent（不是重启 GUI）；恢复后补录，禁止静默跳过。
12. **upsert 是整条记录覆盖，不是字段级 patch**：merge 模式下未传的字段会被默认值重写（例如 foothold 的 `privilege_level` / `status` / `evidence`、credential 的 `secret`、pivot 的 `hops` / `reachable_subnets` 都会被重置或清空）。更新任何实体前先用 `query_asset_context({ project_name, include_internal: true })`（或 `ctx internal hosts` / `ctx internal routes`）读现状，再把完整字段一起传回。

## 领域模型与 ID

| 实体 | ID 前缀 | 必须引用 | 去重 / 说明 |
| --- | --- | --- | --- |
| Foothold | `FH-` | 入口 Web 资产 `entry_host_port`（必须已 `sync_asset_info` 入库）；`entry_vuln_id` 可选但推荐 | 自然键 `(project_name, entry_host_port, access_type)`：同入口 + 同访问方式会合并更新，换 access_type / 换入口才新建；更新时带 `id` |
| Internal host | `IH-` | `project_name` | 自然键 `(project_name, ip)`；`ip` 只填 IPv4/IPv6 字面量，网段写 `subnet`（CIDR） |
| Internal service | `IS-` | `host_id`（`IH-*`） | 自然键 `(host_id, port, protocol)`；`port` 1–65535 |
| Credential | `CR-` | `project_name`；可关联 `host_id` / `service_id` | 自然键 `(project, type, username, domain, secret)`；`secret` 高敏，读取只返回脱敏预览 |
| Pivot | `PV-` | `foothold_id`（`FH-*`） | 自然键 `(foothold_id, kind, local_endpoint.host, local_endpoint.port)`；`hops` 引用同 project 的 `IH-*` / `IS-*`；`reachable_subnets` 用 CIDR |
| Loot import | `LT-` | 仅 CLI / 桌面端导入 | 只由 Loot 流程创建，MCP 不写 |

- 单 project 上限：hosts ≤300、services ≤1000、credentials ≤500、pivots ≤100、footholds ≤100；hops ≤20/路由，`reachable_subnets` ≤20/pivot；超限的视图返回 `truncated`。
- 单次调用上限：footholds ≤50、hosts ≤500、services ≤2000、credentials ≤500、pivots ≤100；超了分批调用。

## 何时调用 sync_internal_scope

- 初始访问确认后：RCE / webshell / SSRF 代理 / 可用凭据 / VPN 入口 → 先建 foothold；
- 发现新的内网主机、端口、服务 → 先 hosts，再 services（`host_id` 用返回的 `IH-*`）；
- 获得凭据（明文密码 / NTLM hash / NetNTLMv2 / Kerberos 票据 / SSH Key / 证书 / API Key）；
- 隧道建立、状态变化、断开（pivot `planned` → `established` → `degraded` → `lost`）；
- 入口状态变化（foothold 掉线、权限提升、新增第二条入口）；
- 需要显式删除错误录入的数据（`removed`）。

**不要调用**：未确认的猜测、扫描器原始结果未筛选、Web 资产 / 接口（走 `sync_asset_info`）、漏洞（走 `save_vulnerability`）、快照进度（走 `manage_snapshot`）。

## 推荐工作流（必看示例）

### 0. 入口：先看上下文，再存入口漏洞

```json
query_asset_context({ "host_port": "http://10.0.0.5:8080/" })
```

```json
save_vulnerability({
  "host": "10.0.0.5:8080",
  "vuln_name": "Jenkins Script Console RCE",
  "vuln_type": "RCE",
  "severity": "Critical",
  "target_url": "http://10.0.0.5:8080/script",
  "realm": "web",
  "reproduction_steps": "### 步骤 1：访问 script console 执行 id\n\n**请求**\n```http\nPOST /script HTTP/1.1\nHost: 10.0.0.5:8080\n\nscript=println(%22id%22.execute().text)\n```\n\n**响应**\n```http\nHTTP/1.1 200 OK\n\nuid=0(root) gid=0(root)\n```\n\n**判据**：未认证即可执行系统命令并回显 root。"
})
```

记下返回的 `id`（如 `VULN-20261103-001`），下一步的 `entry_vuln_id` 用它。

### (a) 登记 foothold + 内网主机，再登记服务

第一步：foothold + hosts。**services 先不传**，因为 `host_id` 要等主机返回 `IH-*`。

```json
sync_internal_scope({
  "project_name": "Starport Portal 物流客户门户靶场",
  "mode": "merge",
  "footholds": [{
    "entry_host_port": "http://10.0.0.5:8080/",
    "entry_vuln_id": "VULN-20261103-001",
    "access_type": "rce",
    "privilege_level": "admin",
    "status": "established",
    "evidence": "script console 执行 id -> uid=0(root)",
    "established_at": "2026-11-03T10:00:00+08:00"
  }],
  "hosts": [
    { "ip": "10.0.1.10", "hostname": "jump", "os": "linux", "subnet": "10.0.1.0/24", "state": "compromised", "source": "agent", "confidence": "high" },
    { "ip": "10.0.1.20", "hostname": "db01", "os": "linux", "subnet": "10.0.1.0/24", "state": "alive", "source": "agent", "confidence": "medium" }
  ]
})
```

返回（节选）：`{ "project_name": "...", "created": { "footholds": 1, "hosts": 2, "...": 0 }, "updated": { "...": 0 }, "ids": { "footholds": ["FH-..."], "hosts": ["IH-...", "IH-..."], "...": [] }, "warnings": [] }`。

第二步用返回的 `ids.hosts` 登记服务：

```json
sync_internal_scope({
  "project_name": "Starport Portal 物流客户门户靶场",
  "mode": "merge",
  "services": [
    { "host_id": "IH-...", "port": 22, "protocol": "tcp", "service": "ssh", "state": "open", "source": "agent" },
    { "host_id": "IH-...", "port": 6379, "protocol": "tcp", "service": "redis", "state": "open", "source": "agent" }
  ]
})
```

想让 foothold 记录可达主机，再补一次 foothold 更新（带 `id`，并**重传全部字段**——`entry_host_port` / `access_type` 必填；漏传 `privilege_level` / `status` / `evidence` 会被重置为默认值；`host_ids` 在 merge 模式下取并集、replace 模式下按本次传入为准）：

```json
sync_internal_scope({
  "project_name": "Starport Portal 物流客户门户靶场",
  "mode": "merge",
  "footholds": [{
    "id": "FH-...",
    "entry_host_port": "http://10.0.0.5:8080/",
    "entry_vuln_id": "VULN-20261103-001",
    "access_type": "rce",
    "privilege_level": "admin",
    "status": "established",
    "evidence": "script console 执行 id -> uid=0(root)",
    "established_at": "2026-11-03T10:00:00+08:00",
    "host_ids": ["IH-...", "IH-..."]
  }]
})
```

> 如果确实要一次调用完成，可给 hosts 显式传自己的 `id`（建议仍用 `IH-` 前缀），services 直接用该 `id`；但 `entry_host_port` 必须是已入库入口资产（先 `sync_asset_info`）。

### (b) 登记第二条 foothold（同一内网主机 / 同一入口）

同一个内网主机被第二个入口（或同一入口的另一种访问方式）拿下时，**复用已有 `IH-*`**，不要再建主机：

```json
sync_internal_scope({
  "project_name": "Starport Portal 物流客户门户靶场",
  "mode": "merge",
  "footholds": [{
    "entry_host_port": "http://10.0.0.7:3000/",
    "entry_vuln_id": "VULN-20261103-004",
    "access_type": "ssh_key",
    "privilege_level": "user",
    "status": "established",
    "evidence": "Gitea 泄露的 id_rsa 可登录 jump 的 deploy 用户",
    "host_ids": ["IH-..."]
  }],
  "credentials": [{
    "type": "ssh_key",
    "username": "deploy",
    "secret": "-----BEGIN OPENSSH PRIVATE KEY-----...",
    "source": "gitea repo: infra/ansible 部署仓库",
    "host_id": "IH-...",
    "confidence": "high",
    "status": "valid"
  }]
})
```

- 同一入口资产可以有多条 foothold：不传 `id`、换 `access_type` 再调一次即新建，不会覆盖旧记录；同入口 + 同 `access_type` 会按自然键更新已有记录；
- 要更新某条已存在的 foothold，带它的 `id` 并重传全部字段（见硬性规则 12）。

### (c) 保存内网漏洞（save_vulnerability）

```json
save_vulnerability({
  "host": "10.0.0.5:8080",
  "service_host": "10.0.1.10:6379",
  "internal_service_id": "IS-...",
  "realm": "internal",
  "vuln_name": "Redis 未授权访问",
  "vuln_type": "Unauthenticated Access",
  "severity": "High",
  "target_url": "redis://10.0.1.10:6379",
  "description": "经 foothold 建立的 SOCKS 隧道访问内网 Redis，未认证即可执行命令。",
  "reproduction_steps": "### 步骤 1：经 SOCKS5 隧道连接内网 Redis\n\n**请求**\n```http\nGET / HTTP/1.1\nHost: 10.0.1.10:6379\n\nINFO\n```\n\n**响应**\n```http\nHTTP/1.1 200 OK\n\nredis_version:7.2.0\n```\n\n**判据**：未认证返回 INFO，可继续 CONFIG SET 写文件。"
})
```

- `host` 是**入口资产**（该漏洞归属入口资产，主看板 Web 视图不显示）；
- `internal_service_id` 必须先用 `sync_internal_scope` 登记过，否则报错并提示；
- Web 漏洞：`realm="web"`（或省略）、`service_host=""`、`internal_service_id=""`。

### (d) 登记 / 更新 pivot（隧道建立与断开）

建立隧道后登记（拿到返回的 `PV-*`）：

```json
sync_internal_scope({
  "project_name": "Starport Portal 物流客户门户靶场",
  "mode": "merge",
  "pivots": [{
    "foothold_id": "FH-...",
    "kind": "proxy",
    "local_endpoint": { "host": "127.0.0.1", "port": 1080, "protocol": "socks5" },
    "hops": [
      { "ref_kind": "internal_host", "ref_id": "IH-...", "label": "jump", "via": "ssh:22" }
    ],
    "reachable_subnets": ["10.0.1.0/24", "10.0.2.0/24"],
    "tool": "chisel",
    "status": "established"
  }]
})
```

隧道断开 / 降级时更新**同一条** pivot：带 `id`，并重传 `foothold_id` / `kind` / `local_endpoint` / `hops` / `reachable_subnets` / `tool`——pivot 的 `hops` 与 `reachable_subnets` 每次写入都按本次传入**整组替换**，漏传会被清空，路由图就断了：

```json
sync_internal_scope({
  "project_name": "Starport Portal 物流客户门户靶场",
  "pivots": [{
    "id": "PV-...",
    "foothold_id": "FH-...",
    "kind": "proxy",
    "local_endpoint": { "host": "127.0.0.1", "port": 1080, "protocol": "socks5" },
    "hops": [
      { "ref_kind": "internal_host", "ref_id": "IH-...", "label": "jump", "via": "ssh:22" }
    ],
    "reachable_subnets": ["10.0.1.0/24", "10.0.2.0/24"],
    "tool": "chisel",
    "status": "lost",
    "notes": "隧道断开：chisel 进程被清理，127.0.0.1:1080 无响应"
  }]
})
```

### (e) 清理：显式 `removed`

```json
sync_internal_scope({
  "project_name": "Starport Portal 物流客户门户靶场",
  "removed": {
    "service_ids": ["IS-..."],
    "host_ids": ["IH-..."],
    "pivot_ids": ["PV-..."],
    "credential_ids": ["CR-..."],
    "foothold_ids": ["FH-..."]
  }
})
```

- `removed` 只用于**错误录入或确实要删除**的记录；保留历史优先把 foothold / pivot 状态改为 `lost` / `degraded`；
- 删除 host 会级联删除其 services；删除 foothold 会级联删除其 pivots 与 hops；删除 credential 会级联删除其 trials；被删除 service 上的 credential `service_id` 会被置空。

## mode 语义（merge / replace / removed）

| mode | 行为 | 删除 |
| --- | --- | --- |
| `merge`（默认） | 按 `id` upsert；无 `id` 时按自然键 upsert（见下方自然键清单）；未出现的实体保持不动 | 不删除（除非 `removed`） |
| `replace` | 仅本次传入的数组按整体替换：该实体类型中**不在数组内的记录会被删除**；未传的数组完全不动 | 同左 + `removed` |
| `removed` | 两种模式下都生效，按 ID 显式删除 | 显式删除 |

- **永远不做「全 project 清空」式 replace**：不带任何数组的 `replace` 不会删除任何东西；需要清空用 `removed`。
- 用 `replace` 前先 `query_asset_context({ project_name, include_internal: true })` 读到当前全量，避免漏传造成误删；日常增量同步一律用 `merge`。
- upsert 是**整条记录覆盖**，不是字段级 patch：未传字段会被默认值重写（硬性规则 12）。
- 自然键：foothold `(project, entry_host_port, access_type)`、host `(project, ip)`、service `(host_id, port, protocol)`、credential `(project, type, username, domain, secret)`、pivot `(foothold_id, kind, local_endpoint.host, local_endpoint.port)`；命中自然键即更新，而不是新建记录。
- 返回示例：

```json
{ "project_name": "Starport Portal 物流客户门户靶场", "created": { "footholds": 0, "hosts": 0, "services": 2, "credentials": 0, "pivots": 0 }, "updated": { "footholds": 1, "hosts": 0, "services": 0, "credentials": 0, "pivots": 0 }, "ids": { "footholds": ["FH-..."], "hosts": ["IH-..."], "services": ["IS-...", "IS-..."], "credentials": [], "pivots": [] }, "warnings": [] }
```

- `warnings` 会给出被忽略 / 引用异常等提示；`created` / `updated` 计数用于确认写入是否覆盖了预期记录。

## 内网漏洞字段规范（save_vulnerability）

| 字段 | 内网漏洞填法 |
| --- | --- |
| `host` | **入口 Web 资产**（host 形式：入口 `host_port` 去掉协议头/路径，如 `10.0.0.5:8080`）；不是内网 IP |
| `service_host` | 实际内网服务：`ip:port`（如 `10.0.1.10:6379`）或人类可读标签（如 `jump`、`redis:6379`） |
| `internal_service_id` | 结构化关联的 `IS-*`；必须同 project 且已由 `sync_internal_scope` 登记 |
| `realm` | 内网漏洞必须 `"internal"`（省略时 `service_host` 非空会被推断为 internal，建议显式传） |
| `target_url` | 实际触发地址，如 `redis://10.0.1.10:6379` 或经隧道访问的 `http://10.0.1.20:8080/...` |
| `reproduction_steps` | 标准 Markdown（`### 步骤 N` + **请求** / **响应** / **判据**），写清如何经 foothold / 隧道到达 |

- 查询内网漏洞：`query_vulnerabilities({ realm: "internal" })`；默认 `realm` 为 `all`（兼容旧调用），主看板默认 `web`；
- 查重仍按 `host` + `service_host` 判断（同一入口资产下同内网服务只保留一条主记录）；
- 升级 / 利用链变化用 `update_vulnerability` 追加复测，不要新开重复漏洞。

## 读取内网上下文

- `query_asset_context({ host_port, include_internal: true })` → 该入口资产的 footholds + 可达 hosts / services / pivots 摘要；
- `query_asset_context({ project_name, include_internal: true })` → 项目级汇总（每类默认最多 50 条，超出给 `counts` 与 `truncated`）；
- `include_credentials: true` 才返回凭据，且只有 `secret_preview` / `secret_length`（脱敏）；默认关闭，避免上下文膨胀与敏感值外泄；
- 不传开关时**不返回任何内网数据**，保持旧 Agent 的上下文兼容。

## 凭据脱敏与安全

- 录入：只填必要字段（`type` / `username` / `domain` / `secret` / `source` / `host_id` / `service_id` / `confidence` / `status` / `notes`）；`notes` 只写来源与用途，不写密码 / 哈希原文。
- 读取：`Credential` 只有 `secret_preview` + `secret_length`，没有 `secret`；UI / CLI 默认脱敏，复制需显式操作。
- 使用：Cortex 不自动连接 / 登录 / 爆破；`credential_trials`（attempted / success / failed / blocked）在人工尝试后由桌面端 / API 记录（不是 MCP 工具）。
- 凭据-服务矩阵的「候选」是本地确定性规则（`ntlm_hash` + SMB → Pass-the-Hash 候选；`netntlmv2` 不能 PtH，只能 Relay / 破解；`password` + RDP / SSH / WinRM / MSSQL → 登录候选；`ssh_key` + SSH → 密钥登录候选…），必须带 reason / caveat / confidence，标注「建议，不是结论」。

## Loot 规则（本地解析）

- 入口只有两个：CLI `ctx loot import <file> --project <name> [--entry <host_port>] [--format auto]` 和桌面端「内网作战 → Loot」面板；**不通过 MCP 导入**。
- 文件不可信：限制文件 / 解压后大小与条目数、防 zip-slip、不联网、不执行任何内容、不把原始文件写入数据库（只存文件名 / 哈希 / 摘要）。
- 解析器：`bloodhound-json` / `secretsdump-text` / `config-env` / `generic-csv`；未知格式 → `needs_review`，解析失败 → `failed` 并带 error。
- 解析结果写入同一套内网表（hosts / services / credentials）；凭据以 `status: "untested"` 写入、导入记录标记 `needs_review`，人工复核后再作为事实；**不要凭 Loot 结果自动尝试凭据**。
- 查看：`ctx loot list --project <name>`；内网只读查询 `ctx internal overview|hosts|routes --project <name>`；以上命令均支持 `--json`、只读、不改数据库。

## 校验与错误处理（均为 `isError: true`，按提示修正后重试）

| 错误 / 现象 | 处理 |
| --- | --- |
| `ip` 非法 | 只填 IPv4/IPv6 字面量（`10.0.1.10`、`2001:db8::10`），不要带 CIDR；网段填 `subnet` |
| `subnet` / `reachable_subnets` 非法 | 必须是合法 CIDR（`10.0.1.0/24`、`2001:db8::/64`） |
| `host_id` 不存在 / 缺失 | 先登记 hosts，用返回的 `ids.hosts` 作为 `host_id`；不要凭空编 `IH-*` |
| `foothold_id` 不存在 | 先登记 foothold 并用返回的 `FH-*` |
| hop `ref_id` 不存在 | 先登记对应 `IH-*` / `IS-*`，或修正 `ref_id` |
| `realm="internal"` 但 `service_host` / `internal_service_id` 都为空 | 补 `service_host` 或先登记 service 并传 `internal_service_id` |
| `internal_service_id` 不属于本 project / 不存在 | 先 `sync_internal_scope` 登记该服务；或检查 `project_name` 是否写错 |
| 更新 foothold / pivot 被拒绝 | 严格 schema 要求必填字段：foothold 带 `entry_host_port` + `access_type`，pivot 带 `foothold_id` + `kind` |
| 未知字段被拒绝 | 输入是严格对象，删掉拼错 / 不存在的字段 |
| 超出单次上限 | footholds ≤50、hosts ≤500、services ≤2000、credentials ≤500、pivots ≤100；分批调用 |
| `replace` 后数据少了 | 只同步了部分实体导致被替换；改用 `merge` 或按全量传入 |
| `removed` 的 ID 未命中 | 返回 warning；先 `query_asset_context` / `ctx internal hosts` 确认真实 ID |
| `removed` 的 ID 属于其他 project | 直接报错（不能跨项目删除）；检查 `project_name` 与 ID |
| `entry_host_port` 不存在 | 报错要求先登记入口资产：先 `sync_asset_info` 写入该 Web 资产，再建 foothold；`project_name` 应与入口资产一致（不一致返回 warning） |
| `entry_vuln_id` 未入库 | 返回 warning 但 foothold 仍记录；建议先 `save_vulnerability` 保存入口漏洞 |
| 更新后字段 / 路由“丢了” | upsert 是整条覆盖：重传完整字段；pivot 必须连同 `hops` / `reachable_subnets` 一起传 |

## 常见错误

- ❌ 把 RCE 当失陷：只 `save_vulnerability` 不建 foothold，内网实体失去归属；
- ❌ 没有 foothold 就直接登记 hosts / services / pivots；
- ❌ 同一 IP 重复登记多条内网主机（应复用 `IH-*`，merge 按 `(project, ip)` 去重）；
- ❌ services 不等 hosts 返回 `IH-*`、手填不存在的 `host_id`；
- ❌ 用 `sync_internal_scope` 存 Web 资产 / 接口 / 漏洞（分别走 `sync_asset_info`、`save_vulnerability`）；
- ❌ 内网漏洞漏传 `realm` / `service_host` / `internal_service_id`，混进主漏洞库；
- ❌ 把内网 IP 填进 `host`（`host` 必须入口资产，内网服务填 `service_host`）；
- ❌ 复测改写原始字段（用 `update_vulnerability` 的 `retest`）；
- ❌ 把 `secret` 写进 `notes` / `evidence` / 日志 / 对话，或在回复里回显；
- ❌ 让 Agent 自动尝试凭据登录 / 爆破；
- ❌ pivot 建立 / 断开不更新状态，导致路由图与真实隧道不一致；
- ❌ 用 `replace` 做“全量同步”却漏传实体 → 误删；
- ❌ 把 `merge` 的 upsert 当字段级 patch：更新时只传 `id` + 一两个字段，其余字段被默认值覆盖（pivot 的 `hops` / `reachable_subnets` 会被清空）；
- ❌ 把扫描器原始结果未经筛选全量登记（应只登记确认有作战价值的主机 / 服务）；
- ❌ 内网实体与入口资产 / 快照使用不同的 `project_name`。

## 完成前 checklist

- [ ] 入口漏洞已 `save_vulnerability` 入库，foothold 带 `entry_vuln_id`；
- [ ] 先 hosts 后 services，`host_id` 来自返回值而不是猜测；
- [ ] 更新前已读现状并重传完整字段；pivot 状态更新时同时重传 `hops` / `reachable_subnets`；
- [ ] 没有重复主机 / 服务；`project_name` 与资产库、快照完全一致；
- [ ] 内网漏洞带 `realm="internal"` + `service_host` / `internal_service_id`，未混入 Web 看板；
- [ ] pivot 状态与真实隧道一致（`established` / `degraded` / `lost`）；
- [ ] `secret` 只写入 `secret` 字段，notes / 日志 / 对话无原文；
- [ ] Loot 解析结果已复核，凭据未被自动使用；
- [ ] 没有把未确认数据 / 扫描器原始输出当事实写入。
