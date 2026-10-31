import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { detectAgents, resolveAgentHomes } from '../../cli/agents'
import { runInit } from '../../cli/commands/init'
import { createCliContext } from '../../cli/context'
import type { CliRuntime } from '../../cli/runtime'
import type {
  AgentId,
  LocalizedText,
  SetupActionSummary,
  SetupAgentOption,
  SetupInfo,
  SetupRunRequest,
  SetupRunResult,
  SkillLanguage,
  UiLanguage
} from '../../shared/types'
import { logger } from '../logger'
import { developmentNodeCommand, installedRoot, nodeExecutableName } from '../runtimePaths'

/**
 * First-run setup bridge.
 *
 * The wizard needs two things the renderer cannot do itself: probe the local
 * agent installations/configs (`getSetupInfo`) and run `ctx init` in-process
 * with explicit options (`runSetup`). Both reuse the CLI implementation, so the
 * GUI and `ctx init` always write exactly the same files.
 */

/** `claude --version` is the only reliable Claude Code installation signal. */
const CLAUDE_PROBE_TIMEOUT_MS = 10_000

interface AgentCatalogEntry {
  id: AgentId
  name: string
  description: LocalizedText
}

/** Wizard agent list, in display order. */
const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    description: {
      zh: '通过 profiles 下的 cordis.patch.yml 以 stdio 方式加载 Cortex 的 MCP 服务。',
      en: 'Loads the Cortex MCP server over stdio from its profile cordis.patch.yml.'
    }
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    description: {
      zh: '在 ~/.codex/config.toml 中写入 [mcp_servers.cortex] 的 stdio 配置。',
      en: 'Writes the [mcp_servers.cortex] stdio entry into ~/.codex/config.toml.'
    }
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: {
      zh: '通过自带的 claude mcp add 命令注册 Cortex 的 stdio 服务。',
      en: 'Registers the Cortex stdio server through its own claude mcp add command.'
    }
  },
  {
    id: 'cursor',
    name: 'Cursor',
    description: {
      zh: '在 ~/.cursor/mcp.json 中添加 cortex 的 stdio 服务。',
      en: 'Adds the cortex stdio server to ~/.cursor/mcp.json.'
    }
  }
]

/**
 * `runInit` options as this bridge calls them.
 *
 * `skillLang` is the CLI's `--skill-lang` switch. It is declared as an
 * intersection so a source build whose `InitOptions` does not yet carry the
 * switch still type-checks; the CLI then falls back to `CTX_SKILL_LANG` / `zh`.
 */
type SetupInitOptions = Parameters<typeof runInit>[0] & { skillLang?: SkillLanguage }

/** Home that owns agent homes; honours the CLI install sandbox env vars. */
function installationHome(env: NodeJS.ProcessEnv): string {
  const override = env['CTX_INSTALL_HOME']?.trim() || env['PDH_INSTALL_HOME']?.trim()
  return override !== undefined && override.length > 0 ? override : homedir()
}

/**
 * Renderer-facing detection: which agents exist and whether any of them already
 * points at Cortex, plus the wizard defaults.
 */
export function buildSetupInfo(env: NodeJS.ProcessEnv = process.env): SetupInfo {
  const home = installationHome(env)
  const homes = resolveAgentHomes(home, env)
  const detected = detectAgents(homes, existsSync, runClaudeCliProbe)
  const agents: SetupAgentOption[] = AGENT_CATALOG.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    detected: detected[agent.id]
  }))

  return {
    alreadyConfigured:
      dshConfigured(homes.dsh) ||
      codexConfigured(homes.codex) ||
      cursorConfigured(homes.cursor) ||
      skillsConfigured(home),
    agents,
    defaultSkillLanguage: resolveDefaultSkillLanguage(env),
    defaultUiLanguage: resolveDefaultUiLanguage()
  }
}

/**
 * Run `ctx init` in-process for the selected agents and languages.
 *
 * Never throws: init failures are reported as `success: false` with the error
 * message in `warnings`, so the renderer can show partial success instead of an
 * unhandled IPC rejection.
 */
