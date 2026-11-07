// Unit tests for the unpacked mini-program analyzer (pages/domains/endpoints/
// secrets/parameters), masking and deterministic caps.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  OVERVIEW_LIMITS,
  analyzeUnpacked,
  buildOverviewText,
  deriveAppName,
  deriveAppNameFromUnpacked,
  extractAppNameFromPackage,
  loadOverview,
  maskSecret,
  saveOverview,
} from '../../src/host/miniapp/analyze.js'
import { ERROR_CODES, WxapkgError } from '../../src/host/miniapp/wxapkg.js'
import { buildEncryptedWxapkg, buildPlainWxapkg } from './miniapp-helpers.mjs'
import { writeFileSync as writeBytes } from 'node:fs'

const APPID = 'wxdabf06925a55f410'

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'
const OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456'
const AKID = 'AKIDabcdefghijklmnop'
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA1234567890abcdef-----END RSA PRIVATE KEY-----'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mini-analyze-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeTextFile(root, relative, content) {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

function buildFixture(t) {
  const root = tempDir(t)
  const appConfig = {
    pages: ['pages/index/index', 'pages/order/detail'],
    subPackages: [{ root: 'packageA', pages: ['pages/a/a'] }],
    tenantId: '10001',
    userId: 20002,
    appId: 'wx1234567890abcdef',
  }
  writeTextFile(root, 'app-config.json', JSON.stringify(appConfig, null, 2))
  const service = [
    'const base = "https://api.demo-target.test/v1";',
    'const noise = ["https://example.com/x", "https://www.w3.org/2000/svg"];',
    'wx.request({ url: "/api/user/list?tenantId=10001&page=1", method: "POST" });',
    'const order = "/api/order/detail?id=42";',
    'const userPath = "/api/user/{userId}/detail";',
    'const page = "/pages/index/index";',
    'const bundle = require("/utils/a.js");',
    `const cfg = { apiKey: "${OPENAI_KEY}", tenantId: "10001", userId: "20002" };`,
    `const placeholderKey = "${'YOUR_KEY_xxxxxxxxxxxx'}";`,
    `const jwt = "${JWT}";`,
    `const ak = "${AKID}";`,
    `const pem = "${PRIVATE_KEY}";`,
  ].join('\n')
  writeTextFile(root, 'app-service.js', service)
  writeTextFile(root, 'pages/index/index.js', 'Page({data:{title:"home"}})')
  writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
  return { root, appConfig, service }
}

