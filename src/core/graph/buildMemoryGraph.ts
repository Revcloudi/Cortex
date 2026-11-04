import type {
  AppliedMemoryGraphLimits,
  FootholdNode,
  FootholdNodeData,
  GraphRelation,
  GraphRouteOverlay,
  HostNode,
  HostNodeData,
  InternalHostNode,
  InternalHostNodeData,
  InternalServiceNode,
  InternalServiceNodeData,
  LeakNode,
  LeakNodeData,
  MemoryGraphData,
  MemoryGraphFilterFlags,
  MemoryGraphLimits,
  MemoryGraphQuery,
  MemoryGraphScope,
  NebulaLink,
  NebulaNode,
  ProjectNode,
  SnapshotNode,
  SnapshotNodeData,
  TargetNode,
  VulnNode,
  VulnNodeData
} from '../../shared/graph'
import {
  MEMORY_GRAPH_AGGREGATE_ELEMENT_LIMIT,
  MEMORY_GRAPH_AGGREGATE_THRESHOLD,
  MEMORY_GRAPH_DEFAULT_LIMITS,
  MEMORY_GRAPH_HARD_LIMITS,
  countNodeTypes,
  emptyTypeCounts
} from '../../shared/graph'
import type {
  AssetContext,
  Foothold,
  InternalHost,
  InternalService,
  PivotWithHops,
  Realm,
  RealmFilter,
  Severity,
  SnapshotSession
} from '../../shared/types'
import type { DatabaseService, GraphVulnerabilityRecord } from '../db/DatabaseService'

/**
 * Memory Nebula graph builder (P2).
 *
 * The graph is a *derived, read-only view*: hosts come from `assets`, vulns from
 * `vulnerabilities`, leaks from `assets.leaked_infos[]` and snapshots from
 * `snapshot_sessions`. Nothing is written and no graph table exists.
 *
 * Host matching rule (guide §4.3): `vulnerability.host`, `asset.host_port` and
 * `snapshot.target_hosts` can each be `example.com`, `example.com:443` or
 * `https://example.com/login`. They are compared through `canonicalHostKey()`
 * without ever rewriting the stored values:
 *   - hostname + explicit port equal       → exact match (`HAS_VULN` solid)
 *   - same hostname, port on one side only → hostname match (link `derived`)
 *
 * Limits (guide §9.4) bound every collection; hitting one sets
 * `meta.truncated` and the data is never silently dropped without that flag.
 */

/* ------------------------------------------------------------------ parsing -- */

/** One parsed host reference; never written back to the database. */
export interface ParsedHostValue {
  /** Lowercase hostname (IPv6 without brackets); empty when unparseable. */
  hostname: string
  /** Explicit port from `host:port` or a `scheme://host:port` URL, else null. */
  port: number | null
}

const HOST_PORT_PATTERN = /^([^\s/:]+)(?::(\d{1,5}))?$/
const IPV6_BRACKET_PATTERN = /^\[([^\]]+)\](?::(\d{1,5}))?$/
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i

function validPort(port: number | null): number | null {
  if (port === null || !Number.isInteger(port) || port <= 0 || port > 65_535) return null
  return port
}

/** Parse a stored host-ish value; tolerant, never throws. */
export function parseHostValue(value: string): ParsedHostValue {
  const raw = value.trim()
  if (raw === '') return { hostname: '', port: null }

  if (SCHEME_PATTERN.test(raw)) {
    try {
      const url = new URL(raw)
      return {
        hostname: url.hostname.toLowerCase().replace(/^\[|\]$/g, ''),
        port: url.port === '' ? null : validPort(Number(url.port))
      }
    } catch {
      return { hostname: '', port: null }
    }
  }

  const bracket = IPV6_BRACKET_PATTERN.exec(raw)
  if (bracket) {
    return {
      hostname: bracket[1].toLowerCase(),
      port: validPort(bracket[2] ? Number(bracket[2]) : null)
    }
  }

  const plain = HOST_PORT_PATTERN.exec(raw)
  if (plain) {
    return {
      hostname: plain[1].toLowerCase(),
      port: validPort(plain[2] ? Number(plain[2]) : null)
    }
  }

  // Bare IPv6 without brackets (e.g. `::1`): keep the whole value as hostname.
  return { hostname: raw.toLowerCase().replace(/^\[|\]$/g, ''), port: null }
}

/** `Example.COM:443` / `https://example.com/login` → `example.com:443` / `example.com`. */
export function canonicalHostKey(value: string): string {
  const parsed = parseHostValue(value)
  if (parsed.hostname === '') return ''
  if (parsed.port === null) return parsed.hostname
  // Bracket IPv6 so `[::1]:8080` cannot be confused with a bare hostname.
  const hostname = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname
  return `${hostname}:${parsed.port}`
}

export type HostMatchKind = 'exact' | 'hostname' | null

/** Compare two stored host values (`exact` / port-less `hostname` match). */
export function matchHostValue(left: string, right: string): HostMatchKind {
  const a = parseHostValue(left)
  const b = parseHostValue(right)
  if (a.hostname === '' || b.hostname === '') return null
  if (a.hostname !== b.hostname) return null
  if (a.port !== null && b.port !== null) return a.port === b.port ? 'exact' : null
  return 'hostname'
}

/** Clamp caller limits to the defaults/hard caps from the guide. */
export function resolveMemoryGraphLimits(
  limits: MemoryGraphLimits | undefined
): AppliedMemoryGraphLimits {
  const clamp = (value: number | undefined, fallback: number, hardMax: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback
    return Math.min(hardMax, Math.max(1, Math.floor(value)))
  }
  return {
    hosts: clamp(limits?.hosts, MEMORY_GRAPH_DEFAULT_LIMITS.hosts, MEMORY_GRAPH_HARD_LIMITS.hosts),
    vulnerabilities: clamp(
      limits?.vulnerabilities,
      MEMORY_GRAPH_DEFAULT_LIMITS.vulnerabilities,
      MEMORY_GRAPH_HARD_LIMITS.vulnerabilities
    ),
    leaks: clamp(limits?.leaks, MEMORY_GRAPH_DEFAULT_LIMITS.leaks, MEMORY_GRAPH_HARD_LIMITS.leaks),
    snapshots: clamp(
      limits?.snapshots,
      MEMORY_GRAPH_DEFAULT_LIMITS.snapshots,
      MEMORY_GRAPH_HARD_LIMITS.snapshots
    ),
    footholds: clamp(
      limits?.footholds,
      MEMORY_GRAPH_DEFAULT_LIMITS.footholds,
      MEMORY_GRAPH_HARD_LIMITS.footholds
    ),
    internalHosts: clamp(
      limits?.internalHosts,
      MEMORY_GRAPH_DEFAULT_LIMITS.internalHosts,
      MEMORY_GRAPH_HARD_LIMITS.internalHosts
    ),
    internalServices: clamp(
      limits?.internalServices,
      MEMORY_GRAPH_DEFAULT_LIMITS.internalServices,
      MEMORY_GRAPH_HARD_LIMITS.internalServices
    )
  }
}

/* --------------------------------------------------------------- utilities -- */

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim()
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  Critical: 16,
  High: 13,
  Medium: 10,
  Low: 7,
  Info: 5
}

/** Deterministic host-node ordering for stable screenshots / layouts. */
function sortByHostPort(nodes: HostNode[]): HostNode[] {
  return [...nodes].sort((a, b) => a.data.host_port.localeCompare(b.data.host_port))
}

interface HostIndex {
  /** Deduplicated host nodes, one per canonical host key. */
  nodes: HostNode[]
  /** Canonical key → node. */
  byCanonical: Map<string, HostNode>
  /** Bare hostname → nodes (all ports); used for derived matches. */
  byHostname: Map<string, HostNode[]>
}

