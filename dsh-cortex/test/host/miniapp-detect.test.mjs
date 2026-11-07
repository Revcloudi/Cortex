import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { MiniappStore } from '../../src/host/miniapp/store.js'
import { detectFormat, groupPackages, scanMiniapps } from '../../src/host/miniapp/detect.js'
import {
  defaultRoots,
  envRoots,
  expandRoots,
  inferIdentity,
  miniAppWorkspaceRoot,
  packageWorkspace,
  sanitizeSegment,
} from '../../src/host/miniapp/roots.js'

const APPID_A = 'wxdabf06925a55f410'
const APPID_B = 'wx0123456789abcdef'

/** @type {string[]} */
const tempDirs = []
/** @type {MiniappStore[]} */
const openStores = []

after(() => {
  for (const store of openStores) store.close()
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cortex-miniapp-detect-'))
  tempDirs.push(dir)
  return dir
}

function openStore() {
  const dir = makeTempDir()
  const store = new MiniappStore({ dbPath: join(dir, 'plugin.db') })
  store.ensure()
  openStores.push(store)
  return store
}

/**
 * Write a fake package file:
 *  - plain: byte0 0xBE
 *  - v1mmwx: "V1MMWX" header
 *  - unknown: ascii filler without either signature
 */
function writePackage(filePath, kind = 'plain', size = 64) {
  const buffer = Buffer.alloc(Math.max(size, 16), 0x41)
  if (kind === 'plain') buffer[0] = 0xbe
  else if (kind === 'v1mmwx') buffer.write('V1MMWX', 0, 'latin1')
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, buffer)
}

function xwechatRoot(users) {
  return { kind: 'xwechat', path: users, label: 'fake xwechat', mode: 'recursive', maxDepth: 10 }
}

/**
 * Fake WeChat 4.x tree: two appids, appid A has two versions, and the 135
 * version carries a subpackage so format must come from the largest file.
 */
function buildXwechatTree(base) {
  const users = join(base, 'users')
  writePackage(join(users, 'hash-a', 'applet', 'packages', APPID_A, '135', '__APP__.wxapkg'), 'plain', 32)
  writePackage(join(users, 'hash-a', 'applet', 'packages', APPID_A, '135', 'sub.wxapkg'), 'v1mmwx', 128)
  writePackage(join(users, 'hash-a', 'applet', 'packages', APPID_A, '136', '__APP__.wxapkg'), 'plain', 64)
  writePackage(join(users, 'hash-b', 'applet', 'packages', APPID_B, '100', '__APP__.wxapkg'), 'plain', 48)
  return users
}

