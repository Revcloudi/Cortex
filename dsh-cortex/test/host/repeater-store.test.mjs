/**
 * Single-Repeater history / collections host tests.
 *
 * These routes keep the Yakit-style sender independent from the (removed)
 * batch fuzzer: history is appended after a successful `/repeater/send` and
 * named favorites are stored under CORTEX_REPEATER_DIR.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { loadHistory, recordSendHistory } from '../../src/host/cortex/repeater-store.js'
import { cleanupDir, createTestDb, insertVuln, openRawDb, startTestHost } from './helpers.mjs'

/* ------------------------------------------------------------------------- */
/* Temp repeater root (never the operator's ~/.cortex)                       */
/* ------------------------------------------------------------------------- */

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-cortex-repeater-'))
const REPEATER_ROOT = join(TEMP_ROOT, 'repeater')
process.env.CORTEX_REPEATER_DIR = REPEATER_ROOT

/* ------------------------------------------------------------------------- */
/* Throwaway upstream                                                        */
/* ------------------------------------------------------------------------- */

const upstream = http.createServer((req, res) => {
  const parsed = new URL(req.url || '/', 'http://127.0.0.1')
  if (parsed.pathname === '/echo') {
    const x = parsed.searchParams.get('x') ?? ''
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`hit:${x}:`)
    return
  }
  if (parsed.pathname === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('z'.repeat(300 * 1024))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamAddress = upstream.address()
const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress ? upstreamAddress.port : 0
const upstreamBase = `http://127.0.0.1:${upstreamPort}`

const VULN_ID = 'VULN-REPEATER-STORE-001'

const fixture = createTestDb()
{
  const db = openRawDb(fixture.dbPath)
  try {
    insertVuln(db, {
      id: VULN_ID,
      host: `127.0.0.1:${upstreamPort}`,
      entry_point: '/echo',
      vuln_name: 'Local repeater store target',
      vuln_type: 'Test',
      severity: 'Low',
      target_url: `${upstreamBase}/echo`,
      created_at: '2026-02-01T00:00:00.000Z',
    })
  } finally {
    db.close()
  }
}

const server = await startTestHost({ dbPath: fixture.dbPath })

after(async () => {
  await server.close()
  await new Promise((resolve) => upstream.close(resolve))
  cleanupDir(fixture.dir)
  cleanupDir(TEMP_ROOT)
})

function expectOk(res) {
  assert.equal(res.status, 200, res.text)
  return res.json
}

function expectError(res, status, code) {
  assert.equal(res.status, status, res.text)
  assert.equal(res.json && res.json.code, code, res.text)
  return res.json
}

describe('repeater: single-send history', () => {
  it('auto-records a history entry after a successful send', async () => {
    const send = await server.request('/cortex-api/cortex/repeater/send', {
      method: 'POST',
      body: {
        vulnId: VULN_ID,
        method: 'GET',
        url: `${upstreamBase}/echo?x=hist`,
        headers: { 'X-Hist': '1' },
        followRedirects: false,
      },
    })
    const sent = expectOk(send)
    assert.deepEqual(Object.keys(sent).sort(), ['request', 'response'])
    assert.equal(sent.response.status, 200)
    assert.equal(sent.response.body, 'hit:hist:')

    const history = expectOk(await server.request('/cortex-api/cortex/repeater/history?limit=20'))
    assert.ok(Array.isArray(history.items))
    const entry = history.items.find((item) => item.request.url === `${upstreamBase}/echo?x=hist`)
    assert.ok(entry, 'history should contain the successful send')
    assert.deepEqual(Object.keys(entry).sort(), [
      'createdAt',
      'id',
      'raw',
      'request',
      'response',
      'vulnId',
    ])
    assert.equal(entry.vulnId, VULN_ID)
    assert.equal(entry.request.method, 'GET')
    assert.equal(entry.request.headers['X-Hist'], '1')
    assert.match(entry.raw, /^GET \/echo\?x=hist HTTP\/1\.1\r\n/)
    assert.equal(entry.response.status, 200)
    assert.equal(entry.response.body, 'hit:hist:')
    assert.equal(entry.response.truncated, false)
    assert.equal(typeof entry.createdAt, 'string')

    // Response bodies are stored capped at 256 KiB with the truncated flag.
    const bigSend = await server.request('/cortex-api/cortex/repeater/send', {
      method: 'POST',
      body: {
        vulnId: VULN_ID,
        method: 'GET',
        url: `${upstreamBase}/big`,
        headers: {},
        followRedirects: false,
      },
    })
    expectOk(bigSend)
    const afterBig = expectOk(await server.request('/cortex-api/cortex/repeater/history?limit=20'))
    const bigEntry = afterBig.items.find((item) => item.request.url === `${upstreamBase}/big`)
    assert.ok(bigEntry)
    assert.equal(Buffer.byteLength(bigEntry.response.body, 'utf8'), 256 * 1024)
    assert.equal(bigEntry.response.truncated, true)
    // Newest first.
    assert.equal(afterBig.items[0].id, bigEntry.id)

    expectError(await server.request('/cortex-api/cortex/repeater/history?limit=0'), 400, 'BAD_REQUEST')
    expectError(await server.request('/cortex-api/cortex/repeater/history?limit=51'), 400, 'BAD_REQUEST')
  })

  it('clears history via DELETE', async () => {
    const cleared = expectOk(
      await server.request('/cortex-api/cortex/repeater/history', { method: 'DELETE' }),
    )
    assert.deepEqual(cleared, { cleared: true })
    const history = expectOk(await server.request('/cortex-api/cortex/repeater/history'))
    assert.deepEqual(history.items, [])
    assert.deepEqual(loadHistory(), [])
  })

  it('caps stored history at 50 entries and writes atomically', async () => {
    for (let index = 0; index < 55; index += 1) {
      const entry = recordSendHistory({
        vulnId: VULN_ID,
        request: {
          method: 'GET',
          url: `http://127.0.0.1:9/h${index}`,
          headers: {},
          body: '',
        },
        result: {
          status: 200,
          headers: {},
          body: 'ok',
          durationMs: 1,
          bodyTruncated: false,
        },
      })
      assert.ok(entry && typeof entry.id === 'string')
    }
    const items = loadHistory()
    assert.equal(items.length, 50)
    assert.equal(items[0].request.url, 'http://127.0.0.1:9/h54')
    assert.equal(items[49].request.url, 'http://127.0.0.1:9/h5')
    assert.equal(existsSync(join(REPEATER_ROOT, 'history.json.tmp')), false)
    // Direct store test leaves history populated; clear it for later tests.
    expectOk(await server.request('/cortex-api/cortex/repeater/history', { method: 'DELETE' }))
  })
})

describe('repeater: collections', () => {
  it('creates, lists and deletes collections with capped response bodies', async () => {
    const responseBody = 'y'.repeat(300 * 1024)
    const created = expectOk(
      await server.request('/cortex-api/cortex/repeater/collections', {
        method: 'POST',
        body: {
          name: '  saved request  ',
          vulnId: VULN_ID,
          raw: `GET /echo?x=hist HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
          request: {
            method: 'GET',
            url: `${upstreamBase}/echo?x=hist`,
            headers: {},
            body: '',
          },
          response: {
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: responseBody,
            durationMs: 5,
            truncated: false,
          },
        },
      }),
    )
    const item = created.item
    assert.equal(item.name, 'saved request')
    assert.equal(item.vulnId, VULN_ID)
    assert.equal(item.request.url, `${upstreamBase}/echo?x=hist`)
    assert.equal(Buffer.byteLength(item.response.body, 'utf8'), 256 * 1024)
    assert.equal(item.response.truncated, true)
    assert.equal(typeof item.id, 'string')

    const list = expectOk(await server.request('/cortex-api/cortex/repeater/collections'))
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0].id, item.id)

    const deleted = expectOk(
      await server.request(`/cortex-api/cortex/repeater/collections/${item.id}`, {
        method: 'DELETE',
      }),
    )
    assert.deepEqual(deleted, { deleted: true })
    const deletedAgain = expectOk(
      await server.request(`/cortex-api/cortex/repeater/collections/${item.id}`, {
        method: 'DELETE',
      }),
    )
    assert.deepEqual(deletedAgain, { deleted: false })
    assert.deepEqual(
      expectOk(await server.request('/cortex-api/cortex/repeater/collections')).items,
      [],
    )
  })

  it('validates collection input strictly', async () => {
    const post = (body) =>
      server.request('/cortex-api/cortex/repeater/collections', { method: 'POST', body })
    expectError(await post({ name: '   ', request: { method: 'GET', url: 'x', headers: {} } }), 400, 'BAD_REQUEST')
    expectError(
      await post({ name: 'x'.repeat(81), request: { method: 'GET', url: 'http://h/', headers: {} } }),
      400,
      'BAD_REQUEST',
    )
    expectError(await post({ name: 'ok' }), 400, 'BAD_REQUEST')
    expectError(
      await post({ name: 'ok', request: { method: 'GET', url: 'http://h/', headers: { 'content-length': '1' } } }),
      400,
      'BAD_REQUEST',
    )
  })

  it('caps collections at 50 entries', async () => {
    const post = (name) =>
      server.request('/cortex-api/cortex/repeater/collections', {
        method: 'POST',
        body: {
          name,
          request: { method: 'GET', url: `${upstreamBase}/echo`, headers: {}, body: '' },
        },
      })
    for (let index = 0; index < 50; index += 1) {
      expectOk(await post(`c${index}`))
    }
    expectError(await post('overflow'), 400, 'BAD_REQUEST')
    const list = expectOk(await server.request('/cortex-api/cortex/repeater/collections'))
    assert.equal(list.items.length, 50)
    assert.equal(list.items[0].name, 'c49')
  })
})
