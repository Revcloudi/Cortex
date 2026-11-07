/**
 * Data-completeness tools for the agent: internal-scope import and a read-only
 * audit that points out missing asset/recon/snapshot data.
 *
 * Kept separate from tools.js so the tool registrations stay declarative.
 */
import { withBusyRetry } from '../db.js'
import {
  normalizeInterfaces,
  normalizeLeaks,
  normalizeProjectName,
  normalizeTestParameters,
} from './normalize-asset.js'

const LOG = '[cortex]'

const ACCESS_TYPES = ['rce', 'webshell', 'ssrf_proxy', 'credential', 'vpn', 'other']
const PRIVILEGE_LEVELS = ['user', 'admin', 'system', 'domain_admin', 'unknown']
const FOOTHOLD_STATUSES = ['planned', 'established', 'degraded', 'lost']
const HOST_STATES = ['unknown', 'alive', 'compromised', 'unreachable', 'firewalled']
const CONFIDENCES = ['low', 'medium', 'high']
const SERVICE_STATES = ['open', 'closed', 'filtered', 'unknown']
const PIVOT_KINDS = ['chain', 'proxy']
const PIVOT_STATUSES = ['planned', 'established', 'degraded', 'lost']
const CREDENTIAL_TYPES = ['password', 'ntlm_hash', 'netntlmv2', 'kerberos_ticket', 'ssh_key', 'cert', 'api_key', 'other']
const CREDENTIAL_STATUSES = ['untested', 'valid', 'invalid', 'expired']

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const num = (value, fallback) => (Number.isInteger(Number(value)) ? Number(value) : fallback)
const oneOf = (allowed, value, fallback) => (allowed.includes(value) ? value : fallback)
const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [])

function ensureDb(holder) {
  const status = holder.ensure()
  if (!status.compatible || holder.db === null) {
    throw new Error(`Cortex database unavailable: ${status.error || `schema ${status.schemaVersion}`}`)
  }
  return holder.db
}

function runWrite(db, work) {
  return withBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw error
    }
  })
}

function newId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  const hex = String(uuid).replace(/-/g, '').replace(/[^0-9a-f]/gi, '').toUpperCase()
  return `${prefix}${hex.slice(0, 12).padEnd(12, '0')}`
}

/* ------------------------------------------------------- internal import -- */

