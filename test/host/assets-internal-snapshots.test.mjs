import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { cleanupDir, createTestDb, startTestHost } from './helpers.mjs'

const fixture = createTestDb()
const server = await startTestHost({ dbPath: fixture.dbPath })

after(async () => {
  await server.close()
  cleanupDir(fixture.dir)
})

describe('assets', () => {
  it('lists assets with counts and projects', async () => {
    const res = await server.request('/cortex-api/assets')
    assert.equal(res.status, 200)
    const body = res.json
    assert.equal(body.total, 2)
    assert.equal(body.page, 1)
    assert.equal(body.pageSize, 20)
    assert.equal(body.pages, 1)
    assert.deepEqual(body.projects, ['Project Alpha', 'Project Beta'])
    assert.equal(body.items.length, 2)
    assert.deepEqual(Object.keys(body.items[0]).sort(), [
      'authRequired',
      'host',
      'hostPort',
      'interfaceCount',
      'lastSeen',
      'projectName',
      'status',
      'techStack',
      'vulnCount',
    ])
    // Newest last_seen first.
    assert.equal(body.items[0].hostPort, 'http://127.0.0.1:8080/')
    assert.equal(body.items[0].interfaceCount, 2)
    assert.equal(body.items[0].vulnCount, 2)
    assert.equal(body.items[0].authRequired, true)
    // Corrupt interfaces JSON degrades to zero.
    assert.equal(body.items[1].hostPort, 'https://beta.example.test:8443/app')
    assert.equal(body.items[1].interfaceCount, 0)
    assert.equal(body.items[1].authRequired, false)
  })

  it('filters by search and status', async () => {
    let res = await server.request('/cortex-api/assets?search=beta')
    assert.equal(res.json.total, 1)
    assert.equal(res.json.items[0].host, 'beta.example.test')

    res = await server.request('/cortex-api/assets?status=Dead')
    assert.equal(res.json.total, 1)

    res = await server.request('/cortex-api/assets?status=Alive&pageSize=1')
    assert.equal(res.json.total, 1)
    assert.equal(res.json.items.length, 1)
    assert.equal(res.json.pages, 1)

    res = await server.request(`/cortex-api/assets?search=${'a'.repeat(401)}`)
    assert.equal(res.status, 400)

    res = await server.request('/cortex-api/assets?status=Bogus')
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'BAD_REQUEST')
  })

  it('returns asset detail with normalized interfaces, leaks and test parameters', async () => {
    const path = `/cortex-api/assets/${encodeURIComponent('http://127.0.0.1:8080/')}`
    const res = await server.request(path)
    assert.equal(res.status, 200)
    const { asset, related } = res.json
    assert.equal(asset.hostPort, 'http://127.0.0.1:8080/')
    assert.equal(asset.interfaces.length, 2)
    assert.equal(asset.interfaces[0].path, '/login')
    assert.equal(asset.interfaces[0].method, 'POST')
    assert.equal(asset.interfaces[0].request.includes('POST /login HTTP/1.1'), true)
    assert.equal(asset.interfaces[1].params, undefined)
    assert.deepEqual(asset.interfaceDir, ['/login', '/orders'])
    assert.deepEqual(asset.leakedInfos[0], {
      infoType: 'Credential',
      value: 'DB_PASSWORD=SecretLeakValue!',
      source: '/var/www/.env',
      potentialImpact: '直连 MariaDB',
    })
    assert.equal(asset.testParameters[0].name, 'invoice_id')
    assert.deepEqual(asset.testParameters[0].values, ['1', '2', '3'])
    assert.equal(asset.testParameters[0].tested, true)
    assert.deepEqual(asset.testParameters[0].relatedVulnIds, ['VULN-20260101-004'])
    assert.deepEqual(asset.relatedVulnIds, ['VULN-20260101-001', 'VULN-20260101-003'])
    assert.deepEqual(related.map((item) => item.id), ['VULN-20260101-001', 'VULN-20260101-003'])
  })

  it('supports raw unencoded hostPort paths and 404s unknown assets', async () => {
    const raw = await server.request('/cortex-api/assets/http://127.0.0.1:8080/')
    assert.equal(raw.status, 200)
    assert.equal(raw.json.asset.hostPort, 'http://127.0.0.1:8080/')

    const missing = await server.request(`/cortex-api/assets/${encodeURIComponent('http://nope.test/')}`)
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'NOT_FOUND')
  })
})

