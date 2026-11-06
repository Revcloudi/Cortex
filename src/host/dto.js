/**
 * Row -> DTO mappers (contract §2.5).
 *
 * Rules:
 *  - every field is always present; missing values fall back to '' / [] / 0 / null
 *  - JSON columns are parsed defensively; corrupt data degrades to the fallback
 *  - `credentials.secret` is NEVER serialized: only `secretMasked` + `secretLength`
 *  - column names are snake_case in SQLite, DTO keys are camelCase
 */

/** @param {unknown} value */
function text(value) {
  return value === null || value === undefined ? '' : String(value)
}

/** @param {unknown} value @returns {string|null} */
function nullableText(value) {
  return value === null || value === undefined ? null : String(value)
}

/** @param {unknown} value @param {number} fallback */
function int(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** @param {unknown} value */
function bool01(value) {
  return value === 1 || value === true || value === '1'
}

/**
 * Safe JSON parse with a type check. Corrupt JSON returns the fallback.
 * @param {unknown} raw
 * @param {Array|Record<string, unknown>|null} fallback
 * @returns {any}
 */
export function parseJson(raw, fallback) {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/**
 * Safe JSON array parse; corrupt JSON / wrong type -> [].
 * @param {unknown} raw
 * @returns {any[]}
 */
export function parseJsonArray(raw) {
  const parsed = parseJson(raw, null)
  return Array.isArray(parsed) ? parsed : []
}

/**
 * Safe JSON object parse; corrupt JSON / arrays -> null.
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
export function parseJsonObject(raw) {
  const parsed = parseJson(raw, null)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

/**
 * Coerce a JSON array (raw TEXT column or already-parsed array) into a list of
 * strings, dropping non-string entries.
 */
function stringArray(raw) {
  const list = Array.isArray(raw) ? raw : parseJsonArray(raw)
  return list.filter((item) => typeof item === 'string')
}

/** Coerce a string/number list (raw TEXT or already-parsed array) to strings. */
function valueArray(raw) {
  const list = Array.isArray(raw) ? raw : parseJsonArray(raw)
  return list
    .filter((item) => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item))
}

/* ------------------------------------------------------------------------- */
/* Vulns                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Normalize the append-only retest history. Cortex stores entries as
 * `{ time_range, conclusion }`; camelCase input is accepted defensively.
 * @param {unknown} raw
 * @returns {{timeRange:string, conclusion:string}[]}
 */
export function retestEntries(raw) {
  const out = []
  for (const entry of parseJsonArray(raw)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    out.push({
      timeRange: text(entry.timeRange ?? entry.time_range),
      conclusion: text(entry.conclusion),
    })
  }
  return out
}

/**
 * Latest retest marker. Cortex retest entries carry no timestamp column, only
 * the human-readable observation window, so the newest `timeRange` is exposed
 * as `latestRetestAt` (null when never retested).
 * @param {{timeRange:string}[]} retests
 */
function latestRetestAt(retests) {
  if (retests.length === 0) return null
  const last = retests[retests.length - 1]
  return last.timeRange.length > 0 ? last.timeRange : null
}

/** @param {Record<string, any>} row */
export function vulnSummary(row) {
  const source = row || {}
  const retests = retestEntries(source.retest_results)
  return {
    id: text(source.id),
    host: text(source.host),
    vulnName: text(source.vuln_name),
    vulnType: text(source.vuln_type),
    severity: text(source.severity),
    status: text(source.status),
    realm: text(source.realm) || 'web',
    serviceHost: text(source.service_host),
    targetUrl: text(source.target_url),
    entryPoint: text(source.entry_point),
    createdAt: nullableText(source.created_at),
    retestCount: retests.length,
    latestRetestAt: latestRetestAt(retests),
  }
}

/** @param {Record<string, any>} row */
export function vulnDetail(row) {
  const source = row || {}
  return {
    ...vulnSummary(source),
    description: text(source.description),
    impact: text(source.impact),
    affectedInterfaces: stringArray(source.affected_interfaces),
    reproductionSteps: text(source.reproduction_steps),
    remediation: stringArray(source.remediation),
    cryptoDetails: text(source.crypto_details),
    testBoundaries: text(source.test_boundaries),
    retestResults: retestEntries(source.retest_results),
    relatedVulnIds: stringArray(source.related_vuln_ids),
    internalServiceId: text(source.internal_service_id),
  }
}

/* ------------------------------------------------------------------------- */
/* Assets                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * @param {unknown} raw
 * @returns {{path:string, method?:string, params?:string, request?:string}[]}
 */
export function interfaceList(raw) {
  const out = []
  for (const item of parseJsonArray(raw)) {
    if (typeof item === 'string') {
      out.push({ path: item })
      continue
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    /** @type {{path:string, method?:string, params?:string, request?:string}} */
    const entry = { path: text(item.path) }
    if (item.method !== null && item.method !== undefined && String(item.method).length > 0) {
      entry.method = String(item.method)
    }
    if (item.params !== null && item.params !== undefined && String(item.params).length > 0) {
      entry.params = String(item.params)
    }
    if (item.request !== null && item.request !== undefined && String(item.request).length > 0) {
      entry.request = String(item.request)
    }
    out.push(entry)
  }
  return out
}

/** @param {unknown} raw */
export function leakedInfoList(raw) {
  const out = []
  for (const item of parseJsonArray(raw)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    out.push({
      infoType: text(item.infoType ?? item.info_type),
      value: text(item.value),
      source: text(item.source),
      potentialImpact: text(item.potentialImpact ?? item.potential_impact),
    })
  }
  return out
}

/** @param {unknown} raw */
export function testParameterList(raw) {
  const out = []
  for (const item of parseJsonArray(raw)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const relatedVulnIds = stringArray(item.relatedVulnIds ?? item.related_vuln_ids)
    /** @type {Record<string, any>} */
    const entry = {
      name: text(item.name),
      endpoint: text(item.endpoint),
      location: text(item.location),
      values: valueArray(item.values),
      source: text(item.source),
      tested: item.tested === true,
    }
    if (item.pattern !== null && item.pattern !== undefined && String(item.pattern).length > 0) {
      entry.pattern = String(item.pattern)
    }
    if (item.notes !== null && item.notes !== undefined && String(item.notes).length > 0) {
      entry.notes = String(item.notes)
    }
    if (relatedVulnIds.length > 0) entry.relatedVulnIds = relatedVulnIds
    out.push(entry)
  }
  return out
}

/** @param {Record<string, any>} row */
export function assetSummary(row) {
  const source = row || {}
  const interfaces = parseJsonArray(source.interfaces)
  const related = stringArray(source.related_vuln_ids)
  return {
    hostPort: text(source.host_port),
    host: text(source.host),
    projectName: text(source.project_name),
    techStack: text(source.tech_stack),
    authRequired: bool01(source.auth_required),
    status: text(source.status),
    lastSeen: nullableText(source.last_seen),
    interfaceCount: interfaces.length,
    vulnCount: related.length,
  }
}

/** @param {Record<string, any>} row */
export function assetDetail(row) {
  const source = row || {}
  return {
    ...assetSummary(source),
    interfaces: interfaceList(source.interfaces),
    interfaceDir: stringArray(source.interface_dir),
    leakedInfos: leakedInfoList(source.leaked_infos),
    testParameters: testParameterList(source.test_parameters),
    relatedVulnIds: stringArray(source.related_vuln_ids),
  }
}

/* ------------------------------------------------------------------------- */
/* Internal operations                                                       */
/* ------------------------------------------------------------------------- */

/**
 * @param {unknown} secret
 * @returns {string} masked preview only, never the real secret
 */
export function maskSecret(secret) {
  const value = text(secret)
  if (value.length === 0) return ''
  if (value.length <= 2) return '••'
  if (value.length <= 6) return '••••'
  return `${value.slice(0, 2)}••••${value.slice(-1)}`
}

/** @param {Record<string, any>} row @param {string[]} hostIds */
export function foothold(row, hostIds = []) {
  const source = row || {}
  return {
    id: text(source.id),
    entryHostPort: text(source.entry_host_port),
    entryVulnId: text(source.entry_vuln_id),
    accessType: text(source.access_type),
    privilegeLevel: text(source.privilege_level),
    status: text(source.status),
    evidence: text(source.evidence),
    notes: text(source.notes),
    establishedAt: text(source.established_at),
    lastVerifiedAt: text(source.last_verified_at),
    hostIds: Array.isArray(hostIds) ? hostIds.map((id) => String(id)) : [],
  }
}

/** @param {Record<string, any>} row */
export function internalHost(row) {
  const source = row || {}
  return {
    id: text(source.id),
    ip: text(source.ip),
    hostname: text(source.hostname),
    os: text(source.os),
    subnet: text(source.subnet),
    state: text(source.state),
    source: text(source.source),
    confidence: text(source.confidence),
    lastSeen: text(source.last_seen),
  }
}

/** @param {Record<string, any>} row */
export function internalService(row) {
  const source = row || {}
  return {
    id: text(source.id),
    hostId: text(source.host_id),
    port: int(source.port, 0),
    protocol: text(source.protocol),
    service: text(source.service),
    banner: text(source.banner),
    state: text(source.state),
    source: text(source.source),
    lastSeen: text(source.last_seen),
  }
}

/**
 * Masked credential DTO. The `secret` column is intentionally never copied.
 * @param {Record<string, any>} row
 */
export function credentialMasked(row) {
  const source = row || {}
  const secret = text(source.secret)
  return {
    id: text(source.id),
    type: text(source.type),
    username: text(source.username),
    domain: text(source.domain),
    source: text(source.source),
    hostId: nullableText(source.host_id),
    serviceId: nullableText(source.service_id),
    confidence: text(source.confidence),
    status: text(source.status),
    notes: text(source.notes),
    secretMasked: maskSecret(secret),
    secretLength: secret.length,
  }
}

/**
 * @param {Record<string, any>} row
 * @param {{seq:number, refKind:string, refId:string, label:string, via:string}[]} hops
 * @param {string[]} reachableSubnets
 */
export function pivot(row, hops = [], reachableSubnets = []) {
  const source = row || {}
  return {
    id: text(source.id),
    footholdId: text(source.foothold_id),
    kind: text(source.kind),
    localHost: text(source.local_host),
    localPort: int(source.local_port, 0),
    localProtocol: text(source.local_protocol),
    tool: text(source.tool),
    status: text(source.status),
    notes: text(source.notes),
    establishedAt: text(source.established_at),
    lastVerifiedAt: text(source.last_verified_at),
    hops: hops.map((hop) => ({
      seq: int(hop.seq, 0),
      refKind: text(hop.refKind ?? hop.ref_kind),
      refId: text(hop.refId ?? hop.ref_id),
      label: text(hop.label),
      via: text(hop.via),
    })),
    reachableSubnets: Array.isArray(reachableSubnets) ? reachableSubnets.map((item) => String(item)) : [],
  }
}

/* ------------------------------------------------------------------------- */
/* Snapshots                                                                 */
/* ------------------------------------------------------------------------- */

/** @param {Record<string, any>} row */
export function snapshotSummary(row) {
  const source = row || {}
  return {
    sessionId: text(source.session_id),
    projectName: text(source.project_name),
    currentPhase: text(source.current_phase),
    targetHosts: stringArray(source.target_hosts),
    parentSessionId: nullableText(source.parent_session_id),
    archivedAt: nullableText(source.archived_at),
    createdAt: nullableText(source.created_at),
    updatedAt: nullableText(source.updated_at),
    nextSteps: text(source.next_steps),
    relatedVulnIds: stringArray(source.related_vuln_ids),
    childCount: int(source.child_count, 0),
  }
}

/** @param {unknown} raw */
function testedInterfaceList(raw) {
  const out = []
  for (const item of parseJsonArray(raw)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    out.push({
      target: text(item.target),
      method: text(item.method),
      result: text(item.result),
    })
  }
  return out
}

/** @param {Record<string, any>} row */
export function snapshotDetail(row) {
  const source = row || {}
  return {
    ...snapshotSummary(source),
    unfinishedTasks: stringArray(source.unfinished_tasks),
    failedPaths: stringArray(source.failed_paths),
    testedInterfaces: testedInterfaceList(source.tested_interfaces),
    notes: text(source.notes),
    nextSteps: text(source.next_steps),
    previousState: parseJsonObject(source.previous_state),
    relatedVulnIds: stringArray(source.related_vuln_ids),
  }
}
