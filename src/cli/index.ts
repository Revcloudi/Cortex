import { cac } from 'cac'
import { CORTEX_VERSION } from '../core/version'
import { createCliContext } from './context'
import { registerAssetCommands } from './commands/assets'
import { registerDoctorCommand } from './commands/doctor'
import { registerInitCommand } from './commands/init'
import { registerMcpConfigCommands } from './commands/mcpConfig'
import { registerOpenCommand } from './commands/open'
import { registerSearchCommand } from './commands/search'
import { registerSnapshotCommands } from './commands/snapshots'
import { registerVulnCommands } from './commands/vulns'
import { isCliError } from './errors'

/**
 * Build and run the `ctx` CLI. Exported rather than executed on import so tests
 * can exercise the real dispatcher in-process.
 *
 * Exit codes: 0 success, 1 parameter / IO / runtime error, 2 data not found.
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  const context = createCliContext({ argv })
  const cli = cac('ctx')
  cli.option('--json', '机器可读 JSON 输出（所有查询命令）')
  cli.version(CORTEX_VERSION)
  cli.help()

  registerInitCommand(cli)
  registerDoctorCommand(cli)
  registerMcpConfigCommands(cli)
  registerVulnCommands(cli)
  registerAssetCommands(cli)
  registerSnapshotCommands(cli)
  registerSearchCommand(cli)
  registerOpenCommand(cli)

  try {
    const parsed = cli.parse(argv, { run: false })
    if (parsed.options.help === true || parsed.options.version === true) return 0

    if (cli.matchedCommand === undefined) {
      cli.outputHelp()
      const attempted = parsed.args.filter((arg) => !arg.startsWith('-')).slice(0, 2)
      if (attempted.length > 0) {
        context.stderr(`未知命令: ${attempted.join(' ')}（运行 ctx --help 查看命令列表）`)
        return 1
      }
      return 0
    }

    await cli.runMatchedCommand()
    return 0
  } catch (error) {
    if (isCliError(error)) {
      context.stderr(`错误: ${error.message}`)
      return error.exitCode
    }
    if (error instanceof Error) {
      context.stderr(`错误: ${error.message}`)
      return 1
    }
    context.stderr(`错误: ${String(error)}`)
    return 1
  }
}
