/**
 * Project-level test-data export for the DSH Cortex UI.
 *
 *   POST /export/project -> cortex.export/v1 JSON, CSV, or DefectDojo Generic
 *   POST /export/assets  -> the same formats for an explicitly selected subset
 *
 * Design rules (security-sensitive):
 *  - The export is a read-only projection of the local SQLite database plus the
 *    additive asset identity sidecars (`asset_meta`, `asset_domains`,
 *    `miniapp_versions`, `asset_vuln_links`). Nothing is written back to SQLite.
 *  - It writes files to a directory the user explicitly chose, or under the
 *    plugin export root (`CORTEX_EXPORT_DIR` / `~/.cortex/exports/<stamp>`).
 *    Every generated file name is sanitized and the resolved target must stay
 *    inside that root (no `..`, no absolute file names).
 *  - The default export is redacted: leaked values, Cookie/Set-Cookie,
 *    Authorization and token/password/key-like fields are masked. Only an
 *    explicit `include_secrets: true` keeps raw values in the JSON format.
 *    CSV and DefectDojo exports always redact.
 *  - Exporting to files while the database is read-only is rejected with 403
 *    READ_ONLY, matching the rest of the write surface.
 *
 * This module never logs SQL, request headers, leaked values or absolute DB
 * paths.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { ApiError, badRequest, readJsonBody, sendJson } from '../http.js'
import { jsonArray, vulnDetail } from './vulns.js'
import { assetContext } from './assets.js'
import {
  getAssetMeta,
  listAssetDomains,
  listAssetMeta,
  listLinkedVulnIds,
  listMiniappVersions,
} from './asset-identity.js'
import { normalizeProjectName } from './normalize-asset.js'

export const EXPORT_SCHEMA = 'cortex.export/v1'
export const EXPORT_FORMATS = ['json', 'csv', 'defectdojo']
export const MAX_EXPORT_IDS = 500
export const MAX_PROJECT_NAME = 120
const MAX_OUTPUT_DIR = 1000
const MAX_URL_LENGTH = 8000

const REDACTED = '[REDACTED]'
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-csrf-token',
  'token',
  'secret',
  'password',
])

/** Property/parameter names that indicate a secret value. */
const SENSITIVE_NAME_RE =
  /(?:^|[^a-z0-9])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?|cookie|session(?:id)?|secret|password|passwd|pwd|api[_-]?key|apikey|private[_-]?key|credential|signature|sig)(?:[^a-z0-9]|$)/i

/** Values that are recognisably credentials even without a sensitive key. */
const SECRET_VALUE_RE = /^(?:sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{8,}\.)/

/* ------------------------------------------------------------------------- */
/* Redaction                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Mask credential-looking header lines and sensitive key/value pairs in a raw
 * HTTP request, response, URL, Markdown evidence or JSON body. This is a
 * best-effort textual scrubber; the structured field redaction below is the
 * primary control.
 * @param {unknown} value
 * @returns {string}
 */
export function redactText(value) {
  let text = value === null || value === undefined ? '' : String(value)
  if (text.length === 0) return ''

  // Header lines: `Cookie: ...`, `Authorization: Bearer ...`, `X-Api-Key: ...`
  text = text
    .split('\n')
    .map((line) => {
      const match = /^(\s*)([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*:\s*(.*)$/.exec(line)
      if (!match) return line
      if (!SENSITIVE_HEADERS.has(match[2].toLowerCase())) return line
      return `${match[1]}${match[2]}: ${REDACTED}`
    })
    .join('\n')

  // JSON object properties such as `"token":"..."` / `'password': '...'`.
  text = text.replace(
    /("([^"\\]|\\.)*"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    (whole, prefix, key) => (SENSITIVE_NAME_RE.test(key) ? `${prefix}"${REDACTED}"` : whole),
  )

  // URL query strings, form bodies and path parameters: `?token=...&a=1`.
  text = text.replace(/([?&;])([^=&\s;]+)=([^&\s;]*)/g, (whole, separator, name, rawValue) => {
    const decodedName = (() => {
      try {
        return decodeURIComponent(name)
      } catch {
        return name
      }
    })()
    if (!SENSITIVE_NAME_RE.test(decodedName)) return whole
    return `${separator}${name}=${REDACTED}`
  })

  return text
}

/**
 * Redact one leaked-info entry. The value never survives in a default export;
 * the metadata (type/source/impact) stays useful for triage.
 * @param {Record<string, any>} entry
 * @param {boolean} includeSecrets
 */
function redactLeak(entry, includeSecrets) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
  const next = { ...entry }
  if (!includeSecrets) next.value = REDACTED
  return next
}

