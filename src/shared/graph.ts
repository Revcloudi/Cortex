import type { AssetStatus, LeakedInfoType, Severity, VulnStatus } from './types'
import type {
  ConfidenceLevel,
  FootholdAccessType,
  FootholdStatus,
  InternalHostState,
  PivotKind,
  PivotStatus,
  PrivilegeLevel,
  RealmFilter,
  ServiceState
} from './internal'

/**
 * Memory Nebula graph contract (P1).
 *
 * Pure TypeScript on purpose: no Node, Electron, React or Three.js imports, so
 * the exact same types can later be produced by the main-process graph builder
 * (P2) and consumed by the renderer or the HTTP transport without conversion.
 *
 * The graph is a *derived view* of the existing SQLite tables: hosts come from
 * `assets`, vulns from `vulnerabilities`, leaks from `assets.leaked_infos[]`
 * and snapshots from `snapshot_sessions`. The internal operations layer adds
 * footholds, internal hosts/services and pivot routes. There is no graph table
 * and the builder never writes anything.
 */

export const GRAPH_NODE_TYPES = [
  'project',
  'target',
  'host',
  'vuln',
  'leak',
  'snapshot',
  'foothold',
  'internal_host',
  'internal_service'
] as const
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number]

export const GRAPH_RELATIONS = [
  'BELONGS_TO',
  'TARGET_SESSION',
  'TARGET_ASSET',
  'HAS_VULN',
  'LEAKED',
  'RELATED_VULN',
  'SNAPSHOT_TARGETS',
  'SNAPSHOT_VULN',
  'TASK_TOUCHED_HOST',
  'FOOTHOLD_FROM',
  'FOOTHOLD_REACHES',
  'HOST_HAS_SERVICE',
  'SERVICE_HAS_VULN'
] as const
export type GraphRelation = (typeof GRAPH_RELATIONS)[number]

/**
 * Relations the builder *inferred*; rendered as fainter/dashed links with the
 * legend explaining them. The project/target hierarchy edges are all inferred
 * from `project_name` and `snapshot.target_hosts` — nothing new is persisted.
 */
export const DERIVED_RELATIONS: readonly GraphRelation[] = [
  'BELONGS_TO',
  'TARGET_SESSION',
  'TARGET_ASSET',
  'SNAPSHOT_TARGETS',
  'TASK_TOUCHED_HOST'
]

/**
 * Graph scope (P2). The asset scope is keyed by the stored `host_port` value and
 * the task scope by the snapshot `session_id`, exactly like the database rows,
 * so the renderer never has to invent its own ids.
 */
export type MemoryGraphScope =
  | { kind: 'all' }
  | { kind: 'asset'; hostPort: string }
  | { kind: 'task'; sessionId: string; includeChildren?: boolean }

/** Per-type hard limits requested by the caller (all optional in IPC). */
export interface MemoryGraphLimits {
  hosts?: number
  vulnerabilities?: number
  leaks?: number
  snapshots?: number
  /** Internal operation limits (plan §7.2 / §12). */
  footholds?: number
  internalHosts?: number
  internalServices?: number
}

export type AppliedMemoryGraphLimits = Required<MemoryGraphLimits>

/**
 * Defaults from the implementation guide §9.4: beyond these the builder stops
 * and reports `truncated: true` instead of silently dropping data (P3 adds
 * aggregation). Hard caps below clamp any larger caller-provided value.
 */
export const MEMORY_GRAPH_DEFAULT_LIMITS: AppliedMemoryGraphLimits = {
  hosts: 200,
  vulnerabilities: 600,
  leaks: 1_000,
  snapshots: 100,
  footholds: 100,
  internalHosts: 300,
  internalServices: 1_000
}

/**
 * Absolute ceiling for explicitly requested limits. Defaults stay well below
 * this so a future bump only needs the default constants above.
 */
export const MEMORY_GRAPH_HARD_LIMITS: AppliedMemoryGraphLimits = {
  hosts: 1_000,
  vulnerabilities: 3_000,
  leaks: 2_000,
  snapshots: 400,
  footholds: 300,
  internalHosts: 1_000,
  internalServices: 3_000
}

/** Node-type switches applied by the builder (distinct from the UI filters). */
export interface MemoryGraphFilterFlags {
  vulnerabilities?: boolean
  leaks?: boolean
  snapshots?: boolean
  /** Include the internal operations layer in `all` scope. */
  internal?: boolean
}

/** Read-only graph query shared by IPC, the Web route and the P2 builder. */
export interface MemoryGraphQuery {
  scope: MemoryGraphScope
  /** Neighbourhood depth for the asset/task scopes (1 in P2). */
  depth?: 1 | 2
  filters?: MemoryGraphFilterFlags
  limits?: MemoryGraphLimits
  /**
   * Logical realm filter (plan §7.2): `web` (default, main dashboard), `internal`
   * (foothold / internal host / service plus the entry Web asset) or `all`.
   */
  realm?: RealmFilter
}

