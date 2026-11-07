/**
 * Agent tools for the Cortex database (non-MCP access).
 *
 * The plugin exposes the same data the UI uses through `ctx.tools.register`, so
 * conversations can read and update the local Cortex library without any MCP
 * server. Every tool shares the Host's single `DatabaseHolder` connection and
 * honours the same schema-v5 guard and read-only mode as the HTTP API.
 */
import { withBusyRetry } from '../db.js'
import { normalizeInterfaces, normalizeLeaks, normalizeTestParameters } from './normalize-asset.js'

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']
const STATUSES = ['Confirmed', 'Inconclusive', 'Retest_Passed']
const REALMS = ['web', 'internal', 'all']

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
}

const renderText = (_args, value) => [{ type: 'text', text: String(value && value.text !== undefined ? value.text : value) }]

/** @param {string} name @param {string} description @param {Record<string, any>} properties @param {string[]} required @param {(args:any)=>Promise<{text:string}>} execute */
function defineTool(name, description, properties, required, execute) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    execute: async (args) => {
      const result = await execute(args && typeof args === 'object' ? args : {})
      return { text: result.text }
    },
    presentCall: (args) => ({ card: 'generic', title: name, kind: 'other', rawInput: args }),
  }
}

function jsonArray(raw) {
  try {
    const value = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function parseJsonList(raw) {
  try {
    const value = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function todayStamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

function nextVulnId(db) {
  const stamp = todayStamp()
  const prefix = `VULN-${stamp}-`
  const rows = db.prepare('SELECT id FROM vulnerabilities WHERE id LIKE ?').all(`${prefix}%`)
  let max = 0
  for (const row of rows) {
    const suffix = Number(String(row.id).slice(prefix.length))
    if (Number.isFinite(suffix) && suffix > max) max = suffix
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
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

function jsonColumn(value) {
  return JSON.stringify(Array.isArray(value) ? value : [])
}

function uniqueJsonMerge(existingRaw, additions) {
  const merged = [...parseJsonList(existingRaw)]
  const seen = new Set(merged.map((entry) => JSON.stringify(entry)))
  for (const entry of Array.isArray(additions) ? additions : []) {
    const key = JSON.stringify(entry)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  return merged
}

function text(value) {
  return value === null || value === undefined ? '' : String(value)
}

function ensureDb(holder) {
  const status = holder.ensure()
  if (!status.compatible || holder.db === null) {
    const reason = status.error || `unsupported schema v${status.schemaVersion ?? '?'}`
    throw new Error(`Cortex database unavailable: ${reason}. This plugin supports schema v5 only and never migrates.`)
  }
  return holder.db
}

function assertWritable(holder) {
  if (holder.readOnly) throw new Error('Cortex database is in read-only mode (CORTEX_DB_READONLY); write rejected.')
}

function severityClause(value) {
  return value !== undefined && SEVERITIES.includes(value) ? value : undefined
}

function statusClause(value) {
  return value !== undefined && STATUSES.includes(value) ? value : undefined
}

function realmClause(value) {
  return value === 'web' || value === 'internal' ? value : undefined
}

const LIMIT = { type: 'integer', minimum: 1, maximum: 200 }
const PAGE = { type: 'integer', minimum: 1, maximum: 100000 }
const REQUESTED = ['id']
const LOG = '[cortex]'

/** Build tool definitions bound to one Host data access. */
export function createCortexToolDefinitions({ holder, config }) {
  const readOnly = Boolean((config && config.readOnly) || holder.readOnly)

  const listVulns = defineTool(
    'cortex_list_vulns',
    'List local Cortex vulnerabilities (vulnerability library) with optional realm/search/severity/status filters and paging. Returns a compact table plus totals. Use ids with cortex_get_vuln.',
    {
      realm: { type: 'string', enum: REALMS, description: 'web | internal | all (default all)' },
      search: { type: 'string', description: 'Substring match on id/host/name/type/target/service host' },
      severity: { type: 'string', enum: SEVERITIES },
      status: { type: 'string', enum: STATUSES },
      page: PAGE,
      pageSize: LIMIT,
    },
    [],
    async (args) => {
      const db = ensureDb(holder)
      const where = []
      const params = []
      const realm = realmClause(args.realm)
      if (realm) {
        where.push('realm = ?')
        params.push(realm)
      }
      const severity = severityClause(args.severity)
      if (severity) {
        where.push('severity = ?')
        params.push(severity)
      }
      const status = statusClause(args.status)
      if (status) {
        where.push('status = ?')
        params.push(status)
      }
      const search = text(args.search).trim()
      if (search) {
        where.push('(id LIKE ? OR host LIKE ? OR vuln_name LIKE ? OR vuln_type LIKE ? OR target_url LIKE ? OR service_host LIKE ?)')
        for (let index = 0; index < 6; index += 1) params.push(`%${search.replace(/[%_]/g, '')}%`)
      }
      const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM vulnerabilities${whereSql}`).get(...params).c) || 0
      const page = Math.max(1, Number(args.page) || 1)
      const pageSize = Math.min(200, Math.max(1, Number(args.pageSize) || 20))
      const rows = db
        .prepare(`SELECT id, host, realm, severity, status, vuln_name, service_host, created_at FROM vulnerabilities${whereSql} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, (page - 1) * pageSize)
      const lines = rows.map(
        (row) =>
          `${row.id} | ${row.severity} | ${row.status} | ${row.realm} | ${row.host}${row.service_host ? ` (${row.service_host})` : ''} | ${row.vuln_name}`,
      )
      const header = `${LOG} ${total} vulnerabilities (page ${page}, ${pageSize}/page; realm ${args.realm || 'all'})`
      return { text: [header, ...lines].join('\n') }
    },
  )

  const getVuln = defineTool(
    'cortex_get_vuln',
    'Read one full Cortex vulnerability record by id: description, impact, affected interfaces, reproduction steps, remediation, retest history, related ids and metadata.',
    { id: { type: 'string', minLength: 1, maxLength: 200 } },
    REQUESTED,
    async (args) => {
      const db = ensureDb(holder)
      const row = db.prepare('SELECT * FROM vulnerabilities WHERE id = ?').get(text(args.id).trim())
      if (!row) return { text: `${LOG} vulnerability not found: ${args.id}` }
      const parts = [
        `# ${row.vuln_name} (${row.id})`,
        `host: ${row.host}`,
        `realm: ${row.realm}${row.service_host ? ` · service_host: ${row.service_host}` : ''}`,
        `severity: ${row.severity} · status: ${row.status} · type: ${row.vuln_type}`,
        `target: ${row.target_url}${row.entry_point ? ` · entry: ${row.entry_point}` : ''}`,
        `created: ${row.created_at}`,
        '',
        '## description',
        text(row.description),
        '',
        '## impact',
        text(row.impact),
        '',
        `## affected_interfaces\n${jsonArray(row.affected_interfaces).map((item) => `- ${text(item)}`).join('\n')}`,
        '',
        `## reproduction_steps\n${text(row.reproduction_steps)}`,
        '',
        `## remediation\n${jsonArray(row.remediation).map((item) => `- ${text(item)}`).join('\n')}`,
        '',
        `## retest_results\n${JSON.stringify(jsonArray(row.retest_results), null, 2)}`,
        '',
        `## related_vuln_ids\n${jsonArray(row.related_vuln_ids).join(', ')}`,
      ]
      return { text: parts.join('\n') }
    },
  )

  const updateStatus = defineTool(
    'cortex_update_vuln_status',
    'Update the status of one Cortex vulnerability (Confirmed | Inconclusive | Retest_Passed). Only the status column changes; original evidence is preserved.',
    {
      id: { type: 'string', minLength: 1, maxLength: 200 },
      status: { type: 'string', enum: STATUSES },
    },
    ['id', 'status'],
    async (args) => {
      assertWritable(holder)
      const db = ensureDb(holder)
      const id = text(args.id).trim()
      const status = text(args.status).trim()
      if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`)
      const existing = db.prepare('SELECT status FROM vulnerabilities WHERE id = ?').get(id)
      if (!existing) return { text: `${LOG} vulnerability not found: ${id}` }
      await withBusyRetry(() =>
        db.exec('BEGIN IMMEDIATE') === undefined
          ? (() => {
              try {
                db.prepare('UPDATE vulnerabilities SET status = ? WHERE id = ?').run(status, id)
                db.exec('COMMIT')
              } catch (error) {
                try {
                  db.exec('ROLLBACK')
                } catch {
                  /* ignore */
                }
                throw error
              }
            })()
          : undefined,
      )
      holder.refreshFileStamp()
      return { text: `${LOG} ${id} status: ${existing.status} -> ${status}` }
    },
  )

  const appendRetest = defineTool(
    'cortex_append_retest',
    'Append one retest conclusion to a Cortex vulnerability (append-only; existing retest entries and all original evidence stay untouched). conclusion is Markdown.',
    {
      id: { type: 'string', minLength: 1, maxLength: 200 },
      timeRange: { type: 'string', minLength: 1, maxLength: 200 },
      conclusion: { type: 'string', minLength: 1, maxLength: 50000 },
    },
    ['id', 'timeRange', 'conclusion'],
    async (args) => {
      assertWritable(holder)
      const db = ensureDb(holder)
      const id = text(args.id).trim()
      const row = db.prepare('SELECT retest_results FROM vulnerabilities WHERE id = ?').get(id)
      if (!row) return { text: `${LOG} vulnerability not found: ${id}` }
      const results = jsonArray(row.retest_results)
      results.push({ time_range: text(args.timeRange), conclusion: text(args.conclusion) })
      await withBusyRetry(() =>
        db.exec('BEGIN IMMEDIATE') === undefined
          ? (() => {
              try {
                db.prepare('UPDATE vulnerabilities SET retest_results = ? WHERE id = ?').run(JSON.stringify(results), id)
                db.exec('COMMIT')
              } catch (error) {
                try {
                  db.exec('ROLLBACK')
                } catch {
                  /* ignore */
                }
                throw error
              }
            })()
          : undefined,
      )
      holder.refreshFileStamp()
      return { text: `${LOG} appended retest result #${results.length} to ${id} (${args.timeRange})` }
    },
  )

  const saveVuln = defineTool(
    'cortex_save_vuln',
    'Insert or update a local Cortex vulnerability record (dedupe with cortex_list_vulns first). Omit id to auto-assign VULN-YYYYMMDD-NNN; passing an existing id overwrites the provided fields. reproduction_steps is Markdown (### 步骤 / **请求** / **响应** / **判据** + http code block).',
    {
      id: { type: 'string', description: 'Existing id to update; omit for a new record' },
      host: { type: 'string', description: 'Entry asset host, e.g. 127.0.0.1:8080 or https://example.com' },
      vuln_name: { type: 'string' },
      vuln_type: { type: 'string', description: 'e.g. SQL Injection / IDOR (default Unclassified)' },
      severity: { type: 'string', enum: SEVERITIES },
      target_url: { type: 'string' },
      realm: { type: 'string', enum: ['web', 'internal'] },
      service_host: { type: 'string', description: 'Internal service label, e.g. 10.0.1.10:6379 (realm=internal)' },
      internal_service_id: { type: 'string' },
      entry_point: { type: 'string' },
      description: { type: 'string' },
      impact: { type: 'string' },
      affected_interfaces: { type: 'array', items: { type: 'string' } },
      reproduction_steps: { type: 'string' },
      remediation: { type: 'array', items: { type: 'string' } },
      crypto_details: { type: 'string' },
      test_boundaries: { type: 'string' },
      status: { type: 'string', enum: STATUSES },
      related_vuln_ids: { type: 'array', items: { type: 'string' } },
    },
    ['host', 'vuln_name', 'severity', 'target_url'],
    async (args) => {
      assertWritable(holder)
      const db = ensureDb(holder)
      const severity = text(args.severity)
      if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`)
      const status = text(args.status) || 'Confirmed'
      if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`)
      const realm = text(args.realm) || 'web'
      if (realm !== 'web' && realm !== 'internal') throw new Error('realm must be web or internal')
      const existingId = text(args.id).trim()
      const existing = existingId ? db.prepare('SELECT id FROM vulnerabilities WHERE id = ?').get(existingId) : null
      if (existingId && !existing) throw new Error(`id ${existingId} does not exist; omit id to create a new record`)
      const id = existingId || nextVulnId(db)
      const now = new Date().toISOString()
      const fields = {
        host: text(args.host).trim(),
        entry_point: text(args.entry_point),
        vuln_name: text(args.vuln_name).trim(),
        vuln_type: text(args.vuln_type) || 'Unclassified',
        severity,
        target_url: text(args.target_url).trim(),
        description: text(args.description),
        impact: text(args.impact),
        affected_interfaces: jsonColumn(args.affected_interfaces),
        reproduction_steps: text(args.reproduction_steps),
        remediation: jsonColumn(args.remediation),
        crypto_details: text(args.crypto_details),
        test_boundaries: text(args.test_boundaries),
        related_vuln_ids: jsonColumn(args.related_vuln_ids),
        status,
        realm,
        service_host: text(args.service_host),
        internal_service_id: text(args.internal_service_id),
      }
      for (const key of ['host', 'vuln_name', 'target_url']) {
        if (!fields[key]) throw new Error(`${key} is required`)
      }
      runWrite(db, () => {
        if (existing) {
          const columns = Object.keys(fields)
          db.prepare(`UPDATE vulnerabilities SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`).run(
            ...columns.map((column) => fields[column]),
            id,
          )
        } else {
          const columns = ['id', ...Object.keys(fields), 'created_at']
          const values = [id, ...Object.keys(fields).map((column) => fields[column]), now]
          db.prepare(`INSERT INTO vulnerabilities (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
            ...values,
          )
        }
      })
      holder.refreshFileStamp()
      return { text: `${LOG} ${existing ? 'updated' : 'saved'} ${id} | ${fields.severity} | ${fields.host} | ${fields.vuln_name}` }
    },
  )

  const syncAsset = defineTool(
    'cortex_sync_asset_info',
    'Insert or update local Cortex asset context. mode=merge (default) appends canonicalized array entries and only overwrites provided scalars; mode=replace replaces the whole asset snapshot. Canonical fields: interfaces[] = {path, method?, params?, request?} where request is a complete raw HTTP request; leaked_infos[] = {info_type, value, source, potential_impact}; test_parameters[] = {name, endpoint, location (path|query|body|header|cookie), values[], pattern?, source, tested?, notes?, related_vuln_ids?}. Common aliases are normalized (raw->request, type->info_type, file->source, param->name, where->location, example->values[0]).',
    {
      host_port: { type: 'string', description: 'Full URL/authority, e.g. http://127.0.0.1:8080/' },
      project_name: { type: 'string' },
      host: { type: 'string' },
      tech_stack: { type: 'string' },
      auth_required: { type: 'boolean' },
      status: { type: 'string', enum: ['Alive', 'Dead', 'WAF_Blocked'] },
      interfaces: { type: 'array', items: { type: 'object', description: '{path (required), method?, params? (query/body string), request? (complete raw HTTP request)}' }, description: 'Structured API interfaces; raw static files are not interfaces' },
      leaked_infos: { type: 'array', items: { type: 'object', description: '{info_type (Credential|API_Key|Token|PII|Internal_IP|Other), value, source, potential_impact}' } },
      test_parameters: { type: 'array', items: { type: 'object', description: '{name, endpoint, location, values[], pattern?, source, tested?, notes?, related_vuln_ids?}' } },
      related_vuln_ids: { type: 'array', items: { type: 'string' } },
      mode: { type: 'string', enum: ['merge', 'replace'] },
    },
    ['host_port', 'project_name'],
    async (args) => {
      assertWritable(holder)
      const db = ensureDb(holder)
      const hostPort = text(args.host_port).trim()
      const project = text(args.project_name).trim()
      if (!hostPort || !project) throw new Error('host_port and project_name are required')
      const merge = args.mode !== 'replace'
      const existing = db.prepare('SELECT * FROM assets WHERE host_port = ?').get(hostPort)
      const now = new Date().toISOString()
      const arrayField = (name, normalize) => {
        const value = args[name] !== undefined && normalize ? normalize(args[name]) : undefined
        if (merge && existing) return jsonColumn(uniqueJsonMerge(existing[name], value))
        return jsonColumn(value)
      }
      const scalar = (name, fallback) =>
        args[name] !== undefined ? args[name] : merge && existing ? existing[name].valueOf() : fallback
      const values = {
        host: merge && existing ? existing.host : text(args.host) || text(new URL(hostPort.startsWith('http') ? hostPort : `http://${hostPort}`).host),
        project_name: project,
        tech_stack: args.tech_stack !== undefined ? text(args.tech_stack) : merge && existing ? existing.tech_stack : '',
        auth_required: scalar('auth_required', false) ? 1 : 0,
        status: scalar('status', 'Alive'),
        interfaces: arrayField('interfaces', normalizeInterfaces),
        leaked_infos: arrayField('leaked_infos', normalizeLeaks),
        test_parameters: arrayField('test_parameters', normalizeTestParameters),
        related_vuln_ids: arrayField('related_vuln_ids', (value) =>
          Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [],
        ),
        last_seen: now,
      }
      runWrite(db, () => {
        if (existing) {
          const columns = Object.keys(values)
          db.prepare(`UPDATE assets SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE host_port = ?`).run(
            ...columns.map((column) => values[column]),
            hostPort,
          )
        } else {
          const columns = ['host_port', ...Object.keys(values)]
          db.prepare(`INSERT INTO assets (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
            hostPort,
            ...Object.keys(values).map((column) => values[column]),
          )
        }
      })
      holder.refreshFileStamp()
      return {
        text: `${LOG} ${existing ? (merge ? 'merged' : 'replaced') : 'created'} asset ${hostPort} (project ${project})`,
      }
    },
  )

  const saveSnapshot = defineTool(
    'cortex_save_snapshot',
    'Create or update a local Cortex cognitive snapshot (认知快照) for the current task: project, phase, targets, unfinished tasks, failed paths, tested interfaces/notes/next steps and related vulns. Call it at task milestones, before context compaction and at session end. Omit session_id to create a new snapshot; pass session_id to update one; force_new=true creates another session for a project that already has one. Updates keep a previous_state rollback buffer.',
    {
      project_name: { type: 'string', minLength: 1, maxLength: 120 },
      current_phase: { type: 'string', maxLength: 200 },
      target_hosts: { type: 'array', items: { type: 'string' } },
      unfinished_tasks: { type: 'array', items: { type: 'string' } },
      failed_paths: { type: 'array', items: { type: 'string' } },
      tested_interfaces: { type: 'array', items: { type: 'object' }, description: 'Tested interface matrix entries (endpoint/result/...)' },
      notes: { type: 'string', maxLength: 30000 },
      related_vuln_ids: { type: 'array', items: { type: 'string' } },
      next_steps: { type: 'string', maxLength: 10000 },
      session_id: { type: 'string', maxLength: 100 },
      parent_session_id: { type: 'string', maxLength: 100 },
      force_new: { type: 'boolean' },
    },
    ['project_name'],
    async (args) => {
      assertWritable(holder)
      const db = ensureDb(holder)
      const project = text(args.project_name).trim()
      if (!project) throw new Error('project_name is required')
      const stringList = (name) =>
        args[name] === undefined
          ? undefined
          : JSON.stringify(
              (Array.isArray(args[name]) ? args[name] : [])
                .filter((entry) => typeof entry === 'string')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
            )
      const objectList = (name) =>
        args[name] === undefined
          ? undefined
          : JSON.stringify((Array.isArray(args[name]) ? args[name] : []).filter((entry) => entry && typeof entry === 'object'))
      const fields = {
        project_name: project,
        current_phase: args.current_phase !== undefined ? text(args.current_phase) : undefined,
        target_hosts: stringList('target_hosts'),
        unfinished_tasks: stringList('unfinished_tasks'),
        failed_paths: stringList('failed_paths'),
        tested_interfaces: objectList('tested_interfaces'),
        notes: args.notes !== undefined ? text(args.notes) : undefined,
        related_vuln_ids: stringList('related_vuln_ids'),
        next_steps: args.next_steps !== undefined ? text(args.next_steps) : undefined,
      }
      const now = new Date().toISOString()
      const sessionId = text(args.session_id).trim()
      if (sessionId) {
        const existing = db.prepare('SELECT * FROM snapshot_sessions WHERE session_id = ?').get(sessionId)
        if (!existing) throw new Error(`snapshot ${sessionId} not found; omit session_id to create a new one`)
        const previous = {
          project_name: existing.project_name,
          target_hosts: jsonArray(existing.target_hosts),
          current_phase: existing.current_phase,
          unfinished_tasks: jsonArray(existing.unfinished_tasks),
          failed_paths: jsonArray(existing.failed_paths),
          tested_interfaces: jsonArray(existing.tested_interfaces),
          notes: existing.notes,
          related_vuln_ids: jsonArray(existing.related_vuln_ids),
          next_steps: existing.next_steps,
        }
        const sets = []
        const values = []
        for (const [column, value] of Object.entries(fields)) {
          if (value === undefined) continue
          sets.push(`${column} = ?`)
          values.push(value)
        }
        sets.push('previous_state = ?', 'updated_at = ?')
        values.push(JSON.stringify(previous), now, sessionId)
        await runWrite(db, () =>
          db.prepare(`UPDATE snapshot_sessions SET ${sets.join(', ')} WHERE session_id = ?`).run(...values),
        )
        holder.refreshFileStamp()
        return { text: `${LOG} snapshot updated: ${sessionId} | ${project} | phase: ${fields.current_phase ?? existing.current_phase}` }
      }
      if (args.force_new !== true) {
        const candidates = db
          .prepare('SELECT session_id, current_phase, updated_at FROM snapshot_sessions WHERE project_name = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 5')
          .all(project)
        if (candidates.length > 0) {
          return {
            text: `${LOG} project ${project} already has snapshots: ${candidates
              .map((row) => `${row.session_id} (${row.current_phase || '-'}, ${row.updated_at})`)
              .join('; ')} — pass session_id to update one, or force_new=true to create a new session.`,
          }
        }
      }
      const id = globalThis.crypto?.randomUUID?.() ?? `snap-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const columns = [
        'session_id', 'project_name', 'target_hosts', 'current_phase', 'unfinished_tasks', 'failed_paths',
        'tested_interfaces', 'notes', 'related_vuln_ids', 'next_steps', 'previous_state',
        'parent_session_id', 'archived_at', 'created_at', 'updated_at',
      ]
      const values = [
        id,
        project,
        fields.target_hosts ?? '[]',
        fields.current_phase ?? '',
        fields.unfinished_tasks ?? '[]',
        fields.failed_paths ?? '[]',
        fields.tested_interfaces ?? '[]',
        fields.notes ?? '',
        fields.related_vuln_ids ?? '[]',
        fields.next_steps ?? '',
        null,
        text(args.parent_session_id) || null,
        null,
        now,
        now,
      ]
      await runWrite(db, () =>
        db
          .prepare(`INSERT INTO snapshot_sessions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...values),
      )
      holder.refreshFileStamp()
      return { text: `${LOG} snapshot saved: ${id} | ${project} | phase: ${fields.current_phase || '-'}` }
    },
  )

  const listAssets = defineTool(
    'cortex_list_assets',
    'List local Cortex assets (host_port, project, tech stack, interface/leak/test-parameter counts). Optional search/status/project filters.',
    {
      search: { type: 'string' },
      status: { type: 'string', enum: ['Alive', 'Dead', 'WAF_Blocked', 'all'] },
      project: { type: 'string' },
    },
    [],
    async (args) => {
      const db = ensureDb(holder)
      const where = []
      const params = []
      const search = text(args.search).trim()
      if (search) {
        where.push('(host_port LIKE ? OR host LIKE ? OR project_name LIKE ? OR tech_stack LIKE ?)')
        for (let index = 0; index < 4; index += 1) params.push(`%${search.replace(/[%_]/g, '')}%`)
      }
      if (args.status && args.status !== 'all') {
        where.push('status = ?')
        params.push(args.status)
      }
      const project = text(args.project).trim()
      if (project) {
        where.push('project_name = ?')
        params.push(project)
      }
      const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      const rows = db
        .prepare(`SELECT host_port, host, project_name, tech_stack, status, auth_required, interfaces, leaked_infos, test_parameters, related_vuln_ids, last_seen FROM assets${whereSql} ORDER BY last_seen DESC LIMIT 500`)
        .all(...params)
      const lines = rows.map(
        (row) =>
          `${row.host_port} | ${row.status} | ${row.project_name} | ifaces=${jsonArray(row.interfaces).length} leaks=${jsonArray(row.leaked_infos).length} params=${jsonArray(row.test_parameters).length} vulns=${jsonArray(row.related_vuln_ids).length} | ${row.tech_stack}`,
      )
      return { text: [`${LOG} ${rows.length} assets`, ...lines].join('\n') }
    },
  )

  const getAsset = defineTool(
    'cortex_get_asset',
    'Read one Cortex asset by host_port (URL-encoded not required): project, tech stack, structured interfaces with raw requests, leaked info, test parameters and related vulnerability ids.',
    { hostPort: { type: 'string', minLength: 1, maxLength: 4000 } },
    ['hostPort'],
    async (args) => {
      const db = ensureDb(holder)
      const row = db.prepare('SELECT * FROM assets WHERE host_port = ?').get(text(args.hostPort).trim())
      if (!row) return { text: `${LOG} asset not found: ${args.hostPort}` }
      const interfaces = normalizeInterfaces(row.interfaces, row.interface_dir)
      const leaks = normalizeLeaks(row.leaked_infos)
      const testParameters = normalizeTestParameters(row.test_parameters)
      const relatedIds = jsonArray(row.related_vuln_ids).filter((entry) => typeof entry === 'string')
      const parts = [
        `# ${row.host_port}`,
        `host: ${row.host} · project: ${row.project_name}`,
        `status: ${row.status} · auth_required: ${row.auth_required ? 'true' : 'false'} · last_seen: ${row.last_seen}`,
        `tech_stack: ${row.tech_stack}`,
        '',
        `## interfaces (${interfaces.length})`,
        JSON.stringify(interfaces, null, 2),
        '',
        `## leaked_infos (${leaks.length})`,
        JSON.stringify(leaks, null, 2),
        '',
        `## test_parameters (${testParameters.length})`,
        JSON.stringify(testParameters, null, 2),
        '',
        `## related_vuln_ids\n${relatedIds.join(', ')}`,
      ]
      return { text: parts.join('\n') }
    },
  )

  const listSnapshots = defineTool(
    'cortex_list_snapshots',
    'List local Cortex snapshot sessions (project, current phase, targets, parent/child, archived flag). Optional project filter.',
    {
      project: { type: 'string' },
      includeArchived: { type: 'boolean' },
    },
    [],
    async (args) => {
      const db = ensureDb(holder)
      const where = []
      const params = []
      const project = text(args.project).trim()
      if (project) {
        where.push('project_name = ?')
        params.push(project)
      }
      if (args.includeArchived !== true) where.push('archived_at IS NULL')
      const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      const rows = db
        .prepare(`SELECT session_id, project_name, current_phase, parent_session_id, archived_at, updated_at, target_hosts FROM snapshot_sessions${whereSql} ORDER BY updated_at DESC LIMIT 200`)
        .all(...params)
      const lines = rows.map(
        (row) =>
          `${row.session_id} | ${row.project_name} | ${row.current_phase} | parent=${row.parent_session_id || '-'} | ${row.archived_at ? 'archived' : 'active'} | targets=${jsonArray(row.target_hosts).length} | ${row.updated_at}`,
      )
      return { text: [`${LOG} ${rows.length} snapshots`, ...lines].join('\n') }
    },
  )

  const getSnapshot = defineTool(
    'cortex_get_snapshot',
    'Read one Cortex snapshot session by session_id: the nine snapshot fields (project, targets, phase, unfinished tasks, failed paths, notes, tested interfaces, next steps, related vulns).',
    { sessionId: { type: 'string', minLength: 1, maxLength: 200 } },
    ['sessionId'],
    async (args) => {
      const db = ensureDb(holder)
      const row = db.prepare('SELECT * FROM snapshot_sessions WHERE session_id = ?').get(text(args.sessionId).trim())
      if (!row) return { text: `${LOG} snapshot not found: ${args.sessionId}` }
      return {
        text: [
          `# ${row.session_id} · ${row.project_name}`,
          `phase: ${row.current_phase} · updated: ${row.updated_at}${row.archived_at ? ' · archived' : ''}`,
          `target_hosts: ${jsonArray(row.target_hosts).join(', ')}`,
          `parent: ${row.parent_session_id || '-'}`,
          `related_vuln_ids: ${jsonArray(row.related_vuln_ids).join(', ')}`,
          '',
          `## unfinished_tasks\n${jsonArray(row.unfinished_tasks).map((item) => `- ${text(item)}`).join('\n')}`,
          '',
          `## failed_paths\n${jsonArray(row.failed_paths).map((item) => `- ${text(item)}`).join('\n')}`,
          '',
          `## tested_interfaces\n${JSON.stringify(jsonArray(row.tested_interfaces), null, 2)}`,
          '',
          `## notes\n${text(row.notes)}`,
          '',
          `## next_steps\n${text(row.next_steps)}`,
        ].join('\n'),
      }
    },
  )

  const internalOverview = defineTool(
    'cortex_internal_overview',
    'Summarise the local Cortex internal-operation scope: footholds, internal hosts/services, credentials (masked) and pivots, optionally scoped to one project.',
    { project: { type: 'string' } },
    [],
    async (args) => {
      const db = ensureDb(holder)
      const project = text(args.project).trim()
      const projectWhere = project ? ' AND project_name = ?' : ''
      const params = project ? [project] : []
      const count = (table) =>
        Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE 1=1${projectWhere}`).get(...params).c) || 0
      const projects = db
        .prepare(`SELECT DISTINCT project_name FROM assets WHERE project_name IS NOT NULL AND project_name != ''`)
        .all()
        .map((row) => row.project_name)
      const rows = [
        `${LOG} internal scope${project ? ` (project: ${project})` : ''}`,
        `projects: ${projects.join(', ') || '-'}`,
        `footholds: ${count('footholds')} · internal_hosts: ${count('internal_hosts')} · internal_services: ${count('internal_services')} · credentials: ${count('credentials')} · pivots: ${count('pivots')}`,
      ]
      return { text: rows.join('\n') }
    },
  )

  const graphSummary = defineTool(
    'cortex_graph_summary',
    'Summarise the derived Cortex memory graph (Nebula) for a realm: node/link counts by type plus the highest-degree nodes. Full graph is visualised in the Cortex panel.',
    { realm: { type: 'string', enum: REALMS } },
    [],
    async (args) => {
      ensureDb(holder)
      const [{ createGraphDatabaseAdapter }, { buildMemoryGraph }] = await Promise.all([
        import('./graph-adapter.js'),
        import('./graph-builder.js'),
      ])
      const adapter = createGraphDatabaseAdapter(holder)
      const graph = buildMemoryGraph(adapter, { scope: { kind: 'all' }, realm: realmClause(args.realm) || 'web' })
      const byType = {}
      for (const node of graph.nodes || []) byType[node.type] = (byType[node.type] || 0) + 1
      const degree = new Map()
      for (const link of graph.links || []) {
        degree.set(link.source, (degree.get(link.source) || 0) + 1)
        degree.set(link.target, (degree.get(link.target) || 0) + 1)
      }
      const labels = new Map((graph.nodes || []).map((node) => [node.id, node.label || node.id]))
      const top = [...degree.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([id, value]) => `${labels.get(id) || id} (${value})`)
      return {
        text: [
          `${LOG} memory graph · realm ${realmClause(args.realm) || 'web'} · ${(graph.nodes || []).length} nodes / ${(graph.links || []).length} links`,
          `by type: ${JSON.stringify(byType)}`,
          `top degree: ${top.join(', ')}`,
        ].join('\n'),
      }
    },
  )

  const tools = [
    listVulns,
    getVuln,
    saveVuln,
    updateStatus,
    appendRetest,
    listAssets,
    syncAsset,
    getAsset,
    listSnapshots,
    getSnapshot,
    saveSnapshot,
    internalOverview,
    graphSummary,
  ]
  return readOnly ? tools.map((tool) => ({ ...tool, description: `${tool.description} (current host: read-only)` })) : tools
}

/**
 * Register every Cortex tool on the DSH tool registry.
 * @param {{register: (definition:any)=>()=>void}} toolsService
 * @param {{holder:any, config:any}} dataAccess
 */
export function registerCortexTools(toolsService, { holder, config }) {
  const definitions = createCortexToolDefinitions({ holder, config })
  const disposers = definitions.map((definition) => toolsService.register(definition))
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }
}