describe('internal operations', () => {
  it('lists internal projects with per-entity counts', async () => {
    const res = await server.request('/cortex-api/internal/projects')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.projects, [
      {
        projectName: 'Project Alpha',
        footholds: 2,
        hosts: 2,
        services: 2,
        credentials: 2,
        pivots: 1,
      },
    ])
  })

  it('returns the default project overview with masked credentials', async () => {
    const res = await server.request('/cortex-api/internal/overview')
    assert.equal(res.status, 200)
    const body = res.json
    assert.equal(body.project, 'Project Alpha')
    assert.deepEqual(Object.keys(body).sort(), [
      'credentials',
      'footholds',
      'hosts',
      'pivots',
      'project',
      'services',
      'stats',
    ])
    assert.deepEqual(body.stats, { footholds: 2, hosts: 2, services: 2, credentials: 2, pivots: 1 })
    assert.equal(body.footholds.length, 2)
    const established = body.footholds.find((item) => item.id === 'FH-1')
    assert.deepEqual(established.hostIds, ['IH-1', 'IH-2'])
    assert.equal(established.entryVulnId, 'VULN-20260101-003')
    assert.equal(body.hosts[0].ip, '10.0.0.5')
    assert.equal(body.services[0].port, 6379)
    assert.equal(body.pivots[0].hops.length, 2)
    assert.deepEqual(body.pivots[0].hops.map((hop) => hop.seq), [0, 1])
    assert.deepEqual(body.pivots[0].reachableSubnets, ['10.0.0.0/24'])

    const masked = body.credentials.find((item) => item.id === 'CR-1')
    assert.equal(masked.secretLength, 'SuperSecretValue!42'.length)
    assert.equal(masked.secretMasked.includes('SuperSecretValue'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(masked, 'secret'), false)
    // Raw response must never contain any credential secret material.
    assert.equal(res.text.includes('SuperSecretValue'), false)
    assert.equal(res.text.includes('ssh-private-key-material'), false)
  })

  it('404s unknown projects and validates project params', async () => {
    const missing = await server.request('/cortex-api/internal/overview?project=Project%20Nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'NOT_FOUND')

    const tooLong = await server.request(`/cortex-api/internal/graph?project=${'a'.repeat(201)}`)
    assert.equal(tooLong.status, 400)
  })

  it('builds the internal relation graph', async () => {
    const res = await server.request('/cortex-api/internal/graph')
    assert.equal(res.status, 200)
    const { nodes, edges } = res.json
    const kinds = new Set(nodes.map((node) => node.kind))
    assert.deepEqual([...kinds].sort(), ['credential', 'foothold', 'host', 'pivot', 'service'])
    assert.equal(nodes.length, 9)
    assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length)
    assert.equal(edges.length, 9)
    assert.equal(
      edges.some((edge) => edge.from === 'FH-1' && edge.to === 'IH-1' && edge.kind === 'foothold_host'),
      true,
    )
    assert.equal(
      edges.some((edge) => edge.from === 'IH-1' && edge.to === 'IS-1' && edge.kind === 'host_service'),
      true,
    )
    assert.equal(res.text.includes('SuperSecretValue'), false)
    assert.equal(res.text.includes('ssh-private-key-material'), false)
  })
})

