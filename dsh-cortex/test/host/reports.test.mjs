import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { cleanupDir, createTestDb, startTestHost } from './helpers.mjs'

const fixture = createTestDb()
const server = await startTestHost({ dbPath: fixture.dbPath })

after(async () => {
  await server.close()
  cleanupDir(fixture.dir)
})

describe('reports: Markdown download', () => {
  it('serves a full Markdown report as an attachment', async () => {
    const res = await server.request('/cortex-api/reports/VULN-20260101-001')
    assert.equal(res.status, 200)
    assert.match(String(res.headers['content-type']), /^text\/markdown;\s*charset=utf-8/)
    assert.match(String(res.headers['content-disposition']), /^attachment;\s*filename="VULN-20260101-001\.md"$/)
    assert.equal(res.headers['cache-control'], 'no-store')

    const markdown = res.text
    assert.match(markdown, /^# SQL 注入导致跨租户数据泄露/m)
    for (const heading of [
      '## 描述',
      '## 影响',
      '## 受影响接口',
      '## 复现步骤',
      '## 复测记录',
      '## 修复建议',
      '## 测试边界 / 加密细节',
      '## 关联漏洞',
    ]) {
      assert.equal(markdown.includes(heading), true, heading)
    }
    assert.equal(markdown.includes('### 复测 1'), true)
    assert.equal(markdown.includes('2026-01-02 10:00-10:04 (Asia/Shanghai)'), true)
    assert.equal(markdown.includes('使用参数化查询'), true)
    assert.equal(markdown.includes('VULN-20260101-002'), true)
    assert.equal(markdown.includes('- 漏洞 ID: VULN-20260101-001'), true)
    assert.equal(markdown.includes('- Host: 127.0.0.1:8080'), true)
    assert.equal(markdown.includes('- 严重级别: Critical'), true)
    assert.equal(markdown.includes('- 状态: Confirmed'), true)
    assert.equal(markdown.includes('VULN-20260101-002 缺少安全响应头'), true)
  })

  it('handles corrupt JSON columns without failing', async () => {
    const res = await server.request('/cortex-api/reports/VULN-20260101-002')
    assert.equal(res.status, 200)
    assert.equal(res.text.includes('_（无）_'), true)
    assert.equal(res.text.includes('## 关联漏洞'), true)
  })

  it('404s unknown vulnerability ids', async () => {
    const res = await server.request('/cortex-api/reports/VULN-00000000-999')
    assert.equal(res.status, 404)
    assert.equal(res.json.code, 'NOT_FOUND')
  })

  it('never includes credential secrets in reports', async () => {
    const res = await server.request('/cortex-api/reports/VULN-20260101-003')
    assert.equal(res.status, 200)
    assert.equal(res.text.includes('SuperSecretValue'), false)
    assert.equal(res.text.includes('ssh-private-key-material'), false)
  })
})
