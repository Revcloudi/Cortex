import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc'
import { formatZodError } from '../../shared/validation'
import {
  AssetHostPortIpcSchema,
  DeleteVulnerabilityIpcSchema,
  GetVulnerabilityIpcSchema,
  ListAssetsIpcSchema,
  ListSnapshotsIpcSchema,
  ListVulnerabilitiesIpcSchema,
  SetupRunRequestIpcSchema,
  SnapshotArchiveIpcSchema,
  SnapshotSessionIdIpcSchema,
  UpdateStatusIpcSchema,
  VulnerabilityIdsIpcSchema,
  WriteClipboardIpcSchema
} from './schemas'
import type {
  AppInfo,
  DatabaseSwitchResult,
  DeleteSnapshotResult,
  ExportReportsResult,
  SetupInfo,
  SetupRunResult,
  SnapshotListResult,
  SnapshotSession,
  Vulnerability
} from '../../shared/types'
import type { DatabaseService } from '../../core/db/DatabaseService'
import {
  buildReportFilename,
  buildVulnerabilityReportMarkdown
} from '../export/markdownReport'
import { buildSetupInfo, runSetup } from './setup'

export interface IpcHandlerDeps {
  db: DatabaseService
  notifyDataChanged: () => void
  seedDemo: () => number
  appInfo: AppInfo
  switchDatabase: (dbPath: string | null) => Promise<AppInfo>
}

/**
 * Renderer -> main bridge. Every payload is validated again here: IPC is a
 * trust boundary just like the MCP transport.
 */
