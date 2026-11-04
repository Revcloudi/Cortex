import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import {
  INTERNAL_HOST_STATES,
  SERVICE_STATES,
  isValidIp,
  normalizeCidr,
  type CredentialType,
  type InternalHostState,
  type LootFormat,
  type ServiceState
} from '../../shared/internal'
import {
  LOOT_PARSE_LIMITS,
  isLootParserFormat,
  LOOT_PARSER_FORMATS,
  type LootParseResult,
  type LootParsedCredential,
  type LootParsedHost,
  type LootParsedService
} from './types'
import { readZipJsonEntries } from './zip'

/**
 * Local Loot parsing engine (Plan B §8.4 / §11).
 *
 * Security contract:
 * - HTML/JSON/CSV/text are parsed as *data*: nothing is executed, imported or
 *   fetched. There is no network access and no temporary file is written.
 * - Input limits (file size, entry count, uncompressed size, line length) are
 *   enforced up front; violations return `status: 'needs_review'` with a warning
 *   instead of throwing, so the database can still record the import.
 * - Secrets are never logged and never end up in `warnings`: provenance strings
 *   are `<format>:<filename>` only. Raw secrets exist solely in
 *   `credentials[].secret`, which the DB layer persists (masked on read).
 * - Only an unreadable / non-regular file throws; the DB layer records that as a
 *   `failed` loot import.
 *
 * Formats: `bloodhound-json` (including BloodHound `.zip` exports),
 * `secretsdump-text`, `config-env`, `generic-csv`; unknown formats become
 * `needs_review` while still carrying the file SHA-256.
 */

export interface LootParseOptions {
  /** `auto` (default) or one of `LOOT_PARSER_FORMATS`; from `--format`. */
  format?: string
}

interface ParseOutcome {
  hosts: LootParsedHost[]
  services: LootParsedService[]
  credentials: LootParsedCredential[]
  warnings: string[]
  fatal: boolean
}

const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_EOCD_SIGNATURE = 0x06054b50
const EMPTY_LM_HASH = 'aad3b435b51404eeaad3b435b51404ee'
const EMPTY_NT_HASH = '31d6cfe0d16ae931b73c59d7e0c089c0'

function emptyOutcome(): ParseOutcome {
  return { hosts: [], services: [], credentials: [], warnings: [], fatal: false }
}

/* ------------------------------------------------------------- file utils -- */

