/**
 * Asset identity layer: one mini-program per appid, domains are relations, and
 * sharing a domain never merges two apps.
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'
import {
  findMiniappMetaByExternalId,
  getAssetMeta,
  linkVulnerability,
  listAssetDomains,
  listLinkedVulnIds,
  listMiniappVersions,
  miniappAssetKey,
  upsertMiniappIdentity,
} from '../../src/host/cortex/asset-identity.js'
import { cleanupDir, createTestDb } from './helpers.mjs'

const fixture = createTestDb()
const db = new DatabaseSync(fixture.dbPath)

after(() => {
  db.close()
  cleanupDir(fixture.dir)
})

function upsert(overrides = {}) {
  return upsertMiniappIdentity(db, {
    projectName: '小程序资产测试',
    appid: 'wxaaaabbbbccccdddd',
    appName: '测试商城',
    platform: 'wechat',
    version: '1',
    packageHash: 'hash-one',
    packageDir: '/tmp/miniapp/one',
    domains: [{ host: 'api.shared-target.test', count: 4, examples: ['https://api.shared-target.test'] }],
    ...overrides,
  })
}

describe('mini-program asset identity', () => {
  it('creates one asset per appid even when domains are shared', () => {
    const first = upsert()
    const second = upsert({
      appid: 'wxeeeeffffaaaabbbb',
      appName: '第二个小程序',
      packageHash: 'hash-two',
    })
    assert.match(first.assetKey, /^miniapp:/)
    assert.notEqual(first.assetKey, second.assetKey)
    assert.equal(getAssetMeta(db, first.assetKey).appid, 'wxaaaabbbbccccdddd')
    assert.equal(getAssetMeta(db, second.assetKey).appid, 'wxeeeeffffaaaabbbb')
    assert.equal(listAssetDomains(db, first.assetKey).length, 1)
    assert.equal(listAssetDomains(db, second.assetKey).length, 1)
    assert.equal(listAssetDomains(db, first.assetKey)[0].host, 'api.shared-target.test')
  })

  it('keeps the same asset across package versions and records both versions', () => {
    const first = upsert({ version: '1', packageHash: 'hash-one' })
    const second = upsert({
      version: '2',
      packageHash: 'hash-two',
      packageDir: '/tmp/miniapp/two',
    })
    assert.equal(second.assetKey, first.assetKey)
    assert.equal(second.created, false)
    assert.equal(listMiniappVersions(db, first.assetKey).length, 2)
  })

  it('scopes the same appid by project and falls back to a hash when appid is missing', () => {
    const projectA = upsert({ projectName: '项目 A', appid: 'wxsharedappid0001', packageHash: 'a' })
    const projectB = upsert({ projectName: '项目 B', appid: 'wxsharedappid0001', packageHash: 'b' })
    assert.notEqual(projectA.assetKey, projectB.assetKey)
    assert.equal(findMiniappMetaByExternalId(db, { platform: 'wechat', externalId: 'wxsharedappid0001' }).appid, 'wxsharedappid0001')

    const noAppid = upsert({ appid: '', appName: '无 AppID 包', packageHash: 'only-hash' })
    assert.match(noAppid.assetKey, /^miniapp:/)
    assert.equal(getAssetMeta(db, noAppid.assetKey).appid, '')
    assert.equal(getAssetMeta(db, noAppid.assetKey).identity_confidence, 'low')
    assert.equal(
      miniappAssetKey({ platform: 'wechat', appid: 'wxaaaabbbbccccdddd', projectName: '小程序资产测试' }),
      miniappAssetKey({ platform: 'wechat', appid: 'wxaaaabbbbccccdddd', projectName: '小程序资产测试' }),
    )
  })

  it('links vulnerability ownership without replacing the target URL host', () => {
    const asset = upsert({ appid: 'wxlinkvuln0000001', packageHash: 'link-hash' })
    linkVulnerability(db, asset.assetKey, 'VULN-20260101-001')
    linkVulnerability(db, asset.assetKey, 'VULN-20260101-001')
    assert.deepEqual(listLinkedVulnIds(db, asset.assetKey), ['VULN-20260101-001'])
  })
})
