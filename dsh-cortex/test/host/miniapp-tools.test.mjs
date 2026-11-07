/**
 * Agent-tool tests for the mini-program pipeline.
 *
 * Uses the real `createCortexToolDefinitions` registry (schema-v5 temp DB) and
 * synthetic wxapkg packages only; no real WeChat cache is touched.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, it } from 'node:test'
import { DatabaseHolder } from '../../src/host/db.js'
import { createCortexToolDefinitions } from '../../src/host/cortex/tools.js'
import { createTestDb, cleanupDir, makeTempDir } from './helpers.mjs'
import {
  isolateMiniappEnv,
  sampleFiles,
  writeFakePackage,
  writeUndecryptablePackage,
} from './miniapp-helpers.mjs'

const APPID = 'wxaaabbbcccdddeeff'
const APPID2 = 'wx1111222233334444'
const MINIAPP_TOOLS = [
  'cortex_scan_miniapps',
  'cortex_list_miniapps',
  'cortex_unpack_miniapp',
  'cortex_get_miniapp_overview',
  'cortex_read_miniapp_file',
  'cortex_search_miniapp',
  'cortex_import_miniapp_assets',
]

const tmp = makeTempDir()
const fakeRoot = join(tmp, 'xwechat-users')

let holder
let definitions
let tools
let mainDb

async function run(name, args = {}) {
  const tool = tools.get(name)
  assert.ok(tool, `tool ${name} is registered`)
  const result = await tool.execute(args)
  assert.equal(typeof result.text, 'string')
  return result.text
}

before(() => {
  isolateMiniappEnv(tmp, { roots: [fakeRoot] })
  writeFakePackage(fakeRoot, { appid: APPID, version: 2, files: sampleFiles({ marker: 'TOOL-MARKER' }) })
  writeFakePackage(fakeRoot, {
    appid: APPID,
    version: 3,
    encrypted: true,
    files: sampleFiles({ marker: 'TOOL-ENCRYPTED' }),
  })
  writeUndecryptablePackage(fakeRoot, { appid: APPID2, version: 9 })

  mainDb = createTestDb()
  holder = new DatabaseHolder({ dbPath: mainDb.dbPath })
  holder.ensure()
  definitions = createCortexToolDefinitions({ holder, config: { readOnly: false } })
  tools = new Map(definitions.map((definition) => [definition.name, definition]))
})

after(() => {
  try {
    holder.close()
  } catch {
    /* ignore */
  }
  cleanupDir(mainDb ? mainDb.dir : tmp)
  cleanupDir(tmp)
})

it('registers the seven miniapp tools alongside the existing Cortex tools', () => {
  for (const name of MINIAPP_TOOLS) {
    assert.ok(tools.has(name), `${name} is registered`)
  }
  assert.ok(definitions.length >= 22, `expected >= 22 tools, got ${definitions.length}`)
  for (const name of MINIAPP_TOOLS) {
    assert.ok(tools.get(name).description.length > 40, `${name} has a descriptive tool description`)
  }
})

it('cortex_scan_miniapps + cortex_list_miniapps report the detected packages', async () => {
  const scan = await run('cortex_scan_miniapps', {})
  assert.match(scan, /miniapp scan complete/)
  assert.match(scan, /sources=\d+/)
  assert.match(scan, new RegExp(APPID))

  const list = await run('cortex_list_miniapps', { search: APPID })
  assert.match(list, /miniapp sources/)
  assert.match(list, /versions=2/)
  assert.match(list, /v1mmwx/)
  assert.match(list, /测试健康商城/)
})

