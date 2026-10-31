---
name: asset-context
description: "[MUST] After JS auditing, fingerprinting, endpoint capture and other recon, you must call sync_asset_info to persist the asset fingerprint, structured interfaces (interfaces), leaked information and related vulnerabilities into Cortex; before testing a new asset you must first call query_asset_context({ host_port }) to reuse existing context."
---

# Skill: Asset Context (Collection and Persistence)

Cortex stores not only vulnerabilities but also "asset context". Asset context is the core memory for later testing, vulnerability retests and resuming a task in a new session: structured endpoints are often more valuable than a single vulnerability, and a leaked secret can directly determine the exploitation path.

## Hard rules (MUST)

1. **Before testing a host / URL, first call `query_asset_context({ host_port })`** (or `query_asset_context({ project_name })`) to read the existing asset context, avoiding duplicate recon and avoiding overwriting old information.
2. **After finishing a round of information gathering, you must call `sync_asset_info` before replying to the user**, to persist the fingerprints, endpoints, leaks and related vulnerabilities that were added or changed this time. Not syncing (or not explaining why it does not apply) = the task is not complete.
3. **Prefer recording endpoints as structured `interfaces[]`**: write `path` first; after JS auditing / traffic capture confirms an endpoint, fill in `method`, `params` and `request` one by one. `request` must be the **complete raw HTTP request** (request line, Host/headers, optional body), not a path and not a URL. The legacy `interface_dir: string[]` is still supported: the server normalizes it to `{ path }` on read/write, without errors or data loss; but new data should not be a bare path array anymore.
4. **Prefer passing a full URL for `host_port`** (supports `http://` / `https://`, ports, login pages / business paths); the `host` field is a pure host (no port, no scheme, no path) and may be omitted, in which case the server derives it from the URL. Do not write only a generic path that cannot locate the system.
5. **A bare IP / IP:port is not accepted**: this asset library targets Web/HTTP assets and does not record port scans, service discovery or protocol probes for bare IPs. IP assets must be recorded as a full `http(s)://IP:port/path` URL (e.g. `http://10.0.0.5:8080/login`).
6. Do not overwrite existing information with empty arrays/strings. Read the current full context first, then decide:
   - this round is a complete snapshot → `mode: "replace"` (default);
   - this round only adds incremental findings → `mode: "merge"`; `project_name` is still required when merging, omitted `auth_required` / `status` keep their existing values, and interfaces/leaks/related vulnerabilities are appended as a union.
7. **Write `tech_stack` item by item with explicit separators** (English comma `, `, full-width comma `，`, English semicolon `; `, full-width semicolon `；`, the CJK enumeration comma `、`, or newlines), one technology per item, e.g. `Nginx, Spring Boot 3, Vue 3`; do not join them with an ellipsis or a whole run without separators, because the UI splits on these separators into individual tags.
8. When you find sensitive information, record the source for each item (JS file path/line number, API, page URL) and the **impact you can act on**; do not just write "a key leaked".
9. After saving a vulnerability, link the new vulnerability ID to the corresponding asset (`related_vuln_ids`); the asset library also auto-links vulnerabilities of the same host by pure host.
10. **If the MCP is unavailable** (tools missing / `server is disconnected`), first run `ctx doctor`: confirm the agent launches the MCP over stdio (development `node <project>/out/mcp/stdio.cjs`, installed `<install>\bin\node.exe` + `<install>\bin\mcp-stdio.cjs`) and that the database path is correct, then **restart the agent** (not the GUI); if the database is busy / the schema is too old, open the GUI once or run `ctx doctor`. Backfill after recovery; silently skipping is forbidden; see "MCP connection troubleshooting" in the `vuln-db` skill.
11. If the user explicitly says "no need to persist / just taking a look" in this turn, follow the user's instruction.

## Asset persistence value threshold

