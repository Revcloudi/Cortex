import chokidar, { type FSWatcher } from 'chokidar'
import { statSync } from 'node:fs'
import type { HubLogger } from '../core/logging'

/**
 * Database change watcher for the Electron main process.
 *
 * The agent writes through its own stdio MCP process, so the GUI must refresh
 * without polling. SQLite in WAL mode often leaves the *main* database file
 * untouched by a write (data lands in `-wal` until a checkpoint), so the watcher
 * also listens to the WAL/SHM sidecars.
 *
 * `chokidar` handles normal writes; a cheap size/mtime poll is the fallback for
 * filesystems that coalesce or miss events (network shares, some AV setups).
 * Both paths feed one debounced callback, so a burst of events triggers a single
 * renderer refresh.
 */

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_POLL_INTERVAL_MS = 2_000

export interface DatabaseWatcherOptions {
  dbPath: string
  onChange: () => void
  logger?: HubLogger
  /** Coalescing window for filesystem events. Defaults to 250 ms. */
  debounceMs?: number
  /** Size/mtime fallback interval; 0 disables it. Defaults to 2 s. */
  pollIntervalMs?: number
}

export interface DatabaseWatcher {
  stop(): Promise<void>
}

export interface Debounced {
  (): void
  cancel(): void
}

/** Collapse a burst of calls into a single trailing invocation. */
export function debounce(fn: () => void, delayMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null
  const debounced = ((): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn()
    }, delayMs)
  }) as Debounced
  debounced.cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return debounced
}

/** `size:mtime` for every file that exists; missing files contribute `-`. */
function fingerprint(files: readonly string[]): string {
  return files
    .map((file) => {
      try {
        const stat = statSync(file)
        return `${stat.size}:${stat.mtimeMs}`
      } catch {
        return '-'
      }
    })
    .join('|')
}

export function databaseWatchFiles(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
}

/** Start watching one Cortex database. Call `stop()` before closing the DB. */
export function createDatabaseWatcher(options: DatabaseWatcherOptions): DatabaseWatcher {
  const dbPath = options.dbPath
  if (dbPath === ':memory:') {
    return { stop: async (): Promise<void> => undefined }
  }

  const files = databaseWatchFiles(dbPath)
  const logger = options.logger
  const fire = debounce(options.onChange, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)

  let watcher: FSWatcher | null = null
  try {
    watcher = chokidar.watch(files, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
    })
    watcher.on('all', () => fire())
    watcher.on('error', (error: unknown) => {
      logger?.warn(
        `[watcher] database file watch error: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  } catch (error) {
    logger?.warn(
      `[watcher] failed to start chokidar, falling back to polling: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  let lastFingerprint = fingerprint(files)
  const interval =
    pollIntervalMs > 0
      ? setInterval(() => {
          const next = fingerprint(files)
          if (next === lastFingerprint) return
          lastFingerprint = next
          fire()
        }, pollIntervalMs)
      : null
  if (interval !== null && typeof interval.unref === 'function') interval.unref()

  return {
    stop: async (): Promise<void> => {
      fire.cancel()
      if (interval !== null) clearInterval(interval)
      if (watcher !== null) {
        try {
          await watcher.close()
        } catch (error) {
          logger?.warn(
            `[watcher] failed to close watcher: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
    }
  }
}
