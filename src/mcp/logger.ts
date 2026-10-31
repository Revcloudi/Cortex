import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HubLogger } from '../core/logging'

/**
 * MCP stdio logger.
 *
 * **stdout is the JSON-RPC channel**: a single `console.log` would corrupt the
 * protocol stream and break every client. Everything here writes to stderr, and
 * optionally mirrors to a log file when `CTX_MCP_LOG` points at one.
 */

function writeLine(level: string, message: string, meta: unknown[]): void {
  const rest = meta.length > 0 ? ` ${meta.map(formatMeta).join(' ')}` : ''
  process.stderr.write(`[cortex][${level}] ${message}${rest}\n`)
}

function formatMeta(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface McpLoggerOptions {
  /** Mirror all levels to this file. Defaults to `CTX_MCP_LOG`, else disabled. */
  logFile?: string | null
}

export function createMcpLogger(options: McpLoggerOptions = {}): HubLogger {
  const envPath =
    process.env['CTX_MCP_LOG']?.trim() || process.env['PDH_MCP_LOG']?.trim()
  const logFile = options.logFile === undefined ? (envPath ? envPath : null) : options.logFile
  let fileReady = false

  const writeFile = (level: string, message: string, meta: unknown[]): void => {
    if (logFile === null) return
    try {
      if (!fileReady) {
        mkdirSync(dirname(logFile), { recursive: true })
        fileReady = true
      }
      const rest = meta.length > 0 ? ` ${meta.map(formatMeta).join(' ')}` : ''
      appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${message}${rest}\n`, 'utf8')
    } catch {
    }
  }

  const log = (level: string, message: string, meta: unknown[]): void => {
    writeLine(level, message, meta)
    writeFile(level, message, meta)
  }

  return {
    debug: (message, ...meta) => {
      if (logFile !== null) log('debug', message, meta)
    },
    info: (message, ...meta) => log('info', message, meta),
    warn: (message, ...meta) => log('warn', message, meta),
    error: (message, ...meta) => log('error', message, meta)
  }
}
