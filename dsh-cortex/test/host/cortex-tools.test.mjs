// Agent tools (non-MCP Cortex access): unit tests against a fixture schema-v5 DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createFixtureDb } from '../../fixtures/build.mjs'
import { createCortexHost } from '../../src/host/app.js'
import { createCortexToolDefinitions } from '../../src/host/cortex/tools.js'

const tempDir = mkdtempSync(join(tmpdir(), 'dsh-cortex-tools-'))
const dbPath = join(tempDir, 'data.db')
createFixtureDb(dbPath)

const host = createCortexHost({ config: { dbPath } })
const tools = createCortexToolDefinitions(host.dataAccess)
const byName = new Map(tools.map((tool) => [tool.name, tool]))

async function call(name, args) {
  const tool = byName.get(name)
  assert.ok(tool, `missing tool ${name}`)
  return tool.execute(args || {})
}

test('registers the Cortex agent tool surface without MCP', () => {
  const names = tools.map((tool) => tool.name)
  assert.deepEqual(names, [
    'cortex_list_vulns',
    'cortex_get_vuln',
    'cortex_save_vuln',
    'cortex_update_vuln_status',
    'cortex_append_retest',
    'cortex_list_assets',
    'cortex_sync_asset_info',
    'cortex_get_asset',
    'cortex_list_snapshots',
    'cortex_get_snapshot',
    'cortex_save_snapshot',
    'cortex_internal_overview',
    'cortex_graph_summary',
    'cortex_audit_completeness',
    'cortex_sync_internal_scope',
  ])
  for (const tool of tools) {
    assert.ok(tool.description.length > 20)
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.output && typeof tool.output.render === 'function')
  }
})

test('cortex_list_vulns filters and pages the fixture library', async () => {
  const all = await call('cortex_list_vulns', {})
  assert.match(all.text, /vulnerabilities/)
  const critical = await call('cortex_list_vulns', { severity: 'Critical', realm: 'web' })
  assert.match(critical.text, /Critical/)
  assert.ok(!critical.text.includes('Low'))
  const limited = await call('cortex_list_vulns', { pageSize: 2 })
  const lines = limited.text.split('\n')
  assert.equal(lines.length, 3) // header + 2 rows
})