export async function runSetup(
  request: SetupRunRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<SetupRunResult> {
  try {
    const context = createCliContext({
      stdout: () => undefined,
      stderr: () => undefined,
      env,
      homeDir: homedir()
    })
    const options: SetupInitOptions = {
      yes: true,
      agents: request.agents.join(','),
      skillLang: request.skillLanguage
    }
    const report = await runInit(options, context, { runtime: buildSetupRuntime(env) })
    logger.info(
      `[setup] ctx init applied (agents=${request.agents.join(',')}, skillLang=${request.skillLanguage}, actions=${report.actions.length})`
    )
    return {
      success: true,
      actions: report.actions.map(toActionSummary),
      warnings: report.warnings,
      restartHint: report.restartHint
    }
  } catch (error) {
    logger.warn('[setup] ctx init failed', error)
    return {
      success: false,
      actions: [],
      warnings: [error instanceof Error ? error.message : String(error)],
      restartHint: ''
    }
  }
}

/**
 * Explicit CLI runtime for the running app.
 *
 * `runInit` cannot auto-detect this one: inside Electron the "script path" is
 * the asar bundle, so the GUI must state where the MCP/CLI bundles and the
 * language-scoped skill sources live.
 */
export function buildSetupRuntime(env: NodeJS.ProcessEnv = process.env): CliRuntime {
  if (app.isPackaged) {
    const root = installedRoot()
    const binDir = join(root, 'bin')
    return {
      mode: 'installed',
      nodeExecutable: join(binDir, nodeExecutableName()),
      mcpEntry: join(binDir, 'mcp-stdio.cjs'),
      cliEntry: join(binDir, 'ctx.cjs'),
      root,
      skillSourceDir: join(binDir, 'skills')
    }
  }

  const projectRoot = app.getAppPath()
  return {
    mode: 'development',
    nodeExecutable: developmentNodeCommand(env),
    mcpEntry: join(projectRoot, 'out', 'mcp', 'stdio.cjs'),
    cliEntry: join(projectRoot, 'out', 'cli', 'ctx.cjs'),
    root: projectRoot,
    skillSourceDir: join(projectRoot, 'skills')
  }
}

/** Status values the CLI may report; `planned` only appears in dry runs. */
const ACTION_STATUS_MAP: Record<string, SetupActionSummary['status']> = {
  created: 'created',
  updated: 'updated',
  skipped: 'skipped',
  'manual-required': 'manual-required',
  planned: 'skipped',
  failed: 'failed'
}

interface InitActionLike {
  agent?: AgentId
  kind: 'mcp' | 'skill' | 'rule'
  path: string
  status: string
  detail?: string
}

function toActionSummary(action: InitActionLike): SetupActionSummary {
  const summary: SetupActionSummary = {
    kind: action.kind,
    path: action.path,
    status: ACTION_STATUS_MAP[action.status] ?? 'failed'
  }
  if (action.agent !== undefined) summary.agent = action.agent
  if (action.detail !== undefined && action.detail.length > 0) summary.detail = action.detail
  return summary
}

/** `CTX_SKILL_LANG` (zh/en) wins; anything else defaults to Chinese. */
function resolveDefaultSkillLanguage(env: NodeJS.ProcessEnv): SkillLanguage {
  const raw = env['CTX_SKILL_LANG']?.trim().toLowerCase()
  return raw === 'en' ? 'en' : 'zh'
}

/** Follow the OS UI language: Chinese locales start with `zh`. */
function resolveDefaultUiLanguage(): UiLanguage {
  try {
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * `claude --version` runner used only for detection. Mirrors the CLI's
 * production runner (the shell resolves `claude.cmd` on Windows) with a shorter
 * timeout because this call runs inside the main process while the wizard opens.
 */
function runClaudeCliProbe(args: string[]): {
  status: number | null
  stdout: string
  stderr: string
  error?: unknown
} {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'claude.cmd' : 'claude', args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32',
      timeout: CLAUDE_PROBE_TIMEOUT_MS
    })
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error
    }
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error }
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function directoryNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** DSH: any profile patch file carries the Cortex stdio loader entry. */
function dshConfigured(dshHome: string): boolean {
  const profilesRoot = join(dshHome, 'profiles')
  for (const profile of directoryNames(profilesRoot)) {
    const content = readTextFile(join(profilesRoot, profile, 'cordis.patch.yml'))
    if (content === null) continue
    if (content.includes('mcp-cortex') || /serverName:\s*cortex\b/.test(content)) return true
  }
  return false
}

/** Codex: a `[mcp_servers.cortex]` table exists. */
function codexConfigured(codexHome: string): boolean {
  const content = readTextFile(join(codexHome, 'config.toml'))
  return content !== null && /^[ \t]*\[mcp_servers\.cortex\][ \t]*(?:#.*)?$/m.test(content)
}

/** Cursor: `mcpServers.cortex` exists (JSON is parsed; regex is the fallback). */
function cursorConfigured(cursorHome: string): boolean {
  const content = readTextFile(join(cursorHome, 'mcp.json'))
  if (content === null) return false
  try {
    const parsed: unknown = JSON.parse(content)
    const servers = isJsonObject(parsed) ? parsed['mcpServers'] : undefined
    if (isJsonObject(servers) && servers['cortex'] !== undefined) return true
  } catch {
    // Fall through to the textual marker below (hand-edited / commented JSON).
  }
  return /"cortex"\s*:/.test(content)
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shared skills installed by a previous run (`ctx init` copies all three). */
function skillsConfigured(home: string): boolean {
  return existsSync(join(home, '.agents', 'skills', 'vuln-db', 'SKILL.md'))
}
