---
name: vuln-db
description: "[MUST] Before saving a new vulnerability, deduplicate with query_vulnerabilities({ host }) and then call save_vulnerability; for retests only append a Markdown conclusion via update_vulnerability retest, and never overwrite the original evidence with save_vulnerability; reproduction_steps must be standard Markdown (### Step N, **Request**, **Response**, **Evidence** + http code blocks)."
---

# Skill: Vulnerability Discovery and Persistence (Cortex)

Cortex is a local **stdio MCP Server**: the agent launches it automatically (`node <entry>`), so the desktop app does not need to be running; the desktop app is only a viewer and can be opened or closed at any time. It never scans on its own; it only persists the vulnerabilities the agent has confirmed into SQLite in a structured form, for humans to review in the desktop app or the terminal. The UI renders `reproduction_steps` and retest conclusions as Markdown, applies syntax highlighting to ```http / ```json code blocks, and auto-formats the JSON inside them.

## Connection (stdio)

- **Transport**: stdio. The agent starts the MCP server inside its own process and exchanges JSON-RPC over stdin/stdout; there is no listening port and no HTTP endpoint, and the desktop app does not start the MCP.
- **Entry point**: development mode `node <project>/out/mcp/stdio.cjs`; Windows installed build `<install>\bin\node.exe` + `<install>\bin\mcp-stdio.cjs` (server name `cortex`, version `0.1.1`).
- **Database**: Windows `%USERPROFILE%\.cortex\data.db`, macOS/Linux `~/.cortex/data.db`, overridable with `CTX_DB_PATH` (the legacy `PDH_DB_PATH` still works); the GUI / MCP / CLI share the same file.
- **Verify the link**: call one read-only tool, e.g. `manage_snapshot({ "action": "list" })` or `query_vulnerabilities({ "host": "example.com:443" })`; if the tool exists and returns normally, the stdio connection works.

## Hard rules (MUST, higher priority than the rest of this skill)

This is an **execution gate**, not a "recommended call":

1. **When you confirm a new vulnerability, you must persist it before replying to the user.** Fixed order: first `query_vulnerabilities({ host })` for deduplication → then `save_vulnerability` to write.
2. **When retesting an existing vulnerability, only call `update_vulnerability({ vuln_id, retest: { time_range, conclusion } })` to append the retest result.** Do not write retest conclusions into `test_boundaries`, and do not use `save_vulnerability` to rewrite the original fields such as description, impact, reproduction steps or remediation.
3. **Use only `update_vulnerability({ vuln_id, status })` for status transitions**; do not rewrite the whole record with `save_vulnerability` just to change status.
4. Writing a report only / merely saying "vulnerability found" in the conversation without a successful call to the persistence tool = the task is not complete.
5. Even a finding with insufficient evidence that is worth recording must be persisted with `status: "Inconclusive"`; never discard it.
6. **If the MCP is unavailable (tools missing / `server is disconnected` / the stdio process will not start) → run `ctx doctor` first**: verify the database path, schema version and MCP entry point (development `node` + `out/mcp/stdio.cjs`, installed `<install>\bin\node.exe` + `<install>\bin\mcp-stdio.cjs`), confirm the agent's MCP config uses `node <entry>`, then **restart the agent** (not the GUI). If the database is busy or the schema is too old, open the GUI once or run `ctx doctor`. Backfill after recovery; **silently skipping is forbidden**, and "cannot connect" is not an excuse to end the task.
7. If the user explicitly says "no need to persist / just taking a look" in this turn, follow the user's instruction; there are no other exceptions.
8. Tool names may be namespaced: on DSH it is `mcp__cortex__save_vulnerability`; Codex/Claude may show it as `cortex.save_vulnerability`. Call the tool under whatever name is actually exposed; do not skip it just because the prefix differs.

## When to use

