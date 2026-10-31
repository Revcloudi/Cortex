---
name: snapshot
description: "[MUST] Before resuming a task in a new session, restore tactical progress with manage_snapshot list → load (project session → child session); save when a phase completes, context is nearly full, or the session ends; only create child sessions for valuable reachable targets; archiving/deletion is desktop-only."
---

# Skill: Cognitive Snapshot

Cortex's cognitive snapshots record the tactical progress of a task: project / target hosts / phase, unfinished tasks, failed paths, next steps, plus the structured endpoint test matrix `tested_interfaces`, Markdown notes `notes` and related vulnerability references `related_vuln_ids`. A snapshot records only **tactical progress + test conclusions** and does not re-store vulnerability evidence or raw messages.

It is operated through a single tool, `manage_snapshot` (DSH: `mcp__cortex__manage_snapshot`), with `action` = `save` / `load` / `list` / `attach_assets` / `restore_previous`; the total number of tools remains 6. Sessions do not keep a version history — only one `previous_state` for a single-step rollback; a project has at most one level of child sessions, and do not maintain multiple sibling sessions for the same task in parallel.

## Hierarchy: project session → child session (one level only)

| Level | Purpose | How to create |
| --- | --- | --- |
| Project session (root) | Large SRC / project root: scope, exclusion ledger, overall progress | `save` without `parent_session_id` |
| Child session (child) | One system / sub-project: independent tactical progress | `save` + `parent_session_id: <root session_id>` |

- Only one level is allowed: a child session cannot create another child session; `parent_session_id` is passed only at creation time, and the parent-child relationship cannot be changed afterwards.
- Before creating a child session, first run `list({ keyword, roots_only: true })` to confirm the project session; if a session already exists for the project, let the user choose per `SESSION_EXISTS`.
- `load` on a project session returns `session` + `children` (child session summaries): the agent shows the `children` summaries to the user, then `load`s the chosen child session.

## Value threshold (prevent asset / session explosion)

Only Web assets that satisfy all 4 conditions are persisted with `sync_asset_info` and get a child session:

1. in the authorized scope; 2. HTTP-reachable (real page / endpoint); 3. has a real business or attack surface (login / API / upload / admin / SSO / sensitive data); 4. has reuse or testing value (will be tested again / handed over).

Anything that does not qualify is never written to the asset library and gets no child session: unreachable, parked pages, default pages / welcome pages, pure static sites, CDN / static-resource domains, duplicate domains (same system), out-of-scope targets.

- Do not create a record for each excluded item: maintain a "scope ledger" in the **project session's `notes`**, summarizing reasons / counts / items to verify;
- Never create one child session per host; merge multiple domains of the same system into the same child session / asset entry;
- Asset persistence and upstream rules follow the `asset-context` skill.

## When to use

- Before resuming a task in a new session / new conversation → `list` → `load` to restore;
- A phase completes, context is nearly full, the session ends, or the user asks to save progress → `save`;
- Task objectives, hosts, failed paths or next steps change materially → `save`;
- A new valid target host needs to be merged in → `attach_assets`;
- An overwrite went wrong / the state is abnormal → `restore_previous` for a single-step rollback.

## Hard rules (MUST, higher priority than the rest of this skill)

