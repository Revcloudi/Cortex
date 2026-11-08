/**
 * Import extracted mini-program intelligence into the Cortex asset library.
 *
 * A mini-program is its own asset: identity is the appid (or package hash when
 * no appid exists), never the host of one of its API domains. Domains,
 * package/version evidence and the app metadata live in the additive
 * `asset_*` identity tables (v5-compatible), or, when the tables are absent,
 * the import creates them. Domain reuse never merges two mini-programs.
 *
 * Nothing here uploads package content or calls the network.
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import {
  ensureAssetIdentityTables,
  findMiniappMetaByExternalId,
  listAssetDomains,
  listMiniappVersions,
  upsertMiniappIdentity,
  withAssetWrite,
} from '../cortex/asset-identity.js'
import {
  normalizeInterfaces,
  normalizeLeaks,
  normalizeProjectName,
  normalizeTestParameters,
} from '../cortex/normalize-asset.js'

/** Domains that belong to the WeChat runtime / generic references, not the target. */
const NOISE_DOMAIN_PATTERNS = [
  /(^|\.)qq\.com$/i,
  /(^|\.)weixin\.qq\.com$/i,
  /(^|\.)servicewechat\.com$/i,
  /(^|\.)qpic\.cn$/i,
  /(^|\.)qlogo\.cn$/i,
  /(^|\.)w3\.org$/i,
  /(^|\.)schema\.org$/i,
  /(^|\.)example\.com$/i,
  /(^|\.)localhost$/i,
]

const MAX_INTERFACES = 200
const MAX_LEAKS = 100
const MAX_PARAMETERS = 100

function isNoiseDomain(host) {
  if (!host || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return NOISE_DOMAIN_PATTERNS.some((pattern) => pattern.test(host))
}

/**
 * Pick the asset host_port from overview domains (or an explicit value).
 * @param {Array<{host:string,count:number,examples?:string[]}>} domains
 * @returns {string} '' when no usable domain exists
 */
export function chooseAssetHostPort(domains) {
  const entries = Array.isArray(domains) ? domains : []
  const usable = entries.filter((entry) => entry && !isNoiseDomain(String(entry.host || '')))
  if (usable.length === 0) return ''
  const ranked = [...usable].sort((left, right) => {
    const leftHttps = (left.examples || []).some((value) => String(value).startsWith('https://'))
    const rightHttps = (right.examples || []).some((value) => String(value).startsWith('https://'))
    if (leftHttps !== rightHttps) return leftHttps ? -1 : 1
    return Number(right.count || 0) - Number(left.count || 0)
  })
  const host = String((ranked[0] && ranked[0].host) || '').trim().toLowerCase()
  if (host.length === 0) return ''
  const https = (ranked[0].examples || []).some((value) => String(value).startsWith('https://'))
  return `${https ? 'https' : 'http'}://${host}`
}

/** Build canonical interface entries from analyzer endpoint candidates. */
export function buildInterfaces(endpoints) {
  const candidates = []
  for (const item of Array.isArray(endpoints) ? endpoints : []) {
    if (!item) continue
    let path = String(item.path || '').trim()
    if (path.length === 0) continue
    if (path.length > 2000) path = path.slice(0, 2000)
    let params = ''
    const queryIndex = path.indexOf('?')
    if (queryIndex >= 0) {
      params = path.slice(queryIndex + 1)
      path = path.slice(0, queryIndex)
    }
    if (path.length === 0 || !path.startsWith('/')) continue
    const entry = { path }
    const method = String(item.method || '').toUpperCase()
    if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)) entry.method = method
    if (params.length > 0) entry.params = params
    candidates.push(entry)
  }
  return normalizeInterfaces(candidates).slice(0, MAX_INTERFACES)
}

/** Build leaked-info entries from analyzer secrets (never logs the value). */
export function buildLeaks(secrets, appid) {
  const entries = []
  for (const item of Array.isArray(secrets) ? secrets : []) {
    if (!item || typeof item.value !== 'string' || item.value.trim().length === 0) continue
    const source = `${String(item.source || 'unknown')}${item.line ? `:${item.line}` : ''}`
    entries.push({
      info_type: ['Credential', 'API_Key', 'Token', 'PII', 'Internal_IP', 'Other'].includes(item.info_type)
        ? item.info_type
        : 'Other',
      value: item.value,
      source: `miniapp:${appid}:${source}`,
      potential_impact:
        String(item.potential_impact || '').trim() ||
        '小程序包内硬编码的凭据/密钥，可能被用于伪造请求或访问后端资源',
    })
  }
  return normalizeLeaks(entries).slice(0, MAX_LEAKS)
}