export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  const { db } = deps

  ipcMain.handle(IPC_CHANNELS.listVulnerabilities, (_event, rawFilters: unknown) => {
    const parsed = ListVulnerabilitiesIpcSchema.safeParse(rawFilters)
    if (!parsed.success) {
      throw new Error(`Invalid vulnerability filter: ${formatZodError(parsed.error)}`)
    }
    return db.list(parsed.data ?? {})
  })

  ipcMain.handle(IPC_CHANNELS.getVulnerability, (_event, rawId: unknown) => {
    const parsed = GetVulnerabilityIpcSchema.safeParse(rawId)
    if (!parsed.success) {
      throw new Error(`Invalid vulnerability id: ${formatZodError(parsed.error)}`)
    }
    return db.getById(parsed.data)
  })

  ipcMain.handle(IPC_CHANNELS.getStats, () => db.getStats())

  ipcMain.handle(IPC_CHANNELS.updateVulnerabilityStatus, (_event, rawInput: unknown) => {
    const parsed = UpdateStatusIpcSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid status update payload: ${formatZodError(parsed.error)}`)
    }
    const updated = db.updateStatus(parsed.data.id, parsed.data.status)
    deps.notifyDataChanged()
    return updated
  })

  ipcMain.handle(IPC_CHANNELS.deleteVulnerability, (_event, rawId: unknown) => {
    const parsed = DeleteVulnerabilityIpcSchema.safeParse(rawId)
    if (!parsed.success) {
      throw new Error(`Invalid vulnerability id: ${formatZodError(parsed.error)}`)
    }
    const deleted = db.delete(parsed.data)
    if (deleted) deps.notifyDataChanged()
    return { deleted }
  })

  ipcMain.handle(IPC_CHANNELS.deleteVulnerabilities, (_event, rawIds: unknown) => {
    const parsed = VulnerabilityIdsIpcSchema.safeParse(rawIds)
    if (!parsed.success) {
      throw new Error(`Invalid bulk delete payload: ${formatZodError(parsed.error)}`)
    }
    const deleted = db.deleteMany(parsed.data)
    if (deleted > 0) deps.notifyDataChanged()
    return { deleted }
  })

  ipcMain.handle(
    IPC_CHANNELS.exportVulnerabilities,
    async (_event, rawIds: unknown): Promise<ExportReportsResult> => {
      const parsed = VulnerabilityIdsIpcSchema.safeParse(rawIds)
      if (!parsed.success) {
        throw new Error(`Invalid export payload: ${formatZodError(parsed.error)}`)
      }

      const vulns = parsed.data
        .map((id) => db.getById(id))
        .filter((vuln): vuln is Vulnerability => vuln !== null)
      if (vulns.length === 0) {
        throw new Error('No vulnerability records found to export')
      }

      if (vulns.length === 1) {
        const vuln = vulns[0] as Vulnerability
        const result = await dialog.showSaveDialog({
          title: 'Export Vulnerability Report',
          defaultPath: buildReportFilename(vuln),
          filters: [{ name: 'Markdown Report', extensions: ['md'] }]
        })
        if (result.canceled || !result.filePath) {
          return { cancelled: true, files: [] }
        }
        await writeFile(result.filePath, buildVulnerabilityReportMarkdown(vuln), 'utf8')
        return { cancelled: false, files: [result.filePath] }
      }

      const result = await dialog.showOpenDialog({
        title: 'Select Markdown Report Directory',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true, files: [] }
      }

      const targetDir = result.filePaths[0] as string
      const usedNames = new Set<string>()
      const files: string[] = []
      for (const vuln of vulns) {
        let filename = buildReportFilename(vuln)
        const base = filename.replace(/\.md$/i, '')
        let suffix = 2
        while (usedNames.has(filename.toLowerCase())) {
          filename = `${base}-${suffix}.md`
          suffix += 1
        }
        usedNames.add(filename.toLowerCase())
        const target = join(targetDir, filename)
        await writeFile(target, buildVulnerabilityReportMarkdown(vuln), 'utf8')
        files.push(target)
      }
      return { cancelled: false, files }
    }
  )

  ipcMain.handle(IPC_CHANNELS.getDatabaseInfo, () => db.getDatabaseInfo())

  ipcMain.handle(IPC_CHANNELS.listAssets, (_event, rawFilters: unknown) => {
    const parsed = ListAssetsIpcSchema.safeParse(rawFilters)
    if (!parsed.success) {
      throw new Error(`Invalid asset filter: ${formatZodError(parsed.error)}`)
    }
    return db.listAssets(parsed.data ?? {})
  })

  ipcMain.handle(IPC_CHANNELS.getAssetDetail, (_event, rawHostPort: unknown) => {
    const parsed = AssetHostPortIpcSchema.safeParse(rawHostPort)
    if (!parsed.success) {
      throw new Error(`Invalid asset host_port: ${formatZodError(parsed.error)}`)
    }
    return db.getAssetDetail(parsed.data)
  })

  ipcMain.handle(IPC_CHANNELS.getAssetRelatedVulnerabilities, (_event, rawHostPort: unknown) => {
    const parsed = AssetHostPortIpcSchema.safeParse(rawHostPort)
    if (!parsed.success) {
      throw new Error(`Invalid asset host_port: ${formatZodError(parsed.error)}`)
    }
    return db.getAssetRelatedVulnerabilities(parsed.data)
  })

  ipcMain.handle(IPC_CHANNELS.deleteAsset, (_event, rawHostPort: unknown) => {
    const parsed = AssetHostPortIpcSchema.safeParse(rawHostPort)
    if (!parsed.success) {
      throw new Error(`Invalid asset host_port: ${formatZodError(parsed.error)}`)
    }
    const deleted = db.deleteAsset(parsed.data)
    if (deleted) deps.notifyDataChanged()
    return { deleted }
  })

  ipcMain.handle(
    IPC_CHANNELS.listSnapshots,
    (_event, rawFilters: unknown): SnapshotListResult => {
      const parsed = ListSnapshotsIpcSchema.safeParse(rawFilters)
      if (!parsed.success) {
        throw new Error(`Invalid snapshot filter: ${formatZodError(parsed.error)}`)
      }
      return db.listSnapshotSessions(parsed.data ?? {})
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.getSnapshot,
    (_event, rawSessionId: unknown): SnapshotSession | null => {
      const parsed = SnapshotSessionIdIpcSchema.safeParse(rawSessionId)
      if (!parsed.success) {
        throw new Error(`Invalid snapshot session_id: ${formatZodError(parsed.error)}`)
      }
      return db.getSnapshotSession(parsed.data)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.restoreSnapshotPrevious,
    (_event, rawSessionId: unknown): SnapshotSession => {
      const parsed = SnapshotSessionIdIpcSchema.safeParse(rawSessionId)
      if (!parsed.success) {
        throw new Error(`Invalid snapshot session_id: ${formatZodError(parsed.error)}`)
      }
      const session = db.restoreSnapshotPrevious(parsed.data)
      deps.notifyDataChanged()
      return session
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.archiveSnapshot,
    (_event, rawInput: unknown): SnapshotSession => {
      const parsed = SnapshotArchiveIpcSchema.safeParse(rawInput)
      if (!parsed.success) {
        throw new Error(`Invalid snapshot archive payload: ${formatZodError(parsed.error)}`)
      }
      const session = db.setSnapshotArchived(parsed.data.sessionId, parsed.data.archived)
      deps.notifyDataChanged()
      return session
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.deleteSnapshot,
    (_event, rawSessionId: unknown): DeleteSnapshotResult => {
      const parsed = SnapshotSessionIdIpcSchema.safeParse(rawSessionId)
      if (!parsed.success) {
        throw new Error(`Invalid snapshot session_id: ${formatZodError(parsed.error)}`)
      }
      const deleted = db.deleteSnapshotSession(parsed.data)
      if (deleted > 0) deps.notifyDataChanged()
      return { deleted }
    }
  )

  ipcMain.handle(IPC_CHANNELS.getAppInfo, (): AppInfo => {
    return deps.appInfo
  })

  ipcMain.handle(
    IPC_CHANNELS.chooseDatabase,
    async (): Promise<DatabaseSwitchResult> => {
      const choice = await dialog.showOpenDialog({
        title: 'Select a Cortex SQLite database',
        properties: ['openFile'],
        filters: [
          { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (choice.canceled || choice.filePaths.length === 0) {
        return { cancelled: true, error: null, dbPath: null, appInfo: null }
      }
      try {
        const info = await deps.switchDatabase(choice.filePaths[0])
        return { cancelled: false, error: null, dbPath: info.dbPath, appInfo: info }
      } catch (error) {
        return {
          cancelled: false,
          error: error instanceof Error ? error.message : String(error),
          dbPath: null,
          appInfo: null
        }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.resetDatabase, async (): Promise<DatabaseSwitchResult> => {
    try {
      const info = await deps.switchDatabase(null)
      return { cancelled: false, error: null, dbPath: info.dbPath, appInfo: info }
    } catch (error) {
      return {
        cancelled: false,
        error: error instanceof Error ? error.message : String(error),
        dbPath: null,
        appInfo: null
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.getSetupInfo, (): SetupInfo => buildSetupInfo())

  ipcMain.handle(
    IPC_CHANNELS.runSetup,
    async (_event, rawRequest: unknown): Promise<SetupRunResult> => {
      const parsed = SetupRunRequestIpcSchema.safeParse(rawRequest)
      if (!parsed.success) {
        throw new Error(`Invalid setup request: ${formatZodError(parsed.error)}`)
      }
      return runSetup(parsed.data)
    }
  )

  ipcMain.handle(IPC_CHANNELS.seedDemoData, () => {
    const inserted = deps.seedDemo()
    if (inserted > 0) deps.notifyDataChanged()
    return { inserted }
  })

  ipcMain.handle(IPC_CHANNELS.writeClipboard, (_event, rawText: unknown) => {
    const parsed = WriteClipboardIpcSchema.safeParse(rawText)
    if (!parsed.success) {
      throw new Error(`Invalid clipboard payload: ${formatZodError(parsed.error)}`)
    }
    clipboard.writeText(parsed.data)
  })

  ipcMain.handle(IPC_CHANNELS.minimizeWindow, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle(IPC_CHANNELS.toggleMaximizeWindow, (event): boolean => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  ipcMain.handle(IPC_CHANNELS.closeWindow, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle(IPC_CHANNELS.getWindowMaximized, (event): boolean => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
}

export function unregisterIpcHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.listVulnerabilities)
  ipcMain.removeHandler(IPC_CHANNELS.getVulnerability)
  ipcMain.removeHandler(IPC_CHANNELS.getStats)
  ipcMain.removeHandler(IPC_CHANNELS.updateVulnerabilityStatus)
  ipcMain.removeHandler(IPC_CHANNELS.deleteVulnerability)
  ipcMain.removeHandler(IPC_CHANNELS.deleteVulnerabilities)
  ipcMain.removeHandler(IPC_CHANNELS.exportVulnerabilities)
  ipcMain.removeHandler(IPC_CHANNELS.listAssets)
  ipcMain.removeHandler(IPC_CHANNELS.getAssetDetail)
  ipcMain.removeHandler(IPC_CHANNELS.getAssetRelatedVulnerabilities)
  ipcMain.removeHandler(IPC_CHANNELS.deleteAsset)
  ipcMain.removeHandler(IPC_CHANNELS.listSnapshots)
  ipcMain.removeHandler(IPC_CHANNELS.getSnapshot)
  ipcMain.removeHandler(IPC_CHANNELS.restoreSnapshotPrevious)
  ipcMain.removeHandler(IPC_CHANNELS.archiveSnapshot)
  ipcMain.removeHandler(IPC_CHANNELS.deleteSnapshot)
  ipcMain.removeHandler(IPC_CHANNELS.getDatabaseInfo)
  ipcMain.removeHandler(IPC_CHANNELS.chooseDatabase)
  ipcMain.removeHandler(IPC_CHANNELS.resetDatabase)
  ipcMain.removeHandler(IPC_CHANNELS.getAppInfo)
  ipcMain.removeHandler(IPC_CHANNELS.getSetupInfo)
  ipcMain.removeHandler(IPC_CHANNELS.runSetup)
  ipcMain.removeHandler(IPC_CHANNELS.seedDemoData)
  ipcMain.removeHandler(IPC_CHANNELS.writeClipboard)
  ipcMain.removeHandler(IPC_CHANNELS.minimizeWindow)
  ipcMain.removeHandler(IPC_CHANNELS.toggleMaximizeWindow)
  ipcMain.removeHandler(IPC_CHANNELS.closeWindow)
  ipcMain.removeHandler(IPC_CHANNELS.getWindowMaximized)
}
