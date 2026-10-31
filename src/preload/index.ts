import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type CortexApi } from '../shared/ipc'
import type {
  AppInfo,
  AssetContext,
  AssetFilters,
  AssetListItem,
  DashboardStats,
  DatabaseInfo,
  DatabaseSwitchResult,
  DeleteAssetResult,
  DeleteSnapshotResult,
  DeleteVulnResult,
  DeleteVulnsResult,
  ExportReportsResult,
  PaginatedVulnerabilities,
  SeedDemoResult,
  SetupInfo,
  SetupRunRequest,
  SetupRunResult,
  Severity,
  SnapshotListFilters,
  SnapshotListResult,
  SnapshotSession,
  UpdateVulnStatusRequest,
  VulnListQuery,
  Vulnerability,
  VulnerabilityListItem,
  VulnStatus
} from '../shared/types'

const api: CortexApi = {
  listVulnerabilities(query?: VulnListQuery): Promise<PaginatedVulnerabilities> {
    return ipcRenderer.invoke(IPC_CHANNELS.listVulnerabilities, query) as Promise<
      PaginatedVulnerabilities
    >
  },
  getVulnerability(id: string): Promise<Vulnerability | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.getVulnerability, id) as Promise<Vulnerability | null>
  },
  getStats(): Promise<DashboardStats> {
    return ipcRenderer.invoke(IPC_CHANNELS.getStats) as Promise<DashboardStats>
  },
  updateVulnerabilityStatus(input: UpdateVulnStatusRequest): Promise<Vulnerability> {
    return ipcRenderer.invoke(IPC_CHANNELS.updateVulnerabilityStatus, input) as Promise<Vulnerability>
  },
  deleteVulnerability(id: string): Promise<DeleteVulnResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.deleteVulnerability, id) as Promise<DeleteVulnResult>
  },
  deleteVulnerabilities(ids: string[]): Promise<DeleteVulnsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.deleteVulnerabilities, ids) as Promise<DeleteVulnsResult>
  },
  exportVulnerabilities(ids: string[]): Promise<ExportReportsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.exportVulnerabilities, ids) as Promise<ExportReportsResult>
  },
  listAssets(filters?: AssetFilters): Promise<AssetListItem[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.listAssets, filters) as Promise<AssetListItem[]>
  },
  getAssetDetail(hostPort: string): Promise<AssetContext | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.getAssetDetail, hostPort) as Promise<AssetContext | null>
  },
  getAssetRelatedVulnerabilities(hostPort: string): Promise<VulnerabilityListItem[]> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.getAssetRelatedVulnerabilities,
      hostPort
    ) as Promise<VulnerabilityListItem[]>
  },
  deleteAsset(hostPort: string): Promise<DeleteAssetResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.deleteAsset, hostPort) as Promise<DeleteAssetResult>
  },
  listSnapshots(filters?: SnapshotListFilters): Promise<SnapshotListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.listSnapshots, filters) as Promise<SnapshotListResult>
  },
  getSnapshot(sessionId: string): Promise<SnapshotSession | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.getSnapshot, sessionId) as Promise<SnapshotSession | null>
  },
  restoreSnapshotPrevious(sessionId: string): Promise<SnapshotSession> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.restoreSnapshotPrevious,
      sessionId
    ) as Promise<SnapshotSession>
  },
  archiveSnapshot(sessionId: string, archived: boolean): Promise<SnapshotSession> {
    return ipcRenderer.invoke(IPC_CHANNELS.archiveSnapshot, {
      sessionId,
      archived
    }) as Promise<SnapshotSession>
  },
  deleteSnapshot(sessionId: string): Promise<DeleteSnapshotResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.deleteSnapshot,
      sessionId
    ) as Promise<DeleteSnapshotResult>
  },
  getDatabaseInfo(): Promise<DatabaseInfo> {
    return ipcRenderer.invoke(IPC_CHANNELS.getDatabaseInfo) as Promise<DatabaseInfo>
  },
  chooseDatabase(): Promise<DatabaseSwitchResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.chooseDatabase) as Promise<DatabaseSwitchResult>
  },
  resetDatabase(): Promise<DatabaseSwitchResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.resetDatabase) as Promise<DatabaseSwitchResult>
  },
  getAppInfo(): Promise<AppInfo> {
    return ipcRenderer.invoke(IPC_CHANNELS.getAppInfo) as Promise<AppInfo>
  },
  getSetupInfo(): Promise<SetupInfo> {
    return ipcRenderer.invoke(IPC_CHANNELS.getSetupInfo) as Promise<SetupInfo>
  },
  runSetup(request: SetupRunRequest): Promise<SetupRunResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.runSetup, request) as Promise<SetupRunResult>
  },
  seedDemoData(): Promise<SeedDemoResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.seedDemoData) as Promise<SeedDemoResult>
  },
  writeClipboard(text: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.writeClipboard, text) as Promise<void>
  },
  minimizeWindow(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.minimizeWindow) as Promise<void>
  },
  toggleMaximizeWindow(): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.toggleMaximizeWindow) as Promise<boolean>
  },
  closeWindow(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.closeWindow) as Promise<void>
  },
  isWindowMaximized(): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.getWindowMaximized) as Promise<boolean>
  },
  onWindowMaximizedChanged(callback: (maximized: boolean) => void): () => void {
    const listener = (_event: unknown, maximized: boolean): void => callback(maximized)
    ipcRenderer.on(IPC_CHANNELS.windowMaximizedChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.windowMaximizedChanged, listener)
    }
  },
  onDataChanged(callback: () => void): () => void {
    const listener = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.dataChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.dataChanged, listener)
    }
  }
}

export type { Severity, VulnStatus }

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  ;(globalThis as unknown as { api: CortexApi }).api = api
}
