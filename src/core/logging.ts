/**
 * Logger abstraction shared by the MCP server (which must stay runnable in a
 * plain Node process for tests) and the Electron main process.
 */
export interface HubLogger {
  debug(message: string, ...meta: unknown[]): void
  info(message: string, ...meta: unknown[]): void
  warn(message: string, ...meta: unknown[]): void
  error(message: string, ...meta: unknown[]): void
}

export const consoleLogger: HubLogger = {
  debug: (message, ...meta) => console.debug(message, ...meta),
  info: (message, ...meta) => console.info(message, ...meta),
  warn: (message, ...meta) => console.warn(message, ...meta),
  error: (message, ...meta) => console.error(message, ...meta)
}

export const silentLogger: HubLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

/**
 * Tool payloads can be large (thousands of characters of prose or JSON).
 * Truncate before logging so the log file stays useful.
 */
export function truncateForLog(value: unknown, maxLength = 1500): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}… [truncated ${text.length - maxLength} chars]`
}