/** Build canonical test-parameter seeds from analyzer candidates. */
export function buildTestParameters(parameters, appid) {
  const entries = []
  for (const item of Array.isArray(parameters) ? parameters : []) {
    if (!item) continue
    entries.push({
      name: item.name,
      endpoint: item.endpoint,
      location: item.location,
      values: Array.isArray(item.values) ? item.values : [],
      source: `miniapp:${appid}:${String(item.source || '')}`,
      pattern: item.pattern,
    })
  }
  return normalizeTestParameters(entries).slice(0, MAX_PARAMETERS)
}

function readJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function uniqueMerge(existingRaw, additions) {
  const merged = [...readJsonArray(existingRaw)]
  const seen = new Set(merged.map((entry) => JSON.stringify(entry)))
  for (const entry of Array.isArray(additions) ? additions : []) {
    const key = JSON.stringify(entry)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  return merged
}

/**
 * Merge one source's extracted intelligence into the asset library.
 *
 * @param {{holder:any, source:any, overview:any, projectName?:string, hostPort?:string}} input
 * @returns {{ok:boolean, project:string, assets:Array<object>, totals:object, warnings:string[]}}
 */
export async function importMiniappAssets(input) {
  const holder = input && input.holder
  const source = input && input.source
  const overview = input && input.overview
  if (!holder || !source || !overview) throw new Error('holder, source and overview are required')
  if (typeof holder.ensure === 'function') holder.ensure()
  if (typeof holder.assertUsable === 'function') holder.assertUsable()
  if (holder.readOnly) throw new Error('Cortex database is in read-only mode; asset import rejected.')
  if (typeof holder.assertWritable === 'function') holder.assertWritable()

  const appid = String(source.appid || '').trim()
  const version = String(source.version || '').trim()
  const platform = String(source.platform || 'wechat').trim().toLowerCase() || 'wechat'
  const packageHash =
    String(source.package_hash || '').trim() ||
    createHash('sha256')
      .update(`${appid}|${version}|${String(source.package_dir || '')}`)
      .digest('hex')
  const externalId = appid || packageHash
  const displayName = String(source.app_name || '').trim() || appid || `miniapp ${externalId.slice(0, 12)}`

  const db = holder.db
  if (!db) throw new Error('Cortex database is unavailable')
  ensureAssetIdentityTables(db)

  const existingIdentity = findMiniappMetaByExternalId(db, { platform, externalId })
  const explicitProject =
    input.projectName !== undefined && input.projectName !== null && String(input.projectName).trim().length > 0
      ? String(input.projectName)
      : ''
  const project = normalizeProjectName(
    explicitProject || String(existingIdentity?.project_name || '') || `小程序 ${externalId.slice(0, 12)}`,
  )

  const interfaces = buildInterfaces(overview.endpoints)
  const leaks = buildLeaks(overview.secrets, appid || externalId)
  const parameters = buildTestParameters(overview.parameters, appid || externalId)
  const domains = []
  for (const entry of Array.isArray(overview.domains) ? overview.domains : []) {
    const host = String((entry && entry.host) || '').trim().toLowerCase()
    if (host.length === 0 || isNoiseDomain(host)) continue
    if (domains.some((candidate) => candidate.host === host)) continue
    domains.push({ host, count: Number(entry.count || 0), examples: Array.isArray(entry.examples) ? entry.examples : [] })
  }
  domains.sort((left, right) => {
    const leftHttps = left.examples.some((value) => String(value).startsWith('https://'))
    const rightHttps = right.examples.some((value) => String(value).startsWith('https://'))
    if (leftHttps !== rightHttps) return leftHttps ? -1 : 1
    return right.count - left.count
  })

  const warnings = []
  if (!appid) warnings.push('appid was not detected; using the package hash as the asset identity (low confidence)')
  if (domains.length === 0) warnings.push('no business domain was extracted; the mini-program asset is still created')
  if (interfaces.length === 0) warnings.push('no endpoint candidates were extracted')
  if (leaks.length === 0) warnings.push('no hard-coded secret was extracted')
  if (parameters.length === 0) warnings.push('no test-parameter candidate was extracted')
  if (input.hostPort !== undefined && input.hostPort !== null && String(input.hostPort).trim().length > 0) {
    warnings.push('host_port is deprecated for mini-programs; domains are stored on the mini-program asset')
  }
  const legacy = db
    .prepare(
      `SELECT host_port FROM assets
        WHERE host_port NOT LIKE 'miniapp:%' AND tech_stack LIKE ?
        ORDER BY last_seen DESC LIMIT 1`,
    )
    .get(`%wechat-miniapp ${externalId}%`)
  if (legacy) {
    warnings.push(
      `legacy host asset ${legacy.host_port} was left unchanged; the mini-program asset is separate`,
    )
  }

  const write = await withAssetWrite(db, () => {
    const identity = upsertMiniappIdentity(db, {
      projectName: project,
      appid,
      appName: displayName,
      platform,
      version,
      packageHash,
      packageDir: String(source.package_dir || ''),
      domains,
      metadata: {
        source: 'miniapp',
        package_hash: packageHash,
        root_kind: String(source.root_kind || ''),
      },
    })
    const assetKey = identity.assetKey
    const existing = db.prepare('SELECT * FROM assets WHERE host_port = ?').get(assetKey)
    const primaryHost = domains[0]?.host || ''
    const marker = `wechat-miniapp ${externalId}${version ? `@${version}` : ''}`
    const techStack = existing && existing.tech_stack ? String(existing.tech_stack) : ''
    const nextTechStack =
      techStack.length === 0
        ? marker
        : techStack.toLowerCase().includes(marker.toLowerCase())
          ? techStack
          : `${techStack}, ${marker}`
    const mergedInterfaces = uniqueMerge(existing && existing.interfaces, interfaces)
    const mergedLeaks = uniqueMerge(existing && existing.leaked_infos, leaks)
    const mergedParameters = uniqueMerge(existing && existing.test_parameters, parameters)
    const now = new Date().toISOString()

    if (existing) {
      db.prepare(
        `UPDATE assets SET host = ?, project_name = ?, tech_stack = ?, status = 'Alive',
           interfaces = ?, leaked_infos = ?, test_parameters = ?, last_seen = ?
         WHERE host_port = ?`,
      ).run(
        existing.host || primaryHost || externalId,
        project,
        nextTechStack,
        JSON.stringify(mergedInterfaces),
        JSON.stringify(mergedLeaks),
        JSON.stringify(mergedParameters),
        now,
        assetKey,
      )
    } else {
      db.prepare(
        `INSERT INTO assets
           (host_port, host, project_name, tech_stack, auth_required, status,
            interfaces, leaked_infos, test_parameters, related_vuln_ids, last_seen)
         VALUES (?, ?, ?, ?, 0, 'Alive', ?, ?, ?, '[]', ?)`,
      ).run(
        assetKey,
        primaryHost || externalId,
        project,
        nextTechStack,
        JSON.stringify(mergedInterfaces),
        JSON.stringify(mergedLeaks),
        JSON.stringify(mergedParameters),
        now,
      )
    }
    return {
      identity,
      assetKey,
      existing,
      created: !existing,
      mergedInterfaces,
      mergedLeaks,
      mergedParameters,
      primaryHost,
      displayName,
    }
  })
  if (typeof holder.refreshFileStamp === 'function') holder.refreshFileStamp()

  return {
    ok: true,
    project,
    assets: [
      {
        asset_id: write.assetKey,
        host_port: write.assetKey,
        kind: 'miniapp',
        external_id: externalId,
        appid,
        platform,
        display_name: write.displayName,
        project_name: project,
        primary_domain: write.primaryHost,
        domains: listAssetDomains(db, write.assetKey),
        versions: listMiniappVersions(db, write.assetKey),
        created: write.created,
        interfaces: write.mergedInterfaces.length,
        leaks: write.mergedLeaks.length,
        parameters: write.mergedParameters.length,
      },
    ],
    totals: {
      assets: 1,
      interfaces: write.mergedInterfaces.length,
      leaks: write.mergedLeaks.length,
      parameters: write.mergedParameters.length,
      added_interfaces: interfaces.length,
      added_leaks: leaks.length,
      added_parameters: parameters.length,
    },
    warnings,
  }
}
/** Short label for the source package (no absolute path). */
export function miniappLabel(source) {
  const appid = String((source && source.appid) || 'unknown')
  const version = String((source && source.version) || '')
  const name = String((source && source.app_name) || '') || basename(String((source && source.package_dir) || ''))
  return `${appid}${version ? `@${version}` : ''}${name ? ` (${name})` : ''}`
}