- Confirming a **new vulnerability** → call `save_vulnerability`.
- Before testing a new host → call `query_vulnerabilities({ host })` to review historical conclusions (deduplication).
- Need full vulnerability details → call `query_vulnerabilities({ vuln_id })`.
- **Retesting an existing vulnerability → call `update_vulnerability({ vuln_id, retest: { time_range, conclusion } })`**, appending only the retest; the same call may carry `status`, or you can only transition the status.
- Browsing / filtering / paging through data → `query_vulnerabilities({ search?, severity?, status?, page?, pageSize? })`.

## Field specification

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | No | Omit it to auto-assign `VULN-YYYYMMDD-NNN`; the same ID overwrites the old record |
| `host` | string | Yes | Must include a port, e.g. `opcenter.example.com:443`; no scheme and no path |
| `vuln_name` | string | Yes | Vulnerability name |
| `vuln_type` | string | No | e.g. `SQLi` / `SSRF` / `Arbitrary_File_Download`; omitted = `Unclassified` (the UI renders the localized “unclassified” label) |
| `severity` | enum | Yes | `Critical` / `High` / `Medium` / `Low` / `Info` |
| `target_url` | string | Yes | URL that triggers the vulnerability |
| `entry_point` | string | No | Initial entry point, e.g. a URL or `/login` |
| `description` | string | No | Root cause, endpoint, parameters, preconditions |
| `impact` | string | No | Actual harm and scope of impact |
| `affected_interfaces` | string[] | No | List of affected endpoints/URLs (the UI renders an unordered list and wraps long URLs) |
| `reproduction_steps` | string | No | **A standard Markdown string**; see the next section for the format; do not pass an array |
| `remediation` | string[] | No | Remediation advice (the UI renders an unordered list) |
| `crypto_details` | string | No | Encryption/signature algorithm, key source, flow; use `"None"` or an empty string if there is none |
| `test_boundaries` | string | No | Testing boundaries and what was not done; **do not write retest conclusions here** |
| `retest_results` | object[] | No | Retest history, appended by `update_vulnerability`'s `retest`; each item is `{ time_range, conclusion }`. `conclusion` is Markdown |
| `related_vuln_ids` | string[] | No | IDs of prerequisite vulnerabilities for chained attacks |
| `status` | enum | No | `Confirmed` (default) / `Inconclusive` / `Retest_Passed` |
| `created_at` | string | No | ISO 8601; the server fills in the current time when omitted |

## reproduction_steps specification (important)

`reproduction_steps` is **a single Markdown string**, not a JSON array. The following structure is required so the UI can render and highlight it correctly:

````markdown
### Step 1: Request the download endpoint anonymously and obtain the presigned download URL for file_id=10

**Request**
```http
GET /api/v1/files/download?file_id=10 HTTP/1.1
Host: opcenter.example.com
Accept: */*
```

**Response**
```http
HTTP/1.1 200 OK
content-type: application/json

{"code":0,"data":{"file_url":"https://files.oss.example.com/..."},"message":"success"}
```

**Evidence**: a request carrying no session credentials returned 200 and still issued an OSS presigned download URL for the student file “Chen Tao Group.rar”.

### Step 2: Download the file content with the presigned URL

**Request**
```http
GET /example-bucket%2Fsample-group.rar HTTP/1.1
Host: files.oss.example.com
Range: bytes=0-1023
```

**Response**
```http
HTTP/1.1 206 Partial Content
content-range: bytes 0-1023/1048576

Rar!\x1a\x07\x01\x00m\xee+a\r\x01\x05\t
```

**Evidence**: the presigned URL really works; it returned the original content of the student assignment archive (RAR magic bytes, total size 1,048,576 bytes).
````

Hard requirements:

