import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'
import {
  MINIAPP_STATUSES,
  MiniappStore,
  defaultPluginDbPath,
  getMiniappStore,
  resetMiniappStoreForTests,
  sourceIdFor,
} from '../../src/host/miniapp/store.js'

const APPID_A = 'wxdabf06925a55f410'
const APPID_B = 'wx0123456789abcdef'

/** @type {string[]} */
const tempDirs = []
/** @type {MiniappStore[]} */
const openStores = []

after(() => {
  for (const store of openStores) store.close()
  resetMiniappStoreForTests()
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cortex-miniapp-store-'))
  tempDirs.push(dir)
  return dir
}

function openStore() {
  const dir = makeTempDir()
  const dbPath = join(dir, 'plugin.db')
  const store = new MiniappStore({ dbPath })
  store.ensure()
  openStores.push(store)
  return { dir, dbPath, store }
}

/** @param {string} packageDir */
function appFile(packageDir) {
  return {
    name: '__APP__.wxapkg',
    path: join(packageDir, '__APP__.wxapkg'),
    size: 100,
  }
}

/** Build one minimial package-directory source input. */
function sourceInput({ appid = APPID_A, version = '135', rootPath, packageDir, files } = {}) {
  const dir = packageDir ?? join(rootPath, appid, version)
  return {
    root_path: rootPath,
    root_kind: 'xwechat',
    appid,
    version,
    package_dir: dir,
    files: files ?? [appFile(dir)],
  }
}

describe('miniapp store: paths and schema', () => {
  it('resolves the default plugin.db path with CORTEX_PLUGIN_DB override', () => {
    const pathDir = makeTempDir()
    const custom = join(pathDir, 'custom.db')
    assert.equal(defaultPluginDbPath({ CORTEX_PLUGIN_DB: custom }), resolve(custom))

    const home = join(tmpdir(), 'dsh-cortex-fake-home')
    assert.equal(
      defaultPluginDbPath({ HOME: home, USERPROFILE: '' }),
      resolve(join(home, '.cortex', 'plugin.db')),
    )
  })

  it('creates all four tables idempotently and survives close/reopen', () => {
    const { store, dbPath } = openStore()
    store.ensure()
    store.ensure()

    const raw = new DatabaseSync(dbPath)
    try {
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'miniapp_%' ORDER BY name")
        .all()
        .map((row) => row.name)
      assert.deepEqual(tables, [
        'miniapp_analyses',
        'miniapp_jobs',
        'miniapp_settings',
        'miniapp_sources',
      ])
      const journal = raw.prepare('PRAGMA journal_mode').get()
      assert.equal(String(journal.journal_mode).toLowerCase(), 'wal')
    } finally {
      raw.close()
    }

    store.close()
    store.close() // idempotent
    const reopened = new MiniappStore({ dbPath })
    openStores.push(reopened)
    reopened.ensure()
    reopened.ensure()
    assert.equal(reopened.listSources().length, 0)
  })

  it('derives stable 40-hex source ids from root + package dir', () => {
    const rootPath = join(tmpdir(), 'dsh-cortex-roots')
    const packageDir = join(rootPath, APPID_A, '135')
    const id = sourceIdFor(rootPath, packageDir)
    assert.match(id, /^[0-9a-f]{40}$/)
    assert.equal(sourceIdFor(rootPath, packageDir), id)
    assert.notEqual(sourceIdFor(rootPath, join(rootPath, APPID_A, '136')), id)
    assert.deepEqual(MINIAPP_STATUSES, ['detected', 'decrypting', 'unpacked', 'unsupported', 'failed'])
  })
})

describe('miniapp store: sources', () => {
  it('inserts a source with hydrated file entries', () => {
    const { dir, store } = openStore()
    const rootPath = join(dir, 'users')
    const packageDir = join(rootPath, APPID_A, '135')
    const result = store.upsertSource(sourceInput({ rootPath, packageDir }))

    assert.equal(result.created, true)
    assert.equal(result.changed, true)
    assert.equal(result.row.id, sourceIdFor(rootPath, packageDir))
    assert.equal(result.row.status, 'detected')
    assert.equal(result.row.file_count, 1)
    assert.equal(result.row.size_bytes, 100)
    assert.equal(result.row.format, 'unknown')
    assert.deepEqual(result.row.files.map((file) => file.name), ['__APP__.wxapkg'])
    assert.equal(store.getSource(result.row.id).id, result.row.id)
    assert.equal(store.getSource('missing-id'), null)
    assert.throws(() => store.upsertSource({}), TypeError)
  })

  it('preserves unpacked/unsupported/failed status and unpacked_path when files are unchanged', () => {
    const { dir, store } = openStore()
    const rootPath = join(dir, 'users')
    const packageDir = join(rootPath, APPID_A, '135')
    const created = store.upsertSource(sourceInput({ rootPath, packageDir }))

    for (const status of ['unpacked', 'unsupported', 'failed']) {
      const unpackedPath = status === 'unpacked' ? join(dir, 'out', 'unpacked') : ''
      store.updateSource(created.row.id, { status, unpacked_path: unpackedPath, error: `${status}-msg` })
      const again = store.upsertSource(sourceInput({ rootPath, packageDir }))
      assert.equal(again.created, false)
      assert.equal(again.changed, false)
      assert.equal(again.row.status, status)
      assert.equal(again.row.unpacked_path, unpackedPath)
    }
  })

  it('resets to detected when the package file list or size changes', () => {
    const { dir, store } = openStore()
    const rootPath = join(dir, 'users')
    const packageDir = join(rootPath, APPID_A, '135')
    const created = store.upsertSource(sourceInput({ rootPath, packageDir }))
    store.updateSource(created.row.id, { status: 'unpacked', unpacked_path: join(dir, 'out') })

    const addedFile = sourceInput({
      rootPath,
      packageDir,
      files: [appFile(packageDir), { name: 'sub.wxapkg', path: join(packageDir, 'sub.wxapkg'), size: 50 }],
    })
    const changed = store.upsertSource(addedFile)
    assert.equal(changed.created, false)
    assert.equal(changed.changed, true)
    assert.equal(changed.row.status, 'detected')
    assert.equal(changed.row.unpacked_path, '')
    assert.equal(changed.row.file_count, 2)
    assert.equal(changed.row.size_bytes, 150)

    store.updateSource(created.row.id, { status: 'unpacked', unpacked_path: join(dir, 'out2') })
    const resized = store.upsertSource({
      ...addedFile,
      files: [appFile(packageDir), { name: 'sub.wxapkg', path: join(packageDir, 'sub.wxapkg'), size: 80 }],
    })
    assert.equal(resized.changed, true)
    assert.equal(resized.row.status, 'detected')
    assert.equal(resized.row.unpacked_path, '')
  })

  it('searches sources and filters by status/appid with LIKE wildcards escaped', () => {
    const { dir, store } = openStore()
    const rootPath = join(dir, 'users')
    store.upsertSource(sourceInput({ rootPath, appid: APPID_A, version: '135' }))
    store.upsertSource(sourceInput({ rootPath, appid: APPID_A, version: '136' }))
    const other = store.upsertSource(sourceInput({ rootPath, appid: APPID_B, version: '100' }))
    store.updateSource(other.row.id, { status: 'unpacked' })

    assert.equal(store.listSources().length, 3)
    assert.equal(store.listSources({ search: 'dabf' }).length, 2)
    assert.equal(store.listSources({ search: '%' }).length, 0)
    assert.equal(store.listSources({ status: 'unpacked' }).length, 1)
    assert.equal(store.listSources({ appid: APPID_A }).length, 2)
    assert.equal(store.listSources({ appid: APPID_A, status: 'detected' }).length, 2)
    assert.equal(store.listSources({ search: APPID_B, status: 'unpacked' }).length, 1)
  })

  it('lists versions newest-first and finds the latest source per app', () => {
    const { dir, store } = openStore()
    const rootPath = join(dir, 'users')
    store.upsertSource(sourceInput({ rootPath, appid: APPID_A, version: '135' }))
    store.upsertSource(sourceInput({ rootPath, appid: APPID_A, version: '136' }))
    store.upsertSource(sourceInput({ rootPath, appid: APPID_B, version: '100' }))

    assert.deepEqual(
      store.findSources({ appid: APPID_A }).map((row) => row.version),
      ['136', '135'],
    )
    assert.equal(store.findSources({ appid: APPID_A, version: '135' }).length, 1)
    assert.equal(store.findSources({ appid: APPID_A, version: '999' }).length, 0)
    assert.equal(store.latestForApp(APPID_A).version, '136')
    assert.equal(store.latestForApp('wxffffffffffffffff'), null)
  })

  it('ignores unknown update keys and invalid statuses', () => {
    const { dir, store } = openStore()
    const rootPath = join(dir, 'users')
    const created = store.upsertSource(sourceInput({ rootPath }))
    assert.equal(store.updateSource('nope', { status: 'unpacked' }), null)

    const updated = store.updateSource(created.row.id, { app_name: 'Demo App', status: 'bogus', nope: 1 })
    assert.equal(updated.app_name, 'Demo App')
    assert.equal(updated.status, 'detected')
  })
})

describe('miniapp store: settings, analyses and jobs', () => {
  it('round-trips settings and de-duplicates custom roots', () => {
    const { dir, store } = openStore()
    const rootA = join(dir, 'root-a')
    const rootB = join(dir, 'root-b')

    assert.equal(store.getSetting('missing'), null)
    assert.equal(store.getSetting('missing', 'fallback'), 'fallback')
    assert.equal(store.setSetting('lastScanAt', '2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z')
    assert.equal(store.getSetting('lastScanAt'), '2026-01-01T00:00:00.000Z')
    assert.equal(store.setSetting('count', 42), '42')

    assert.deepEqual(store.customRoots(), [])
    const saved = store.setCustomRoots([rootA, `${rootA}\\`, rootB, '  '])
    assert.deepEqual(saved, [resolve(rootA), resolve(rootB)])
    assert.deepEqual(store.customRoots(), saved)
  })

  it('saves and updates analysis JSON per source', () => {
    const { dir, store } = openStore()
    const rootPath = join(dir, 'users')
    const created = store.upsertSource(sourceInput({ rootPath }))
    assert.equal(store.getAnalysis(created.row.id), null)

    store.saveAnalysis(created.row.id, { appid: APPID_A, pages: ['pages/index/index'] })
    assert.deepEqual(store.getAnalysis(created.row.id), {
      appid: APPID_A,
      pages: ['pages/index/index'],
    })
    store.saveAnalysis(created.row.id, { appid: APPID_A, pages: [] })
    assert.deepEqual(store.getAnalysis(created.row.id).pages, [])
  })

  it('creates, clamps and lists jobs', () => {
    const { dir, store } = openStore()
    const rootPath = join(dir, 'users')
    const created = store.upsertSource(sourceInput({ rootPath }))

    const job = store.createJob({ source_id: created.row.id, kind: 'unpack' })
    assert.equal(job.status, 'queued')
    assert.equal(job.progress, 0)
    assert.equal(job.message, '')

    const updated = store.updateJob(job.id, { status: 'running', progress: 150, message: 'half way' })
    assert.equal(updated.status, 'running')
    assert.equal(updated.progress, 100)
    assert.equal(updated.message, 'half way')
    assert.equal(store.updateJob('missing-job', { progress: 1 }), null)
    assert.equal(store.getJob('missing-job'), null)

    store.createJob({ source_id: created.row.id, kind: 'analyze' })
    assert.equal(store.listJobs({ sourceId: created.row.id }).length, 2)
    assert.equal(store.listJobs({ sourceId: created.row.id, limit: 1 }).length, 1)
    assert.equal(store.listJobs({ sourceId: 'other' }).length, 0)
    assert.equal(store.listJobs().length, 2)
  })
})

describe('miniapp store: singleton', () => {
  it('shares one store per db path and resets cleanly', () => {
    resetMiniappStoreForTests()
    const dbPath = join(makeTempDir(), 'singleton.db')
    const first = getMiniappStore({ dbPath })
    openStores.push(first)
    const second = getMiniappStore({ dbPath })
    assert.equal(first, second)
    first.setSetting('marker', 'v1')
    assert.equal(second.getSetting('marker'), 'v1')

    resetMiniappStoreForTests()
    const third = getMiniappStore({ dbPath })
    openStores.push(third)
    assert.notEqual(first, third)
    assert.equal(third.getSetting('marker'), 'v1')
  })
})