function createHostIndex(assets: readonly AssetContext[]): HostIndex {
  const byCanonical = new Map<string, HostNode>()
  const byHostname = new Map<string, HostNode[]>()
  for (const asset of assets) {
    const key = canonicalHostKey(asset.host_port)
    if (key === '') continue
    if (byCanonical.has(key)) continue
    const node = toHostNode(asset, key)
    byCanonical.set(key, node)
    const hostname = parseHostValue(asset.host_port).hostname
    const bucket = byHostname.get(hostname) ?? []
    bucket.push(node)
    byHostname.set(hostname, bucket)
  }
  const nodes = sortByHostPort([...byCanonical.values()])
  return { nodes, byCanonical, byHostname }
}

interface HostMatchResult {
  node: HostNode
  kind: 'exact' | 'hostname'
}

/** Resolve an arbitrary host-ish value against the indexed host nodes. */
function resolveHost(index: HostIndex, value: string): HostMatchResult | null {
  const key = canonicalHostKey(value)
  if (key === '') return null
  const exact = index.byCanonical.get(key)
  if (exact) return { node: exact, kind: 'exact' }
  const hostname = parseHostValue(value).hostname
  const candidates = index.byHostname.get(hostname)
  if (candidates === undefined || candidates.length === 0) return null
  const target = parseHostValue(value)
  const withSamePort =
    target.port === null
      ? undefined
      : candidates.find((candidate) => parseHostValue(candidate.data.host_port).port === target.port)
  return { node: withSamePort ?? candidates[0], kind: 'hostname' }
}

/* ------------------------------------------------------------------- nodes -- */

function toHostNode(asset: AssetContext, key: string): HostNode {
  const interfaceCount = asset.interfaces.length
  const leakedCount = asset.leaked_infos.length
  const data: HostNodeData = {
    host_port: asset.host_port,
    host: asset.host,
    project_name: asset.project_name,
    tech_stack: asset.tech_stack ?? '',
    status: asset.status,
    interface_count: interfaceCount,
    leaked_count: leakedCount,
    last_seen: asset.last_seen,
    test_parameters: asset.test_parameters.slice(0, 12).map((parameter) => parameter.name),
    interfaces: asset.interfaces.slice(0, 8).map((entry) => entry.path)
  }
  return {
    id: `host:${key}`,
    type: 'host',
    name: asset.host_port,
    host: key,
    project: asset.project_name,
    val: clampNumber(8 + interfaceCount * 0.35 + leakedCount * 2, 8, 34),
    data
  }
}

function toVulnNode(record: GraphVulnerabilityRecord, project: string): VulnNode {
  const hostKey = canonicalHostKey(record.host) || record.host.toLowerCase()
  const data: VulnNodeData = {
    vuln_id: record.id,
    vuln_name: record.vuln_name,
    vuln_type: record.vuln_type,
    severity: record.severity,
    status: record.status,
    host: record.host,
    service_host: record.service_host,
    target_url: record.target_url,
    created_at: record.created_at,
    reproduction_steps: record.reproduction_steps,
    related_vuln_ids: record.related_vuln_ids
  }
  return {
    id: `vuln:${record.id}`,
    type: 'vuln',
    name: record.vuln_name,
    host: hostKey,
    project,
    severity: record.severity,
    status: record.status,
    val: SEVERITY_WEIGHT[record.severity],
    data
  }
}

function toLeakNode(
  asset: AssetContext,
  info: AssetContext['leaked_infos'][number],
  index: number,
  hostKey: string
): LeakNode {
  const data: LeakNodeData = {
    info_type: info.info_type,
    // Bounded payload: the inspector truncates for display anyway.
    value: truncate(info.value, 2_000),
    source: info.source,
    potential_impact: info.potential_impact,
    host: asset.host_port
  }
  const sourceHint = info.source.trim()
  return {
    id: `leak:${asset.host_port}:${index}`,
    type: 'leak',
    name: sourceHint === '' ? info.info_type : `${info.info_type} · ${truncate(sourceHint, 40)}`,
    host: hostKey,
    project: asset.project_name,
    val: info.info_type === 'Credential' || info.info_type === 'Token' || info.info_type === 'API_Key' ? 8 : 7,
    data
  }
}

function toSnapshotNode(session: SnapshotSession): SnapshotNode {
  const phase = session.current_phase.trim()
  const data: SnapshotNodeData = {
    session_id: session.session_id,
    project_name: session.project_name,
    current_phase: session.current_phase,
    target_hosts: session.target_hosts,
    related_vuln_ids: session.related_vuln_ids,
    parent_session_id: session.parent_session_id,
    unfinished_tasks: session.unfinished_tasks,
    next_steps: session.next_steps,
    updated_at: session.updated_at
  }
  return {
    id: `snap:${session.session_id}`,
    type: 'snapshot',
    name: `${session.project_name} / ${truncate(phase === '' ? session.session_id : phase, 48)}`,
    project: session.project_name,
    val: clampNumber(8 + session.target_hosts.length + session.related_vuln_ids.length * 1.2, 8, 30),
    data
  }
}

/* ------------------------------------------------- internal layer nodes -- */

/** `foothold:<id>` — the bridge node between a Web entry asset and the intranet. */
function toFootholdNode(foothold: Foothold): FootholdNode {
  const data: FootholdNodeData = {
    foothold_id: foothold.id,
    project_name: foothold.project_name,
    entry_host_port: foothold.entry_host_port,
    entry_vuln_id: foothold.entry_vuln_id,
    access_type: foothold.access_type,
    privilege_level: foothold.privilege_level,
    status: foothold.status,
    // Evidence is Markdown and can be long; the inspector only previews it.
    evidence: truncate(foothold.evidence, 4_000),
    notes: truncate(foothold.notes, 4_000),
    established_at: foothold.established_at,
    last_verified_at: foothold.last_verified_at,
    host_count: foothold.host_ids.length
  }
  const entryKey = canonicalHostKey(foothold.entry_host_port) || foothold.entry_host_port.toLowerCase()
  return {
    id: `foothold:${foothold.id}`,
    type: 'foothold',
    // `FH · rce` reads as a bridge, not as a record title (plan §7.3).
    name: `FH · ${foothold.access_type}`,
    host: entryKey,
    project: foothold.project_name,
    val: 14,
    data
  }
}

/** `internal_host:<id>` — an intranet machine (never a top-level Web asset). */
function toInternalHostNode(host: InternalHost, serviceCount: number): InternalHostNode {
  const hostname = host.hostname.trim()
  const data: InternalHostNodeData = {
    host_id: host.id,
    project_name: host.project_name,
    ip: host.ip,
    hostname,
    os: host.os,
    subnet: host.subnet,
    state: host.state,
    confidence: host.confidence,
    service_count: serviceCount,
    last_seen: host.last_seen,
    foothold_ids: []
  }
  return {
    id: `internal_host:${host.id}`,
    type: 'internal_host',
    name: hostname.length > 0 ? `${host.ip} · ${hostname}` : host.ip,
    host: host.ip,
    project: host.project_name,
    val: clampNumber(9 + serviceCount * 0.4, 9, 24),
    data
  }
}