1. Each step uses `### Step N: <action description>` as its heading, with N starting from 1.
2. Each step must contain three sections: `**Request**`, `**Response**` (write `**Response**: no direct echo, see out-of-band evidence` when there is none), and `**Evidence**`.
3. Raw requests/responses must be placed in ```` ```http ```` code blocks; pure JSON may also use ```` ```json ````. Do not substitute plain text for code blocks.
4. The request block must contain at least the request line, `Host` and key headers; the response block must contain the status line, `content-type` and key body.
5. JSON bodies may stay on one line; the UI indents them automatically (no manual formatting needed in Markdown).
6. `**Evidence**` must state deterministic proof (status code + key fields + actual effect), not "suspected" or "possibly".
7. Do not write `reproduction_steps` as a JSON array or object; the legacy array structure is rejected by the schema.

## Retest result specification (important)

When retesting an existing vulnerability, **do not** call `save_vulnerability` again to overwrite the whole record; append with `update_vulnerability`'s `retest`:

```json
update_vulnerability({
  "vuln_id": "VULN-20260101-001",
  "status": "Retest_Passed",
  "retest": {
    "time_range": "2026-01-02 11:03–11:07 (Asia/Shanghai)",
    "conclusion": "### Retest Conclusion\n\n- **Result**: still reproducible\n- **Key evidence**: a request without credentials still returns 200 and a presigned URL\n\n```http\nGET /api/v1/... HTTP/1.1\nHost: opcenter.example.com\n```"
  }
})
```

Rules:

1. `retest.time_range` uses a readable local time range, recommended `YYYY-MM-DD HH:mm–HH:mm (Asia/Shanghai)`.
2. `retest.conclusion` must be **Markdown** produced directly by the model: headings, lists, bold text, tables and ```http / ```json code blocks are all allowed; the UI renders Markdown uniformly. Starting with `### Retest Conclusion` is recommended; do not write your own "first retest / second retest" headings, because the UI adds the ordinal automatically.
3. The UI displays "First retest", "Second retest", ... in append order; the time is on its own line and the conclusion body is indented by two spaces, so no manual spacing is needed in Markdown.
4. A retest only appends to `retest_results` and cannot modify the original fields such as `description`, `impact`, `reproduction_steps`, `remediation` or `test_boundaries`; provide at least one of `retest` and `status`, and you may pass both.
5. It returns `{ success, id, status, retest_index? }`; `retest_index` starts at 0 and is only returned when this call includes `retest`.
6. To change only the status, call `update_vulnerability({ vuln_id, status })`; do not rewrite the whole record just to change the status.
7. Vulnerabilities that have not been retested are shown as "not retested" by the UI; do not write empty retest records as placeholders.

## Save example (field structure)

