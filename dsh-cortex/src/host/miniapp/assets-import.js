/**
 * Import extracted mini-program intelligence into the existing Cortex asset
 * library (schema v5).
 *
 * The analyzer produces domains/endpoints/secrets/parameters from the unpacked
 * workspace; this module maps them onto the canonical asset shape and merges
 * them with the same semantics as `cortex_sync_asset_info`:
 *
 *   - `host_port` derived from the most-used business domain (https preferred),
 *   - `interfaces[]` from endpoint candidates (path/method/params),
 *   - `leaked_infos[]` from masked-verified hard-coded secrets (full value is
 *     persisted locally, never logged),
 *   - `test_parameters[]` from non-secret id/tenant/order candidates.
 *
 * Nothing here uploads package content or calls the network.
 */

import { basename } from 'node:path'
import { withBusyRetry } from '../db.js'
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
  const explicitHostPort =
    input.hostPort !== undefined && input.hostPort !== null ? String(input.hostPort).trim() : ''
  const hostPort = explicitHostPort || chooseAssetHostPort(overview.domains)
  const project = normalizeProjectName(
    input.projectName !== undefined && input.projectName !== null && String(input.projectName).trim().length > 0
      ? String(input.projectName)
      : `小程序 ${appid}`,
  )

  const interfaces = buildInterfaces(overview.endpoints)
  const leaks = buildLeaks(overview.secrets, appid)
  const parameters = buildTestParameters(overview.parameters, appid)

  const warnings = []
  if (!hostPort) {
    warnings.push('no business domain was extracted; provide host_port explicitly to create an asset')
    return {
      ok: false,
      project,
      assets: [],
      totals: { assets: 0, interfaces: interfaces.length, leaks: leaks.length, parameters: parameters.length },
      warnings,
    }
  }
  if (interfaces.length === 0) warnings.push('no endpoint candidates were extracted')
  if (leaks.length === 0) warnings.push('no hard-coded secret was extracted')
  if (parameters.length === 0) warnings.push('no test-parameter candidate was extracted')

  const db = holder.db
  if (!db) throw new Error('Cortex database is unavailable')
  const existing = db.prepare('SELECT * FROM assets WHERE host_port = ?').get(hostPort)
  const now = new Date().toISOString()
  const techStack = existing && existing.tech_stack ? String(existing.tech_stack) : ''
  const marker = `wechat-miniapp ${appid}${version ? `@${version}` : ''}`
  const nextTechStack =
    techStack.length === 0
      ? marker
      : techStack.toLowerCase().includes(marker.toLowerCase())
        ? techStack
        : `${techStack}, ${marker}`
  const projectName =
    !existing || !String(existing.project_name || '').trim() ? project : normalizeProjectName(existing.project_name)
  const mergedInterfaces = uniqueMerge(existing && existing.interfaces, interfaces)
  const mergedLeaks = uniqueMerge(existing && existing.leaked_infos, leaks)
  const mergedParameters = uniqueMerge(existing && existing.test_parameters, parameters)

  await withBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (existing) {
        db.prepare(
          `UPDATE assets SET host = ?, project_name = ?, tech_stack = ?, status = 'Alive',
             interfaces = ?, leaked_infos = ?, test_parameters = ?, last_seen = ?
           WHERE host_port = ?`,
        ).run(
          existing.host || hostPort.replace(/^https?:\/\//, ''),
          projectName,
          nextTechStack,
          JSON.stringify(mergedInterfaces),
          JSON.stringify(mergedLeaks),
          JSON.stringify(mergedParameters),
          now,
          hostPort,
        )
      } else {
        db.prepare(
          `INSERT INTO assets
             (host_port, host, project_name, tech_stack, auth_required, status,
              interfaces, leaked_infos, test_parameters, related_vuln_ids, last_seen)
           VALUES (?, ?, ?, ?, 0, 'Alive', ?, ?, ?, '[]', ?)`,
        ).run(
          hostPort,
          hostPort.replace(/^https?:\/\//, ''),
          projectName,
          nextTechStack,
          JSON.stringify(mergedInterfaces),
          JSON.stringify(mergedLeaks),
          JSON.stringify(mergedParameters),
          now,
        )
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw error
    }
  })
  if (typeof holder.refreshFileStamp === 'function') holder.refreshFileStamp()

  return {
    ok: true,
    project: projectName,
    assets: [
      {
        host_port: hostPort,
        created: !existing,
        interfaces: mergedInterfaces.length,
        leaks: mergedLeaks.length,
        parameters: mergedParameters.length,
      },
    ],
    totals: {
      assets: 1,
      interfaces: mergedInterfaces.length,
      leaks: mergedLeaks.length,
      parameters: mergedParameters.length,
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
