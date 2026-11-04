---
name: internal-ops
description: "[MUST] After taking a Web entry, register footholds / internal hosts / services / credentials / pivots with sync_internal_scope (schema v3); internal vulnerabilities still go through save_vulnerability (realm=\"internal\" + service_host + internal_service_id); order is entry finding → foothold → hosts/services → credentials → pivots; credentials are masked, Loot is parsed locally only, and Cortex never actively scans / logs in / exploits."
---

# Skill: Internal Operations

Cortex keeps **Web assets** (`assets`, where `host_port` is a URL) logically isolated from the **internal operations domain**: footholds, internal hosts / services / credentials / pivots have their own entities and IDs, but are **never promoted to top-level Web assets**. The only bridge is a **Foothold** — an entry Web asset plus the initial access method (RCE / webshell / SSRF proxy / credential / VPN). The main vulnerability dashboard shows Web findings only (`realm='web'`); internal findings live in the separate **Internal Operations** page.

The internal domain is written through **one new MCP tool**, `sync_internal_scope` (Cortex now exposes **7 MCP tools** in total). Reading uses `query_asset_context` with `include_internal` / `include_credentials` and `query_vulnerabilities` with the `realm` filter; internal vulnerabilities still go through `save_vulnerability`; Loot is parsed locally by the CLI / desktop app only. Cortex **never actively scans, never logs in automatically and never exploits**: the heatmap, credential matrix and route view are all derived from agent-reported data.

## Hard rules (MUST, higher priority than the rest of this skill)

