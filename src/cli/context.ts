import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { DatabaseService, readSchemaVersion } from '../core/db/DatabaseService'
import { resolveDbPath } from '../core/paths'
import { DATABASE_SCHEMA_VERSION } from '../shared/types'
import { envOverride } from './env'
import { CliError } from './errors'

/**
 * Every external dependency a `ctx` command needs.
 *
 * Injected so commands are testable in-process without spawning a child process
 * and without touching the developer's real home directory or database.
 */
export interface CliContext {
  /** `--json`: machine-readable output, no ANSI, no human tables. */
  json: boolean
  env: NodeJS.ProcessEnv
  homeDir: string
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export interface CreateCliContextOptions {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  homeDir?: string
  cwd?: string
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export function createCliContext(options: CreateCliContextOptions = {}): CliContext {
  const argv = options.argv ?? process.argv
  return {
    json: argv.includes('--json'),
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
    cwd: options.cwd ?? process.cwd(),
    stdout: options.stdout ?? ((text: string) => process.stdout.write(`${text}\n`)),
    stderr: options.stderr ?? ((text: string) => process.stderr.write(`${text}\n`))
  }
}

/** Absolute path of the database this CLI invocation will use. */
export function cliDatabasePath(context: CliContext): string {
  return resolveDbPath({ env: context.env, homeDir: context.homeDir })
}

export interface OpenDatabaseOptions {
  /**
   * When true a missing database is created (used by `ctx init` / doctor-like
   * commands). Read commands default to a friendly "not created yet" error.
   */
  create?: boolean
}

/**
 * Open the shared database for a read command.
 *
 * Read-only commands must not silently migrate an outdated schema: opening an
 * old library and writing to it from the CLI could race the GUI's migration.
 * When the on-disk `user_version` lags, we ask the user to start the GUI (or run
 * `ctx doctor`) first; a missing file is a "no data yet" condition (exit 2).
 */
export function openDatabase(context: CliContext, options: OpenDatabaseOptions = {}): DatabaseService {
  const dbPath = cliDatabasePath(context)
  const version = readSchemaVersion(dbPath)

  if (version === null) {
    if (options.create === true) return new DatabaseService(dbPath)
    throw new CliError(
      `数据库尚未创建：${dbPath}\n请先启动 Cortex 桌面端或让 Agent 完成一次写入，然后再试。`,
      2
    )
  }

  if (version > DATABASE_SCHEMA_VERSION) {
    throw new CliError(
      `数据库 schema 版本（v${version}）高于当前 CLI 支持的版本（v${DATABASE_SCHEMA_VERSION}）：请更新 Cortex 后再试。`,
      1
    )
  }

  if (version < DATABASE_SCHEMA_VERSION) {
    throw new CliError(
      `数据库 schema 版本过旧（v${version} < v${DATABASE_SCHEMA_VERSION}）：请先启动 GUI 完成迁移，或运行 ctx doctor 查看详情。`,
      1
    )
  }

  return new DatabaseService(dbPath)
}

/** `platform`-aware executable name, shared by doctor / init helpers. */
export function nodeExecutableName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/**
 * Home directory used for agent config/skill targets.
 *
 * `CTX_INSTALL_HOME` (legacy `PDH_INSTALL_HOME`) exists for tests and power
 * users: `ctx init` then edits a throw-away home instead of the real `~/.dsh`,
 * `~/.codex`, `~/.claude`.
 */
export function resolveHomeDirectory(context: CliContext): string {
  return envOverride(context.env, 'CTX_INSTALL_HOME', 'PDH_INSTALL_HOME') ?? context.homeDir
}

export function pathExists(filePath: string): boolean {
  return existsSync(filePath)
}