/** Mask values of test-parameter candidates that look like credentials. */
function redactTestParameter(entry, includeSecrets) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
  if (includeSecrets) return { ...entry }
  const next = { ...entry }
  const name = String(next.name || '')
  const values = Array.isArray(next.values) ? next.values : []
  next.values = values.map((value) => {
    const text = String(value)
    return SENSITIVE_NAME_RE.test(name) || SECRET_VALUE_RE.test(text) ? REDACTED : value
  })
  return next
}

/**
 * Deep-ish asset copy with sensitive request/leak material masked.
 * @param {Record<string, any>} asset
 * @param {boolean} includeSecrets
 */
export function redactAsset(asset, includeSecrets = false) {
  const next = { ...(asset || {}) }
  next.interfaces = (Array.isArray(next.interfaces) ? next.interfaces : []).map((item) => {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? { ...item } : item
    if (!includeSecrets && entry && typeof entry === 'object' && typeof entry.request === 'string') {
      entry.request = redactText(entry.request)
    }
    return entry
  })
  next.leaked_infos = (Array.isArray(next.leaked_infos) ? next.leaked_infos : []).map((entry) =>
    redactLeak(entry, includeSecrets),
  )
  next.test_parameters = (Array.isArray(next.test_parameters) ? next.test_parameters : []).map((entry) =>
    redactTestParameter(entry, includeSecrets),
  )
  next.domains = Array.isArray(next.domains) ? next.domains.map((entry) => ({ ...entry })) : []
  next.versions = Array.isArray(next.versions) ? next.versions.map((entry) => ({ ...entry })) : []
  return next
}

/**
 * Redacted copy of a vulnerability. Retest results are append-only evidence, so
 * their conclusions are scrubbed while the time range is preserved.
 * @param {Record<string, any>} vuln
 * @param {boolean} includeSecrets
 */
export function redactVulnerability(vuln, includeSecrets = false) {
  const next = { ...(vuln || {}) }
  const scrub = (value) => (includeSecrets ? value : redactText(value))
  for (const key of ['description', 'impact', 'test_boundaries', 'crypto_details', 'reproduction_steps']) {
    next[key] = scrub(next[key])
  }
  next.affected_interfaces = (Array.isArray(next.affected_interfaces) ? next.affected_interfaces : []).map(scrub)
  next.remediation = (Array.isArray(next.remediation) ? next.remediation : []).map(scrub)
  next.retest_results = (Array.isArray(next.retest_results) ? next.retest_results : []).map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
    return { ...entry, conclusion: includeSecrets ? entry.conclusion : redactText(entry.conclusion) }
  })
  return next
}

/* ------------------------------------------------------------------------- */
/* CSV                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Escape one CSV cell. Leading `= + - @` (and tab/CR) are prefixed with `'` to
 * neutralise spreadsheet formula injection; quotes/newlines are RFC-4180
 * quoted.
 * @param {unknown} value
 * @returns {string}
 */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

/** @param {string[]} headers @param {unknown[][]} rows */
function toCsv(headers, rows) {
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')
    .concat('\r\n')
}

