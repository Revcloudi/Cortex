/**
 * Static analysis of an unpacked mini-program tree.
 *
 * Everything here is read-only over the already-unpacked workspace: no network,
 * no execution of extracted JavaScript, no access to the original WeChat cache.
 * The analyzer extracts small, high-signal intelligence for the Cortex asset
 * library:
 *
 *   - pages / subpackages from `app-config.json`,
 *   - business domains and API endpoint candidates from text files,
 *   - hard-coded secrets (masked in every summary / persisted masked overview),
 *   - authz-test parameter candidates (query / path / config values).
 *
 * `analyzeUnpacked` keeps full secret values in the returned object so the
 * local asset importer can persist them. `saveOverview` writes `overview.json`
 * with masked values only plus `extracted.json` with the full values.
 */

import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { ERROR_CODES, WxapkgError, readPackage } from './wxapkg.js'

/** Deterministic caps for one overview. */
export const OVERVIEW_LIMITS = Object.freeze({
  domains: 200,
  endpoints: 300,
  secrets: 100,
  parameters: 100,
  pages: 500,
})

const BINARY_PROBE_BYTES = 8 * 1024
const MAX_ANALYZE_FILE_BYTES = 16 * 1024 * 1024
const MAX_LISTED_FILES = 5
const MAX_DOMAIN_EXAMPLES = 3
const MAX_CONFIG_DEPTH = 8
const MAX_TEXT_INSIGHT_WARNINGS = 20

/* ------------------------------------------------------------------------- */
/* Display name extraction                                                   */
/* ------------------------------------------------------------------------- */

/** Generic page titles that are navigation labels, not the mini-program name. */
const GENERIC_TITLES = new Set([
  '首页',
  '我的',
  '分类',
  '购物车',
  '订单',
  '搜索',
  '详情',
  '活动',
  '登录',
  '注册',
  '预约',
  '立即预约',
  '提交订单',
  '商品详情',
  '订单详情',
  '我的订单',
  '个人中心',
  '会员中心',
  '设置',
  '消息',
  '通知',
  '列表',
  '更多',
  '加载中',
  '暂无数据',
  '我的积分',
  '积分商城',
  '会员注册',
  '会员信息',
  '我的权益',
  '商品评价',
  '评价中心',
  '免费领券',
  '运动打卡',
  '景点',
  '景点预约',
  '确认信息',
  '预约登记',
  '医生列表',
  '报告查询',
  '报告信息',
  '健康档案',
  '选择服务',
  '访客管理',
  '邀请函',
  '同行人',
  '提货码',
  '物流查询',
  '我的佣金',
  '积分分配',
  '失物招领',
  '礼品卡',
  '扫码积分',
  '拍照积分',
  '缴费记录',
  '企业客户预约',
  '预约详情',
  '畅享卡',
  '扫码领券',
  '分销商品',
  '分类',
  '活动',
  '首页',
])

const TITLE_CJK_RE = /[\u3400-\u9fff]/

function cleanName(value) {
  if (typeof value !== 'string') return ''
  let name = value
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’《》\s]+|["'“”‘’《》\s]+$/g, '')
    .trim()
  // Devtools project names are often percent-encoded in project.private.config.json.
  if (/%[0-9A-Fa-f]{2}/.test(name)) {
    try {
      name = decodeURIComponent(name).replace(/\s+/g, ' ').trim()
    } catch {
      /* keep the raw value */
    }
  }
  if (name.length < 2 || name.length > 32) return ''
  if (/^(?:https?:\/\/|\d{4,}|undefined|null|true|false|none|todo|示例|测试)$/i.test(name)) return ''
  if (GENERIC_TITLES.has(name)) return ''
  if (!TITLE_CJK_RE.test(name) && !/^[A-Za-z][A-Za-z0-9 ._-]{1,31}$/.test(name)) return ''
  return name
}

function collectTitleCandidates(config, displaySource, acc) {
  if (!config || typeof config !== 'object') return
  const subRoots = Array.isArray(config.subPackages)
    ? config.subPackages
    : Array.isArray(config.subpackages)
      ? config.subpackages
      : []
  const subRootsList = subRoots
    .map((entry) => (entry && typeof entry.root === 'string' ? entry.root.replace(/\/$/, '') : ''))
    .filter((entry) => entry.length > 0)
  const entryPagePath =
    typeof config.entryPagePath === 'string' ? config.entryPagePath.replace(/\.html$/, '') : ''

  const globalTitle = config.global && config.global.window && config.global.window.navigationBarTitleText
  if (typeof globalTitle === 'string' && cleanName(globalTitle)) {
    acc.push({ title: globalTitle, weight: 3, source: displaySource })
  }

  const pageMap = config.page && typeof config.page === 'object' ? config.page : null
  if (!pageMap) return
  const entries = Object.entries(pageMap)
  for (let index = 0; index < entries.length; index += 1) {
    const [pagePath, pageConfig] = entries[index]
    const title = pageConfig && pageConfig.window && pageConfig.window.navigationBarTitleText
    if (typeof title !== 'string' || cleanName(title).length === 0) continue
    const normalizedPage = String(pagePath).replace(/\.html$/, '')
    const inSubPackage = subRootsList.some((root) => normalizedPage.startsWith(`${root}/`))
    let weight = inSubPackage ? 1 : 3
    if (index < 20) weight += 1
    if (normalizedPage.endsWith('/index') || normalizedPage.endsWith('/index/index')) weight += 1
    if (entryPagePath && normalizedPage === entryPagePath) weight += 4
    acc.push({ title, weight, source: displaySource })
  }
}

