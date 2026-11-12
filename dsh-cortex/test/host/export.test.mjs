import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { upsertMiniappIdentity } from '../../src/host/cortex/asset-identity.js'
import {
  cleanupDir,
  createTestDb,
  insertAsset,
  insertVuln,
  makeTempDir,
  openRawDb,
  startTestHost,
} from './helpers.mjs'

/**
 * Project export tests. All target data is reserved/example-only; no real
 * project, domain, credential or token is used.
 */

const PROJECT = 'Project Alpha'
const WEB_ASSET = 'http://127.0.0.1:8080/'
const MINIAPP_ID = 'PROJECT-ALPHA-001'
const MINIAPP_KEY = 'miniapp:wechat:wxdemo000000000001:0a1b2c3d4e'

const fixture = createTestDb()
const exportDir = makeTempDir()

{
  const db = openRawDb(fixture.dbPath)
  try {
    upsertMiniappIdentity(db, {
      projectName: PROJECT,
      appid: 'wxdemo000000000001',
      appName: 'Demo Mini Program',
      platform: 'wechat',
      version: '42',
      packageHash: 'a'.repeat(64),
      packageDir: 'C:\\demo-packages\\demo\\42',
      domains: [
        { host: 'api.example.test', count: 4, examples: ['https://api.example.test/v1/orders'] },
        { host: 'cdn.example.test', count: 1 },
      ],
      metadata: { source: 'miniapp' },
    })
    // Keep the stable key deterministic for assertions.
    db.prepare('UPDATE asset_meta SET asset_key = ? WHERE asset_key LIKE ?').run(
      MINIAPP_KEY,
      'miniapp:wechat:wxdemo000000000001:%',
    )
    db.prepare('UPDATE asset_domains SET asset_key = ? WHERE asset_key LIKE ?').run(
      MINIAPP_KEY,
      'miniapp:wechat:wxdemo000000000001:%',
    )
    db.prepare('UPDATE miniapp_versions SET asset_key = ? WHERE asset_key LIKE ?').run(
      MINIAPP_KEY,
      'miniapp:wechat:wxdemo000000000001:%',
    )
    insertAsset(db, {
      host_port: MINIAPP_KEY,
      host: 'api.example.test',
      project_name: PROJECT,
      tech_stack: 'wechat-miniapp wxdemo000000000001@42',
      interfaces: JSON.stringify([
        {
          path: '/v1/orders',
          method: 'GET',
          request: 'GET /v1/orders HTTP/1.1\nHost: api.example.test\nAuthorization: Bearer raw-token-value\nCookie: sid=raw-session\n',
        },
      ]),
      leaked_infos: JSON.stringify([
        {
          info_type: 'API_Key',
          value: 'demo-api-key-value',
          source: 'miniapp:demo:app.js:12',
          potential_impact: '可伪造 API 请求',
        },
      ]),
      test_parameters: JSON.stringify([
        {
          name: 'order_id',
          endpoint: '/v1/orders/<id>',
          location: 'path',
          values: ['1001', '1002'],
          source: 'miniapp:demo:app.js',
        },
      ]),
      related_vuln_ids: JSON.stringify(['VULN-20260101-004', 'VULN-INJECT-001']),
      last_seen: '2026-01-03T00:00:00.000Z',
    })
    db.prepare(
      'INSERT INTO asset_vuln_links (asset_key, vuln_id, created_at) VALUES (?, ?, ?)',
    ).run(MINIAPP_KEY, 'VULN-20260101-004', '2026-01-03T00:00:00.000Z')
    insertVuln(db, {
      id: 'VULN-INJECT-001',
      host: '127.0.0.1:8080',
      entry_point: '/spreadsheet',
      vuln_name: '=HYPERLINK("https://example.test","click")',
      vuln_type: 'CSV Injection',
      severity: 'Low',
      target_url: 'http://127.0.0.1:8080/spreadsheet',
      description: 'Spreadsheet export test',
      impact: 'Formula injection',
      reproduction_steps: 'Authorization: Bearer raw-token-value\nGET /spreadsheet HTTP/1.1',
      status: 'Confirmed',
      created_at: '2026-01-03T00:00:00.000Z',
    })
    db.prepare('UPDATE assets SET related_vuln_ids = ? WHERE host_port = ?').run(
      JSON.stringify(['VULN-20260101-001', 'VULN-20260101-003', 'VULN-INJECT-001']),
      WEB_ASSET,
    )
  } finally {
    db.close()
  }
}

