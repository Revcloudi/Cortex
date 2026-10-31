import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CORTEX_VERSION,
  DatabaseService,
  ensureDbDirectory,
  hardenDatabasePermissions,
  resolveDbPath,
  seedDemoData
} from '../core'
import { CORTEX_APP_ID, CORTEX_APP_NAME, IPC_CHANNELS } from '../shared/ipc'
import type { AppInfo, McpRuntimeInfo } from '../shared/types'
import { runCaptureMode } from './capture'
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc/handlers'
import { logger } from './logger'
import { developmentNodeCommand, installedBinDir, nodeExecutableName } from './runtimePaths'
import { configuredDatabasePath, persistDatabasePath } from './settings'
import { createDatabaseWatcher, type DatabaseWatcher } from './watcher'

const isDev = !app.isPackaged
/** Branding for the app menu, `app.getName()` and the default window title. */
app.setName(CORTEX_APP_NAME)
/** Development-only visual smoke test (`CTX_CAPTURE_DIR`, legacy `PDH_CAPTURE_DIR`). */
const captureDir = process.env['CTX_CAPTURE_DIR'] ?? process.env['PDH_CAPTURE_DIR']
/** Demo seeding for screenshots / smoke tests (`CTX_SEED_DEMO`, legacy `PDH_SEED_DEMO`). */
const seedDemoRequested =
  (process.env['CTX_SEED_DEMO'] ?? process.env['PDH_SEED_DEMO']) === '1'

if (captureDir) {
  app.disableHardwareAcceleration()
}

let mainWindow: BrowserWindow | null = null
let database: DatabaseService | null = null
let databaseWatcher: DatabaseWatcher | null = null
let ipcRegistered = false
let quitting = false

function broadcastDataChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.dataChanged)
    }
  }
}

/**
 * The stdio MCP runtime for this build.
 *
 * Installed builds ship a self-contained Node runtime and bundled MCP entry under
 * `<install>/bin` (macOS: `Cortex.app/Contents/bin`); the source workspace points
 * the agent at the esbuild output (`out/mcp/stdio.cjs`) and the developer's
 * `node` (the one that launched `npm run dev`).
 */
function buildMcpRuntime(): McpRuntimeInfo {
  if (app.isPackaged) {
    const binDir = installedBinDir()
    const command = join(binDir, nodeExecutableName())
    const entry = join(binDir, 'mcp-stdio.cjs')
    return { mode: 'installed', command, entry, display: `${command} ${entry}` }
  }
  const entry = join(app.getAppPath(), 'out', 'mcp', 'stdio.cjs')
  const command = developmentNodeCommand()
  return { mode: 'development', command, entry, display: `${command} ${entry}` }
}

function buildAppInfo(db: DatabaseService): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    projectRoot: app.getAppPath(),
    dbPath: db.dbPath,
    schemaVersion: db.getSchemaVersion(),
    platform: process.platform,
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? '',
    mcpRuntime: buildMcpRuntime()
  }
}

/** Only ordinary web links may leave the app. */
function isSafeExternalUrl(target: string): boolean {
  try {
    const parsed = new URL(target)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function hasSameOrigin(target: string, base: string): boolean {
  try {
    return new URL(target).origin === new URL(base).origin
  } catch {
    return false
  }
}

function isSameFilePage(target: string, expected: string): boolean {
  try {
    const targetUrl = new URL(target)
    const expectedUrl = new URL(expected)
    return targetUrl.protocol === 'file:' && targetUrl.pathname === expectedUrl.pathname
  } catch {
    return false
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#fbfaf8',
    title: CORTEX_APP_NAME,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('focus', () => broadcastDataChanged())

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const productionPageUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, target) => {
    const current = window.webContents.getURL()
    if (target === current) return
    const sameDevOrigin = rendererUrl !== undefined && hasSameOrigin(target, rendererUrl)
    const sameFilePage = rendererUrl === undefined && isSameFilePage(target, productionPageUrl)
    if (sameDevOrigin || sameFilePage) return
    event.preventDefault()
    if (isSafeExternalUrl(target)) void shell.openExternal(target)
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`[renderer] process gone: ${details.reason} (exit ${details.exitCode})`)
  })

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error(`[preload] failed to load ${preloadPath}: ${error.message}`)
  })

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error(`[renderer] failed to load ${validatedURL}: ${errorCode} ${errorDescription}`)
  })

  if (isDev && rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}