/** Which node types are rendered (UI-only, applied client side). */
export interface GraphFilters {
  vulns: boolean
  leaks: boolean
  snapshots: boolean
  /** Internal node groups; omitted means visible. */
  footholds?: boolean
  internalHosts?: boolean
  internalServices?: boolean
}

export type GraphTypeCounts = Record<GraphNodeType, number>

/* ------------------------------------------------------------------ nodes -- */

export interface HostNodeData {
  host_port: string
  host: string
  project_name: string
  tech_stack: string
  status: AssetStatus
  interface_count: number
  leaked_count: number
  last_seen: string
  /** Non-secret test parameter seeds collected from responses/JS (P2 audience). */
  test_parameters: string[]
  /** A handful of interface paths for the inspector, not the full inventory. */
  interfaces: string[]
}

export interface VulnNodeData {
  vuln_id: string
  vuln_name: string
  vuln_type: string
  severity: Severity
  status: VulnStatus
  host: string
  /** Internal service this vuln lives on, while `host` stays the entry asset. */
  service_host?: string
  target_url: string
  created_at: string
  /** Markdown in the real DB; the inspector shows a truncated plain preview. */
  reproduction_steps: string
  related_vuln_ids: string[]
  /** Present only when this node collapses several vulnerabilities (`+N`). */
  aggregate?: GraphAggregateInfo
}

export interface LeakNodeData {
  info_type: LeakedInfoType
  /** Never rendered in full by default: the inspector truncates it. */
  value: string
  source: string
  potential_impact: string
  host: string
  /** Present only when this node collapses several leaked secrets (`+N`). */
  aggregate?: GraphAggregateInfo
}

export interface SnapshotNodeData {
  session_id: string
  project_name: string
  current_phase: string
  target_hosts: string[]
  related_vuln_ids: string[]
  parent_session_id: string | null
  unfinished_tasks: string[]
  next_steps: string
  updated_at: string
}

/** Bridge between one entry Web asset and the internal operations domain. */
export interface FootholdNodeData {
  foothold_id: string
  project_name: string
  entry_host_port: string
  entry_vuln_id: string
  access_type: FootholdAccessType
  privilege_level: PrivilegeLevel
  status: FootholdStatus
  evidence: string
  notes: string
  established_at: string
  last_verified_at: string
  /** How many internal hosts this foothold reaches. */
  host_count: number
}

export interface InternalHostNodeData {
  host_id: string
  project_name: string
  ip: string
  hostname: string
  os: string
  subnet: string
  state: InternalHostState
  confidence: ConfidenceLevel
  service_count: number
  last_seen: string
  /** Footholds that reach this host (a host can have several entries). */
  foothold_ids: string[]
}

export interface InternalServiceNodeData {
  service_id: string
  project_name: string
  host_id: string
  ip: string
  port: number
  protocol: string
  service: string
  state: ServiceState
  /** Internal vulnerabilities found on this service. */
  vuln_ids: string[]
}

/** Project grouping node (derived from `project_name`, all scope only). */
export interface ProjectNodeData {
  project_name: string
  /** Assets whose `project_name` matches. */
  asset_count: number
  /** Snapshot sessions whose `project_name` matches. */
  session_count: number
}

/** Target grouping node: an original target the user gave to the task. */
export interface TargetNodeData {
  /** Raw target value as stored in `snapshot.target_hosts`. */
  target: string
  /** Canonical host key used to match assets. */
  host_key: string
  project_name: string
  /** Sessions that target this host. */
  session_count: number
  /** Assets attributed to this target (including pivoted services). */
  asset_count: number
}

export type GraphNodeData =
  | ProjectNodeData
  | TargetNodeData
  | HostNodeData
  | VulnNodeData
  | LeakNodeData
  | SnapshotNodeData
  | FootholdNodeData
  | InternalHostNodeData
  | InternalServiceNodeData

/* -------------------------------------------------------------- aggregation -- */

/**
 * P3 aggregation: when one host owns more than this many vulnerabilities (or
 * leaks), the all-scope graph collapses them into a single `+N` node instead of
 * rendering every record. Asset/task scopes always stay granular.
 */
export const MEMORY_GRAPH_AGGREGATE_THRESHOLD = 6

/**
 * Performance-aware aggregation gate (all scope only): individual records are
 * collapsed into `+N` nodes only when the estimated graph size (nodes + links)
 * exceeds this budget. Small libraries therefore always show every vulnerability
 * and leak, even for one host with more than `MEMORY_GRAPH_AGGREGATE_THRESHOLD`.
 */