1. **Hierarchy compliance**: the project session is the root; a child session must be created with `parent_session_id`, one level only. Run `list` before creating one to confirm the project, and do not create duplicate sessions with the same name.
2. **Value threshold**: only persist / create child sessions for Web assets that are "in scope + reachable + have an attack surface + worth reusing"; record excluded items in the project session's `notes` scope ledger, **do not create a record for each**, and never create a child session per host.
3. **Fill all 9 fields at creation** (`project_name` / `target_hosts` / `current_phase` / `unfinished_tasks` / `failed_paths` / `tested_interfaces` / `notes` / `related_vuln_ids` / `next_steps`); arrays / notes may be empty, but the keys cannot be omitted.
4. **Update with `session_id` + only the changed fields**; fields not passed stay unchanged; arrays are replaced wholesale (`[]` clears them).
5. **`SESSION_EXISTS` must be presented to the user**: it returns `{ success: false, requires_choice: true, code: "SESSION_EXISTS", candidates }`; show the candidates to the user and let them choose "continue the existing session (save + session_id)" or "create a new one (save + force_new: true)"; never guess.
6. **Restore flow**: `list` (`keyword` / `roots_only`) → `load(project)` to view `children` → the user picks a child session → `load(child)`. **Load only one complete session at a time**; do not batch-load. **Skipping list → load and continuing from memory is a violation.**
7. **Archiving / deletion is done by the user in the desktop app only** (the MCP has no such action, and the agent cannot delete). Archived sessions do not appear in `list` by default (`include_archived: true` shows them, and `load` can still view them); an archived session cannot be modified with `save` / `attach_assets` / `restore_previous`, so prompt the user to unarchive it in the UI.
8. **Division of responsibilities**: vulnerability details / HTTP messages / reproduction steps / remediation → `save_vulnerability`; endpoint directory / complete raw requests / tech stack / sensitive leaks → `sync_asset_info`; a snapshot holds only test conclusions (`tested_interfaces`), notes (`notes`) and related IDs (`related_vuln_ids`). Large message dumps and screenshots do not go into a snapshot.
9. **Payload limits**: the whole serialized payload ≤32,000 characters; `tested_interfaces` ≤50 entries (`target` ≤300 / `method` ≤300 / `result` ≤500), `notes` ≤8,000 characters, `related_vuln_ids` ≤100. If over the limit, compress `notes` and trim the matrix first.
10. **Asset ownership uses `attach_assets`** (deduplicated and merged into `target_hosts`); do not rewrite a session elsewhere with save.
11. **Rollback only via `restore_previous`** (single step; confirm with the user before executing; after a rollback `previous_state` is cleared, so consecutive rollbacks are not possible).
12. **Optimistic locking**: pass `base_updated_at` on update (the `updated_at` this change is based on); a `STALE` response means the session has changed, so you must `load` it again before editing.
13. **If the MCP is unavailable** (tools missing / `server is disconnected`) → run `ctx doctor` first, confirm the agent launches the MCP over stdio (development `node <project>/out/mcp/stdio.cjs`, installed `<install>\bin\node.exe` + `mcp-stdio.cjs`) and that the database path is correct, then **restart the agent** (not the GUI); if the database is busy / the schema is too old, open the GUI once or run `ctx doctor`. Do not pretend the save succeeded / silently skip; if the user explicitly says not to save, follow their instruction.
14. **Save timing**: when a phase completes, context is nearly full, the session is ending, or the user asks to save progress, you must `save`; ending the task without the required save = the task is not complete.

## Field specification (payload)

Fill all 9 fields at creation (arrays / notes may be empty, but keys cannot be omitted):

| Field | Type | Limit | Description |
| --- | --- | --- | --- |
| `project_name` | string | 1–120 | Project / system name, used to locate the session |
| `target_hosts` | string[] | 1–50, each ≤255 | Target hosts of this task; append later with `attach_assets` |
| `current_phase` | string | ≤200 | Current phase, e.g. "JS endpoint audit" or "access control verification" |
| `unfinished_tasks` | string[] | ≤20, each ≤500 | Unfinished items; remove completed ones |
| `failed_paths` | string[] | ≤20, each ≤500 | Paths already proven failed / infeasible, to avoid repeating the same effort |
| `tested_interfaces` | object[] | ≤50 entries | Test matrix `{ target, method, result }`: target ≤300 required, method ≤300, result ≤500; conclusions only |
| `notes` | string (Markdown) | ≤8,000 chars | Commands, payloads, response snippets, JS clues, observations, scope ledger |
| `related_vuln_ids` | string[] | ≤100 | IDs already persisted in the vulnerability DB; do not copy the evidence |
| `next_steps` | string | ≤2000 | Next-step plan; may contain Markdown lists |

> Overall limit: the serialized payload ≤32,000 characters (the server rejects anything larger). `tested_interfaces` is a **test matrix**, not an endpoint inventory: the authoritative record of endpoint paths / methods / raw requests lives in the asset library.

Session response fields: `session_id`, `parent_session_id` (null for root), `archived_at` (null = not archived), `child_count`, `has_previous_state`, `created_at` / `updated_at` + all payload fields.