/** `internal_service:<id>` — a port/service on an internal host. */
function toInternalServiceNode(
  service: InternalService,
  vulnIds: readonly string[]
): InternalServiceNode {
  const ip = service.host_ip.trim()
  const endpoint = ip.length > 0 ? `${ip}:${service.port}` : `${service.host_id}:${service.port}`
  const label = service.service.trim().length > 0 ? service.service.trim() : service.protocol
  const data: InternalServiceNodeData = {
    service_id: service.id,
    project_name: service.project_name,
    host_id: service.host_id,
    ip,
    port: service.port,
    protocol: service.protocol,
    service: service.service,
    state: service.state,
    vuln_ids: [...vulnIds]
  }
  return {
    id: `internal_service:${service.id}`,
    type: 'internal_service',
    name: label.length > 0 ? `${endpoint} · ${label}` : endpoint,
    host: ip,
    project: service.project_name,
    val: clampNumber(5 + vulnIds.length * 1.5, 5, 16),
    data
  }
}

/* ------------------------------------------------------------- accumulator -- */

interface GraphAccumulator {
  nodes: Map<string, NebulaNode>
  links: NebulaLink[]
  linkKeys: Set<string>
  truncated: boolean
  unresolvedTargets: Set<string>
}

function createAccumulator(): GraphAccumulator {
  return {
    nodes: new Map(),
    links: [],
    linkKeys: new Set(),
    truncated: false,
    unresolvedTargets: new Set()
  }
}

function addNodes(accumulator: GraphAccumulator, nodes: readonly NebulaNode[]): void {
  for (const node of nodes) accumulator.nodes.set(node.id, node)
}

function addLink(
  accumulator: GraphAccumulator,
  source: string,
  target: string,
  relation: GraphRelation,
  derived = false
): void {
  if (!accumulator.nodes.has(source) || !accumulator.nodes.has(target)) return
  const key = `${relation}|${source}|${target}`
  if (accumulator.linkKeys.has(key)) return
  accumulator.linkKeys.add(key)
  accumulator.links.push(derived ? { source, target, relation, derived } : { source, target, relation })
}

/**
 * Re-open a finalized graph as an accumulator so the internal layer can be
 * appended to it (realm `all`) without re-running the Web projection.
 */
function accumulatorFromGraph(graph: MemoryGraphData): GraphAccumulator {
  const accumulator = createAccumulator()
  addNodes(accumulator, graph.nodes)
  for (const link of graph.links) {
    accumulator.linkKeys.add(`${link.relation}|${link.source}|${link.target}`)
    accumulator.links.push(link)
  }
  accumulator.truncated = graph.meta.truncated
  for (const target of graph.meta.unresolvedTargets) accumulator.unresolvedTargets.add(target)
  return accumulator
}

function finalize(
  accumulator: GraphAccumulator,
  scope: MemoryGraphScope,
  limits: AppliedMemoryGraphLimits,
  routes?: readonly GraphRouteOverlay[]
): MemoryGraphData {
  const nodes = [...accumulator.nodes.values()]
  const graph: MemoryGraphData = {
    nodes,
    links: accumulator.links,
    meta: {
      scope,
      counts: countNodeTypes(nodes),
      truncated: accumulator.truncated,
      limits,
      generatedAt: new Date().toISOString(),
      unresolvedTargets: [...accumulator.unresolvedTargets]
    }
  }
  // `routes` is only present for the internal / all realms (shared contract).
  if (routes !== undefined) graph.routes = [...routes]
  return graph
}

export function emptyGraph(scope: MemoryGraphScope, limits: AppliedMemoryGraphLimits): MemoryGraphData {
  return {
    nodes: [],
    links: [],
    meta: {
      scope,
      counts: emptyTypeCounts(),
      truncated: false,
      limits,
      generatedAt: new Date().toISOString(),
      unresolvedTargets: []
    }
  }
}

/* ------------------------------------------------------------ shared parts -- */

function resolveFilters(filters: MemoryGraphFilterFlags | undefined): Required<MemoryGraphFilterFlags> {
  return {
    vulnerabilities: filters?.vulnerabilities !== false,
    leaks: filters?.leaks !== false,
    snapshots: filters?.snapshots !== false,
    // Internal layer is opt-out only in the `all` realm (plan §7.2).
    internal: filters?.internal !== false
  }
}

/** Add leak nodes + `LEAKED` links for the given host assets, bounded by limit. */
function appendLeaks(
  accumulator: GraphAccumulator,
  assets: readonly AssetContext[],
  hostIndex: HostIndex,
  limits: AppliedMemoryGraphLimits,
  existingLeaks: { count: number }
): void {
  for (const asset of assets) {
    const host = resolveHost(hostIndex, asset.host_port)
    if (host === null) continue
    for (const [index, info] of asset.leaked_infos.entries()) {
      if (existingLeaks.count >= limits.leaks) {
        accumulator.truncated = true
        return
      }
      existingLeaks.count += 1
      const leak = toLeakNode(asset, info, index, host.node.host)
      addNodes(accumulator, [leak])
      addLink(accumulator, host.node.id, leak.id, 'LEAKED')
    }
  }
}

/**
 * Load vulnerabilities of one realm up to `requestedLimit`, flagging truncation
 * when the database holds more rows than requested. The Web layer only ever sees
 * `realm='web'`; the internal layer asks for `realm='internal'` explicitly, so
 * the two databases views never bleed into each other (plan §3).
 */
function loadVulnerabilities(
  db: DatabaseService,
  requestedLimit: number,
  realm: Realm
): { records: GraphVulnerabilityRecord[]; truncated: boolean } {
  const records = db.listGraphVulnerabilities(requestedLimit, undefined, realm)
  const totalCount = db.countVulnerabilities(realm)
  return { records, truncated: totalCount > requestedLimit || records.length > requestedLimit }
}

/** Add vuln nodes and `HAS_VULN` links for every record whose host matches. */
/** `RELATED_VULN` links for every pair of included vulnerability nodes. */
function addRelatedVulnLinks(
  accumulator: GraphAccumulator,
  records: readonly GraphVulnerabilityRecord[],
  vulnNodes: Map<string, VulnNode>
): void {
  for (const record of records) {
    const source = vulnNodes.get(record.id)
    if (source === undefined) continue
    for (const relatedId of record.related_vuln_ids) {
      const target = vulnNodes.get(relatedId)
      if (target !== undefined) {
        addLink(accumulator, source.id, target.id, 'RELATED_VULN')
      }
    }
  }
}

/** Add one snapshot node, its target-host links and its explicit vuln links. */
function appendSnapshot(
  accumulator: GraphAccumulator,
  session: SnapshotSession,
  hostIndex: HostIndex,
  vulnNodes: Map<string, VulnNode>,
  options: { trackUnresolved: boolean }
): SnapshotNode {
  const node = toSnapshotNode(session)
  addNodes(accumulator, [node])
  for (const targetHost of session.target_hosts) {
    const match = resolveHost(hostIndex, targetHost)
    if (match === null) {
      // In the asset scope the other targets of a snapshot are simply outside
      // that scope, not unresolved data; only report them where we intend to
      // resolve every target (all / task).
      if (options.trackUnresolved) accumulator.unresolvedTargets.add(targetHost)
      continue
    }
    addLink(accumulator, node.id, match.node.id, 'SNAPSHOT_TARGETS', true)
  }
  for (const vulnId of session.related_vuln_ids) {
    const vuln = vulnNodes.get(vulnId)
    if (vuln !== undefined) addLink(accumulator, node.id, vuln.id, 'SNAPSHOT_VULN')
  }
  return node
}

/* -------------------------------------------------------------- projections -- */

/** Highest severity inside a vulnerability bucket (`aggregate` view). */
function highestSeverity(records: readonly GraphVulnerabilityRecord[]): Severity {
  let best: Severity = 'Info'
  for (const record of records) {
    if (SEVERITY_WEIGHT[record.severity] > SEVERITY_WEIGHT[best]) best = record.severity
  }
  return best
}

