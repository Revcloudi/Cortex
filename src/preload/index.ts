import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type CortexApi, type DashboardStatsQuery } from '../shared/ipc'
import type {
  AppInfo,
  AssetContext,
  AssetFilters,
  AssetListItem,
  CredentialTrial,
  DashboardStats,
  DatabaseInfo,
  DatabaseSwitchResult,
  DeleteAssetResult,
  DeleteSnapshotResult,
  DeleteVulnResult,
  DeleteVulnsResult,
  ExportReportsResult,
  ImportLootInput,
  InternalGraphData,
  InternalOverview,
  InternalProjectSummary,
  LootImport,
  PaginatedVulnerabilities,
  RecordCredentialTrialInput,
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
import type { MemoryGraphData, MemoryGraphQuery } from '../shared/graph'
import type {
  ListPocModelsInput,
  ListPocModelsResult,
  PocConfigView,
  SavePocConfigInput,
  TestPocProviderResult,
  UpsertPocProviderInput
} from '../shared/poc'
import type { RepeaterSendInput, RepeaterSendResult } from '../shared/repeater'

const api: CortexApi = {
  listVulnerabilities(query?: VulnListQuery): Promise<PaginatedVulnerabilities> {
    return ipcRenderer.invoke(IPC_CHANNELS.listVulnerabilities, query) as Promise<
      PaginatedVulnerabilities
    >
  },
  getVulnerability(id: string): Promise<Vulnerability | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.getVulnerability, id) as Promise<Vulnerability | null>
  },
  getStats(query: DashboardStatsQuery = {}): Promise<DashboardStats> {
    return ipcRenderer.invoke(IPC_CHANNELS.getStats, query) as Promise<DashboardStats>
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
  getInternalOverview(input?: { project_name?: string }): Promise<InternalOverview> {
    return ipcRenderer.invoke(IPC_CHANNELS.getInternalOverview, input) as Promise<InternalOverview>
  },
  getInternalGraph(input: { project_name: string }): Promise<InternalGraphData> {
    return ipcRenderer.invoke(IPC_CHANNELS.getInternalGraph, input) as Promise<InternalGraphData>
  },
  getInternalProjects(): Promise<InternalProjectSummary[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.getInternalProjects) as Promise<InternalProjectSummary[]>
  },
  recordCredentialTrial(input: RecordCredentialTrialInput): Promise<CredentialTrial> {
    return ipcRenderer.invoke(IPC_CHANNELS.recordCredentialTrial, input) as Promise<CredentialTrial>
  },
  listLootImports(input?: { project_name?: string }): Promise<LootImport[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.listLootImports, input) as Promise<LootImport[]>
  },
  importLoot(input: ImportLootInput): Promise<LootImport> {
    return ipcRenderer.invoke(IPC_CHANNELS.importLoot, input) as Promise<LootImport>
  },
  getMemoryGraph(query: MemoryGraphQuery): Promise<MemoryGraphData> {
    return ipcRenderer.invoke(IPC_CHANNELS.getMemoryGraph, query) as Promise<MemoryGraphData>
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
  },

  /*
   * AI model configuration + retest HTTP repeater (desktop only).
   * The old generated-JS sandbox/artifact/run API was removed in schema v5.
   */
  getPocConfig(): Promise<PocConfigView> {
    return ipcRenderer.invoke(IPC_CHANNELS.getPocConfig) as Promise<PocConfigView>
  },
  savePocConfig(input: SavePocConfigInput): Promise<PocConfigView> {
    return ipcRenderer.invoke(IPC_CHANNELS.savePocConfig, input) as Promise<PocConfigView>
  },
  reloadPocConfig(): Promise<PocConfigView> {
    return ipcRenderer.invoke(IPC_CHANNELS.reloadPocConfig) as Promise<PocConfigView>
  },
  upsertPocProvider(input: UpsertPocProviderInput): Promise<PocConfigView> {
    return ipcRenderer.invoke(IPC_CHANNELS.upsertPocProvider, input) as Promise<PocConfigView>
  },
  removePocProvider(id: string): Promise<PocConfigView> {
    return ipcRenderer.invoke(IPC_CHANNELS.removePocProvider, id) as Promise<PocConfigView>
  },
  listPocModels(input: ListPocModelsInput): Promise<ListPocModelsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.listPocModels, input) as Promise<ListPocModelsResult>
  },
  testPocProvider(input: { id: string }): Promise<TestPocProviderResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.testPocProvider, input) as Promise<TestPocProviderResult>
  },
  sendRepeaterRequest(input: RepeaterSendInput): Promise<RepeaterSendResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.sendRepeaterRequest,
      input
    ) as Promise<RepeaterSendResult>
  }
}

export type { Severity, VulnStatus }

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  ;(globalThis as unknown as { api: CortexApi }).api = api
}