it('cortex_unpack_miniapp unpacks plaintext + V1MMWX and reports unsupported honestly', async () => {
  const plain = await run('cortex_unpack_miniapp', { appid: APPID, version: '2' })
  assert.match(plain, /unpacked/)
  assert.match(plain, /workspace:/)
  assert.match(plain, /files: [1-9]/)

  const encrypted = await run('cortex_unpack_miniapp', { appid: APPID, version: '3', force: true })
  assert.match(encrypted, /unpacked/)

  const unsupported = await run('cortex_unpack_miniapp', { appid: APPID2, version: '9' })
  assert.match(unsupported, /unsupported/)
  assert.match(unsupported, /reason:/)
  assert.doesNotMatch(unsupported, /unpacked [a-z]/)

  const missing = await run('cortex_unpack_miniapp', { appid: 'wxdeadbeefdeadbeef' })
  assert.match(missing, /failed/)
})

it('cortex_get_miniapp_overview returns a capped, secret-masked summary', async () => {
  const text = await run('cortex_get_miniapp_overview', { appid: APPID, version: '2' })
  assert.ok(text.length <= 8000, `overview ${text.length} chars exceeds 8000`)
  assert.match(text, /api\.demo-target\.test/)
  assert.match(text, /测试健康商城/)
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz/)

  const notUnpacked = await run('cortex_get_miniapp_overview', { appid: APPID2, version: '9' })
  assert.match(notUnpacked, /not unpacked/)
})

it('cortex_read_miniapp_file reads slices inside the workspace and rejects escapes/binaries', async () => {
  const text = await run('cortex_read_miniapp_file', {
    appid: APPID,
    version: '2',
    path: 'app-service.js',
    limit: 20,
  })
  assert.match(text, /TOOL-MARKER/)
  assert.match(text, /```/)

  const escape = await run('cortex_read_miniapp_file', {
    appid: APPID,
    version: '2',
    path: '../package.json',
  })
  assert.match(escape, /failed/)

  const absolute = await run('cortex_read_miniapp_file', {
    appid: APPID,
    version: '2',
    path: 'C:\\Windows\\win.ini',
  })
  assert.match(absolute, /failed/)

  const binary = await run('cortex_read_miniapp_file', {
    appid: APPID,
    version: '2',
    path: 'assets/logo.png',
  })
  assert.match(binary, /binary file/)
})

it('cortex_search_miniapp returns file:line matches and validates regex', async () => {
  const text = await run('cortex_search_miniapp', {
    appid: APPID,
    version: '2',
    query: 'TOOL-MARKER',
    maxResults: 10,
  })
  assert.match(text, /match\(es\)/)
  assert.match(text, /app-service\.js:\d+:/)

  const none = await run('cortex_search_miniapp', {
    appid: APPID,
    version: '2',
    query: 'no-such-token-xyz',
  })
  assert.match(none, /No match/)

  const bad = await run('cortex_search_miniapp', {
    appid: APPID,
    version: '2',
    query: '(',
    regex: true,
  })
  assert.match(bad, /failed/)
})

it('cortex_import_miniapp_assets persists canonical asset data and reports real counts', async () => {
  const text = await run('cortex_import_miniapp_assets', {
    appid: APPID,
    version: '2',
    host_port: 'https://mini.example-target.test/',
  })
  assert.match(text, /imported/)
  assert.match(text, /interfaces=\d+/)
  assert.match(text, /leaked_infos=\d+/)
  assert.match(text, /test_parameters=\d+/)
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz/)

  const row = holder.db.prepare('SELECT * FROM assets WHERE host_port = ?').get('https://mini.example-target.test/')
  assert.ok(row, 'asset row exists')
  assert.match(row.project_name, /小程序/)
  const interfaces = JSON.parse(row.interfaces)
  const leaks = JSON.parse(row.leaked_infos)
  const parameters = JSON.parse(row.test_parameters)
  assert.ok(interfaces.length >= 1)
  assert.ok(leaks.length >= 1)
  assert.ok(parameters.length >= 1)
  assert.ok(interfaces.every((entry) => typeof entry.path === 'string'))
  assert.ok(leaks.every((entry) => entry.source.startsWith('miniapp:')))

  const missing = await run('cortex_import_miniapp_assets', { appid: 'wxdeadbeefdeadbeef' })
  assert.match(missing, /failed/)
})
