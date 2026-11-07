// Unit tests for safe unpacking + read-only workspace browsing.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  UNPACK_LIMITS,
  isInsideRoot,
  listTree,
  readManifest,
  readTextFile,
  resolveInside,
  safeRelativePath,
  searchFiles,
  unpackSource,
} from '../../src/host/miniapp/unpack.js'
import { ERROR_CODES, WxapkgError } from '../../src/host/miniapp/wxapkg.js'
import {
  buildEncryptedWxapkg,
  buildPlainWxapkg,
  buildUndecryptableWxapkg,
} from './miniapp-helpers.mjs'

const APPID = 'wxdabf06925a55f410'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mini-unpack-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writePackage(directory, name, buffer) {
  mkdirSync(directory, { recursive: true })
  const filePath = join(directory, name)
  writeFileSync(filePath, buffer)
  return { name, path: filePath, size: buffer.length }
}

function sourceFor({ files, appid = APPID, version = '135', packageDir = dirname(files[0].path) } = {}) {
  return { appid, version, root_kind: 'xwechat', package_dir: packageDir, files }
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error instanceof WxapkgError && error.code === code)
}

/* ------------------------------ path jail ------------------------------ */

test('safeRelativePath: normalizes package names and rejects traversal', () => {
  assert.equal(safeRelativePath('/pages/a.js'), 'pages/a.js')
  assert.equal(safeRelativePath('pages\\a.js'), 'pages/a.js')
  assert.equal(safeRelativePath('/a/./b.js'), 'a/b.js')
  assert.equal(safeRelativePath('/'), '')
  assert.equal(safeRelativePath(''), '')

  assertCode(() => safeRelativePath('../evil.js'), ERROR_CODES.INVALID_PACKAGE)
  assertCode(() => safeRelativePath('a/../../evil.js'), ERROR_CODES.INVALID_PACKAGE)
  assertCode(() => safeRelativePath('C:\\Windows\\evil.js'), ERROR_CODES.INVALID_PACKAGE)
  assertCode(() => safeRelativePath('//server/share/evil.js'), ERROR_CODES.INVALID_PACKAGE)
  assertCode(() => safeRelativePath('a\u0000b'), ERROR_CODES.INVALID_PACKAGE)
  assertCode(() => safeRelativePath('a:b'), ERROR_CODES.INVALID_PACKAGE)
  assertCode(() => safeRelativePath('CON'), ERROR_CODES.INVALID_PACKAGE)
  assertCode(() => safeRelativePath('dir./file.js'), ERROR_CODES.INVALID_PACKAGE)
})

test('isInsideRoot/resolveInside: containment, absolute paths and symlinks', (t) => {
  const root = tempDir(t)
  const inner = join(root, 'pages', 'a.js')
  mkdirSync(dirname(inner), { recursive: true })
  writeFileSync(inner, 'ok')

  assert.equal(isInsideRoot(root, inner), true)
  assert.equal(isInsideRoot(root, root), true)
  assert.equal(isInsideRoot(root, join(root, '..', 'escape.js')), false)
  assert.equal(isInsideRoot(join(root, 'pages'), inner), true)

  assert.equal(resolveInside(root, 'pages/a.js', { mustExist: true }), inner)
  assert.equal(resolveInside(root, ''), root)
  assertCode(() => resolveInside(root, '../escape.js'), ERROR_CODES.INVALID_PATH)
  assertCode(() => resolveInside(root, join(root, 'pages', 'a.js')), ERROR_CODES.INVALID_PATH)
  assertCode(() => resolveInside(root, 'missing.txt', { mustExist: true }), ERROR_CODES.INVALID_PATH)

  const target = join(root, 'linked')
  const link = join(root, 'pages', 'linked')
  mkdirSync(target)
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('symlink creation is not permitted in this environment')
    return
  }
  assertCode(() => resolveInside(root, 'pages/linked/file.js'), ERROR_CODES.INVALID_PATH)
})

/* ------------------------------- unpacking ------------------------------- */

