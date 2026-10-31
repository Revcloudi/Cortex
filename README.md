![Cortex — local-first, MCP-native pentest intelligence memory](assets/readme-hero.png)

# Cortex

Local-first, MCP-native pentest intelligence hub for authorized engagements. One SQLite memory shared by a **pure stdio MCP server** (agents), a **`ctx` CLI** (terminals) and a **Windows desktop app** (humans).

[![README English](https://img.shields.io/badge/README-English-0f766e?style=flat-square)](README.md)
[![README 中文](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-f59e0b?style=flat-square)](README.zh-CN.md)
[![Version 0.1.1](https://img.shields.io/badge/version-0.1.1-2dd4bf?style=flat-square)](https://github.com/Revcloudi/Cortex/releases)
[![MCP 6 tools](https://img.shields.io/badge/MCP-6%20tools-0ea5e9?style=flat-square)](#mcp-access)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20CLI%20%C2%B7%20Linux%20CLI-64748b?style=flat-square)](#cli-only-macos--linux--windows)
[![Node >= 22.12](https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933?style=flat-square)](#requirements)
[![License MIT](https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square)](LICENSE)

> **Authorized testing only.** Cortex is built for systems you own or have explicit written permission to test. You are responsible for complying with applicable laws, contracts and scope boundaries.

**English** · [简体中文](README.zh-CN.md) · [CLI-only install](#cli-only-macos--linux--windows) · [Windows desktop app](#windows-desktop-app) · [Usage examples](#usage-examples) · [MCP tools](#mcp-access)

## CLI only (macOS / Linux / Windows)

The `ctx` CLI is plain Node.js — macOS and Linux use the same source as Windows. No desktop app or installer is needed:

```bash
# Node.js >= 22.12 required
git clone git@github.com:Revcloudi/Cortex.git
cd Cortex
npm install
npm run build
npm link            # exposes `ctx` on PATH; without link: node out/cli/ctx.cjs
ctx --version
ctx init --yes      # writes MCP config + bilingual skills for detected agents
ctx doctor          # verify DB, MCP runtime and agent configs
```

The CLI shares the same SQLite database as the desktop app (`~/.cortex/data.db` on macOS/Linux, `%USERPROFILE%\.cortex\data.db` on Windows). MCP is stdio-only, so agents launch it directly; no desktop app is required on macOS/Linux.

## Windows desktop app

The Windows installer is published to GitHub Releases by the release workflow. Current release: **cortex-v0.1.1**. macOS and Linux are supported through the CLI-only path above.

| Platform | Download |
| --- | --- |
| Windows 10/11 x64 | [Cortex-0.1.1-setup.exe](https://github.com/Revcloudi/Cortex/releases/latest/download/Cortex-0.1.1-setup.exe) |

> The link always points at the newest Cortex release; the full list is on the [Releases page](https://github.com/Revcloudi/Cortex/releases). The installer is unsigned: Windows SmartScreen may warn ("More info → Run anyway").

### During installation

**Windows (NSIS installer)** — setup asks:

1. **Which agents to connect**: DeepSeek Harness / Codex CLI / Claude Code / Cursor (multi-select; detected clients are pre-checked);
2. **Skill language**: 中文 or English (installs the matching `vuln-db` / `asset-context` / `snapshot` skills);
3. optionally, whether to add `bin` to the current-user PATH.

The installer then runs `ctx init` non-interactively with those choices. The same first-run welcome dialog appears if you skip the installer step. Uninstalling removes the program only — `%USERPROFILE%\.cortex\data.db` is preserved.

The desktop UI supports **中文 / English switching** at any time from the sidebar; the choice is remembered. The skill language only affects the files installed into your agents and can be changed later with `ctx init --skill-lang`.

## Features

- Vulnerability model: host, entry point, type, severity, URL, description, impact, affected interfaces, Markdown reproduction, remediation, crypto notes, test boundaries, append-only retests, related IDs and status.
- Asset context: full URLs, project, tech stack, structured interfaces (`path` / `method` / `params` / raw request), leaked info, non-secret `test_parameters` and related vulnerabilities. Legacy `interface_dir` arrays are normalized automatically.
- One MCP server with exactly six tools: `save_vulnerability`, `query_vulnerabilities`, `update_vulnerability`, `sync_asset_info`, `query_asset_context`, `manage_snapshot`.
- `ctx init` detects installed agents and writes their MCP config, the three skills and system-level hard rules idempotently (with backups, a dry-run mode and JSON / TOML / YAML validation).
- GUI: vulnerability dashboard with server-side filtering/pagination, asset library with interface explorer, cognitive snapshot sessions (project → child hierarchy), Markdown report export, and a bilingual MCP access page with the launch command and a compact tool reference.
- The sidebar database button can attach another Cortex SQLite file for browsing (desktop view only; agents keep using the default database).
- The main process watches the SQLite files (`data.db`, `-wal`, `-shm`) with chokidar and pushes `data:changed`, so agent writes usually show up in under a second without losing filters or open detail panels.
- Bilingual skills: `skills/zh/**` and `skills/en/**`; choose per installation.

## Requirements

- Node.js **≥ 22.12** for the CLI and source builds. The Windows desktop installer bundles its own Node runtime, so Windows end users do not need Node.
- The packaged desktop app is Windows 10/11 x64; macOS/Linux use the CLI-only path.

## Build from source

```bash
git clone git@github.com:Revcloudi/Cortex.git
cd Cortex
npm install
npm run build       # typecheck + Electron bundles + MCP bundle + CLI bundle
npm run dev         # Electron + Vite dev mode
```

Useful commands:

```bash
npm run typecheck   # Node + Web TypeScript projects
npm run build:mcp   # out/mcp/stdio.cjs (stdio MCP entry agents launch)
npm run build:cli   # out/cli/ctx.cjs + out/cli/ctx.cmd
npm start           # preview the built Electron app
```

The database is created on first launch at `%USERPROFILE%\.cortex\data.db` (macOS/Linux: `~/.cortex/data.db`); override with `CTX_DB_PATH`.

### Open the desktop app

- Development: `npm run dev`
- Already built: `npm start` (or `ctx open` after linking the CLI)
- Installer: `npm run dist:win` (builds the bundled Node runtime too); the artifact is written to `release/`.

### Make `ctx` available as a command

After `npm run build`:

```bash
npm link        # registers a ctx shim in the npm global bin (already on PATH for a standard Node install)
ctx --version
```

Without linking: `node out/cli/ctx.cjs --version` or `npm run ctx -- --version`.

## MCP access

The MCP server is **stdio only**: the agent starts it in its own process; there is no listening port and the GUI never starts MCP. Server name: `cortex`, version `0.1.1`.

| Scenario | Launch command |
| --- | --- |
| Source build | `node <repo>/out/mcp/stdio.cjs` |
| Windows install | `<install>\bin\node.exe <install>\bin\mcp-stdio.cjs` |

DeepSeek Harness (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: mcp-cortex
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: cortex
        transport: stdio
        command: "node"
        args:
          - "<repo>/out/mcp/stdio.cjs"
        toolCallTimeoutMs: 120000
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.cortex]
command = "node"
args = ["<repo>/out/mcp/stdio.cjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Claude Code:

```bash
claude mcp add --transport stdio cortex -- node <repo>/out/mcp/stdio.cjs
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["<repo>/out/mcp/stdio.cjs"]
    }
  }
}
```

### One-command setup

```bash
npm run build
node out/cli/ctx.cjs init --dry-run                    # preview only
node out/cli/ctx.cjs init --yes                        # detect agents, back up and write
node out/cli/ctx.cjs init --yes --agents dsh --skill-lang en
node out/cli/ctx.cjs doctor                            # diagnose config + runtime
```

`ctx init` backs up existing files as `.bak-YYYYMMDD-HHmmss`, merges marker-managed blocks idempotently (old `PENTEST` markers are migrated), validates JSON / TOML / YAML before writing, and installs the selected skill language. Restart the agent afterwards (not the GUI); then verify a read-only tool call such as `manage_snapshot({ "action": "list" })`.

## Usage examples

MCP is JSON-RPC over **stdio**: there is no HTTP endpoint to curl. After `ctx init`, the agent launches the server and calls the six tools; the desktop app and `ctx` read the same SQLite file, so agent writes appear in the GUI/CLI immediately.

| Tool | Use it when |
| --- | --- |
| `query_asset_context` | Before testing an asset: reuse project name, tech stack, interfaces, leaks and test parameters. |
| `sync_asset_info` | After recon/JS audit/interception: persist fingerprints, structured interfaces, leaks and non-secret test parameters. |
| `query_vulnerabilities` | Before saving a finding: deduplicate by host, or review existing records. |
| `save_vulnerability` | Persist a confirmed finding with Markdown reproduction steps. |
| `update_vulnerability` | Change status, or append a retest conclusion without rewriting the original evidence. |
| `manage_snapshot` | Save/resume the tactical state of the current task ("session memory"). |

### 1. Reuse recon and persist asset context

Ask the agent to start from existing memory (DSH exposes tools as `mcp__cortex__*`; other clients use the plain names):

```text
query_asset_context({ "host_port": "https://app.example.com/login" })
query_asset_context({ "project_name": "Example Program" })
```

After recon, persist what was learned. Tool arguments for `sync_asset_info`:

```json
{
  "mode": "merge",
  "host_port": "https://app.example.com/login",
  "project_name": "Example Program",
  "tech_stack": "Nginx, Spring Boot, Vue",
  "interfaces": [
    {
      "path": "/api/v1/files/download",
      "method": "GET",
      "params": "file_id=1",
      "request": "GET /api/v1/files/download?file_id=1 HTTP/1.1\r\nHost: app.example.com\r\n"
    }
  ],
  "test_parameters": [
    {
      "name": "file_id",
      "endpoint": "GET /api/v1/files/download?id={id}",
      "location": "query",
      "values": ["1", "2", "3"],
      "pattern": "incrementing integer"
    }
  ]
}
```

Rules: `host_port` prefers a full URL; `mode: "replace"` writes a full snapshot, `mode: "merge"` merges increments; JS/CSS/images are evidence, not interfaces.

### 2. Deduplicate, save and retest a finding

```text
query_vulnerabilities({ "host": "app.example.com:443" })
```

If it is new, call `save_vulnerability` with the finding payload (`vuln_name`, `host`, `severity`, `target_url`, `description`, `impact`, `reproduction_steps` as Markdown, `remediation`, `status`, …). When retesting an existing record, append:

````text
update_vulnerability({
  "vuln_id": "VULN-20260101-001",
  "retest": {
    "time_range": "2026-01-02 10:00–10:04",
    "conclusion": "### Retest Conclusion\n\n- **Result**: still reproducible\n\n```http\nGET /api/v1/files/download?file_id=1 HTTP/1.1\nHost: app.example.com\n```"
  }
})
````

Never overwrite the original evidence with `save_vulnerability`; use `update_vulnerability` for retests and status changes.

### 3. Session memory (cognitive snapshots)

Snapshots are stored in the same SQLite database and survive agent restarts. At the start of a new session, resume:

```text
manage_snapshot({ "action": "list" })
manage_snapshot({ "action": "load", "session_id": "SESS-20260101-001" })
```

At a phase boundary / before the context window fills / before ending:

```json
{
  "action": "save",
  "payload": {
    "project_name": "Example Program",
    "target_hosts": ["app.example.com"],
    "current_phase": "IDOR verification",
    "unfinished_tasks": ["check /api/v1/orders/{id} for tenant B"],
    "failed_paths": ["/admin requires SSO"],
    "next_steps": "enumerate file_id on the download endpoint"
  }
}
```

- Project sessions can have **one level of child sessions** (`parent_session_id`); keep one active session per task.
- If the project already has a session, `save` returns `SESSION_EXISTS` with candidates — ask the user to continue an existing session or create `force_new: true`; do not guess.
- `attach_assets({ "hosts": ["app.example.com"] })` joins targets into a session; `restore_previous` rolls back one overwrite.
- A snapshot holds conclusions/tactical state (`notes`, `tested_interfaces`, `related_vuln_ids`), not large HTTP dumps/screenshots; payload ≤32,000 characters and `notes` should reference evidence paths.
- Archived sessions are read-only in the database; unarchive them in the desktop UI before reusing.

### 4. Review and hand over

- Desktop: Vulnerability dashboard, Asset library, Snapshot sessions (project → child hierarchy), Markdown export, and the sidebar database button for opening another SQLite file.
- CLI: `ctx vulns list --severity High`, `ctx assets get app.example.com`, `ctx snapshots list`, `ctx search payment`, `ctx doctor`.

## CLI (`ctx`)

Runs on Node without Electron, reads the same SQLite database. All commands accept `--json`; exit codes are 0 success, 1 parameter/IO error, 2 data not found.

| Command | Description |
| --- | --- |
| `ctx init [--dry-run] [--yes] [--agents dsh,codex,claude,cursor] [--skill-lang zh\|en]` | Detect agents, show the planned diff, back up, then write MCP configs + skills + system rules |
| `ctx doctor` | Check database, schema, MCP/CLI runtime, agent configs, GUI install and versions |
| `ctx mcp print-config [agent]` | Print the stdio config snippet for DSH / Codex / Claude Code / Cursor |
| `ctx vulns list [--severity] [--host] [--limit]` | List vulnerabilities |
| `ctx vulns get <id>` | Show one full vulnerability |
| `ctx assets list [--search] [--status]` | List asset contexts |
| `ctx assets get <host_port>` | Show one asset context |
| `ctx snapshots list [--keyword]` | List cognitive snapshot sessions |
| `ctx snapshots get <session_id>` | Show one snapshot session |
| `ctx search <keyword>` | Search vulnerabilities, assets and snapshots together |
| `ctx open [--dev] [--path <exe>]` | Launch or focus the desktop app (Windows install or source build) |

## Skills (bilingual)

```
skills/
  zh/  vuln-db.skill.md  asset-context.skill.md  snapshot.skill.md
  en/  vuln-db.skill.md  asset-context.skill.md  snapshot.skill.md
```

`ctx init` copies the selected language to the agent skill directories (`~/.agents/skills/<name>/SKILL.md`, plus client-specific skill directories for Codex / Claude Code). The desktop MCP page and the installer both use the same generator, so configs and skills never drift apart.

## Packaging and releases

```bash
npm run dist:win           # build + bundled runtime → Windows x64 NSIS installer (release/Cortex-0.1.1-setup.exe)
npm run build:runtime      # only materialize runtime/ (manual/advanced packaging)
```

The installed layout (per-user on Windows):

```text
%LOCALAPPDATA%\Programs\Cortex\
  Cortex.exe                                    Electron shell
  resources/app.asar                            main / preload / renderer bundles
  bin\
    node.exe                                    bundled Node LTS runtime
    mcp-stdio.cjs                               stdio MCP entry
    ctx.cjs  ctx.cmd                            CLI + wrapper
    ctx-path.cjs                                installer PATH helper
    skills\{zh,en}\...                          skill sources for ctx init
    node_modules\                               better-sqlite3 (Node-API)
```

`.github/workflows/release.yml` builds the Windows installer on `v*` / `cortex-v*` tags and publishes it to GitHub Releases. macOS/Linux are CLI-only (see “CLI only” above), so no macOS artifacts are produced.

## Project layout

```text
src/
  shared/      shared contracts (types, IPC channels, Zod schemas, MCP config generator)
  core/        Electron-free database, paths, logging, version
  mcp/         pure stdio MCP server and the six tools
  cli/         ctx commands and agent config writers
  main/        Electron main process (IPC, file watcher, first-run setup, no MCP server)
  preload/     contextBridge API
  renderer/    React UI + lightweight zh/en i18n (messages in renderer/src/i18n)
skills/        bilingual agent skills (zh / en)
scripts/       build, runtime, packaging and legacy install scripts
build/         NSIS customizations
```

## Data and concurrency

- Default database: `%USERPROFILE%\.cortex\data.db` (Windows) or `~/.cortex/data.db`; override with `CTX_DB_PATH` (legacy `PDH_DB_PATH` is still honoured).
- `PRAGMA journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`; write transactions use `BEGIN IMMEDIATE` with bounded SQLITE_BUSY retries; schema version lives in `PRAGMA user_version`.
- Migrations run in one immediate transaction, so concurrent agent processes cannot partially migrate a database.
- The database is plaintext, including credentials in `leaked_infos` — an explicit trade-off of this version.

## Security and engineering constraints

- **stdio only**: no listening port, no HTTP endpoint; the MCP process lives and dies with the agent. stdout carries JSON-RPC frames only; logs go to stderr or `CTX_MCP_LOG`.
- **Process isolation**: `contextIsolation` + `sandbox`, no `nodeIntegration`; the renderer talks only to `window.api` and the main process re-validates every IPC payload.
- **Zod validation** at MCP and IPC boundaries; parameterized SQL everywhere.
- **Concurrency**: WAL, busy timeout, immediate transactions and retries keep transient lock contention away from tool calls.

## License

MIT. See [LICENSE](LICENSE).