const server = await startTestHost({ dbPath: fixture.dbPath })

after(async () => {
  await server.close()
  cleanupDir(fixture.dir)
  cleanupDir(exportDir)
})

function exportProject(body) {
  return server.request('/cortex-api/cortex/export/project', { method: 'POST', body })
}

function exportAssets(body) {
  return server.request('/cortex-api/cortex/export/assets', { method: 'POST', body })
}

describe('export: project JSON', () => {
  it('writes the versioned envelope with assets, findings, retests, appid/domains and relationships', async () => {
    const res = await exportProject({
      project_name: PROJECT,
      format: 'json',
      include_evidence: true,
      output_dir: exportDir,
    })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json.ok, true)
    assert.equal(Array.isArray(res.json.savedPaths), true)
    assert.ok(res.json.savedPaths.length >= 2, 'JSON + evidence files expected')
    for (const saved of res.json.savedPaths) assert.ok(existsSync(saved), saved)

    const jsonPath = res.json.savedPaths.find((path) => path.endsWith('.json'))
    const payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
    assert.equal(payload.schema, 'cortex.export/v1')
    assert.equal(typeof payload.exported_at, 'string')
    assert.equal(payload.project.name, PROJECT)
    assert.equal(payload.counts.assets, payload.assets.length)
    assert.equal(payload.counts.vulnerabilities, payload.vulnerabilities.length)

    const miniapp = payload.assets.find((asset) => asset.kind === 'miniapp')
    assert.ok(miniapp, 'mini-program asset missing')
    assert.equal(miniapp.asset_id, MINIAPP_KEY)
    assert.equal(miniapp.appid, 'wxdemo000000000001')
    assert.equal(miniapp.external_id, 'wxdemo000000000001')
    assert.equal(miniapp.platform, 'wechat')
    assert.equal(miniapp.display_name, 'Demo Mini Program')
    assert.deepEqual(miniapp.domains.map((domain) => domain.host).sort(), [
      'api.example.test',
      'cdn.example.test',
    ])
    assert.equal(miniapp.versions.length, 1)
    assert.equal(miniapp.versions[0].version, '42')
    assert.equal(miniapp.interfaces.length, 1)
    assert.equal(miniapp.leaked_infos.length, 1)
    assert.equal(miniapp.test_parameters.length, 1)

    const vuln = payload.vulnerabilities.find((item) => item.id === 'VULN-20260101-001')
    assert.ok(vuln)
    assert.equal(vuln.severity, 'Critical')
    assert.equal(vuln.status, 'Confirmed')
    assert.equal(Array.isArray(vuln.retest_results), true)
    assert.equal(vuln.retest_results.length, 1)
    assert.match(vuln.retest_results[0].conclusion, /复测/)
    assert.ok(Array.isArray(vuln.remediation))
    assert.ok(payload.relationships.asset_vulnerabilities.length > 0)
    assert.ok(
      payload.relationships.asset_domains.some((relation) => relation.asset_id === MINIAPP_KEY),
    )
    assert.ok(
      payload.relationships.miniapp_versions.some((relation) => relation.asset_id === MINIAPP_KEY),
    )
  })

  it('redacts leaked values, cookie/authorization headers and token-like test data by default', async () => {
    const res = await exportProject({ project_name: PROJECT, format: 'json', output_dir: exportDir })
    assert.equal(res.status, 200)
    const raw = readFileSync(res.json.savedPaths[0], 'utf8')
    const payload = JSON.parse(raw)
    const miniapp = payload.assets.find((asset) => asset.asset_id === MINIAPP_KEY)
    assert.equal(miniapp.leaked_infos[0].value, '[REDACTED]')
    assert.doesNotMatch(miniapp.interfaces[0].request, /raw-token-value|raw-session/)
    assert.match(miniapp.interfaces[0].request, /Authorization: \[REDACTED\]/)
    assert.match(miniapp.interfaces[0].request, /Cookie: \[REDACTED\]/)
    const injected = payload.vulnerabilities.find((item) => item.id === 'VULN-INJECT-001')
    assert.doesNotMatch(injected.reproduction_steps, /raw-token-value/)
    assert.equal(raw.includes('demo-api-key-value'), false)
    assert.equal(raw.includes('SecretLeakValue!'), false)
    assert.ok(res.json.warnings.some((warning) => /redacted/i.test(warning)))
  })

  it('includes raw values only when include_secrets is explicitly true', async () => {
    const res = await exportProject({
      project_name: PROJECT,
      format: 'json',
      include_secrets: true,
      output_dir: exportDir,
    })
    assert.equal(res.status, 200)
    const payload = JSON.parse(readFileSync(res.json.savedPaths[0], 'utf8'))
    const miniapp = payload.assets.find((asset) => asset.asset_id === MINIAPP_KEY)
    assert.equal(miniapp.leaked_infos[0].value, 'demo-api-key-value')
    assert.match(miniapp.interfaces[0].request, /raw-token-value/)
    assert.ok(res.json.warnings.some((warning) => /include_secrets=true/.test(warning)))
  })
})

