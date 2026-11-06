// GENERATED from src/cortex-ui/shared/*.ts by scripts/build-host-graph.mjs.
// Do not edit: adapt the Host code instead.


// src/cortex-ui/shared/graph.ts
var GRAPH_NODE_TYPES = [
  "project",
  "target",
  "host",
  "vuln",
  "leak",
  "snapshot",
  "foothold",
  "internal_host",
  "internal_service"
];
var GRAPH_RELATIONS = [
  "BELONGS_TO",
  "TARGET_SESSION",
  "TARGET_ASSET",
  "HAS_VULN",
  "LEAKED",
  "RELATED_VULN",
  "SNAPSHOT_TARGETS",
  "SNAPSHOT_VULN",
  "TASK_TOUCHED_HOST",
  "FOOTHOLD_FROM",
  "FOOTHOLD_REACHES",
  "HOST_HAS_SERVICE",
  "SERVICE_HAS_VULN"
];
var DERIVED_RELATIONS = [
  "BELONGS_TO",
  "TARGET_SESSION",
  "TARGET_ASSET",
  "SNAPSHOT_TARGETS",
  "TASK_TOUCHED_HOST"
];
var MEMORY_GRAPH_DEFAULT_LIMITS = {
  hosts: 200,
  vulnerabilities: 600,
  leaks: 1e3,
  snapshots: 100,
  footholds: 100,
  internalHosts: 300,
  internalServices: 1e3
};
var MEMORY_GRAPH_HARD_LIMITS = {
  hosts: 1e3,
  vulnerabilities: 3e3,
  leaks: 2e3,
  snapshots: 400,
  footholds: 300,
  internalHosts: 1e3,
  internalServices: 3e3
};
var MEMORY_GRAPH_AGGREGATE_THRESHOLD = 6;
var MEMORY_GRAPH_AGGREGATE_ELEMENT_LIMIT = 1e3;
function aggregateInfoOf(node) {
  if (node.type === "vuln" || node.type === "leak") return node.data.aggregate ?? null;
  return null;
}
function graphHasAggregates(nodes) {
  return nodes.some((node) => aggregateInfoOf(node) !== null);
}
var EMPTY_COUNTS = {
  project: 0,
  target: 0,
  host: 0,
  vuln: 0,
  leak: 0,
  snapshot: 0,
  foothold: 0,
  internal_host: 0,
  internal_service: 0
};
function emptyTypeCounts() {
  return { ...EMPTY_COUNTS };
}
function countNodeTypes(nodes) {
  const counts = emptyTypeCounts();
  for (const node of nodes) counts[node.type] += 1;
  return counts;
}
function isHostNode(node) {
  return node.type === "host";
}
function filterGraph(graph, filters) {
  const visible = (node) => {
    switch (node.type) {
      case "project":
      case "target":
      case "host":
        return true;
      case "vuln":
        return filters.vulns;
      case "leak":
        return filters.leaks;
      case "snapshot":
        return filters.snapshots;
      case "foothold":
        return filters.footholds !== false;
      case "internal_host":
        return filters.internalHosts !== false;
      case "internal_service":
        return filters.internalServices !== false;
    }
  };
  const nodes = graph.nodes.filter(visible);
  const ids = new Set(nodes.map((node) => node.id));
  const links = graph.links.filter((link) => ids.has(link.source) && ids.has(link.target));
  return {
    nodes,
    links,
    ...graph.routes !== void 0 ? {
      routes: graph.routes.map((route) => ({
        ...route,
        node_ids: route.node_ids.filter((id) => ids.has(id))
      })).filter((route) => route.node_ids.length >= 2)
    } : {},
    meta: { ...graph.meta, counts: countNodeTypes(nodes) }
  };
}
function nodeMatchesQuery(node, query) {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return false;
  const haystack = [node.name, node.id, node.type, "project" in node ? node.project : ""];
  if ("host" in node) haystack.push(node.host);
  const data = node.data;
  for (const value of Object.values(data)) {
    if (typeof value === "string") haystack.push(value);
    else if (Array.isArray(value)) haystack.push(value.join(" "));
  }
  return haystack.some((value) => value.toLowerCase().includes(needle));
}
function collectNeighbors(nodeId, graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const neighbors = [];
  for (const link of graph.links) {
    if (link.source === nodeId) {
      const node = byId.get(link.target);
      if (node) {
        neighbors.push({
          node,
          relation: link.relation,
          direction: "outgoing",
          derived: link.derived === true
        });
      }
    } else if (link.target === nodeId) {
      const node = byId.get(link.source);
      if (node) {
        neighbors.push({
          node,
          relation: link.relation,
          direction: "incoming",
          derived: link.derived === true
        });
      }
    }
  }
  return neighbors;
}
function collectNeighborhoodIds(graph, nodeId, depth) {
  const adjacency = /* @__PURE__ */ new Map();
  for (const link of graph.links) {
    const sourceBucket = adjacency.get(link.source);
    if (sourceBucket === void 0) adjacency.set(link.source, [link.target]);
    else sourceBucket.push(link.target);
    const targetBucket = adjacency.get(link.target);
    if (targetBucket === void 0) adjacency.set(link.target, [link.source]);
    else targetBucket.push(link.source);
  }
  const included = /* @__PURE__ */ new Set([nodeId]);
  let frontier = [nodeId];
  for (let hop = 0; hop < depth; hop += 1) {
    const next = [];
    for (const current of frontier) {
      for (const neighbour of adjacency.get(current) ?? []) {
        if (included.has(neighbour)) continue;
        included.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return included;
}
export {
  DERIVED_RELATIONS,
  GRAPH_NODE_TYPES,
  GRAPH_RELATIONS,
  MEMORY_GRAPH_AGGREGATE_ELEMENT_LIMIT,
  MEMORY_GRAPH_AGGREGATE_THRESHOLD,
  MEMORY_GRAPH_DEFAULT_LIMITS,
  MEMORY_GRAPH_HARD_LIMITS,
  aggregateInfoOf,
  collectNeighborhoodIds,
  collectNeighbors,
  countNodeTypes,
  emptyTypeCounts,
  filterGraph,
  graphHasAggregates,
  isHostNode,
  nodeMatchesQuery
};
