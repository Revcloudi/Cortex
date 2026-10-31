import { join } from 'node:path'
import { envOverride } from '../env'
import { CliError } from '../errors'
import type { CliRuntime } from '../runtime'
import type { AgentId, AgentPlan, FilePlan, SkillLanguage } from './index'

/**
 * Copy the three agent skills (`vuln-db`, `asset-context`, `snapshot`) into the
 * agent skill directories.
 *
 * Skill sources are language-scoped: `<skillSourceDir>/<lang>/<name>.skill.md`.
 * Development builds read `<repo>/skills`, installed builds read
 * `<install>/bin/skills`, and `CTX_SKILL_DIR` overrides both.
 *
 * Every agent gets the shared `~/.agents/skills/<name>/SKILL.md` copy (the only
 * location DSH reads). Codex and Claude Code additionally get their own copy
 * under `<agent home>/skills`, matching the legacy layout.
 */

export const SKILL_NAMES = ['vuln-db', 'asset-context', 'snapshot'] as const
export type SkillName = (typeof SKILL_NAMES)[number]

export const SKILL_LANGUAGES: readonly SkillLanguage[] = ['zh', 'en']
export const DEFAULT_SKILL_LANGUAGE: SkillLanguage = 'zh'

export function isSkillLanguage(value: string): value is SkillLanguage {
  return (SKILL_LANGUAGES as readonly string[]).includes(value)
}

/**
 * Resolve the skill language: explicit `--skill-lang` wins, then
 * `CTX_SKILL_LANG`, then Chinese. Unknown values are parameter errors rather
 * than silently falling back, so a typo cannot install the wrong language.
 */
export function resolveSkillLanguage(
  raw: string | boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): SkillLanguage {
  if (raw === true) {
    throw new CliError('--skill-lang 需要一个值（可选 zh | en）', 1)
  }
  const flag = typeof raw === 'string' ? raw.trim().toLowerCase() : undefined
  if (flag !== undefined && flag.length > 0) {
    if (!isSkillLanguage(flag)) {
      throw new CliError(`--skill-lang 不合法：${flag}（可选 zh | en）`, 1)
    }
    return flag
  }

  const fromEnv = envOverride(env, 'CTX_SKILL_LANG')
  if (fromEnv !== undefined) {
    const normalized = fromEnv.toLowerCase()
    if (!isSkillLanguage(normalized)) {
      throw new CliError(`CTX_SKILL_LANG 不合法：${fromEnv}（可选 zh | en）`, 1)
    }
    return normalized
  }

  return DEFAULT_SKILL_LANGUAGE
}

export interface SkillPlanOptions {
  runtime: CliRuntime
  home: string
  codexHome: string
  claudeHome: string
  zcodeHome: string
  agents: readonly AgentId[]
  skillLanguage: SkillLanguage
  exists: (filePath: string) => boolean
  readFile: (filePath: string) => string
}

export function skillSourcePath(
  runtime: CliRuntime,
  name: SkillName,
  language: SkillLanguage
): string {
  return join(runtime.skillSourceDir, language, `${name}.skill.md`)
}

export function skillTargets(
  options: Pick<SkillPlanOptions, 'home' | 'codexHome' | 'claudeHome' | 'zcodeHome' | 'agents'>,
  name: SkillName
): Array<{ agent?: AgentId; path: string }> {
  const targets: Array<{ agent?: AgentId; path: string }> = [
    { path: join(options.home, '.agents', 'skills', name, 'SKILL.md') }
  ]
  if (options.agents.includes('codex')) {
    targets.push({ agent: 'codex', path: join(options.codexHome, 'skills', name, 'SKILL.md') })
  }
  if (options.agents.includes('claude')) {
    targets.push({ agent: 'claude', path: join(options.claudeHome, 'skills', name, 'SKILL.md') })
  }
  if (options.agents.includes('zcode')) {
    targets.push({ agent: 'zcode', path: join(options.zcodeHome, 'skills', name, 'SKILL.md') })
  }
  return targets
}

export function planSkills(options: SkillPlanOptions): AgentPlan {
  const files: FilePlan[] = []
  const warnings: string[] = []

  if (options.agents.includes('workbuddy')) {
    warnings.push(
      'WorkBuddy 的技能需在 WorkBuddy「设置 → 技能」中从 ~/.agents/skills 导入（Cortex 已写入共享技能目录）'
    )
  }

  for (const name of SKILL_NAMES) {
    const source = skillSourcePath(options.runtime, name, options.skillLanguage)
    if (!options.exists(source)) {
      warnings.push(
        `未找到技能文件 ${source}（语言 ${options.skillLanguage}，跳过 ${name} 安装）`
      )
      files.push({
        agent: undefined,
        kind: 'skill',
        path: join(options.home, '.agents', 'skills', name, 'SKILL.md'),
        status: 'skipped',
        detail: `缺少技能源文件 ${source}`
      })
      continue
    }

    const content = options.readFile(source)
    for (const target of skillTargets(options, name)) {
      const existed = options.exists(target.path)
      if (existed && options.readFile(target.path) === content) {
        files.push({
          agent: target.agent,
          kind: 'skill',
          path: target.path,
          status: 'skipped',
          detail: '内容已最新'
        })
        continue
      }
      files.push({
        agent: target.agent,
        kind: 'skill',
        path: target.path,
        status: existed ? 'updated' : 'created',
        content
      })
    }
  }

  return { files, warnings }
}
