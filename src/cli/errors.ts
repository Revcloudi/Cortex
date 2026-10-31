/**
 * CLI error contract.
 *
 * Exit codes (documented in README / `ctx --help`):
 * - 0 success
 * - 1 parameter / IO / runtime error
 * - 2 data not found (empty result is not an error, a missing record is)
 */
export type CliExitCode = 0 | 1 | 2

export class CliError extends Error {
  readonly exitCode: CliExitCode

  constructor(message: string, exitCode: CliExitCode = 1) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError
}

/** Missing record: the command ran, but the requested data does not exist. */
export function notFound(message: string): CliError {
  return new CliError(message, 2)
}