export const MEMORY_GRAPH_AGGREGATE_ELEMENT_LIMIT = 1_000

/** Metadata attached to a collapsed `+N` node (still typed vuln / leak). */
export interface GraphAggregateInfo {
  kind: 'vuln' | 'leak'
  /** How many underlying records this node stands for. */
  count: number
  /** Highest severity inside a vulnerability bucket (vulns only). */
  severity?: Severity
  /** Up to 8 sample display names, used by search and the inspector. */
  samples: string[]
}

/** Aggregate metadata for vuln/leak nodes, or `null` for ordinary nodes. */
export function aggregateInfoOf(node: NebulaNode): GraphAggregateInfo | null {
  if (node.type === 'vuln' || node.type === 'leak') return node.data.aggregate ?? null
  return null
}

/** True when the graph contains any collapsed `+N` node. */
export function graphHasAggregates(nodes: readonly NebulaNode[]): boolean {
  return nodes.some((node) => aggregateInfoOf(node) !== null)
}

interface NebulaNodeBase {
  /** Stable graph id: `host:<host_port>`, `vuln:<id>`, `leak:<host_port>:<index>`, `snap:<session_id>`. */
  id: string
  name: string
  /** Node weight used for sprite size (interface/vuln/leak counts feed hosts). */
  val: number
}

export type ProjectNode = NebulaNodeBase & {
  type: 'project'
  project: string
  data: ProjectNodeData
}

export type TargetNode = NebulaNodeBase & {
  type: 'target'
  project: string
  data: TargetNodeData
}

export type HostNode = NebulaNodeBase & {
  type: 'host'
  /** Canonical host key used for linking, e.g. `example.com:443`. */
  host: string
  project: string
  data: HostNodeData
}
export type VulnNode = NebulaNodeBase & {
  type: 'vuln'
  host: string
  project: string
  severity: Severity
  status: VulnStatus
  data: VulnNodeData
}

export type LeakNode = NebulaNodeBase & {
  type: 'leak'
  host: string
  project: string
  data: LeakNodeData
}

export type SnapshotNode = NebulaNodeBase & {
  type: 'snapshot'
  project: string
  data: SnapshotNodeData
}

export type FootholdNode = NebulaNodeBase & {
  type: 'foothold'
  project: string
  /** Entry Web asset (`assets.host_port`), also the id of the linked host node. */
  host: string
  data: FootholdNodeData
}

export type InternalHostNode = NebulaNodeBase & {
  type: 'internal_host'
  project: string
  /** Internal IP (not a Web asset; kept separate from `host` node ids). */
  host: string
  data: InternalHostNodeData
}

export type InternalServiceNode = NebulaNodeBase & {
  type: 'internal_service'
  project: string
  /** Owning internal host IP. */
  host: string
  data: InternalServiceNodeData
}

export type NebulaNode =
  | ProjectNode
  | TargetNode
  | HostNode
  | VulnNode
  | LeakNode
  | SnapshotNode
  | FootholdNode
  | InternalHostNode
  | InternalServiceNode

/* ------------------------------------------------------------------ links -- */

export interface NebulaLink {
  source: string
  target: string
  relation: GraphRelation
  /** Inferred by the builder (host matching / task fallback) → dashed link. */
  derived?: boolean
}

/* --------------------------------------------------------------- overlays -- */

/**
 * One pivot route as an ordered node path: entry Web asset → foothold →
 * internal host/service hops. The renderer only highlights the path; it never
 * changes the layout, so the overlay stays cheap even with many pivots.
 */
export interface GraphRouteOverlay {
  /** `pivots.id`. */
  id: string
  foothold_id: string
  project_name: string
  kind: PivotKind
  status: PivotStatus
  tool: string
  local_endpoint: string
  label: string
  /** Ordered graph node ids along the attack path. */
  node_ids: string[]
  reachable_subnets: string[]
}

/* ------------------------------------------------------------------- meta -- */

export interface MemoryGraphMeta {
  scope: MemoryGraphScope
  counts: GraphTypeCounts
  /** True when the builder hit one of the limits and returned a partial graph. */
  truncated: boolean
  /** Limits that were actually applied to this build (after clamping). */
  limits: AppliedMemoryGraphLimits
  /** ISO timestamp of the build. */
  generatedAt: string
  /** Snapshot target hosts that could not be resolved to an asset node. */
  unresolvedTargets: string[]
}

export interface MemoryGraphData {
  nodes: NebulaNode[]
  links: NebulaLink[]
  meta: MemoryGraphMeta
  /**
   * Pivot routes rendered as a highlight overlay (never part of the force
   * layout). Only present for the `internal` / `all` realms.
   */
  routes?: GraphRouteOverlay[]
}

