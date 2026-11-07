/**
 * Small plugin-local settings store (JSON file under ~/.cortex).
 *
 * Currently remembers the last successful export directory so the export dialog
 * can default to it on the next export. Kept out of Cortex's own tables/config
 * so the desktop app and schema stay untouched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { sendJson } from '../http.js'

function settingsPath() {
  return process.env.CORTEX_SETTINGS_FILE || join(homedir(), '.cortex', 'plugin-settings.json')
}

function readSettings() {
  const file = settingsPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeSettings(settings) {
  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

export function getLastExportDir() {
  const value = readSettings().exportDir
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** Best-effort: a settings write failure must never fail an export. */
export function rememberExportDir(outputDir) {
  try {
    const settings = readSettings()
    settings.exportDir = outputDir
    writeSettings(settings)
  } catch {
    /* ignore */
  }
}

/** GET /export/settings -> { outputDir: string | null } */
export function handleGetExportSettings({ res }) {
  sendJson(res, 200, { outputDir: getLastExportDir() })
}
