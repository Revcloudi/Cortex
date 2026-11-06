// GENERATED from src/cortex-ui/graph/buildMemoryGraph.ts by scripts/build-host-graph.mjs.
// Do not edit: the Cortex builder is vendored verbatim; adapt the DB adapter instead.


// src/cortex-ui/shared/graph.ts
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

// src/cortex-ui/graph/buildMemoryGraph.ts
var HOST_PORT_PATTERN = /^([^\s/:]+)(?::(\d{1,5}))?$/;
var IPV6_BRACKET_PATTERN = /^\[([^\]]+)\](?::(\d{1,5}))?$/;
var SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
function validPort(port) {
  if (port === null || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port;
}
function parseHostValue(value) {
  const raw = value.trim();
  if (raw === "") return { hostname: "", port: null };
  if (SCHEME_PATTERN.test(raw)) {
    try {
      const url = new URL(raw);
      return {
        hostname: url.hostname.toLowerCase().replace(/^\[|\]$/g, ""),
        port: url.port === "" ? null : validPort(Number(url.port))
      };
    } catch {
      return { hostname: "", port: null };
    }
  }
  const bracket = IPV6_BRACKET_PATTERN.exec(raw);
  if (bracket) {
    return {
      hostname: bracket[1].toLowerCase(),
      port: validPort(bracket[2] ? Number(bracket[2]) : null)
    };
  }
  const plain = HOST_PORT_PATTERN.exec(raw);
  if (plain) {
    return {
      hostname: plain[1].toLowerCase(),
      port: validPort(plain[2] ? Number(plain[2]) : null)
    };
  }
  return { hostname: raw.toLowerCase().replace(/^\[|\]$/g, ""), port: null };
}
function canonicalHostKey(value) {
  const parsed = parseHostValue(value);
  if (parsed.hostname === "") return "";
  if (parsed.port === null) return parsed.hostname;
  const hostname = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
  return `${hostname}:${parsed.port}`;
}
function matchHostValue(left, right) {
  const a = parseHostValue(left);
  const b = parseHostValue(right);
  if (a.hostname === "" || b.hostname === "") return null;
  if (a.hostname !== b.hostname) return null;
  if (a.port !== null && b.port !== null) return a.port === b.port ? "exact" : null;
  return "hostname";
}
function resolveMemoryGraphLimits(limits) {
  const clamp = (value, fallback, hardMax) => {
    if (value === void 0 || !Number.isFinite(value)) return fallback;
    return Math.min(hardMax, Math.max(1, Math.floor(value)));
  };
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
  };
}
function truncate(value, maxLength) {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}\u2026`;
}
function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
var SEVERITY_WEIGHT = {
  Critical: 16,
  High: 13,
  Medium: 10,
  Low: 7,
  Info: 5
};
function sortByHostPort(nodes) {
  return [...nodes].sort((a, b) => a.data.host_port.localeCompare(b.data.host_port));
}
function createHostIndex(assets) {
  const byCanonical = /* @__PURE__ */ new Map();
  const byHostname = /* @__PURE__ */ new Map();
  for (const asset of assets) {
    const key = canonicalHostKey(asset.host_port);
    if (key === "") continue;
    if (byCanonical.has(key)) continue;
    const node = toHostNode(asset, key);
    byCanonical.set(key, node);
    const hostname = parseHostValue(asset.host_port).hostname;
    const bucket = byHostname.get(hostname) ?? [];
    bucket.push(node);
    byHostname.set(hostname, bucket);
  }
  const nodes = sortByHostPort([...byCanonical.values()]);
  return { nodes, byCanonical, byHostname };
}
function resolveHost(index, value) {
  const key = canonicalHostKey(value);
  if (key === "") return null;
  const exact = index.byCanonical.get(key);
  if (exact) return { node: exact, kind: "exact" };
  const hostname = parseHostValue(value).hostname;
  const candidates = index.byHostname.get(hostname);
  if (candidates === void 0 || candidates.length === 0) return null;
  const target = parseHostValue(value);
  const withSamePort = target.port === null ? void 0 : candidates.find((candidate) => parseHostValue(candidate.data.host_port).port === target.port);
  return { node: withSamePort ?? candidates[0], kind: "hostname" };
}
function toHostNode(asset, key) {
  const interfaceCount = asset.interfaces.length;
  const leakedCount = asset.leaked_infos.length;
  const data = {
    host_port: asset.host_port,
    host: asset.host,
    project_name: asset.project_name,
    tech_stack: asset.tech_stack ?? "",
    status: asset.status,
    interface_count: interfaceCount,
    leaked_count: leakedCount,
    last_seen: asset.last_seen,
    test_parameters: asset.test_parameters.slice(0, 12).map((parameter) => parameter.name),
    interfaces: asset.interfaces.slice(0, 8).map((entry) => entry.path)
  };
  return {
    id: `host:${key}`,
    type: "host",
    name: asset.host_port,
    host: key,
    project: asset.project_name,
    val: clampNumber(8 + interfaceCount * 0.35 + leakedCount * 2, 8, 34),
    data
  };
}
function toVulnNode(record, project) {
  const hostKey = canonicalHostKey(record.host) || record.host.toLowerCase();
  const data = {
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
  };
  return {
    id: `vuln:${record.id}`,
    type: "vuln",
    name: record.vuln_name,
    host: hostKey,
    project,
    severity: record.severity,
    status: record.status,
    val: SEVERITY_WEIGHT[record.severity],
    data
  };
}
function toLeakNode(asset, info, index, hostKey) {
  const data = {
    info_type: info.info_type,
    // Bounded payload: the inspector truncates for display anyway.
    value: truncate(info.value, 2e3),
    source: info.source,
    potential_impact: info.potential_impact,
    host: asset.host_port
  };
  const sourceHint = info.source.trim();
  return {
    id: `leak:${asset.host_port}:${index}`,
    type: "leak",
    name: sourceHint === "" ? info.info_type : `${info.info_type} \xB7 ${truncate(sourceHint, 40)}`,
    host: hostKey,
    project: asset.project_name,
    val: info.info_type === "Credential" || info.info_type === "Token" || info.info_type === "API_Key" ? 8 : 7,
    data
  };
}
function toSnapshotNode(session) {
  const phase = session.current_phase.trim();
  const data = {
    session_id: session.session_id,
    project_name: session.project_name,
    current_phase: session.current_phase,
    target_hosts: session.target_hosts,
    related_vuln_ids: session.related_vuln_ids,
    parent_session_id: session.parent_session_id,
    unfinished_tasks: session.unfinished_tasks,
    next_steps: session.next_steps,
    updated_at: session.updated_at
  };
  return {
    id: `snap:${session.session_id}`,
    type: "snapshot",
    name: `${session.project_name} / ${truncate(phase === "" ? session.session_id : phase, 48)}`,
    project: session.project_name,
    val: clampNumber(8 + session.target_hosts.length + session.related_vuln_ids.length * 1.2, 8, 30),
    data
  };
}
function toFootholdNode(foothold) {
  const data = {
    foothold_id: foothold.id,
    project_name: foothold.project_name,
    entry_host_port: foothold.entry_host_port,
    entry_vuln_id: foothold.entry_vuln_id,
    access_type: foothold.access_type,
    privilege_level: foothold.privilege_level,
    status: foothold.status,
    // Evidence is Markdown and can be long; the inspector only previews it.
    evidence: truncate(foothold.evidence, 4e3),
    notes: truncate(foothold.notes, 4e3),
    established_at: foothold.established_at,
    last_verified_at: foothold.last_verified_at,
    host_count: foothold.host_ids.length
  };
  const entryKey = canonicalHostKey(foothold.entry_host_port) || foothold.entry_host_port.toLowerCase();
  return {
    id: `foothold:${foothold.id}`,
    type: "foothold",
    // `FH · rce` reads as a bridge, not as a record title (plan §7.3).
    name: `FH \xB7 ${foothold.access_type}`,
    host: entryKey,
    project: foothold.project_name,
    val: 14,
    data
  };
}
function toInternalHostNode(host, serviceCount) {
  const hostname = host.hostname.trim();
  const data = {
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
  };
  return {
    id: `internal_host:${host.id}`,
    type: "internal_host",
    name: hostname.length > 0 ? `${host.ip} \xB7 ${hostname}` : host.ip,
    host: host.ip,
    project: host.project_name,
    val: clampNumber(9 + serviceCount * 0.4, 9, 24),
    data
  };
}
function toInternalServiceNode(service, vulnIds) {
  const ip = service.host_ip.trim();
  const endpoint = ip.length > 0 ? `${ip}:${service.port}` : `${service.host_id}:${service.port}`;
  const label = service.service.trim().length > 0 ? service.service.trim() : service.protocol;
  const data = {
    service_id: service.id,
    project_name: service.project_name,
    host_id: service.host_id,
    ip,
    port: service.port,
    protocol: service.protocol,
    service: service.service,
    state: service.state,
    vuln_ids: [...vulnIds]
  };
  return {
    id: `internal_service:${service.id}`,
    type: "internal_service",
    name: label.length > 0 ? `${endpoint} \xB7 ${label}` : endpoint,
    host: ip,
    project: service.project_name,
    val: clampNumber(5 + vulnIds.length * 1.5, 5, 16),
    data
  };
}
function createAccumulator() {
  return {
    nodes: /* @__PURE__ */ new Map(),
    links: [],
    linkKeys: /* @__PURE__ */ new Set(),
    truncated: false,
    unresolvedTargets: /* @__PURE__ */ new Set()
  };
}
function addNodes(accumulator, nodes) {
  for (const node of nodes) accumulator.nodes.set(node.id, node);
}
function addLink(accumulator, source, target, relation, derived = false) {
  if (!accumulator.nodes.has(source) || !accumulator.nodes.has(target)) return;
  const key = `${relation}|${source}|${target}`;
  if (accumulator.linkKeys.has(key)) return;
  accumulator.linkKeys.add(key);
  accumulator.links.push(derived ? { source, target, relation, derived } : { source, target, relation });
}
function accumulatorFromGraph(graph) {
  const accumulator = createAccumulator();
  addNodes(accumulator, graph.nodes);
  for (const link of graph.links) {
    accumulator.linkKeys.add(`${link.relation}|${link.source}|${link.target}`);
    accumulator.links.push(link);
  }
  accumulator.truncated = graph.meta.truncated;
  for (const target of graph.meta.unresolvedTargets) accumulator.unresolvedTargets.add(target);
  return accumulator;
}
function finalize(accumulator, scope, limits, routes) {
  const nodes = [...accumulator.nodes.values()];
  const graph = {
    nodes,
    links: accumulator.links,
    meta: {
      scope,
      counts: countNodeTypes(nodes),
      truncated: accumulator.truncated,
      limits,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      unresolvedTargets: [...accumulator.unresolvedTargets]
    }
  };
  if (routes !== void 0) graph.routes = [...routes];
  return graph;
}
function emptyGraph(scope, limits) {
  return {
    nodes: [],
    links: [],
    meta: {
      scope,
      counts: emptyTypeCounts(),
      truncated: false,
      limits,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      unresolvedTargets: []
    }
  };
}
function resolveFilters(filters) {
  return {
    vulnerabilities: filters?.vulnerabilities !== false,
    leaks: filters?.leaks !== false,
    snapshots: filters?.snapshots !== false,
    // Internal layer is opt-out only in the `all` realm (plan §7.2).
    internal: filters?.internal !== false
  };
}
function appendLeaks(accumulator, assets, hostIndex, limits, existingLeaks) {
  for (const asset of assets) {
    const host = resolveHost(hostIndex, asset.host_port);
    if (host === null) continue;
    for (const [index, info] of asset.leaked_infos.entries()) {
      if (existingLeaks.count >= limits.leaks) {
        accumulator.truncated = true;
        return;
      }
      existingLeaks.count += 1;
      const leak = toLeakNode(asset, info, index, host.node.host);
      addNodes(accumulator, [leak]);
      addLink(accumulator, host.node.id, leak.id, "LEAKED");
    }
  }
}
function loadVulnerabilities(db, requestedLimit, realm) {
  const records = db.listGraphVulnerabilities(requestedLimit, void 0, realm);
  const totalCount = db.countVulnerabilities(realm);
  return { records, truncated: totalCount > requestedLimit || records.length > requestedLimit };
}
function addRelatedVulnLinks(accumulator, records, vulnNodes) {
  for (const record of records) {
    const source = vulnNodes.get(record.id);
    if (source === void 0) continue;
    for (const relatedId of record.related_vuln_ids) {
      const target = vulnNodes.get(relatedId);
      if (target !== void 0) {
        addLink(accumulator, source.id, target.id, "RELATED_VULN");
      }
    }
  }
}
function appendSnapshot(accumulator, session, hostIndex, vulnNodes, options) {
  const node = toSnapshotNode(session);
  addNodes(accumulator, [node]);
  for (const targetHost of session.target_hosts) {
    const match = resolveHost(hostIndex, targetHost);
    if (match === null) {
      if (options.trackUnresolved) accumulator.unresolvedTargets.add(targetHost);
      continue;
    }
    addLink(accumulator, node.id, match.node.id, "SNAPSHOT_TARGETS", true);
  }
  for (const vulnId of session.related_vuln_ids) {
    const vuln = vulnNodes.get(vulnId);
    if (vuln !== void 0) addLink(accumulator, node.id, vuln.id, "SNAPSHOT_VULN");
  }
  return node;
}
function highestSeverity(records) {
  let best = "Info";
  for (const record of records) {
    if (SEVERITY_WEIGHT[record.severity] > SEVERITY_WEIGHT[best]) best = record.severity;
  }
  return best;
}
function toVulnAggregateNode(groupKey, host, records) {
  const count = records.length;
  const severity = highestSeverity(records);
  const samples = records.slice(0, 8).map((record) => truncate(record.vuln_name, 60));
  const hostPort = host?.data.host_port ?? records[0]?.host ?? "";
  const newest = records[0]?.created_at ?? "";
  return {
    id: `vuln-group:${groupKey}`,
    type: "vuln",
    name: `+${count}`,
    host: host?.host ?? canonicalHostKey(hostPort),
    project: host?.project ?? "",
    severity,
    status: "Confirmed",
    val: clampNumber(12 + count, 12, 30),
    data: {
      vuln_id: `aggregate:vuln:${groupKey}`,
      vuln_name: `+${count}`,
      vuln_type: "Aggregate",
      severity,
      status: "Confirmed",
      host: hostPort,
      target_url: "",
      created_at: newest,
      reproduction_steps: "",
      related_vuln_ids: [],
      aggregate: { kind: "vuln", count, severity, samples }
    }
  };
}
function toLeakAggregateNode(groupKey, host, entries) {
  const count = entries.length;
  const typeCounts = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    typeCounts.set(entry.info.info_type, (typeCounts.get(entry.info.info_type) ?? 0) + 1);
  }
  const [dominantType] = [...typeCounts.entries()].sort((left, right) => right[1] - left[1])[0] ?? [
    "Other",
    0
  ];
  const samples = entries.slice(0, 8).map((entry) => `${entry.info.info_type} \xB7 ${truncate(entry.info.source, 40)}`);
  return {
    id: `leak-group:${groupKey}`,
    type: "leak",
    name: `+${count}`,
    host: host.host,
    project: host.project,
    val: clampNumber(10 + count, 10, 24),
    data: {
      info_type: dominantType,
      value: entries.slice(0, 8).map((entry) => entry.info.value).join("\n").slice(0, 2e3),
      source: "aggregate",
      potential_impact: "",
      host: host.data.host_port,
      aggregate: { kind: "leak", count, samples }
    }
  };
}
function buildAllGraphPass(db, limits, filters, aggregateRecords) {
  const accumulator = createAccumulator();
  const assets = db.listAssetsForGraph(limits.hosts);
  const hostIndex = createHostIndex(assets);
  addNodes(accumulator, hostIndex.nodes);
  if (db.countAssets() > limits.hosts || assets.length > limits.hosts) {
    accumulator.truncated = true;
  }
  const projectNodes = /* @__PURE__ */ new Map();
  const projectAssetIds = /* @__PURE__ */ new Map();
  const projectSessionIds = /* @__PURE__ */ new Map();
  const ensureProject = (name) => {
    const key = name.trim().length > 0 ? name.trim() : "\u672A\u547D\u540D\u9879\u76EE";
    const existing = projectNodes.get(key);
    if (existing !== void 0) return existing;
    const node = {
      id: `project:${key}`,
      name: key,
      type: "project",
      project: key,
      val: 26,
      data: { project_name: key, asset_count: 0, session_count: 0 }
    };
    projectNodes.set(key, node);
    addNodes(accumulator, [node]);
    return node;
  };
  for (const host of hostIndex.nodes) {
    const project = ensureProject(host.data.project_name);
    addLink(accumulator, project.id, host.id, "BELONGS_TO", true);
    const ids = projectAssetIds.get(project.id) ?? /* @__PURE__ */ new Set();
    ids.add(host.id);
    projectAssetIds.set(project.id, ids);
  }
  if (filters.leaks) {
    const groups = /* @__PURE__ */ new Map();
    let taken = 0;
    let exhausted = false;
    for (const asset of assets) {
      if (exhausted) break;
      const host = resolveHost(hostIndex, asset.host_port);
      if (host === null) continue;
      for (const [index, info] of asset.leaked_infos.entries()) {
        if (taken >= limits.leaks) {
          exhausted = true;
          accumulator.truncated = true;
          break;
        }
        taken += 1;
        const bucket = groups.get(host.node.id) ?? { host: host.node, entries: [] };
        bucket.entries.push({ asset, info, index });
        groups.set(host.node.id, bucket);
      }
    }
    for (const [hostId, group] of groups) {
      if (aggregateRecords && group.entries.length > MEMORY_GRAPH_AGGREGATE_THRESHOLD) {
        const aggregate = toLeakAggregateNode(hostId, group.host, group.entries);
        addNodes(accumulator, [aggregate]);
        addLink(accumulator, group.host.id, aggregate.id, "LEAKED");
        continue;
      }
      for (const entry of group.entries) {
        const leak = toLeakNode(entry.asset, entry.info, entry.index, group.host.host);
        addNodes(accumulator, [leak]);
        addLink(accumulator, group.host.id, leak.id, "LEAKED");
      }
    }
  }
  const vulnNodes = /* @__PURE__ */ new Map();
  const individualVulnIds = /* @__PURE__ */ new Set();
  if (filters.vulnerabilities) {
    const loaded = loadVulnerabilities(db, limits.vulnerabilities, "web");
    if (loaded.truncated) accumulator.truncated = true;
    const groups = /* @__PURE__ */ new Map();
    for (const record of loaded.records) {
      const match = resolveHost(hostIndex, record.host);
      const key = match === null ? `unmatched:${canonicalHostKey(record.host) || record.host.toLowerCase()}` : match.node.id;
      const bucket = groups.get(key) ?? {
        host: match === null ? null : match.node,
        derived: match?.kind === "hostname",
        records: []
      };
      bucket.records.push(record);
      groups.set(key, bucket);
    }
    for (const [groupKey, group] of groups) {
      if (aggregateRecords && group.records.length > MEMORY_GRAPH_AGGREGATE_THRESHOLD) {
        const aggregate = toVulnAggregateNode(groupKey, group.host, group.records);
        addNodes(accumulator, [aggregate]);
        if (group.host !== null) {
          addLink(accumulator, group.host.id, aggregate.id, "HAS_VULN", group.derived);
        }
        for (const record of group.records) vulnNodes.set(record.id, aggregate);
        continue;
      }
      for (const record of group.records) {
        const vuln = toVulnNode(record, group.host?.project ?? "");
        individualVulnIds.add(record.id);
        vulnNodes.set(record.id, vuln);
        addNodes(accumulator, [vuln]);
        if (group.host !== null) {
          addLink(accumulator, group.host.id, vuln.id, "HAS_VULN", group.derived);
        }
      }
    }
    for (const record of loaded.records) {
      if (!individualVulnIds.has(record.id)) continue;
      const source = vulnNodes.get(record.id);
      if (source === void 0) continue;
      for (const relatedId of record.related_vuln_ids) {
        if (!individualVulnIds.has(relatedId)) continue;
        const target = vulnNodes.get(relatedId);
        if (target !== void 0) {
          addLink(accumulator, source.id, target.id, "RELATED_VULN");
        }
      }
    }
  }
  if (filters.snapshots) {
    const sessions = db.listGraphSnapshots(limits.snapshots);
    if (db.countSnapshotSessions() > limits.snapshots) accumulator.truncated = true;
    const targetNodes = /* @__PURE__ */ new Map();
    const targetSessionIds = /* @__PURE__ */ new Map();
    const targetAssetIds = /* @__PURE__ */ new Map();
    const ensureTarget = (rawTarget, projectName) => {
      const hostKey = canonicalHostKey(rawTarget) || rawTarget.trim().toLowerCase();
      if (hostKey.length === 0) return null;
      const existing = targetNodes.get(hostKey);
      if (existing !== void 0) return existing;
      const node = {
        id: `target:${hostKey}`,
        name: rawTarget,
        type: "target",
        project: projectName,
        val: 24,
        data: {
          target: rawTarget,
          host_key: hostKey,
          project_name: projectName,
          session_count: 0,
          asset_count: 0
        }
      };
      targetNodes.set(hostKey, node);
      addNodes(accumulator, [node]);
      return node;
    };
    const remember = (map, key, value) => {
      const ids = map.get(key) ?? /* @__PURE__ */ new Set();
      ids.add(value);
      map.set(key, ids);
    };
    for (const session of sessions) {
      appendSnapshot(accumulator, session, hostIndex, vulnNodes, { trackUnresolved: true });
      const sessionNodeId = `snap:${session.session_id}`;
      const project = ensureProject(session.project_name);
      addLink(accumulator, project.id, sessionNodeId, "BELONGS_TO", true);
      remember(projectSessionIds, project.id, sessionNodeId);
      for (const targetHost of session.target_hosts) {
        const target = ensureTarget(targetHost, session.project_name);
        if (target === null) continue;
        addLink(accumulator, project.id, target.id, "BELONGS_TO", true);
        addLink(accumulator, target.id, sessionNodeId, "TARGET_SESSION", true);
        remember(targetSessionIds, target.id, sessionNodeId);
        const matched = resolveHost(hostIndex, targetHost);
        if (matched !== null) {
          addLink(accumulator, target.id, matched.node.id, "TARGET_ASSET", true);
          remember(targetAssetIds, target.id, matched.node.id);
        }
        for (const vulnId of session.related_vuln_ids) {
          const vulnNode = vulnNodes.get(vulnId);
          if (vulnNode === void 0) continue;
          const hostMatch = resolveHost(hostIndex, vulnNode.data.host);
          if (hostMatch === null) continue;
          addLink(accumulator, target.id, hostMatch.node.id, "TARGET_ASSET", true);
          remember(targetAssetIds, target.id, hostMatch.node.id);
        }
      }
    }
    for (const node of projectNodes.values()) {
      node.data.asset_count = projectAssetIds.get(node.id)?.size ?? 0;
      node.data.session_count = projectSessionIds.get(node.id)?.size ?? 0;
    }
    for (const node of targetNodes.values()) {
      node.data.session_count = targetSessionIds.get(node.id)?.size ?? 0;
      node.data.asset_count = targetAssetIds.get(node.id)?.size ?? 0;
    }
  }
  return finalize(accumulator, { kind: "all" }, limits);
}
function buildAllGraph(db, limits, filters, _depth) {
  const granular = buildAllGraphPass(db, limits, filters, false);
  const elements = granular.nodes.length + granular.links.length;
  if (elements <= MEMORY_GRAPH_AGGREGATE_ELEMENT_LIMIT) return granular;
  return buildAllGraphPass(db, limits, filters, true);
}
function findAssetForScope(db, hostPort, hostIndex) {
  const direct = db.getAssetDetail(hostPort);
  if (direct !== null) {
    const match = resolveHost(hostIndex, direct.host_port);
    if (match !== null) return { asset: direct, host: match.node };
  }
  const matched = resolveHost(hostIndex, hostPort);
  if (matched === null) return null;
  const asset = db.listAssetsForGraph(MEMORY_GRAPH_HARD_LIMITS.hosts).find(
    (candidate) => canonicalHostKey(candidate.host_port) === canonicalHostKey(matched.node.data.host_port)
  );
  if (asset === void 0) return null;
  return { asset, host: matched.node };
}
function buildAssetGraph(db, hostPort, limits, filters, depth) {
  const accumulator = createAccumulator();
  const allAssets = db.listAssetsForGraph(limits.hosts);
  const fullIndex = createHostIndex(allAssets);
  const target = findAssetForScope(db, hostPort, fullIndex);
  const scope = { kind: "asset", hostPort };
  if (target === null) {
    accumulator.unresolvedTargets.add(hostPort);
    return finalize(accumulator, scope, limits);
  }
  const hostIndex = {
    nodes: [target.host],
    byCanonical: /* @__PURE__ */ new Map([[target.host.host, target.host]]),
    byHostname: /* @__PURE__ */ new Map([[parseHostValue(target.host.data.host_port).hostname, [target.host]]])
  };
  addNodes(accumulator, [target.host]);
  const leakCounter = { count: 0 };
  if (filters.leaks) {
    appendLeaks(accumulator, [target.asset], hostIndex, limits, leakCounter);
  }
  let vulnRecords = [];
  const vulnNodes = /* @__PURE__ */ new Map();
  if (filters.vulnerabilities) {
    const loaded = loadVulnerabilities(
      db,
      MEMORY_GRAPH_HARD_LIMITS.vulnerabilities,
      "web"
    );
    vulnRecords = loaded.records;
    const hostVulns = vulnRecords.filter(
      (record) => resolveHost(hostIndex, record.host) !== null
    );
    for (const record of hostVulns) {
      const match = resolveHost(hostIndex, record.host);
      if (match === null) continue;
      const vuln = toVulnNode(record, target.host.project);
      vulnNodes.set(record.id, vuln);
      addNodes(accumulator, [vuln]);
      addLink(accumulator, match.node.id, vuln.id, "HAS_VULN", match.kind === "hostname");
    }
    const relatedIds = /* @__PURE__ */ new Set();
    for (const vuln of hostVulns) {
      for (const relatedId of vuln.related_vuln_ids) relatedIds.add(relatedId);
    }
    if (depth === 2) {
      for (const record of vulnRecords) {
        if (!relatedIds.has(record.id)) continue;
        for (const deeperId of record.related_vuln_ids) relatedIds.add(deeperId);
      }
    }
    for (const record of vulnRecords) {
      if (!relatedIds.has(record.id) || vulnNodes.has(record.id)) continue;
      const vuln = toVulnNode(record, "");
      vulnNodes.set(record.id, vuln);
      addNodes(accumulator, [vuln]);
    }
    addRelatedVulnLinks(accumulator, vulnRecords, vulnNodes);
    if (db.countVulnerabilities("web") > MEMORY_GRAPH_HARD_LIMITS.vulnerabilities) {
      accumulator.truncated = true;
    }
  }
  if (filters.snapshots) {
    const sessions = db.listGraphSnapshots(limits.snapshots);
    const matching = [];
    for (const session of sessions) {
      const touches = session.target_hosts.some(
        (targetHost) => resolveHost(hostIndex, targetHost) !== null
      );
      if (touches) matching.push(session);
    }
    if (db.countSnapshotSessions() > limits.snapshots) accumulator.truncated = true;
    for (const session of matching) {
      appendSnapshot(accumulator, session, hostIndex, vulnNodes, { trackUnresolved: false });
    }
  }
  return finalize(accumulator, scope, limits);
}
function buildTaskGraph(db, sessionId, includeChildren, limits, filters, depth) {
  const scope = { kind: "task", sessionId, includeChildren };
  const accumulator = createAccumulator();
  const root = db.getSnapshotSession(sessionId);
  if (root === null) {
    accumulator.unresolvedTargets.add(sessionId);
    return finalize(accumulator, scope, limits);
  }
  const allAssets = db.listAssetsForGraph(limits.hosts);
  const allHostIndex = createHostIndex(allAssets);
  const allVulns = loadVulnerabilities(
    db,
    MEMORY_GRAPH_HARD_LIMITS.vulnerabilities,
    "web"
  );
  if (allVulns.truncated) accumulator.truncated = true;
  const recordsById = new Map(allVulns.records.map((record) => [record.id, record]));
  const sessions = [root];
  if (includeChildren) {
    const children = db.listGraphSnapshots(limits.snapshots - 1, sessionId);
    sessions.push(...children);
    if (root.child_count > children.length) accumulator.truncated = true;
  }
  if (sessions.length > limits.snapshots) accumulator.truncated = true;
  const targetHostNodes = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    for (const targetHost of session.target_hosts) {
      const match = resolveHost(allHostIndex, targetHost);
      if (match === null) {
        accumulator.unresolvedTargets.add(targetHost);
        continue;
      }
      targetHostNodes.set(match.node.id, match.node);
    }
  }
  if (targetHostNodes.size > limits.hosts) {
    accumulator.truncated = true;
    targetHostNodes.clear();
    for (const node of [...allHostIndex.nodes].slice(0, limits.hosts)) {
      targetHostNodes.set(node.id, node);
    }
  }
  const scopedHosts = [...targetHostNodes.values()];
  addNodes(accumulator, scopedHosts);
  const scopedIndex = {
    nodes: scopedHosts,
    byCanonical: new Map(scopedHosts.map((node) => [node.host, node])),
    byHostname: /* @__PURE__ */ new Map()
  };
  for (const node of scopedHosts) {
    const hostname = parseHostValue(node.data.host_port).hostname;
    const bucket = scopedIndex.byHostname.get(hostname) ?? [];
    bucket.push(node);
    scopedIndex.byHostname.set(hostname, bucket);
  }
  const leakCounter = { count: 0 };
  if (filters.leaks) {
    const scopedPorts = new Set(scopedHosts.map((node) => node.data.host_port));
    const matchingAssets = allAssets.filter((asset) => scopedPorts.has(asset.host_port));
    appendLeaks(accumulator, matchingAssets, scopedIndex, limits, leakCounter);
  }
  const vulnNodes = /* @__PURE__ */ new Map();
  if (filters.vulnerabilities) {
    const explicitIds = /* @__PURE__ */ new Set();
    for (const session of sessions) {
      for (const vulnId of session.related_vuln_ids) explicitIds.add(vulnId);
    }
    const includedIds = new Set(explicitIds);
    for (const record of allVulns.records) {
      if (resolveHost(scopedIndex, record.host) !== null) includedIds.add(record.id);
    }
    if (depth === 2) {
      for (const id of [...includedIds]) {
        const record = recordsById.get(id);
        if (record === void 0) continue;
        for (const relatedId of record.related_vuln_ids) includedIds.add(relatedId);
      }
    }
    for (const id of includedIds) {
      const record = recordsById.get(id);
      if (record === void 0) continue;
      const hostMatch = resolveHost(scopedIndex, record.host);
      const vuln = toVulnNode(record, hostMatch?.node.project ?? "");
      vulnNodes.set(record.id, vuln);
      addNodes(accumulator, [vuln]);
      if (hostMatch !== null) {
        addLink(accumulator, hostMatch.node.id, vuln.id, "HAS_VULN", hostMatch.kind === "hostname");
      }
    }
    addRelatedVulnLinks(accumulator, allVulns.records, vulnNodes);
  }
  for (const session of sessions) {
    const node = appendSnapshot(accumulator, session, scopedIndex, vulnNodes, {
      trackUnresolved: true
    });
    if (!filters.vulnerabilities) continue;
    const explicit = new Set(session.related_vuln_ids);
    for (const record of allVulns.records) {
      if (explicit.has(record.id)) continue;
      if (vulnNodes.get(record.id) === void 0) continue;
      if (resolveHost(scopedIndex, record.host) === null) continue;
      addLink(accumulator, node.id, `vuln:${record.id}`, "TASK_TOUCHED_HOST", true);
    }
  }
  return finalize(accumulator, scope, limits);
}
function resolveInternalScopeFilter(db, scope) {
  switch (scope.kind) {
    case "all":
      return {};
    case "asset":
      return { entryKeys: /* @__PURE__ */ new Set([canonicalHostKey(scope.hostPort)]) };
    case "task": {
      const root = db.getSnapshotSession(scope.sessionId);
      if (root === null) return null;
      return { projectNames: /* @__PURE__ */ new Set([root.project_name]) };
    }
  }
}
function createProjectRegistry() {
  const nodes = /* @__PURE__ */ new Map();
  const assetIds = /* @__PURE__ */ new Map();
  const ensure = (accumulator, name) => {
    const key = name.trim().length > 0 ? name.trim() : "\u672A\u547D\u540D\u9879\u76EE";
    const id = `project:${key}`;
    const existing = accumulator.nodes.get(id);
    if (existing !== void 0 && existing.type === "project") return existing;
    const existingRegistry = nodes.get(id);
    if (existingRegistry !== void 0) return existingRegistry;
    const node = {
      id,
      name: key,
      type: "project",
      project: key,
      val: 26,
      data: { project_name: key, asset_count: 0, session_count: 0 }
    };
    nodes.set(id, node);
    addNodes(accumulator, [node]);
    return node;
  };
  const rememberAsset = (projectId, nodeId) => {
    const ids = assetIds.get(projectId) ?? /* @__PURE__ */ new Set();
    ids.add(nodeId);
    assetIds.set(projectId, ids);
  };
  const applyCounts = () => {
    for (const node of nodes.values()) {
      node.data.asset_count = assetIds.get(node.id)?.size ?? 0;
    }
  };
  return { nodes, assetIds, ensure, rememberAsset, applyCounts };
}
function resolveGraphHostNode(accumulator, index, value) {
  const key = canonicalHostKey(value);
  if (key !== "") {
    const node = accumulator.nodes.get(`host:${key}`);
    if (node !== void 0 && node.type === "host") return node;
  }
  return resolveHost(index, value)?.node ?? null;
}
function appendInternalLayer(accumulator, db, limits, filters, filter) {
  let footholds = db.listGraphInternalFootholds(limits.footholds);
  if (db.countFootholds() > limits.footholds || footholds.length > limits.footholds) {
    accumulator.truncated = true;
  }
  if (filter.projectNames !== void 0) {
    footholds = footholds.filter((foothold) => filter.projectNames?.has(foothold.project_name) === true);
  } else if (filter.entryKeys !== void 0) {
    footholds = footholds.filter(
      (foothold) => filter.entryKeys?.has(canonicalHostKey(foothold.entry_host_port)) === true
    );
  }
  const footholdById = new Map(footholds.map((foothold) => [foothold.id, foothold]));
  const projects = createProjectRegistry();
  const entryKeys = /* @__PURE__ */ new Set();
  for (const foothold of footholds) {
    const key = canonicalHostKey(foothold.entry_host_port);
    if (key !== "") entryKeys.add(key);
  }
  const entryAssets = db.listGraphInternalEntryAssets(limits.hosts).filter((asset) => entryKeys.has(canonicalHostKey(asset.host_port)));
  const entryIndex = createHostIndex(entryAssets);
  addNodes(accumulator, entryIndex.nodes);
  for (const node of entryIndex.nodes) {
    const project = projects.ensure(accumulator, node.data.project_name);
    addLink(accumulator, project.id, node.id, "BELONGS_TO", true);
    projects.rememberAsset(project.id, node.id);
  }
  let hosts = db.listGraphInternalHosts(limits.internalHosts);
  if (db.countInternalHosts() > limits.internalHosts || hosts.length > limits.internalHosts) {
    accumulator.truncated = true;
  }
  if (filter.projectNames !== void 0) {
    hosts = hosts.filter((host) => filter.projectNames?.has(host.project_name) === true);
  } else if (filter.entryKeys !== void 0) {
    const reachable = /* @__PURE__ */ new Set();
    for (const foothold of footholds) for (const hostId of foothold.host_ids) reachable.add(hostId);
    hosts = hosts.filter((host) => reachable.has(host.id));
  }
  const hostIds = new Set(hosts.map((host) => host.id));
  let services = db.listGraphInternalServices(limits.internalServices);
  if (db.countInternalServices() > limits.internalServices || services.length > limits.internalServices) {
    accumulator.truncated = true;
  }
  services = services.filter((service) => hostIds.has(service.host_id));
  const serviceIds = new Set(services.map((service) => service.id));
  const serviceCountByHost = /* @__PURE__ */ new Map();
  for (const service of services) {
    serviceCountByHost.set(service.host_id, (serviceCountByHost.get(service.host_id) ?? 0) + 1);
  }
  const keptVulns = [];
  if (filters.vulnerabilities) {
    const loaded = loadVulnerabilities(db, limits.vulnerabilities, "internal");
    if (loaded.truncated) accumulator.truncated = true;
    for (const record of loaded.records) {
      const serviceId = record.internal_service_id ?? "";
      if (serviceId !== "" && serviceIds.has(serviceId)) {
        keptVulns.push(record);
        continue;
      }
      const hostKey = canonicalHostKey(record.host);
      if (filter.entryKeys !== void 0) {
        if (hostKey !== "" && filter.entryKeys.has(hostKey)) keptVulns.push(record);
      } else if (hostKey !== "" && entryKeys.has(hostKey)) {
        keptVulns.push(record);
      } else if (filter.projectNames === void 0) {
        keptVulns.push(record);
      }
    }
  }
  const vulnIdsByService = /* @__PURE__ */ new Map();
  for (const record of keptVulns) {
    const serviceId = record.internal_service_id ?? "";
    if (serviceId === "") continue;
    const bucket = vulnIdsByService.get(serviceId) ?? [];
    bucket.push(record.id);
    vulnIdsByService.set(serviceId, bucket);
  }
  const footholdsByHost = /* @__PURE__ */ new Map();
  for (const foothold of footholds) {
    const node = toFootholdNode(foothold);
    addNodes(accumulator, [node]);
    const project = projects.ensure(accumulator, foothold.project_name);
    addLink(accumulator, project.id, node.id, "BELONGS_TO", true);
    const entry = resolveGraphHostNode(accumulator, entryIndex, foothold.entry_host_port);
    if (entry !== null) addLink(accumulator, entry.id, node.id, "FOOTHOLD_FROM");
    for (const hostId of foothold.host_ids) {
      const bucket = footholdsByHost.get(hostId) ?? [];
      bucket.push(foothold);
      footholdsByHost.set(hostId, bucket);
    }
  }
  for (const host of hosts) {
    const reachableFrom = footholdsByHost.get(host.id) ?? [];
    const node = toInternalHostNode(
      host,
      serviceCountByHost.get(host.id) ?? host.service_count
    );
    node.data.foothold_ids = reachableFrom.map((foothold) => foothold.id);
    addNodes(accumulator, [node]);
    const project = projects.ensure(accumulator, host.project_name);
    addLink(accumulator, project.id, node.id, "BELONGS_TO", true);
    for (const foothold of reachableFrom) {
      addLink(accumulator, `foothold:${foothold.id}`, node.id, "FOOTHOLD_REACHES");
    }
  }
  for (const service of services) {
    const node = toInternalServiceNode(service, vulnIdsByService.get(service.id) ?? []);
    addNodes(accumulator, [node]);
    addLink(accumulator, `internal_host:${service.host_id}`, node.id, "HOST_HAS_SERVICE");
  }
  for (const record of keptVulns) {
    const serviceId = record.internal_service_id ?? "";
    const serviceNodeId = serviceId === "" ? null : `internal_service:${serviceId}`;
    const entry = resolveGraphHostNode(accumulator, entryIndex, record.host);
    const vuln = toVulnNode(record, entry?.data.project_name ?? "");
    addNodes(accumulator, [vuln]);
    if (serviceNodeId !== null && accumulator.nodes.has(serviceNodeId)) {
      addLink(accumulator, serviceNodeId, vuln.id, "SERVICE_HAS_VULN");
    } else if (entry !== null) {
      addLink(accumulator, entry.id, vuln.id, "HAS_VULN");
    }
  }
  projects.applyCounts();
  return collectInternalRoutes(accumulator, db, limits, footholdById, entryIndex);
}
function collectInternalRoutes(accumulator, db, limits, footholdById, entryIndex) {
  const pivots = db.listGraphInternalPivots(limits.footholds);
  const routes = [];
  for (const pivot of pivots) {
    const foothold = footholdById.get(pivot.foothold_id);
    if (foothold === void 0) continue;
    const nodeIds = [];
    const entry = resolveGraphHostNode(accumulator, entryIndex, foothold.entry_host_port);
    if (entry !== null) nodeIds.push(entry.id);
    const footholdNodeId = `foothold:${pivot.foothold_id}`;
    if (accumulator.nodes.has(footholdNodeId)) nodeIds.push(footholdNodeId);
    for (const hop of [...pivot.hops].sort((left, right) => left.seq - right.seq)) {
      const hopId = hop.ref_kind === "internal_host" ? `internal_host:${hop.ref_id}` : `internal_service:${hop.ref_id}`;
      if (accumulator.nodes.has(hopId)) nodeIds.push(hopId);
    }
    if (nodeIds.length < 2) continue;
    const tool = pivot.tool.trim();
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
    });
  }
  return routes;
}
function formatLocalEndpoint(pivot) {
  const endpoint = `${pivot.local_host}:${pivot.local_port}`;
  return pivot.local_protocol.trim().length > 0 ? `${endpoint}/${pivot.local_protocol.trim()}` : endpoint;
}
function buildWebGraph(db, scope, limits, filters, depth) {
  switch (scope.kind) {
    case "all":
      return buildAllGraph(db, limits, filters, depth);
    case "asset":
      return buildAssetGraph(db, scope.hostPort, limits, filters, depth);
    case "task":
      return buildTaskGraph(
        db,
        scope.sessionId,
        scope.includeChildren === true,
        limits,
        filters,
        depth
      );
  }
}
function buildMemoryGraph(db, query) {
  const limits = resolveMemoryGraphLimits(query.limits);
  const filters = resolveFilters(query.filters);
  const depth = query.depth === 2 ? 2 : 1;
  const realm = query.realm === "internal" || query.realm === "all" ? query.realm : "web";
  const scope = query.scope;
  if (realm === "web" || realm === "all" && !filters.internal) {
    return buildWebGraph(db, scope, limits, filters, depth);
  }
  const webGraph = realm === "all" ? buildWebGraph(db, scope, limits, filters, depth) : null;
  const scopeFilter = resolveInternalScopeFilter(db, scope);
  if (scopeFilter === null) {
    if (webGraph !== null) return webGraph;
    const accumulator2 = createAccumulator();
    if (scope.kind === "task") accumulator2.unresolvedTargets.add(scope.sessionId);
    return finalize(accumulator2, scope, limits, []);
  }
  const accumulator = webGraph === null ? createAccumulator() : accumulatorFromGraph(webGraph);
  const routes = appendInternalLayer(accumulator, db, limits, filters, scopeFilter);
  return finalize(accumulator, scope, limits, routes);
}
export {
  buildMemoryGraph,
  canonicalHostKey,
  emptyGraph,
  matchHostValue,
  parseHostValue,
  resolveMemoryGraphLimits
};
