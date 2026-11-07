import assert from 'node:assert/strict'
import http from 'node:http'
import { after, describe, it } from 'node:test'
import { ApiError } from '../../src/host/http.js'
import { sendRetest, validateSendRequest } from '../../src/host/retest.js'
import {
  cleanupDir,
  createTestDb,
  insertVuln,
  openRawDb,
  startTestHost,
} from './helpers.mjs'

/* ------------------------------------------------------------------------- */
/* Throwaway upstream server                                                 */
/* ------------------------------------------------------------------------- */

const upstream = http.createServer((req, res) => {
  /** @type {Buffer[]} */
  const chunks = []
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  req.on('end', () => {
    const requestBody = Buffer.concat(chunks).toString('utf8')
    const path = String(req.url || '/').split('?')[0]
    if (path === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-upstream': 'yes' })
      res.end('ok-body')
      return
    }
    if (path === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ method: req.method, body: requestBody, headers: req.headers }))
      return
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: '/ok' })
      res.end('redirect-body')
      return
    }
    if (path === '/redirect-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
      return
    }
    if (path === '/destroy') {
      req.socket.destroy()
      return
    }
    const chain = /^\/r(\d+)$/.exec(path)
    if (chain) {
      const index = Number(chain[1])
      if (index >= 6) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('end')
        return
      }
      res.writeHead(302, { location: `/r${index + 1}` })
      res.end()
      return
    }
    if (path === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      const chunk = Buffer.alloc(64 * 1024, 97)
      let sent = 0
      const total = 2 * 1024 * 1024 + 100
      while (sent < total) {
        res.write(chunk)
        sent += chunk.length
      }
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
})

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamAddress = upstream.address()
const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress ? upstreamAddress.port : 0
const upstreamBase = `http://127.0.0.1:${upstreamPort}`
const otherPort = upstreamPort === 65535 ? upstreamPort - 1 : upstreamPort + 1