describe('miniapp roots: discovery and workspace helpers', () => {
  it('builds the three default roots from a fake environment', () => {
    const base = makeTempDir()
    const env = {
      APPDATA: join(base, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(base, 'AppData', 'Local'),
      USERPROFILE: join(base, 'Users', 'tester'),
      HOME: '',
    }
    const roots = defaultRoots(env)
    assert.equal(roots.length, 3)
    assert.deepEqual(roots.map((root) => root.kind), ['xwechat', 'wechat3', 'devtools'])
    assert.equal(roots[0].path, resolve(join(env.APPDATA, 'Tencent', 'xwechat', 'radium', 'users')))
    assert.equal(roots[1].path, resolve(join(env.USERPROFILE, 'Documents', 'WeChat Files')))
    assert.equal(
      roots[2].path,
      resolve(join(env.LOCALAPPDATA, '微信web开发者工具', 'User Data')),
    )
    assert.equal(roots.every((root) => root.mode === 'recursive'), true)
  })

  it('expands existing roots only, plus custom and CORTEX_MINIAPP_ROOTS entries', () => {
    const base = makeTempDir()
    const customRoot = join(base, 'custom-root')
    const envRoot = join(base, 'env-root')
    mkdirSync(customRoot, { recursive: true })
    mkdirSync(envRoot, { recursive: true })
    const env = {
      CORTEX_MINIAPP_ROOTS: `${envRoot};${join(base, 'missing-env')}`,
      APPDATA: join(base, 'no-appdata'),
      LOCALAPPDATA: join(base, 'no-localappdata'),
      USERPROFILE: join(base, 'no-home'),
      HOME: '',
    }

    const roots = expandRoots({ customRoots: [customRoot, join(base, 'missing-custom')], env })
    assert.deepEqual(roots.map((root) => root.kind), ['custom', 'custom'])
    assert.deepEqual(roots.map((root) => root.path), [resolve(customRoot), resolve(envRoot)])

    const missing = expandRoots({ customRoots: [join(base, 'missing-custom')], env, includeMissing: true })
    assert.equal(missing.length, 6) // 3 defaults + 1 custom + 2 env
    assert.deepEqual(
      envRoots({ CORTEX_MINIAPP_ROOTS: `${join(base, 'a')};${join(base, 'b')}` }),
      [resolve(join(base, 'a')), resolve(join(base, 'b'))],
    )
    assert.deepEqual(envRoots({}), [])
  })

  it('resolves workspace roots and sanitizes path segments', () => {
    const base = makeTempDir()
    assert.equal(
      miniAppWorkspaceRoot({ HOME: join(base, 'home'), USERPROFILE: '' }),
      resolve(join(base, 'home', '.cortex', 'miniapps')),
    )
    const env = { CORTEX_MINIAPP_WORKSPACE: join(base, 'ws'), HOME: join(base, 'home') }
    assert.equal(miniAppWorkspaceRoot(env), resolve(join(base, 'ws')))

    const workspace = packageWorkspace(APPID_A, '135', env)
    assert.equal(workspace.root, resolve(join(base, 'ws', APPID_A, '135')))
    assert.equal(workspace.unpacked, join(workspace.root, 'unpacked'))
    assert.equal(workspace.manifestPath, join(workspace.unpacked, 'manifest.json'))
    assert.equal(workspace.extractedPath, join(workspace.unpacked, 'extracted.json'))
    assert.equal(packageWorkspace('../evil', '..', env).root, resolve(base, 'ws', '_evil', 'unknown'))

    assert.equal(sanitizeSegment('  a/b:c  ', 'fb'), 'a_b_c')
    assert.equal(sanitizeSegment('   ', 'fb'), 'fb')
    assert.equal(sanitizeSegment('CON'), '_CON')
  })

  it('infers appid/version for common wxapkg layouts', () => {
    const base = makeTempDir()
    const users = join(base, 'users')
    const packageDir = join(users, 'hash-a', 'applet', 'packages', APPID_A, '135')
    const identity = inferIdentity(join(packageDir, '__APP__.wxapkg'), xwechatRoot(users))
    assert.equal(identity.appid, APPID_A)
    assert.equal(identity.version, '135')
    assert.equal(identity.packageDir, packageDir)
    assert.equal(identity.packageName, '__APP__')
    assert.equal(identity.rootPath, users)
    assert.equal(identity.rootKind, 'xwechat')

    const publicLib = inferIdentity(
      join(users, 'hash-b', 'applet', 'publicLib', '3.8.1', 'publicLib.wxapkg'),
      xwechatRoot(users),
    )
    assert.equal(publicLib.appid, 'publicLib')
    assert.equal(publicLib.version, '3.8.1')

    const dated = inferIdentity(
      join(users, 'applet', 'packages', APPID_B, '20240101', 'app.wxapkg'),
      xwechatRoot(users),
    )
    assert.equal(dated.appid, APPID_B)
    assert.equal(dated.version, '20240101')

    const noAppid = inferIdentity(join(base, 'custom', 'sub', 'app.wxapkg'), {
      kind: 'custom',
      path: join(base, 'custom'),
      label: 'custom',
      mode: 'recursive',
      maxDepth: 10,
    })
    assert.equal(noAppid.appid, '')
    assert.equal(noAppid.version, '')

    // Never report a package dir outside the scan root.
    const outside = inferIdentity(join(base, 'elsewhere', 'app.wxapkg'), xwechatRoot(users))
    assert.equal(outside.packageDir, users)
    assert.equal(outside.appid, '')
  })
})

describe('miniapp detect: format and grouping', () => {
  it('detects plain, v1mmwx and unknown containers from the first bytes', () => {
    const base = makeTempDir()
    const plain = join(base, 'plain.wxapkg')
    const encrypted = join(base, 'enc.wxapkg')
    const unknown = join(base, 'unknown.wxapkg')
    writePackage(plain, 'plain')
    writePackage(encrypted, 'v1mmwx')
    writeFileSync(unknown, Buffer.from('NOPE'))

    assert.equal(detectFormat(plain), 'plain')
    assert.equal(detectFormat(encrypted), 'v1mmwx')
    assert.equal(detectFormat(unknown), 'unknown')
    assert.equal(detectFormat(join(base, 'missing.wxapkg')), 'unknown')
  })

  it('groups files by package dir with __APP__ first and format from the largest file', () => {
    const base = makeTempDir()
    const packageDir = join(base, 'pkgs', APPID_A, '135')
    writePackage(join(packageDir, '__APP__.wxapkg'), 'plain', 32)
    writePackage(join(packageDir, 'sub.wxapkg'), 'v1mmwx', 128)

    const groups = groupPackages(
      [
        { path: join(packageDir, '__APP__.wxapkg'), size: 32 },
        { path: join(packageDir, 'sub.wxapkg'), size: 128 },
      ],
      { kind: 'custom', path: join(base, 'pkgs'), label: 'pkgs', mode: 'recursive', maxDepth: 10 },
    )
    assert.equal(groups.length, 1)
    assert.equal(groups[0].appid, APPID_A)
    assert.equal(groups[0].version, '135')
    assert.equal(groups[0].file_count, 2)
    assert.equal(groups[0].size_bytes, 160)
    assert.equal(groups[0].format, 'v1mmwx')
    assert.deepEqual(groups[0].files.map((file) => file.name), ['__APP__.wxapkg', 'sub.wxapkg'])
  })
})

describe('miniapp detect: scanning', () => {
  it('detects a fake xwechat tree, dedupes on rescan and updates only changed sources', async () => {
    const base = makeTempDir()
    const users = buildXwechatTree(base)
    const store = openStore()
    const options = {
      store,
      roots: [xwechatRoot(users)],
      now: () => '2026-01-01T00:00:00.000Z',
    }

    const first = await scanMiniapps(options)
    assert.equal(first.ok, true)
    assert.equal(first.totalSources, 3)
    assert.equal(first.totalPackages, 4)
    assert.equal(first.added, 3)
    assert.equal(first.updated, 0)
    assert.equal(first.unchanged, 0)
    assert.equal(first.errors.length, 0)
    assert.equal(first.roots.length, 1)
    assert.equal(first.roots[0].exists, true)
    assert.equal(first.roots[0].filesFound, 4)
    assert.equal(first.scannedAt, '2026-01-01T00:00:00.000Z')
    assert.deepEqual(
      first.sources.map((source) => `${source.appid}:${source.version}`),
      [`${APPID_B}:100`, `${APPID_A}:136`, `${APPID_A}:135`],
    )
    const rich = first.sources.find((source) => source.version === '135')
    assert.equal(rich.format, 'v1mmwx')
    assert.equal(rich.file_count, 2)
    assert.equal(rich.size_bytes, 160)
    assert.equal(rich.root_kind, 'xwechat')
    assert.equal(rich.status, 'detected')
    assert.equal(store.listSources().length, 3)

    // Re-scan without changes: no writes, everything `unchanged`.
    store.updateSource(rich.id, { status: 'unpacked', unpacked_path: join(base, 'out') })
    const second = await scanMiniapps(options)
    assert.equal(second.added, 0)
    assert.equal(second.updated, 0)
    assert.equal(second.unchanged, 3)
    assert.equal(second.totalSources, 3)
    assert.equal(store.getSource(rich.id).status, 'unpacked')
    assert.equal(store.getSource(rich.id).unpacked_path, join(base, 'out'))

    // Growing one package file resets just that source.
    writePackage(join(users, 'hash-a', 'applet', 'packages', APPID_A, '136', '__APP__.wxapkg'), 'plain', 96)
    const third = await scanMiniapps(options)
    assert.equal(third.added, 0)
    assert.equal(third.updated, 1)
    assert.equal(third.unchanged, 2)
    const resized = third.sources.find((source) => source.version === '136')
    assert.equal(resized.size_bytes, 96)
  })

  it('tolerates a missing root and scans env-configured roots instead of real defaults', async () => {
    const base = makeTempDir()
    const store = openStore()
    const missing = await scanMiniapps({
      store,
      roots: [{ kind: 'custom', path: join(base, 'does-not-exist') }],
    })
    assert.equal(missing.ok, true)
    assert.equal(missing.totalSources, 0)
    assert.equal(missing.roots[0].exists, false)
    assert.equal(missing.roots[0].filesFound, 0)
    assert.deepEqual(missing.errors, [])

    const envBase = makeTempDir()
    const users = join(envBase, 'users')
    writePackage(join(users, 'hash-a', 'applet', 'packages', APPID_A, '135', '__APP__.wxapkg'), 'plain', 32)
    const env = {
      CORTEX_MINIAPP_ROOTS: users,
      APPDATA: join(envBase, 'no-roaming'),
      LOCALAPPDATA: join(envBase, 'no-local'),
      USERPROFILE: join(envBase, 'no-home'),
      HOME: join(envBase, 'no-home'),
    }
    const result = await scanMiniapps({ store, env })
    assert.equal(result.totalSources, 1)
    assert.deepEqual(result.roots.map((root) => root.kind), ['custom'])
    assert.equal(result.roots[0].filesFound, 1)
    assert.equal(result.sources[0].appid, APPID_A)
    assert.equal(result.sources[0].root_kind, 'custom')
  })

  it('counts per-directory permission errors and keeps scanning', async () => {
    const base = makeTempDir()
    const blockedDir = join(base, 'blocked')
    writePackage(join(blockedDir, '__APP__.wxapkg'), 'plain', 32)
    writePackage(join(base, 'ok', '__APP__.wxapkg'), 'v1mmwx', 64)

    const io = {
      existsSync: nodeFs.existsSync,
      statSync: nodeFs.statSync,
      readdirSync(path, options) {
        if (resolve(path) === resolve(blockedDir)) {
          const error = new Error('access denied')
          error.code = 'EACCES'
          throw error
        }
        return nodeFs.readdirSync(path, options)
      },
    }
    const result = await scanMiniapps({
      store: openStore(),
      roots: [{ kind: 'custom', path: base }],
      io,
    })
    assert.equal(result.ok, true)
    assert.equal(result.totalSources, 1)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].path, blockedDir)
    assert.match(result.errors[0].message, /EACCES/)
    assert.equal(result.roots[0].errors, 1)
  })

  it('honours depth, maxFiles, maxPackageFiles and skips node_modules', async () => {
    const base = makeTempDir()
    writePackage(join(base, 'level1', '__APP__.wxapkg'), 'plain', 16)
    writePackage(join(base, 'level1', 'level2', '__APP__.wxapkg'), 'plain', 16)
    writePackage(join(base, 'node_modules', 'dep', '__APP__.wxapkg'), 'plain', 16)

    const depthResult = await scanMiniapps({
      store: openStore(),
      roots: [{ kind: 'custom', path: base }],
      limits: { maxDepth: 1 },
    })
    assert.equal(depthResult.totalSources, 1)
    assert.equal(depthResult.roots[0].filesFound, 1)

    const filesBase = makeTempDir()
    for (const name of ['one', 'two', 'three']) {
      writePackage(join(filesBase, name, '__APP__.wxapkg'), 'plain', 16)
    }
    const fileResult = await scanMiniapps({
      store: openStore(),
      roots: [{ kind: 'custom', path: filesBase }],
      limits: { maxFiles: 2 },
    })
    assert.equal(fileResult.totalPackages, 2)
    assert.equal(fileResult.totalSources, 2)
    assert.equal(fileResult.errors.some((error) => /maxFiles/.test(error.message)), true)

    const packageBase = makeTempDir()
    const packageDir = join(packageBase, APPID_A, '135')
    for (const name of ['__APP__.wxapkg', 'a.wxapkg', 'b.wxapkg']) {
      writePackage(join(packageDir, name), 'plain', 16)
    }
    const packageResult = await scanMiniapps({
      store: openStore(),
      roots: [{ kind: 'custom', path: packageBase }],
      limits: { maxPackageFiles: 2 },
    })
    assert.equal(packageResult.totalSources, 1)
    assert.equal(packageResult.totalPackages, 2)
    assert.equal(packageResult.sources[0].file_count, 2)
    assert.equal(packageResult.errors.some((error) => /maxPackageFiles/.test(error.message)), true)
  })

  it('dedupes one package directory reachable from overlapping roots', async () => {
    const base = makeTempDir()
    const users = buildXwechatTree(base)
    const packagesDir = join(users, 'hash-a', 'applet', 'packages')
    const result = await scanMiniapps({
      store: openStore(),
      roots: [xwechatRoot(users), { kind: 'xwechat', path: packagesDir }],
    })
    assert.equal(result.roots.length, 2)
    assert.equal(result.totalSources, 3)
    assert.equal(result.totalPackages, 4)
    assert.equal(result.roots[1].filesFound, 3)
  })

  it('detects publicLib as its own source with the version from its directory', async () => {
    const base = makeTempDir()
    const users = join(base, 'users')
    writePackage(
      join(users, 'hash-b', 'applet', 'publicLib', '3.8.1', 'publicLib.wxapkg'),
      'v1mmwx',
      256,
    )
    const result = await scanMiniapps({ store: openStore(), roots: [xwechatRoot(users)] })
    assert.equal(result.totalSources, 1)
    assert.equal(result.sources[0].appid, 'publicLib')
    assert.equal(result.sources[0].version, '3.8.1')
    assert.equal(result.sources[0].format, 'v1mmwx')
    assert.equal(result.sources[0].root_kind, 'xwechat')
  })
})