/** @param {Record<string, any>[]} assets */
export function assetsCsv(assets) {
  const headers = [
    'asset_id',
    'kind',
    'external_id',
    'display_name',
    'appid',
    'platform',
    'project_name',
    'host_port',
    'host',
    'primary_domain',
    'status',
    'tech_stack',
    'auth_required',
    'interface_count',
    'leak_count',
    'related_vuln_count',
    'last_seen',
    'domains',
    'versions',
  ]
  const rows = (Array.isArray(assets) ? assets : []).map((asset) => [
    asset.asset_id,
    asset.kind,
    asset.external_id,
    asset.display_name,
    asset.appid,
    asset.platform,
    asset.project_name,
    asset.host_port,
    asset.host,
    asset.primary_domain,
    asset.status,
    asset.tech_stack,
    asset.auth_required,
    Array.isArray(asset.interfaces) ? asset.interfaces.length : 0,
    Array.isArray(asset.leaked_infos) ? asset.leaked_infos.length : 0,
    Array.isArray(asset.related_vuln_ids) ? asset.related_vuln_ids.length : 0,
    asset.last_seen,
    (asset.domains || []).map((domain) => `${domain.host} (${domain.role || 'api'})`).join('; '),
    (asset.versions || []).map((version) => version.version || version.package_sha256).join('; '),
  ])
  return toCsv(headers, rows)
}

/** @param {Record<string, any>[]} vulnerabilities */
export function vulnerabilitiesCsv(vulnerabilities) {
  const headers = [
    'id',
    'asset_ids',
    'host',
    'target_url',
    'severity',
    'status',
    'vuln_name',
    'vuln_type',
    'entry_point',
    'description',
    'impact',
    'reproduction_steps',
    'remediation',
    'retest_count',
    'created_at',
  ]
  const rows = (Array.isArray(vulnerabilities) ? vulnerabilities : []).map((vuln) => [
    vuln.id,
    (vuln.asset_ids || []).join('; '),
    vuln.host,
    vuln.target_url,
    vuln.severity,
    vuln.status,
    vuln.vuln_name,
    vuln.vuln_type,
    vuln.entry_point,
    vuln.description,
    vuln.impact,
    vuln.reproduction_steps,
    (vuln.remediation || []).join('; '),
    (vuln.retest_results || []).length,
    vuln.created_at,
  ])
  return toCsv(headers, rows)
}

/* ------------------------------------------------------------------------- */
/* DefectDojo Generic Findings Import                                        */
/* ------------------------------------------------------------------------- */

/**
 * Build a DefectDojo-compatible endpoint list for one finding. Only http(s)
 * origins/paths are emitted and query strings are stripped so tokens from test
 * URLs never leak into an integration export.
 * @param {string} targetUrl
 * @returns {string[]}
 */
