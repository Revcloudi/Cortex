import { join } from 'node:path'
import { envOverride } from '../env'
import { CliError } from '../errors'

/**
 * `ctx init` building blocks: agent ids, target home resolution, detection and
 * the report/plan types shared by the per-agent writers.
 *
 * The per-agent modules (`dsh` / `codex` / `claude` / `cursor`) are pure: given
 * an injected `exists` / `readFile`, they return a plan with the candidate file
 * contents, so `runInit` can show a diff first and only then write.
 */

export type AgentId = 'dsh' | 'codex' | 'claude' | 'cursor' | 'workbuddy' | 'zcode'

export const AGENT_IDS: readonly AgentId[] = [
  'dsh',
  'codex',
  'claude',
  'cursor',
  'workbuddy',
  'zcode'
]

/** Language of the skill set copied by `ctx init --skill-lang`. */
export type SkillLanguage = 'zh' | 'en'

export type InitActionKind = 'mcp' | 'skill' | 'rule'

export type InitActionStatus =
  | 'created'
  | 'updated'
  | 'skipped'
  | 'manual-required'
  | 'planned'
  | 'failed'

export interface InitAction {
  agent?: AgentId
  kind: InitActionKind
  path: string
  status: InitActionStatus
  detail?: string
  diff?: string
}

export interface InitReport {
  dryRun: boolean
  /** Skill language copied into the agent skill directories. */
  skillLanguage: SkillLanguage
  actions: InitAction[]
  warnings: string[]
  restartHint: string
}

/**
 * Injectable `claude` CLI runner. Mirrors the shape of `spawnSync`, so a missing
 * CLI yields `{ status: null, error }` instead of throwing.
 */
export type ClaudeCliRunner = (args: string[]) => {
  status: number | null
  stdout?: string
  stderr?: string
  error?: unknown
}

/** A file the init run may create/overwrite. `content` is absent when skipped. */
export interface FilePlan {
  agent?: AgentId
  kind: InitActionKind
  path: string
  status: 'created' | 'updated' | 'skipped'
  detail?: string
  diff?: string
  content?: string
}

export interface AgentPlan {
  files: FilePlan[]
  warnings: string[]
}

export interface AgentHomes {
  dsh: string
  codex: string
  claude: string
  cursor: string
  workbuddy: string
  zcode: string
}

/**
 * Agent config roots. `home` already honors `CTX_INSTALL_HOME` (see
 * `resolveHomeDirectory`); the per-agent environment variables are developer
 * overrides.
 *
 * `CTX_INSTALL_HOME` (or its legacy alias `PDH_INSTALL_HOME`) acts as a
 * **sandbox**: when it is set, `DSH_HOME` / `CODEX_HOME` / `CLAUDE_HOME` are
 * ignored so tests (and power users) cannot write into the real agent homes of
 * the machine running them.
 */
export function resolveAgentHomes(home: string, env: NodeJS.ProcessEnv): AgentHomes {
  const sandboxed = installHomeOverride(env) !== undefined
  const override = (name: string): string | undefined =>
    sandboxed ? undefined : nonEmpty(env[name])
  return {
    dsh: override('DSH_HOME') ?? join(home, '.dsh'),
    codex: override('CODEX_HOME') ?? join(home, '.codex'),
    claude: override('CLAUDE_HOME') ?? join(home, '.claude'),
    cursor: join(home, '.cursor'),
    workbuddy: override('WORKBUDDY_HOME') ?? join(home, '.workbuddy'),
    zcode: override('ZCODE_HOME') ?? join(home, '.zcode')
  }
}

/**
 * `CTX_INSTALL_HOME`, falling back to the pre-rename `PDH_INSTALL_HOME` so an
 * existing onboarding/test setup keeps working.
 */
export function installHomeOverride(env: NodeJS.ProcessEnv): string | undefined {
  return envOverride(env, 'CTX_INSTALL_HOME', 'PDH_INSTALL_HOME')
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/**
 * Parse `--agents dsh,codex`. Returns `undefined` for "not specified" so the
 * caller can fall back to auto-detection; unknown names are a parameter error.
 */
export function parseAgentSelection(raw: string | undefined): AgentId[] | undefined {
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined

  const requested = new Set<AgentId>()
  for (const part of trimmed.split(',')) {
    const token = part.trim().toLowerCase()
    if (token.length === 0) continue
    if (!isAgentId(token)) {
      throw new CliError(
        `未知 Agent: ${token}（可选: dsh | codex | claude | cursor | workbuddy | zcode）`,
        1
      )
    }
    requested.add(token)
  }
  if (requested.size === 0) return undefined
  return AGENT_IDS.filter((agent) => requested.has(agent))
}

function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value)
}

export interface AgentDetection {
  dsh: boolean
  codex: boolean
  claude: boolean
  cursor: boolean
  workbuddy: boolean
  zcode: boolean
}

/**
 * Detect which agents are installed locally.
 *
 * DSH, Codex and Cursor are directory probes; Claude Code owns its registration
 * inside the CLI, so `claude --version` is the only reliable signal. A spawn
 * error (CLI not installed) simply means "not detected".
 */
export function detectAgents(
  homes: AgentHomes,
  exists: (filePath: string) => boolean,
  runClaudeCli: ClaudeCliRunner
): AgentDetection {
  return {
    dsh: exists(join(homes.dsh, 'profiles')),
    codex: exists(homes.codex),
    cursor: exists(homes.cursor),
    workbuddy: exists(homes.workbuddy),
    zcode: exists(join(homes.zcode, 'cli')) || exists(homes.zcode),
    claude: probeClaudeCli(runClaudeCli)
  }
}

export function probeClaudeCli(runClaudeCli: ClaudeCliRunner): boolean {
  try {
    const result = runClaudeCli(['--version'])
    return result.error === undefined && result.status === 0
  } catch {
    return false
  }
}