/** SHA-256 of a possibly large file, read in chunks (never fully buffered). */
function hashFileSync(filePath: string): string {
  const hash = createHash('sha256')
  const fd = openSync(filePath, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead = readSync(fd, chunk, 0, chunk.length, null)
    while (bytesRead > 0) {
      hash.update(chunk.subarray(0, bytesRead))
      bytesRead = readSync(fd, chunk, 0, chunk.length, null)
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function isZipBuffer(buffer: Buffer): boolean {
  if (buffer.length < 4) return false
  const signature = buffer.readUInt32LE(0)
  return signature === ZIP_LOCAL_SIGNATURE || signature === ZIP_EOCD_SIGNATURE
}

/** Decode UTF-8 text, returning null when the probe finds NUL (binary) bytes. */
function decodeTextBuffer(buffer: Buffer): string | null {
  const probeLength = Math.min(buffer.length, 8192)
  for (let index = 0; index < probeLength; index += 1) {
    if (buffer[index] === 0) return null
  }
  const text = buffer.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function splitBoundedLines(text: string, warnings: string[]): string[] {
  const rawLines = text.split(/\r?\n/)
  const limit = LOOT_PARSE_LIMITS.maxTextLines
  if (rawLines.length > limit) {
    warnings.push(`文件行数 ${rawLines.length} 超过解析上限 ${limit}，只解析前 ${limit} 行`)
    return rawLines.slice(0, limit)
  }
  return rawLines
}

function isLineTooLong(line: string): boolean {
  return line.length > LOOT_PARSE_LIMITS.maxLineLength
}

function extractIpFromFileName(fileName: string): string | undefined {
  const candidate = /(?:\d{1,3}\.){3}\d{1,3}/.exec(fileName)?.[0]
  return candidate !== undefined && isValidIp(candidate) ? candidate : undefined
}

function guessFormatFromName(fileName: string): LootFormat {
  const lower = fileName.toLowerCase()
  const ext = extname(lower)
  if (ext === '.json' || ext === '.zip') return 'bloodhound-json'
  if (ext === '.csv' || ext === '.tsv') return 'generic-csv'
  if (lower === '.env' || lower.startsWith('.env.') || ext === '.env') return 'config-env'
  if (ext === '.txt' || ext === '.log' || ext === '.hashes' || ext === '.ntds') {
    return 'secretsdump-text'
  }
  return 'unknown'
}

function normalizeRequestedFormat(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase() ?? ''
  return trimmed.length === 0 ? 'auto' : trimmed
}

function needsReviewResult(
  format: LootFormat,
  parser: string,
  sha256: string,
  warnings: string[]
): LootParseResult {
  return {
    format,
    parser,
    sha256,
    status: 'needs_review',
    hosts: [],
    services: [],
    credentials: [],
    warnings
  }
}

/* ------------------------------------------------------------ entry point -- */

export function parseLootFile(
  filePath: string,
  options: LootParseOptions = {}
): LootParseResult {
  const absolutePath = resolve(filePath)
  let fileSize: number
  try {
    const stats = statSync(absolutePath)
    if (!stats.isFile()) throw new Error('not a regular file')
    fileSize = stats.size
  } catch {
    throw new Error(`Loot 文件不存在或不是普通文件: ${filePath}`)
  }

  const fileName = basename(absolutePath)
  const oversize = fileSize > LOOT_PARSE_LIMITS.maxFileBytes
  let buffer: Buffer | null = null
  let sha256: string
  if (oversize) {
    // Still hash the whole file: the import record must be identifiable.
    sha256 = hashFileSync(absolutePath)
  } else {
    buffer = readFileSync(absolutePath)
    sha256 = createHash('sha256').update(buffer).digest('hex')
  }

  const requested = normalizeRequestedFormat(options.format)
  if (requested !== 'auto' && !isLootParserFormat(requested)) {
    return needsReviewResult('unknown', 'none', sha256, [
      `不支持的 Loot 格式: ${requested}（可选 auto | ${LOOT_PARSER_FORMATS.join(' | ')}）`
    ])
  }

  if (buffer === null) {
    return needsReviewResult(guessFormatFromName(fileName), 'none', sha256, [
      `文件大小 ${fileSize} 字节超过上限 ${LOOT_PARSE_LIMITS.maxFileBytes} 字节，未解析`
    ])
  }

  const detection = detectFormat(buffer, fileName)
  let format: LootFormat
  let parseAsZip = false
  if (requested !== 'auto') {
    format = requested as LootFormat
    if (detection.isZip && format !== 'bloodhound-json') {
      return needsReviewResult(format, 'none', sha256, [
        '文件是 ZIP 归档，仅支持 --format bloodhound-json（BloodHound JSON 导出）'
      ])
    }
    parseAsZip = detection.isZip && format === 'bloodhound-json'
  } else {
    format = detection.format
    parseAsZip = detection.isZip
  }

  if (format === 'unknown') {
    return needsReviewResult('unknown', 'none', sha256, [
      '未识别的 Loot 格式：支持 bloodhound-json / secretsdump-text / config-env / generic-csv；可用 --format 显式指定'
    ])
  }

  let outcome: ParseOutcome
  let parser: string = format
  try {
    if (parseAsZip) {
      outcome = parseBloodhoundZip(buffer, fileName)
      parser = 'bloodhound-json+zip'
    } else {
      const text = decodeTextBuffer(buffer)
      if (text === null) {
        outcome = emptyOutcome()
        outcome.fatal = true
        outcome.warnings.push('文件包含二进制内容，无法按文本解析')
      } else if (format === 'bloodhound-json') {
        outcome = parseBloodhoundJsonText(text)
      } else if (format === 'secretsdump-text') {
        outcome = parseSecretsdumpText(text, fileName)
      } else if (format === 'config-env') {
        outcome = parseConfigEnvText(text, fileName)
      } else {
        outcome = parseGenericCsvText(text, fileName)
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : 'unknown error'
    return needsReviewResult(format, 'none', sha256, [`解析器异常: ${detail}`])
  }

  return finalizeResult(format, parser, sha256, outcome)
}

/* -------------------------------------------------------------- detection -- */

interface Detection {
  format: LootFormat
  isZip: boolean
}

function isEnvFileName(lowerName: string): boolean {
  return (
    lowerName === '.env' ||
    lowerName.startsWith('.env.') ||
    lowerName.endsWith('.env') ||
    lowerName.includes('.env.')
  )
}

function detectFormat(buffer: Buffer, fileName: string): Detection {
  if (isZipBuffer(buffer)) return { format: 'bloodhound-json', isZip: true }
  const lowerName = fileName.toLowerCase()
  const ext = extname(lowerName)
  if (ext === '.json') return { format: 'bloodhound-json', isZip: false }
  if (ext === '.csv' || ext === '.tsv') return { format: 'generic-csv', isZip: false }
  if (isEnvFileName(lowerName)) return { format: 'config-env', isZip: false }

  const text = decodeTextBuffer(buffer)
  if (text === null) return { format: 'unknown', isZip: false }
  const trimmedStart = text.trimStart()
  // Regression guard: secretsdump/impacket output routinely starts with
  // `[*] Dumping local SAM hashes ...` markers, so a bare `[` is NOT a JSON
  // array. JSON sniffing must be strict (object: `{`; array: `[` followed by a
  // JSON value token) and runs after the secretsdump marker check below.
  const looksLikeJsonObject = trimmedStart.startsWith('{')
  const looksLikeJsonArray = /^\[\s*(?:\{|\[|\]|"|-?\d|true|false|null)/.test(trimmedStart)
  if (looksLikeJsonObject || looksLikeJsonArray) {
    return { format: 'bloodhound-json', isZip: false }
  }
  if (looksLikeSecretsdump(text)) return { format: 'secretsdump-text', isZip: false }
  if (looksLikeConfigEnv(text)) return { format: 'config-env', isZip: false }
  if (looksLikeCsv(text)) return { format: 'generic-csv', isZip: false }
  return { format: 'unknown', isZip: false }
}

const SECRETSDUMP_MARKERS = [
  /\[\*\]\s*Dumping\s+(?:local\s+SAM\s+hashes|domain\s+credentials|cached\s+domain\s+logon|LSA\s+Secrets)/i,
  /impacket/i,
  /secretsdump/i
]
const SAM_HASH_LINE_PATTERN = /^[^:]{1,512}:\d{1,10}:(?:[0-9a-fA-F]{32})?:(?:[0-9a-fA-F]{32})?:{3}$/

function looksLikeSecretsdump(text: string): boolean {
  const head = text.slice(0, 200_000)
  if (SECRETSDUMP_MARKERS.some((pattern) => pattern.test(head))) return true
  let samLines = 0
  for (const line of head.split(/\r?\n/, 2_000)) {
    if (SAM_HASH_LINE_PATTERN.test(line.trim())) {
      samLines += 1
      if (samLines >= 2) return true
    }
  }
  return false
}

function looksLikeConfigEnv(text: string): boolean {
  let assignments = 0
  let secretAssignments = 0
  for (const line of text.split(/\r?\n/, 2_000)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('//')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*.*$/.exec(trimmed)
    if (match === null) continue
    assignments += 1
    if (classifySecretKey(match[1] ?? '') !== null) secretAssignments += 1
  }
  return assignments >= 2 && secretAssignments >= 1
}

function looksLikeCsv(text: string): boolean {
  const firstLine = text
    .split(/\r?\n/, 20)
    .find((line) => line.trim().length > 0)
  if (firstLine === undefined) return false
  const delimiter = detectCsvDelimiter(firstLine)
  if (delimiter === null) return false
  const headers = parseDelimitedLine(firstLine, delimiter).map(normalizeColumnName)
  if (headers.length < 2) return false
  const recognized = headers.filter((header) => resolveCsvColumn(header) !== null)
  return recognized.length >= 2
}

/* ------------------------------------------------------------- finalizing -- */

function finalizeResult(
  format: LootFormat,
  parser: string,
  sha256: string,
  outcome: ParseOutcome
): LootParseResult {
  const hosts = dedupeHosts(outcome.hosts, outcome.warnings)
  const hostByIp = new Map(hosts.map((host) => [host.ip, host]))
  const ensureHost = (ip: string): void => {
    if (!isValidIp(ip) || hostByIp.has(ip)) return
    const host: LootParsedHost = { ip, state: 'unknown' }
    hosts.push(host)
    hostByIp.set(ip, host)
  }

  const services = dedupeServices(outcome.services, outcome.warnings)
  for (const service of services) ensureHost(service.host_ip)

  const credentials = dedupeCredentials(outcome.credentials, outcome.warnings)
  for (const credential of credentials) {
    const hostIp = credential.host_ip ?? credential.service_ip
    if (hostIp !== undefined && isValidIp(hostIp)) {
      credential.host_ip = hostIp
      ensureHost(hostIp)
    } else {
      delete credential.host_ip
    }
  }

  // The parser may add hosts after the collection caps were applied.
  if (hosts.length > LOOT_PARSE_LIMITS.maxEntries) {
    outcome.warnings.push(
      `主机数量 ${hosts.length} 超过上限 ${LOOT_PARSE_LIMITS.maxEntries}，已截断`
    )
    hosts.length = LOOT_PARSE_LIMITS.maxEntries
  }

  return {
    format,
    parser,
    sha256,
    status: outcome.fatal ? 'needs_review' : 'parsed',
    hosts,
    services,
    credentials,
    warnings: [...new Set(outcome.warnings)].slice(0, 50)
  }
}

function mergeDefined<T extends object>(
  target: T,
  source: T,
  keys: ReadonlyArray<keyof T>
): void {
  for (const key of keys) {
    const current = target[key]
    const next = source[key]
    if ((current === undefined || current === '') && next !== undefined && next !== '') {
      target[key] = next
    }
  }
}

function dedupeHosts(hosts: LootParsedHost[], warnings: string[]): LootParsedHost[] {
  const byIp = new Map<string, LootParsedHost>()
  let invalid = 0
  for (const host of hosts) {
    const ip = host.ip.trim()
    if (!isValidIp(ip)) {
      invalid += 1
      continue
    }
    const normalized: LootParsedHost = {
      ...host,
      ip,
      state:
        host.state !== undefined &&
        (INTERNAL_HOST_STATES as readonly string[]).includes(host.state)
          ? host.state
          : 'unknown'
    }
    const existing = byIp.get(ip)
    if (existing === undefined) {
      byIp.set(ip, normalized)
      continue
    }
    mergeDefined(existing, normalized, ['hostname', 'os', 'subnet'])
    if (existing.state === 'unknown' && normalized.state !== 'unknown') {
      existing.state = normalized.state
    }
  }
  if (invalid > 0) warnings.push(`${invalid} 个主机条目 IP 非法，已跳过`)
  const result = [...byIp.values()]
  if (result.length > LOOT_PARSE_LIMITS.maxEntries) {
    warnings.push(`主机数量 ${result.length} 超过上限 ${LOOT_PARSE_LIMITS.maxEntries}，已截断`)
    result.length = LOOT_PARSE_LIMITS.maxEntries
  }
  return result
}

function dedupeServices(
  services: LootParsedService[],
  warnings: string[]
): LootParsedService[] {
  const byKey = new Map<string, LootParsedService>()
  let invalid = 0
  for (const service of services) {
    const port = service.port
    if (
      !isValidIp(service.host_ip) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      invalid += 1
      continue
    }
    const protocol = (service.protocol ?? '').toLowerCase()
    const normalized: LootParsedService = {
      ...service,
      protocol,
      state:
        service.state !== undefined &&
        (SERVICE_STATES as readonly string[]).includes(service.state)
          ? service.state
          : 'open',
      banner:
        service.banner !== undefined
          ? service.banner.slice(0, LOOT_PARSE_LIMITS.maxBannerLength)
          : undefined
    }
    const key = `${service.host_ip}|${port}|${protocol}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, normalized)
      continue
    }
    mergeDefined(existing, normalized, ['service', 'banner'])
  }
  if (invalid > 0) warnings.push(`${invalid} 个服务条目缺少合法 IP/端口，已跳过`)
  const result = [...byKey.values()]
  if (result.length > LOOT_PARSE_LIMITS.maxEntries) {
    warnings.push(`服务数量 ${result.length} 超过上限 ${LOOT_PARSE_LIMITS.maxEntries}，已截断`)
    result.length = LOOT_PARSE_LIMITS.maxEntries
  }
  return result
}

function dedupeCredentials(
  credentials: LootParsedCredential[],
  warnings: string[]
): LootParsedCredential[] {
  const byKey = new Map<string, LootParsedCredential>()
  let empty = 0
  let tooLong = 0
  for (const credential of credentials) {
    if (credential.secret.length === 0) {
      empty += 1
      continue
    }
    if (credential.secret.length > LOOT_PARSE_LIMITS.maxSecretLength) {
      tooLong += 1
      continue
    }
    const key = [
      credential.type,
      credential.domain ?? '',
      credential.username ?? '',
      credential.secret
    ].join('\u0000')
    if (byKey.has(key)) continue
    byKey.set(key, {
      ...credential,
      confidence: credential.confidence ?? 'medium'
    })
  }
  if (empty > 0) warnings.push(`${empty} 个凭据 secret 为空，已跳过`)
  if (tooLong > 0) {
    warnings.push(
      `${tooLong} 个凭据 secret 超过 ${LOOT_PARSE_LIMITS.maxSecretLength} 字符上限，已跳过`
    )
  }
  const result = [...byKey.values()]
  if (result.length > LOOT_PARSE_LIMITS.maxEntries) {
    warnings.push(`凭据数量 ${result.length} 超过上限 ${LOOT_PARSE_LIMITS.maxEntries}，已截断`)
    result.length = LOOT_PARSE_LIMITS.maxEntries
  }
  return result
}

/* ------------------------------------------------------ bloodhound parsing -- */

interface BloodhoundAppendResult {
  recognized: boolean
  computerCount: number
  withoutIpCount: number
}

function bloodhoundProperties(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['properties', 'Properties', 'props', 'Props']) {
    const value = record[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return {}
}

function bloodhoundKindText(record: Record<string, unknown>, hint: string): string {
  const candidates: unknown[] = [
    record['kind'],
    record['Kind'],
    record['type'],
    record['Type'],
    record['label'],
    record['Label'],
    hint
  ]
  const kinds = record['Kinds'] ?? record['kinds']
  if (Array.isArray(kinds)) candidates.push(...kinds)
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate.toLowerCase()
    }
  }
  return ''
}

function isBloodhoundComputer(
  kindText: string,
  properties: Record<string, unknown>,
  hint: string
): boolean {
  if (kindText.includes('computer') || hint === 'computer') return true
  if (kindText.includes('user') || kindText.includes('group')) return false
  if (hint === 'user' || hint === 'group') return false
  // BloodHound computer nodes always carry an operating system property.
  return (
    typeof properties['operatingsystem'] === 'string' ||
    typeof properties['operatingSystem'] === 'string'
  )
}

function firstStringProperty(
  properties: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = properties[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function extractBloodhoundIp(properties: Record<string, unknown>): string | null {
  const directKeys = ['ip', 'ipaddress', 'ip_address', 'ipAddress', 'ipv4', 'ipv6', 'address']
  for (const key of directKeys) {
    const value = properties[key]
    if (typeof value !== 'string') continue
    const cleaned = value.trim().replace(/^\[/, '').replace(/\]$/, '')
    if (isValidIp(cleaned)) return cleaned
  }
  // Synthetic fixtures sometimes use the machine name as an IP.
  const name = properties['name']
  if (typeof name === 'string') {
    const cleaned = name.trim()
    if (isValidIp(cleaned)) return cleaned
  }
  return null
}

function bloodhoundComputerToHost(properties: Record<string, unknown>): LootParsedHost | null {
  const ip = extractBloodhoundIp(properties)
  if (ip === null) return null
  const host: LootParsedHost = { ip, state: 'unknown' }
  const hostname = firstStringProperty(properties, [
    'name',
    'dnshostname',
    'hostname',
    'samaccountname',
    'cn'
  ])
  if (hostname !== null) host.hostname = hostname.replace(/\$$/, '')
  const os = firstStringProperty(properties, ['operatingsystem', 'operatingSystem', 'os'])
  if (os !== null) host.os = os
  return host
}

interface BloodhoundNodeGroup {
  nodes: unknown[]
  hint: string
}

function collectBloodhoundNodeGroups(value: unknown): BloodhoundNodeGroup[] {
  if (Array.isArray(value)) return [{ nodes: value, hint: '' }]
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const groups: BloodhoundNodeGroup[] = []
  const entityKeys: ReadonlyArray<readonly [string, string]> = [
    ['users', 'user'],
    ['computers', 'computer'],
    ['groups', 'group']
  ]
  for (const [key, hint] of entityKeys) {
    const candidate = record[key]
    if (Array.isArray(candidate)) groups.push({ nodes: candidate, hint })
  }
  const data = record['data']
  if (Array.isArray(data)) {
    groups.push({ nodes: data, hint: '' })
  } else if (data !== null && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>
    for (const [key, hint] of entityKeys) {
      const candidate = dataRecord[key]
      if (Array.isArray(candidate)) groups.push({ nodes: candidate, hint })
    }
  }
  const nodes = record['nodes']
  if (groups.length === 0 && Array.isArray(nodes)) {
    groups.push({ nodes, hint: '' })
  }
  return groups
}

function appendBloodhoundNodes(
  value: unknown,
  hint: string,
  outcome: ParseOutcome
): BloodhoundAppendResult {
  const groups = collectBloodhoundNodeGroups(value)
  const result: BloodhoundAppendResult = {
    recognized: groups.length > 0,
    computerCount: 0,
    withoutIpCount: 0
  }
  for (const group of groups) {
    const groupHint = group.hint.length > 0 ? group.hint : hint
    for (const node of group.nodes) {
      if (node === null || typeof node !== 'object') continue
      const record = node as Record<string, unknown>
      const properties = bloodhoundProperties(record)
      const kindText = bloodhoundKindText(record, groupHint)
      if (!isBloodhoundComputer(kindText, properties, groupHint)) continue
      result.computerCount += 1
      const host = bloodhoundComputerToHost(properties)
      if (host === null) {
        result.withoutIpCount += 1
        continue
      }
      outcome.hosts.push(host)
    }
  }
  return result
}

function parseBloodhoundJsonText(text: string): ParseOutcome {
  const outcome = emptyOutcome()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    outcome.fatal = true
    outcome.warnings.push('BloodHound JSON 解析失败：文件不是合法 JSON')
    return outcome
  }

  const appended = appendBloodhoundNodes(value, '', outcome)
  if (!appended.recognized) {
    outcome.fatal = true
    outcome.warnings.push(
      'JSON 不是 BloodHound 导出结构（期望 computers/users/groups 数组、data 数组或节点数组）'
    )
    return outcome
  }
  if (appended.computerCount === 0) {
    outcome.fatal = true
    outcome.warnings.push('BloodHound 导出中没有计算机节点（users/groups 不生成内网主机）')
    return outcome
  }
  if (appended.withoutIpCount > 0) {
    outcome.warnings.push(
      `BloodHound 中 ${appended.withoutIpCount} 台计算机缺少 IP，未生成 internal host（ip 必填）`
    )
  }
  if (outcome.hosts.length === 0) {
    outcome.fatal = true
    outcome.warnings.push('BloodHound 未解析出可入库的计算机（需要 properties.ip 等 IP 字段）')
  }
  return outcome
}

function parseBloodhoundZip(buffer: Buffer, fileName: string): ParseOutcome {
  const outcome = emptyOutcome()
  const archive = readZipJsonEntries(buffer)
  outcome.warnings.push(...archive.warnings)
  if (archive.fatal) {
    outcome.fatal = true
    return outcome
  }

  let computerCount = 0
  let withoutIpCount = 0
  for (const entry of archive.entries) {
    let value: unknown
    try {
      value = JSON.parse(entry.data.toString('utf8').replace(/^\uFEFF/, ''))
    } catch {
      outcome.warnings.push(`ZIP 条目 ${entry.name} 不是合法 JSON，已跳过`)
      continue
    }
    const hint = /computer/i.test(entry.name)
      ? 'computer'
      : /user/i.test(entry.name)
        ? 'user'
        : /group/i.test(entry.name)
          ? 'group'
          : ''
    const appended = appendBloodhoundNodes(value, hint, outcome)
    if (!appended.recognized) {
      outcome.warnings.push(`ZIP 条目 ${entry.name} 不是 BloodHound 节点结构，已跳过`)
      continue
    }
    computerCount += appended.computerCount
    withoutIpCount += appended.withoutIpCount
  }

  if (computerCount === 0) {
    outcome.fatal = true
    outcome.warnings.push('ZIP 内的 BloodHound JSON 没有计算机节点，无法生成内网主机')
    return outcome
  }
  if (withoutIpCount > 0) {
    outcome.warnings.push(
      `BloodHound 中 ${withoutIpCount} 台计算机缺少 IP，未生成 internal host（ip 必填）`
    )
  }
  if (outcome.hosts.length === 0) {
    outcome.fatal = true
    outcome.warnings.push('BloodHound ZIP 未解析出可入库的计算机（需要 properties.ip 等 IP 字段）')
  }
  void fileName
  return outcome
}

/* ------------------------------------------------------ secretsdump text -- */

interface SamHashLine {
  userPart: string
  rid: string
  lmHash: string
  ntHash: string
}

function isHex32OrEmpty(value: string): boolean {
  return value === '' || /^[0-9a-fA-F]{32}$/.test(value)
}

function parseSamHashLine(line: string): SamHashLine | null {
  const parts = line.split(':')
  if (parts.length !== 7) return null
  if (parts[4] !== '' || parts[5] !== '' || parts[6] !== '') return null
  const userPart = parts[0] ?? ''
  const rid = parts[1] ?? ''
  const lmHash = parts[2] ?? ''
  const ntHash = parts[3] ?? ''
  if (userPart.length === 0 || userPart.length > 512) return null
  if (!/^\d{1,10}$/.test(rid)) return null
  if (!isHex32OrEmpty(lmHash) || !isHex32OrEmpty(ntHash)) return null
  return { userPart, rid, lmHash, ntHash }
}

const DCC2_LINE_PATTERN = /^\$DCC2\$\d+#[^#]{1,255}#[0-9a-fA-F]{16,256}$/

function parseSecretsdumpText(text: string, fileName: string): ParseOutcome {
  const outcome = emptyOutcome()
  const source = `secretsdump-text:${fileName}`
  const fileNameIp = extractIpFromFileName(fileName)
  const lines = splitBoundedLines(text, outcome.warnings)
  let dumpMarker = false
  let skippedLong = 0
  let emptyHashes = 0
  let parsedHashes = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (isLineTooLong(line)) {
      skippedLong += 1
      continue
    }
    if (
      /\[\*\]\s*Dumping\s+(?:local\s+SAM\s+hashes|domain\s+credentials|cached\s+domain\s+logon)/i.test(
        line
      )
    ) {
      dumpMarker = true
      continue
    }

    if (DCC2_LINE_PATTERN.test(line)) {
      const parts = line.split('#')
      const username = parts[1] ?? ''
      const credential: LootParsedCredential = {
        type: 'other',
        username,
        secret: line,
        source,
        confidence: 'medium',
        notes: 'cached domain credential (DCC2)'
      }
      if (fileNameIp !== undefined) credential.host_ip = fileNameIp
      outcome.credentials.push(credential)
      parsedHashes += 1
      continue
    }

    const sam = parseSamHashLine(line)
    if (sam === null) continue
    const ntHash = sam.ntHash.trim()
    const lmHash = sam.lmHash.trim()
    let secret = ''
    const notes: string[] = []
    if (ntHash.length > 0) {
      secret = ntHash
      if (ntHash.toLowerCase() === EMPTY_NT_HASH) notes.push('空密码 NT 哈希')
    } else if (lmHash.length > 0 && lmHash.toLowerCase() !== EMPTY_LM_HASH) {
      secret = lmHash
      notes.push('仅有 LM 哈希')
    }
    if (secret.length === 0) {
      emptyHashes += 1
      continue
    }

    const slash = sam.userPart.lastIndexOf('\\')
    const domain = slash >= 0 ? sam.userPart.slice(0, slash) : ''
    const username = slash >= 0 ? sam.userPart.slice(slash + 1) : sam.userPart
    notes.push(`rid=${sam.rid}`)
    if (username.endsWith('$')) notes.push('机器账户')
    const credential: LootParsedCredential = {
      type: 'ntlm_hash',
      username,
      secret,
      source,
      confidence: 'medium',
      notes: notes.join('; ')
    }
    if (domain.length > 0) credential.domain = domain
    if (fileNameIp !== undefined) credential.host_ip = fileNameIp
    outcome.credentials.push(credential)
    parsedHashes += 1
  }

  if (skippedLong > 0) outcome.warnings.push(`${skippedLong} 行文本超长，已跳过`)
  if (emptyHashes > 0) {
    outcome.warnings.push(`${emptyHashes} 行哈希为空（LM/NT 均为空），已跳过`)
  }
  if (fileNameIp !== undefined && parsedHashes > 0) {
    outcome.hosts.push({ ip: fileNameIp, state: 'unknown' })
  }
  if (parsedHashes === 0) {
    outcome.fatal = true
    outcome.warnings.push(
      dumpMarker
        ? '未从 secretsdump 输出中解析出哈希行（期望 DOMAIN\\user:RID:LM:NTLM::: 或 $DCC2$ 缓存）'
        : '未识别到 secretsdump 内容（缺少 Dumping 标记与 user:RID:LM:NTLM::: 哈希行）'
    )
  }
  return outcome
}

/* ----------------------------------------------------------- config / env -- */

/** Credential classification for `.env` / key=value configuration files. */
function classifySecretKey(rawKey: string): CredentialType | null {
  const key = rawKey.toLowerCase()
  if (
    /(^|[_.-])(private[_-]?key|ssh[_-]?key|id_rsa|id_ed25519)([_.-]|$)/.test(key) ||
    key.endsWith('privatekey')
  ) {
    return 'ssh_key'
  }
  if (/(password|passwd|passphrase|pwd)([_.-]|$)/.test(key) || /(^|[_.-])pass([_.-]|$)/.test(key)) {
    return 'password'
  }
  if (
    /(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret)([_.-]|$)/.test(key)
  ) {
    return 'api_key'
  }
  if (
    /(^|[_.-])(token|bearer|auth[_-]?token|access[_-]?token|refresh[_-]?token)([_.-]|$)/.test(
      key
    )
  ) {
    return 'api_key'
  }
  if (/(^|[_.-])secret([_.-]|$)/.test(key)) return 'password'
  if (/(^|[_.-])(cert|certificate)([_.-]|$)/.test(key)) return 'cert'
  if (/(^|[_.-])(auth|credential|jwt)([_.-]|$)/.test(key)) return 'api_key'
  return null
}

const ENV_HOST_KEY_PATTERN =
  /(^|[_.-])(host|hostname|url|uri|endpoint|addr|address|server)([_.-]|$)/

function findClosingQuote(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1
      continue
    }
    if (value[index] === quote) return index
  }
  return -1
}

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

interface EnvValue {
  value: string
  template: boolean
}

function parseEnvValue(raw: string): EnvValue {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"')) {
    const end = findClosingQuote(trimmed, '"')
    const body = end >= 0 ? trimmed.slice(1, end) : trimmed.slice(1)
    return { value: unescapeDoubleQuoted(body), template: false }
  }
  if (trimmed.startsWith("'")) {
    const end = findClosingQuote(trimmed, "'")
    const body = end >= 0 ? trimmed.slice(1, end) : trimmed.slice(1)
    return { value: body, template: false }
  }
  const comment = /\s+#/.exec(trimmed)
  const value = comment !== null ? trimmed.slice(0, comment.index).trim() : trimmed
  const template =
    /^\$\{[^}]*\}$/.test(value) || /^<[^>]*>$/.test(value) || /^\{\{[^}]*\}\}$/.test(value)
  return { value, template }
}

function envPrefix(rawKey: string): string {
  const index = rawKey.indexOf('_')
  // Comparison happens against lowercased assignment keys, so the prefix must
  // be lowercased too (`DB_PASSWORD` → `db` → `db_user` / `db_port`).
  return index > 0 ? rawKey.slice(0, index).toLowerCase() : ''
}

function lookupEnvValue(
  assignments: Map<string, string>,
  candidates: readonly string[]
): string | undefined {
  for (const key of candidates) {
    const value = assignments.get(key)
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

function lookupEnvUsername(
  assignments: Map<string, string>,
  prefix: string
): string | undefined {
  const candidates =
    prefix.length > 0
      ? [`${prefix}_user`, `${prefix}_username`, `${prefix}_login`, `${prefix}_account`]
      : ['user', 'username', 'login', 'account']
  return lookupEnvValue(assignments, candidates)
}

function lookupEnvDomain(
  assignments: Map<string, string>,
  prefix: string
): string | undefined {
  const candidates =
    prefix.length > 0
      ? [`${prefix}_domain`, `${prefix}_realm`, `${prefix}_ad_domain`, 'domain', 'realm']
      : ['domain', 'realm', 'ad_domain']
  return lookupEnvValue(assignments, candidates)
}

function sliceOptional(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return value.slice(0, maxLength)
}

function parseConfigEnvText(text: string, fileName: string): ParseOutcome {
  const outcome = emptyOutcome()
  const source = `config-env:${fileName}`
  const lines = splitBoundedLines(text, outcome.warnings)
  const assignments = new Map<string, string>()
  const originalKeys = new Map<string, string>()
  const templateKeys = new Set<string>()
  let skippedLong = 0

  for (const rawLine of lines) {
    let line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) {
      continue
    }
    if (isLineTooLong(line)) {
      skippedLong += 1
      continue
    }
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()
    const equals = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line)
    const colon = equals === null ? /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.+)$/.exec(line) : null
    const match = equals ?? colon
    if (match === null) continue
    const rawKey = match[1] ?? ''
    const lookupKey = rawKey.toLowerCase()
    if (lookupKey.length === 0 || assignments.has(lookupKey)) continue
    const parsed = parseEnvValue(match[2] ?? '')
    assignments.set(lookupKey, parsed.value)
    originalKeys.set(lookupKey, rawKey)
    if (parsed.template) templateKeys.add(lookupKey)
  }

  if (assignments.size === 0) {
    outcome.fatal = true
    outcome.warnings.push('config-env 解析失败：未找到 KEY=VALUE 形式的配置项')
    return outcome
  }

  let templateCount = 0
  for (const [lookupKey, secret] of assignments) {
    const rawKey = originalKeys.get(lookupKey) ?? lookupKey
    const type = classifySecretKey(rawKey)
    if (type === null) continue
    if (secret.length === 0) continue
    if (templateKeys.has(lookupKey)) {
      templateCount += 1
      continue
    }
    if (secret.length > LOOT_PARSE_LIMITS.maxSecretLength) {
      outcome.warnings.push(`配置项 ${rawKey} 的值超过长度上限，已跳过`)
      continue
    }
    const prefix = envPrefix(rawKey)
    const username = lookupEnvUsername(assignments, prefix)
    const credential: LootParsedCredential = {
      type,
      secret,
      source,
      confidence: looksLikePlaceholder(secret) ? 'low' : 'medium',
      notes: `key=${rawKey}`
    }
    if (username !== undefined) credential.username = username
    const domain = lookupEnvDomain(assignments, prefix)
    if (domain !== undefined) credential.domain = domain
    outcome.credentials.push(credential)
  }
  if (templateCount > 0) {
    outcome.warnings.push(`${templateCount} 个配置项的值是模板/占位符（\${...} 等），未作为凭据`)
  }

  let hostnameOnly = 0
  for (const [lookupKey, value] of assignments) {
    if (!ENV_HOST_KEY_PATTERN.test(lookupKey)) continue
    const rawKey = originalKeys.get(lookupKey) ?? lookupKey
    const prefix = envPrefix(rawKey)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        const url = new URL(value)
        const urlHost = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
        const urlPort = url.port.length > 0 ? Number(url.port) : 0
        let hostIp: string | undefined
        if (isValidIp(urlHost)) {
          hostIp = urlHost
          outcome.hosts.push({ ip: urlHost, state: 'unknown' })
          if (urlPort >= 1 && urlPort <= 65_535) {
            outcome.services.push({
              host_ip: urlHost,
              port: urlPort,
              protocol: url.protocol.replace(/:$/, ''),
              state: 'open'
            })
          }
        } else if (urlHost.length > 0) {
          hostnameOnly += 1
        }
        const username = url.username.length > 0 ? decodeURIComponent(url.username) : ''
        const password = url.password.length > 0 ? decodeURIComponent(url.password) : ''
        if (password.length > 0 && password.length <= LOOT_PARSE_LIMITS.maxSecretLength) {
          const credential: LootParsedCredential = {
            type: 'password',
            secret: password,
            source,
            confidence: 'medium',
            notes: `URL userinfo (${rawKey})`
          }
          if (username.length > 0) credential.username = username
          if (hostIp !== undefined) credential.host_ip = hostIp
          if (urlPort >= 1 && urlPort <= 65_535) credential.service_port = urlPort
          outcome.credentials.push(credential)
        }
      } catch {
        // Not a URL after all: fall through to the plain-value handling below.
      }
      continue
    }
    const cleaned = value.trim().replace(/^\[/, '').replace(/\]$/, '')
    if (isValidIp(cleaned)) {
      outcome.hosts.push({ ip: cleaned, state: 'unknown' })
      const portKey = prefix.length > 0 ? `${prefix}_port` : 'port'
      const portValue = assignments.get(portKey)
      const port = portValue !== undefined ? Number(portValue) : Number.NaN
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
        outcome.services.push({
          host_ip: cleaned,
          port,
          protocol: 'tcp',
          state: 'open'
        })
      }
    } else if (cleaned.length > 0) {
      hostnameOnly += 1
    }
  }

  if (hostnameOnly > 0) {
    outcome.warnings.push(
      `config-env 中 ${hostnameOnly} 个主机名没有 IP，未生成 internal host（ip 必填）`
    )
  }
  if (skippedLong > 0) outcome.warnings.push(`${skippedLong} 行配置超过行长度上限，已跳过`)
  if (outcome.credentials.length === 0 && outcome.hosts.length === 0) {
    outcome.fatal = true
    outcome.warnings.push('config-env 未解析出可用凭据或内网主机')
  }
  return outcome
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    /^\$\{[^}]*\}$/.test(value) ||
    /^<[^>]*>$/.test(value) ||
    /^\{\{[^}]*\}\}$/.test(value) ||
    ['changeme', 'change_me', 'todo', 'example', 'password', 'secret', 'xxx', 'placeholder'].includes(
      normalized
    )
  )
}

/* ---------------------------------------------------------------- csv -- */

const CSV_COLUMN_ALIASES: Record<string, readonly string[]> = {
  host_ip: ['hostip', 'ip', 'ipaddress', 'dstip', 'dst', 'targetip', 'target', 'address', 'host'],
  hostname: [
    'hostname',
    'computername',
    'computer',
    'machine',
    'machinename',
    'netbiosname',
    'nodename'
  ],
  username: ['username', 'user', 'userid', 'login', 'account', 'samaccountname', 'accountname'],
  domain: ['domain', 'domainname', 'realm', 'netbiosdomain'],
  port: ['port', 'dport', 'destport', 'serviceport'],
  protocol: ['protocol', 'proto', 'transport'],
  service: ['service', 'servicename', 'product', 'application', 'app'],
  password: ['password', 'pass', 'pwd', 'passwd', 'cleartext', 'plaintext'],
  hash: ['hash', 'ntlm', 'ntlmhash', 'nthash', 'lmhash', 'hashes'],
  secret: ['secret', 'key', 'apikey', 'token'],
  credential_type: ['type', 'credentialtype', 'credtype'],
  os: ['os', 'operatingsystem', 'platform'],
  subnet: ['subnet', 'network', 'cidr'],
  state: ['state', 'status'],
  banner: ['banner', 'version', 'productversion', 'info'],
  notes: ['notes', 'note', 'comment', 'description']
}

type CsvColumn = keyof typeof CSV_COLUMN_ALIASES

function normalizeColumnName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_.-]+/g, '')
}

function resolveCsvColumn(normalizedHeader: string): CsvColumn | null {
  if (normalizedHeader.length === 0) return null
  for (const column of Object.keys(CSV_COLUMN_ALIASES) as CsvColumn[]) {
    if (CSV_COLUMN_ALIASES[column].includes(normalizedHeader)) return column
  }
  return null
}

function detectCsvDelimiter(headerLine: string): string | null {
  const candidates = [',', ';', '\t']
  let best: string | null = null
  let bestCount = 0
  for (const candidate of candidates) {
    const count = headerLine.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return bestCount > 0 ? best : null
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? ''
    if (inQuotes) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        current += character
      }
      continue
    }
    if (character === '"') {
      inQuotes = true
    } else if (character === delimiter) {
      fields.push(current)
      current = ''
    } else {
      current += character
    }
  }
  fields.push(current)
  return fields
}

function resolveCredentialType(raw: string, fallback: CredentialType): CredentialType {
  const normalized = raw.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (normalized.length === 0) return fallback
  if (['password', 'pass', 'plaintext', 'cleartext', 'plain'].includes(normalized)) {
    return 'password'
  }
  if (['ntlm', 'ntlmhash', 'nthash', 'hash', 'lmhash', 'ntlmv1'].includes(normalized)) {
    return 'ntlm_hash'
  }
  if (['netntlmv2', 'ntlmv2', 'netntlm'].includes(normalized)) return 'netntlmv2'
  if (['kerberos', 'kerberosticket', 'ticket', 'krb5', 'kirbi'].includes(normalized)) {
    return 'kerberos_ticket'
  }
  if (['sshkey', 'key', 'privatekey', 'idrsa', 'ided25519'].includes(normalized)) {
    return 'ssh_key'
  }
  if (['cert', 'certificate', 'x509', 'pem'].includes(normalized)) return 'cert'
  if (['apikey', 'api', 'token', 'bearer'].includes(normalized)) return 'api_key'
  return fallback
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw.trim())) return null
  const port = Number(raw.trim())
  return port >= 1 && port <= 65_535 ? port : null
}

function parseHostState(raw: string): InternalHostState | undefined {
  const value = raw.trim().toLowerCase()
  return (INTERNAL_HOST_STATES as readonly string[]).includes(value)
    ? (value as InternalHostState)
    : undefined
}

function parseServiceState(raw: string): ServiceState | undefined {
  const value = raw.trim().toLowerCase()
  return (SERVICE_STATES as readonly string[]).includes(value)
    ? (value as ServiceState)
    : undefined
}

/** Split `10.0.1.5:445` / `[fe80::1]:22` style cells into IP + optional port. */
function splitHostAndPort(raw: string): { host: string; port?: number } {
  const bracket = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(raw)
  if (bracket !== null) {
    const host = bracket[1] ?? ''
    const portText = bracket[2]
    if (portText !== undefined) {
      const port = Number(portText)
      if (port >= 1 && port <= 65_535) return { host, port }
    }
    return { host }
  }
  const withPort = /^([^:]+):(\d{1,5})$/.exec(raw)
  if (withPort !== null) {
    const host = withPort[1] ?? ''
    const port = Number(withPort[2])
    if (port >= 1 && port <= 65_535) return { host, port }
  }
  return { host: raw }
}

/** Extract the host part of a URL cell; returns the raw cell for plain values. */
function extractCellHost(raw: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  try {
    return new URL(raw).hostname.replace(/^\[/, '').replace(/\]$/, '')
  } catch {
    return raw
  }
}

function parseGenericCsvText(text: string, fileName: string): ParseOutcome {
  const outcome = emptyOutcome()
  const source = `generic-csv:${fileName}`
  const lines = splitBoundedLines(text, outcome.warnings)
  const headerIndex = lines.findIndex((line) => line.trim().length > 0)
  if (headerIndex < 0) {
    outcome.fatal = true
    outcome.warnings.push('CSV 文件为空')
    return outcome
  }

  const headerLine = lines[headerIndex] ?? ''
  const delimiter = detectCsvDelimiter(headerLine) ?? ','
  const headers = parseDelimitedLine(headerLine, delimiter)
  const columns = new Map<CsvColumn, number>()
  for (const [index, header] of headers.entries()) {
    const column = resolveCsvColumn(normalizeColumnName(header))
    if (column !== null && !columns.has(column)) columns.set(column, index)
  }
  if (columns.size === 0) {
    outcome.fatal = true
    outcome.warnings.push(
      'CSV 未识别到可用列（支持 host/ip、hostname、port、username、domain、password/hash 等）'
    )
    return outcome
  }

  let rows = 0
  let skippedLong = 0
  let invalidHosts = 0
  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] ?? ''
    if (rawLine.trim().length === 0) continue
    if (isLineTooLong(rawLine)) {
      skippedLong += 1
      continue
    }
    const fields = parseDelimitedLine(rawLine, delimiter)
    rows += 1
    const cell = (column: CsvColumn): string => {
      const index = columns.get(column)
      if (index === undefined) return ''
      return (fields[index] ?? '').trim()
    }

    const hostCell = extractCellHost(cell('host_ip'))
    const split = splitHostAndPort(hostCell)
    const hostIp = isValidIp(split.host) ? split.host : ''
    if (hostCell.length > 0 && hostIp.length === 0) invalidHosts += 1
    if (hostIp.length > 0) {
      const host: LootParsedHost = { ip: hostIp, state: 'unknown' }
      const hostname = cell('hostname')
      if (hostname.length > 0) host.hostname = hostname
      const os = cell('os')
      if (os.length > 0) host.os = os
      const subnetRaw = cell('subnet')
      if (subnetRaw.length > 0) {
        const subnet = normalizeCidr(subnetRaw)
        if (subnet !== null) host.subnet = subnet
      }
      const state = parseHostState(cell('state'))
      if (state !== undefined) host.state = state
      outcome.hosts.push(host)
    }

    const port = parsePort(cell('port')) ?? split.port ?? null
    if (hostIp.length > 0 && port !== null) {
      const service: LootParsedService = { host_ip: hostIp, port, state: 'open' }
      const protocol = cell('protocol').toLowerCase()
      if (protocol.length > 0) service.protocol = protocol
      const serviceName = cell('service')
      if (serviceName.length > 0) service.service = serviceName
      const banner = cell('banner')
      if (banner.length > 0) service.banner = banner
      const state = parseServiceState(cell('state'))
      if (state !== undefined) service.state = state
      outcome.services.push(service)
    }

    const password = cell('password')
    const hash = cell('hash')
    const genericSecret = cell('secret')
    const secret =
      password.length > 0 ? password : hash.length > 0 ? hash : genericSecret
    if (secret.length > 0) {
      if (secret.length > LOOT_PARSE_LIMITS.maxSecretLength) {
        outcome.warnings.push('CSV 中存在超过长度上限的 secret，已跳过')
        continue
      }
      const fallbackType: CredentialType =
        password.length > 0 ? 'password' : hash.length > 0 ? 'ntlm_hash' : 'other'
      const credential: LootParsedCredential = {
        type: resolveCredentialType(cell('credential_type'), fallbackType),
        secret,
        source,
        confidence: 'medium'
      }
      const username = cell('username')
      if (username.length > 0) credential.username = username
      const domain = cell('domain')
      if (domain.length > 0) credential.domain = domain
      if (hostIp.length > 0) credential.host_ip = hostIp
      if (port !== null) credential.service_port = port
      const notes = cell('notes')
      if (notes.length > 0) credential.notes = sliceOptional(notes, 10_000)
      outcome.credentials.push(credential)
    }
  }

  if (rows === 0) {
    outcome.fatal = true
    outcome.warnings.push('CSV 没有数据行')
    return outcome
  }
  if (invalidHosts > 0) {
    outcome.warnings.push(
      `CSV 中 ${invalidHosts} 行的 host/ip 不是合法 IP 字面量，未生成 internal host（ip 必填）`
    )
  }
  if (skippedLong > 0) outcome.warnings.push(`${skippedLong} 行 CSV 超过行长度上限，已跳过`)
  if (
    outcome.hosts.length === 0 &&
    outcome.services.length === 0 &&
    outcome.credentials.length === 0
  ) {
    outcome.fatal = true
    outcome.warnings.push('CSV 未解析出可用主机、服务或凭据')
  }
  return outcome
}
