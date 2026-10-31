# Cortex

Cortex is a local-first pentest intelligence hub: one SQLite memory shared by a **pure stdio MCP server** (for agents), a **`ctx` CLI** (for terminals) and an **Electron desktop app** (for humans). It is not a scanner — agents write confirmed vulnerabilities, recon asset context and task snapshots; humans review, filter, retest and hand over.

中文文档：[README.zh-CN.md](README.zh-CN.md)

## Download & install

Direct installers are published to GitHub Releases by the release workflow. Current release: **cortex-v0.1.1**.

| Platform | Download |
| --- | --- |
| Windows 10/11 x64 | [Cortex-0.1.1-setup.exe](https://github.com/Revcloudi/Cortex/releases/latest/download/Cortex-0.1.1-setup.exe) |
| macOS Apple Silicon (arm64) | [Cortex-0.1.1-arm64.dmg](https://github.com/Revcloudi/Cortex/releases/latest/download/Cortex-0.1.1-arm64.dmg) |
| macOS Intel (x64) | [Cortex-0.1.1-x64.dmg](https://github.com/Revcloudi/Cortex/releases/latest/download/Cortex-0.1.1-x64.dmg) |

> The links always point at the newest Cortex release; the full list is on the [Releases page](https://github.com/Revcloudi/Cortex/releases). All builds are unsigned: Windows SmartScreen may warn ("More info → Run anyway"), and on macOS right-click the app → Open (or run `xattr -dr com.apple.quarantine "/Applications/Cortex.app"` once).

### During installation

**Windows (NSIS installer)** — setup asks:

1. **Which agents to connect**: DeepSeek Harness / Codex CLI / Claude Code / Cursor (multi-select; detected clients are pre-checked);
2. **Skill language**: 中文 or English (installs the matching `vuln-db` / `asset-context` / `snapshot` skills);
3. optionally, whether to add `bin` to the current-user PATH.

The installer then runs `ctx init` non-interactively with those choices. Uninstalling removes the program only — `%USERPROFILE%\.cortex\data.db` is preserved.

**macOS (DMG)** — drag Cortex into Applications. Because a DMG has no installer wizard, the same choices (agents, skill language, UI language) are shown in a **first-run welcome dialog** inside the app. The dialog also appears after a Windows install if you skipped the setup step.

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

- Node.js **≥ 22.12** for source builds. The Windows installer and macOS DMG bundle their own Node runtime, so end users do not need Node.
- Windows 10/11 x64 or macOS 12+ (arm64/x64) for the packaged apps.

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
- Installer: `npm run dist:win` (Windows) / `npm run dist:mac` (macOS host or CI); both include the bundled Node runtime. Run the artifact from `release/`.

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
| macOS install | `/Applications/Cortex.app/Contents/bin/node /Applications/Cortex.app/Contents/bin/mcp-stdio.cjs` |

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
| `ctx open [--dev] [--path <exe>]` | Launch or focus the desktop app (Windows install, macOS app or source build) |

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
npm run dist:mac           # build + bundled runtime → macOS dmg (must run on macOS or CI)
npm run build:runtime      # only materialize runtime/ (manual/advanced packaging)
```

The installed layout (`<install>`, per-user on Windows):

```text
Windows: %LOCALAPPDATA%\Programs\Cortex\      macOS: /Applications/Cortex.app/Contents/
  Cortex.exe                                    MacOS/Cortex
  resources/app.asar                            resources/app.asar
  bin\                                          bin/
    node.exe | node                             bundled Node LTS runtime
    mcp-stdio.cjs                               stdio MCP entry
    ctx.cjs  ctx.cmd | ctx                      CLI + wrapper
    ctx-path.cjs                                installer PATH helper
    skills\{zh,en}\...                          skill sources for ctx init
    node_modules\                               better-sqlite3 (Node-API)
```

`.github/workflows/release.yml` builds Windows + macOS (arm64/x64) artifacts on `v*` / `cortex-v*` tags and uploads exactly three installers (Windows x64 setup, macOS arm64 dmg, macOS x64 dmg) to GitHub Releases. macOS builds are unsigned (no Apple Developer certificate), hence the Gatekeeper note above.

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