function registerDatabaseHandlers(): void {
  const db = database
  if (!db) return
  if (ipcRegistered) {
    unregisterIpcHandlers()
    ipcRegistered = false
  }
  registerIpcHandlers({
    db,
    notifyDataChanged: broadcastDataChanged,
    seedDemo: () => seedDemoData(db),
    appInfo: buildAppInfo(db),
    switchDatabase
  })
  ipcRegistered = true
}

/**
 * Attach a SQLite file to the desktop process.
 *
 * The new database is opened (and its watcher started) before the previous one
 * is closed, so a failed switch (for example a non-SQLite file) leaves the
 * current database intact. IPC handlers are re-registered because they close
 * over the `DatabaseService` instance.
 */
async function attachDatabase(
  targetPath: string,
  options: { seed?: boolean } = {}
): Promise<AppInfo> {
  ensureDbDirectory(targetPath)
  const nextDatabase = new DatabaseService(targetPath)
  let nextWatcher: DatabaseWatcher | null = null
  try {
    hardenDatabasePermissions(targetPath)
    nextWatcher = createDatabaseWatcher({
      dbPath: targetPath,
      onChange: broadcastDataChanged,
      logger
    })

    if (databaseWatcher) {
      try {
        await databaseWatcher.stop()
      } catch (error) {
        logger.warn('[cortex] failed to stop previous database watcher', error)
      }
      databaseWatcher = null
    }
    if (database) {
      try {
        database.close()
      } catch (error) {
        logger.warn('[cortex] failed to close previous database', error)
      }
      database = null
    }

    database = nextDatabase
    databaseWatcher = nextWatcher

    if (options.seed) {
      const inserted = seedDemoData(nextDatabase)
      if (inserted > 0) logger.info(`[cortex] seeded ${inserted} demo vulnerabilities`)
    }

    registerDatabaseHandlers()
    broadcastDataChanged()
    return buildAppInfo(nextDatabase)
  } catch (error) {
    try {
      await nextWatcher?.stop()
    } catch {
    }
    try {
      nextDatabase.close()
    } catch {
    }
    throw error
  }
}

/** Switch the desktop view to `nextPath`; `null` restores the default database. */
async function switchDatabase(nextPath: string | null): Promise<AppInfo> {
  const target = nextPath === null ? resolveDbPath() : nextPath
  const info = await attachDatabase(target)
  persistDatabasePath(nextPath === null ? null : target)
  logger.info(`[cortex] desktop database: ${target}`)
  return info
}

async function bootstrap(): Promise<void> {
  const defaultPath = resolveDbPath()
  const storedPath = configuredDatabasePath()
  const initialPath = storedPath ?? defaultPath
  logger.info(`[cortex] v${CORTEX_VERSION} database: ${initialPath}`)
  try {
    await attachDatabase(initialPath, { seed: seedDemoRequested })
  } catch (error) {
    if (storedPath === null) throw error
    logger.warn('[cortex] configured database is unusable, falling back to default', error)
    persistDatabasePath(null)
    await attachDatabase(defaultPath, { seed: seedDemoRequested })
  }

  mainWindow = createWindow()

  if (captureDir) {
    mainWindow.once('ready-to-show', () => {
      const window = mainWindow
      if (!window) return
      void runCaptureMode(window, captureDir, logger)
        .catch((error: unknown) => logger.error('[capture] failed', error))
        .finally(() => {
          setTimeout(() => app.quit(), 300)
        })
    })
  }
}

async function shutdown(): Promise<void> {
  try {
    unregisterIpcHandlers()
  } catch (error) {
    logger.warn('[cortex] failed to unregister IPC handlers', error)
  }
  ipcRegistered = false

  if (databaseWatcher) {
    try {
      await databaseWatcher.stop()
    } catch (error) {
      logger.warn('[cortex] failed to stop database watcher', error)
    }
    databaseWatcher = null
  }

  if (database) {
    try {
      database.close()
    } catch (error) {
      logger.warn('[cortex] failed to close database', error)
    }
    database = null
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId(CORTEX_APP_ID)
    try {
      await bootstrap()
    } catch (error) {
      logger.error('[cortex] fatal boot error', error)
      dialog.showErrorBox(
        CORTEX_APP_NAME,
        error instanceof Error ? error.message : String(error)
      )
      app.quit()
      return
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    if (ipcRegistered || databaseWatcher || database) {
      void shutdown().finally(() => app.quit())
    } else {
      app.quit()
    }
  })
}