```json
{
  "host": "opcenter.example.com:443",
  "vuln_name": "Example Cloud Course Student Management System — Arbitrary File Download",
  "severity": "High",
  "target_url": "https://www.example.com/",
  "entry_point": "https://www.example.com/",
  "description": "The team-project download endpoint only checks that file_id is an integer; it lacks authentication and resource-ownership checks.",
  "impact": "Unauthenticated bulk download of student team-project assignment files; file_id is enumerable.",
  "affected_interfaces": [
    "https://opcenter.example.com/api/v1/files/download?file_id=10"
  ],
  "reproduction_steps": "### Step 1: Request the download endpoint anonymously\n\n**Request**\n```http\nGET /api/v1/files/download?file_id=10 HTTP/1.1\nHost: opcenter.example.com\n```\n\n**Response**\n```http\nHTTP/1.1 200 OK\n\n{\"code\":0}\n```\n\n**Evidence**: a request without credentials still returned 200 and a presigned URL.",
  "remediation": ["Add authentication and resource-ownership checks", "Change file_id to a UUID and apply rate limiting"],
  "crypto_details": "None",
  "test_boundaries": "Only enumerated metadata for file_id 1–60; no bulk download was performed.",
  "related_vuln_ids": [],
  "status": "Confirmed"
}
```

## Queries

- `query_vulnerabilities({ host: "opcenter.example.com:443" })` → `{ host, total, items: [{ vuln_id, vuln_name, severity, target_url }] }`, for a quick pre-test review and deduplication.
- `query_vulnerabilities({ vuln_id: "VULN-20260101-001" })` → the complete record, including the Markdown `reproduction_steps` and `retest_results`.
- `query_vulnerabilities({ search?, severity?, status?, page?, pageSize? })` → a paged list `{ items, total, page, pageSize }`, for browsing, filtering and report extraction.
- Mode priority: `vuln_id` first, then `host`; when neither is given, page by filter conditions. Provide at least one of `vuln_id` / `host` / `search` / `severity` / `status`.
- `update_vulnerability({ vuln_id, retest: { time_range, conclusion } })` → appends a retest result and returns `retest_index`.
- `update_vulnerability({ vuln_id, status })` → status transition.

## Error handling

- Parameter validation failures return `isError: true` and a field path (e.g. `host: host must include a port between 1-65535`); fix it per the message and retry.
- Passing an array for `reproduction_steps` raises a type error; pass a Markdown string instead.
- When `query_vulnerabilities` / `update_vulnerability` cannot find an ID, first confirm the correct ID with `query_vulnerabilities({ host })` or `{ search }`.
- Writes return `{ success: true, id, created }`; `created: false` means the same ID was overwritten, and the client may ask for confirmation.
- `update_vulnerability` requires at least one of `status` and `retest`; the returned `retest_index` starts at 0.

## MCP connection troubleshooting (DSH / Codex / Claude Code)

The stdio MCP is launched by the agent, so there is no "is the service online" precondition; connection problems usually come from configuration, the entry file or the database:

1. Run `ctx doctor`: it checks the database path / directory writability / schema version / WAL size, the MCP entry point (development `node` + `out/mcp/stdio.cjs`, installed `<install>\bin\node.exe` + `<install>\bin\mcp-stdio.cjs`) and whether each agent's config exists and is valid.
2. Verify the agent config really uses stdio: `command` points at Node (the system `node` in development mode, `<install>\bin\node.exe` for the installed build), and `args` points at the absolute path of `mcp-stdio.cjs` / `out/mcp/stdio.cjs`; in development mode run `npm run build:mcp` first to generate the entry file.
3. **Restart the agent** after changing the configuration (the MCP client initializes when the agent starts); **restarting the GUI will not fix the MCP connection**, and the GUI can be opened or closed at any time.
4. Database busy / schema too old: open the GUI once so the main process runs the migration, or run `ctx doctor` for details; read-only CLI commands will not migrate for you.
5. If it still fails, set `CTX_MCP_LOG=<log path>` and restart the agent, then check stderr / the log file for startup errors; you can also run `node scripts/mcp-stdio-smoke.mjs` to verify the entry point on its own.
6. Tool names may be namespaced (DSH `mcp__cortex__*`, other clients may show `cortex.*`); call the tool by the name actually exposed; `ctx mcp print-config dsh|codex|claude|cursor` prints the official stdio config snippet.

## Installing into agents (including enforcement)

**Registering the MCP alone is usually not enough**: agent clients do not call a tool merely because it exists. All three layers must be installed together:

1. **MCP server**: start it over stdio so the 6 tools are visible (3 vulnerability tools + 2 asset tools + 1 cognitive snapshot tool);
2. **Skill**: install this file together with `asset-context` and `snapshot` into the agent's skills directory, providing the vulnerability field, Markdown, retest and asset-context specifications;
3. **System-level hard rules**: write "confirmed vulnerabilities must be persisted + assets must be synced after recon + cognitive snapshot" into the agent's global instruction file (DSH `AGENTS.md`, Codex `AGENTS.md`, Claude `CLAUDE.md`).

### Recommended: a single `ctx init` command

```powershell
ctx init                          # detect local agents, show files and diff, back up, then write idempotently
ctx init --dry-run                # only show which files would change; write nothing
ctx init --agents dsh,claude      # only handle the specified agents (dsh / claude / codex / cursor)
```

`ctx init` installs the MCP config, the three skills and the system-level rules, backs files up as `.bak-YYYYMMDD-HHmmss`, validates that the written JSON/TOML/YAML parses, and finally prompts you to restart the agent. Run `ctx doctor` for a self-check after installation.

Compatibility entry point (retained for old scripts and CI):

```powershell
node scripts/install-agent.mjs dsh      # DeepSeek Harness
node scripts/install-agent.mjs codex    # OpenAI Codex CLI
node scripts/install-agent.mjs claude   # Claude Code
node scripts/install-agent.mjs all      # all of them
```

You can also copy the config snippet from the corresponding agent card on the MCP Access page (same generator and same paths as `ctx mcp print-config`).

### Installation locations per agent

| Agent | MCP config | Skill directory | System-level enforcement rules |
| --- | --- | --- | --- |
| DeepSeek Harness | `@deepseek-ai/dsh-mcp-client` in `~/.dsh/profiles/<profile>/cordis.patch.yml` (stdio: `node` + `<entry>`) | `~/.agents/skills/vuln-db/SKILL.md` | `~/.dsh/AGENTS.md` |
| Codex CLI | `[mcp_servers.cortex]` in `~/.codex/config.toml` (stdio) | `~/.codex/skills/vuln-db/SKILL.md` and `~/.agents/skills/vuln-db/SKILL.md` | `~/.codex/AGENTS.md` |
| Claude Code | `claude mcp add --transport stdio cortex -- <node> <entry>` | `~/.claude/skills/vuln-db/SKILL.md` and `~/.agents/skills/vuln-db/SKILL.md` | `~/.claude/CLAUDE.md` |
| Cursor | `mcpServers` in `~/.cursor/mcp.json` (stdio) | Installed by `ctx init` according to client capabilities | — |

> The stdio MCP is launched by the agent, so no desktop app needs to stay running; closing the GUI does not affect MCP reads/writes. Restart the corresponding agent after changing the config or installing the skill / rules.

### Post-install self-check

1. Restart the agent; confirm the 6 tools are present in the tool list: `save_vulnerability`, `query_vulnerabilities`, `update_vulnerability`, `sync_asset_info`, `query_asset_context`, `manage_snapshot`.
2. Ask the agent to run `query_vulnerabilities`, `query_asset_context` and `manage_snapshot({ action: "list" })` once (read-only) to confirm the link works.
3. Confirm a test vulnerability and watch whether the agent proactively calls `save_vulnerability` before replying; if it still does not, check whether the system-level rules file is actually loaded by the agent (rule file paths differ between clients). After asset recon it should likewise call `sync_asset_info`; for retests only append via `update_vulnerability`.
4. If tools are missing or the connection drops, run `ctx doctor`, check each item in "MCP connection troubleshooting", then restart the agent.

### Manual installation (either option)

- Generic stdio MCP config (usable directly by Cursor and similar clients; for the installed build, replace `command` with `<install>\bin\node.exe` and the entry with `<install>\bin\mcp-stdio.cjs`):
  ```json
  {
    "mcpServers": {
      "cortex": {
        "command": "node",
        "args": ["<project>/out/mcp/stdio.cjs"]
      }
    }
  }
  ```
- Manual skill installation: copy this file to the matching skill directory in the table above.
- Manual enforcement rules: append the entire "Hard rules (MUST)" section from the top of this file to the agent's global instruction file (DSH `~/.dsh/AGENTS.md`, Codex `~/.codex/AGENTS.md`, Claude `~/.claude/CLAUDE.md`).
- Data location: Windows `%USERPROFILE%\.cortex\data.db`, macOS/Linux `~/.cortex/data.db`; set `CTX_DB_PATH` to isolate multiple databases (the legacy `PDH_DB_PATH` still works).