export function syncInternalScope({ holder, args }) {
  const db = ensureDb(holder)
  const project = normalizeProjectName(text(args.project_name))
  if (project.length === 0) throw new Error('project_name is required')
  const now = new Date().toISOString()
  const counts = { hosts: 0, services: 0, footholds: 0, links: 0, credentials: 0, pivots: 0, hops: 0 }
  const warnings = []
  const hostIdByIp = new Map()

  const findHost = (ip) => {
    if (hostIdByIp.has(ip)) return hostIdByIp.get(ip)
    const row = db.prepare('SELECT id FROM internal_hosts WHERE project_name = ? AND ip = ?').get(project, ip)
    if (row) hostIdByIp.set(ip, row.id)
    return row ? row.id : undefined
  }

  runWrite(db, () => {
    for (const host of list(args.internal_hosts)) {
      const ip = text(host.ip ?? host.host)
      if (ip.length === 0) {
        warnings.push('internal_hosts: entry without ip skipped')
        continue
      }
      let id = findHost(ip)
      if (!id) {
        id = newId('IH-')
        db.prepare(
          `INSERT INTO internal_hosts
           (id, project_name, ip, hostname, os, subnet, state, source, confidence, last_seen, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          project,
          ip,
          text(host.hostname),
          text(host.os),
          text(host.subnet),
          oneOf(HOST_STATES, text(host.state), 'alive'),
          text(host.source),
          oneOf(CONFIDENCES, text(host.confidence), 'medium'),
          text(host.last_seen) || now,
          now,
          now,
        )
        hostIdByIp.set(ip, id)
        counts.hosts += 1
      } else {
        const fields = [
          ['hostname', text(host.hostname)],
          ['os', text(host.os)],
          ['subnet', text(host.subnet)],
          ['state', oneOf(HOST_STATES, text(host.state), undefined)],
          ['source', text(host.source)],
          ['confidence', oneOf(CONFIDENCES, text(host.confidence), undefined)],
        ].filter(([, value]) => value !== undefined && value !== '')
        if (fields.length > 0) {
          db.prepare(
            `UPDATE internal_hosts SET ${fields.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
          ).run(...fields.map(([, value]) => value), now, id)
        }
      }
    }

    const serviceIdByKey = new Map()
    for (const service of list(args.internal_services)) {
      const hostId = text(service.host_id) || findHost(text(service.ip ?? service.host))
      const port = num(service.port, 0)
      if (!hostId || port < 1 || port > 65535) {
        warnings.push('internal_services: entry without resolvable host/port skipped')
        continue
      }
      const protocol = text(service.protocol) || 'tcp'
      const key = `${hostId}:${port}:${protocol}`
      const existing = db
        .prepare('SELECT id FROM internal_services WHERE host_id = ? AND port = ? AND protocol = ?')
        .get(hostId, port, protocol)
      let id = existing ? existing.id : undefined
      if (!id) {
        id = newId('IS-')
        db.prepare(
          `INSERT INTO internal_services
           (id, project_name, host_id, port, protocol, service, banner, state, source, last_seen, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          project,
          hostId,
          port,
          protocol,
          text(service.service),
          text(service.banner),
          oneOf(SERVICE_STATES, text(service.state), 'open'),
          text(service.source),
          text(service.last_seen) || now,
          now,
          now,
        )
        counts.services += 1
      } else {
        db.prepare(
          `UPDATE internal_services SET service = COALESCE(NULLIF(?, ''), service),
             banner = COALESCE(NULLIF(?, ''), banner), updated_at = ? WHERE id = ?`,
        ).run(text(service.service), text(service.banner), now, id)
      }
      serviceIdByKey.set(key, id)
    }

    const footholdIdByEntry = new Map()
    for (const foothold of list(args.footholds)) {
      const entry = text(foothold.entry_host_port)
      if (entry.length === 0) {
        warnings.push('footholds: entry without entry_host_port skipped')
        continue
      }
      const existing = db
        .prepare('SELECT id FROM footholds WHERE project_name = ? AND entry_host_port = ?')
        .get(project, entry)
      let id = existing ? existing.id : undefined
      if (!id) {
        id = newId('IF-')
        db.prepare(
          `INSERT INTO footholds
           (id, project_name, entry_host_port, entry_vuln_id, access_type, privilege_level, status, evidence, notes,
            established_at, last_verified_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          project,
          entry,
          text(foothold.entry_vuln_id),
          oneOf(ACCESS_TYPES, text(foothold.access_type), 'other'),
          oneOf(PRIVILEGE_LEVELS, text(foothold.privilege_level), 'unknown'),
          oneOf(FOOTHOLD_STATUSES, text(foothold.status), 'established'),
          text(foothold.evidence),
          text(foothold.notes),
          text(foothold.established_at) || now,
          text(foothold.last_verified_at) || now,
          now,
          now,
        )
        counts.footholds += 1
      } else {
        db.prepare(
          `UPDATE footholds SET access_type = COALESCE(NULLIF(?, ''), access_type),
             privilege_level = COALESCE(NULLIF(?, ''), privilege_level),
             status = COALESCE(NULLIF(?, ''), status), notes = COALESCE(NULLIF(?, ''), notes), updated_at = ?
           WHERE id = ?`,
        ).run(
          oneOf(ACCESS_TYPES, text(foothold.access_type), '') || '',
          oneOf(PRIVILEGE_LEVELS, text(foothold.privilege_level), '') || '',
          oneOf(FOOTHOLD_STATUSES, text(foothold.status), '') || '',
          text(foothold.notes),
          now,
          id,
        )
      }
      footholdIdByEntry.set(entry, id)
      const relatedHosts = Array.isArray(foothold.host_ips) ? foothold.host_ips : []
      for (const ipValue of relatedHosts) {
        const ip = text(ipValue)
        if (ip.length === 0) continue
        const hostId = findHost(ip)
        if (!hostId) {
          warnings.push(`footholds: host ${ip} not registered before foothold; add it to internal_hosts`)
          continue
        }
        db.prepare(
          'INSERT OR IGNORE INTO foothold_hosts (foothold_id, internal_host_id, discovered_at, notes) VALUES (?,?,?,?)',
        ).run(id, hostId, now, '')
        counts.links += 1
      }
    }

    for (const credential of list(args.credentials)) {
      const type = oneOf(CREDENTIAL_TYPES, text(credential.type), 'other')
      const hostId = text(credential.host_id) || findHost(text(credential.ip ?? credential.host))
      const serviceKey = `${hostId ?? ''}:${num(credential.port, 0)}:${text(credential.protocol) || 'tcp'}`
      db.prepare(
        `INSERT INTO credentials
         (id, project_name, type, username, domain, secret, source, host_id, service_id, confidence, status, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        newId('IC-'),
        project,
        type,
        text(credential.username),
        text(credential.domain),
        text(credential.secret),
        text(credential.source),
        hostId ?? null,
        serviceIdByKey.get(serviceKey) ?? null,
        oneOf(CONFIDENCES, text(credential.confidence), 'medium'),
        oneOf(CREDENTIAL_STATUSES, text(credential.status), 'untested'),
        text(credential.notes),
        now,
        now,
      )
      counts.credentials += 1
    }

    for (const pivot of list(args.pivots)) {
      const footholdId =
        text(pivot.foothold_id) || footholdIdByEntry.get(text(pivot.entry_host_port)) || findFoothold(db, project, text(pivot.entry_host_port))
      if (!footholdId) {
        warnings.push('pivots: entry without a registered foothold skipped')
        continue
      }
      const kind = oneOf(PIVOT_KINDS, text(pivot.kind), 'chain')
      const localPort = num(pivot.local_port, 0)
      const id = newId('IP-')
      db.prepare(
        `INSERT INTO pivots
         (id, project_name, foothold_id, kind, local_host, local_port, local_protocol, tool, status, notes,
          established_at, last_verified_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        project,
        footholdId,
        kind,
        text(pivot.local_host) || '127.0.0.1',
        localPort,
        text(pivot.local_protocol),
        text(pivot.tool),
        oneOf(PIVOT_STATUSES, text(pivot.status), 'planned'),
        text(pivot.notes),
        text(pivot.established_at) || now,
        text(pivot.last_verified_at) || now,
        now,
        now,
      )
      counts.pivots += 1
      const hops = Array.isArray(pivot.hops) ? pivot.hops : []
      hops.forEach((hop, index) => {
        const refKind = hop && hop.ref_kind === 'internal_service' ? 'internal_service' : 'internal_host'
        const refId = text(hop && hop.ref_id)
        if (refId.length === 0) return
        db.prepare(
          'INSERT INTO pivot_hops (pivot_id, seq, ref_kind, ref_id, label, via) VALUES (?,?,?,?,?,?)',
        ).run(id, index, refKind, refId, text(hop && hop.label), text(hop && hop.via))
        counts.hops += 1
      })
    }
  })

  holder.refreshFileStamp()
  const summary = [
    `${LOG} internal scope updated for project "${project}"`,
    `hosts +${counts.hosts}, services +${counts.services}, footholds +${counts.footholds}, host links +${counts.links}, credentials +${counts.credentials}, pivots +${counts.pivots}, hops +${counts.hops}`,
  ]
  if (warnings.length > 0) summary.push(...warnings.slice(0, 8).map((warning) => `warning: ${warning}`))
  return { text: summary.join('\n') }
}

function findFoothold(db, project, entry) {
  if (!entry) return undefined
  const row = db.prepare('SELECT id FROM footholds WHERE project_name = ? AND entry_host_port = ?').get(project, entry)
  return row ? row.id : undefined
}

/* ------------------------------------------------------------- audit -- */

export function auditCompleteness({ holder, args }) {
  const db = ensureDb(holder)
  const projectFilter = normalizeProjectName(text(args.project_name))
  const assets = db
    .prepare('SELECT host_port, project_name, interfaces, leaked_infos, test_parameters, tech_stack FROM assets')
    .all()
  const grouped = new Map()
  for (const row of assets) {
    const project = normalizeProjectName(row.project_name)
    if (projectFilter && project !== projectFilter) continue
    const entry = grouped.get(project) ?? {
      assets: 0,
      missingInterfaces: 0,
      missingLeaks: 0,
      missingParameters: 0,
      missingTech: 0,
    }
    entry.assets += 1
    if (normalizeInterfaces(row.interfaces, row.interface_dir).length === 0) entry.missingInterfaces += 1
    if (normalizeLeaks(row.leaked_infos).length === 0) entry.missingLeaks += 1
    if (normalizeTestParameters(row.test_parameters).length === 0) entry.missingParameters += 1
    if (text(row.tech_stack).length === 0) entry.missingTech += 1
    grouped.set(project, entry)
  }

  const vulns = db.prepare('SELECT id, vuln_name, description, impact, reproduction_steps, related_vuln_ids FROM vulnerabilities').all()
  const missingRepro = vulns.filter((row) => text(row.reproduction_steps).length < 50)
  const missingImpact = vulns.filter((row) => text(row.impact).length === 0)
  const missingDescription = vulns.filter((row) => text(row.description).length === 0)

  const countByProject = (table) => {
    const counts = new Map()
    for (const row of db.prepare(`SELECT project_name FROM ${table}`).all()) {
      const project = normalizeProjectName(row.project_name)
      counts.set(project, (counts.get(project) || 0) + 1)
    }
    return counts
  }
  const footholdCounts = countByProject('footholds')
  const hostCounts = countByProject('internal_hosts')
  const serviceCounts = countByProject('internal_services')
  const credentialCounts = countByProject('credentials')
  const pivotCounts = countByProject('pivots')
  const snapshotCounts = countByProject('snapshot_sessions')

  const lines = [`${LOG} completeness audit${projectFilter ? ` (project: ${projectFilter})` : ''}`]
  for (const [project, entry] of grouped) {
    const count = (map) => map.get(project) || 0
    lines.push(
      `- ${project}: assets ${entry.assets} (missing interfaces ${entry.missingInterfaces}, leaks ${entry.missingLeaks}, test parameters ${entry.missingParameters}, tech stack ${entry.missingTech})`,
    )
    lines.push(
      `  internal: footholds ${count(footholdCounts)}, hosts ${count(hostCounts)}, services ${count(serviceCounts)}, credentials ${count(credentialCounts)}, pivots ${count(pivotCounts)}; snapshots ${count(snapshotCounts)}`,
    )
  }
  lines.push(
    `${LOG} vulnerabilities: ${vulns.length}; missing reproduction_steps ${missingRepro.length}, description ${missingDescription.length}, impact ${missingImpact.length}`,
  )
  if (missingRepro.length > 0) lines.push(`  incomplete findings: ${missingRepro.slice(0, 8).map((row) => row.id).join(', ')}`)
  if (grouped.size === 0) lines.push('  no assets registered yet')
  lines.push(
    'Fill gaps with cortex_sync_asset_info (interfaces/leaks/test_parameters), cortex_save_vuln (complete reproduction), cortex_sync_internal_scope (internal ops) and cortex_save_snapshot (task progress).',
  )
  return { text: lines.join('\n') }
}
