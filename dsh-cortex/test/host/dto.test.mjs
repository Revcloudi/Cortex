import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as dto from '../../src/host/dto.js'

describe('dto: safe JSON parsing', () => {
  it('returns [] for corrupt / wrong-typed arrays', () => {
    assert.deepEqual(dto.parseJsonArray('not json'), [])
    assert.deepEqual(dto.parseJsonArray('{"a":1}'), [])
    assert.deepEqual(dto.parseJsonArray('null'), [])
    assert.deepEqual(dto.parseJsonArray(null), [])
    assert.deepEqual(dto.parseJsonArray(''), [])
    assert.deepEqual(dto.parseJsonArray('[1,2]'), [1, 2])
  })

  it('returns null for corrupt objects and arrays', () => {
    assert.equal(dto.parseJsonObject('{bad'), null)
    assert.equal(dto.parseJsonObject('[1]'), null)
    assert.equal(dto.parseJsonObject('null'), null)
    assert.deepEqual(dto.parseJsonObject('{"a":1}'), { a: 1 })
  })
})

describe('dto: credentials are always masked', () => {
  it('masks a long secret without exposing it', () => {
    const masked = dto.maskSecret('SuperSecretValue!42')
    assert.equal(masked.includes('SuperSecret'), false)
    assert.equal(masked.includes('Value'), false)
    assert.equal(masked.length > 0, true)
  })

  it('masks short/empty secrets', () => {
    assert.equal(dto.maskSecret(''), '')
    assert.equal(dto.maskSecret('ab'), '••')
    assert.equal(dto.maskSecret('abcdef'), '••••')
  })

  it('credential DTO has no `secret` key and carries length', () => {
    const row = {
      id: 'CR-1',
      type: 'password',
      username: 'admin',
      domain: 'CORP',
      secret: 'SuperSecretValue!42',
      source: '.env',
      host_id: 'IH-1',
      service_id: null,
      confidence: 'high',
      status: 'valid',
      notes: 'x',
    }
    const view = dto.credentialMasked(row)
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'secret'), false)
    assert.equal(view.secretLength, 'SuperSecretValue!42'.length)
    assert.equal(JSON.stringify(view).includes('SuperSecretValue'), false)
    assert.equal(view.hostId, 'IH-1')
    assert.equal(view.serviceId, null)
  })
})

describe('dto: vulnerability mapping', () => {
  it('fills every summary field for an empty row', () => {
    const view = dto.vulnSummary({})
    assert.deepEqual(Object.keys(view).sort(), [
      'createdAt',
      'entryPoint',
      'host',
      'id',
      'latestRetestAt',
      'realm',
      'retestCount',
      'serviceHost',
      'severity',
      'status',
      'targetUrl',
      'vulnName',
      'vulnType',
    ])
    assert.equal(view.realm, 'web')
    assert.equal(view.retestCount, 0)
    assert.equal(view.latestRetestAt, null)
    assert.equal(view.createdAt, null)
  })

  it('maps snake_case columns and retest history', () => {
    const view = dto.vulnDetail({
      id: 'V-1',
      host: 'h:1',
      entry_point: '/e',
      vuln_name: 'n',
      vuln_type: 't',
      severity: 'High',
      target_url: 'http://h:1/',
      description: 'd',
      impact: 'i',
      affected_interfaces: JSON.stringify(['/a', '/b']),
      reproduction_steps: 'r',
      remediation: JSON.stringify(['fix']),
      crypto_details: 'c',
      test_boundaries: 'tb',
      retest_results: JSON.stringify([
        { time_range: 'T1', conclusion: 'C1' },
        { time_range: 'T2', conclusion: 'C2' },
      ]),
      related_vuln_ids: JSON.stringify(['V-2']),
      status: 'Confirmed',
      created_at: '2026-01-01T00:00:00.000Z',
      service_host: 's:1',
      realm: 'internal',
      internal_service_id: 'IS-1',
    })
    assert.equal(view.vulnName, 'n')
    assert.equal(view.entryPoint, '/e')
    assert.deepEqual(view.affectedInterfaces, ['/a', '/b'])
    assert.deepEqual(view.remediation, ['fix'])
    assert.deepEqual(view.relatedVulnIds, ['V-2'])
    assert.equal(view.retestCount, 2)
    assert.equal(view.latestRetestAt, 'T2')
    assert.deepEqual(view.retestResults, [
      { timeRange: 'T1', conclusion: 'C1' },
      { timeRange: 'T2', conclusion: 'C2' },
    ])
    assert.equal(view.internalServiceId, 'IS-1')
  })

  it('degrades corrupt JSON columns to empty arrays', () => {
    const view = dto.vulnDetail({
      id: 'V-2',
      affected_interfaces: 'not-json',
      remediation: '{"a":1}',
      retest_results: 'nope',
      related_vuln_ids: '42',
    })
    assert.deepEqual(view.affectedInterfaces, [])
    assert.deepEqual(view.remediation, [])
    assert.deepEqual(view.retestResults, [])
    assert.deepEqual(view.relatedVulnIds, [])
    assert.equal(view.retestCount, 0)
    assert.equal(view.latestRetestAt, null)
  })

  it('accepts camelCase retest entries defensively and skips invalid entries', () => {
    const entries = dto.retestEntries(
      JSON.stringify([{ timeRange: 'X', conclusion: 'Y' }, 'garbage', null, { time_range: 'A', conclusion: 'B' }]),
    )
    assert.deepEqual(entries, [
      { timeRange: 'X', conclusion: 'Y' },
      { timeRange: 'A', conclusion: 'B' },
    ])
  })
})

