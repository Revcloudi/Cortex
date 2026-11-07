/**
 * Cross-platform Cortex database path helpers.
 *
 * The plugin Host runs on Windows, macOS or Linux. Never assume a drive
 * letter: expand `~` with the Host's own home directory and let `node:path`
 * resolve according to that platform. Candidate labels stay in `~` form so the
 * setup UI never needs to know (or leak) an absolute server path.
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Expand a leading `~` (and `~/` / `~\`) using the Host user's home. */
export function expandHome(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return trimmed
}

function fileStat(filePath) {
  try {
    const stat = statSync(filePath)
    return { exists: true, sizeBytes: Number(stat.size) || 0 }
  } catch {
    return { exists: false, sizeBytes: 0 }
  }
}

/**
 * Candidate locations for a Cortex v5 SQLite file on this Host.
 * The portable `~/.cortex/data.db` is first; platform-specific app-data
 * variants are included because Cortex/Electron installs on macOS and Linux
 * sometimes place data under the OS application-data conventions.
 */
export function candidateDatabasePaths(platform = process.platform) {
  const entries = [
    { id: 'cortex-home', label: '~/.cortex/data.db' },
  ]
  if (platform === 'darwin') {
    entries.push(
      { id: 'mac-app-support', label: '~/Library/Application Support/Cortex/data.db' },
      { id: 'mac-app-support-lower', label: '~/Library/Application Support/cortex/data.db' }
    )
  } else if (platform === 'linux') {
    entries.push(
      { id: 'linux-xdg-config', label: '~/.config/Cortex/data.db' },
      { id: 'linux-xdg-config-lower', label: '~/.config/cortex/data.db' },
      { id: 'linux-xdg-data', label: '~/.local/share/Cortex/data.db' },
      { id: 'linux-xdg-data-lower', label: '~/.local/share/cortex/data.db' }
    )
  } else if (platform === 'win32') {
    entries.push(
      { id: 'win-roaming', label: '~/AppData/Roaming/Cortex/data.db' },
      { id: 'win-local', label: '~/AppData/Local/Cortex/data.db' }
    )
  }
  const seen = new Set()
  return entries
    .filter((entry) => {
      if (seen.has(entry.label)) return false
      seen.add(entry.label)
      return true
    })
    .map((entry) => {
      const stat = fileStat(expandHome(entry.label))
      return { ...entry, exists: stat.exists, sizeBytes: stat.sizeBytes }
    })
}

export const DEFAULT_DB_LABEL = '~/.cortex/data.db'