/**
 * Derive a human display name from package config files. Official app names are
 * not stored in the WeChat cache in plaintext, so this is a best-effort
 * extraction from `project.config.json` / app config / page titles, with a
 * stable heuristic that prefers the entry page and main-package titles.
 */
export function deriveAppName({ appConfig = null, projectConfig = null, pluginConfig = null } = {}) {
  const directCandidates = [
    ['project.config.json', projectConfig && (projectConfig.projectname || projectConfig.projectName || projectConfig.name)],
    ['app-config.json', appConfig && (appConfig.name || appConfig.appName || appConfig.nickname || appConfig.brandName || appConfig.shopName || appConfig.mallName)],
    ['plugin.json', pluginConfig && (pluginConfig.name || pluginConfig.pluginName)],
  ]
  for (const [source, value] of directCandidates) {
    const name = cleanName(value)
    if (name) return { appName: name, appNameSource: source }
  }

  const candidates = []
  collectTitleCandidates(appConfig, 'app-config.json', candidates)
  collectTitleCandidates(pluginConfig, 'plugin.json', candidates)
  if (candidates.length === 0) return { appName: '', appNameSource: '' }

  const scores = new Map()
  for (const candidate of candidates) {
    const name = cleanName(candidate.title)
    if (!name) continue
    const current = scores.get(name) || { name, score: 0, hits: 0 }
    current.score += candidate.weight
    current.hits += 1
    scores.set(name, current)
  }
  const ranked = [...scores.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (right.hits !== left.hits) return right.hits - left.hits
    return left.name.length - right.name.length
  })
  if (ranked.length === 0) return { appName: '', appNameSource: '' }
  return { appName: ranked[0].name, appNameSource: 'page-title' }
}

function readJsonFileQuiet(filePath, maxBytes = 2 * 1024 * 1024) {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size > maxBytes) return null
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Derive the display name from an already unpacked workspace (fast, no scan). */
export function deriveAppNameFromUnpacked(unpackedPath) {
  if (typeof unpackedPath !== 'string' || unpackedPath.length === 0) return { appName: '', appNameSource: '' }
  const root = resolve(unpackedPath)
  return deriveAppName({
    appConfig: readJsonFileQuiet(join(root, 'app-config.json')) || readJsonFileQuiet(join(root, 'app.json')),
    projectConfig:
      readJsonFileQuiet(join(root, 'project.config.json')) || readJsonFileQuiet(join(root, 'project.private.config.json')),
    pluginConfig: readJsonFileQuiet(join(root, 'plugin.json')),
  })
}

/**
 * Derive the display name from one encrypted/plain wxapkg file. Used by the
 * scan phase (one package per app) so the list can show a Chinese name before
 * the user unpacks anything.
 */
export function extractAppNameFromPackage(filePath, appid) {
  try {
    const parsed = readPackage(filePath, { appid })
    const findEntry = (fileName) => {
      const exact = parsed.files.find((entry) => entry.name === `/${fileName}`)
      if (exact) return exact
      return parsed.files.find((entry) => entry.name.endsWith(`/${fileName}`))
    }
    const readEntryJson = (fileName) => {
      const entry = findEntry(fileName)
      if (!entry || entry.size > 2 * 1024 * 1024) return null
      try {
        const parsedJson = JSON.parse(
          parsed.buffer.subarray(entry.offset, entry.offset + entry.size).toString('utf8'),
        )
        return parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson) ? parsedJson : null
      } catch {
        return null
      }
    }
    return deriveAppName({
      appConfig: readEntryJson('app-config.json') || readEntryJson('app.json'),
      projectConfig: readEntryJson('project.config.json') || readEntryJson('project.private.config.json'),
      pluginConfig: readEntryJson('plugin.json'),
    })
  } catch {
    return { appName: '', appNameSource: '' }
  }
}

/** Workspace metadata files are counted but not mined (they echo file paths). */
const ANALYSIS_METADATA_FILES = new Set(['manifest.json', 'overview.json', 'extracted.json'])

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']
const NOISE_DOMAINS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'w3.org',
  'www.w3.org',
  'w3c.org',
  'www.w3c.org',
  'schema.org',
  'www.schema.org',
  'example.com',
  'www.example.com',
])
const NOISE_DOMAIN_SUFFIXES = ['.w3.org', '.w3c.org', '.schema.org', '.example.com']
const STATIC_ASSET_RE = /\.(?:js|json|wxml|wxss|wxs|html?|css|png|jpe?g|gif|svg|webp|ico|bmp|ttf|otf|woff2?|eot|mp[34]|wav|amr|map)$/i
/**
 * References to bundled page/component/plugin modules (`"/pages/index/index"`,
 * `"/./components/x/x"`) are not HTTP endpoints; keeping them would drown the
 * real API candidates on large packages.
 */