test('analyzeUnpacked: pages, subpackages, domains, endpoints, secrets, parameters', (t) => {
  const { root, service } = buildFixture(t)
  const overview = analyzeUnpacked({ unpackedPath: root, appid: APPID, version: '135' })

  assert.equal(overview.appid, APPID)
  assert.equal(overview.version, '135')
  assert.match(overview.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(overview.pages, ['pages/index/index', 'pages/order/detail'])
  assert.equal(overview.subPackages.length, 1)
  assert.equal(overview.subPackages[0].root, 'packageA')
  assert.deepEqual(overview.subPackages[0].pages, ['pages/a/a'])

  assert.equal(overview.files.total, 4)
  assert.equal(overview.files.binary, 1)
  assert.equal(overview.files.text, 3)
  assert.ok(overview.files.bytes > 0)
  assert.ok(overview.byExtension.length > 0 && overview.byExtension.length <= 12)
  assert.equal(overview.byExtension[0].ext, '.js')

  const hosts = overview.domains.map((entry) => entry.host)
  assert.ok(hosts.includes('api.demo-target.test'))
  assert.equal(hosts.includes('example.com'), false)
  assert.equal(hosts.includes('www.w3.org'), false)
  assert.deepEqual(overview.domains[0].examples, ['https://api.demo-target.test'])

  const listCall = overview.endpoints.find((entry) => entry.path === '/api/user/list')
  assert.ok(listCall)
  assert.equal(listCall.method, 'POST')
  assert.ok(overview.endpoints.some((entry) => entry.path === '/api/order/detail'))
  // Module references are not HTTP endpoints (otherwise they flood big bundles).
  assert.equal(overview.endpoints.some((entry) => entry.path.startsWith('/pages/')), false)
  assert.equal(overview.endpoints.some((entry) => entry.path.endsWith('.js')), false)

  const byValue = (value) => overview.secrets.find((secret) => secret.value === value)
  const openai = byValue(OPENAI_KEY)
  assert.ok(openai)
  assert.equal(openai.info_type, 'API_Key')
  assert.equal(openai.value_masked, 'sk-a\u202656')
  assert.equal(openai.source, 'app-service.js')
  assert.equal(openai.line, service.split('\n').findIndex((line) => line.includes(OPENAI_KEY)) + 1)
  assert.ok(openai.potential_impact.length > 0)

  assert.equal(byValue(JWT).info_type, 'Token')
  assert.equal(byValue(AKID).info_type, 'API_Key')
  assert.equal(byValue(PRIVATE_KEY).info_type, 'Credential')
  assert.equal(byValue('YOUR_KEY_xxxxxxxxxxxx'), undefined)
  // The sk- pattern and the `apiKey:` assignment describe the same value.
  assert.equal(overview.secrets.filter((secret) => secret.value === OPENAI_KEY).length, 1)

  const tenantQuery = overview.parameters.find(
    (parameter) => parameter.name === 'tenantId' && parameter.location === 'query' && parameter.endpoint === '/api/user/list',
  )
  assert.ok(tenantQuery)
  assert.deepEqual(tenantQuery.values, ['10001'])
  const pathParam = overview.parameters.find(
    (parameter) => parameter.name === 'userId' && parameter.location === 'path',
  )
  assert.ok(pathParam)
  assert.equal(pathParam.endpoint, '/api/user/{userId}/detail')
  const configParam = overview.parameters.find(
    (parameter) => parameter.name === 'userId' && parameter.location === 'body' && parameter.endpoint === 'app-service.js',
  )
  assert.ok(configParam)
  assert.deepEqual(configParam.values, ['20002'])
  assert.ok(overview.parameters.some((parameter) => parameter.name === 'appId' && parameter.endpoint === 'app-config.json'))

  assert.ok(overview.largestFiles.length > 0)
  assert.ok(overview.largestFiles.length <= 10)
  assert.ok(overview.largestFiles[0].size >= overview.largestFiles[overview.largestFiles.length - 1].size)
})

test('maskSecret: first 4 + ellipsis + last 2, short values fully masked', () => {
  assert.equal(maskSecret('sk-abcdefghijklmnopqrstuvwxyz123456'), 'sk-a\u202656')
  assert.equal(maskSecret('12345678'), '***')
  assert.equal(maskSecret(''), '***')
})

test('analyzeUnpacked: deterministic caps are enforced', (t) => {
  const root = tempDir(t)
  const pages = Array.from({ length: 600 }, (_, index) => `pages/p${index}/index`)
  writeTextFile(root, 'app-config.json', JSON.stringify({ pages }))
  const lines = []
  for (let index = 0; index < 250; index += 1) lines.push(`const d${index} = "https://cap${index}.demo.test/x";`)
  for (let index = 0; index < 350; index += 1) lines.push(`const e${index} = "/api/cap/${index}/endpoint";`)
  for (let index = 0; index < 150; index += 1) {
    lines.push(`const k${index} = "AKID${index.toString(36).padStart(4, '0')}abcdefghij";`)
  }
  for (let index = 0; index < 150; index += 1) {
    lines.push(`const p${index} = "/api/param/${index}?tenant${index}=1000${index}";`)
  }
  writeTextFile(root, 'app-service.js', lines.join('\n'))

  const overview = analyzeUnpacked({ unpackedPath: root, appid: APPID, version: '135' })
  assert.equal(overview.pages.length, OVERVIEW_LIMITS.pages)
  assert.equal(overview.domains.length, OVERVIEW_LIMITS.domains)
  assert.equal(overview.endpoints.length, OVERVIEW_LIMITS.endpoints)
  assert.equal(overview.secrets.length, OVERVIEW_LIMITS.secrets)
  assert.equal(overview.parameters.length, OVERVIEW_LIMITS.parameters)
  assert.ok(overview.warnings.some((warning) => /pages truncated/.test(warning)))
  assert.ok(overview.warnings.some((warning) => /domains truncated/.test(warning)))
  assert.ok(overview.warnings.some((warning) => /endpoints truncated/.test(warning)))
  assert.ok(overview.warnings.some((warning) => /secrets truncated/.test(warning)))
  assert.ok(overview.warnings.some((warning) => /parameters truncated/.test(warning)))
})

test('buildOverviewText: capped, readable and never prints full secrets', (t) => {
  const { root } = buildFixture(t)
  const overview = analyzeUnpacked({ unpackedPath: root, appid: APPID, version: '135' })
  const text = buildOverviewText(overview)
  assert.equal(typeof text, 'string')
  assert.ok(text.length <= 8000)
  assert.ok(text.includes(APPID))
  assert.ok(text.includes('/api/user/list'))
  assert.ok(text.includes('sk-a\u202656'))
  assert.equal(text.includes(OPENAI_KEY), false)
  assert.equal(text.includes(JWT), false)
  assert.equal(text.includes(AKID), false)

  const tiny = buildOverviewText(overview, { maxChars: 300 })
  assert.ok(tiny.length <= 300)
  assert.ok(tiny.includes('truncated'))
})

test('saveOverview/loadOverview: overview.json masked, extracted.json keeps full values', (t) => {
  const { root } = buildFixture(t)
  const overview = analyzeUnpacked({ unpackedPath: root, appid: APPID, version: '135' })
  saveOverview(root, overview)

  assert.equal(existsSync(join(root, 'overview.json')), true)
  assert.equal(existsSync(join(root, 'extracted.json')), true)
  const maskedRaw = readFileSync(join(root, 'overview.json'), 'utf8')
  const extractedRaw = readFileSync(join(root, 'extracted.json'), 'utf8')
  assert.equal(maskedRaw.includes(OPENAI_KEY), false)
  assert.equal(maskedRaw.includes('"value"'), false)
  assert.ok(maskedRaw.includes('value_masked'))
  assert.equal(extractedRaw.includes(OPENAI_KEY), true)

  const extracted = JSON.parse(extractedRaw)
  assert.ok(extracted.secrets.some((secret) => secret.value === OPENAI_KEY && secret.info_type === 'API_Key'))
  assert.ok(extracted.parameters.length > 0)
  assert.ok(extracted.endpoints.length > 0)

  const loaded = loadOverview(root)
  assert.ok(loaded)
  assert.equal(loaded.appid, APPID)
  assert.ok(Array.isArray(loaded.secrets))
  assert.ok(loaded.secrets.length > 0)
  assert.ok(loaded.secrets.every((secret) => !Object.hasOwn(secret, 'value')))
  assert.ok(loaded.secrets.every((secret) => typeof secret.value_masked === 'string'))
  assert.equal(loadOverview(join(root, 'missing-dir')), null)
})

test('analyzeUnpacked: missing workspace throws INVALID_PATH', () => {
  assert.throws(
    () => analyzeUnpacked({ unpackedPath: join(tmpdir(), 'mini-analyze-does-not-exist'), appid: APPID }),
    (error) => error instanceof WxapkgError && error.code === ERROR_CODES.INVALID_PATH,
  )
})


test('deriveAppName: projectname wins, otherwise entry-page Chinese title', (t) => {
  const root = tempDir(t)
  const appConfig = {
    entryPagePath: 'pages/index/index.html',
    pages: ['pages/index/index', 'pages/order/detail'],
    global: { window: { navigationBarTitleText: '首页' } },
    page: {
      'pages/index/index.html': { window: { navigationBarTitleText: '平安健康商城' } },
      'pages/order/detail.html': { window: { navigationBarTitleText: '订单详情' } },
    },
  }
  const name = deriveAppName({ appConfig })
  assert.equal(name.appName, '平安健康商城')
  assert.equal(name.appNameSource, 'page-title')

  const withProject = deriveAppName({ appConfig, projectConfig: { projectname: '开发者工具项目名' } })
  assert.equal(withProject.appName, '开发者工具项目名')
  assert.equal(withProject.appNameSource, 'project.config.json')

  const encoded = deriveAppName({
    projectConfig: { projectname: '%E5%BF%83%E5%8A%A8%E5%A5%B3%E5%8F%8B' },
  })
  assert.equal(encoded.appName, '心动女友')

  // Only generic navigation labels -> no guessed name.
  const generic = deriveAppName({
    appConfig: {
      page: {
        'pages/index/index.html': { window: { navigationBarTitleText: '首页' } },
        'pages/order/detail.html': { window: { navigationBarTitleText: '订单详情' } },
      },
    },
  })
  assert.equal(generic.appName, '')

  writeFileSync(join(root, 'app-config.json'), JSON.stringify(appConfig))
  assert.equal(deriveAppNameFromUnpacked(root).appName, '平安健康商城')
  const overview = analyzeUnpacked({ unpackedPath: root, appid: APPID, version: '1' })
  assert.equal(overview.appName, '平安健康商城')
  assert.match(buildOverviewText(overview), /平安健康商城/)
})

test('extractAppNameFromPackage reads app-config from plain and encrypted packages', (t) => {
  const root = tempDir(t)
  const files = [
    {
      name: '/app-config.json',
      content: JSON.stringify({
        page: { 'pages/index/index.html': { window: { navigationBarTitleText: '包内中文名' } } },
      }),
    },
    { name: '/app-service.js', content: 'const a=1;' },
  ]
  for (const [fileName, encrypted] of [
    ['plain.wxapkg', false],
    ['encrypted.wxapkg', true],
  ]) {
    const buffer = encrypted
      ? buildEncryptedWxapkg(files, APPID)
      : buildPlainWxapkg(files)
    const filePath = join(root, fileName)
    writeBytes(filePath, buffer)
    const result = extractAppNameFromPackage(filePath, APPID)
    assert.equal(result.appName, '包内中文名', fileName)
  }
})