- Only persist Web assets that are **reachable, in scope, and have a real attack surface** (login / API / upload / admin / SSO / sensitive data);
- Unreachable targets, parked pages, default pages / welcome pages, pure static sites, CDN / static-resource domains, duplicate sites and out-of-scope targets are not written to the asset library;
- Do not create a record for each excluded item: summarize the reason / count into the corresponding project snapshot (`notes` of the project session in the `snapshot` skill's `manage_snapshot`);
- Do not bulk-persist by subdomain; merge multiple domains of the same system into one asset entry to avoid asset / session explosion.

## When to use

- After finishing JS auditing, fingerprinting, traffic capture, directory scanning or public-document collection;
- After discovering new endpoint paths / methods / parameters / raw requests, tech stack, sensitive leaks, internal addresses or WAF/authentication behavior;
- Before starting to test a host (read the asset context first);
- After a retest, when the asset's alive status needs updating or a new vulnerability needs linking.

## Field specification

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `host_port` | string | Yes | **Prefer a full URL**: `https://example.com/login`, `http://10.0.0.5:8080/admin`, `https://example.com:8443/`. `host` / `host:port` / `host/path` are also accepted; no whitespace allowed. **A bare IP or IP:port is rejected** |
| `host` | string | No | Pure host: no port, no scheme, no path, e.g. `example.com`, `10.0.0.5`, `[::1]`. When omitted, the server derives it from `host_port` |
| `project_name` | string | Yes | Project / system / app name; if unsure, infer it from the page title first — do not make it up |
| `tech_stack` | string | No | Fingerprint information; separate each technology with `, ` / `，` / `; ` / `；` / `、` / newlines, e.g. `Nginx, Spring Boot 3, Vue 3`; the UI splits on these separators into individual tags |
| `auth_required` | boolean | No | Whether the core functionality requires a logged-in session; default `false`, set `true` only when there is evidence |
| `status` | enum | No | `Alive` / `Dead` / `WAF_Blocked`, default `Alive` |
| `interfaces` | object[] | No (recommended) | **Structured endpoint list**, fields below; preferred for new data, up to 2000 entries |
| `interface_dir` | string[] | No (compatibility field) | Legacy bare-path list, kept only for backward compatibility; the server normalizes it to `{ path }` and merges/deduplicates it with `interfaces`. Write `interfaces` for new data |
| `leaked_infos` | object[] | No (default `[]`, up to 200 entries) | Sensitive leak list, fields below |
| `test_parameters` | object[] | No | **Non-secret test parameter seeds** (ids / order numbers / tenant ids from post-login traffic, IDOR/enumeration material), fields below; do not mix with `leaked_infos`; up to 100 entries |
| `related_vuln_ids` | string[] | No | Related vulnerability IDs; prefer IDs already stored in the vulnerability library (existence is not enforced) |
| `last_seen` | string | No | Written automatically by the server; the agent does not need to pass it |

> The server normalizes `interfaces` and `interface_dir` together: a bare path → `{ path }`; when the same `path` already has a structured method, the old bare-path entry is upgraded/deduplicated; `interface_count` and the UI both count normalized structured endpoints. Static paths such as JS/CSS/images are rejected in both.

### `interfaces[]`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | API path starting with `/`, deduplicated; no domain or scheme. **Static files such as JS/CSS/images are not endpoints**; do not write them |
| `method` | enum | No | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `OPTIONS` / `HEAD` |
| `params` | string | No | Query parameters, form parameters or a JSON body summary, e.g. `id=1001`, `{"page":1,"size":20}` |
| `request` | string | No | **Complete raw HTTP request**: request line + Host/headers + optional body; not a path, not a URL |

After traffic capture confirms an endpoint, fill it in one by one:

```json
{
  "path": "/api/v1/files/download",
  "method": "POST",
  "params": "id=1001&format=pdf",
  "request": "POST /api/v1/files/download HTTP/1.1\nHost: opcenter.example.com\nContent-Type: application/x-www-form-urlencoded\nCookie: session=<redacted>\n\nid=1001&format=pdf"
}
```

When only the path is confirmed and no request has been captured yet, you may write just `path`:

```json
{ "path": "/api/v1/user/info" }
```

### `leaked_infos[]`

| Field | Description |
| --- | --- |
| `info_type` | `Credential` / `API_Key` / `Token` / `PII` / `Internal_IP` / `Other` |
| `value` | The leaked content itself: plaintext password, AK/SK, JWT, internal address, etc.; store only the actual value, do not paste a whole block of JS |
| `source` | Exact source, e.g. `https://target.example.com/main.js:182` |
| `potential_impact` | Describe exploitability with professional judgment, e.g. "leaked Alibaba Cloud AK, may allow taking over OSS" |

> Development/testing stage: the asset library displays leaked values in plaintext, without encryption or masking. Do not abuse this in a real production environment; encrypted storage and sensitive-field controls will be evaluated later.

### `test_parameters[]` (test parameters, non-secret)

**id, order number, tenant id, UUID**, etc. collected after login from traffic/responses/URLs/JS are IDOR / enumeration test material, but they are **not secrets**: store them separately in `test_parameters` instead of stuffing them into `leaked_infos`; passwords, tokens, AK/SK and PII still go to `leaked_infos`.

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Parameter name, e.g. `id` / `orderId` / `tenantId` (≤100) |
| `endpoint` | string | Endpoint that uses the parameter, e.g. `GET /api/v1/users/{id}` (≤500) |
| `location` | enum | `path` / `query` / `body` / `header` / `cookie` |
| `values` | string[] | **At most 50 samples** (≤200 each); a full dump is forbidden |
| `pattern` | string | Optional enumeration pattern: `auto-incrementing number 100000+`, `UUID v4`, `prefix + 6 digits` (≤500) |
| `source` | string | Source: response JSON / URL / JS (e.g. `app.js:182`, ≤1000) |
| `tested` | boolean | Whether it has been used in authorized testing; default false, update after testing |
| `notes` | string | Optional test conclusion / boundary (≤2000) |
| `related_vuln_ids` | string[] | Vulnerability IDs linked after confirming broken access control (≤100) |

```json
{
  "name": "orderId",
  "endpoint": "GET /api/v1/orders/{orderId}",
  "location": "path",
  "values": ["100234", "100235", "100236", "100237"],
  "pattern": "auto-incrementing number 100000+",
  "source": "response JSON /api/v1/orders",
  "tested": true,
  "notes": "Replacing orderId returned another user's order; IDOR confirmed",
  "related_vuln_ids": ["VULN-20261031-001"]
}
```

- One record per parameter; after testing, update `tested` / `notes` / `related_vuln_ids` with `sync_asset_info` (with `mode: "merge"`, dedupe by `endpoint` + `name` + `location`, union `values`, and OR `tested`);
- The snapshot's `tested_interfaces` records conclusions only, not the candidate values again.

## interfaces and static assets (important)

- `interfaces[].path` records only **callable API endpoints/routes**, e.g. `/api/v1/user`, `/api/admin/login`, `/download/report`.
- JS files, CSS, images, fonts, source maps and other static resources **are not endpoints** and must not be written to `interfaces` (the compatibility field `interface_dir` is likewise not allowed).
- When you find sensitive information in JS, put the JS URL/line number into the corresponding `leaked_infos[].source`; put API paths extracted from JS into `interfaces`, and complete `method` / `params` / `request` via traffic capture where possible.
- `request` may reference real messages reconstructed from JS or traffic capture, but do not paste whole blocks of JS code, and do not treat a static-resource URL as a request record.
- Do not treat a path as an endpoint just because it ends with `.js`; if the file really must be kept as evidence, use `leaked_infos.source` or a note.

## Why a bare IP is not persisted

- The asset library is a Web asset identity (`host_port`), not a network scan result table: a bare IP, IP:port, open port/service fingerprint (e.g. `10.0.0.5:22`) is not written.
- When the IP hosts a Web service, record the full URL (`http://10.0.0.5:8080/login`) + `project_name` + `interfaces`; keep bare-IP scan results in the scanner and do not disguise them as a Web asset.

## Recommended workflow

### 1. Recall (before testing)

Read a single asset by full URL:

```json
query_asset_context({ "host_port": "https://opcenter.example.com/login" })
```

If you do not remember the exact URL, query fuzzily by project name; it returns `AssetContext[]`:

```json
query_asset_context({ "project_name": "Example Cloud Course" })
```

`host_port` and `project_name` are mutually exclusive. If existing endpoints (with method / params / request), tech stack or historical leaks are returned, reuse them first instead of re-capturing.

### 2. Collect (in real time)

Collect from JS, API responses, captured traffic, pages and public documents:

- Fingerprints and tech stack (each technology separate, separated by a delimiter);
- Endpoint `path`, `method`, parameters (query / form / JSON body);
- Raw HTTP requests (request line + headers + body) to fill in `request`;
- Front-end hardcoded credentials, AK/SK, tokens, internal IPs;
- Whether a login session is required, and whether a WAF blocks requests.

### 3. Decide (the AI judges autonomously)

Compare "existing asset context" with "real-time findings from this round" and let the model judge:

- which fields need to change;
- which endpoints are new, and which need upgrading from bare paths to structured entries (adding method / params / request);
- which leaks are new;
- which old information is no longer valid;
- whether new vulnerabilities need to be linked.

### 4. Persist

Full snapshot (recommended after reading the full context):

```json
sync_asset_info({
  "host_port": "https://opcenter.example.com/login",
  "host": "opcenter.example.com",
  "project_name": "Example Cloud Course",
  "tech_stack": "Nginx, Spring Boot 3, Vue 3",
  "auth_required": false,
  "status": "Alive",
  "interfaces": [
    {
      "path": "/api/v1/files/download",
      "method": "POST",
      "params": "id=1001&format=pdf",
      "request": "POST /api/v1/files/download HTTP/1.1\nHost: opcenter.example.com\nContent-Type: application/x-www-form-urlencoded\nCookie: session=<redacted>\n\nid=1001&format=pdf"
    },
    {
      "path": "/api/v1/user/info",
      "method": "GET",
      "params": "id=1001"
    },
    {
      "path": "/api/v1/report/legacy/export"
    }
  ],
  "leaked_infos": [
    {
      "info_type": "API_Key",
      "value": "LTAI5tFakeExampleKey000000",
      "source": "https://static.example.com/main.js:182",
      "potential_impact": "Suspected Alibaba Cloud STS credentials; may be usable to call OSS/STS APIs"
    }
  ],
  "related_vuln_ids": ["VULN-20260101-001"],
  "mode": "replace"
})
```

- The first two are structured entries (with complete `request` / parameters);
- The last one records only `path`: it corresponds to legacy data or an endpoint where "only the path was seen and no request captured yet", to be completed once the request is captured.

Add only new findings (`interfaces` and the compatibility field `interface_dir` may appear together):

```json
sync_asset_info({
  "host_port": "https://opcenter.example.com/login",
  "project_name": "Example Cloud Course",
  "interfaces": [
    { "path": "/api/v1/new/export", "method": "POST", "params": "taskId=88" }
  ],
  "interface_dir": ["/api/v1/legacy/notify"],
  "mode": "merge"
})
```

`interface_dir` is the legacy form: the server normalizes it to `{ "path": "/api/v1/legacy/notify" }` and merges it with `interfaces` without errors; for new data, write `interfaces` directly.

### 5. Link vulnerabilities

After confirming a vulnerability:

1. First `query_vulnerabilities({ host })` to deduplicate, then `save_vulnerability` to persist;
2. Then `sync_asset_info` to write the new vulnerability ID into `related_vuln_ids`;
3. The asset library's "Related vulnerabilities" tab shows vulnerabilities matched automatically by the same host plus explicitly linked ones.

## Returns and error handling

- `sync_asset_info(...)` → `{ success: true, host_port, host, created, mode, message }`; `created: false` means an existing asset was replaced/merged.
- `query_asset_context({ host_port })` → the full `AssetContext` (including `interfaces[]`, `leaked_infos[]`, `test_parameters[]`, `related_vuln_ids[]`, `last_seen`); a missing asset returns `isError: true` and tells you to finish recon and call `sync_asset_info` first.
- `query_asset_context({ project_name })` → `AssetContext[]` (fuzzy match, possibly empty).
- Validation failures return `isError: true` plus the field path: a bare IP / IP:port, a static-asset `path`, or a `host` with port/scheme are rejected — fix the field and retry.
- `mode: "replace"` treats this payload as authoritative; `mode: "merge"` keeps fields you did not pass. Either way, read the full context with `query_asset_context` before writing to avoid deleting data.

## Common mistakes

- ❌ Persisting a bare IP / IP:port (e.g. `10.0.0.5`, `10.0.0.5:22`) as an asset; an IP must be written as a full http(s) URL;
- ❌ Writing static resources such as `main.js`, `app.css`, `logo.png` into `interfaces` / `interface_dir`;
- ❌ Writing only bare paths without adding `method` / `params` / `request` (new data should prefer `interfaces`, completed one by one after traffic capture);
- ❌ Writing only a path or URL in `request` (it must be the complete raw HTTP request: request line + Host/headers + optional body);
- ❌ Joining `tech_stack` with an ellipsis or a whole run without separators (the UI cannot split it into individual tags);
- ❌ Writing only a hostname that cannot locate the concrete Web entry point (prefer recording the full URL + path);
- ❌ Overwriting existing endpoints with empty `interfaces` / `interface_dir`;
- ❌ Fabricating AK/SK, tokens or unverified leaks;
- ❌ Making `potential_impact` merely repeat the value without exploitability;
- ❌ Writing passwords / tokens / AK / PII into `test_parameters` (they belong in `leaked_infos`), or treating ordinary ids / order numbers as sensitive leaks, or stuffing a whole response into `values` (at most 50 samples + `pattern`);
- ❌ Forgetting to link the asset after saving a vulnerability.

## Installing into agents

Use `ctx init` to do the MCP config + three skills + system-level rules in one go (`--dry-run` only previews, `--agents` selects clients):

```powershell
ctx init
ctx init --dry-run
ctx init --agents dsh,claude,codex,cursor,workbuddy,zcode
```

- DSH: skill installed to `~/.agents/skills/asset-context/SKILL.md`, hard rules written to `~/.dsh/AGENTS.md`;
- Codex: skill installed to `~/.codex/skills/asset-context/SKILL.md` and the shared `.agents/skills`, rules written to `~/.codex/AGENTS.md`;
- Claude Code: skill installed to `~/.claude/skills/asset-context/SKILL.md`, rules written to `~/.claude/CLAUDE.md`;
- Cursor: MCP config written to `mcpServers` in `~/.cursor/mcp.json` (stdio), handled by `ctx init` according to client capabilities.
- WorkBuddy: MCP config written to `mcpServers` in `~/.workbuddy/mcp.json` (stdio); import the skill from `~/.agents/skills` in WorkBuddy Settings → Skills; no global rule file.
- ZCode: MCP config written to `mcp.servers` in `~/.zcode/cli/config.json` (stdio); skill installed to `~/.zcode/skills/asset-context/SKILL.md`, rules written to `~/.zcode/AGENTS.md`.
- The MCP is launched by the agent (stdio), so no desktop app needs to run; the GUI is only a viewer and can be opened or closed at any time.
- Database: Windows `%USERPROFILE%\.cortex\data.db`, macOS/Linux `~/.cortex/data.db`; override with `CTX_DB_PATH` (the legacy `PDH_DB_PATH` still works).
- For manual configuration, use `ctx mcp print-config <agent>` to print the stdio config snippet that matches the GUI's "MCP Access" page.

### Post-install self-check

1. Restart the agent; confirm the 6 tools are present in the tool list: `save_vulnerability`, `query_vulnerabilities`, `update_vulnerability`, `sync_asset_info`, `query_asset_context`, `manage_snapshot`.
2. Ask the agent to run `query_asset_context`, `query_vulnerabilities` and `manage_snapshot({ action: "list" })` once (read-only) to confirm the link works.
3. After one asset recon round, confirm the agent proactively calls `sync_asset_info`; reading again with `query_asset_context({ host_port })` should show the structured endpoints and sensitive leaks.
4. If tools are missing or the connection drops, run `ctx doctor`, fix the config as prompted, then restart the agent.