const MODULE_REFERENCE_RE = /^\/(?:pages|components|__plugin__|miniprogram_npm)\/|^\/\.\//
const DOMAIN_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi
const ENDPOINT_RE = /["'](\/[a-zA-Z0-9_\-./{}:]+(?:\?[^"']*)?)["']/g
const QUERY_PAIR_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,60}$/
const PARAM_KEY_RE = /(tenant|user|order|member|card|shop|store|org|account|id)$/i
const SECRET_KEY_RE = /(secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key|private[_-]?key)$/i
const PATH_PLACEHOLDER_RE = /^(?:\{([^{}]+)\}|:([A-Za-z_][A-Za-z0-9_]*))$/

const SECRET_PATTERNS = [
  {
    re: /AKID[0-9A-Za-z]{13,}/g,
    name: 'tencent_akid',
    info_type: 'API_Key',
    potential_impact: '腾讯云 API 密钥泄露，可能被用于调用云资源或读取数据',
  },
  {
    re: /sk-[A-Za-z0-9]{20,}/g,
    name: 'openai_api_key',
    info_type: 'API_Key',
    potential_impact: '第三方模型 API Key 泄露，可能被滥用并产生费用',
  },
  {
    re: /ghp_[A-Za-z0-9]{20,}/g,
    name: 'github_token',
    info_type: 'Token',
    potential_impact: 'GitHub Token 泄露，可能访问仓库或流水线',
  },
  {
    re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
    name: 'jwt',
    info_type: 'Token',
    potential_impact: 'JWT 泄露，可能被重放或用于伪造会话',
  },
]
const ASSIGNMENT_RE =
  /(api[_-]?key|secret|token|app[_-]?secret|access[_-]?key)\s*[:=]\s*['"]([^'"]{8,120})['"]/gi