/** Collapsed `+N` vulnerability node for one host (all scope only). */
function toVulnAggregateNode(
  groupKey: string,
  host: HostNode | null,
  records: readonly GraphVulnerabilityRecord[]
): VulnNode {
  const count = records.length
  const severity = highestSeverity(records)
  const samples = records.slice(0, 8).map((record) => truncate(record.vuln_name, 60))
  const hostPort = host?.data.host_port ?? records[0]?.host ?? ''
  const newest = records[0]?.created_at ?? ''
  return {
    id: `vuln-group:${groupKey}`,
    type: 'vuln',
    name: `+${count}`,
    host: host?.host ?? canonicalHostKey(hostPort),
    project: host?.project ?? '',
    severity,
    status: 'Confirmed',
    val: clampNumber(12 + count, 12, 30),
    data: {
      vuln_id: `aggregate:vuln:${groupKey}`,
      vuln_name: `+${count}`,
      vuln_type: 'Aggregate',
      severity,
      status: 'Confirmed',
      host: hostPort,
      target_url: '',
      created_at: newest,
      reproduction_steps: '',
      related_vuln_ids: [],
      aggregate: { kind: 'vuln', count, severity, samples }
    }
  }
}

/** Collapsed `+N` leaked-secret node for one host (all scope only). */
function toLeakAggregateNode(
  groupKey: string,
  host: HostNode,
  entries: readonly { info: AssetContext['leaked_infos'][number] }[]
): LeakNode {
  const count = entries.length
  const typeCounts = new Map<AssetContext['leaked_infos'][number]['info_type'], number>()
  for (const entry of entries) {
    typeCounts.set(entry.info.info_type, (typeCounts.get(entry.info.info_type) ?? 0) + 1)
  }
  const [dominantType] = [...typeCounts.entries()].sort((left, right) => right[1] - left[1])[0] ?? [
    'Other',
    0
  ]
  const samples = entries
    .slice(0, 8)
    .map((entry) => `${entry.info.info_type} · ${truncate(entry.info.source, 40)}`)
  return {
    id: `leak-group:${groupKey}`,
    type: 'leak',
    name: `+${count}`,
    host: host.host,
    project: host.project,
    val: clampNumber(10 + count, 10, 24),
    data: {
      info_type: dominantType,
      value: entries
        .slice(0, 8)
        .map((entry) => entry.info.value)
        .join('\n')
        .slice(0, 2_000),
      source: 'aggregate',
      potential_impact: '',
      host: host.data.host_port,
      aggregate: { kind: 'leak', count, samples }
    }
  }
}

/**
 * One all-scope pass. The public `buildAllGraph()` wrapper first builds without
 * aggregation and only re-runs with `+N` collapsing when the granular graph
 * exceeds `MEMORY_GRAPH_AGGREGATE_ELEMENT_LIMIT`, so small libraries always show
 * every individual vulnerability/leak.
 */
function buildAllGraphPass(
  db: DatabaseService,
  limits: AppliedMemoryGraphLimits,
  filters: Required<MemoryGraphFilterFlags>,
  aggregateRecords: boolean
): MemoryGraphData {
  const accumulator = createAccumulator()
  const assets = db.listAssetsForGraph(limits.hosts)
  const hostIndex = createHostIndex(assets)
  addNodes(accumulator, hostIndex.nodes)
  if (db.countAssets() > limits.hosts || assets.length > limits.hosts) {
    accumulator.truncated = true
  }

  /* ---- project hierarchy: project → asset (derived from project_name) ---- */
  const projectNodes = new Map<string, ProjectNode>()
  const projectAssetIds = new Map<string, Set<string>>()
  const projectSessionIds = new Map<string, Set<string>>()
  const ensureProject = (name: string): ProjectNode => {
    const key = name.trim().length > 0 ? name.trim() : '未命名项目'
    const existing = projectNodes.get(key)
    if (existing !== undefined) return existing
    const node: ProjectNode = {
      id: `project:${key}`,
      name: key,
      type: 'project',
      project: key,
      val: 26,
      data: { project_name: key, asset_count: 0, session_count: 0 }
    }
    projectNodes.set(key, node)
    addNodes(accumulator, [node])
    return node
  }
  for (const host of hostIndex.nodes) {
    const project = ensureProject(host.data.project_name)
    addLink(accumulator, project.id, host.id, 'BELONGS_TO', true)
    const ids = projectAssetIds.get(project.id) ?? new Set<string>()
    ids.add(host.id)
    projectAssetIds.set(project.id, ids)
  }

  /* ---- leaks: per host, collapsing a host with too many secrets into `+N` ---- */
  if (filters.leaks) {
    interface LeakEntry {
      asset: AssetContext
      info: AssetContext['leaked_infos'][number]
      index: number
    }
    const groups = new Map<string, { host: HostNode; entries: LeakEntry[] }>()
    let taken = 0
    let exhausted = false
    for (const asset of assets) {
      if (exhausted) break
      const host = resolveHost(hostIndex, asset.host_port)
      if (host === null) continue
      for (const [index, info] of asset.leaked_infos.entries()) {
        if (taken >= limits.leaks) {
          exhausted = true
          accumulator.truncated = true
          break
        }
        taken += 1
        const bucket = groups.get(host.node.id) ?? { host: host.node, entries: [] }
        bucket.entries.push({ asset, info, index })
        groups.set(host.node.id, bucket)
      }
    }
    for (const [hostId, group] of groups) {
      if (aggregateRecords && group.entries.length > MEMORY_GRAPH_AGGREGATE_THRESHOLD) {
        const aggregate = toLeakAggregateNode(hostId, group.host, group.entries)
        addNodes(accumulator, [aggregate])
        addLink(accumulator, group.host.id, aggregate.id, 'LEAKED')
        continue
      }
      for (const entry of group.entries) {
        const leak = toLeakNode(entry.asset, entry.info, entry.index, group.host.host)
        addNodes(accumulator, [leak])
        addLink(accumulator, group.host.id, leak.id, 'LEAKED')
      }
    }
  }

  /* ---- vulnerabilities: same per-host collapse; snapshot links resolve to the
          aggregate node so no relation is silently dropped ---- */
  const vulnNodes = new Map<string, VulnNode>()
  const individualVulnIds = new Set<string>()
  if (filters.vulnerabilities) {
    const loaded = loadVulnerabilities(db, limits.vulnerabilities, 'web')
    if (loaded.truncated) accumulator.truncated = true

    interface VulnGroup {
      host: HostNode | null
      derived: boolean
      records: GraphVulnerabilityRecord[]
    }
    const groups = new Map<string, VulnGroup>()
    for (const record of loaded.records) {
      const match = resolveHost(hostIndex, record.host)
      const key =
        match === null
          ? `unmatched:${canonicalHostKey(record.host) || record.host.toLowerCase()}`
          : match.node.id
      const bucket = groups.get(key) ?? {
        host: match === null ? null : match.node,
        derived: match?.kind === 'hostname',
        records: []
      }
      bucket.records.push(record)
      groups.set(key, bucket)
    }

    for (const [groupKey, group] of groups) {
      if (aggregateRecords && group.records.length > MEMORY_GRAPH_AGGREGATE_THRESHOLD) {
        const aggregate = toVulnAggregateNode(groupKey, group.host, group.records)
        addNodes(accumulator, [aggregate])
        if (group.host !== null) {
          addLink(accumulator, group.host.id, aggregate.id, 'HAS_VULN', group.derived)
        }
        // Snapshot `related_vuln_ids` pointing into this bucket resolve here.
        for (const record of group.records) vulnNodes.set(record.id, aggregate)
        continue
      }
      for (const record of group.records) {
        const vuln = toVulnNode(record, group.host?.project ?? '')
        individualVulnIds.add(record.id)
        vulnNodes.set(record.id, vuln)
        addNodes(accumulator, [vuln])
        if (group.host !== null) {
          addLink(accumulator, group.host.id, vuln.id, 'HAS_VULN', group.derived)
        }
      }
    }

    // Explicit relations only make sense between two individual nodes.
    for (const record of loaded.records) {
      if (!individualVulnIds.has(record.id)) continue
      const source = vulnNodes.get(record.id)
      if (source === undefined) continue
      for (const relatedId of record.related_vuln_ids) {
        if (!individualVulnIds.has(relatedId)) continue
        const target = vulnNodes.get(relatedId)
        if (target !== undefined) {
          addLink(accumulator, source.id, target.id, 'RELATED_VULN')
        }
      }
    }
  }

  if (filters.snapshots) {
    const sessions = db.listGraphSnapshots(limits.snapshots)
    if (db.countSnapshotSessions() > limits.snapshots) accumulator.truncated = true

    /* ---- target hierarchy: project → target → session / asset --------------
     * A Target node is one original target the user gave for a task
     * (`snapshot.target_hosts`). Assets matched by a target — plus hosts of the
     * vulnerabilities the session explicitly references (usually services
     * reached by pivoting, whose host differs from the target) — are attached
     * to that target, which makes the attribution visible in the all-scope
     * nebula instead of floating as an isolated host. */
    const targetNodes = new Map<string, TargetNode>()
    const targetSessionIds = new Map<string, Set<string>>()
    const targetAssetIds = new Map<string, Set<string>>()
    const ensureTarget = (rawTarget: string, projectName: string): TargetNode | null => {
      const hostKey = canonicalHostKey(rawTarget) || rawTarget.trim().toLowerCase()
      if (hostKey.length === 0) return null
      const existing = targetNodes.get(hostKey)
      if (existing !== undefined) return existing
      const node: TargetNode = {
        id: `target:${hostKey}`,
        name: rawTarget,
        type: 'target',
        project: projectName,
        val: 24,
        data: {
          target: rawTarget,
          host_key: hostKey,
          project_name: projectName,
          session_count: 0,
          asset_count: 0
        }
      }
      targetNodes.set(hostKey, node)
      addNodes(accumulator, [node])
      return node
    }
    const remember = (map: Map<string, Set<string>>, key: string, value: string): void => {
      const ids = map.get(key) ?? new Set<string>()
      ids.add(value)
      map.set(key, ids)
    }

    for (const session of sessions) {
      appendSnapshot(accumulator, session, hostIndex, vulnNodes, { trackUnresolved: true })
      const sessionNodeId = `snap:${session.session_id}`
      const project = ensureProject(session.project_name)
      addLink(accumulator, project.id, sessionNodeId, 'BELONGS_TO', true)
      remember(projectSessionIds, project.id, sessionNodeId)

      for (const targetHost of session.target_hosts) {
        const target = ensureTarget(targetHost, session.project_name)
        if (target === null) continue
        addLink(accumulator, project.id, target.id, 'BELONGS_TO', true)
        addLink(accumulator, target.id, sessionNodeId, 'TARGET_SESSION', true)
        remember(targetSessionIds, target.id, sessionNodeId)
        const matched = resolveHost(hostIndex, targetHost)
        if (matched !== null) {
          addLink(accumulator, target.id, matched.node.id, 'TARGET_ASSET', true)
          remember(targetAssetIds, target.id, matched.node.id)
        }
        // Pivoted/related services: hosts of the vulns this session references.
        for (const vulnId of session.related_vuln_ids) {
          const vulnNode = vulnNodes.get(vulnId)
          if (vulnNode === undefined) continue
          const hostMatch = resolveHost(hostIndex, vulnNode.data.host)
          if (hostMatch === null) continue
          addLink(accumulator, target.id, hostMatch.node.id, 'TARGET_ASSET', true)
          remember(targetAssetIds, target.id, hostMatch.node.id)
        }
      }
    }

    for (const node of projectNodes.values()) {
      node.data.asset_count = projectAssetIds.get(node.id)?.size ?? 0
      node.data.session_count = projectSessionIds.get(node.id)?.size ?? 0
    }
    for (const node of targetNodes.values()) {
      node.data.session_count = targetSessionIds.get(node.id)?.size ?? 0
      node.data.asset_count = targetAssetIds.get(node.id)?.size ?? 0
    }
  }

  return finalize(accumulator, { kind: 'all' }, limits)
}

