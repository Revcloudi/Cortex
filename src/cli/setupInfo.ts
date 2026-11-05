import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
} from '../shared/types'
import { detectAgents, resolveAgentHomes } from './agents'
import { inspectClaudeCommand, type ClaudeInspection } from './agents/claudeCommand'
import { runInit } from './commands/init'
import { createCliContext } from './context'
import { resolveCliRuntime, type CliRuntime } from './runtime'

/**
 * Electron-free first-run setup logic shared by the desktop GUI
 * (`src/main/ipc/setup.ts`) and the Web server (`src/server/setup.ts`).
 *
 * The wizard needs two things the renderer cannot do itself: probe the local
 * agent installations/configs (`buildSetupInfo`) and run `ctx init` in-process
 * with explicit options (`runSetupCore`). Both reuse the CLI implementation, so
 * every entry point writes exactly the same files. This module must never
 * import `electron`; the desktop wrapper supplies the packaged/dev runtime and
 * the OS locale.
 *
 * Claude Code detection also reuses the CLI's `claudeCommand` resolver/probe
 * (the same logic `ctx init` / `ctx doctor` use), so the GUI and CLI agree: a
 * launcher that is not really Claude Code — notably a Bun shim that still exits
 * 0 on `--version` — is reported as "not detected", never as installed.
 */

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
      zh: '在 DSH 根目录 patch 层（$DSH_HOME/cordis.patch.yml，对所有 profile 生效）写入 cortex 的 stdio 服务。',
      en: 'Writes the Cortex stdio server into the DSH home patch layer ($DSH_HOME/cordis.patch.yml, applied to every profile).'
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
      en: 'Adds the cortex stdio service to ~/.cursor/mcp.json.'
    }
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    description: {
      zh: '在 ~/.workbuddy/mcp.json 中添加 cortex 的 stdio 服务；Skill 可在应用内从 ~/.agents/skills 导入。',
      en: 'Adds the cortex stdio service to ~/.workbuddy/mcp.json; skills can be imported from ~/.agents/skills in the app.'
    }
  },
  {
    id: 'zcode',
    name: 'ZCode',
    description: {
      zh: '在 ~/.zcode/cli/config.json 的 mcp.servers 中添加 cortex；Skill 写入 ~/.zcode/skills。',
      en: 'Adds cortex to mcp.servers in ~/.zcode/cli/config.json; skills go to ~/.zcode/skills.'
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

export interface BuildSetupInfoOptions {
  /** Locale-derived default for the wizard language; defaults to `zh`. */
  defaultUiLanguage?: UiLanguage
  /**
   * Overridable for tests: default resolves the real `claude` launcher
   * (`where.exe` / `which`) and probes it via `inspectClaudeCommand`.
   */
  inspectClaude?: () => ClaudeInspection
}

/**
 * Renderer-facing detection: which agents exist and whether any of them already
 * points at Cortex, plus the wizard defaults.
 */
export function buildSetupInfo(
  env: NodeJS.ProcessEnv = process.env,
  options: BuildSetupInfoOptions = {}
): SetupInfo {
  const home = installationHome(env)
  const homes = resolveAgentHomes(home, env)
  const inspectClaude =
    options.inspectClaude ??
    (() => inspectClaudeCommand({ env, platform: process.platform }))
  const detected = detectAgents(homes, existsSync, claudeDetected(inspectClaude))
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
      workbuddyConfigured(homes.workbuddy) ||
      zcodeConfigured(homes.zcode) ||
      skillsConfigured(home),
    agents,
    defaultSkillLanguage: resolveDefaultSkillLanguage(env),
    defaultUiLanguage: options.defaultUiLanguage ?? 'zh'
  }
}

export interface RunSetupOptions {
  /** Runtime that owns the stdio MCP entry / CLI bundle / skill sources. */
  runtime: CliRuntime
  /** Local-only progress log (never receives file contents). */
  log?: (message: string) => void
  /** Home directory owning the agent homes; injectable for tests. */
  homeDir?: string
}

/**
 * Run `ctx init` in-process for the selected agents and languages.
 *
 * Never throws: init failures are reported as `success: false` with the error
 * message in `warnings`, so the caller can show partial success instead of an
 * unhandled rejection.
 */
export async function runSetupCore(
  request: SetupRunRequest,
  env: NodeJS.ProcessEnv = process.env,
  options: RunSetupOptions
): Promise<SetupRunResult> {
  try {
    const context = createCliContext({
      stdout: () => undefined,
      stderr: () => undefined,
      env,
      homeDir: options.homeDir ?? homedir()
    })
    const initOptions: SetupInitOptions = {
      yes: true,
      agents: request.agents.join(','),
      skillLang: request.skillLanguage
    }
    const report = await runInit(initOptions, context, { runtime: options.runtime })
    options.log?.(
      `[setup] ctx init applied (agents=${request.agents.join(',')}, skillLang=${request.skillLanguage}, actions=${report.actions.length})`
    )
    return {
      success: true,
      actions: report.actions.map(toActionSummary),
      warnings: report.warnings,
      restartHint: report.restartHint
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.log?.(`[setup] ctx init failed: ${message}`)
    return { success: false, actions: [], warnings: [message], restartHint: '' }
  }
}

/** Runtime used by non-Electron entry points (`ctx web`). */
export function resolveSetupRuntime(env: NodeJS.ProcessEnv = process.env): CliRuntime {
  return resolveCliRuntime({ env })
}

/** `CTX_UI_LANG` (zh/en) wins, then the POSIX locale, then English. */
export function defaultUiLanguageFromEnv(env: NodeJS.ProcessEnv = process.env): UiLanguage {
  const explicit = env['CTX_UI_LANG']?.trim().toLowerCase()
  if (explicit === 'zh' || explicit === 'en') return explicit
  const locale =
    env['LC_ALL']?.trim() || env['LC_MESSAGES']?.trim() || env['LANG']?.trim() || ''
  return defaultUiLanguageFromLocale(locale)
}

/** Follow the OS UI language: Chinese locales start with `zh`. */
export function defaultUiLanguageFromLocale(locale: string): UiLanguage {
  return locale.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en'
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

/**
 * Claude Code counts as detected only when the resolved launcher actually proves
 * it is Claude Code (the same verdict `ctx doctor` shows). A failed or throwing
 * probe means "not detected" — the wizard must still open and offer `ctx init`.
 */
function claudeDetected(inspectClaude: () => ClaudeInspection): boolean {
  try {
    return inspectClaude().probe.ok
  } catch {
    return false
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

/**
 * DSH: Cortex registers in the home-level patch layer
 * (`$DSH_HOME/cordis.patch.yml`), which applies to every profile and survives
 * DSH's profile recovery. The per-profile patch layer is still recognized as a
 * legacy location (an old Cortex release wrote it there); `ctx init` migrates
 * it, so the wizard reports such an installation as configured.
 */
function dshConfigured(dshHome: string): boolean {
  const homePatch = readTextFile(join(dshHome, 'cordis.patch.yml'))
  if (homePatch !== null && isCortexPatchContent(homePatch)) return true
  const profilesRoot = join(dshHome, 'profiles')
  for (const profile of directoryNames(profilesRoot)) {
    const content = readTextFile(join(profilesRoot, profile, 'cordis.patch.yml'))
    if (content === null) continue
    if (isCortexPatchContent(content)) return true
  }
  return false
}

function isCortexPatchContent(content: string): boolean {
  return content.includes('mcp-cortex') || /serverName:\s*cortex\b/.test(content)
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

/** WorkBuddy: `mcpServers.cortex` exists in `~/.workbuddy/mcp.json`. */
function workbuddyConfigured(workbuddyHome: string): boolean {
  const content = readTextFile(join(workbuddyHome, 'mcp.json'))
  if (content === null) return false
  try {
    const parsed: unknown = JSON.parse(content)
    const servers = isJsonObject(parsed) ? parsed['mcpServers'] : undefined
    if (isJsonObject(servers) && servers['cortex'] !== undefined) return true
  } catch {
    // Fall through to the textual marker below.
  }
  return /"cortex"\s*:/.test(content)
}

/** ZCode: `mcp.servers.cortex` exists in `~/.zcode/cli/config.json`. */
function zcodeConfigured(zcodeHome: string): boolean {
  const content = readTextFile(join(zcodeHome, 'cli', 'config.json'))
  if (content === null) return false
  try {
    const parsed: unknown = JSON.parse(content)
    const mcp = isJsonObject(parsed) ? parsed['mcp'] : undefined
    const servers = isJsonObject(mcp) ? mcp['servers'] : undefined
    if (isJsonObject(servers) && servers['cortex'] !== undefined) return true
  } catch {
    // Fall through to the textual marker below.
  }
  return /"cortex"\s*:/.test(content)
}

/** Shared skills installed by a previous run (`ctx init` copies all three). */
function skillsConfigured(home: string): boolean {
  return existsSync(join(home, '.agents', 'skills', 'vuln-db', 'SKILL.md'))
}