1. **Fixed order**: `query_asset_context({ host_port })` to inspect existing context → `save_vulnerability` for the entry RCE / initial access (`realm="web"`) → `sync_internal_scope` registers the foothold (with `entry_vuln_id`) → hosts (collect the `IH-*` IDs) → services (use the returned `IH-*` as `host_id`) → credentials → pivots → then `save_vulnerability` for internal findings (`realm="internal"` + `service_host` + `internal_service_id`).
2. **RCE ≠ compromise**: the entry RCE is only a vulnerability record; you must also create a foothold that records access type, privilege level, status, evidence and time. Internal entities without a foothold have no owner.
3. **Multiple entries, multiple paths**: one entry asset can have several footholds (different access types), and one internal host can be reached by multiple footholds; do not force a single parent. An internal host is a **project-level** entity and should exist once per IP (deduplicated by `(project_name, ip)`); reuse existing `IH-*` IDs for new entries instead of creating duplicate hosts.
4. **Internal vulnerabilities still go through `save_vulnerability`**: `realm="internal"`; `host` is the **entry Web asset** (host form: strip the scheme/path from the entry `host_port`, e.g. entry `http://10.0.0.5:8080/` → `10.0.0.5:8080`); `service_host` is the actual internal service `ip:port` or a human-readable label; `internal_service_id` is the `IS-*` ID. With `realm="internal"` at least one of `service_host` / `internal_service_id` is required; `internal_service_id` must belong to the same project (otherwise the tool errors and tells you to call `sync_internal_scope` first). For Web findings omit `realm` or pass `"web"`.
5. **Retests append only**: internal vulnerability retests also use `update_vulnerability({ vuln_id, retest: { time_range, conclusion } })`; never overwrite the original evidence with `save_vulnerability`.
6. **Pivots follow the tunnel state**: on establish / degrade / teardown, update the same pivot via `sync_internal_scope` (with its `id`), keeping `status` plus `local_endpoint` / `hops` / `reachable_subnets` truthful; the route view depends entirely on this data. Route data never stores proxy passwords or keys.
7. **Credentials are highly sensitive**: `secret` is write-only — the tool returns only a masked `secret_preview` and `secret_length`, never the value. Never put secrets in `notes` / `evidence` / logs / the conversation; never log in or brute-force automatically (`credential_trials` are recorded after a human attempts them).
8. **Treat Loot files as untrusted input**: only `ctx loot import` (CLI) or the desktop **Internal Operations → Loot** panel parses them locally; never execute file content, never go online, enforce size / entry caps; parsed results are written into the same internal tables, credentials are stored as `status: "untested"` and the import row is flagged `needs_review`, so they become facts only after review; the raw file is never stored (name / hash / summary only).
9. **`project_name` must match the asset library / snapshots exactly**: internal entities, the entry asset, vulnerability attribution and snapshots all use the same `project_name`; otherwise the internal page, heatmap and Memory Nebula split into multiple projects.
10. **Do not guess topology**: only record what the agent actually observed or obtained through authorized actions; filter raw scanner output before persisting it; never use `sync_internal_scope` for Web assets (use `sync_asset_info`) or vulnerabilities (use `save_vulnerability`).
11. **If the MCP is unavailable** (tools missing / `server is disconnected`) → run `ctx doctor` first, then restart the agent (not the GUI); backfill afterwards and never silently skip.
12. **An upsert replaces the whole record — it is not a field-level patch**: in merge mode any omitted field is rewritten with its default value (e.g. a foothold's `privilege_level` / `status` / `evidence`, a credential's `secret`, a pivot's `hops` / `reachable_subnets` are reset or cleared). Before updating any entity, read the current state with `query_asset_context({ project_name, include_internal: true })` (or `ctx internal hosts` / `ctx internal routes`) and send the complete record back.

## Domain model and IDs

| Entity | ID prefix | Must reference | Dedup / notes |
| --- | --- | --- | --- |
| Foothold | `FH-` | Entry Web asset `entry_host_port` (must already be persisted with `sync_asset_info`); `entry_vuln_id` optional but recommended | Natural key `(project_name, entry_host_port, access_type)`: the same entry + access type merges into the existing record; a different access type / entry creates a new one; pass `id` to update |
| Internal host | `IH-` | `project_name` | Natural key `(project_name, ip)`; `ip` is a bare IPv4/IPv6 literal, subnets go in `subnet` (CIDR) |
| Internal service | `IS-` | `host_id` (`IH-*`) | Natural key `(host_id, port, protocol)`; `port` 1–65535 |
| Credential | `CR-` | `project_name`; may link `host_id` / `service_id` | Natural key `(project, type, username, domain, secret)`; `secret` is sensitive, reads return a masked preview only |
| Pivot | `PV-` | `foothold_id` (`FH-*`) | Natural key `(foothold_id, kind, local_endpoint.host, local_endpoint.port)`; `hops` reference `IH-*` / `IS-*` in the same project; `reachable_subnets` uses CIDR |
| Loot import | `LT-` | CLI / desktop import only | Created only by the Loot flow; the MCP never writes it |

- Per-project caps: hosts ≤300, services ≤1000, credentials ≤500, pivots ≤100, footholds ≤100; hops ≤20 per route, `reachable_subnets` ≤20 per pivot; views over the cap return `truncated`.
- Per-call caps: footholds ≤50, hosts ≤500, services ≤2000, credentials ≤500, pivots ≤100; split the calls when over.

## When to call sync_internal_scope

- After initial access is confirmed: RCE / webshell / SSRF proxy / usable credential / VPN entry → create the foothold first;
- When new internal hosts, ports or services are discovered → hosts first, then services (`host_id` from the returned `IH-*`);
- When credentials are obtained (plaintext password / NTLM hash / NetNTLMv2 / Kerberos ticket / SSH key / certificate / API key);
- When a tunnel is established, changes state or is torn down (pivot `planned` → `established` → `degraded` → `lost`);
- When the entry state changes (foothold lost, privilege escalated, a second entry appears);
- When explicitly deleting mistakenly recorded data (`removed`).

**Do not call it for**: unconfirmed guesses, unfiltered raw scanner output, Web assets / endpoints (use `sync_asset_info`), vulnerabilities (use `save_vulnerability`) or snapshot progress (use `manage_snapshot`).

## Recommended workflow (examples)

### 0. Entry: inspect context first, then save the entry finding

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
  "reproduction_steps": "### Step 1: run id via the script console\n\n**Request**\n```http\nPOST /script HTTP/1.1\nHost: 10.0.0.5:8080\n\nscript=println(%22id%22.execute().text)\n```\n\n**Response**\n```http\nHTTP/1.1 200 OK\n\nuid=0(root) gid=0(root)\n```\n\n**Evidence**: unauthenticated command execution with root output."
})
```

Note the returned `id` (e.g. `VULN-20261103-001`); it becomes `entry_vuln_id` in the next step.

### (a) Register a foothold + internal hosts, then services

Step one: foothold + hosts. **Do not send services yet** — their `host_id` needs the `IH-*` returned by the hosts step.

```json
sync_internal_scope({
  "project_name": "Starport Portal logistics customer portal lab",
  "mode": "merge",
  "footholds": [{
    "entry_host_port": "http://10.0.0.5:8080/",
    "entry_vuln_id": "VULN-20261103-001",
    "access_type": "rce",
    "privilege_level": "admin",
    "status": "established",
    "evidence": "script console executed id -> uid=0(root)",
    "established_at": "2026-11-03T10:00:00+08:00"
  }],
  "hosts": [
    { "ip": "10.0.1.10", "hostname": "jump", "os": "linux", "subnet": "10.0.1.0/24", "state": "compromised", "source": "agent", "confidence": "high" },
    { "ip": "10.0.1.20", "hostname": "db01", "os": "linux", "subnet": "10.0.1.0/24", "state": "alive", "source": "agent", "confidence": "medium" }
  ]
})
```

Returns (abridged): `{ "project_name": "...", "created": { "footholds": 1, "hosts": 2, "...": 0 }, "updated": { "...": 0 }, "ids": { "footholds": ["FH-..."], "hosts": ["IH-...", "IH-..."], "...": [] }, "warnings": [] }`.

Step two uses the returned `ids.hosts` to register services:

```json
sync_internal_scope({
  "project_name": "Starport Portal logistics customer portal lab",
  "mode": "merge",
  "services": [
    { "host_id": "IH-...", "port": 22, "protocol": "tcp", "service": "ssh", "state": "open", "source": "agent" },
    { "host_id": "IH-...", "port": 6379, "protocol": "tcp", "service": "redis", "state": "open", "source": "agent" }
  ]
})
```

To let the foothold record which hosts it reaches, update it once more with `id` and **resend every field** — `entry_host_port` / `access_type` are required, and omitting `privilege_level` / `status` / `evidence` resets them to defaults (`host_ids` is unioned in merge mode and taken as authoritative in replace mode):

```json
sync_internal_scope({
  "project_name": "Starport Portal logistics customer portal lab",
  "mode": "merge",
  "footholds": [{
    "id": "FH-...",
    "entry_host_port": "http://10.0.0.5:8080/",
    "entry_vuln_id": "VULN-20261103-001",
    "access_type": "rce",
    "privilege_level": "admin",
    "status": "established",
    "evidence": "script console executed id -> uid=0(root)",
    "established_at": "2026-11-03T10:00:00+08:00",
    "host_ids": ["IH-...", "IH-..."]
  }]
})
```

> If you really need a single call, give hosts your own explicit `id` (keep the `IH-` prefix) and reference it from services; but `entry_host_port` must be an already-persisted entry asset (run `sync_asset_info` first).

### (b) Register a second foothold (same internal host / same entry)

When a second entry (or a second access method on the same entry) reaches the same internal host, **reuse the existing `IH-*`** instead of creating a duplicate host:

```json
sync_internal_scope({
  "project_name": "Starport Portal logistics customer portal lab",
  "mode": "merge",
  "footholds": [{
    "entry_host_port": "http://10.0.0.7:3000/",
    "entry_vuln_id": "VULN-20261103-004",
    "access_type": "ssh_key",
    "privilege_level": "user",
    "status": "established",
    "evidence": "id_rsa leaked in Gitea logs in as deploy on jump",
    "host_ids": ["IH-..."]
  }],
  "credentials": [{
    "type": "ssh_key",
    "username": "deploy",
    "secret": "-----BEGIN OPENSSH PRIVATE KEY-----...",
    "source": "gitea repo: infra/ansible deployment repository",
    "host_id": "IH-...",
    "confidence": "high",
    "status": "valid"
  }]
})
```

- The same entry asset can also have several footholds: omit `id`, change `access_type` and call again — the old record is not overwritten; the same entry + the same `access_type` updates the existing record through the natural key;
- To update an existing foothold, pass its `id` and resend every field (see hard rule 12).

### (c) Save an internal vulnerability (save_vulnerability)

```json
save_vulnerability({
  "host": "10.0.0.5:8080",
  "service_host": "10.0.1.10:6379",
  "internal_service_id": "IS-...",
  "realm": "internal",
  "vuln_name": "Redis unauthenticated access",
  "vuln_type": "Unauthenticated Access",
  "severity": "High",
  "target_url": "redis://10.0.1.10:6379",
  "description": "Reached internal Redis through the SOCKS tunnel built on the foothold; commands run without authentication.",
  "reproduction_steps": "### Step 1: connect to internal Redis through the SOCKS5 tunnel\n\n**Request**\n```http\nGET / HTTP/1.1\nHost: 10.0.1.10:6379\n\nINFO\n```\n\n**Response**\n```http\nHTTP/1.1 200 OK\n\nredis_version:7.2.0\n```\n\n**Evidence**: INFO returned without authentication; CONFIG SET can write files."
})
```

- `host` is the **entry asset** (the finding is attributed to the entry asset and does not appear in the Web dashboard view);
- `internal_service_id` must have been registered with `sync_internal_scope` first, otherwise the tool errors and tells you to;
- Web findings: `realm="web"` (or omitted), `service_host=""`, `internal_service_id=""`.

### (d) Register / update a pivot (tunnel up and down)

Register the pivot after the tunnel is up (keep the returned `PV-*`):

```json
sync_internal_scope({
  "project_name": "Starport Portal logistics customer portal lab",
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

When the tunnel degrades or is torn down, update the **same** pivot: pass its `id` and resend `foothold_id` / `kind` / `local_endpoint` / `hops` / `reachable_subnets` / `tool` — a pivot's `hops` and `reachable_subnets` are **replaced as a whole** on every write, so omitting them clears the route:

```json
sync_internal_scope({
  "project_name": "Starport Portal logistics customer portal lab",
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
    "notes": "tunnel down: chisel process cleaned up, 127.0.0.1:1080 no longer answers"
  }]
})
```

### (e) Cleanup with explicit `removed`

```json
sync_internal_scope({
  "project_name": "Starport Portal logistics customer portal lab",
  "removed": {
    "service_ids": ["IS-..."],
    "host_ids": ["IH-..."],
    "pivot_ids": ["PV-..."],
    "credential_ids": ["CR-..."],
    "foothold_ids": ["FH-..."]
  }
})
```

- Use `removed` only for **mistakenly recorded or genuinely unwanted** rows; to preserve history prefer setting the foothold / pivot status to `lost` / `degraded`;
- Deleting a host cascades to its services; deleting a foothold cascades to its pivots and hops; deleting a credential cascades to its trials; a credential's `service_id` is set to null when its service is deleted.

## Mode semantics (merge / replace / removed)

| Mode | Behavior | Deletion |
| --- | --- | --- |
| `merge` (default) | Upsert by `id`; without an `id`, upsert by natural key (see the natural-key list below); entities not mentioned stay untouched | Never deletes (unless `removed`) |
| `replace` | Only the arrays passed in this call are replaced as a whole: records of that entity kind **not present in the array are deleted**; arrays not passed stay untouched | Same as left + `removed` |
| `removed` | Honored in both modes; deletes by explicit ID | Explicit deletion |

- **Never do a "wipe the whole project" replace**: a `replace` without any arrays deletes nothing; to clear data use `removed`.
- Before using `replace`, read the current full state with `query_asset_context({ project_name, include_internal: true })` so you cannot accidentally delete rows by omission; use `merge` for everyday incremental syncs.
- An upsert **replaces the whole record**, it is not a field-level patch: omitted fields are rewritten with their defaults (hard rule 12).
- Natural keys: foothold `(project, entry_host_port, access_type)`, host `(project, ip)`, service `(host_id, port, protocol)`, credential `(project, type, username, domain, secret)`, pivot `(foothold_id, kind, local_endpoint.host, local_endpoint.port)`; a matching natural key updates the row instead of creating a new one.
- Example return value:

```json
{ "project_name": "Starport Portal logistics customer portal lab", "created": { "footholds": 0, "hosts": 0, "services": 2, "credentials": 0, "pivots": 0 }, "updated": { "footholds": 1, "hosts": 0, "services": 0, "credentials": 0, "pivots": 0 }, "ids": { "footholds": ["FH-..."], "hosts": ["IH-..."], "services": ["IS-...", "IS-..."], "credentials": [], "pivots": [] }, "warnings": [] }
```

- `warnings` reports ignored items / bad references; the `created` / `updated` counters confirm whether the write touched the intended rows.

## Internal vulnerability field specification (save_vulnerability)

| Field | Value for internal findings |
| --- | --- |
| `host` | The **entry Web asset** (host form: strip the scheme/path from the entry `host_port`, e.g. `10.0.0.5:8080`); not the internal IP |
| `service_host` | The actual internal service: `ip:port` (e.g. `10.0.1.10:6379`) or a human-readable label (e.g. `jump`, `redis:6379`) |
| `internal_service_id` | The structured `IS-*` link; must be in the same project and already registered by `sync_internal_scope` |
| `realm` | Internal findings must be `"internal"` (when omitted, a non-empty `service_host` infers internal, but pass it explicitly) |
| `target_url` | The actual trigger address, e.g. `redis://10.0.1.10:6379` or an `http://10.0.1.20:8080/...` URL reached through the tunnel |
| `reproduction_steps` | Standard Markdown (`### Step N` + **Request** / **Response** / **Evidence**), stating how the target is reached through the foothold / tunnel |

- Query internal findings with `query_vulnerabilities({ realm: "internal" })`; the default is `all` (backwards compatible) and the main dashboard defaults to `web`;
- Deduplicate by `host` + `service_host` (keep one primary record per internal service under the same entry asset);
- When the exploit chain changes, append a retest via `update_vulnerability` instead of creating a duplicate finding.

## Reading internal context

- `query_asset_context({ host_port, include_internal: true })` → the footholds + reachable hosts / services / pivots summary for that entry asset;
- `query_asset_context({ project_name, include_internal: true })` → the project-level summary (max 50 rows per kind by default, with `counts` and `truncated` when cut);
- `include_credentials: true` is required to get credentials, and even then only `secret_preview` / `secret_length` (masked); it is off by default to avoid context bloat and secret exposure;
- Without these switches **no internal data is returned**, keeping older agents' context unchanged.

## Credential masking and security

- On write: provide only the necessary fields (`type` / `username` / `domain` / `secret` / `source` / `host_id` / `service_id` / `confidence` / `status` / `notes`); `notes` holds source and purpose only — never the password / hash itself.
- On read: `Credential` exposes only `secret_preview` + `secret_length`, never `secret`; the UI / CLI mask by default and copying requires an explicit action.
- On use: Cortex never connects, logs in or brute-forces automatically; `credential_trials` (attempted / success / failed / blocked) are recorded by the desktop app / API after a human attempt (not an MCP tool).
- The credential-service matrix "candidates" come from a deterministic local rule engine (`ntlm_hash` + SMB → Pass-the-Hash candidate; `netntlmv2` cannot be used for PtH, relay / crack only; `password` + RDP / SSH / WinRM / MSSQL → login candidate; `ssh_key` + SSH → key login candidate…). Every candidate carries reason / caveat / confidence and is labelled "a suggestion, not a conclusion".

## Loot rules (local parsing only)

- Only two entry points: CLI `ctx loot import <file> --project <name> [--entry <host_port>] [--format auto]` and the desktop **Internal Operations → Loot** panel; **never import through MCP**.
- Files are untrusted: enforce file / uncompressed size and entry-count caps, prevent zip-slip, never go online, never execute anything, never store the raw file in the database (name / hash / summary only).
- Parsers: `bloodhound-json` / `secretsdump-text` / `config-env` / `generic-csv`; unknown formats go to `needs_review`, parse failures go to `failed` with an error.
- Parsed results are written into the same internal tables (hosts / services / credentials); credentials are stored as `status: "untested"` and the import row is flagged `needs_review`, so they only become facts after human review; **never auto-try credentials from Loot results**.
- Inspect: `ctx loot list --project <name>`; read-only internal queries `ctx internal overview|hosts|routes --project <name>`; all accept `--json`, are read-only and never modify the database.

## Validation and error handling (all return `isError: true`; fix the input and retry)

| Error / symptom | Fix |
| --- | --- |
| Invalid `ip` | Pass a bare IPv4/IPv6 literal (`10.0.1.10`, `2001:db8::10`), no CIDR; put networks in `subnet` |
| Invalid `subnet` / `reachable_subnets` | Must be a valid CIDR (`10.0.1.0/24`, `2001:db8::/64`) |
| Missing / unknown `host_id` | Register hosts first and use the returned `ids.hosts` as `host_id`; never invent an `IH-*` |
| Unknown `foothold_id` | Register the foothold first and use the returned `FH-*` |
| Unknown hop `ref_id` | Register the corresponding `IH-*` / `IS-*` or fix `ref_id` |
| `realm="internal"` but both `service_host` and `internal_service_id` are empty | Provide `service_host`, or register the service and pass `internal_service_id` |
| `internal_service_id` is not in this project / does not exist | Register the service with `sync_internal_scope` first, or fix `project_name` |
| Updating a foothold / pivot is rejected | The strict schema still requires the mandatory fields: foothold needs `entry_host_port` + `access_type`, pivot needs `foothold_id` + `kind` |
| Unknown field rejected | Inputs are strict objects; remove typo'd / non-existent fields |
| Per-call cap exceeded | footholds ≤50, hosts ≤500, services ≤2000, credentials ≤500, pivots ≤100; split the call |
| Data disappeared after `replace` | You synced only part of the entity kind and it was replaced; use `merge` or pass the complete array |
| `removed` IDs did not match | A warning is returned; confirm the real IDs with `query_asset_context` / `ctx internal hosts` |
| `removed` ID belongs to another project | Hard error (cross-project deletion is rejected); check `project_name` and the ID |
| `entry_host_port` does not exist | The call errors and asks you to register the entry asset first: `sync_asset_info` the Web asset, then create the foothold; `project_name` should match the entry asset (a mismatch returns a warning) |
| `entry_vuln_id` not persisted | A warning is returned but the foothold is still recorded; save the entry finding with `save_vulnerability` first |
| Fields / routes "disappeared" after an update | Upserts replace the whole record: resend every field; a pivot must include `hops` / `reachable_subnets` |

## Common mistakes

- ❌ Treating RCE as a compromise: only calling `save_vulnerability` without creating a foothold leaves internal entities unowned;
- ❌ Registering hosts / services / pivots without a foothold;
- ❌ Registering the same IP as several internal hosts (reuse the `IH-*`; `merge` deduplicates by `(project, ip)`);
- ❌ Registering services before hosts return `IH-*`, or hand-writing a `host_id` that does not exist;
- ❌ Using `sync_internal_scope` for Web assets / endpoints / vulnerabilities (use `sync_asset_info` / `save_vulnerability`);
- ❌ Omitting `realm` / `service_host` / `internal_service_id` on internal findings so they leak into the main vulnerability library;
- ❌ Putting an internal IP in `host` (`host` must be the entry asset; internal services belong in `service_host`);
- ❌ Rewriting original fields on retest (use `update_vulnerability` with `retest`);
- ❌ Writing `secret` into `notes` / `evidence` / logs / the conversation, or echoing it in a reply;
- ❌ Letting the agent try credential logins / brute-force automatically;
- ❌ Not updating pivot state on tunnel up / down, leaving the route view inconsistent with reality;
- ❌ Using `replace` as a "full sync" while omitting entities → accidental deletion;
- ❌ Treating a merge upsert as a field-level patch: sending only `id` + one or two fields on update, so the other fields fall back to defaults (a pivot's `hops` / `reachable_subnets` are cleared);
- ❌ Persisting unfiltered raw scanner output (only record hosts / services with real operational value);
- ❌ Using a different `project_name` for internal entities than the entry asset / snapshots.

## Pre-flight checklist

- [ ] The entry finding is saved with `save_vulnerability` and the foothold carries `entry_vuln_id`;
- [ ] Hosts are registered before services, and every `host_id` comes from a return value, not a guess;
- [ ] Current state was read before updating and every field is resent; pivot status updates include `hops` / `reachable_subnets`;
- [ ] No duplicate hosts / services; `project_name` matches the asset library and snapshots exactly;
- [ ] Internal findings carry `realm="internal"` + `service_host` / `internal_service_id` and do not appear in the Web dashboard;
- [ ] Pivot status matches the real tunnel (`established` / `degraded` / `lost`);
- [ ] `secret` is written only into the `secret` field — notes / logs / conversation contain no plaintext;
- [ ] Loot results are reviewed and credentials were not used automatically;
- [ ] No unconfirmed data / raw scanner output was persisted as fact.