Summaries (`list` items / `children`) do not include the full arrays: `session_id`, `project_name`, `current_phase`, `target_hosts`, `parent_session_id`, `archived_at`, `child_count`, `unfinished_count`, `failed_count`, `tested_interface_count`, `next_steps_excerpt`, `has_previous_state`.

## `list` parameters and recovery

| Parameter | Description |
| --- | --- |
| `keyword` | Fuzzy filter by project / phase |
| `roots_only` | Return only project sessions (roots) |
| `parent_session_id` | Return only the child sessions of a given project session |
| `include_archived` | Include archived sessions (default false; archived ones are hidden) |
| `limit` | 1–50 |

Restore order: `list` → `load(project)` → view the `children` summaries → the user picks a child session → `load(child)`; load only one complete session at a time, and do not load every child session of the same project into context.

## Partial update semantics

- Missing fields (`undefined`) → keep the original value; arrays are replaced wholesale: pass `[]` to clear `unfinished_tasks` / `failed_paths` / `tested_interfaces` / `related_vuln_ids`, while `target_hosts` must keep at least 1; strings `notes` / `current_phase` / `next_steps` are replaced wholesale.
- Strict object; unknown fields are not allowed; every save re-validates the whole payload ≤32,000 characters; before overwriting, the previous version goes into `previous_state` (one version only).
- To append a test record, pass the old array back along with the new one (`load` first, then edit); `parent_session_id` is passed only at creation time.

## Examples

Creating a child session (same for a project session, omitting `parent_session_id`):

```json
manage_snapshot({
  "action": "save",
  "parent_session_id": "SESS-20260101-001",
  "payload": {
    "project_name": "Example Cloud Course-opcenter",
    "target_hosts": ["opcenter.example.com"],
    "current_phase": "access control verification",
    "unfinished_tasks": ["Haven't verified the file_id enumeration range on the download endpoint"],
    "failed_paths": ["SQL injection on /api/v1/login (parameterized queries, ruled out)"],
    "tested_interfaces": [
      {
        "target": "POST /api/v1/.../download/cooperation/project/",
        "method": "No Cookie, enumerated file_id 1–60",
        "result": "200, returned presigned URLs for other users' projects, saved as VULN-20261031-001"
      }
    ],
    "notes": "### Clues\n- Full HTTP messages are in the vulnerability DB, VULN-20261031-001\n- admin subdomain 302 → SSO, to be verified",
    "related_vuln_ids": ["VULN-20261031-001"],
    "next_steps": "1. Re-check the file_id enumeration range\n2. Test authentication on the admin subdomain"
  }
})
```

Returns `{ "success": true, "action": "save", "created": true, "session": { "session_id": "...", "parent_session_id": "SESS-20260101-001", "...": "..." } }`.

Partial update:

```json
manage_snapshot({
  "action": "save",
  "session_id": "SESS-20260101-002",
  "base_updated_at": "2026-01-02T05:20:00.000Z",
  "payload": { "current_phase": "access control verification", "next_steps": "1. Test authentication on the admin subdomain" }
})
```

Fields not passed keep their original values; `tested_interfaces` / `related_vuln_ids` are replaced wholesale (appending requires including the old entries). Returns `created: false`.

Common calls:

| Goal | Call | Returns |
| --- | --- | --- |
| List project sessions | `list({ keyword, roots_only: true })` | `{ total, items[] }` |
| List child sessions | `list({ parent_session_id })` | `{ total, items[] }` |
| Read a project session | `load({ session_id: root })` | `{ session, children[] }` |
| Read a child session | `load({ session_id: child })` | `{ session }` (one at a time) |
| Merge assets into a session | `attach_assets({ session_id, hosts })` | `{ session }` (target_hosts merged and deduplicated) |
| Roll back the last overwrite | `restore_previous({ session_id })` | `{ session }` (has_previous_state → false) |

`SESSION_EXISTS` handling: returned when creating without `session_id` while a session already exists for the same project

```json
{ "success": false, "requires_choice": true, "code": "SESSION_EXISTS", "candidates": [{ "session_id": "SESS-20260101-001", "project_name": "Example Cloud Course", "current_phase": "access control verification", "...": "..." }] }
```

Show `candidates` to the user and let them choose "continue the existing session (save + session_id)" or "create a new one (save + force_new: true)"; do not guess.

## Returns and error handling

