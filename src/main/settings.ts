import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Small user-level settings file for the desktop process.
 *
 * Only the optional database override is stored here; everything else is
 * derived from the app/runtime. Kept intentionally tiny (no dependency) because
 * the file is read once during bootstrap.
 */
export interface MainSettings {
  /** Absolute SQLite path chosen through the sidebar database button. */
  databasePath?: string
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function readSettings(): MainSettings {
  try {
    const raw = readFileSync(settingsFile(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const databasePath = (parsed as { databasePath?: unknown }).databasePath
      if (typeof databasePath === 'string' && databasePath.trim().length > 0) {
        return { databasePath }
      }
    }
  } catch {
  }
  return {}
}

function writeSettings(settings: MainSettings): void {
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

export function configuredDatabasePath(): string | null {
  const settings = readSettings()
  const value = settings.databasePath
  return value !== undefined && existsSync(value) ? value : null
}

export function persistDatabasePath(dbPath: string | null): void {
  try {
    if (dbPath === null) {
      rmSync(settingsFile(), { force: true })
      return
    }
    writeSettings({ databasePath: dbPath })
  } catch {
  }
}