test('unpackSource: plain package writes the tree, manifest and clears stale output', async (t) => {
  const workspace = tempDir(t)
  const packageDir = join(workspace, 'src-pkgs')
  const file = writePackage(
    packageDir,
    '__APP__.wxapkg',
    buildPlainWxapkg([
      { name: '/app-config.json', content: '{"pages":["pages/index/index"]}' },
      { name: '/pages/index/index.js', content: 'Page({})' },
      { name: '/common/util.js', content: 'module.exports={}' },
    ]),
  )
  // Stale output from an earlier run must be removed before writing.
  const stale = join(workspace, APPID, '135', 'unpacked', 'stale.txt')
  mkdirSync(dirname(stale), { recursive: true })
  writeFileSync(stale, 'stale')

  const progress = []
  const result = await unpackSource({
    source: sourceFor({ files: [file] }),
    workspaceRoot: workspace,
    onProgress: (event) => progress.push(event.phase),
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'unpacked')
  assert.equal(result.error, '')
  assert.equal(result.unpackedPath, join(workspace, APPID, '135', 'unpacked'))
  assert.equal(result.manifestPath, join(result.unpackedPath, 'manifest.json'))
  const expectedBytes = ['{"pages":["pages/index/index"]}', 'Page({})', 'module.exports={}'].reduce(
    (total, content) => total + Buffer.byteLength(content),
    0,
  )
  assert.deepEqual(result.totals, {
    packages: 1,
    files: 3,
    bytes: expectedBytes,
    skipped: 0,
    conflicts: 0,
    unsupportedPackages: 0,
  })
  assert.equal(existsSync(stale), false)
  assert.equal(readFileSync(join(result.unpackedPath, 'pages/index/index.js'), 'utf8'), 'Page({})')
  assert.ok(progress.includes('start'))
  assert.ok(progress.includes('package'))
  assert.ok(progress.includes('done'))

  const manifest = readManifest(result.unpackedPath)
  assert.ok(manifest)
  assert.equal(manifest.appid, APPID)
  assert.equal(manifest.version, '135')
  assert.equal(manifest.totals.packages, 1)
  assert.equal(manifest.totals.files, 3)
  assert.equal(manifest.packages[0].file, '__APP__.wxapkg')
  assert.equal(manifest.packages[0].format, 'plain')
  assert.equal(manifest.source.root_kind, 'xwechat')
  assert.match(manifest.source.package_hash, /^[0-9a-f]{40}$/)
  assert.equal(manifest.conflicts.length, 0)
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    ['app-config.json', 'common/util.js', 'pages/index/index.js'],
  )
  assert.equal(readManifest(join(workspace, 'missing')), null)
})

test('unpackSource: identical duplicates are skipped, conflicts keep the main package', async (t) => {
  const workspace = tempDir(t)
  const packageDir = join(workspace, 'src-pkgs')
  const appFile = writePackage(
    packageDir,
    '__APP__.wxapkg',
    buildPlainWxapkg([
      { name: '/common/same.js', content: 'same' },
      { name: '/common/diff.js', content: 'from-main' },
    ]),
  )
  const subFile = writePackage(
    packageDir,
    'sub.wxapkg',
    buildPlainWxapkg([
      { name: '/common/same.js', content: 'same' },
      { name: '/common/diff.js', content: 'from-sub' },
    ]),
  )

  // Deliberately unsorted: __APP__ must still win the conflict.
  const result = await unpackSource({
    source: sourceFor({ files: [subFile, appFile] }),
    workspaceRoot: workspace,
  })
  assert.equal(result.ok, true)
  assert.equal(result.totals.packages, 2)
  assert.equal(result.totals.files, 2)
  assert.equal(result.totals.skipped, 1)
  assert.equal(result.totals.conflicts, 1)
  assert.equal(readFileSync(join(result.unpackedPath, 'common/diff.js'), 'utf8'), 'from-main')
  assert.deepEqual(result.manifest.conflicts[0], {
    path: 'common/diff.js',
    keptFrom: '__APP__.wxapkg',
    ignoredFrom: 'sub.wxapkg',
  })
})

