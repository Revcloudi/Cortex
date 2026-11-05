/**
 * Unit tests for src/cli/agents/claudeCommand.ts.
 *
 * Every external dependency of the module (`spawn`, `exists`, `platform`, `env`)
 * is injected, so these tests never execute a real `claude` / `bun` / `where.exe`
 * and do not depend on what is installed on the machine. Run through the repo's
 * existing `tsx` devDependency with the built-in Node test runner:
 *
 *   npx tsx --test src/cli/__tests__/claudeCommand.test.ts
 *
 * Key invariant under test: probing must only ever run `--version` or
 * `mcp list` — never the bare command (which would open the REPL) and never
 * a mutating `mcp add/remove`, `mcp get`, etc.
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  CLAUDE_BIN_ENV,
  claudeFixHint,
  claudeFixLines,
  claudeInstallCommands,
  probeClaudeCommand,
  resolveClaudeCommand
} from '../agents/claudeCommand'
import type {
  ClaudeCommandDeps,
  ClaudeProbeResult,
  ClaudeSpawn,
  ClaudeSpawnOptions,
  ClaudeSpawnResult
} from '../agents/claudeCommand'

/* -------------------------------------------------------------------------- */
/* Fake spawn: records every call and routes by (file, args)                  */
/* -------------------------------------------------------------------------- */

const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe'
const WIN_PATH = 'C:\\Windows\\System32;C:\\Program Files\\nodejs'
const CLAUDE_EXE = 'C:\\Users\\x\\AppData\\Local\\Programs\\claude\\claude.exe'
const CLAUDE_CMD = 'C:\\Program Files\\npm\\claude.cmd'
const BUN_SHIM_PATH = '.bun\\bin\\claude.exe'

interface RecordedSpawn {
  file: string
  args: string[]
  options: ClaudeSpawnOptions
}

interface CliCall {
  /** Command that was actually invoked (unwrapped from `cmd.exe /c call`). */
  command: string
  args: string[]
  spawn: RecordedSpawn
}

type LookupHandler = (file: string, args: string[]) => ClaudeSpawnResult | undefined
type CliHandler = (
  command: string,
  args: string[],
  spawn: RecordedSpawn
) => ClaudeSpawnResult | undefined

interface FakeSpawnConfig {
  /** Handles `where.exe` / `which`; returns undefined to use the "not found" default. */
  lookup?: LookupHandler
  /** Handles the actual CLI invocations (direct `.exe`, or unwrapped `.cmd`). */
  cli?: CliHandler
  /** `ComSpec` to recognize as the Windows shim launcher. Defaults to CMD_EXE. */
  comspec?: string
}

interface FakeSpawn {
  spawn: ClaudeSpawn
  /** Every spawn call, in order. */
  recorded: RecordedSpawn[]
  /** Only `where.exe` / `which` calls. */
  lookups: RecordedSpawn[]
  /** Only CLI invocations, with the `cmd.exe /c call` wrapper unwrapped. */
  cliCalls: CliCall[]
  /** Calls no handler matched: a test failure when non-empty. */
  unexpected: RecordedSpawn[]
}

const LOOKUP_FILES = new Set(['where.exe', 'which'])

function createFakeSpawn(config: FakeSpawnConfig = {}): FakeSpawn {
  const comspec = (config.comspec ?? CMD_EXE).toLowerCase()
  const fake: FakeSpawn = {
    spawn: () => ({ status: null }),
    recorded: [],
    lookups: [],
    cliCalls: [],
    unexpected: []
  }

  fake.spawn = (file, args, options) => {
    const recorded: RecordedSpawn = { file, args: [...args], options: { ...options } }
    fake.recorded.push(recorded)

    if (LOOKUP_FILES.has(file.toLowerCase())) {
      fake.lookups.push(recorded)
      return config.lookup?.(file, args) ?? { status: 1, stdout: '', stderr: '' }
    }

    let command = file
    let commandArgs = args
    if (file.toLowerCase() === comspec) {
      // The module must use `cmd.exe /d /s /c call <path> <args…>` for .cmd/.bat.
      const prefix = args.slice(0, 5)
      const expectedPrefix = ['/d', '/s', '/c', 'call']
      if (
        args.length < 5 ||
        prefix[0] !== expectedPrefix[0] ||
        prefix[1] !== expectedPrefix[1] ||
        prefix[2] !== expectedPrefix[2] ||
        prefix[3] !== expectedPrefix[3]
      ) {
        fake.unexpected.push(recorded)
        return { status: 127, stdout: '', stderr: 'unexpected cmd.exe arguments' }
      }
      command = args[4] as string
      commandArgs = args.slice(5)
    }

    const cliCall: CliCall = { command, args: commandArgs, spawn: recorded }
    fake.cliCalls.push(cliCall)
    const result = config.cli?.(command, commandArgs, recorded)
    if (result === undefined) {
      fake.unexpected.push(recorded)
      return { status: 127, stdout: '', stderr: `unexpected cli spawn: ${file}` }
    }
    return result
  }

  return fake
}

function winEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ComSpec: CMD_EXE, SystemRoot: 'C:\\Windows', PATH: WIN_PATH, ...extra }
}

function winDeps(fake: FakeSpawn, overrides: Partial<ClaudeCommandDeps> = {}): ClaudeCommandDeps {
  return {
    env: winEnv(),
    platform: 'win32',
    cwd: 'C:\\repo',
    spawn: fake.spawn,
    exists: () => false,
    ...overrides
  }
}

/* -------------------------------------------------------------------------- */
/* Small result builders + shared assertions                                  */
/* -------------------------------------------------------------------------- */

function claudeVersionResult(version = '2.1.29'): ClaudeSpawnResult {
  return { status: 0, stdout: `${version} (Claude Code)\r\n`, stderr: '' }
}

function bunVersionResult(): ClaudeSpawnResult {
  return {
    status: 0,
    stdout: 'Bun is a fast JavaScript runtime, package manager, bundler, and test runner.\r\n',
    stderr: ''
  }
}

function timeoutResult(): ClaudeSpawnResult {
  return { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }
}

/** `where.exe claude` responder. */
function whereReturns(stdout: string, status = 0): LookupHandler {
  return (file, args) => {
    if (file === 'where.exe' && args.length === 1 && args[0] === 'claude') {
      return { status, stdout, stderr: '' }
    }
    return undefined
  }
}

function isSafeProbeArgs(args: string[]): boolean {
  if (args.length === 1 && args[0] === '--version') return true
  if (args.length === 2 && args[0] === 'mcp' && args[1] === 'list') return true
  return false
}

/** Probe invocations may only be `--version` / `mcp list` and nothing unexpected. */
function assertProbeArgsSafe(fake: FakeSpawn): void {
  assert.deepEqual(
    fake.unexpected,
    [],
    `unexpected spawn calls: ${fake.unexpected.map((call) => `${call.file} ${call.args.join(' ')}`).join('; ')}`
  )
  for (const call of fake.cliCalls) {
    assert.ok(
      isSafeProbeArgs(call.args),
      `探测只允许 --version / mcp list，实际调用: ${call.command} ${JSON.stringify(call.args)}`
    )
    assert.notDeepEqual(call.args, [], '探测不能使用空参数（会进入 REPL）')
    assert.notEqual(call.command, 'claude', '不能裸调 claude（会进入 REPL）')
  }
}

function bunShimScenario(): { probe: ClaudeProbeResult; fake: FakeSpawn } {
  const fake = createFakeSpawn({
    lookup: whereReturns(`${BUN_SHIM_PATH}\r\n`),
    cli: (command, args) =>
      command === BUN_SHIM_PATH && args.length === 1 && args[0] === '--version'
        ? bunVersionResult()
        : undefined
  })
  return { probe: probeClaudeCommand(winDeps(fake)), fake }
}

function notFoundScenario(): {
  probe: ClaudeProbeResult
  fake: FakeSpawn
  existsCalls: string[]
} {
  const fake = createFakeSpawn({ lookup: () => ({ status: 1, stdout: '', stderr: '' }) })
  const existsCalls: string[] = []
  const probe = probeClaudeCommand(
    winDeps(fake, {
      exists: (filePath) => {
        existsCalls.push(filePath)
        return false
      }
    })
  )
  return { probe, fake, existsCalls }
}

/* -------------------------------------------------------------------------- */
/* 1. Bun shim                                                                */
/* -------------------------------------------------------------------------- */

