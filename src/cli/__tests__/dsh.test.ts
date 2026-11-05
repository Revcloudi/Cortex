/**
 * Unit tests for src/cli/agents/dsh.ts — the DSH MCP registration migration.
 *
 * Cortex used to write its marker-managed MCP block into
 * `~/.dsh/profiles/<profile>/cordis.patch.yml`. DSH profile recovery renames
 * that layer away, so the registration is now written to the DSH **home/root**
 * patch layer (`$DSH_HOME/cordis.patch.yml`), which applies to every profile
 * and is natively preserved. The old per-profile block is stripped during
 * `ctx init` so DSH never sees two `serverName: cortex` entries.
 *
 * These tests use a real temp directory per test (`mkdtempSync(os.tmpdir())`)
 * and parse every generated patch with the `yaml` package. The real `~/.dsh` /
 * `~/.agents` are never read or written: `dshHome` is always the temp dir and
 * the plan must only touch paths inside it.
 *
 * Run through the repo's `tsx` devDependency (see package.json "test"):
 *   npx tsx --test src/cli/__tests__/dsh.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { TestContext } from 'node:test'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'
import { detectAgents } from '../agents'
import type { AgentHomes, AgentPlan, FilePlan } from '../agents'
import { buildDshMcpBlock, planDsh, resolveDshPaths } from '../agents/dsh'
import { MCP_MARKERS, RULE_MARKERS } from '../agents/markers'
import type { CliRuntime } from '../runtime'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const RUNTIME: CliRuntime = {
  mode: 'installed',
  nodeExecutable: 'C:\\Program Files\\Cortex\\bin\\node.exe',
  mcpEntry: 'C:\\Program Files\\Cortex\\bin\\mcp-stdio.cjs',
  cliEntry: 'C:\\Program Files\\Cortex\\bin\\ctx.cjs',
  root: 'C:\\Program Files\\Cortex',
  skillSourceDir: 'C:\\Program Files\\Cortex\\bin\\skills'
}

/** `buildDshMcpBlock` always renders forward-slash paths. */
const POSIX_NODE = RUNTIME.nodeExecutable.replace(/\\/g, '/')
const POSIX_ENTRY = RUNTIME.mcpEntry.replace(/\\/g, '/')

const USER_LOCALE_PATCH = [
  '- id: locale',
  "  name: '@deepseek-ai/dsh-client-locale'",
  '  config:',
  '    locale: zh'
].join('\n')

/* -------------------------------------------------------------------------- */
/* Temp-home helpers (never touch the real user home)                         */
/* -------------------------------------------------------------------------- */

function tempHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), 'cortex-dsh-test-'))
  t.after(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
  })
  return home
}