/**
 * All-scope entry point: decide aggregation from the *actual* graph size, not
 * from raw record counts. Only when the fully granular graph would exceed the
 * element budget do we re-build with per-host `+N` collapsing.
 */
function buildAllGraph(
  db: DatabaseService,
  limits: AppliedMemoryGraphLimits,
  filters: Required<MemoryGraphFilterFlags>,
  _depth: 1 | 2
): MemoryGraphData {
  const granular = buildAllGraphPass(db, limits, filters, false)
  const elements = granular.nodes.length + granular.links.length
  if (elements <= MEMORY_GRAPH_AGGREGATE_ELEMENT_LIMIT) return granular
  return buildAllGraphPass(db, limits, filters, true)
}

function findAssetForScope(
  db: DatabaseService,
  hostPort: string,
  hostIndex: HostIndex
): { asset: AssetContext; host: HostNode } | null {
  const direct = db.getAssetDetail(hostPort)
  if (direct !== null) {
    const match = resolveHost(hostIndex, direct.host_port)
    if (match !== null) return { asset: direct, host: match.node }
  }
  const matched = resolveHost(hostIndex, hostPort)
  if (matched === null) return null
  const asset = db
    .listAssetsForGraph(MEMORY_GRAPH_HARD_LIMITS.hosts)
    .find(
      (candidate) =>
        canonicalHostKey(candidate.host_port) === canonicalHostKey(matched.node.data.host_port)
    )
  if (asset === undefined) return null
  return { asset, host: matched.node }
}

function buildAssetGraph(
  db: DatabaseService,
  hostPort: string,
  limits: AppliedMemoryGraphLimits,
  filters: Required<MemoryGraphFilterFlags>,
  depth: 1 | 2
): MemoryGraphData {
  const accumulator = createAccumulator()
  const allAssets = db.listAssetsForGraph(limits.hosts)
  const fullIndex = createHostIndex(allAssets)
  const target = findAssetForScope(db, hostPort, fullIndex)
  const scope: MemoryGraphScope = { kind: 'asset', hostPort }

  if (target === null) {
    accumulator.unresolvedTargets.add(hostPort)
    return finalize(accumulator, scope, limits)
  }

  // Scope graph contains only the focused host; matching still uses the full
  // index so related vulns on other hosts resolve their project names.
  const hostIndex: HostIndex = {
    nodes: [target.host],
    byCanonical: new Map([[target.host.host, target.host]]),
    byHostname: new Map([[parseHostValue(target.host.data.host_port).hostname, [target.host]]])
  }
  addNodes(accumulator, [target.host])

  const leakCounter = { count: 0 }
  if (filters.leaks) {
    appendLeaks(accumulator, [target.asset], hostIndex, limits, leakCounter)
  }

  let vulnRecords: GraphVulnerabilityRecord[] = []
  const vulnNodes = new Map<string, VulnNode>()
  if (filters.vulnerabilities) {
    const loaded = loadVulnerabilities(
      db,
      MEMORY_GRAPH_HARD_LIMITS.vulnerabilities,
      'web'
    )
    vulnRecords = loaded.records
    const hostVulns = vulnRecords.filter(
      (record) => resolveHost(hostIndex, record.host) !== null
    )
    for (const record of hostVulns) {
      const match = resolveHost(hostIndex, record.host)
      if (match === null) continue
      const vuln = toVulnNode(record, target.host.project)
      vulnNodes.set(record.id, vuln)
      addNodes(accumulator, [vuln])
      addLink(accumulator, match.node.id, vuln.id, 'HAS_VULN', match.kind === 'hostname')
    }

    // One hop of explicitly related vulns (may live on other hosts).
    const relatedIds = new Set<string>()
    for (const vuln of hostVulns) {
      for (const relatedId of vuln.related_vuln_ids) relatedIds.add(relatedId)
    }
    if (depth === 2) {
      for (const record of vulnRecords) {
        if (!relatedIds.has(record.id)) continue
        for (const deeperId of record.related_vuln_ids) relatedIds.add(deeperId)
      }
    }
    for (const record of vulnRecords) {
      if (!relatedIds.has(record.id) || vulnNodes.has(record.id)) continue
      const vuln = toVulnNode(record, '')
      vulnNodes.set(record.id, vuln)
      addNodes(accumulator, [vuln])
    }
    addRelatedVulnLinks(accumulator, vulnRecords, vulnNodes)
    if (db.countVulnerabilities('web') > MEMORY_GRAPH_HARD_LIMITS.vulnerabilities) {
      accumulator.truncated = true
    }
  }

  if (filters.snapshots) {
    const sessions = db.listGraphSnapshots(limits.snapshots)
    const matching: SnapshotSession[] = []
    for (const session of sessions) {
      const touches = session.target_hosts.some(
        (targetHost) => resolveHost(hostIndex, targetHost) !== null
      )
      if (touches) matching.push(session)
    }
    if (db.countSnapshotSessions() > limits.snapshots) accumulator.truncated = true
    for (const session of matching) {
      appendSnapshot(accumulator, session, hostIndex, vulnNodes, { trackUnresolved: false })
    }
  }

  return finalize(accumulator, scope, limits)
}