export function defectDojoEndpoints(targetUrl) {
  let target
  try {
    target = new URL(String(targetUrl || ''))
  } catch {
    return []
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return []
  const path = target.pathname === '' ? '/' : target.pathname
  return [`${target.origin}${path}`]
}

/**
 * Build the Generic Findings Import envelope. Secrets are always redacted here:
 * CSV and DefectDojo output never carries raw credential material, even when
 * the caller asked for it.
 *
 * @param {{vulnerabilities: Record<string, any>[], assets: Record<string, any>[], exportedAt: string}} input
 */
export function buildDefectDojoExport({ vulnerabilities, assets, exportedAt }) {
  const vulnAssets = new Map()
  for (const asset of Array.isArray(assets) ? assets : []) {
    for (const id of Array.isArray(asset.related_vuln_ids) ? asset.related_vuln_ids : []) {
      const list = vulnAssets.get(id) || []
      list.push(String(asset.asset_id || asset.host_port || ''))
      vulnAssets.set(id, list)
    }
  }
  const findings = (Array.isArray(vulnerabilities) ? vulnerabilities : []).map((vuln) => {
    const redacted = redactVulnerability(vuln, false)
    const assetIds = [...new Set([
      ...(Array.isArray(vuln.asset_ids) ? vuln.asset_ids : []),
      ...(vulnAssets.get(String(vuln.id)) || []),
    ].filter(Boolean))]
    const description = [
      redacted.description,
      redacted.reproduction_steps ? `### Reproduction\n\n${redacted.reproduction_steps}` : '',
    ]
      .filter((part) => String(part || '').trim().length > 0)
      .join('\n\n')
    return {
      title: String(redacted.vuln_name || redacted.id || 'Cortex finding').slice(0, 500),
      description: description.slice(0, 50_000),
      severity: ['Critical', 'High', 'Medium', 'Low', 'Info'].includes(redacted.severity)
        ? redacted.severity
        : 'Info',
      mitigation: (redacted.remediation || []).join('\n').slice(0, 50_000),
      impact: String(redacted.impact || '').slice(0, 50_000),
      references: [`cortex:vulnerability:${redacted.id}`, assetIds.length > 0 ? `cortex:assets:${assetIds.join(',')}` : '']
        .filter(Boolean)
        .join('\n'),
      date: String(redacted.created_at || exportedAt || new Date().toISOString()).slice(0, 40),
      vuln_id_from_tool: String(redacted.vuln_type || 'Unclassified').slice(0, 100),
      unique_id_from_tool: String(redacted.id || '').slice(0, 200),
      endpoints: defectDojoEndpoints(redacted.target_url),
      active: true,
      verified: redacted.status === 'Confirmed' || redacted.status === 'Retest_Passed',
    }
  })
  return { findings }
}

/* ------------------------------------------------------------------------- */
/* File naming / paths                                                       */
/* ------------------------------------------------------------------------- */

/** Safe single path segment (no separators, no leading dots, bounded length). */
export function sanitizeFileName(name, fallback = 'export') {
  const base = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, '_')
    .slice(0, 120)
  return base.length > 0 ? base : fallback
}