| Call | Success result |
| --- | --- |
| `save` (create / update) | `{ success: true, action: "save", created, session }` |
| `load` | `{ success: true, action: "load", session, children? }` (project sessions include child summaries) |
| `list` | `{ success: true, action: "list", total, items }` |
| `attach_assets` / `restore_previous` | `{ success: true, action, session }` |

Common errors (all return `isError: true`; fix the input and retry):

- `SESSION_EXISTS`: the project already has a session and no `session_id` / `force_new` was given; show the `candidates` to the user.
- `STALE`: `base_updated_at` is outdated; `load` again and retry with the latest `updated_at`.
- Archived session: `save` / `attach_assets` / `restore_previous` are rejected; ask the user to unarchive it in the desktop UI.
- Validation: the field path is reported (missing creation fields, payload over 32,000 characters, `parent_session_id` across levels).
- `load` on an unknown ID: run `list` first to confirm the `session_id`.

## Pre-save checklist

- [ ] Hierarchy is correct: the project session is the root, and the child session carries `parent_session_id` (one level only);
- [ ] Child sessions / asset records were created only for assets that meet the value threshold; excluded items are already in the project `notes` scope ledger;
- [ ] `unfinished_tasks` / `failed_paths` / `next_steps` reflect the real current state, with completed items removed;
- [ ] Vulnerability evidence / raw endpoint requests / sensitive leaks are in the vulnerability DB and asset library respectively; the snapshot does not duplicate large blocks;
- [ ] `tested_interfaces` records conclusions only (target / method / result), with no full messages pasted;
- [ ] `related_vuln_ids` were persisted with `save_vulnerability` first;
- [ ] The whole payload is ≤32,000 characters (compress `notes` first when over);
- [ ] Updates carry `base_updated_at` and are based on the latest `load`; note the `session_id` after saving.

## Common mistakes

- ❌ Creating a child session under a child session (only one level allowed); omitting `parent_session_id` when creating a child session;
- ❌ One child session per host / persisting unreachable targets, parked pages, default pages, CDNs, duplicate domains or out-of-scope targets one by one (merge them or record only in the scope ledger);
- ❌ Picking a candidate yourself after receiving `SESSION_EXISTS` (the user must choose);
- ❌ Using `save` + `session_id` to write another project's progress into an existing session (a new task should create a new session);
- ❌ Trying to archive / delete a session on the agent side (the MCP has no such action; only prompt the user to do it in the desktop app);
- ❌ Calling `save` / `attach_assets` / `restore_previous` on an archived session (first prompt the user to unarchive it in the UI);
- ❌ Saving on every turn, leaving completed items in `unfinished_tasks`, or retrying after `STALE` without `load`ing again;
- ❌ Stuffing full HTTP messages / screenshots into `tested_interfaces` or `notes`, or copying reproduction steps after referencing a vulnerability (blowing the 32,000 limit);
- ❌ Using a snapshot instead of persisting vulnerabilities / assets (still go through `save_vulnerability` / `sync_asset_info`).

## Installing into agents

A single `ctx init` command completes the MCP config + three skills + system rules (idempotent, automatic backup, `--dry-run` previews only); you can also use the **Connect agents** button on the MCP page. Location: `~/.agents/skills/snapshot/SKILL.md` (see the README for the DSH / Codex / Claude skill directories), and the hard rules are written to the corresponding global instruction file; clients such as Cursor can use the stdio config printed by `ctx mcp print-config cursor`.

The stdio MCP is launched by the agent, so no GUI needs to run; the GUI is only a viewer, and archiving / deletion are still done in the desktop app. Database: Windows `%USERPROFILE%\.cortex\data.db`, macOS/Linux `~/.cortex/data.db` (`CTX_DB_PATH` can override it; the legacy `PDH_DB_PATH` still works).

Post-install self-check: confirm the 6 tools in the tool list (`save_vulnerability`, `query_vulnerabilities`, `update_vulnerability`, `sync_asset_info`, `query_asset_context`, `manage_snapshot`); run `manage_snapshot({ action: "list" })` and a read-only query once to confirm the link; after saving a test snapshot, a new session should be able to restore it via `list` → `load`, and `parent_session_id` / `children` / `restore_previous` should behave correctly. If tools are missing or the connection drops, run `ctx doctor`, fix the config, then restart the agent.