function buildTaskGraph(
  db: DatabaseService,
  sessionId: string,
  includeChildren: boolean,
  limits: AppliedMemoryGraphLimits,
  filters: Required<MemoryGraphFilterFlags>,
  depth: 1 | 2
): MemoryGraphData {
  const scope: MemoryGraphScope = { kind: 'task', sessionId, includeChildren }
  const accumulator = createAccumulator()
  const root = db.getSnapshotSession(sessionId)
  if (root === null) {
    accumulator.unresolvedTargets.add(sessionId)
    return finalize(accumulator, scope, limits)
  }

  const allAssets = db.listAssetsForGraph(limits.hosts)
  const allHostIndex = createHostIndex(allAssets)
  const allVulns = loadVulnerabilities(
    db,
    MEMORY_GRAPH_HARD_LIMITS.vulnerabilities,
    'web'
  )
  if (allVulns.truncated) accumulator.truncated = true
  const recordsById = new Map(allVulns.records.map((record) => [record.id, record]))

  const sessions: SnapshotSession[] = [root]
  if (includeChildren) {
    const children = db.listGraphSnapshots(limits.snapshots - 1, sessionId)
    sessions.push(...children)
    if (root.child_count > children.length) accumulator.truncated = true
  }
  if (sessions.length > limits.snapshots) accumulator.truncated = true

  // Resolve every target host of every session in scope.
  const targetHostNodes = new Map<string, HostNode>()
  for (const session of sessions) {
    for (const targetHost of session.target_hosts) {
      const match = resolveHost(allHostIndex, targetHost)
      if (match === null) {
        accumulator.unresolvedTargets.add(targetHost)
        continue
      }
      targetHostNodes.set(match.node.id, match.node)
    }
  }
  if (targetHostNodes.size > limits.hosts) {
    accumulator.truncated = true
    targetHostNodes.clear()
    for (const node of [...allHostIndex.nodes].slice(0, limits.hosts)) {
      targetHostNodes.set(node.id, node)
    }
  }
  const scopedHosts = [...targetHostNodes.values()]
  addNodes(accumulator, scopedHosts)
  const scopedIndex: HostIndex = {
    nodes: scopedHosts,
    byCanonical: new Map(scopedHosts.map((node) => [node.host, node])),
    byHostname: new Map()
  }
  for (const node of scopedHosts) {
    const hostname = parseHostValue(node.data.host_port).hostname
    const bucket = scopedIndex.byHostname.get(hostname) ?? []
    bucket.push(node)
    scopedIndex.byHostname.set(hostname, bucket)
  }

  // Leaks for the scoped hosts.
  const leakCounter = { count: 0 }
  if (filters.leaks) {
    const scopedPorts = new Set(scopedHosts.map((node) => node.data.host_port))
    const matchingAssets = allAssets.filter((asset) => scopedPorts.has(asset.host_port))
    appendLeaks(accumulator, matchingAssets, scopedIndex, limits, leakCounter)
  }

  // Vulnerabilities: everything found on the scoped hosts, plus the sessions'
  // explicit `related_vuln_ids` (which may live on other hosts).
  const vulnNodes = new Map<string, VulnNode>()
  if (filters.vulnerabilities) {
    const explicitIds = new Set<string>()
    for (const session of sessions) {
      for (const vulnId of session.related_vuln_ids) explicitIds.add(vulnId)
    }
    const includedIds = new Set<string>(explicitIds)
    for (const record of allVulns.records) {
      if (resolveHost(scopedIndex, record.host) !== null) includedIds.add(record.id)
    }
    if (depth === 2) {
      for (const id of [...includedIds]) {
        const record = recordsById.get(id)
        if (record === undefined) continue
        for (const relatedId of record.related_vuln_ids) includedIds.add(relatedId)
      }
    }
    for (const id of includedIds) {
      const record = recordsById.get(id)
      if (record === undefined) continue
      const hostMatch = resolveHost(scopedIndex, record.host)
      const vuln = toVulnNode(record, hostMatch?.node.project ?? '')
      vulnNodes.set(record.id, vuln)
      addNodes(accumulator, [vuln])
      if (hostMatch !== null) {
        addLink(accumulator, hostMatch.node.id, vuln.id, 'HAS_VULN', hostMatch.kind === 'hostname')
      }
    }
    addRelatedVulnLinks(accumulator, allVulns.records, vulnNodes)
  }

  // Snapshot nodes + explicit SNAPSHOT_VULN links.
  for (const session of sessions) {
    const node = appendSnapshot(accumulator, session, scopedIndex, vulnNodes, {
      trackUnresolved: true
    })
    // Dashed fallback: the task touched these hosts, so their vulns are related
    // even when the snapshot never listed them explicitly.
    if (!filters.vulnerabilities) continue
    const explicit = new Set(session.related_vuln_ids)
    for (const record of allVulns.records) {
      if (explicit.has(record.id)) continue
      if (vulnNodes.get(record.id) === undefined) continue
      if (resolveHost(scopedIndex, record.host) === null) continue
      addLink(accumulator, node.id, `vuln:${record.id}`, 'TASK_TOUCHED_HOST', true)
    }
  }

  return finalize(accumulator, scope, limits)
}

/* ------------------------------------------------------------ internal layer -- */

/**
 * Scope restriction applied to the internal layer:
 * - `all` scope → no restriction (whole database, bounded by limits);
 * - `asset` scope → only footholds whose entry Web asset is the focused one;
 * - `task` scope → only the project of the focused snapshot session.
 *
 * `null` means the scope target does not exist (unresolved session id).
 */
interface InternalScopeFilter {
  /** Canonical entry host keys allowed by an asset scope. */
  entryKeys?: ReadonlySet<string>
  /** Project names allowed by a task scope. */
  projectNames?: ReadonlySet<string>
}