describe('export: CSV', () => {
  it('writes assets.csv + vulnerabilities.csv and escapes spreadsheet formulas', async () => {
    const res = await exportProject({ project_name: PROJECT, format: 'csv', output_dir: exportDir })
    assert.equal(res.status, 200, res.text)
    const names = res.json.files.map((file) => file.name).sort()
    assert.deepEqual(names, ['assets.csv', 'vulnerabilities.csv'])
    const assetsCsv = readFileSync(res.json.savedPaths.find((path) => path.endsWith('assets.csv')), 'utf8')
    const vulnsCsv = readFileSync(
      res.json.savedPaths.find((path) => path.endsWith('vulnerabilities.csv')),
      'utf8',
    )
    assert.match(assetsCsv, /asset_id,kind,external_id/)
    assert.match(vulnsCsv, /id,asset_ids,host,target_url,severity/)
    assert.ok(vulnsCsv.includes("'=HYPERLINK"), 'formula cell must be escaped')
    assert.equal(vulnsCsv.includes('\n=HYPERLINK'), false, 'raw formula must not start a cell')
    assert.equal(assetsCsv.includes('demo-api-key-value'), false)
    assert.equal(vulnsCsv.includes('raw-token-value'), false)
    assert.ok(vulnsCsv.includes('VULN-20260101-001'))
  })

  it('ignores include_secrets for CSV (always redacted)', async () => {
    const res = await exportProject({
      project_name: PROJECT,
      format: 'csv',
      include_secrets: true,
      output_dir: exportDir,
    })
    assert.equal(res.status, 200)
    const assetsCsv = readFileSync(res.json.savedPaths.find((path) => path.endsWith('assets.csv')), 'utf8')
    const vulnsCsv = readFileSync(
      res.json.savedPaths.find((path) => path.endsWith('vulnerabilities.csv')),
      'utf8',
    )
    assert.equal(assetsCsv.includes('demo-api-key-value'), false)
    assert.equal(assetsCsv.includes('SecretLeakValue!'), false)
    assert.equal(vulnsCsv.includes('raw-token-value'), false)
  })

  it('writes optional evidence files', async () => {
    const res = await exportProject({
      project_name: PROJECT,
      format: 'csv',
      include_evidence: true,
      output_dir: exportDir,
    })
    assert.equal(res.status, 200)
    assert.ok(res.json.savedPaths.some((path) => /evidence[\\/].*\.md$/.test(path)))
    const evidence = readFileSync(
      res.json.savedPaths.find((path) => /evidence[\\/]/.test(path)),
      'utf8',
    )
    assert.match(evidence, /## Reproduction/)
    assert.doesNotMatch(evidence, /raw-token-value/)
  })

  it('rejects relative output_dir and traversal-shaped file names stay inside the root', async () => {
    const relative = await exportProject({
      project_name: PROJECT,
      format: 'csv',
      output_dir: 'relative/dir',
    })
    assert.equal(relative.status, 400)
    assert.equal(relative.json.code, 'BAD_REQUEST')

    const res = await exportProject({
      project_name: PROJECT,
      format: 'csv',
      output_dir: join(exportDir, '..', 'cortex-export-safe'),
    })
    assert.equal(res.status, 200)
    for (const saved of res.json.savedPaths) {
      assert.equal(saved.includes('..'), false)
      assert.ok(saved.includes('cortex-export-safe'))
    }
    cleanupDir(join(exportDir, '..', 'cortex-export-safe'))
  })
})

describe('export: DefectDojo', () => {
  it('builds the Generic Findings envelope, maps fields and never leaks secrets', async () => {
    const res = await exportProject({
      project_name: PROJECT,
      format: 'defectdojo',
      include_secrets: true,
      output_dir: exportDir,
    })
    assert.equal(res.status, 200, res.text)
    const payload = JSON.parse(readFileSync(res.json.savedPaths[0], 'utf8'))
    assert.ok(Array.isArray(payload.findings))
    assert.ok(payload.findings.length > 0)
    const first = payload.findings.find((finding) => finding.unique_id_from_tool === 'VULN-20260101-001')
    assert.ok(first)
    const keys = [
      'title',
      'description',
      'severity',
      'mitigation',
      'impact',
      'references',
      'date',
      'vuln_id_from_tool',
      'unique_id_from_tool',
      'endpoints',
    ]
    for (const key of keys) assert.ok(Object.prototype.hasOwnProperty.call(first, key), key)
    assert.equal(first.severity, 'Critical')
    assert.match(first.references, /VULN-20260101-001/)
    assert.ok(Array.isArray(first.endpoints))
    assert.ok(first.endpoints.some((endpoint) => endpoint.startsWith('http://127.0.0.1:8080/')))
    const raw = readFileSync(res.json.savedPaths[0], 'utf8')
    assert.equal(raw.includes('SecretLeakValue!'), false)
    assert.equal(raw.includes('demo-api-key-value'), false)
    assert.equal(raw.includes('raw-token-value'), false)
    assert.equal(raw.includes('raw-session'), false)
  })
})

describe('export: scope, validation and read-only', () => {
  it('supports selected asset ids and excludes other projects', async () => {
    const res = await exportAssets({
      format: 'json',
      asset_ids: [MINIAPP_KEY],
      output_dir: exportDir,
    })
    assert.equal(res.status, 200, res.text)
    const payload = JSON.parse(readFileSync(res.json.savedPaths[0], 'utf8'))
    assert.equal(payload.assets.length, 1)
    assert.equal(payload.assets[0].asset_id, MINIAPP_KEY)
    assert.ok(payload.vulnerabilities.every((vuln) => vuln.id !== 'VULN-20260101-002'))
  })

  it('reports missing selected asset ids in warnings without failing', async () => {
    const res = await exportAssets({
      format: 'json',
      asset_ids: [MINIAPP_KEY, 'missing-asset-key'],
      output_dir: exportDir,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.counts.assets, 1)
    assert.ok(res.json.warnings.some((warning) => /no longer exist/.test(warning)))
  })

  it('validates the format, project name, id lists and output_dir type', async () => {
    const cases = [
      { project_name: PROJECT, format: 'xml', output_dir: exportDir },
      { project_name: '', format: 'json', output_dir: exportDir },
      { project_name: PROJECT, format: 'json', asset_ids: 'not-array', output_dir: exportDir },
      { project_name: PROJECT, format: 'json', output_dir: 42 },
      { project_name: PROJECT, format: 'json', include_evidence: 'yes', output_dir: exportDir },
    ]
    for (const body of cases) {
      const res = await exportProject(body)
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120))
      assert.equal(res.json.code, 'BAD_REQUEST')
    }
  })

  it('rejects writing an export when the database is read-only', async () => {
    const readonlyServer = await startTestHost({ dbPath: fixture.dbPath, readOnly: true })
    try {
      const res = await readonlyServer.request('/cortex-api/cortex/export/project', {
        method: 'POST',
        body: { project_name: PROJECT, format: 'json', output_dir: exportDir },
      })
      assert.equal(res.status, 403)
      assert.equal(res.json.code, 'READ_ONLY')
    } finally {
      await readonlyServer.close()
    }
  })

  it('exports a project with no assets as an empty, well-formed envelope', async () => {
    const res = await exportProject({
      project_name: 'Project Without Assets',
      format: 'json',
      output_dir: exportDir,
    })
    assert.equal(res.status, 200)
    const payload = JSON.parse(readFileSync(res.json.savedPaths[0], 'utf8'))
    assert.equal(payload.assets.length, 0)
    assert.equal(payload.vulnerabilities.length, 0)
    assert.ok(Array.isArray(payload.warnings))
  })
})
