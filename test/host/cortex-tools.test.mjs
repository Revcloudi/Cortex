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
    'cortex_update_vuln_status',
    'cortex_append_retest',
    'cortex_list_assets',
    'cortex_get_asset',
    'cortex_list_snapshots',
    'cortex_get_snapshot',
    'cortex_internal_overview',
    'cortex_graph_summary',
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

test('read-only host rejects the write tools', async () => {
  const readOnlyHost = createCortexHost({ config: { dbPath, readOnly: true } })
  const readOnlyTools = createCortexToolDefinitions(readOnlyHost.dataAccess)
  const update = readOnlyTools.find((tool) => tool.name === 'cortex_update_vuln_status')
  await assert.rejects(update.execute({ id: 'VULN-20260101-001', status: 'Confirmed' }), /read-only/i)
  await readOnlyHost.dispose()
})

test.after(async () => {
  await host.dispose()
  rmSync(tempDir, { recursive: true, force: true })
})