function resolveInternalScopeFilter(
  db: DatabaseService,
  scope: MemoryGraphScope
): InternalScopeFilter | null {
  switch (scope.kind) {
    case 'all':
      return {}
    case 'asset':
      return { entryKeys: new Set([canonicalHostKey(scope.hostPort)]) }
    case 'task': {
      const root = db.getSnapshotSession(scope.sessionId)
      if (root === null) return null
      return { projectNames: new Set([root.project_name]) }
    }
  }
}

/**
 * Project nodes shared by the Web and internal layers. `ensure` reuses an
 * existing `project:<name>` node (the Web pass already created them in the all
 * scope) so the internal layer only *adds* structure, never duplicates it.
 */
interface ProjectRegistry {
  nodes: Map<string, ProjectNode>
  assetIds: Map<string, Set<string>>
  ensure: (accumulator: GraphAccumulator, name: string) => ProjectNode
  rememberAsset: (projectId: string, nodeId: string) => void
  applyCounts: () => void
}

function createProjectRegistry(): ProjectRegistry {
  const nodes = new Map<string, ProjectNode>()
  const assetIds = new Map<string, Set<string>>()
  const ensure = (accumulator: GraphAccumulator, name: string): ProjectNode => {
    const key = name.trim().length > 0 ? name.trim() : '未命名项目'
    const id = `project:${key}`
    const existing = accumulator.nodes.get(id)
    if (existing !== undefined && existing.type === 'project') return existing
    const existingRegistry = nodes.get(id)
    if (existingRegistry !== undefined) return existingRegistry
    const node: ProjectNode = {
      id,
      name: key,
      type: 'project',
      project: key,
      val: 26,
      data: { project_name: key, asset_count: 0, session_count: 0 }
    }
    nodes.set(id, node)
    addNodes(accumulator, [node])
    return node
  }
  const rememberAsset = (projectId: string, nodeId: string): void => {
    const ids = assetIds.get(projectId) ?? new Set<string>()
    ids.add(nodeId)
    assetIds.set(projectId, ids)
  }
  const applyCounts = (): void => {
    for (const node of nodes.values()) {
      node.data.asset_count = assetIds.get(node.id)?.size ?? 0
    }
  }
  return { nodes, assetIds, ensure, rememberAsset, applyCounts }
}

/** Resolve a stored host value to an already-added host node (Web asset). */
function resolveGraphHostNode(
  accumulator: GraphAccumulator,
  index: HostIndex,
  value: string
): HostNode | null {
  const key = canonicalHostKey(value)
  if (key !== '') {
    const node = accumulator.nodes.get(`host:${key}`)
    if (node !== undefined && node.type === 'host') return node
  }
  return resolveHost(index, value)?.node ?? null
}

/**
 * Append the internal operations layer to an accumulator (plan §7.2 / §7.3).
 *
 * Layers added (internal / all realms only):
 *   entry Web asset (host)  ──FOOTHOLD_FROM──▶ foothold
 *   foothold                ──FOOTHOLD_REACHES──▶ internal host
 *   internal host           ──HOST_HAS_SERVICE──▶ internal service
 *   internal service        ──SERVICE_HAS_VULN──▶ internal vulnerability
 *   project                 ──BELONGS_TO──▶ entry host / foothold / internal host
 *
 * Orphan internal vulnerabilities (no service id yet) fall back to a `HAS_VULN`
 * edge against their entry asset when it is part of this realm, so a recorded
 * intranet finding never floats unattached. Returns the pivot route overlays.
 */
function appendInternalLayer(
  accumulator: GraphAccumulator,
  db: DatabaseService,
  limits: AppliedMemoryGraphLimits,
  filters: Required<MemoryGraphFilterFlags>,
  filter: InternalScopeFilter
): GraphRouteOverlay[] {
  /* ---- 1) footholds: the only bridge into the intranet ---- */
  let footholds = db.listGraphInternalFootholds(limits.footholds)
  if (db.countFootholds() > limits.footholds || footholds.length > limits.footholds) {
    accumulator.truncated = true
  }
  if (filter.projectNames !== undefined) {
    footholds = footholds.filter((foothold) => filter.projectNames?.has(foothold.project_name) === true)
  } else if (filter.entryKeys !== undefined) {
    footholds = footholds.filter(
      (foothold) => filter.entryKeys?.has(canonicalHostKey(foothold.entry_host_port)) === true
    )
  }
  const footholdById = new Map(footholds.map((foothold) => [foothold.id, foothold] as const))
  const projects = createProjectRegistry()

  /* ---- 2) entry Web assets (only assets referenced by footholds) ---- */
  const entryKeys = new Set<string>()
  for (const foothold of footholds) {
    const key = canonicalHostKey(foothold.entry_host_port)
    if (key !== '') entryKeys.add(key)
  }
  const entryAssets = db
    .listGraphInternalEntryAssets(limits.hosts)
    .filter((asset) => entryKeys.has(canonicalHostKey(asset.host_port)))
  const entryIndex = createHostIndex(entryAssets)
  addNodes(accumulator, entryIndex.nodes)
  for (const node of entryIndex.nodes) {
    const project = projects.ensure(accumulator, node.data.project_name)
    addLink(accumulator, project.id, node.id, 'BELONGS_TO', true)
    projects.rememberAsset(project.id, node.id)
  }

  /* ---- 3) internal hosts + services (bounded, scope-filtered) ---- */
  let hosts = db.listGraphInternalHosts(limits.internalHosts)
  if (db.countInternalHosts() > limits.internalHosts || hosts.length > limits.internalHosts) {
    accumulator.truncated = true
  }
  if (filter.projectNames !== undefined) {
    hosts = hosts.filter((host) => filter.projectNames?.has(host.project_name) === true)
  } else if (filter.entryKeys !== undefined) {
    // Only hosts recorded as reachable from the in-scope footholds.
    const reachable = new Set<string>()
    for (const foothold of footholds) for (const hostId of foothold.host_ids) reachable.add(hostId)
    hosts = hosts.filter((host) => reachable.has(host.id))
  }
  const hostIds = new Set(hosts.map((host) => host.id))

  let services = db.listGraphInternalServices(limits.internalServices)
  if (
    db.countInternalServices() > limits.internalServices ||
    services.length > limits.internalServices
  ) {
    accumulator.truncated = true
  }
  services = services.filter((service) => hostIds.has(service.host_id))
  const serviceIds = new Set(services.map((service) => service.id))
  const serviceCountByHost = new Map<string, number>()
  for (const service of services) {
    serviceCountByHost.set(service.host_id, (serviceCountByHost.get(service.host_id) ?? 0) + 1)
  }

  /* ---- 4) internal vulnerabilities (realm='internal' only) ---- */
  const keptVulns: GraphVulnerabilityRecord[] = []
  if (filters.vulnerabilities) {
    const loaded = loadVulnerabilities(db, limits.vulnerabilities, 'internal')
    if (loaded.truncated) accumulator.truncated = true
    for (const record of loaded.records) {
      const serviceId = record.internal_service_id ?? ''
      if (serviceId !== '' && serviceIds.has(serviceId)) {
        keptVulns.push(record)
        continue
      }
      const hostKey = canonicalHostKey(record.host)
      if (filter.entryKeys !== undefined) {
        if (hostKey !== '' && filter.entryKeys.has(hostKey)) keptVulns.push(record)
      } else if (hostKey !== '' && entryKeys.has(hostKey)) {
        keptVulns.push(record)
      } else if (filter.projectNames === undefined) {
        // All scope: keep recorded internal findings that are not normalized to a
        // service yet (the inspector can show their `service_host` label).
        keptVulns.push(record)
      }
    }
  }
  const vulnIdsByService = new Map<string, string[]>()
  for (const record of keptVulns) {
    const serviceId = record.internal_service_id ?? ''
    if (serviceId === '') continue
    const bucket = vulnIdsByService.get(serviceId) ?? []
    bucket.push(record.id)
    vulnIdsByService.set(serviceId, bucket)
  }

  /* ---- 5) nodes + the internal relation set ---- */
  const footholdsByHost = new Map<string, Foothold[]>()
  for (const foothold of footholds) {
    const node = toFootholdNode(foothold)
    addNodes(accumulator, [node])
    const project = projects.ensure(accumulator, foothold.project_name)
    addLink(accumulator, project.id, node.id, 'BELONGS_TO', true)
    const entry = resolveGraphHostNode(accumulator, entryIndex, foothold.entry_host_port)
    if (entry !== null) addLink(accumulator, entry.id, node.id, 'FOOTHOLD_FROM')
    for (const hostId of foothold.host_ids) {
      const bucket = footholdsByHost.get(hostId) ?? []
      bucket.push(foothold)
      footholdsByHost.set(hostId, bucket)
    }
  }

  for (const host of hosts) {
    const reachableFrom = footholdsByHost.get(host.id) ?? []
    const node = toInternalHostNode(
      host,
      serviceCountByHost.get(host.id) ?? host.service_count
    )
    node.data.foothold_ids = reachableFrom.map((foothold) => foothold.id)
    addNodes(accumulator, [node])
    const project = projects.ensure(accumulator, host.project_name)
    addLink(accumulator, project.id, node.id, 'BELONGS_TO', true)
    for (const foothold of reachableFrom) {
      addLink(accumulator, `foothold:${foothold.id}`, node.id, 'FOOTHOLD_REACHES')
    }
  }

  for (const service of services) {
    const node = toInternalServiceNode(service, vulnIdsByService.get(service.id) ?? [])
    addNodes(accumulator, [node])
    addLink(accumulator, `internal_host:${service.host_id}`, node.id, 'HOST_HAS_SERVICE')
  }

  for (const record of keptVulns) {
    const serviceId = record.internal_service_id ?? ''
    const serviceNodeId = serviceId === '' ? null : `internal_service:${serviceId}`
    const entry = resolveGraphHostNode(accumulator, entryIndex, record.host)
    const vuln = toVulnNode(record, entry?.data.project_name ?? '')
    addNodes(accumulator, [vuln])
    if (serviceNodeId !== null && accumulator.nodes.has(serviceNodeId)) {
      addLink(accumulator, serviceNodeId, vuln.id, 'SERVICE_HAS_VULN')
    } else if (entry !== null) {
      addLink(accumulator, entry.id, vuln.id, 'HAS_VULN')
    }
  }

  projects.applyCounts()

  /* ---- 6) pivot routes (overlay only: never part of the force layout) ---- */
  return collectInternalRoutes(accumulator, db, limits, footholdById, entryIndex)
}