describe('snapshots', () => {
  it('lists sessions (archived hidden by default) with child counts', async () => {
    const res = await server.request('/cortex-api/snapshots')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.projects, ['Project Alpha', 'Project Beta'])
    assert.equal(res.json.sessions.length, 2)
    const parent = res.json.sessions.find((item) => item.sessionId === 'SESS-20260101-001')
    const child = res.json.sessions.find((item) => item.sessionId === 'SESS-20260101-002')
    assert.equal(parent.childCount, 1)
    assert.equal(child.parentSessionId, 'SESS-20260101-001')
    assert.equal(child.childCount, 0)
    assert.equal(parent.archivedAt, null)
    assert.deepEqual(parent.targetHosts, ['http://127.0.0.1:8080/'])

    const withArchived = await server.request('/cortex-api/snapshots?includeArchived=1')
    assert.equal(withArchived.json.sessions.length, 3)
    const archived = withArchived.json.sessions.find((item) => item.sessionId === 'SESS-20260101-003')
    assert.equal(archived.archivedAt, '2026-01-03T00:00:00.000Z')
  })

  it('filters by project and paginates', async () => {
    let res = await server.request('/cortex-api/snapshots?project=Project%20Beta')
    assert.equal(res.json.sessions.length, 0)
    assert.deepEqual(res.json.projects, ['Project Alpha', 'Project Beta'])

    res = await server.request('/cortex-api/snapshots?pageSize=1&page=2')
    assert.equal(res.json.sessions.length, 1)
    assert.equal(res.json.sessions[0].sessionId, 'SESS-20260101-001')
  })

  it('returns snapshot detail with children and related vulns', async () => {
    const res = await server.request('/cortex-api/snapshots/SESS-20260101-001')
    assert.equal(res.status, 200)
    const { session, children, relatedVulns } = res.json
    assert.equal(session.sessionId, 'SESS-20260101-001')
    assert.deepEqual(session.unfinishedTasks, ['提取 /orders 参数'])
    assert.deepEqual(session.failedPaths, ['XSS 不可注入'])
    assert.deepEqual(session.testedInterfaces, [
      { target: '/orders?q=', method: 'UNION 注入', result: '泄露 users 表' },
    ])
    assert.equal(session.previousState, null)
    assert.equal(session.notes.includes('进入内网 db1'), true)
    assert.equal(session.nextSteps, '复测 SQL 注入')
    assert.deepEqual(session.relatedVulnIds, ['VULN-20260101-001'])
    assert.deepEqual(children.map((item) => item.sessionId), ['SESS-20260101-002'])
    assert.deepEqual(relatedVulns.map((item) => item.id), ['VULN-20260101-001'])
  })

  it('404s unknown snapshot sessions', async () => {
    const res = await server.request('/cortex-api/snapshots/SESS-00000000-999')
    assert.equal(res.status, 404)
    assert.equal(res.json.code, 'NOT_FOUND')
  })
})

describe('stats', () => {
  it('returns counts, distributions, projects and recent vulns', async () => {
    const res = await server.request('/cortex-api/stats')
    assert.equal(res.status, 200)
    const body = res.json
    assert.deepEqual(body.counts, { web: 3, internal: 1, total: 4 })
    assert.deepEqual(body.bySeverity, { Critical: 1, High: 1, Medium: 1, Low: 1, Info: 0 })
    assert.deepEqual(body.byStatus, { Confirmed: 2, Inconclusive: 1, Retest_Passed: 1 })
    assert.equal(body.hosts, 3)
    assert.equal(body.assets, 2)
    assert.deepEqual(body.projects, ['Project Alpha', 'Project Beta'])
    assert.equal(body.recent.length, 4)
    assert.equal(body.recent[0].id, 'VULN-20260101-004')
  })

  it('narrows distributions and recent list by realm', async () => {
    const res = await server.request('/cortex-api/stats?realm=internal')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.counts, { web: 3, internal: 1, total: 4 })
    assert.deepEqual(res.json.bySeverity, { Critical: 0, High: 1, Medium: 0, Low: 0, Info: 0 })
    assert.equal(res.json.recent.length, 1)
    assert.equal(res.json.recent[0].realm, 'internal')

    const invalid = await server.request('/cortex-api/stats?realm=bogus')
    assert.equal(invalid.status, 400)
  })
})