const fixture = createTestDb()
{
  const db = openRawDb(fixture.dbPath)
  try {
    insertVuln(db, {
      id: 'VULN-20260201-101',
      host: `127.0.0.1:${upstreamPort}`,
      entry_point: '/ok',
      vuln_name: 'Retest Target',
      vuln_type: 'Test',
      severity: 'Medium',
      target_url: `${upstreamBase}/ok`,
      created_at: '2026-02-01T00:00:00.000Z',
      related_vuln_ids: '[]',
    })
    insertVuln(db, {
      id: 'VULN-20260201-102',
      host: `127.0.0.1:${upstreamPort}`,
      vuln_name: 'Retest Broken Upstream',
      vuln_type: 'Test',
      severity: 'Low',
      target_url: `${upstreamBase}/destroy`,
      created_at: '2026-02-01T00:00:01.000Z',
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
})

function send(body) {
  return server.request('/cortex-api/retest/send', { method: 'POST', body })
}

describe('retest/send: happy path', () => {
  it('performs a GET and returns the contract result object', async () => {
    const res = await send({ vulnId: 'VULN-20260201-101', method: 'GET', url: `${upstreamBase}/ok` })
    assert.equal(res.status, 200)
    const body = res.json
    assert.deepEqual(Object.keys(body).sort(), [
      'body',
      'bodyBytes',
      'bodyTruncated',
      'contentType',
      'durationMs',
      'finalUrl',
      'headers',
      'redirects',
      'status',
      'statusText',
      'url',
    ])
    assert.equal(body.status, 200)
    assert.equal(body.statusText, 'OK')
    assert.equal(body.url, `${upstreamBase}/ok`)
    assert.equal(body.finalUrl, `${upstreamBase}/ok`)
    assert.equal(body.body, 'ok-body')
    assert.equal(body.bodyBytes, 7)
    assert.equal(body.bodyTruncated, false)
    assert.match(body.contentType, /^text\/plain/)
    assert.equal(body.headers['x-upstream'], 'yes')
    assert.equal(typeof body.durationMs, 'number')
    assert.deepEqual(body.redirects, [])
  })

  it('passes method, headers and body through to the upstream', async () => {
    const res = await send({
      vulnId: 'VULN-20260201-101',
      method: 'POST',
      url: `${upstreamBase}/echo`,
      headers: { 'x-custom': 'abc' },
      body: 'hello upstream',
    })
    assert.equal(res.status, 200)
    const echoed = JSON.parse(res.json.body)
    assert.equal(echoed.method, 'POST')
    assert.equal(echoed.body, 'hello upstream')
    assert.equal(echoed.headers['x-custom'], 'abc')
  })
})

describe('retest/send: redirects', () => {
  it('does not follow redirects by default', async () => {
    const res = await send({ vulnId: 'VULN-20260201-101', method: 'GET', url: `${upstreamBase}/redirect` })
    assert.equal(res.status, 200)
    assert.equal(res.json.status, 302)
    assert.equal(res.json.headers.location, '/ok')
    assert.deepEqual(res.json.redirects, [])
    assert.equal(res.json.finalUrl, `${upstreamBase}/redirect`)
  })

  it('follows redirects when asked and records each hop', async () => {
    const res = await send({
      vulnId: 'VULN-20260201-101',
      method: 'GET',
      url: `${upstreamBase}/redirect`,
      followRedirects: true,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.status, 200)
    assert.equal(res.json.body, 'ok-body')
    assert.equal(res.json.finalUrl, `${upstreamBase}/ok`)
    assert.deepEqual(res.json.redirects, [
      { url: `${upstreamBase}/redirect`, status: 302, location: '/ok' },
    ])
  })

  it('caps redirect following at 5 hops', async () => {
    const res = await send({
      vulnId: 'VULN-20260201-101',
      method: 'GET',
      url: `${upstreamBase}/r0`,
      followRedirects: true,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.redirects.length, 5)
    assert.equal(res.json.status, 302)
    assert.equal(res.json.finalUrl, `${upstreamBase}/r5`)
  })

  it('re-validates the allowlist on redirect hops', async () => {
    const res = await send({
      vulnId: 'VULN-20260201-101',
      method: 'GET',
      url: `${upstreamBase}/redirect-metadata`,
      followRedirects: true,
    })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'BAD_REQUEST')
  })
})

describe('retest/send: allowlist and URL safety', () => {
  it('rejects disallowed origins with the allowed list', async () => {
    const res = await send({
      vulnId: 'VULN-20260201-101',
      method: 'GET',
      url: `http://127.0.0.1:${otherPort}/ok`,
    })
    assert.equal(res.status, 403)
    assert.equal(res.json.code, 'ORIGIN_NOT_ALLOWED')
    assert.equal(Array.isArray(res.json.details.allowed), true)
    assert.equal(res.json.details.allowed.includes(upstreamBase), true)

    const evil = await send({
      vulnId: 'VULN-20260201-101',
      method: 'GET',
      url: 'http://evil.example.test/steal',
    })
    assert.equal(evil.status, 403)
    assert.equal(evil.json.code, 'ORIGIN_NOT_ALLOWED')
  })

  it('rejects non-http(s), userinfo and metadata URLs', async () => {
    const cases = [
      { url: 'ftp://127.0.0.1/ok' },
      { url: `http://user:pass@127.0.0.1:${upstreamPort}/ok` },
      { url: 'http://169.254.169.254/latest/meta-data/' },
      { url: 'http://metadata.google.internal/computeMetadata/v1/' },
      { url: 'not-a-url' },
    ]
    for (const item of cases) {
      const res = await send({ vulnId: 'VULN-20260201-101', method: 'GET', ...item })
      assert.equal(res.status, 400, item.url)
      assert.equal(res.json.code, 'BAD_REQUEST', item.url)
    }
  })

  it('ignores the Host header copied from raw requests (URL host wins)', async () => {
    const res = await send({
      vulnId: 'VULN-20260201-101',
      method: 'GET',
      url: `${upstreamBase}/echo`,
      headers: { Host: 'evil.example', 'x-custom': 'kept' },
    })
    assert.equal(res.status, 200)
    const echoed = JSON.parse(res.json.body)
    assert.equal(echoed.headers['x-custom'], 'kept')
    assert.notEqual(echoed.headers.host, 'evil.example')
  })

  it('rejects forbidden request headers and invalid payload shapes', async () => {
    const cases = [
      { method: 'GET', url: `${upstreamBase}/ok`, headers: { 'content-length': '1' } },
      { method: 'GET', url: `${upstreamBase}/ok`, headers: { Connection: 'keep-alive' } },
      { method: 'get', url: `${upstreamBase}/ok` },
      { method: 'GET', url: `${upstreamBase}/ok`, followRedirects: 'yes' },
      { method: 'GET', url: `${upstreamBase}/ok`, body: 'nope' },
      { method: 'GET', url: `${upstreamBase}/ok`, headers: { 'x-bad': 5 } },
      { method: 'GET', url: `${upstreamBase}/ok`, body: 'x'.repeat(256 * 1024 + 1) },
    ]
    for (const item of cases) {
      const res = await send({ vulnId: 'VULN-20260201-101', ...item })
      assert.equal(res.status, 400, JSON.stringify(item).slice(0, 80))
      assert.equal(res.json.code, 'BAD_REQUEST')
    }
  })

  it('404s unknown vulnerability ids', async () => {
    const res = await send({ vulnId: 'VULN-00000000-999', method: 'GET', url: `${upstreamBase}/ok` })
    assert.equal(res.status, 404)
    assert.equal(res.json.code, 'NOT_FOUND')
  })
})

describe('retest/send: response limits and failures', () => {
  it('caps response bodies at 2 MiB and flags truncation', async () => {
    const res = await send({ vulnId: 'VULN-20260201-101', method: 'GET', url: `${upstreamBase}/big` })
    assert.equal(res.status, 200)
    assert.equal(res.json.status, 200)
    assert.equal(res.json.bodyTruncated, true)
    assert.equal(res.json.bodyBytes, 2 * 1024 * 1024)
    assert.equal(res.json.body.length, 2 * 1024 * 1024)
  })

  it('maps connection failures to 502 UPSTREAM_ERROR', async () => {
    const res = await send({ vulnId: 'VULN-20260201-102', method: 'GET', url: `${upstreamBase}/destroy` })
    assert.equal(res.status, 502)
    assert.equal(res.json.code, 'UPSTREAM_ERROR')
  })

  it('honours allowNetwork=false', async () => {
    const restricted = await startTestHost({ dbPath: fixture.dbPath, allowNetwork: false })
    try {
      const res = await restricted.request('/cortex-api/retest/send', {
        method: 'POST',
        body: { vulnId: 'VULN-20260201-101', method: 'GET', url: `${upstreamBase}/ok` },
      })
      assert.equal(res.status, 403)
      assert.equal(res.json.code, 'FORBIDDEN')
    } finally {
      await restricted.close()
    }
  })
})

describe('retest/send: timeouts (unit, injected fetch)', () => {
  const request = validateSendRequest({
    vulnId: 'VULN-UNIT-1',
    method: 'GET',
    url: 'http://127.0.0.1:9/timeout',
  })
  const context = {
    vuln: {
      id: 'VULN-UNIT-1',
      host: '127.0.0.1:9',
      target_url: 'http://127.0.0.1:9/timeout',
      service_host: '',
    },
    assets: [],
  }

  it('maps aborts to 502 UPSTREAM_TIMEOUT', async () => {
    await assert.rejects(
      sendRetest(
        { request, context },
        {
          fetchImpl: async () => {
            const err = new Error('The operation was aborted due to timeout')
            err.name = 'TimeoutError'
            throw err
          },
        },
      ),
      (err) => err instanceof ApiError && err.status === 502 && err.code === 'UPSTREAM_TIMEOUT',
    )
  })

  it('maps fetch errors to 502 UPSTREAM_ERROR with a sanitized cause', async () => {
    await assert.rejects(
      sendRetest(
        { request, context },
        {
          fetchImpl: async () => {
            const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
            const err = new Error('fetch failed')
            err.cause = cause
            throw err
          },
        },
      ),
      (err) =>
        err instanceof ApiError &&
        err.status === 502 &&
        err.code === 'UPSTREAM_ERROR' &&
        err.details.cause === 'ECONNREFUSED',
    )
  })
})