test('unpackSource: traversal names fail the source without writing outside', async (t) => {
  const workspace = tempDir(t)
  const packageDir = join(workspace, 'src-pkgs')
  const escapeTarget = join(workspace, 'evil.js')
  const file = writePackage(
    packageDir,
    '__APP__.wxapkg',
    buildPlainWxapkg([{ name: '/../evil.js', content: 'pwn' }]),
  )

  const result = await unpackSource({
    source: sourceFor({ files: [file] }),
    workspaceRoot: workspace,
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.unpackedPath, '')
  assert.match(result.error, /escapes the package root|invalid/i)
  assert.equal(existsSync(escapeTarget), false)
  assert.equal(existsSync(join(workspace, APPID, '135', 'unpacked')), false)
})

test('unpackSource: symlinked ancestors are rejected before any write', async (t) => {
  const workspace = tempDir(t)
  const outside = join(workspace, 'outside')
  mkdirSync(outside, { recursive: true })
  // A pre-existing "unpacked" dir behind the symlink must never be cleared.
  const sentinel = join(outside, '135', 'unpacked', 'sentinel.txt')
  mkdirSync(dirname(sentinel), { recursive: true })
  writeFileSync(sentinel, 'keep-me')
  const link = join(workspace, APPID)
  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('symlink creation is not permitted in this environment')
    return
  }
  const packageDir = join(workspace, 'src-pkgs')
  const file = writePackage(
    packageDir,
    '__APP__.wxapkg',
    buildPlainWxapkg([{ name: '/app.js', content: 'Page({})' }]),
  )

  const result = await unpackSource({
    source: sourceFor({ files: [file] }),
    workspaceRoot: workspace,
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /symbolic link/i)
  assert.equal(existsSync(join(outside, '135')), true)
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep-me')
  assert.equal(lstatSync(link).isSymbolicLink(), true)
})

test('unpackSource: size/count/time limits fail cleanly', async (t) => {
  const workspace = tempDir(t)
  const packageDir = join(workspace, 'src-pkgs')
  const files = [
    { name: '/pages/one.js', content: 'x'.repeat(20) },
    { name: '/pages/two.js', content: 'y'.repeat(20) },
  ]
  const file = writePackage(packageDir, '__APP__.wxapkg', buildPlainWxapkg(files))
  const source = sourceFor({ files: [file] })

  const perFile = await unpackSource({ source, workspaceRoot: workspace, limits: { maxFileBytes: 10 } })
  assert.equal(perFile.ok, false)
  assert.equal(perFile.status, 'failed')
  assert.match(perFile.error, /per-file limit/i)

  const perCount = await unpackSource({ source, workspaceRoot: workspace, limits: { maxFiles: 1 } })
  assert.equal(perCount.ok, false)
  assert.match(perCount.error, /file count exceeded/i)

  const perTotal = await unpackSource({ source, workspaceRoot: workspace, limits: { maxTotalBytes: 25 } })
  assert.equal(perTotal.ok, false)
  assert.match(perTotal.error, /total size exceeded/i)

  const timedOut = await unpackSource({ source, workspaceRoot: workspace, limits: { timeoutMs: -1 } })
  assert.equal(timedOut.ok, false)
  assert.match(timedOut.error, /deadline/i)

  assert.equal(existsSync(join(workspace, APPID, '135', 'unpacked')), false)
  assert.equal(UNPACK_LIMITS.maxFileBytes, 50 * 1024 * 1024)
  assert.equal(UNPACK_LIMITS.maxFiles, 20000)
})

test('unpackSource: encrypted package decrypts with the source appid', async (t) => {
  const workspace = tempDir(t)
  const packageDir = join(workspace, 'src-pkgs')
  const file = writePackage(
    packageDir,
    '__APP__.wxapkg',
    buildEncryptedWxapkg(
      [
        { name: '/app-config.json', content: '{"pages":["pages/index/index"]}' },
        { name: '/pages/index/index.js', content: `Page({filler:"${'z'.repeat(1500)}"})` },
      ],
      APPID,
    ),
  )
  const result = await unpackSource({
    source: sourceFor({ files: [file] }),
    workspaceRoot: workspace,
  })
  assert.equal(result.ok, true)
  assert.equal(result.manifest.packages[0].format, 'v1mmwx')
  assert.equal(readFileSync(join(result.unpackedPath, 'app-config.json'), 'utf8').includes('pages/index/index'), true)
})

test('unpackSource: undecryptable sources degrade to unsupported', async (t) => {
  const workspace = tempDir(t)
  const packageDir = join(workspace, 'src-pkgs')

  const wrongAppid = writePackage(
    packageDir,
    'wrong.wxapkg',
    buildEncryptedWxapkg([{ name: '/app.js', content: 'Page({})' }], APPID),
  )
  const unsupported = await unpackSource({
    source: sourceFor({ appid: 'wx0000000000000000', files: [wrongAppid] }),
    workspaceRoot: workspace,
  })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.status, 'unsupported')
  assert.equal(unsupported.manifest, null)
  assert.match(unsupported.error, /V1MMWX/)
  assert.match(unsupported.error, /wx0000000000000000/)
  assert.equal(existsSync(join(workspace, 'wx0000000000000000', '135', 'unpacked')), false)

  const broken = writePackage(packageDir, 'broken.wxapkg', buildUndecryptableWxapkg(APPID))
  const undecryptable = await unpackSource({
    source: sourceFor({ files: [broken] }),
    workspaceRoot: workspace,
  })
  assert.equal(undecryptable.status, 'unsupported')
  assert.equal(existsSync(join(workspace, APPID, '135', 'unpacked')), false)
})

/* ---------------------------- workspace browser ---------------------------- */

function fixtureTree(t) {
  const root = tempDir(t)
  writeFileSync(join(root, 'app-config.json'), '{}')
  mkdirSync(join(root, 'pages'), { recursive: true })
  writeFileSync(join(root, 'pages', 'a.js'), 'one\ntwo\nthree\nfour\nfive\n')
  writeFileSync(join(root, 'pages', 'b.js'), 'needle here\nconst other = "needle2";\n')
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'needle ignored\n')
  writeFileSync(join(root, 'info.json'), '{"needle":true}\n')
  writeFileSync(join(root, 'logo.bin'), Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]))
  return root
}