function writeText(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

function isInside(root: string, filePath: string): boolean {
  if (filePath === root) return true
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return filePath.startsWith(prefix)
}

interface PlanRun {
  plan: AgentPlan
  paths: ReturnType<typeof resolveDshPaths>
  /** Every path the plan asked `exists`/`readFile` about, in order. */
  accessed: string[]
}

/** Run `planDsh` against a real temp home, recording every filesystem probe. */
function runPlan(home: string, env: NodeJS.ProcessEnv = {}): PlanRun {
  const accessed: string[] = []
  const exists = (filePath: string): boolean => {
    accessed.push(filePath)
    return existsSync(filePath)
  }
  const readFile = (filePath: string): string => {
    accessed.push(filePath)
    return readText(filePath)
  }
  const paths = resolveDshPaths(home, env, exists)
  const plan = planDsh({ dshHome: home, env, runtime: RUNTIME, exists, readFile })

  // Isolation guard: the plan may only ever look at the injected temp home.
  for (const filePath of accessed) {
    assert.ok(isInside(home, filePath), `规划访问了临时 home 之外的路径: ${filePath}`)
  }
  for (const file of plan.files) {
    assert.ok(isInside(home, file.path), `FilePlan 指向临时 home 之外的路径: ${file.path}`)
  }
  return { plan, paths, accessed }
}

/* -------------------------------------------------------------------------- */
/* Assertion helpers                                                          */
/* -------------------------------------------------------------------------- */

function filesOfKind(plan: AgentPlan, kind: 'mcp' | 'rule'): FilePlan[] {
  return plan.files.filter((file) => file.kind === kind)
}

function findMcpPlanFor(plan: AgentPlan, patchPath: string): FilePlan {
  const found = plan.files.find((file) => file.kind === 'mcp' && file.path === patchPath)
  assert.ok(
    found !== undefined,
    `未找到 ${patchPath} 的 mcp FilePlan；实际: ${JSON.stringify(
      plan.files.map((file) => ({ kind: file.kind, path: file.path, status: file.status }))
    )}`
  )
  return found
}

/** A created/updated action must carry content; skipped ones must not. */
function planContent(file: FilePlan): string {
  assert.ok(file.content !== undefined, `${file.path} 的 FilePlan 缺少 content`)
  return file.content
}

function parsePatchList(content: string): Record<string, unknown>[] {
  const parsed = parseYaml(content) as unknown
  assert.ok(Array.isArray(parsed), `patch 内容应为 YAML 数组，实际: ${String(parsed)}`)
  return parsed as Record<string, unknown>[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface McpCortexEntry {
  id: unknown
  name: unknown
  config: Record<string, unknown>
}

/** Locate `- insert: [{ id: mcp-cortex, … }]` in a parsed patch layer. */
function findMcpCortexEntry(content: string): McpCortexEntry {
  for (const item of parsePatchList(content)) {
    const insert = item['insert']
    if (!Array.isArray(insert)) continue
    for (const entry of insert) {
      if (!isRecord(entry) || entry['id'] !== 'mcp-cortex') continue
      return {
        id: entry['id'],
        name: entry['name'],
        config: isRecord(entry['config']) ? entry['config'] : {}
      }
    }
  }
  assert.fail('patch 中未找到 insert → id: mcp-cortex 条目')
}

function assertNoCortexResidue(content: string): void {
  assert.ok(!content.includes('mcp-cortex'), `清理后仍残留 mcp-cortex: ${content}`)
  assert.ok(!content.includes('CORTEX'), `清理后仍残留 CORTEX 标记: ${content}`)
  assert.ok(!content.includes('serverName: cortex'), `清理后仍残留 serverName: cortex: ${content}`)
}

function agentHomes(home: string): AgentHomes {
  return {
    dsh: join(home, '.dsh'),
    codex: join(home, '.codex'),
    claude: join(home, '.claude'),
    cursor: join(home, '.cursor'),
    workbuddy: join(home, '.workbuddy'),
    zcode: join(home, '.zcode')
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Fresh DSH home                                                          */
/* -------------------------------------------------------------------------- */

test('全新 DSH home：注册写入 $DSH_HOME/cordis.patch.yml（created）并生成 AGENTS.md 规则', (t) => {
  const home = tempHome(t)
  const { plan, paths } = runPlan(home)
  const homePatchPath = join(home, 'cordis.patch.yml')

  // Path contract: root patch layer + legacy per-profile path for diagnostics.
  assert.equal(paths.homePatchPath, homePatchPath)
  assert.equal(paths.profilesRoot, join(home, 'profiles'))
  assert.equal(paths.legacyPatchPath, join(home, 'profiles', 'desktop', 'cordis.patch.yml'))
  assert.equal(paths.rulePath, join(home, 'AGENTS.md'))

  const homePlan = findMcpPlanFor(plan, homePatchPath)
  assert.equal(homePlan.status, 'created')
  assert.equal(homePlan.agent, 'dsh')
  const content = planContent(homePlan)
  assert.ok(content.includes(MCP_MARKERS.begin), 'content 应包含 CORTEX BEGIN 标记')
  assert.ok(content.includes(MCP_MARKERS.end), 'content 应包含 CORTEX END 标记')

  // YAML: top-level array with one `insert:` entry for the Cortex MCP client.
  const parsed = parsePatchList(content)
  assert.equal(parsed.length, 1)
  const entry = findMcpCortexEntry(content)
  assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(entry.config['serverName'], 'cortex')
  assert.equal(entry.config['transport'], 'stdio')
  assert.equal(entry.config['command'], POSIX_NODE)
  assert.deepEqual(entry.config['args'], [POSIX_ENTRY])

  // Root layer only: without a profiles/ directory there is no cleanup action.
  assert.equal(filesOfKind(plan, 'mcp').length, 1)

  const rulePlan = plan.files.find((file) => file.kind === 'rule')
  assert.ok(rulePlan !== undefined, '应生成 AGENTS.md 规则 FilePlan')
  assert.equal(rulePlan.agent, 'dsh')
  assert.equal(rulePlan.path, join(home, 'AGENTS.md'))
  assert.equal(rulePlan.status, 'created')
  const ruleContent = planContent(rulePlan)
  assert.ok(ruleContent.includes(RULE_MARKERS.begin))
  assert.ok(ruleContent.includes(RULE_MARKERS.end))

  assert.deepEqual(plan.warnings, [])
  assert.equal(existsSync(homePatchPath), false, 'planDsh 只规划、不落盘')
})

/* -------------------------------------------------------------------------- */
/* 2. Existing home patch keeps user entries                                  */
/* -------------------------------------------------------------------------- */

test('已有根目录 patch：保留用户条目并追加 Cortex 块（updated，YAML 合法）', (t) => {
  const home = tempHome(t)
  const homePatchPath = join(home, 'cordis.patch.yml')
  writeText(homePatchPath, `${USER_LOCALE_PATCH}\n`)

  const { plan } = runPlan(home)
  const homePlan = findMcpPlanFor(plan, homePatchPath)
  assert.equal(homePlan.status, 'updated')

  const content = planContent(homePlan)
  assert.ok(content.startsWith(USER_LOCALE_PATCH), '用户内容必须原样保留在文件开头')
  assert.ok(content.includes('id: locale'), '必须保留用户条目')
  assert.ok(content.includes('locale: zh'), '必须保留用户配置')
  assert.ok(content.includes(MCP_MARKERS.begin), '必须写入 CORTEX 块')
  assert.ok(content.includes(MCP_MARKERS.end))

  const parsed = parsePatchList(content)
  assert.equal(parsed.length, 2, '用户条目 + insert 条目共两条')
  assert.ok(parsed.some((item) => item['id'] === 'locale'))
  assert.equal(findMcpCortexEntry(content).config['serverName'], 'cortex')
})

/* -------------------------------------------------------------------------- */
/* 3. Legacy per-profile migration                                            */
/* -------------------------------------------------------------------------- */

test('legacy profile 迁移：从 profile patch 清除 CORTEX 块并保留用户条目', (t) => {
  const home = tempHome(t)
  const legacyPatchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  writeText(legacyPatchPath, `${USER_LOCALE_PATCH}\n\n${buildDshMcpBlock(RUNTIME)}\n`)
  // A user-only profile patch must be left untouched.
  const untouchedPatch = join(home, 'profiles', 'web', 'cordis.patch.yml')
  writeText(untouchedPatch, `${USER_LOCALE_PATCH}\n`)

  const { plan, paths } = runPlan(home)
  assert.equal(paths.legacyPatchPath, legacyPatchPath)
  assert.equal(paths.profile, 'desktop')

  // Home layer is created…
  const homePlan = findMcpPlanFor(plan, join(home, 'cordis.patch.yml'))
  assert.equal(homePlan.status, 'created')
  assert.equal(findMcpCortexEntry(planContent(homePlan)).config['serverName'], 'cortex')

  // …and the legacy block is removed from the profile layer.
  const cleanup = findMcpPlanFor(plan, legacyPatchPath)
  assert.equal(cleanup.status, 'updated')
  assert.ok(cleanup.detail?.includes('per-profile'))
  assert.ok(cleanup.diff?.includes(MCP_MARKERS.begin), 'diff 应展示被移除的 CORTEX 块')

  const content = planContent(cleanup)
  assertNoCortexResidue(content)
  assert.ok(content.includes('id: locale'), '必须保留用户条目')
  assert.ok(content.includes('locale: zh'))
  const parsed = parsePatchList(content)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.['id'], 'locale')

  // User-only profile patch: no action at all.
  assert.equal(
    plan.files.some((file) => file.path === untouchedPatch),
    false,
    '不含 Cortex 内容的 profile patch 不应产生清理动作'
  )
  assert.equal(filesOfKind(plan, 'mcp').length, 2)
})

/* -------------------------------------------------------------------------- */
/* 4. Legacy profile with ONLY the Cortex block → '[]'                        */
/* -------------------------------------------------------------------------- */

test("legacy profile 仅含 CORTEX 块：清理后内容为 '[]\\n'（DSH 不接受空 patch）", (t) => {
  const home = tempHome(t)
  const legacyPatchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  writeText(legacyPatchPath, `${buildDshMcpBlock(RUNTIME)}\n`)

  const { plan } = runPlan(home)
  const cleanup = findMcpPlanFor(plan, legacyPatchPath)
  assert.equal(cleanup.status, 'updated')
  const content = planContent(cleanup)
  assert.equal(content, '[]\n')
  assert.deepEqual(parseYaml(content), [])
})

/* -------------------------------------------------------------------------- */
/* 5. Idempotency                                                             */
/* -------------------------------------------------------------------------- */

test('幂等：已安装的根目录 patch 再次规划为 skipped，且无 profile 清理动作', (t) => {
  const home = tempHome(t)
  const homePatchPath = join(home, 'cordis.patch.yml')

  const first = runPlan(home)
  const created = findMcpPlanFor(first.plan, homePatchPath)
  assert.equal(created.status, 'created')
  writeText(homePatchPath, planContent(created)) // simulate a previous ctx init

  const second = runPlan(home)
  const homePlans = second.plan.files.filter(
    (file) => file.kind === 'mcp' && file.path === homePatchPath
  )
  assert.equal(homePlans.length, 1)
  assert.equal(homePlans[0]?.status, 'skipped')
  assert.equal(homePlans[0]?.detail, '内容已最新')
  assert.equal(homePlans[0]?.content, undefined)

  assert.equal(filesOfKind(second.plan, 'mcp').length, 1, '不应产生 profile 清理动作')
  assert.deepEqual(second.plan.warnings, [])
})

/* -------------------------------------------------------------------------- */
/* 6. Corrupted multi-marker file (real-world historical format)              */
/* -------------------------------------------------------------------------- */

test('损坏的多重 marker：清理后无 mcp-cortex / 无 CORTEX 标记残留、保留用户条目且 YAML 合法', (t) => {
  const home = tempHome(t)
  const legacyPatchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  const comment = '# Cortex 2.0：纯 stdio MCP（历史损坏文件）'
  const damaged = [
    USER_LOCALE_PATCH,
    '',
    MCP_MARKERS.begin,
    comment,
    '- insert:',
    '',
    MCP_MARKERS.begin,
    comment,
    '- insert:',
    '    - id: mcp-cortex',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: cortex',
    MCP_MARKERS.end,
    MCP_MARKERS.end,
    ''
  ].join('\n')
  writeText(legacyPatchPath, damaged)

  const { plan } = runPlan(home)
  const cleanup = findMcpPlanFor(plan, legacyPatchPath)
  assert.equal(cleanup.status, 'updated')

  const content = planContent(cleanup)
  assertNoCortexResidue(content)
  assert.ok(!content.includes('insert:'), '空的 - insert: 条目应一并清理')
  assert.ok(content.includes('id: locale'), '必须保留用户条目')
  assert.ok(content.includes('locale: zh'))

  const parsed = parsePatchList(content)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.['id'], 'locale')
  assert.ok(cleanup.diff?.includes('mcp-cortex'), 'diff 应展示被移除的 CORTEX 条目')
})

/* -------------------------------------------------------------------------- */
/* 7. Unmarked legacy entry (no marker comments)                              */
/* -------------------------------------------------------------------------- */

test('根目录 patch 里的未标记旧条目：替换为 marker 块、吞掉空父 - insert:，二次规划幂等', (t) => {
  const home = tempHome(t)
  const homePatchPath = join(home, 'cordis.patch.yml')
  // Historical format: an `- insert:` list whose only child is the old,
  // unmarked Cortex entry (no BEGIN/END markers around it).
  const unmarkedLegacy = [
    USER_LOCALE_PATCH,
    '',
    '- insert:',
    '    - id: mcp-cortex',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: cortex',
    '        transport: stdio',
    '        command: "C:/old/node.exe"',
    '        args:',
    '          - "C:/old/stdio.cjs"',
    ''
  ].join('\n')
  writeText(homePatchPath, unmarkedLegacy)

  const first = runPlan(home)
  const updated = findMcpPlanFor(first.plan, homePatchPath)
  assert.equal(updated.status, 'updated')

  const content = planContent(updated)
  assert.ok(content.includes(MCP_MARKERS.begin), '应写入新的 marker 块')
  assert.ok(content.includes(MCP_MARKERS.end))
  assert.ok(!content.includes('C:/old/node.exe'), '旧 command 应被新 runtime 替换')
  // The now-childless parent `- insert:` must be swallowed, leaving exactly the
  // marker block's own `- insert:` (otherwise YAML would hold insert: null).
  const insertLines = content.split('\n').filter((line) => /^-\s+insert:\s*$/.test(line))
  assert.equal(insertLines.length, 1, '空的父 - insert: 应被吞掉，只保留 Cortex 块的 insert')
  const parsed = parsePatchList(content)
  assert.equal(parsed.length, 2, '用户条目 + Cortex insert 条目')
  assert.ok(parsed.some((item) => item['id'] === 'locale'))
  const entry = findMcpCortexEntry(content)
  assert.equal(entry.config['serverName'], 'cortex')
  assert.equal(entry.config['command'], POSIX_NODE)
  assert.deepEqual(entry.config['args'], [POSIX_ENTRY])

  // Idempotency: apply the plan, then planDsh must be a no-op.
  writeText(homePatchPath, content)
  const second = runPlan(home)
  const secondPlans = second.plan.files.filter(
    (file) => file.kind === 'mcp' && file.path === homePatchPath
  )
  assert.equal(secondPlans.length, 1)
  assert.equal(secondPlans[0]?.status, 'skipped')
  assert.equal(secondPlans[0]?.detail, '内容已最新')
})

test('legacy profile 里的未标记旧条目：清理后仅剩用户条目（无 insert: null）', (t) => {
  const home = tempHome(t)
  const legacyPatchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  const unmarkedLegacy = [
    USER_LOCALE_PATCH,
    '',
    '- insert:',
    '    - id: mcp-pentest-data-hub',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: cortex'
  ].join('\n')
  writeText(legacyPatchPath, unmarkedLegacy)

  const { plan } = runPlan(home)
  const cleanup = findMcpPlanFor(plan, legacyPatchPath)
  assert.equal(cleanup.status, 'updated')
  const content = planContent(cleanup)
  assertNoCortexResidue(content)
  assert.ok(!content.includes('insert:'), '无子项的 - insert: 必须一并清除')
  assert.ok(content.includes('id: locale'))
  const parsed = parsePatchList(content)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.['id'], 'locale')
})

/* -------------------------------------------------------------------------- */
/* 8. detectAgents: DSH is detected by its home directory alone               */
/* -------------------------------------------------------------------------- */

test('detectAgents：$DSH_HOME 目录存在即判定 dsh（没有 profiles 子目录也算）', (t) => {
  const home = tempHome(t)
  const homes = agentHomes(home)
  mkdirSync(homes.dsh, { recursive: true })
  assert.equal(existsSync(join(homes.dsh, 'profiles')), false, '本用例故意不创建 profiles 目录')

  const probed: string[] = []
  const exists = (filePath: string): boolean => {
    probed.push(filePath)
    return existsSync(filePath)
  }
  const detected = detectAgents(homes, exists, false)
  assert.equal(detected.dsh, true)
  assert.ok(probed.includes(homes.dsh), '应探测 $DSH_HOME 目录本身')
  assert.ok(!probed.includes(join(homes.dsh, 'profiles')), '不应再要求 profiles 子目录')

  const missing = detectAgents({ ...homes, dsh: join(home, 'missing-dsh') }, existsSync, false)
  assert.equal(missing.dsh, false)
})

test('detectAgents：codex/cursor/workbuddy/zcode/claude 的检测规则不变', (t) => {
  const home = tempHome(t)
  const homes = agentHomes(home)

  const present = new Set<string>([
    homes.dsh,
    homes.codex,
    homes.cursor,
    homes.workbuddy,
    join(homes.zcode, 'cli')
  ])
  const exists = (filePath: string): boolean => present.has(filePath)
  assert.deepEqual(detectAgents(homes, exists, true), {
    dsh: true,
    codex: true,
    claude: true,
    cursor: true,
    workbuddy: true,
    zcode: true
  })

  // ZCode also accepts the home directory itself (not only `<zcode>/cli`).
  assert.deepEqual(detectAgents(homes, (filePath) => filePath === homes.zcode, false), {
    dsh: false,
    codex: false,
    claude: false,
    cursor: false,
    workbuddy: false,
    zcode: true
  })

  // Claude is driven exclusively by the probe verdict, never by ~/.claude.
  assert.deepEqual(detectAgents(homes, (filePath) => filePath === homes.claude, false), {
    dsh: false,
    codex: false,
    claude: false,
    cursor: false,
    workbuddy: false,
    zcode: false
  })
})

/* -------------------------------------------------------------------------- */
/* 9. Isolation: planning never reads/writes outside the injected home        */
/* -------------------------------------------------------------------------- */

test('隔离性：规划只访问注入的临时 DSH home，不触碰真实 ~/.dsh / ~/.agents', (t) => {
  const home = tempHome(t)
  const accessed: string[] = []
  const exists = (filePath: string): boolean => {
    accessed.push(filePath)
    return existsSync(filePath)
  }
  const readFile = (filePath: string): string => {
    accessed.push(filePath)
    return readText(filePath)
  }

  const plan = planDsh({ dshHome: home, env: {}, runtime: RUNTIME, exists, readFile })
  assert.ok(accessed.length > 0, '规划应至少探测一次文件')

  for (const filePath of accessed) {
    assert.ok(isInside(home, filePath), `访问了临时 home 之外的路径: ${filePath}`)
  }
  for (const file of plan.files) {
    assert.ok(isInside(home, file.path), `FilePlan 指向临时 home 之外的路径: ${file.path}`)
  }

  // Nothing was written by planning: the temp home stays empty until the
  // caller applies the plan.
  assert.deepEqual(
    plan.files.filter((file) => existsSync(file.path)),
    []
  )
})