/**
 * Pivot route overlays: entry Web asset → foothold → ordered hops (plan §7.3 /
 * §8.3). Only node ids that actually exist in the graph survive, and a route
 * needs at least two resolvable endpoints to be worth highlighting.
 */
function collectInternalRoutes(
  accumulator: GraphAccumulator,
  db: DatabaseService,
  limits: AppliedMemoryGraphLimits,
  footholdById: ReadonlyMap<string, Foothold>,
  entryIndex: HostIndex
): GraphRouteOverlay[] {
  const pivots: PivotWithHops[] = db.listGraphInternalPivots(limits.footholds)
  const routes: GraphRouteOverlay[] = []
  for (const pivot of pivots) {
    const foothold = footholdById.get(pivot.foothold_id)
    if (foothold === undefined) continue

    const nodeIds: string[] = []
    const entry = resolveGraphHostNode(accumulator, entryIndex, foothold.entry_host_port)
    if (entry !== null) nodeIds.push(entry.id)
    const footholdNodeId = `foothold:${pivot.foothold_id}`
    if (accumulator.nodes.has(footholdNodeId)) nodeIds.push(footholdNodeId)
    for (const hop of [...pivot.hops].sort((left, right) => left.seq - right.seq)) {
      const hopId =
        hop.ref_kind === 'internal_host'
          ? `internal_host:${hop.ref_id}`
          : `internal_service:${hop.ref_id}`
      if (accumulator.nodes.has(hopId)) nodeIds.push(hopId)
    }
    if (nodeIds.length < 2) continue

    const tool = pivot.tool.trim()
    routes.push({
      id: pivot.id,
      foothold_id: pivot.foothold_id,
      project_name: pivot.project_name,
      kind: pivot.kind,
      status: pivot.status,
      tool,
      local_endpoint: formatLocalEndpoint(pivot),
      // The HUD shows the tool that carries the route; kind is the fallback.
      label: tool.length > 0 ? tool : pivot.kind,
      node_ids: nodeIds,
      reachable_subnets: [...pivot.reachable_subnets]
    })
  }
  return routes
}

function formatLocalEndpoint(pivot: PivotWithHops): string {
  const endpoint = `${pivot.local_host}:${pivot.local_port}`
  return pivot.local_protocol.trim().length > 0
    ? `${endpoint}/${pivot.local_protocol.trim()}`
    : endpoint
}

/* -------------------------------------------------------------------- main -- */

function buildWebGraph(
  db: DatabaseService,
  scope: MemoryGraphScope,
  limits: AppliedMemoryGraphLimits,
  filters: Required<MemoryGraphFilterFlags>,
  depth: 1 | 2
): MemoryGraphData {
  switch (scope.kind) {
    case 'all':
      return buildAllGraph(db, limits, filters, depth)
    case 'asset':
      return buildAssetGraph(db, scope.hostPort, limits, filters, depth)
    case 'task':
      return buildTaskGraph(
        db,
        scope.sessionId,
        scope.includeChildren === true,
        limits,
        filters,
        depth
      )
  }
}

/**
 * Build the Memory Nebula projection for one scope + realm. Pure read: `db` is
 * only used for SELECT statements.
 *
 * Realm semantics (plan §7.2):
 * - `web` (default): the legacy projection, only `realm='web'` vulnerabilities.
 * - `internal`: entry Web assets + footholds + internal hosts/services/internal
 *   vulnerabilities + pivot routes; no target/snapshot/leak nodes.
 * - `all`: the Web layer plus the internal layer (deduplicated by node id, and
 *   only when `filters.internal !== false`).
 */
export function buildMemoryGraph(db: DatabaseService, query: MemoryGraphQuery): MemoryGraphData {
  const limits = resolveMemoryGraphLimits(query.limits)
  const filters = resolveFilters(query.filters)
  const depth: 1 | 2 = query.depth === 2 ? 2 : 1
  const realm: RealmFilter =
    query.realm === 'internal' || query.realm === 'all' ? query.realm : 'web'
  const scope = query.scope

  // Web realm (and `all` with the internal layer switched off): unchanged.
  if (realm === 'web' || (realm === 'all' && !filters.internal)) {
    return buildWebGraph(db, scope, limits, filters, depth)
  }

  const webGraph = realm === 'all' ? buildWebGraph(db, scope, limits, filters, depth) : null
  const scopeFilter = resolveInternalScopeFilter(db, scope)

  // Task scope pointing at a session that no longer exists: keep the Web layer
  // in the all realm, otherwise report the missing session like the task builder.
  if (scopeFilter === null) {
    if (webGraph !== null) return webGraph
    const accumulator = createAccumulator()
    if (scope.kind === 'task') accumulator.unresolvedTargets.add(scope.sessionId)
    return finalize(accumulator, scope, limits, [])
  }

  const accumulator = webGraph === null ? createAccumulator() : accumulatorFromGraph(webGraph)
  const routes = appendInternalLayer(accumulator, db, limits, filters, scopeFilter)
  return finalize(accumulator, scope, limits, routes)
}