test('cortex_get_vuln returns the full record', async () => {
  const list = await call('cortex_list_vulns', { pageSize: 1 })
  const id = list.text.split('\n')[1].split(' | ')[0]
  const detail = await call('cortex_get_vuln', { id })
  assert.match(detail.text, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(detail.text, /## description/)
  assert.match(detail.text, /## reproduction_steps/)
})

test('cortex_update_vuln_status writes only the status column', async () => {
  const list = await call('cortex_list_vulns', { pageSize: 1 })
  const id = list.text.split('\n')[1].split(' | ')[0]
  const before = await call('cortex_get_vuln', { id })
  const status = before.text.match(/status: (\w+)/)[1]
  const next = status === 'Confirmed' ? 'Inconclusive' : 'Confirmed'
  const result = await call('cortex_update_vuln_status', { id, status: next })
  assert.match(result.text, new RegExp(`${id} status: ${status} -> ${next}`))
  const after = await call('cortex_get_vuln', { id })
  assert.match(after.text, new RegExp(`status: ${next}`))
  await call('cortex_update_vuln_status', { id, status })
})

test('cortex_append_retest appends without touching original evidence', async () => {
  const list = await call('cortex_list_vulns', { pageSize: 1 })
  const id = list.text.split('\n')[1].split(' | ')[0]
  const before = await call('cortex_get_vuln', { id })
  const result = await call('cortex_append_retest', {
    id,
    timeRange: '2026-11-07 ~ 2026-11-07',
    conclusion: '### tool retest\n\n- still reproducible',
  })
  assert.match(result.text, /appended retest result/)
  const after = await call('cortex_get_vuln', { id })
  assert.ok(after.text.length > before.text.length)
  assert.match(after.text, /still reproducible/)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const row = db.prepare('SELECT retest_results FROM vulnerabilities WHERE id = ?').get(id)
  db.close()
  const parsed = JSON.parse(row.retest_results)
  assert.equal(parsed[parsed.length - 1].time_range, '2026-11-07 ~ 2026-11-07')
})

test('asset, snapshot, internal and graph tools return data', async () => {
  const assets = await call('cortex_list_assets', {})
  assert.match(assets.text, /assets/)
  const firstHostPort = assets.text.split('\n')[1].split(' | ')[0]
  const asset = await call('cortex_get_asset', { hostPort: firstHostPort })
  assert.match(asset.text, /## interfaces/)
  const snapshots = await call('cortex_list_snapshots', { includeArchived: true })
  assert.match(snapshots.text, /snapshots/)
  const firstSession = snapshots.text.split('\n')[1].split(' | ')[0]
  const snapshot = await call('cortex_get_snapshot', { sessionId: firstSession })
  assert.match(snapshot.text, /## notes/)
  const internal = await call('cortex_internal_overview', {})
  assert.match(internal.text, /footholds:/)
  const graph = await call('cortex_graph_summary', { realm: 'all' })
  assert.match(graph.text, /nodes \/ \d+ links/)
})

test('cortex_save_vuln inserts and updates records', async () => {
  const created = await call('cortex_save_vuln', {
    host: 'example.test:8080',
    vuln_name: 'Tool-created finding',
    severity: 'High',
    target_url: 'http://example.test:8080/tool',
    vuln_type: 'IDOR',
    description: 'created by the agent tool test',
    reproduction_steps: '### 步骤 1\n\n- request\n\n**判据**: 200',
  })
  const id = created.text.match(/VULN-\d{8}-\d{3}/)[0]
  assert.match(created.text, /saved/)
  const list = await call('cortex_list_vulns', { search: 'Tool-created finding' })
  assert.match(list.text, new RegExp(id))
  const updated = await call('cortex_save_vuln', {
    id,
    host: 'example.test:8080',
    vuln_name: 'Tool-created finding (updated)',
    severity: 'Critical',
    target_url: 'http://example.test:8080/tool',
    description: 'second write',
  })
  assert.match(updated.text, /updated/)
  const detail = await call('cortex_get_vuln', { id })
  assert.match(detail.text, /Tool-created finding \(updated\)/)
  assert.match(detail.text, /second write/)
})

test('cortex_sync_asset_info merges and replaces asset snapshots', async () => {
  const hostPort = 'http://example.test:9000/'
  const created = await call('cortex_sync_asset_info', {
    host_port: hostPort,
    project_name: 'tool-test',
    tech_stack: 'nginx, PHP',
    interfaces: [{ path: '/a', method: 'GET' }],
    leaked_infos: [{ info_type: 'API_Key', value: 'demo-key', source: '/js/app.js', potential_impact: 'demo' }],
    test_parameters: [{ name: 'tenantId', endpoint: '/api', location: 'query', values: ['1'], source: 'js' }],
  })
  assert.match(created.text, /created asset/)
  await call('cortex_sync_asset_info', {
    host_port: hostPort,
    project_name: 'tool-test',
    interfaces: [{ path: '/b', method: 'POST' }],
    mode: 'merge',
  })
  let asset = await call('cortex_get_asset', { hostPort })
  assert.match(asset.text, /\/a/)
  assert.match(asset.text, /\/b/)
  await call('cortex_sync_asset_info', {
    host_port: hostPort,
    project_name: 'tool-test',
    interfaces: [{ path: '/c', method: 'GET' }],
    mode: 'replace',
  })
  asset = await call('cortex_get_asset', { hostPort })
  assert.match(asset.text, /## interfaces \(1\)\n\[\n  \{\n    "path": "\/c"/)
})

test('cortex_sync_asset_info normalizes agent alias shapes on write', async () => {
  const hostPort = 'http://example.test:9100/'
  await call('cortex_sync_asset_info', {
    host_port: hostPort,
    project_name: 'tool-normalize-test',
    interfaces: [{ method: 'POST', path: '/login', raw: 'POST /login HTTP/1.1\nHost: x\n\n{"a":1}' }],
    leaked_infos: [{ type: 'Token', value: 'abc', file: '/js/app.js', note: 'demo' }],
    test_parameters: [{ param: 'memberId', where: 'json', example: 'M-1' }],
  })
  const asset = await call('cortex_get_asset', { hostPort })
  assert.match(asset.text, /"path": "\/login"/)
  assert.match(asset.text, /"request": "POST \/login/)
  assert.match(asset.text, /"info_type": "Token"/)
  assert.match(asset.text, /"source": "\/js\/app\.js"/)
  assert.match(asset.text, /"name": "memberId"/)
  assert.match(asset.text, /"location": "body"/)
  assert.match(asset.text, /"values": \[\n\s+"M-1"/)
  assert.match(asset.text, /"related_vuln_ids": \[\]/)
})

test('cortex_save_snapshot creates, updates and guards existing projects', async () => {
  const created = await call('cortex_save_snapshot', {
    project_name: 'tool-snapshot-test',
    current_phase: 'recon',
    target_hosts: ['example.test'],
    unfinished_tasks: ['check /admin'],
    notes: 'first save',
    next_steps: 'continue recon',
  })
  const sessionId = created.text.match(/snapshot saved: ([^\s|]+)/)[1]
  const detail = await call('cortex_get_snapshot', { sessionId })
  assert.match(detail.text, /phase: recon/)
  assert.match(detail.text, /first save/)
  assert.match(detail.text, /check \/admin/)

  const guard = await call('cortex_save_snapshot', { project_name: 'tool-snapshot-test', current_phase: 'recon2' })
  assert.match(guard.text, /already has snapshots/)
  assert.match(guard.text, new RegExp(sessionId))

  const updated = await call('cortex_save_snapshot', {
    session_id: sessionId,
    project_name: 'tool-snapshot-test',
    current_phase: 'exploit',
    next_steps: 'run exploit',
  })
  assert.match(updated.text, /snapshot updated/)
  const after = await call('cortex_get_snapshot', { sessionId })
  assert.match(after.text, /phase: exploit/)
  assert.match(after.text, /run exploit/)
  assert.match(after.text, /first save/)

  const forced = await call('cortex_save_snapshot', {
    project_name: 'tool-snapshot-test',
    current_phase: 'second-session',
    force_new: true,
  })
  assert.match(forced.text, /snapshot saved:/)
  const listed = await call('cortex_list_snapshots', { project: 'tool-snapshot-test' })
  assert.match(listed.text, /2 snapshots/)
})

test('cortex_sync_internal_scope registers hosts/services/footholds/credentials/pivots', async () => {
  await call('cortex_sync_asset_info', {
    host_port: 'http://internal.example.test:9443/',
    project_name: '__tool_internal_test__',
    interfaces: [{ path: '/', method: 'GET' }],
  })
  const synced = await call('cortex_sync_internal_scope', {
    project_name: '__tool_internal_test__',
    internal_hosts: [{ ip: '10.9.9.9', hostname: 'db01', os: 'Ubuntu 22.04', state: 'alive' }],
    internal_services: [{ ip: '10.9.9.9', port: 6379, protocol: 'tcp', service: 'redis', banner: 'Redis 7.4' }],
    footholds: [
      {
        entry_host_port: 'http://internal.example.test:9443/',
        access_type: 'rce',
        privilege_level: 'admin',
        evidence: 'id; whoami',
        host_ips: ['10.9.9.9'],
      },
    ],
    credentials: [{ type: 'password', username: 'deploy', secret: 'demo', host: '10.9.9.9', source: 'backup.sh', status: 'valid' }],
    pivots: [{ entry_host_port: 'http://internal.example.test:9443/', kind: 'proxy', local_port: 1080, local_protocol: 'socks5' }],
  })
  assert.match(synced.text, /internal scope updated/)
  assert.match(synced.text, /hosts \+1/)
  assert.match(synced.text, /footholds \+1/)
  assert.match(synced.text, /credentials \+1/)
  const audit = await call('cortex_audit_completeness', { project_name: '__tool_internal_test__' })
  assert.match(audit.text, /footholds 1, hosts 1, services 1, credentials 1, pivots 1/)
  assert.match(audit.text, /snapshots 0/)
})

test('cortex_audit_completeness reports gaps in current library data', async () => {
  const audit = await call('cortex_audit_completeness', {})
  assert.match(audit.text, /completeness audit/)
  assert.match(audit.text, /vulnerabilities:/)
  assert.match(audit.text, /Fill gaps with cortex_sync_asset_info/)
})

test('read-only host rejects the write tools', async () => {
  const readOnlyHost = createCortexHost({ config: { dbPath, readOnly: true } })
  const readOnlyTools = createCortexToolDefinitions(readOnlyHost.dataAccess)
  const update = readOnlyTools.find((tool) => tool.name === 'cortex_update_vuln_status')
  await assert.rejects(update.execute({ id: 'VULN-20260101-001', status: 'Confirmed' }), /read-only/i)
  const save = readOnlyTools.find((tool) => tool.name === 'cortex_save_vuln')
  await assert.rejects(
    save.execute({ host: 'example.test', vuln_name: 'x', severity: 'Low', target_url: 'http://example.test/' }),
    /read-only/i,
  )
  const sync = readOnlyTools.find((tool) => tool.name === 'cortex_sync_asset_info')
  await assert.rejects(sync.execute({ host_port: 'http://example.test/', project_name: 'p' }), /read-only/i)
  await readOnlyHost.dispose()
})

test.after(async () => {
  await host.dispose()
  rmSync(tempDir, { recursive: true, force: true })
})
