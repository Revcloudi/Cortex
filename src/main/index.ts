import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/**
 * GPU-less / remote-desktop Windows machines can fail to launch the Chromium GPU
 * process (`GPU process isn't usable. Goodbye.`). Two mitigations:
 *  - `CORTEX_DISABLE_GPU=1` (or `CTX_DISABLE_GPU=1`) skips GPU startup entirely so
 *    the window still opens with software compositing;
 *  - `enable-unsafe-swiftshader` keeps WebGL available through SwiftShader, so the
 *    3D memory nebula falls back to software rendering instead of dropping to the
 *    2D view (Chromium 137+ blocks software WebGL without this switch).
 */
const disableGpuRequested =
  (process.env['CORTEX_DISABLE_GPU'] ?? process.env['CTX_DISABLE_GPU']) === '1'
if (disableGpuRequested) {
  app.disableHardwareAcceleration()
}
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

/**
 * Windows Administrator sessions are the documented cause of
 * `render-process-gone: launch-failed (exitCode 18)` (electron/electron#49167):
 * the sandboxed renderer cannot start under an elevated token, so the window
 * appears with no page. Both switches are required; `--no-sandbox` alone is not
 * enough. Must run before `whenReady()`.
 */
function isWindowsAdministrator(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const groups = spawnSync('whoami', ['/groups'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3_000
    })
    const text = typeof groups.stdout === 'string' ? groups.stdout : ''
    // S-1-16-12288 = High (Administrator) integrity, S-1-16-16384 = System.
    return /S-1-16-12288|S-1-16-16384/i.test(text)
  } catch {
    return false
  }
}

const elevatedSession = isWindowsAdministrator()
if (elevatedSession) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

let mainWindow: BrowserWindow | null = null
let database: DatabaseService | null = null
let databaseWatcher: DatabaseWatcher | null = null
let ipcRegistered = false
let quitting = false
/** One automatic relaunch for the elevated-sandbox renderer failure. */
let rendererRelaunchAttempted = false

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
    frame: false,
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

  window.on('maximize', () => {
    window.webContents.send(IPC_CHANNELS.windowMaximizedChanged, true)
  })
  window.on('unmaximize', () => {
    window.webContents.send(IPC_CHANNELS.windowMaximizedChanged, false)
  })

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
    // Elevated Windows sessions can still hit the sandbox launch failure even
    // when the switches above are set late; relaunch once with the documented
    // workaround flags instead of showing an empty/closed window.
    const sandboxLaunchFailure =
      details.reason === 'launch-failed' || details.exitCode === 18
    const alreadySandboxOff =
      process.argv.includes('--no-sandbox') || app.commandLine.hasSwitch('no-sandbox')
    if (!sandboxLaunchFailure || alreadySandboxOff || rendererRelaunchAttempted) return
    rendererRelaunchAttempted = true
    logger.info('[renderer] relaunching with --no-sandbox --disable-gpu-sandbox')
    app.relaunch({
      args: [
        ...process.argv.slice(1),
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--disable-gpu',
        '--enable-unsafe-swiftshader'
      ]
    })
    app.exit(0)
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

/**
 * Custom single-instance lock.
 *
 * Electron's own lock lives in `userData`. When that directory cannot be
 * written (sandboxed shells, locked-down profiles) `requestSingleInstanceLock()`
 * returns false and the app silently quits with exit code 0 — it looks like
 * `ctx open` succeeded but no window ever appears. This pid-file fallback lets
 * the app start when the lock is unavailable and still blocks a real second
 * instance whose process is alive.
 */
type InstanceLockState = 'acquired' | 'exists' | 'unavailable'

function acquireInstanceLock(): InstanceLockState {
  try {
    const lockPath = join(app.getPath('userData'), 'instance.lock')
    const read = (): { pid: number } | null => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof (parsed as { pid?: unknown }).pid === 'number'
        ) {
          return { pid: (parsed as { pid: number }).pid }
        }
      } catch {
        /* missing or unreadable */
      }
      return null
    }
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const existing = read()
    if (existing !== null && existing.pid !== process.pid && isAlive(existing.pid)) {
      return 'exists'
    }
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      'utf8'
    )
    app.on('will-quit', () => {
      try {
        const current = read()
        if (current !== null && current.pid === process.pid) rmSync(lockPath, { force: true })
      } catch {
        /* best effort */
      }
    })
    return 'acquired'
  } catch {
    return 'unavailable'
  }
}

const instanceLock = acquireInstanceLock()
const gotLock = instanceLock === 'exists' ? false : app.requestSingleInstanceLock()

if (instanceLock === 'exists' || (!gotLock && instanceLock !== 'unavailable')) {
  app.quit()
} else {
  if (!gotLock) {
    logger.warn('[cortex] single-instance lock unavailable; continuing without it')
  }
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