/** ASCII project slug used only for the default export directory name. */
function projectSlug(projectName) {
  const slug = String(projectName || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug.length > 0 ? slug : 'project'
}

function timestampSlug(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-')
}

/**
 * Resolve the output directory. An explicitly supplied directory is honoured
 * (must be absolute or `~`-relative); otherwise a fresh stamped directory is
 * created under the configured export root.
 * @param {string|undefined} outputDir
 * @param {string} projectName
 * @param {Date} now
 * @returns {{directory: string, explicit: boolean, root: string}}
 */
export function resolveExportDirectory(outputDir, projectName, now = new Date()) {
  const root = process.env.CORTEX_EXPORT_DIR
    ? resolve(String(process.env.CORTEX_EXPORT_DIR))
    : join(homedir(), '.cortex', 'exports')
  if (typeof outputDir === 'string' && outputDir.trim().length > 0) {
    const raw = outputDir.trim()
    if (raw.length > MAX_OUTPUT_DIR) {
      throw badRequest('output_dir is too long', { field: 'output_dir', max: MAX_OUTPUT_DIR })
    }
    const expanded = raw.startsWith('~') ? join(homedir(), raw.replace(/^~[/\\]?/, '')) : raw
    if (!isAbsolute(expanded)) {
      throw badRequest('output_dir must be an absolute path', { field: 'output_dir' })
    }
    return { directory: resolve(expanded), explicit: true, root }
  }
  return {
    directory: join(root, `${timestampSlug(now)}-${projectSlug(projectName)}`),
    explicit: false,
    root,
  }
}

/**
 * Join a generated relative file name to the export directory and prove the
 * result remains inside it (defence against traversal in generated names).
 * @param {string} directory
 * @param {string} relativeName
 */
export function safeExportPath(directory, relativeName) {
  const parts = String(relativeName || '')
    .split(/[\\/]+/)
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .map((part) => sanitizeFileName(part, 'file'))
  if (parts.length === 0) throw badRequest('export file name is empty')
  const base = resolve(directory)
  const target = resolve(base, ...parts)
  if (target !== base && !target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) {
    throw new ApiError(400, 'EXPORT_PATH_INVALID', 'export file path escapes the output directory')
  }
  return { path: target, relative: parts.join('/') }
}

/* ------------------------------------------------------------------------- */
/* Scope + payload builders                                                  */
/* ------------------------------------------------------------------------- */

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/** @param {Record<string, unknown>} body @param {string} field @param {number} max */
function idList(body, field, max = MAX_EXPORT_IDS) {
  const value = body[field]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw badRequest(`${field} must be an array`, { field })
  if (value.length > max) throw badRequest(`${field} has too many entries`, { field, max })
  const ids = []
  for (const item of value) {
    if (typeof item !== 'string') throw badRequest(`${field} entries must be strings`, { field })
    const id = item.trim()
    if (id.length === 0 || id.length > 4000) {
      throw badRequest(`${field} entries must be 1-4000 characters`, { field })
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** @param {Record<string, unknown>} body @param {string} field */
function boolField(body, field) {
  const value = body[field]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw badRequest(`${field} must be a boolean`, { field })
  return value
}

/** @param {Record<string, unknown>} body */
function formatField(body) {
  if (body.format === undefined || body.format === null) return 'json'
  const value = String(body.format).trim().toLowerCase()
  if (value === 'defect-dojo') return 'defectdojo'
  if (!EXPORT_FORMATS.includes(value)) {
    throw badRequest('format must be json, csv or defectdojo', {
      field: 'format',
      allowed: EXPORT_FORMATS,
    })
  }
  return value
}

/** @param {Record<string, unknown>} body @param {boolean} required */
function projectField(body, required) {
  const value = body.project_name
  if (value === undefined || value === null) {
    if (required) throw badRequest('project_name is required', { field: 'project_name' })
    return ''
  }
  if (typeof value !== 'string') throw badRequest('project_name must be a string', { field: 'project_name' })
  const name = value.trim()
  if (required && name.length === 0) {
    throw badRequest('project_name is required', { field: 'project_name' })
  }
  if (name.length > MAX_PROJECT_NAME) {
    throw badRequest('project_name is too long', { field: 'project_name', max: MAX_PROJECT_NAME })
  }
  return name
}

/**
 * Collect the asset rows for a project, including sidecar-only assets whose
 * legacy `assets` row is missing. The caller already checked DB availability.
 * @param {any} db
 * @param {string} projectName
 */
function projectAssetEntries(db, projectName) {
  const entries = []
  const seen = new Set()
  const metaByKey = listAssetMeta(db)
  let rows = []
  try {
    rows = db.prepare('SELECT * FROM assets WHERE project_name = ?').all(projectName)
  } catch {
    rows = []
  }
  for (const row of rows) {
    const key = String(row.host_port)
    seen.add(key)
    entries.push({ key, row, meta: metaByKey.get(key) || null })
  }
  for (const [key, meta] of metaByKey) {
    if (seen.has(key)) continue
    if (String(meta.project_name || '') !== projectName) continue
    seen.add(key)
    entries.push({ key, row: null, meta })
  }
  return entries
}

/** @param {any} db @param {string[]} assetIds */
function selectedAssetEntries(db, assetIds) {
  const entries = []
  const missing = []
  for (const id of assetIds) {
    const row = db.prepare('SELECT * FROM assets WHERE host_port = ?').get(id) || null
    const meta = getAssetMeta(db, id)
    if (!row && !meta) {
      missing.push(id)
      continue
    }
    entries.push({ key: id, row, meta })
  }
  return { entries, missing }
}

/** @param {any} db @param {string} projectName @returns {string[]} */
function projectVulnerabilityIds(db, projectName) {
  const ids = new Set()
  for (const entry of projectAssetEntries(db, projectName)) {
    const rowIds = stringArray(jsonArray(entry.row && entry.row.related_vuln_ids))
    for (const id of rowIds) ids.add(id)
    for (const id of listLinkedVulnIds(db, entry.key)) ids.add(id)
  }
  try {
    for (const row of db
      .prepare('SELECT related_vuln_ids FROM snapshot_sessions WHERE project_name = ?')
      .all(projectName)) {
      for (const id of stringArray(jsonArray(row.related_vuln_ids))) ids.add(id)
    }
  } catch {
    /* snapshots are optional for older/partial databases */
  }
  return [...ids]
}

/** @param {any} db @param {string[]} ids */
function loadVulnerabilities(db, ids) {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
  if (unique.length === 0) return []
  const placeholders = unique.map(() => '?').join(', ')
  const rows = db.prepare(`SELECT * FROM vulnerabilities WHERE id IN (${placeholders})`).all(...unique)
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  return unique.map((id) => byId.get(id)).filter(Boolean)
}

/**
 * Build the versioned JSON envelope (already redacted where requested).
 * @param {{projectName:string, assets:Record<string,any>[], vulnerabilities:Record<string,any>[], exportedAt:string, warnings:string[]}} input
 */
export function buildProjectJsonExport({ projectName, assets, vulnerabilities, exportedAt, warnings = [] }) {
  const assetIds = new Set(assets.map((asset) => String(asset.asset_id || asset.host_port || '')))
  const vulnIds = new Set(vulnerabilities.map((vuln) => String(vuln.id || '')))
  const assetVulns = []
  for (const asset of assets) {
    const assetId = String(asset.asset_id || asset.host_port || '')
    for (const vulnId of asset.related_vuln_ids || []) {
      if (vulnIds.has(String(vulnId))) assetVulns.push({ asset_id: assetId, vuln_id: String(vulnId) })
    }
  }
  const assetDomains = []
  for (const asset of assets) {
    const assetId = String(asset.asset_id || asset.host_port || '')
    for (const domain of asset.domains || []) {
      assetDomains.push({ asset_id: assetId, host: String(domain.host || ''), role: String(domain.role || '') })
    }
  }
  const miniappVersions = []
  for (const asset of assets) {
    const assetId = String(asset.asset_id || asset.host_port || '')
    for (const version of asset.versions || []) {
      miniappVersions.push({
        asset_id: assetId,
        version: String(version.version || ''),
        package_sha256: String(version.package_sha256 || ''),
      })
    }
  }
  return {
    schema: EXPORT_SCHEMA,
    exported_at: exportedAt,
    project: {
      name: projectName,
      asset_count: assets.length,
      vulnerability_count: vulnerabilities.length,
    },
    assets,
    vulnerabilities,
    relationships: {
      asset_vulnerabilities: assetVulns,
      asset_domains: assetDomains,
      miniapp_versions: miniappVersions,
    },
    counts: {
      assets: assets.length,
      vulnerabilities: vulnerabilities.length,
      relationships: assetVulns.length + assetDomains.length + miniappVersions.length,
      evidence: 0,
      unique_assets: assetIds.size,
    },
    warnings,
  }
}

/** Redacted Markdown evidence for one finding. */
export function buildEvidenceMarkdown(vuln) {
  const lines = [
    `# ${vuln.vuln_name || vuln.id}`,
    '',
    `- ID: ${vuln.id}`,
    `- Host: ${vuln.host}`,
    `- Target: ${vuln.target_url}`,
    `- Severity: ${vuln.severity}`,
    `- Status: ${vuln.status}`,
    `- Type: ${vuln.vuln_type}`,
    '',
    '## Description',
    '',
    vuln.description || '(none)',
    '',
    '## Impact',
    '',
    vuln.impact || '(none)',
    '',
    '## Reproduction',
    '',
    vuln.reproduction_steps || '(none)',
    '',
    '## Remediation',
    '',
    ...(Array.isArray(vuln.remediation) && vuln.remediation.length > 0
      ? vuln.remediation.map((item) => `- ${item}`)
      : ['(none)']),
    '',
  ]
  for (const [index, result] of (vuln.retest_results || []).entries()) {
    lines.push(`## Retest ${index + 1}`, '', `Time: ${result.time_range}`, '', result.conclusion || '', '')
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------------- */
/* Handler                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Build both the projection and the files on disk.
 * @param {{holder:any, config:any, mode:'project'|'assets', body:Record<string,unknown>}} input
 */
async function exportToFiles({ holder, config, mode, body }) {
  if (config && config.readOnly) {
    throw new ApiError(403, 'READ_ONLY', 'database is opened in read-only mode')
  }
  if (holder.readOnly || holder.readOnlyFallback) {
    throw new ApiError(403, 'READ_ONLY', 'database is opened in read-only mode')
  }
  const format = formatField(body)
  const includeEvidence = boolField(body, 'include_evidence')
  const includeSecrets = boolField(body, 'include_secrets')
  const projectName = projectField(body, mode === 'project')
  const assetIds = idList(body, 'asset_ids')
  const vulnIds = idList(body, 'vuln_ids')
  const outputDir =
    body.output_dir === undefined || body.output_dir === null ? '' : String(body.output_dir).trim()
  if (typeof body.output_dir !== 'undefined' && body.output_dir !== null && typeof body.output_dir !== 'string') {
    throw badRequest('output_dir must be a string', { field: 'output_dir' })
  }
  if (mode === 'assets' && assetIds.length === 0 && vulnIds.length === 0) {
    throw badRequest('asset_ids or vuln_ids is required', { field: 'asset_ids' })
  }

  const db = holder.db
  const warnings = []
  let entries = []
  let missingAssetIds = []
  if (assetIds.length > 0) {
    const selected = selectedAssetEntries(db, assetIds)
    entries = selected.entries
    missingAssetIds = selected.missing
    if (mode === 'project' && projectName.length > 0) {
      entries = entries.filter((entry) => {
        const owner = entry.meta ? String(entry.meta.project_name || '') : String(entry.row.project_name || '')
        return owner === projectName
      })
    }
  } else if (mode === 'project') {
    entries = projectAssetEntries(db, projectName)
  }
  if (missingAssetIds.length > 0) {
    warnings.push(`${missingAssetIds.length} selected asset id(s) no longer exist and were skipped`)
  }

  const exportedAt = new Date().toISOString()
  const assets = entries.map((entry) => {
    const row = entry.row || {
      host_port: entry.key,
      host: '',
      project_name: entry.meta ? String(entry.meta.project_name || '') : projectName,
      tech_stack: '',
      auth_required: 0,
      status: 'Alive',
      interfaces: '[]',
      interface_dir: '[]',
      leaked_infos: '[]',
      test_parameters: '[]',
      related_vuln_ids: '[]',
      last_seen: '',
    }
    const context = assetContext(
      row,
      entry.meta || null,
      listAssetDomains(db, entry.key),
      listMiniappVersions(db, entry.key),
      listLinkedVulnIds(db, entry.key),
    )
    return redactAsset(context, includeSecrets)
  })

  const linkedVulnIds = new Set()
  for (const entry of entries) {
    for (const id of stringArray(jsonArray(entry.row && entry.row.related_vuln_ids))) linkedVulnIds.add(id)
    for (const id of listLinkedVulnIds(db, entry.key)) linkedVulnIds.add(id)
  }
  if (mode === 'project') {
    for (const id of projectVulnerabilityIds(db, projectName)) linkedVulnIds.add(id)
  }
  let wantedVulnIds = vulnIds.length > 0 ? vulnIds : [...linkedVulnIds]
  if (mode === 'assets' && vulnIds.length === 0) wantedVulnIds = [...linkedVulnIds]
  const rawVulns = loadVulnerabilities(db, wantedVulnIds)
  const vulnerabilities = rawVulns.map((row) => {
    const detail = vulnDetail(row)
    const assetIdSet = new Set()
    for (const entry of entries) {
      const candidate = entry.meta ? String(entry.meta.asset_key || '') : String(entry.key || '')
      const related = [
        ...stringArray(jsonArray(entry.row && entry.row.related_vuln_ids)),
        ...listLinkedVulnIds(db, entry.key),
      ]
      if (related.includes(String(detail.id))) assetIdSet.add(candidate)
    }
    return redactVulnerability({
      ...detail,
      asset_id: [...assetIdSet][0] || '',
      asset_ids: [...assetIdSet],
    }, includeSecrets)
  })

  if (assets.length === 0) warnings.push('no matching asset was found')
  if (vulnerabilities.length === 0) warnings.push('no matching vulnerability was found')
  if (format === 'csv' || format === 'defectdojo') {
    warnings.push('secrets and session headers are always redacted in CSV and DefectDojo exports')
  } else if (!includeSecrets) {
    warnings.push('secrets and session headers are redacted by default')
  } else {
    warnings.push('include_secrets=true: raw leaked values and request headers are included in the JSON export')
  }

  /** @type {{name:string, content:string}[]} */
  const files = []
  const exportJson = buildProjectJsonExport({
    projectName,
    assets,
    vulnerabilities,
    exportedAt,
    warnings,
  })
  if (format === 'json') {
    const name = `cortex-export-${projectSlug(projectName)}-${timestampSlug(new Date(exportedAt))}.json`
    files.push({ name, content: JSON.stringify(exportJson, null, 2) })
  } else if (format === 'csv') {
    // CSV is shared with spreadsheets and other tools: always redacted,
    // independently of the JSON include_secrets choice.
    files.push({ name: 'assets.csv', content: assetsCsv(assets.map((asset) => redactAsset(asset, false))) })
    files.push({
      name: 'vulnerabilities.csv',
      content: vulnerabilitiesCsv(vulnerabilities.map((vuln) => redactVulnerability(vuln, false))),
    })
  } else {
    files.push({
      name: 'defectdojo-findings.json',
      content: JSON.stringify(buildDefectDojoExport({ vulnerabilities, assets, exportedAt }), null, 2),
    })
  }

  let evidenceCount = 0
  if (includeEvidence) {
    for (const vuln of vulnerabilities) {
      files.push({
        name: `evidence/${sanitizeFileName(vuln.id, 'finding')}.md`,
        content: buildEvidenceMarkdown(vuln),
      })
      evidenceCount += 1
    }
  }

  const resolved = resolveExportDirectory(outputDir, projectName, new Date(exportedAt))
  const savedPaths = []
  const writtenFiles = []
  if (files.length > 0) {
    try {
      mkdirSync(resolved.directory, { recursive: true })
      for (const file of files) {
        const target = safeExportPath(resolved.directory, file.name)
        mkdirSync(dirname(target.path), { recursive: true })
        writeFileSync(target.path, file.content, 'utf8')
        savedPaths.push(target.path)
        writtenFiles.push({
          name: target.relative,
          format,
          bytes: Buffer.byteLength(file.content, 'utf8'),
        })
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      const code =
        error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
          ? error.code
          : 'WRITE_FAILED'
      throw new ApiError(
        resolved.explicit ? 400 : 500,
        'EXPORT_WRITE_FAILED',
        `cannot write export files (${code})`,
        { code },
      )
    }
  }

  return {
    ok: true,
    format,
    files: writtenFiles,
    savedPaths,
    counts: {
      assets: assets.length,
      vulnerabilities: vulnerabilities.length,
      evidence: evidenceCount,
      relationships:
        exportJson.relationships.asset_vulnerabilities.length +
        exportJson.relationships.asset_domains.length +
        exportJson.relationships.miniapp_versions.length,
      missing_assets: missingAssetIds.length,
    },
    warnings,
    directory: resolved.directory,
  }
}

/** POST /export/project -> exported project files. */
export async function handleProjectExport({ req, res, holder, config }) {
  const body = await readJsonBody(req)
  sendJson(res, 200, await exportToFiles({ holder, config, mode: 'project', body }))
}

/** POST /export/assets -> export an explicit selection of assets/findings. */
export async function handleAssetsExport({ req, res, holder, config }) {
  const body = await readJsonBody(req)
  sendJson(res, 200, await exportToFiles({ holder, config, mode: 'assets', body }))
}

export { MAX_URL_LENGTH, REDACTED }
