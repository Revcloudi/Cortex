/**
 * Defensive normalizers for agent-written asset JSON.
 *
 * MCP-era skills asked agents for one canonical shape; with the plugin tools
 * the model sometimes writes aliases (`raw` instead of `request`, `type`/`file`
 * instead of `info_type`/`source`, `param`/`where`/`example` instead of
 * `name`/`location`/`values`). The original renderer and the memory-graph
 * builder assume the canonical shape, so malformed-but-useful records used to
 * crash the asset drawer / the nebula graph. Normalize on read and on write.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']
export const LEAKED_INFO_TYPES = [
  'Credential',
  'API_Key',
  'Token',
  'PII',
  'Internal_IP',
  'Other',
]
export const TEST_PARAMETER_LOCATIONS = ['path', 'query', 'body', 'header', 'cookie']

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const pick = (...values) => {
  for (const value of values) {
    const candidate = text(value)
    if (candidate.length > 0) return candidate
  }
  return ''
}

export function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

/** Pull the query string / body out of a captured raw HTTP request. */
export function extractParamsFromRaw(raw) {
  const source = text(raw).replace(/\r\n/g, '\n')
  if (source.length === 0) return ''
  const lines = source.split('\n')
  const requestLine = lines[0] || ''
  const queryIndex = requestLine.indexOf('?')
  const query = queryIndex >= 0 ? requestLine.slice(queryIndex).trim() : ''
  const separator = source.indexOf('\n\n')
  const body = separator >= 0 ? source.slice(separator + 2).trim() : ''
  return [query, body].filter((part) => part.length > 0).join('\n')
}

/** @returns {{path:string, method?:string, params?:string, request?:string}|null} */
export function normalizeInterface(raw) {
  if (typeof raw === 'string') {
    const path = raw.trim()
    return path.length > 0 ? { path } : null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const path = pick(raw.path, raw.url, raw.route, raw.endpoint)
  if (path.length === 0) return null
  const entry = { path }
  const method = pick(raw.method).toUpperCase()
  if (HTTP_METHODS.includes(method)) entry.method = method
  const request = pick(raw.request, raw.raw, raw.http)
  const params = pick(raw.params, raw.parameters, raw.query, raw.data) || extractParamsFromRaw(request)
  if (params.length > 0) entry.params = params
  if (request.length > 0) entry.request = request
  return entry
}

/** @returns {Array<{path:string, method?:string, params?:string, request?:string}>} */
export function normalizeInterfaces(raw, interfaceDir) {
  const result = []
  const seen = new Set()
  const push = (entry) => {
    if (!entry) return
    const key = `${entry.method || ''}\u0000${entry.path}`
    if (seen.has(key)) return
    seen.add(key)
    result.push(entry)
  }
  for (const item of parseJsonArray(raw)) push(normalizeInterface(item))
  for (const item of parseJsonArray(interfaceDir)) {
    const path = text(item)
    if (path.length > 0) push(normalizeInterface({ path }))
  }
  return result
}

/** @returns {{info_type:string, value:string, source:string, potential_impact:string}} */
export function normalizeLeak(raw) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const rawType = pick(item.info_type, item.infoType, item.type, item.kind, item.category)
  const infoType = LEAKED_INFO_TYPES.includes(rawType)
    ? rawType
    : rawType === 'public_config' || rawType === 'config'
      ? 'Other'
      : 'Other'
  return {
    info_type: infoType,
    value: pick(item.value, item.content, item.data, item.secret, item.example),
    source: pick(item.source, item.file, item.where, item.url, item.path, item.endpoint),
    potential_impact: pick(item.potential_impact, item.potentialImpact, item.impact, item.note),
  }
}

/** @returns {Array<ReturnType<typeof normalizeLeak>>} */
export function normalizeLeaks(raw) {
  const result = []
  for (const item of parseJsonArray(raw)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const leak = normalizeLeak(item)
    if (leak.value.length === 0 && leak.source.length === 0) continue
    result.push(leak)
  }
  return result
}

/** @returns {object|null} canonical TestParameterCandidate */
export function normalizeTestParameter(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = pick(raw.name, raw.param, raw.key)
  const endpoint = pick(raw.endpoint, raw.interface, raw.api, raw.path)
  const values = Array.isArray(raw.values)
    ? raw.values.filter((value) => typeof value === 'string' || typeof value === 'number').map(String)
    : [pick(raw.example, raw.example_value, raw.value, raw.sample)].filter((value) => value.length > 0)
  const locationRaw = pick(raw.location, raw.where, raw.in).toLowerCase()
  const locationAliases = {
    json: 'body',
    form: 'body',
    formdata: 'body',
    post: 'body',
    query: 'query',
    querystring: 'query',
    url: 'query',
    header: 'header',
    headers: 'header',
    cookie: 'cookie',
    path: 'path',
  }
  const mappedLocation = locationAliases[locationRaw] || locationRaw
  const location = TEST_PARAMETER_LOCATIONS.includes(mappedLocation) ? mappedLocation : 'query'
  const source = pick(raw.source, raw.file, raw.interface, raw.endpoint)
  if (name.length === 0 && endpoint.length === 0 && values.length === 0) return null
  const entry = {
    name: name || 'value',
    endpoint: endpoint || source || '(unknown)',
    location,
    values: values.slice(0, 50),
    source: source || endpoint || '(unknown)',
    tested: raw.tested === true,
    related_vuln_ids: Array.isArray(raw.related_vuln_ids)
      ? raw.related_vuln_ids.filter((value) => typeof value === 'string' && value.trim().length > 0)
      : [],
  }
  const pattern = pick(raw.pattern)
  if (pattern.length > 0) entry.pattern = pattern
  const notes = pick(raw.notes, raw.note)
  if (notes.length > 0) entry.notes = notes
  return entry
}

/** @returns {Array<ReturnType<typeof normalizeTestParameter>>} */
export function normalizeTestParameters(raw) {
  const result = []
  const seen = new Set()
  for (const item of parseJsonArray(raw)) {
    const entry = normalizeTestParameter(item)
    if (!entry) continue
    const key = `${entry.endpoint}\u0000${entry.name}\u0000${entry.location}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

/** Normalize one raw asset row for API / graph consumers. */
export function normalizeAssetRow(row) {
  if (!row || typeof row !== 'object') return row
  return {
    ...row,
    interfaces: normalizeInterfaces(row.interfaces, row.interface_dir),
    leaked_infos: normalizeLeaks(row.leaked_infos),
    test_parameters: normalizeTestParameters(row.test_parameters),
    related_vuln_ids: parseJsonArray(row.related_vuln_ids).filter((value) => typeof value === 'string'),
  }
}