test('listTree: dirs first, relative posix paths, path jail and cap', (t) => {
  const root = fixtureTree(t)
  const tree = listTree({ root })
  assert.equal(tree.path, '')
  assert.ok(tree.entries.length >= 4)
  const types = tree.entries.map((entry) => entry.type)
  assert.deepEqual(types.slice(0, types.lastIndexOf('dir') + 1).every((type) => type === 'dir'), true)
  const pages = tree.entries.find((entry) => entry.name === 'pages')
  assert.equal(pages.path, 'pages')
  assert.equal(pages.type, 'dir')
  const appJs = listTree({ root, path: 'pages' }).entries.find((entry) => entry.name === 'a.js')
  assert.equal(appJs.type, 'file')
  assert.equal(appJs.path, 'pages/a.js')
  assert.equal(appJs.size, 24)
  assertCode(() => listTree({ root, path: '../..' }), ERROR_CODES.INVALID_PATH)
  assertCode(() => listTree({ root, path: join(root, 'pages') }), ERROR_CODES.INVALID_PATH)
  assertCode(() => listTree({ root, path: 'app-config.json' }), ERROR_CODES.INVALID_PATH)

  mkdirSync(join(root, 'cap'))
  for (let index = 0; index < 505; index += 1) {
    writeFileSync(join(root, 'cap', `f${index}.txt`), 'x')
  }
  assert.equal(listTree({ root, path: 'cap' }).entries.length, 500)
})

test('readTextFile: line paging, byte caps, binary detection and jail', (t) => {
  const root = fixtureTree(t)
  const full = readTextFile({ root, path: 'pages/a.js' })
  assert.equal(full.path, 'pages/a.js')
  assert.equal(full.content, 'one\ntwo\nthree\nfour\nfive')
  assert.equal(full.totalLines, 5)
  assert.equal(full.truncated, false)
  assert.equal(full.binary, false)
  assert.equal(full.size, 24)

  const page = readTextFile({ root, path: 'pages/a.js', offset: 1, limit: 2 })
  assert.equal(page.content, 'two\nthree')
  assert.equal(page.offset, 1)
  assert.equal(page.truncated, true)

  const tail = readTextFile({ root, path: 'pages/a.js', offset: 4, limit: 10 })
  assert.equal(tail.content, 'five')
  assert.equal(tail.truncated, false)

  const byteCapped = readTextFile({ root, path: 'pages/a.js', maxBytes: 12 })
  assert.equal(byteCapped.truncated, true)
  assert.equal(byteCapped.size, 24)

  const binary = readTextFile({ root, path: 'logo.bin' })
  assert.equal(binary.binary, true)
  assert.equal(binary.content, '')

  assertCode(() => readTextFile({ root, path: '../app-config.json' }), ERROR_CODES.INVALID_PATH)
  assertCode(() => readTextFile({ root, path: 'missing.js' }), ERROR_CODES.INVALID_PATH)
  assertCode(() => readTextFile({ root, path: 'pages' }), ERROR_CODES.INVALID_PATH)
})

test('searchFiles: query/regex/glob/maxResults, binary + node_modules skipped', (t) => {
  const root = fixtureTree(t)
  const plain = searchFiles({ root, query: 'needle' })
  assert.ok(plain.matches.length >= 3)
  assert.equal(plain.truncated, false)
  assert.ok(plain.scanned >= 3)
  assert.equal(plain.matches.some((match) => match.file.startsWith('node_modules/')), false)
  assert.equal(plain.matches.some((match) => match.file === 'logo.bin'), false)
  assert.ok(plain.matches.every((match) => match.line >= 1 && match.text.length <= 240))
  const bMatch = plain.matches.filter((match) => match.file === 'pages/b.js')
  assert.equal(bMatch.length, 2)
  assert.equal(bMatch[0].line, 1)

  const regex = searchFiles({ root, query: 'needle\\d', regex: true })
  assert.equal(regex.matches.length, 1)
  assert.equal(regex.matches[0].file, 'pages/b.js')

  const globbed = searchFiles({ root, query: 'needle', glob: '**/*.js' })
  assert.ok(globbed.matches.length > 0)
  assert.ok(globbed.matches.every((match) => match.file.endsWith('.js')))

  const capped = searchFiles({ root, query: 'needle', maxResults: 1 })
  assert.equal(capped.matches.length, 1)
  assert.equal(capped.truncated, true)

  assertCode(() => searchFiles({ root, query: '[', regex: true }), ERROR_CODES.INVALID_QUERY)
  assertCode(() => searchFiles({ root, query: '' }), ERROR_CODES.INVALID_QUERY)
  assertCode(() => searchFiles({ root: join(root, 'missing'), query: 'x' }), ERROR_CODES.INVALID_PATH)
})
