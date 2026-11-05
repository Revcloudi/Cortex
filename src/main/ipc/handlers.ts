import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc'
import { formatZodError } from '../../shared/validation'
import {
  AssetHostPortIpcSchema,
  DeleteVulnerabilityIpcSchema,
  GetVulnerabilityIpcSchema,
  ImportLootIpcSchema,
  InternalGraphQueryIpcSchema,
  InternalOverviewIpcSchema,
  ListAssetsIpcSchema,
  ListLootImportsIpcSchema,
  ListPocModelsIpcSchema,
  ListSnapshotsIpcSchema,
  DashboardStatsIpcSchema,
  ListVulnerabilitiesIpcSchema,
  MemoryGraphQueryIpcSchema,
  PocIdIpcSchema,
  RecordCredentialTrialIpcSchema,
  RepeaterSendIpcSchema,
  SavePocConfigIpcSchema,
  SetupRunRequestIpcSchema,
  SnapshotArchiveIpcSchema,
  SnapshotSessionIdIpcSchema,
  TestPocProviderIpcSchema,
  UpdateStatusIpcSchema,
  UpsertPocProviderIpcSchema,
  VulnerabilityIdsIpcSchema,
  WriteClipboardIpcSchema
} from './schemas'
import type {
  AppInfo,
  CredentialTrial,
  DatabaseSwitchResult,
  DeleteSnapshotResult,
  ExportReportsResult,
  InternalGraphData,
  InternalOverview,
  InternalProjectSummary,
  LootImport,
  SetupInfo,
  SetupRunResult,
  SnapshotListResult,
  SnapshotSession,
  Vulnerability
} from '../../shared/types'
import type { DatabaseService } from '../../core/db/DatabaseService'
import type { PocConfigService } from '../services/pocContracts'
import type { RepeaterService } from '../services/RepeaterService'
import { buildMemoryGraph } from '../../core/graph/buildMemoryGraph'
import type { MemoryGraphData } from '../../shared/graph'
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
  /** AI model configuration + retest proxy configuration. */
  pocConfig: PocConfigService
  /** Raw HTTP repeater for the selected Web finding. */
  repeater: RepeaterService
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

  ipcMain.handle(IPC_CHANNELS.getStats, (_event, rawQuery: unknown) => {
    const parsed = DashboardStatsIpcSchema.safeParse(rawQuery)
    if (!parsed.success) {
      throw new Error(`Invalid stats query: ${formatZodError(parsed.error)}`)
    }
    return db.getStats(parsed.data ?? {})
  })

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

  /**
   * Internal operations projections (Plan B). The four reads never write and
   * never emit `data:changed`; the two writes (credential trial, loot import)
   * notify so every window refreshes exactly like the Web runtime's SSE
   * `changed` event.
   */
  ipcMain.handle(
    IPC_CHANNELS.getInternalOverview,
    (_event, rawInput: unknown): InternalOverview => {
      const parsed = InternalOverviewIpcSchema.safeParse(rawInput)
      if (!parsed.success) {
        throw new Error(`Invalid internal overview filter: ${formatZodError(parsed.error)}`)
      }
      return db.getInternalOverview(parsed.data?.project_name)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.getInternalGraph,
    (_event, rawInput: unknown): InternalGraphData => {
      const parsed = InternalGraphQueryIpcSchema.safeParse(rawInput)
      if (!parsed.success) {
        throw new Error(`Invalid internal graph query: ${formatZodError(parsed.error)}`)
      }
      return db.getInternalGraph(parsed.data.project_name)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.getInternalProjects,
    (): InternalProjectSummary[] => db.getInternalProjects()
  )

  ipcMain.handle(
    IPC_CHANNELS.recordCredentialTrial,
    (_event, rawInput: unknown): CredentialTrial => {
      const parsed = RecordCredentialTrialIpcSchema.safeParse(rawInput)
      if (!parsed.success) {
        throw new Error(`Invalid credential trial payload: ${formatZodError(parsed.error)}`)
      }
      const trial = db.recordCredentialTrial(parsed.data)
      deps.notifyDataChanged()
      return trial
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.listLootImports,
    (_event, rawInput: unknown): LootImport[] => {
      const parsed = ListLootImportsIpcSchema.safeParse(rawInput)
      if (!parsed.success) {
        throw new Error(`Invalid loot import filter: ${formatZodError(parsed.error)}`)
      }
      return db.listLootImports(parsed.data?.project_name)
    }
  )

  /** Local-file import: the database layer parses the path, never executes it. */
  ipcMain.handle(IPC_CHANNELS.importLoot, (_event, rawInput: unknown): LootImport => {
    const parsed = ImportLootIpcSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid loot import payload: ${formatZodError(parsed.error)}`)
    }
    const imported = db.importLoot(parsed.data)
    deps.notifyDataChanged()
    return imported
  })

  /**
   * Read-only Memory Nebula projection (P2): never writes, so it never emits
   * `data:changed`. Validation mirrors `listSnapshots`; the builder clamps the
   * caller limits and reports `meta.truncated` instead of silently dropping.
   */
  ipcMain.handle(
    IPC_CHANNELS.getMemoryGraph,
    (_event, rawQuery: unknown): MemoryGraphData => {
      const parsed = MemoryGraphQueryIpcSchema.safeParse(rawQuery)
      if (!parsed.success) {
        throw new Error(`Invalid memory graph query: ${formatZodError(parsed.error)}`)
      }
      return buildMemoryGraph(db, parsed.data)
    }
  )

  /*
   * AI model configuration + retest-scoped proxy (desktop only).
   * The generated-JS pipeline was removed in schema v5; only provider/model
   * settings and the retest proxy remain. Keys never leave the main process.
   */
  const { pocConfig, repeater } = deps

  ipcMain.handle(IPC_CHANNELS.getPocConfig, () => pocConfig.view())

  ipcMain.handle(IPC_CHANNELS.savePocConfig, (_event, rawInput: unknown) => {
    const parsed = SavePocConfigIpcSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid AI config payload: ${formatZodError(parsed.error)}`)
    }
    return pocConfig.save(parsed.data)
  })

  ipcMain.handle(IPC_CHANNELS.reloadPocConfig, () => pocConfig.reload())

  ipcMain.handle(IPC_CHANNELS.upsertPocProvider, (_event, rawInput: unknown) => {
    const parsed = UpsertPocProviderIpcSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid AI provider payload: ${formatZodError(parsed.error)}`)
    }
    return pocConfig.upsertProvider(parsed.data)
  })

  ipcMain.handle(IPC_CHANNELS.removePocProvider, (_event, rawId: unknown) => {
    const parsed = PocIdIpcSchema.safeParse(rawId)
    if (!parsed.success) {
      throw new Error(`Invalid AI provider id: ${formatZodError(parsed.error)}`)
    }
    return pocConfig.removeProvider(parsed.data)
  })

  ipcMain.handle(IPC_CHANNELS.listPocModels, async (_event, rawInput: unknown) => {
    const parsed = ListPocModelsIpcSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid AI model discovery payload: ${formatZodError(parsed.error)}`)
    }
    return pocConfig.listModels(parsed.data)
  })

  ipcMain.handle(IPC_CHANNELS.testPocProvider, async (_event, rawInput: unknown) => {
    const parsed = TestPocProviderIpcSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid AI provider test payload: ${formatZodError(parsed.error)}`)
    }
    return pocConfig.testProvider(parsed.data.id)
  })

  ipcMain.handle(IPC_CHANNELS.sendRepeaterRequest, async (_event, rawInput: unknown) => {
    const parsed = RepeaterSendIpcSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new Error(`Invalid repeater payload: ${formatZodError(parsed.error)}`)
    }
    return repeater.send(parsed.data)
  })
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
  ipcMain.removeHandler(IPC_CHANNELS.getInternalOverview)
  ipcMain.removeHandler(IPC_CHANNELS.getInternalGraph)
  ipcMain.removeHandler(IPC_CHANNELS.getInternalProjects)
  ipcMain.removeHandler(IPC_CHANNELS.recordCredentialTrial)
  ipcMain.removeHandler(IPC_CHANNELS.listLootImports)
  ipcMain.removeHandler(IPC_CHANNELS.importLoot)
  ipcMain.removeHandler(IPC_CHANNELS.getMemoryGraph)
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
  ipcMain.removeHandler(IPC_CHANNELS.getPocConfig)
  ipcMain.removeHandler(IPC_CHANNELS.savePocConfig)
  ipcMain.removeHandler(IPC_CHANNELS.reloadPocConfig)
  ipcMain.removeHandler(IPC_CHANNELS.upsertPocProvider)
  ipcMain.removeHandler(IPC_CHANNELS.removePocProvider)
  ipcMain.removeHandler(IPC_CHANNELS.listPocModels)
  ipcMain.removeHandler(IPC_CHANNELS.testPocProvider)
  ipcMain.removeHandler(IPC_CHANNELS.sendRepeaterRequest)
}