/** An edge as seen from one node, resolved for the inspector's relation list. */
export interface GraphNeighbor {
  node: NebulaNode
  relation: GraphRelation
  direction: 'outgoing' | 'incoming'
  derived: boolean
}

const EMPTY_COUNTS: GraphTypeCounts = {
  project: 0,
  target: 0,
  host: 0,
  vuln: 0,
  leak: 0,
  snapshot: 0,
  foothold: 0,
  internal_host: 0,
  internal_service: 0
}

export function emptyTypeCounts(): GraphTypeCounts {
  return { ...EMPTY_COUNTS }
}

export function countNodeTypes(nodes: readonly NebulaNode[]): GraphTypeCounts {
  const counts = emptyTypeCounts()
  for (const node of nodes) counts[node.type] += 1
  return counts
}

/** Type guard that keeps the discriminated union usable outside the page. */
export function isHostNode(node: NebulaNode): node is HostNode {
  return node.type === 'host'
}

/**
 * Apply the control-panel type filters. Hosts are never hidden (they anchor the
 * graph); links survive only when both endpoints survive.
 */
export function filterGraph(
  graph: MemoryGraphData,
  filters: GraphFilters
): MemoryGraphData {
  const visible = (node: NebulaNode): boolean => {
    switch (node.type) {
      case 'project':
      case 'target':
      case 'host':
        return true
      case 'vuln':
        return filters.vulns
      case 'leak':
        return filters.leaks
      case 'snapshot':
        return filters.snapshots
      case 'foothold':
        return filters.footholds !== false
      case 'internal_host':
        return filters.internalHosts !== false
      case 'internal_service':
        return filters.internalServices !== false
    }
  }
  const nodes = graph.nodes.filter(visible)
  const ids = new Set(nodes.map((node) => node.id))
  const links = graph.links.filter((link) => ids.has(link.source) && ids.has(link.target))
  return {
    nodes,
    links,
    ...(graph.routes !== undefined
      ? {
          routes: graph.routes
            .map((route) => ({
              ...route,
              node_ids: route.node_ids.filter((id) => ids.has(id))
            }))
            .filter((route) => route.node_ids.length >= 2)
        }
      : {}),
    meta: { ...graph.meta, counts: countNodeTypes(nodes) }
  }
}

/**
 * Search is highlight-only (never destructive): every field a human would type
 * into the search box is matched case-insensitively.
 */
export function nodeMatchesQuery(node: NebulaNode, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return false
  const haystack: string[] = [node.name, node.id, node.type, 'project' in node ? node.project : '']
  if ('host' in node) haystack.push(node.host)
  const data = node.data as unknown as Record<string, unknown>
  for (const value of Object.values(data)) {
    if (typeof value === 'string') haystack.push(value)
    else if (Array.isArray(value)) haystack.push(value.join(' '))
  }
  return haystack.some((value) => value.toLowerCase().includes(needle))
}

/** Resolve both directions of every link touching `nodeId` for the inspector. */
export function collectNeighbors(
  nodeId: string,
  graph: MemoryGraphData
): GraphNeighbor[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const neighbors: GraphNeighbor[] = []
  for (const link of graph.links) {
    if (link.source === nodeId) {
      const node = byId.get(link.target)
      if (node) {
        neighbors.push({
          node,
          relation: link.relation,
          direction: 'outgoing',
          derived: link.derived === true
        })
      }
    } else if (link.target === nodeId) {
      const node = byId.get(link.source)
      if (node) {
        neighbors.push({
          node,
          relation: link.relation,
          direction: 'incoming',
          derived: link.derived === true
        })
      }
    }
  }
  return neighbors
}

/**
 * Breadth-first neighbourhood around `nodeId` (inclusive), used by the P3
 * "focus neighbourhood" mode. Depth 1 = direct neighbours, 2 = neighbours of
 * neighbours; links are undirected for the purpose of focusing.
 */
export function collectNeighborhoodIds(
  graph: MemoryGraphData,
  nodeId: string,
  depth: 1 | 2
): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const link of graph.links) {
    const sourceBucket = adjacency.get(link.source)
    if (sourceBucket === undefined) adjacency.set(link.source, [link.target])
    else sourceBucket.push(link.target)
    const targetBucket = adjacency.get(link.target)
    if (targetBucket === undefined) adjacency.set(link.target, [link.source])
    else targetBucket.push(link.source)
  }
  const included = new Set<string>([nodeId])
  let frontier: string[] = [nodeId]
  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = []
    for (const current of frontier) {
      for (const neighbour of adjacency.get(current) ?? []) {
        if (included.has(neighbour)) continue
        included.add(neighbour)
        next.push(neighbour)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return included
}
