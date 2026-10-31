import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { nodeExecutableName } from './context'
import { envOverride } from './env'

/**
 * Locate the stdio MCP runtime that agent configs should point at.
 *
 * Three layouts are supported:
 * - **development**: running from the repo (`src/cli/index.ts` via tsx, or
 *   `out/cli/ctx.cjs` built from it) next to `out/mcp/stdio.cjs`; the agent
 *   launches the developer's `node`.
 * - **installed (Windows)**: `<install>/bin/{node.exe, mcp-stdio.cjs, ctx.cjs,
 *   ctx.cmd, ctx-path.cjs, skills/}`, installed to
 *   `%LOCALAPPDATA%\Programs\Cortex` by default.
 * - **installed (macOS)**: the runtime root is `Cortex.app/Contents`, so the
 *   binaries live in `Contents/bin` (same file layout as Windows, with `node`
 *   instead of `node.exe`).
 *
 * `CTX_INSTALL_DIR` (legacy `PDH_INSTALL_DIR`) overrides detection; its value
 * is the installed runtime root, i.e. the directory that *contains* `bin/`.
 * `CTX_SKILL_DIR` overrides where the `<lang>/<name>.skill.md` sources are read
 * from (development defaults to `<repo>/skills`).
 */
export interface CliRuntime {
  mode: 'development' | 'installed'
  /** Executable that launches the stdio MCP server. */
  nodeExecutable: string
  /** Absolute path of the stdio MCP entry (`mcp-stdio.cjs` / `out/mcp/stdio.cjs`). */
  mcpEntry: string
  /** Absolute path of the running CLI entry (`ctx.cjs`). */
  cliEntry: string
  /** Project root (development) or installed runtime root (contains `bin/`). */
  root: string
  /** Directory containing `<lang>/<name>.skill.md` sources. */
  skillSourceDir: string
}

export interface ResolveCliRuntimeOptions {
  env?: NodeJS.ProcessEnv
  /** Defaults to `process.argv[1]`. */
  scriptPath?: string
  /** Defaults to `process.execPath`. */
  execPath?: string
  exists?: (filePath: string) => boolean
}

/** CLI bundle name inside `<install>/bin` (built by `scripts/build-cli.mjs`). */
export const INSTALLED_CLI_BUNDLE = 'ctx.cjs'
/** Stdio MCP bundle name inside `<install>/bin` (built by `scripts/build-mcp.mjs`). */
export const INSTALLED_MCP_BUNDLE = 'mcp-stdio.cjs'
/** Language-scoped skill sources shipped next to the installed bundles. */
export const SKILL_DIR_NAME = 'skills'

function findProjectRoot(start: string, exists: (filePath: string) => boolean): string {
  let current = resolve(start)
  for (let depth = 0; depth < 8; depth += 1) {
    if (exists(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(start)
}

/**
 * Resolve symlinks/junctions so an `npm link`ed global shim still points at the
 * real repository (otherwise generated MCP configs would reference the npm
 * global `node_modules` junction instead of the checked-out project).
 */
function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    return filePath
  }
}

/**
 * Build the installed layout for a runtime root. A caller that passes the
 * `bin/` directory itself is tolerated (some test harnesses do), and a macOS
 * caller may pass either `Cortex.app` or `Cortex.app/Contents`; the documented
 * contract is the root that contains `bin/`.
 */
function installedRuntime(rootOrBin: string, exists: (filePath: string) => boolean): CliRuntime {
  const input = resolve(rootOrBin)
  const bundleContents = join(input, 'Contents')
  const base = exists(join(bundleContents, 'bin')) ? bundleContents : input
  const hasBinDir = exists(join(base, 'bin'))
  const looksLikeBinDir =
    !hasBinDir &&
    (exists(join(base, INSTALLED_CLI_BUNDLE)) || exists(join(base, INSTALLED_MCP_BUNDLE)))
  const binDir = looksLikeBinDir ? base : join(base, 'bin')
  return {
    mode: 'installed',
    nodeExecutable: join(binDir, nodeExecutableName()),
    mcpEntry: join(binDir, INSTALLED_MCP_BUNDLE),
    cliEntry: join(binDir, INSTALLED_CLI_BUNDLE),
    root: looksLikeBinDir ? dirname(base) : base,
    skillSourceDir: join(binDir, SKILL_DIR_NAME)
  }
}

export function resolveCliRuntime(options: ResolveCliRuntimeOptions = {}): CliRuntime {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const scriptPath = safeRealpath(
    resolve(options.scriptPath ?? process.argv[1] ?? join(process.cwd(), INSTALLED_CLI_BUNDLE))
  )
  const execPath = options.execPath ?? process.execPath

  const explicitInstall = envOverride(env, 'CTX_INSTALL_DIR', 'PDH_INSTALL_DIR')
  if (explicitInstall !== undefined) {
    return installedRuntime(explicitInstall, exists)
  }

  const scriptDir = dirname(scriptPath)
  if (
    exists(join(scriptDir, INSTALLED_MCP_BUNDLE)) ||
    exists(join(scriptDir, nodeExecutableName()))
  ) {
    return {
      mode: 'installed',
      nodeExecutable: join(scriptDir, nodeExecutableName()),
      mcpEntry: join(scriptDir, INSTALLED_MCP_BUNDLE),
      cliEntry: scriptPath,
      root: dirname(scriptDir),
      skillSourceDir: join(scriptDir, SKILL_DIR_NAME)
    }
  }

  const projectRoot = findProjectRoot(scriptDir, exists)
  const skillOverride = envOverride(env, 'CTX_SKILL_DIR')
  return {
    mode: 'development',
    nodeExecutable: execPath,
    mcpEntry: join(projectRoot, 'out', 'mcp', 'stdio.cjs'),
    cliEntry: scriptPath,
    root: projectRoot,
    skillSourceDir:
      skillOverride !== undefined ? resolve(skillOverride) : join(projectRoot, 'skills')
  }
}

/** True when the built MCP bundle exists (agents would fail to start otherwise). */
export function mcpEntryExists(runtime: CliRuntime): boolean {
  return existsSync(runtime.mcpEntry)
}

/** Display form used in config snippets / doctor, always forward slashes. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}