describe('dto: asset mapping', () => {
  it('maps summary counts and booleans', () => {
    const summary = dto.assetSummary({
      host_port: 'http://h/',
      host: 'h',
      project_name: 'P',
      tech_stack: 'nginx',
      auth_required: 1,
      status: 'Alive',
      interfaces: JSON.stringify([{ path: '/a' }]),
      related_vuln_ids: JSON.stringify(['V-1', 'V-2']),
      last_seen: '2026-01-01T00:00:00.000Z',
    })
    assert.equal(summary.authRequired, true)
    assert.equal(summary.interfaceCount, 1)
    assert.equal(summary.vulnCount, 2)
  })

  it('degrades corrupt JSON to zero counts', () => {
    const summary = dto.assetSummary({ interfaces: 'corrupt', related_vuln_ids: 'null', auth_required: 0 })
    assert.equal(summary.interfaceCount, 0)
    assert.equal(summary.vulnCount, 0)
    assert.equal(summary.authRequired, false)
  })

  it('normalizes interfaces, leaked info and test parameters', () => {
    const detail = dto.assetDetail({
      interfaces: JSON.stringify(['/legacy', { path: '/login', method: 'POST', request: 'POST /login' }]),
      interface_dir: JSON.stringify(['/login']),
      leaked_infos: JSON.stringify([
        { info_type: 'Credential', value: 'v', source: 's', potential_impact: 'i' },
      ]),
      test_parameters: JSON.stringify([
        {
          name: 'id',
          endpoint: '/x/<id>',
          location: 'path',
          values: ['1', 2],
          pattern: 'int',
          source: 'page',
          tested: true,
          notes: 'n',
          related_vuln_ids: ['V-1'],
        },
      ]),
      related_vuln_ids: JSON.stringify(['V-1']),
    })
    assert.deepEqual(detail.interfaces[0], { path: '/legacy' })
    assert.equal(detail.interfaces[1].method, 'POST')
    assert.equal(detail.interfaces[1].params, undefined)
    assert.deepEqual(detail.leakedInfos[0], {
      infoType: 'Credential',
      value: 'v',
      source: 's',
      potentialImpact: 'i',
    })
    assert.deepEqual(detail.testParameters[0].values, ['1', '2'])
    assert.equal(detail.testParameters[0].tested, true)
    assert.deepEqual(detail.testParameters[0].relatedVulnIds, ['V-1'])
    assert.deepEqual(detail.interfaceDir, ['/login'])
  })
})

describe('dto: internal + snapshot mapping', () => {
  it('maps footholds with host ids', () => {
    const view = dto.foothold(
      {
        id: 'FH-1',
        entry_host_port: 'http://h/',
        entry_vuln_id: 'V-1',
        access_type: 'rce',
        privilege_level: 'user',
        status: 'established',
        evidence: 'e',
        notes: 'n',
        established_at: 'A',
        last_verified_at: 'B',
      },
      ['IH-1'],
    )
    assert.deepEqual(Object.keys(view).sort(), [
      'accessType',
      'entryHostPort',
      'entryVulnId',
      'establishedAt',
      'evidence',
      'hostIds',
      'id',
      'lastVerifiedAt',
      'notes',
      'privilegeLevel',
      'status',
    ])
    assert.deepEqual(view.hostIds, ['IH-1'])
  })

  it('maps pivots with hops and subnets', () => {
    const view = dto.pivot(
      {
        id: 'PV-1',
        foothold_id: 'FH-1',
        kind: 'proxy',
        local_host: '127.0.0.1',
        local_port: 1080,
        local_protocol: 'socks5',
        tool: 'chisel',
        status: 'established',
        notes: '',
        established_at: 'A',
        last_verified_at: 'B',
      },
      [{ seq: 1, ref_kind: 'internal_service', ref_id: 'IS-1', label: 'redis', via: 'socks' }],
      ['10.0.0.0/24'],
    )
    assert.equal(view.localPort, 1080)
    assert.deepEqual(view.hops, [
      { seq: 1, refKind: 'internal_service', refId: 'IS-1', label: 'redis', via: 'socks' },
    ])
    assert.deepEqual(view.reachableSubnets, ['10.0.0.0/24'])
  })

  it('maps snapshots with defaults and safe previousState', () => {
    const summary = dto.snapshotSummary({})
    assert.equal(summary.sessionId, '')
    assert.equal(summary.parentSessionId, null)
    assert.equal(summary.archivedAt, null)
    assert.deepEqual(summary.targetHosts, [])
    assert.equal(summary.childCount, 0)

    const detail = dto.snapshotDetail({
      session_id: 'S-1',
      unfinished_tasks: 'bad',
      failed_paths: JSON.stringify(['p']),
      tested_interfaces: JSON.stringify([{ target: '/x', method: 'm', result: 'r' }]),
      previous_state: '{"phase":"x"}',
      parent_session_id: 'S-0',
      archived_at: null,
    })
    assert.deepEqual(detail.unfinishedTasks, [])
    assert.deepEqual(detail.failedPaths, ['p'])
    assert.deepEqual(detail.testedInterfaces, [{ target: '/x', method: 'm', result: 'r' }])
    assert.deepEqual(detail.previousState, { phase: 'x' })
    assert.equal(detail.parentSessionId, 'S-0')

    const corruptState = dto.snapshotDetail({ previous_state: 'not-json' })
    assert.equal(corruptState.previousState, null)
  })
})
