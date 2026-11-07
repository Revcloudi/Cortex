/**
 * Real-HTTP tests for the mini-program (`/cortex-api/cortex/miniapps/**`) API.
 *
 * The tests build a throwaway fake WeChat package tree plus synthetic wxapkg
 * containers (plaintext and V1MMWX), redirect every path into a temp directory,
 * and never touch the developer's real WeChat cache or ~/.cortex database.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, it } from 'node:test'
import { createTestDb, startTestHost, cleanupDir, makeTempDir } from './helpers.mjs'
import {
  isolateMiniappEnv,
  sampleFiles,
  writeFakePackage,
  writeUndecryptablePackage,
} from './miniapp-helpers.mjs'

const APPID = 'wxaaabbbcccdddeeff'
const APPID2 = 'wx1111222233334444'
const PLUGIN_APPID = 'wx5555666677778888'

const tmp = makeTempDir()
const fakeRoot = join(tmp, 'xwechat-users')
const altRoot = join(tmp, 'alt-root')

let server
let mainDb
let env

function api(path) {
  return `/cortex-api/cortex${path}`
}

function call(path, options = {}) {
  return server.request(api(path), {
    ...options,
    headers: { origin: server.base, ...(options.headers || {}) },
  })
}

function expectOk(response) {
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${response.text.slice(0, 400)}`)
  assert.ok(response.json !== null, 'expected a JSON body')
  return response.json
}

function findSource(listing, appid, version) {
  return listing.miniapps.find((row) => row.appid === appid && String(row.version) === String(version))
}

before(async () => {
  env = isolateMiniappEnv(tmp, { roots: [fakeRoot] })
  writeFakePackage(fakeRoot, { appid: APPID, version: 1, files: sampleFiles({ marker: 'VERSION-ONE' }) })
  writeFakePackage(fakeRoot, { appid: APPID, version: 2, files: sampleFiles({ marker: 'MINIAPP-UNIQUE-MARKER' }) })
  // Same appid+version cached under a second WeChat user -> the list must collapse it.
  writeFakePackage(fakeRoot, {
    user: 'userhash2',
    appid: APPID,
    version: 2,
    files: sampleFiles({ marker: 'MINIAPP-UNIQUE-MARKER' }),
  })
  writeFakePackage(fakeRoot, {
    appid: APPID,
    version: 3,
    encrypted: true,
    files: sampleFiles({ marker: 'ENCRYPTED-V3' }),
  })
  writeFakePackage(fakeRoot, {
    appid: PLUGIN_APPID,
    version: 7,
    fileName: '__PLUGINCODE__.wxapkg',
    files: sampleFiles({ marker: 'PLUGIN-CODE' }),
  })
  writeUndecryptablePackage(fakeRoot, { appid: APPID2, version: 9 })
  writeFakePackage(altRoot, { appid: APPID2, version: 5, files: sampleFiles({ marker: 'ALT-ROOT' }) })

  mainDb = createTestDb()
  server = await startTestHost({ dbPath: mainDb.dbPath })
})

after(async () => {
  if (server) await server.close()
  cleanupDir(mainDb ? mainDb.dir : tmp)
  cleanupDir(tmp)
})

it('POST /miniapps/scan detects packages, groups versions and persists roots', async () => {
  const body = expectOk(await call('/miniapps/scan', { method: 'POST', body: { customRoots: [fakeRoot] } }))
  assert.equal(body.ok, true)
  assert.ok(body.totalSources >= 6, `expected >= 6 sources, got ${body.totalSources}`)
  assert.ok(body.appCount >= 3, `expected >= 3 apps, got ${body.appCount}`)
  assert.ok(body.added >= 6, `expected >= 6 added, got ${body.added}`)
  assert.ok(Array.isArray(body.customRoots) && body.customRoots.includes(fakeRoot))
  assert.ok(typeof body.scannedAt === 'string' && body.scannedAt.length > 0)
  // Same appid+version from two user caches is collapsed into one row.
  assert.equal(body.miniapps.filter((row) => row.appid === APPID).length, 3)
  assert.equal(
    body.miniapps.filter((row) => row.appid === APPID).find((row) => row.version === '2')?.source_count,
    2,
  )
  assert.equal(
    body.miniapps.find((row) => row.appid === PLUGIN_APPID)?.kind,
    'plugin',
  )
  // Name enrichment reads one package per app so the UI can show a Chinese name.
  assert.ok(
    body.miniapps.some((row) => row.appid === APPID && row.app_name === '测试健康商城'),
    'expected a Chinese app_name extracted from app-config.json',
  )
})

it('GET /miniapps lists newest version with counts and formats', async () => {
  const body = expectOk(await call(`/miniapps?search=${APPID}`))
  assert.equal(body.total, 3, `expected 3 versions for ${APPID}`)
  assert.equal(body.appCount, 1)
  const versions = body.miniapps.map((row) => String(row.version)).sort()
  assert.deepEqual(versions, ['1', '2', '3'])
  for (const row of body.miniapps) {
    assert.equal(row.appid, APPID)
    assert.equal(row.version_count, 3)
    assert.ok(['plain', 'v1mmwx'].includes(row.format))
    assert.equal(row.status, 'detected')
    assert.equal(row.kind, 'app')
  }
  const latest = body.miniapps.find((row) => row.is_latest)
  assert.equal(latest.version, '3')
  assert.equal(latest.format, 'v1mmwx')
})

it('GET /miniapps/:id returns detail + versions; unknown id is 404', async () => {
  const listing = expectOk(await call(`/miniapps?search=${APPID}`))
  const target = listing.miniapps.find((row) => String(row.version) === '2')
  const detail = expectOk(await call(`/miniapps/${target.id}`))
  assert.equal(detail.miniapp.id, target.id)
  assert.equal(detail.miniapp.appid, APPID)
  assert.equal(detail.miniapp.versions.length, 3)
  assert.equal(detail.manifest, null)
  assert.equal(detail.analysis, null)
  assert.equal(detail.extractedCounts.endpoints, 0)

  const missing = await call('/miniapps/does-not-exist')
  assert.equal(missing.status, 404)
})

it('POST /unpack decrypts plaintext and V1MMWX, and degrades unknown packages', async () => {
  const listing = expectOk(await call(`/miniapps?search=${APPID}`))
  for (const version of ['2', '3']) {
    const target = listing.miniapps.find((row) => String(row.version) === version)
    const body = expectOk(await call(`/miniapps/${target.id}/unpack`, { method: 'POST', body: { force: true } }))
    assert.equal(body.ok, true, `version ${version} should unpack: ${body.error || ''}`)
    assert.equal(body.status, 'unpacked')
    assert.ok(body.totals.files >= 3, `expected >= 3 files, got ${body.totals.files}`)
    assert.ok(body.manifest && Array.isArray(body.manifest.files))
  }

  const unsupportedListing = expectOk(await call(`/miniapps?search=${APPID2}`))
  const unsupported = unsupportedListing.miniapps.find((row) => String(row.version) === '9')
  const body = expectOk(await call(`/miniapps/${unsupported.id}/unpack`, { method: 'POST', body: {} }))
  assert.equal(body.ok, false)
  assert.equal(body.status, 'unsupported')
  assert.ok(String(body.error).length > 0, 'unsupported packages must carry a reason')

  const afterUnsupported = expectOk(await call(`/miniapps?search=${APPID2}`))
  const failedRow = afterUnsupported.miniapps.find((row) => row.id === unsupported.id)
  assert.equal(failedRow.status, 'unsupported')
  // Other packages stay untouched by the unsupported one.
  const unaffected = expectOk(await call(`/miniapps?search=${APPID}`))
  const healthy = unaffected.miniapps.filter((row) => ['2', '3'].includes(String(row.version)))
  assert.equal(healthy.length, 2)
  assert.ok(healthy.every((row) => row.status === 'unpacked'))
})

it('GET tree/file/search works inside the workspace and rejects escapes', async () => {
  const listing = expectOk(await call(`/miniapps?search=${APPID}`))
  const target = listing.miniapps.find((row) => String(row.version) === '2')

  const tree = expectOk(await call(`/miniapps/${target.id}/tree`))
  assert.ok(Array.isArray(tree.entries) && tree.entries.length > 0)
  assert.ok(tree.entries.some((entry) => entry.name === 'app-service.js'))

  const file = expectOk(await call(`/miniapps/${target.id}/file?path=app-service.js&limit=20`))
  assert.ok(file.content.includes('MINIAPP-UNIQUE-MARKER'))
  assert.ok(file.totalLines > 0)

  // JSON/JS previews are pretty-printed server-side (raw bytes stay untouched).
  const config = expectOk(await call(`/miniapps/${target.id}/file?path=app-config.json&limit=40`))
  assert.equal(config.formatted, true)
  assert.ok(config.totalLines > 3)
  assert.match(config.content, /\n {2}"pages": \[/)

  const rawConfig = expectOk(
    await call(`/miniapps/${target.id}/file?path=app-config.json&limit=40&format=0`),
  )
  assert.equal(rawConfig.formatted, false)
  assert.equal(rawConfig.totalLines, 1)

  const offsetFile = expectOk(await call(`/miniapps/${target.id}/file?path=pages/index/index.js&offset=0&limit=5`))
  assert.ok(offsetFile.content.includes('MINIAPP-UNIQUE-MARKER'))

  const search = expectOk(
    await call(`/miniapps/${target.id}/search?query=MINIAPP-UNIQUE-MARKER&maxResults=10`),
  )
  assert.ok(search.matches.length >= 1)
  assert.ok(search.matches.every((match) => typeof match.file === 'string' && typeof match.line === 'number'))

  const escape = await call(`/miniapps/${target.id}/file?path=${encodeURIComponent('../package.json')}`)
  assert.equal(escape.status, 400, escape.text)

  const absolute = await call(`/miniapps/${target.id}/file?path=${encodeURIComponent('C:\\Windows\\win.ini')}`)
  assert.equal(absolute.status, 400, absolute.text)

  const badRegex = await call(`/miniapps/${target.id}/search?query=${encodeURIComponent('(')}&regex=1`)
  assert.equal(badRegex.status, 400, badRegex.text)
})

it('POST /analyze produces a capped overview with domains, endpoints and masked secrets', async () => {
  const listing = expectOk(await call(`/miniapps?search=${APPID}`))
  const target = listing.miniapps.find((row) => String(row.version) === '2')
  const body = expectOk(await call(`/miniapps/${target.id}/analyze`, { method: 'POST', body: { force: true } }))
  assert.equal(body.ok, true)
  assert.ok(body.analysis.pages.length >= 2)
  assert.ok(body.analysis.subPackages.length >= 1)
  assert.ok(body.analysis.domains.some((domain) => domain.host === 'api.demo-target.test'))
  assert.ok(body.analysis.endpoints.length >= 1)
  assert.ok(body.analysis.secrets.length >= 1)
  assert.ok(body.analysis.parameters.length >= 1)
  assert.ok(body.overviewText.length <= 8000)
  assert.ok(!/sk-abcdefghijklmnopqrstuvwxyz/.test(body.overviewText), 'overview text must not expose full secrets')

  const detail = expectOk(await call(`/miniapps/${target.id}`))
  assert.ok(detail.analysis !== null)
  assert.equal(detail.miniapp.status, 'unpacked')
  assert.ok(detail.extractedCounts.endpoints >= 1)
})

it('POST /import-assets writes canonical interfaces/leaks/params into the asset library', async () => {
  const listing = expectOk(await call(`/miniapps?search=${APPID}`))
  const target = listing.miniapps.find((row) => String(row.version) === '2')
  const body = expectOk(
    await call(`/miniapps/${target.id}/import-assets`, {
      method: 'POST',
      body: { project_name: '小程序测试项目' },
    }),
  )
  assert.equal(body.ok, true)
  assert.ok(body.totals.interfaces >= 1)
  assert.ok(body.totals.leaks >= 1)
  assert.ok(body.totals.parameters >= 1)
  const asset = body.assets[0]
  assert.match(asset.host_port, /^https?:\/\/api\.demo-target\.test/)
  assert.equal(asset.created, true)

  const detail = expectOk(await call(`/assets/${encodeURIComponent(asset.host_port)}`))
  assert.equal(detail.project_name, '小程序测试项目')
  assert.ok(detail.interfaces.length >= 1)
  assert.ok(detail.leaked_infos.length >= 1)
  assert.ok(detail.test_parameters.length >= 1)
  assert.ok(detail.interfaces.every((entry) => typeof entry.path === 'string' && entry.path.startsWith('/')))
  assert.ok(detail.leaked_infos.every((entry) => typeof entry.value === 'string' && entry.value.length > 0))
  assert.ok(detail.leaked_infos.some((entry) => /^sk-/.test(entry.value)))
})

it('GET/POST /miniapps/roots persists custom roots and the next scan finds them', async () => {
  const initial = expectOk(await call('/miniapps/roots'))
  assert.ok(Array.isArray(initial.roots) && initial.roots.some((root) => root.kind === 'xwechat'))
  assert.ok(initial.roots.every((root) => typeof root.exists === 'boolean'))

  const updated = expectOk(
    await call('/miniapps/roots', { method: 'POST', body: { roots: [fakeRoot, altRoot], mode: 'replace' } }),
  )
  assert.ok(updated.customRoots.includes(fakeRoot))
  assert.ok(updated.customRoots.includes(altRoot))

  const scan = expectOk(await call('/miniapps/scan', { method: 'POST', body: {} }))
  assert.ok(scan.miniapps.some((row) => row.appid === APPID2 && String(row.version) === '5'))

  const absolute = await call('/miniapps/roots', {
    method: 'POST',
    body: { roots: ['relative/path'], mode: 'replace' },
  })
  assert.equal(absolute.status, 400, absolute.text)
})

it('POST /miniapps/:id/name overrides the display name', async () => {
  const listing = expectOk(await call(`/miniapps?search=${APPID}`))
  const target = listing.miniapps.find((row) => String(row.version) === '1')
  const body = expectOk(
    await call(`/miniapps/${target.id}/name`, { method: 'POST', body: { app_name: '自定义中文名' } }),
  )
  assert.equal(body.ok, true)
  assert.equal(body.miniapp.app_name, '自定义中文名')

  const refreshed = expectOk(await call(`/miniapps?search=${APPID}`))
  assert.ok(refreshed.miniapps.some((row) => row.id === target.id && row.app_name === '自定义中文名'))

  const tooLong = await call(`/miniapps/${target.id}/name`, {
    method: 'POST',
    body: { app_name: 'x'.repeat(200) },
  })
  assert.equal(tooLong.status, 400)
})

it('write fence: cross-site POST is rejected', async () => {
  const response = await server.request(api('/miniapps/scan'), {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    body: { customRoots: [] },
  })
  assert.equal(response.status, 403)
})
