import log from 'electron-log/main'
import type { HubLogger } from '../core/logging'

log.initialize()
log.transports.console.level = 'debug'
log.transports.file.level = 'info'
log.transports.file.maxSize = 5 * 1024 * 1024

/** Cortex main-process logger (electron-log). MCP code depends on HubLogger. */
export const logger: HubLogger = {
  debug: (message, ...meta) => log.debug(message, ...meta),
  info: (message, ...meta) => log.info(message, ...meta),
  warn: (message, ...meta) => log.warn(message, ...meta),
  error: (message, ...meta) => log.error(message, ...meta)
}