test('Bun shim：claude 指向 Bun 时识别 bun-shim，不误判为 Claude Code', () => {
  const { probe, fake } = bunShimScenario()

  assert.equal(probe.ok, false)
  assert.equal(probe.reason, 'bun-shim')
  assert.equal(probe.command, BUN_SHIM_PATH)
  assert.equal(probe.kind, 'exe')
  assert.equal(probe.version, null)
  assert.equal(probe.method, undefined)
  assert.equal(probe.resolution.source, 'where')
  assert.deepEqual(probe.resolution.candidates, [BUN_SHIM_PATH])
  assert.equal(probe.resolution.path, BUN_SHIM_PATH)

  // Bun 已被识别：只探测过 --version，不继续 mcp list，更不会 mcp add/remove。
  assert.deepEqual(
    fake.cliCalls.map((call) => call.args),
    [['--version']]
  )
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 2. Native .exe                                                             */
/* -------------------------------------------------------------------------- */

test('Claude .exe：直接 spawn（不经 cmd.exe），--version 判定成功', () => {
  const fake = createFakeSpawn({
    lookup: whereReturns(`${CLAUDE_EXE}\r\n`),
    cli: (command, args) =>
      command === CLAUDE_EXE && args.length === 1 && args[0] === '--version'
        ? claudeVersionResult()
        : undefined
  })

  const probe = probeClaudeCommand(winDeps(fake))

  assert.equal(probe.ok, true)
  assert.equal(probe.command, CLAUDE_EXE)
  assert.equal(probe.kind, 'exe')
  assert.equal(probe.version, '2.1.29')
  assert.equal(probe.method, 'version')
  assert.equal(probe.reason, undefined)
  assert.equal(probe.resolution.source, 'where')

  const versionCall = fake.cliCalls[0] as CliCall
  assert.equal(versionCall.spawn.file, CLAUDE_EXE)
  assert.deepEqual(versionCall.spawn.args, ['--version'])
  assert.equal(versionCall.spawn.options.shell, false)
  // .exe 绝不能被 cmd.exe 包一层。
  assert.ok(
    !fake.recorded.some((call) => call.file.toLowerCase() === CMD_EXE.toLowerCase()),
    '.exe 不应经过 cmd.exe'
  )
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 3. npm .cmd shim                                                           */
/* -------------------------------------------------------------------------- */

test('Claude .cmd：经 cmd.exe /d /s /c call，路径含空格但作为单个参数', () => {
  const fake = createFakeSpawn({
    lookup: whereReturns(`${CLAUDE_CMD}\r\n`),
    cli: (command, args) =>
      command === CLAUDE_CMD && args.length === 1 && args[0] === '--version'
        ? claudeVersionResult()
        : undefined
  })

  const probe = probeClaudeCommand(winDeps(fake))

  assert.equal(probe.ok, true)
  assert.equal(probe.command, CLAUDE_CMD)
  assert.equal(probe.kind, 'cmd')
  assert.equal(probe.version, '2.1.29')
  assert.equal(probe.method, 'version')

  const call = fake.cliCalls[0] as CliCall
  assert.equal(call.spawn.file, CMD_EXE)
  assert.equal(call.spawn.options.shell, false)
  assert.deepEqual(call.spawn.args.slice(0, 5), ['/d', '/s', '/c', 'call', CLAUDE_CMD])
  assert.equal(call.spawn.args.length, 6)
  assert.equal(call.spawn.args[4], CLAUDE_CMD)
  assert.equal(call.spawn.args[5], '--version')
  // 参数数组而非 shell 字符串：含空格的路径是一个独立元素，未被拼接/拆分。
  assert.ok(call.spawn.args.includes(CLAUDE_CMD))
  assert.ok(
    !call.spawn.args.some((arg) => arg.includes('claude.cmd ')),
    '路径与参数不应被拼成 shell 字符串'
  )
  assert.equal(call.command, CLAUDE_CMD)
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 4. No command at all                                                       */
/* -------------------------------------------------------------------------- */

test('无命令：where.exe 空结果 + PATH 扫描无命中 → not-found', () => {
  const { probe, fake, existsCalls } = notFoundScenario()

  assert.equal(probe.ok, false)
  assert.equal(probe.reason, 'not-found')
  assert.equal(probe.command, null)
  assert.equal(probe.kind, null)
  assert.equal(probe.version, null)
  assert.equal(probe.method, undefined)
  assert.deepEqual(probe.resolution.candidates, [])
  assert.equal(probe.resolution.source, 'none')
  assert.ok(probe.detail?.includes('未找到 claude 命令'))

  // 没有候选时不启动任何 CLI 进程，只做过一次 where.exe 查找 + PATH 扫描。
  assert.equal(fake.cliCalls.length, 0)
  assert.deepEqual(
    fake.recorded.map((call) => call.file),
    ['where.exe']
  )
  assert.ok(existsCalls.length > 0, '应尝试过 PATH 扫描')
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 5. Multiple candidates: skip the Bun shim, continue with the real CLI      */
/* -------------------------------------------------------------------------- */

test('多候选：第一个是 Bun shim 时继续探测第二个 Claude .cmd', () => {
  const bunPath = 'C:\\bun\\bin\\claude.exe'
  const fake = createFakeSpawn({
    lookup: whereReturns(`${bunPath}\r\n${CLAUDE_CMD}\r\n`),
    cli: (command, args) => {
      if (args.length !== 1 || args[0] !== '--version') return undefined
      if (command === bunPath) return bunVersionResult()
      if (command === CLAUDE_CMD) return claudeVersionResult()
      return undefined
    }
  })

  const probe = probeClaudeCommand(winDeps(fake))

  assert.equal(probe.ok, true)
  assert.equal(probe.command, CLAUDE_CMD)
  assert.equal(probe.kind, 'cmd')
  assert.equal(probe.version, '2.1.29')
  assert.equal(probe.method, 'version')
  assert.deepEqual(probe.resolution.candidates, [bunPath, CLAUDE_CMD])

  assert.equal(fake.cliCalls.length, 2)
  assert.equal(fake.cliCalls[0].command, bunPath)
  assert.deepEqual(fake.cliCalls[0].args, ['--version'])
  assert.equal(fake.cliCalls[1].command, CLAUDE_CMD)
  assert.deepEqual(fake.cliCalls[1].args, ['--version'])
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 6. Timeouts                                                                */
/* -------------------------------------------------------------------------- */

test('超时：claude --version ETIMEDOUT → reason=timeout，不再尝试 mcp list', () => {
  const fake = createFakeSpawn({
    lookup: whereReturns(`${CLAUDE_EXE}\r\n`),
    cli: (command, args) =>
      command === CLAUDE_EXE && args.length === 1 && args[0] === '--version'
        ? timeoutResult()
        : undefined
  })

  const probe = probeClaudeCommand(winDeps(fake))

  assert.equal(probe.ok, false)
  assert.equal(probe.reason, 'timeout')
  assert.equal(probe.command, CLAUDE_EXE)
  assert.equal(probe.kind, 'exe')
  assert.equal(probe.version, null)
  assert.ok(probe.detail?.includes('10s'))
  assert.deepEqual(
    fake.cliCalls.map((call) => call.args),
    [['--version']]
  )
  assertProbeArgsSafe(fake)
})

test('超时：--version 无 Claude 特征、mcp list ETIMEDOUT → reason=timeout', () => {
  const fake = createFakeSpawn({
    lookup: whereReturns(`${CLAUDE_EXE}\r\n`),
    cli: (command, args) => {
      if (command !== CLAUDE_EXE) return undefined
      if (args.length === 1 && args[0] === '--version') {
        return { status: 0, stdout: '1.0.0\r\n', stderr: '' }
      }
      if (args.length === 2 && args[0] === 'mcp' && args[1] === 'list') return timeoutResult()
      return undefined
    }
  })

  const probe = probeClaudeCommand(winDeps(fake))

  assert.equal(probe.ok, false)
  assert.equal(probe.reason, 'timeout')
  assert.ok(probe.detail?.includes('mcp list 超过'))
  assert.deepEqual(
    fake.cliCalls.map((call) => call.args),
    [['--version'], ['mcp', 'list']]
  )
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 7. Wrong CLI on PATH (e.g. a Node wrapper that is not Claude Code)         */
/* -------------------------------------------------------------------------- */

test('wrong-cli：--version 输出 node 版本、mcp list 报 unknown command', () => {
  const fake = createFakeSpawn({
    lookup: whereReturns(`${CLAUDE_EXE}\r\n`),
    cli: (command, args) => {
      if (command !== CLAUDE_EXE) return undefined
      if (args.length === 1 && args[0] === '--version') {
        return { status: 0, stdout: 'node v24.21.0\r\n', stderr: '' }
      }
      if (args.length === 2 && args[0] === 'mcp' && args[1] === 'list') {
        return { status: 1, stdout: '', stderr: 'unknown command\r\n' }
      }
      return undefined
    }
  })

  const probe = probeClaudeCommand(winDeps(fake))

  assert.equal(probe.ok, false)
  assert.equal(probe.reason, 'wrong-cli')
  assert.equal(probe.command, CLAUDE_EXE)
  assert.equal(probe.version, null)
  assert.ok(probe.detail?.includes('不符合 Claude Code 特征'))
  assert.ok(probe.detail?.includes('unknown command'))
  assert.deepEqual(
    fake.cliCalls.map((call) => call.args),
    [['--version'], ['mcp', 'list']]
  )
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 8. `mcp list` fallback for older builds without a product name in version  */
/* -------------------------------------------------------------------------- */

test('mcp list 兜底：--version 无产品名但 mcp list 成功 → method=mcp-list', () => {
  const fake = createFakeSpawn({
    lookup: whereReturns(`${CLAUDE_EXE}\r\n`),
    cli: (command, args) => {
      if (command !== CLAUDE_EXE) return undefined
      if (args.length === 1 && args[0] === '--version') {
        return { status: 0, stdout: '1.0.0\r\n', stderr: '' }
      }
      if (args.length === 2 && args[0] === 'mcp' && args[1] === 'list') {
        return { status: 0, stdout: 'No MCP servers configured\r\n', stderr: '' }
      }
      return undefined
    }
  })

  const probe = probeClaudeCommand(winDeps(fake))

  assert.equal(probe.ok, true)
  assert.equal(probe.method, 'mcp-list')
  assert.equal(probe.command, CLAUDE_EXE)
  assert.equal(probe.kind, 'exe')
  assert.equal(probe.version, '1.0.0')
  assert.deepEqual(
    fake.cliCalls.map((call) => call.args),
    [['--version'], ['mcp', 'list']]
  )
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 9. CORTEX_CLAUDE_BIN override                                              */
/* -------------------------------------------------------------------------- */

test('CORTEX_CLAUDE_BIN：只探测指定路径，不混入系统查找', () => {
  const cwd = 'C:\\repo'
  const fixture = 'C:\\fixtures\\claude.exe'
  const expected = resolve(cwd, fixture)
  const env = winEnv({ [CLAUDE_BIN_ENV]: fixture })
  const fake = createFakeSpawn({
    cli: (command, args) =>
      command === expected && args.length === 1 && args[0] === '--version'
        ? bunVersionResult()
        : undefined
  })

  const deps: ClaudeCommandDeps = {
    env,
    platform: 'win32',
    cwd,
    spawn: fake.spawn,
    exists: () => false
  }
  const resolution = resolveClaudeCommand(deps)
  assert.equal(resolution.source, 'env')
  assert.deepEqual(resolution.candidates, [expected])
  assert.equal(resolution.path, expected)
  assert.equal(resolution.kind, 'exe')
  assert.equal(fake.lookups.length, 0, '显式指定路径时不应调用 where.exe/which')

  const probe = probeClaudeCommand(deps)
  assert.equal(probe.ok, false)
  assert.equal(probe.reason, 'bun-shim')
  assert.equal(probe.command, expected)
  assert.equal(probe.resolution.source, 'env')
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 10. POSIX lookup                                                           */
/* -------------------------------------------------------------------------- */

test('POSIX：which -a 解析候选，不调用 where.exe', () => {
  const fake = createFakeSpawn({
    lookup: (file, args) => {
      if (file === 'which' && args.length === 2 && args[0] === '-a' && args[1] === 'claude') {
        return { status: 0, stdout: '/usr/local/bin/claude\n/home/u/.local/bin/claude\n', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: '' }
    },
    cli: (command, args) =>
      command === '/usr/local/bin/claude' && args.length === 1 && args[0] === '--version'
        ? claudeVersionResult()
        : undefined
  })
  const deps: ClaudeCommandDeps = {
    env: {},
    platform: 'linux',
    cwd: '/repo',
    spawn: fake.spawn,
    exists: () => false
  }

  const resolution = resolveClaudeCommand(deps)
  assert.equal(resolution.source, 'which')
  assert.deepEqual(resolution.candidates, [
    '/usr/local/bin/claude',
    '/home/u/.local/bin/claude'
  ])
  assert.equal(resolution.path, '/usr/local/bin/claude')
  assert.equal(resolution.kind, 'shell')
  assert.deepEqual(
    fake.lookups.map((call) => call.file),
    ['which']
  )
  assert.ok(!fake.recorded.some((call) => call.file.toLowerCase() === 'where.exe'))

  // POSIX 下不需要 cmd.exe 包装，直接 spawn。
  const probe = probeClaudeCommand(deps)
  assert.equal(probe.ok, true)
  assert.equal(probe.command, '/usr/local/bin/claude')
  assert.equal(probe.kind, 'shell')
  assert.equal(probe.version, '2.1.29')
  assert.equal(probe.method, 'version')
  assert.deepEqual(fake.cliCalls[0].spawn.args, ['--version'])
  assertProbeArgsSafe(fake)
})

/* -------------------------------------------------------------------------- */
/* 11. Safety: probe never runs a REPL or a mutating sub-command              */
/* -------------------------------------------------------------------------- */

test('安全性：所有探测只使用 --version / mcp list，绝不裸 claude 或 mcp add/remove', () => {
  const scenarios: Array<{ probe: ClaudeProbeResult; fake: FakeSpawn }> = []

  scenarios.push(bunShimScenario())
  scenarios.push(notFoundScenario())

  const exeFake = createFakeSpawn({
    lookup: whereReturns(`${CLAUDE_EXE}\r\n`),
    cli: (command, args) => {
      if (command !== CLAUDE_EXE) return undefined
      if (args.length === 1 && args[0] === '--version') {
        return { status: 0, stdout: 'node v24.21.0\r\n', stderr: '' }
      }
      if (args.length === 2 && args[0] === 'mcp' && args[1] === 'list') {
        return { status: 1, stdout: '', stderr: 'unknown command\r\n' }
      }
      return undefined
    }
  })
  scenarios.push({ probe: probeClaudeCommand(winDeps(exeFake)), fake: exeFake })

  for (const scenario of scenarios) {
    assertProbeArgsSafe(scenario.fake)
    for (const call of scenario.fake.cliCalls) {
      const [first, second] = call.args
      if (first === 'mcp') {
        assert.equal(second, 'list', `禁止修改 MCP 配置: ${JSON.stringify(call.args)}`)
      }
    }
  }
})

/* -------------------------------------------------------------------------- */
/* 12. Diagnosis copy                                                         */
/* -------------------------------------------------------------------------- */

test('诊断文案：bun-shim / not-found 均给出 Bun 判断与安装命令', () => {
  const install = claudeInstallCommands('win32')

  const bunProbe = bunShimScenario().probe
  const bunLines = claudeFixLines(bunProbe, { platform: 'win32' })
  const bunText = bunLines.join('\n')
  assert.ok(bunLines.length > 0)
  assert.match(bunText, /Bun/)
  assert.ok(bunText.includes(install.official), 'bun-shim 修复步骤应含官方安装命令')
  assert.ok(bunText.includes(install.npm), 'bun-shim 修复步骤应含 npm 安装命令')
  assert.ok(bunText.includes('bun remove -g'), '应提示卸载 Bun 全局包')

  const bunHint = claudeFixHint(bunProbe, { platform: 'win32' })
  assert.match(bunHint, /Bun/)
  assert.ok(bunHint.includes(install.official))
  assert.ok(bunHint.includes(install.npm))

  const notFoundProbe = notFoundScenario().probe
  const notFoundText = claudeFixLines(notFoundProbe, { platform: 'win32' }).join('\n')
  assert.ok(notFoundText.includes(install.official), 'not-found 修复步骤应含官方安装命令')
  assert.ok(notFoundText.includes(install.npm), 'not-found 修复步骤应含 npm 安装命令')

  const notFoundHint = claudeFixHint(notFoundProbe, { platform: 'win32' })
  assert.match(notFoundHint, /安装 Claude Code/)
  assert.ok(notFoundHint.includes(install.official))
  assert.ok(notFoundHint.includes(install.npm))

  // 探测成功时不需要修复提示。
  const okFake = createFakeSpawn({
    lookup: whereReturns(`${CLAUDE_EXE}\r\n`),
    cli: (command, args) =>
      command === CLAUDE_EXE && args.length === 1 && args[0] === '--version'
        ? claudeVersionResult()
        : undefined
  })
  const okProbe = probeClaudeCommand(winDeps(okFake))
  assert.equal(okProbe.ok, true)
  assert.equal(claudeFixHint(okProbe, { platform: 'win32' }), '')
})