/** Reject minified-code fragments such as `).concat(d,` captured by ASSIGNMENT_RE. */
const ASSIGNMENT_VALUE_RE = /^[A-Za-z0-9_\-.\/+=:@]{8,120}$/
/** Full PEM block; multi-line scan runs at content level (bare headers are noise). */
const PEM_KEY_RE =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{20,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
/** `tenantId:"10001"` / `userId: 42` style config samples in JS/config text. */
const CONFIG_ASSIGNMENT_RE =
  /(?:^|[{,;\s])["']?([A-Za-z_$][\w$]{0,60})["']?\s*[:=]\s*(?:"([^"\r\n]{1,120})"|'([^'\r\n]{1,120})'|(\d{1,12}))\s*(?=[,;}\s]|$)/gm

function readPrefix(filePath, bytes) {
  if (bytes <= 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(bytes)
  const fd = openSync(filePath, 'r')
  try {
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function splitLines(text) {
  if (text.length === 0) return []
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

const toPosix = (value) => String(value).split('\\').join('/')

function walkFiles(rootPath) {
  const files = []
  const stack = [{ dir: rootPath, rel: '' }]
  while (stack.length > 0) {
    const current = stack.pop()
    let dirents
    try {
      dirents = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue
      const absolute = join(current.dir, dirent.name)
      const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        stack.push({ dir: absolute, rel })
        continue
      }
      if (!dirent.isFile()) continue
      let size = 0
      try {
        size = statSync(absolute).size
      } catch {
        size = 0
      }
      files.push({ path: rel, abs: absolute, size })
    }
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return files
}

export function maskSecret(value) {
  const text = typeof value === 'string' ? value : String(value === undefined || value === null ? '' : value)
  if (text.length <= 8) return '***'
  return `${text.slice(0, 4)}\u2026${text.slice(-2)}`
}

function isPlaceholder(value) {
  const text = String(value || '').trim()
  if (text.length === 0) return true
  const lower = text.toLowerCase()
  if (lower.length < 8) return true
  if (/^(?:undefined|null|true|false|changeme|password|secret|example|sample|placeholder|todo|none)$/i.test(lower)) {
    return true
  }
  if (/(?:your[_ -]?(?:key|secret|token|appid)|placeholder|example|xxxxx|xxx-xxx)/i.test(lower)) return true
  if (/^<.*>$/.test(lower) || /^\*.+$/.test(lower)) return true
  if (/^(.)\1{6,}$/.test(lower)) return true // 'aaaaaaaa', '00000000'
  if (new Set(lower).size <= 2) return true
  return false
}

function infoTypeForKey(key) {
  const lower = String(key || '').toLowerCase()
  if (lower.includes('token')) return 'Token'
  if (lower.includes('secret') || lower.includes('password') || lower.includes('passwd') || lower.includes('pwd')) {
    return 'Credential'
  }
  if (lower.includes('key')) return 'API_Key'
  return 'Other'
}

function isNoiseDomain(host) {
  const lower = String(host || '').toLowerCase()
  if (NOISE_DOMAINS.has(lower)) return true
  if (/^127\./.test(lower) || /^10\./.test(lower) || /^192\.168\./.test(lower)) return true
  if (NOISE_DOMAIN_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  return false
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '))
  } catch {
    return String(value)
  }
}

function isSampleValue(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) return ''
    const text = String(value)
    return text.length <= 12 ? text : ''
  }
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (/^\d{1,12}$/.test(text)) return text
  if (/^wx[0-9a-z]{8,}$/i.test(text)) return text
  return ''
}

function addParameter(map, { name, endpoint, location, value, source }) {
  const paramName = String(name || '').trim()
  if (paramName.length === 0 || paramName.length > 80) return
  const targetEndpoint = String(endpoint || '').trim()
  const targetLocation = String(location || 'query')
  const key = `${paramName}\u0000${targetEndpoint}\u0000${targetLocation}`
  let entry = map.get(key)
  if (!entry) {
    entry = { name: paramName, endpoint: targetEndpoint, location: targetLocation, values: [], source: String(source || '') }
    map.set(key, entry)
  }
  if (value === undefined || value === null) return
  const text = String(value).trim()
  if (text.length === 0 || text.length > 120) return
  if (entry.values.length >= 5 || entry.values.includes(text)) return
  entry.values.push(text)
}

function configParameters(config, sourceName, map) {
  const visit = (value, depth) => {
    if (depth > MAX_CONFIG_DEPTH || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (child !== null && typeof child === 'object') {
        visit(child, depth + 1)
        continue
      }
      if (!PARAM_KEY_RE.test(key) || SECRET_KEY_RE.test(key)) continue
      const sample = isSampleValue(child)
      if (sample.length === 0) continue
      addParameter(map, { name: key, endpoint: sourceName, location: 'body', value: sample, source: sourceName })
    }
  }
  visit(config, 0)
}

function scanConfigAssignments(content, sourceName, parameterMap) {
  CONFIG_ASSIGNMENT_RE.lastIndex = 0
  let match
  while ((match = CONFIG_ASSIGNMENT_RE.exec(content)) !== null) {
    const key = match[1]
    if (!key || !PARAM_KEY_RE.test(key) || SECRET_KEY_RE.test(key)) continue
    const rawValue = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4]
    const sample = isSampleValue(rawValue)
    if (sample.length === 0) continue
    addParameter(parameterMap, {
      name: key,
      endpoint: sourceName,
      location: 'body',
      value: sample,
      source: sourceName,
    })
  }
}

function nearbyMethod(content, endIndex) {
  const window = content.slice(endIndex, Math.min(content.length, endIndex + 120))
  const match = /method\s*[:=]\s*['"]([A-Za-z]{3,7})['"]/i.exec(window)
  if (!match) return ''
  const method = match[1].toUpperCase()
  return HTTP_METHODS.includes(method) ? method : ''
}

/**
 * Analyze one unpacked mini-program workspace.
 *
 * @param {{unpackedPath:string, appid?:string, version?:string, manifest?:object|null}} input
 * @returns {object} Overview (see contract §3.6)
 */
export function analyzeUnpacked({ unpackedPath, appid = '', version = '', manifest = null } = {}) {
  const rootPath = typeof unpackedPath === 'string' && unpackedPath.trim().length > 0 ? resolve(unpackedPath) : ''
  if (!rootPath) throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'unpackedPath is required')
  let rootStats
  try {
    rootStats = lstatSync(rootPath)
  } catch {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, `unpacked directory does not exist: ${rootPath}`)
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'unpacked path is not a directory')
  }

  const warnings = []
  const files = walkFiles(rootPath)
  const extensionMap = new Map()
  const domainMap = new Map()
  const endpointMap = new Map()
  const parameterMap = new Map()
  const secrets = []
  const secretKeys = new Set()

  let totalBytes = 0
  let textCount = 0
  let binaryCount = 0
  let partialTextFiles = 0
  let truncatedSecrets = false
  let appConfig = null
  let appConfigName = ''
  let projectConfig = null
  let pluginConfig = null

  const rememberDomain = (host, url, sourceFile) => {
    const lower = String(host || '').toLowerCase()
    if (!lower || isNoiseDomain(lower)) return
    let entry = domainMap.get(lower)
    if (!entry) {
      entry = { host: lower, count: 0, examples: [], files: [] }
      domainMap.set(lower, entry)
    }
    entry.count += 1
    if (url && entry.examples.length < MAX_DOMAIN_EXAMPLES && !entry.examples.includes(url)) {
      entry.examples.push(url.length > 300 ? url.slice(0, 300) : url)
    }
    if (entry.files.length < MAX_LISTED_FILES && !entry.files.includes(sourceFile)) entry.files.push(sourceFile)
  }

  const rememberEndpoint = (path, method, sourceFile) => {
    const key = `${method || ''}\u0000${path}`
    let entry = endpointMap.get(key)
    if (!entry) {
      entry = { path, count: 0, files: [] }
      if (method) entry.method = method
      endpointMap.set(key, entry)
    }
    entry.count += 1
    if (entry.files.length < MAX_LISTED_FILES && !entry.files.includes(sourceFile)) entry.files.push(sourceFile)
  }

  const rememberSecret = (infoType, name, value, sourceFile, line) => {
    if (secrets.length >= OVERVIEW_LIMITS.secrets) {
      truncatedSecrets = true
      return
    }
    if (isPlaceholder(value)) return
    const dedupeKey = `${infoType}\u0000${value}\u0000${sourceFile}\u0000${line}`
    if (secretKeys.has(dedupeKey)) return
    secretKeys.add(dedupeKey)
    secrets.push({
      info_type: infoType,
      name,
      value_masked: maskSecret(value),
      value,
      source: sourceFile,
      line: Number.isFinite(Number(line)) ? Math.trunc(Number(line)) : 0,
      potential_impact:
        infoType === 'Token'
          ? '令牌泄露，可能被重放或用于伪造会话'
          : infoType === 'API_Key'
            ? 'API 密钥泄露，可能被用于调用后端或云服务'
            : infoType === 'Credential'
              ? '凭据/私钥泄露，可能导致未授权访问'
              : '硬编码敏感信息泄露',
    })
  }

  const scanSecrets = (content, sourceFile) => {
    const lines = splitLines(content)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      for (const pattern of SECRET_PATTERNS) {
        pattern.re.lastIndex = 0
        let match
        while ((match = pattern.re.exec(line)) !== null) {
          rememberSecret(pattern.info_type, pattern.name, match[0], sourceFile, index + 1)
        }
      }
      ASSIGNMENT_RE.lastIndex = 0
      let assignment
      while ((assignment = ASSIGNMENT_RE.exec(line)) !== null) {
        if (!ASSIGNMENT_VALUE_RE.test(assignment[2])) continue
        rememberSecret(infoTypeForKey(assignment[1]), assignment[1].toLowerCase(), assignment[2], sourceFile, index + 1)
      }
    }
    // A real embedded private key may span lines; scan the whole content once.
    // Bare headers and code fragments that merely mention the markers are not
    // secrets: the body must look like PEM base64.
    PEM_KEY_RE.lastIndex = 0
    let pem
    while ((pem = PEM_KEY_RE.exec(content)) !== null) {
      const bodyMatch = /^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----([\s\S]*?)-----END /.exec(pem[0])
      const body = bodyMatch ? bodyMatch[1] : ''
      if (!/^(?:[A-Za-z0-9+/=]|\\[nr]|\s)+$/.test(body)) continue
      const line = content.slice(0, pem.index).split('\n').length
      rememberSecret('Credential', 'private_key', pem[0].slice(0, 4096), sourceFile, line)
    }
  }

  const scanEndpoints = (content, sourceFile) => {
    ENDPOINT_RE.lastIndex = 0
    let match
    while ((match = ENDPOINT_RE.exec(content)) !== null) {
      const raw = match[1]
      const queryIndex = raw.indexOf('?')
      const rawPath = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw
      const query = queryIndex >= 0 ? raw.slice(queryIndex + 1) : ''
      if (!rawPath.startsWith('/')) continue
      const segments = rawPath.split('/').filter(Boolean)
      const startsWithApiRoot = /^\/(?:api|wx|miniapp|mp)(?:\/|$)/.test(rawPath)
      if (segments.length < 2 && !startsWithApiRoot) continue
      if (STATIC_ASSET_RE.test(rawPath) || MODULE_REFERENCE_RE.test(rawPath)) continue
      const method = nearbyMethod(content, match.index + match[0].length)
      rememberEndpoint(rawPath, method, sourceFile)

      if (query.length > 0) {
        for (const pair of query.split('&')) {
          const equals = pair.indexOf('=')
          const rawName = equals >= 0 ? pair.slice(0, equals) : pair
          const rawValue = equals >= 0 ? pair.slice(equals + 1) : ''
          const name = decodeSafe(rawName).trim()
          if (!QUERY_PAIR_RE.test(name) || SECRET_KEY_RE.test(name)) continue
          addParameter(parameterMap, {
            name,
            endpoint: rawPath,
            location: 'query',
            value: rawValue.length > 0 ? decodeSafe(rawValue).trim() : undefined,
            source: sourceFile,
          })
        }
      }

      for (const segment of segments) {
        const placeholder = PATH_PLACEHOLDER_RE.exec(segment)
        if (!placeholder) continue
        const name = (placeholder[1] || placeholder[2] || '').trim()
        if (name.length === 0 || SECRET_KEY_RE.test(name)) continue
        addParameter(parameterMap, { name, endpoint: rawPath, location: 'path', source: sourceFile })
      }
    }
  }

  for (const file of files) {
    totalBytes += file.size
    const extension = extname(file.path).toLowerCase() || '(none)'
    let extensionEntry = extensionMap.get(extension)
    if (!extensionEntry) {
      extensionEntry = { ext: extension, count: 0, bytes: 0 }
      extensionMap.set(extension, extensionEntry)
    }
    extensionEntry.count += 1
    extensionEntry.bytes += file.size

    let probe
    try {
      probe = readPrefix(file.abs, Math.min(file.size, BINARY_PROBE_BYTES))
    } catch {
      continue
    }
    if (probe.includes(0)) {
      binaryCount += 1
      continue
    }
    textCount += 1

    if (ANALYSIS_METADATA_FILES.has(file.path)) continue

    let content
    try {
      const readBytes = Math.min(file.size, MAX_ANALYZE_FILE_BYTES)
      if (file.size > MAX_ANALYZE_FILE_BYTES) partialTextFiles += 1
      content = readPrefix(file.abs, readBytes).toString('utf8')
    } catch {
      continue
    }

    if (file.path === 'app-config.json' || file.path === 'app.json') {
      try {
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (!appConfig) {
            appConfig = parsed
            appConfigName = file.path
          }
          configParameters(parsed, file.path, parameterMap)
        }
      } catch (error) {
        warnings.push(`could not parse ${file.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (
      (file.path === 'project.config.json' || file.path === 'project.private.config.json') &&
      projectConfig === null
    ) {
      try {
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) projectConfig = parsed
      } catch {
        /* optional metadata */
      }
    }
    if (file.path === 'plugin.json' && pluginConfig === null) {
      try {
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) pluginConfig = parsed
      } catch {
        /* optional metadata */
      }
    }

    DOMAIN_RE.lastIndex = 0
    let domainMatch
    while ((domainMatch = DOMAIN_RE.exec(content)) !== null) {
      rememberDomain(domainMatch[1], domainMatch[0], file.path)
    }

    scanEndpoints(content, file.path)
    scanSecrets(content, file.path)
    scanConfigAssignments(content, file.path, parameterMap)
  }

  if (partialTextFiles > 0) {
    warnings.push(`${Math.min(partialTextFiles, MAX_TEXT_INSIGHT_WARNINGS)} large text file(s) were only partially analyzed (${formatBytes(MAX_ANALYZE_FILE_BYTES)} cap)`)
  }

  /* ------------------------------ pages ------------------------------ */
  let pages = []
  let subPackages = []
  if (appConfig) {
    const rawPages = Array.isArray(appConfig.pages) ? appConfig.pages : []
    pages = rawPages.filter((page) => typeof page === 'string' && page.trim().length > 0).map((page) => page.trim())
    if (pages.length > OVERVIEW_LIMITS.pages) {
      warnings.push(`pages truncated at ${OVERVIEW_LIMITS.pages}`)
      pages = pages.slice(0, OVERVIEW_LIMITS.pages)
    }
    const rawSubPackages = Array.isArray(appConfig.subPackages)
      ? appConfig.subPackages
      : Array.isArray(appConfig.subpackages)
        ? appConfig.subpackages
        : []
    subPackages = []
    for (const item of rawSubPackages.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue
      const root = typeof item.root === 'string' ? item.root.trim() : ''
      const raw = Array.isArray(item.pages) ? item.pages : []
      const subPages = raw.filter((page) => typeof page === 'string' && page.trim().length > 0).map((page) => page.trim())
      if (root.length === 0 && subPages.length === 0) continue
      subPackages.push({ root, pages: subPages.slice(0, OVERVIEW_LIMITS.pages) })
    }
  } else {
    warnings.push('app-config.json was not found; pages/subPackages are empty')
  }

  /* ------------------------------ domains ------------------------------ */
  const sortedDomains = [...domainMap.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count
    return left.host < right.host ? -1 : left.host > right.host ? 1 : 0
  })
  if (sortedDomains.length > OVERVIEW_LIMITS.domains) {
    warnings.push(`domains truncated at ${OVERVIEW_LIMITS.domains}`)
  }
  const domains = sortedDomains.slice(0, OVERVIEW_LIMITS.domains).map((entry) => ({
    host: entry.host,
    count: entry.count,
    examples: entry.examples.slice(),
    files: entry.files.slice(),
  }))

  /* ----------------------------- endpoints ----------------------------- */
  const sortedEndpoints = [...endpointMap.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    return String(left.method || '') < String(right.method || '') ? -1 : 1
  })
  if (sortedEndpoints.length > OVERVIEW_LIMITS.endpoints) {
    warnings.push(`endpoints truncated at ${OVERVIEW_LIMITS.endpoints}`)
  }
  const endpoints = sortedEndpoints.slice(0, OVERVIEW_LIMITS.endpoints).map((entry) => {
    const item = { path: entry.path, count: entry.count, files: entry.files.slice() }
    if (entry.method) item.method = entry.method
    return item
  })

  /* ----------------------------- parameters ----------------------------- */
  const parameters = [...parameterMap.values()]
    .map((entry) => {
      const item = {
        name: entry.name,
        endpoint: entry.endpoint,
        location: entry.location,
        values: entry.values.slice(0, 5),
        source: entry.source,
      }
      if (entry.values.length > 0) {
        if (entry.values.every((value) => /^\d+$/.test(value))) item.pattern = 'numeric'
        else if (entry.values.every((value) => /^wx[0-9a-z]+$/i.test(value))) item.pattern = 'wxid'
        else item.pattern = 'string'
      }
      return item
    })
    .sort((left, right) => {
      if (left.endpoint !== right.endpoint) return left.endpoint < right.endpoint ? -1 : 1
      if (left.name !== right.name) return left.name < right.name ? -1 : 1
      return left.location < right.location ? -1 : 1
    })
  if (parameters.length > OVERVIEW_LIMITS.parameters) {
    warnings.push(`parameters truncated at ${OVERVIEW_LIMITS.parameters}`)
  }

  if (truncatedSecrets) warnings.push(`secrets truncated at ${OVERVIEW_LIMITS.secrets}`)

  /* ------------------------- files / extensions ------------------------- */
  const byExtension = [...extensionMap.values()]
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      return left.ext < right.ext ? -1 : left.ext > right.ext ? 1 : 0
    })
    .slice(0, 12)

  const largestFiles = files
    .slice()
    .sort((left, right) => {
      if (right.size !== left.size) return right.size - left.size
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    })
    .slice(0, 10)
    .map((file) => ({ path: file.path, size: file.size }))

  const contentFileCount = files.filter((file) => !ANALYSIS_METADATA_FILES.has(file.path)).length
  if (manifest && typeof manifest === 'object' && Array.isArray(manifest.files) && manifest.files.length !== contentFileCount) {
    warnings.push(`manifest lists ${manifest.files.length} file(s) but the workspace contains ${contentFileCount}`)
  }
  const nameInfo = deriveAppName({ appConfig, projectConfig, pluginConfig })

  return {
    appid: typeof appid === 'string' ? appid : String(appid || ''),
    version: typeof version === 'string' ? version : String(version || ''),
    generatedAt: new Date().toISOString(),
    appName: nameInfo.appName,
    appNameSource: nameInfo.appNameSource,
    files: { total: files.length, text: textCount, binary: binaryCount, bytes: totalBytes },
    byExtension,
    pages,
    subPackages,
    domains,
    endpoints,
    secrets: secrets.slice(0, OVERVIEW_LIMITS.secrets),
    parameters: parameters.slice(0, OVERVIEW_LIMITS.parameters),
    largestFiles,
    warnings,
  }
}

/**
 * Render a compact, token-friendly overview. Secret values are NEVER printed:
 * only `value_masked` is used.
 *
 * @param {object} overview
 * @param {{maxChars?:number}} [options]
 * @returns {string}
 */
export function buildOverviewText(overview, { maxChars = 8000 } = {}) {
  const data = overview && typeof overview === 'object' ? overview : {}
  const cap = Number.isFinite(Number(maxChars)) ? Math.max(200, Math.trunc(Number(maxChars))) : 8000
  const lines = []
  const push = (line = '') => lines.push(line)
  const list = (items, render, capItems) => {
    const visible = items.slice(0, capItems)
    for (const item of visible) push(render(item))
    if (items.length > visible.length) push(`… and ${items.length - visible.length} more`)
  }

  push(`Mini-program: ${data.appName ? `${data.appName} · ` : ''}${data.appid || '(unknown)'}${data.version ? `@${data.version}` : ''}`)
  if (data.generatedAt) push(`Generated: ${data.generatedAt}`)
  const files = data.files && typeof data.files === 'object' ? data.files : {}
  push(
    `Files: ${Number(files.total) || 0} total (${Number(files.text) || 0} text, ${Number(files.binary) || 0} binary), ${formatBytes(files.bytes)}`,
  )

  const pages = Array.isArray(data.pages) ? data.pages : []
  push('')
  push(`Pages (${pages.length}):`)
  list(pages, (page) => `- ${page}`, 25)

  const subPackages = Array.isArray(data.subPackages) ? data.subPackages : []
  if (subPackages.length > 0) {
    push('')
    push(`Subpackages (${subPackages.length}):`)
    list(
      subPackages,
      (item) => `- ${item.root || '(root)'}: ${Array.isArray(item.pages) ? item.pages.length : 0} page(s)`,
      10,
    )
  }

  const domains = Array.isArray(data.domains) ? data.domains : []
  push('')
  push(`Domains (${domains.length}):`)
  list(domains, (item) => `- ${item.host} (${Number(item.count) || 0} hit(s))`, 20)

  const endpoints = Array.isArray(data.endpoints) ? data.endpoints : []
  push('')
  push(`Endpoint candidates (${endpoints.length}):`)
  list(endpoints, (item) => `- ${item.method ? `${item.method} ` : ''}${item.path} (${Number(item.count) || 0})`, 30)

  const secrets = Array.isArray(data.secrets) ? data.secrets : []
  push('')
  push(`Secrets (${secrets.length}, masked):`)
  list(
    secrets,
    (item) =>
      `- ${item.info_type || 'Other'} ${item.name || ''} ${item.value_masked || '***'}`.trimEnd() +
      ` (${item.source || 'unknown'}${item.line ? `:${item.line}` : ''})`,
    30,
  )

  const parameters = Array.isArray(data.parameters) ? data.parameters : []
  push('')
  push(`Test parameter candidates (${parameters.length}):`)
  list(
    parameters,
    (item) =>
      `- ${item.name} [${item.location || 'query'}] @ ${item.endpoint || 'unknown'}` +
      (Array.isArray(item.values) && item.values.length > 0 ? ` values=${item.values.join(',')}` : ''),
    20,
  )

  const largest = Array.isArray(data.largestFiles) ? data.largestFiles : []
  if (largest.length > 0) {
    push('')
    push('Largest files:')
    list(largest, (item) => `- ${item.path} (${formatBytes(item.size)})`, 5)
  }

  const warnings = Array.isArray(data.warnings) ? data.warnings : []
  if (warnings.length > 0) {
    push('')
    push('Warnings:')
    list(warnings, (warning) => `- ${warning}`, 10)
  }

  let text = lines.join('\n')
  if (text.length > cap) {
    const suffix = '\n…(truncated)'
    text = text.slice(0, Math.max(0, cap - suffix.length)) + suffix
  }
  return text
}

function maskedOverview(overview) {
  const secrets = Array.isArray(overview.secrets)
    ? overview.secrets.map((secret) => ({
        info_type: secret && secret.info_type ? secret.info_type : 'Other',
        name: secret && secret.name ? String(secret.name) : '',
        value_masked:
          secret && typeof secret.value_masked === 'string' && secret.value_masked.length > 0
            ? secret.value_masked
            : maskSecret(secret && secret.value),
        source: secret && secret.source ? String(secret.source) : '',
        line: Number(secret && secret.line) || 0,
        potential_impact: secret && secret.potential_impact ? String(secret.potential_impact) : '',
      }))
    : []
  return { ...overview, secrets }
}

function extractedPayload(overview) {
  const secrets = Array.isArray(overview.secrets)
    ? overview.secrets.map((secret) => ({
        info_type: secret && secret.info_type ? secret.info_type : 'Other',
        name: secret && secret.name ? String(secret.name) : '',
        value: secret && typeof secret.value === 'string' ? secret.value : String((secret && secret.value) || ''),
        source: secret && secret.source ? String(secret.source) : '',
        line: Number(secret && secret.line) || 0,
        potential_impact: secret && secret.potential_impact ? String(secret.potential_impact) : '',
      }))
    : []
  return {
    appid: overview.appid || '',
    version: overview.version || '',
    generatedAt: overview.generatedAt || '',
    secrets,
    endpoints: Array.isArray(overview.endpoints) ? overview.endpoints : [],
    parameters: Array.isArray(overview.parameters) ? overview.parameters : [],
    domains: Array.isArray(overview.domains) ? overview.domains : [],
    pages: Array.isArray(overview.pages) ? overview.pages : [],
    subPackages: Array.isArray(overview.subPackages) ? overview.subPackages : [],
  }
}

/**
 * Persist the analyzer output inside the unpacked directory.
 *
 * `overview.json` contains masked secret values only; `extracted.json` contains
 * the full values for local asset import.
 *
 * @param {string} unpackedPath
 * @param {object} overview
 */
export function saveOverview(unpackedPath, overview) {
  const root = typeof unpackedPath === 'string' && unpackedPath.trim().length > 0 ? resolve(unpackedPath) : ''
  if (!root) throw new WxapkgError(ERROR_CODES.INVALID_PATH, 'unpackedPath is required')
  const data = overview && typeof overview === 'object' ? overview : {}
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'overview.json'), JSON.stringify(maskedOverview(data), null, 2), 'utf8')
  writeFileSync(join(root, 'extracted.json'), JSON.stringify(extractedPayload(data), null, 2), 'utf8')
}

/**
 * Read a previously saved `overview.json` (masked secrets only).
 *
 * @param {string} unpackedPath
 * @returns {object|null}
 */
export function loadOverview(unpackedPath) {
  if (typeof unpackedPath !== 'string' || unpackedPath.trim().length === 0) return null
  const root = resolve(unpackedPath)
  const candidates = [join(root, 'overview.json')]
  if (basename(root) === 'unpacked') candidates.push(join(dirname(root), 'overview.json'))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* try the next location */
    }
  }
  return null
}
