/**
 * Standalone Web Fuzzer host tests.
 *
 * Covers `POST /cortex-api/cortex/repeater/send` with the new independent
 * public-target SSRF policy:
 *  - no vulnerability / no `vulnId` is required, and `vulnId` is metadata only
 *  - 403 TARGET_NOT_ALLOWED (+ stable details.reason) for loopback/private/
 *    link-local/metadata/userinfo/protocol targets, rejected before any fetch
 *  - redirect hops are revalidated, redirects capped at 5
 *  - allowNetwork=false -> 403 FORBIDDEN
 *  - DNS resolution rejects when ANY answer is non-public, failure -> 502
 *  - response body cap / timeout / connection error mapping
 *  - best-effort history with an empty vulnId and an unusable history dir
 *
 * Everything is hermetic: the only outbound-looking path is a mocked
 * `globalThis.fetch`; public targets are IP literals so no DNS is queried.
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ApiError } from '../../src/host/http.js'
import {
  MAX_RESPONSE_BYTES,
  assertTargetAllowed,
  classifyAddress,
  sendFuzzerRequest,
  validateFuzzerRequest,
} from '../../src/host/fuzzer.js'
import { loadHistory } from '../../src/host/cortex/repeater-store.js'
import { cleanupDir, createTestDb, startTestHost } from './helpers.mjs'

const PUBLIC_IP = '93.184.216.34'
const PUBLIC_BASE = `http://${PUBLIC_IP}`

const fixture = createTestDb()
const server = await startTestHost({ dbPath: fixture.dbPath })

/* ------------------------------------------------------------------------- */
/* Hermetic fetch mock                                                       */
/* ------------------------------------------------------------------------- */

/** @type {{url: string, init: any}[]} */
let fetchCalls = []

/** Hermetic replacement for the global fetch used by the route. */
const mockFetch = async (url, init = {}) => {
  const text = String(url)
  fetchCalls.push({ url: text, init })
  const parsed = new URL(text)
  const path = parsed.pathname

  if (path === '/redirect-ok') {
    return new Response('', { status: 302, headers: { location: '/ok' } })
  }
  if (path === '/redirect-private') {
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:65000/private' } })
  }
  if (path === '/redirect-metadata') {
    return new Response('', {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    })
  }
  const chain = /^\/chain\/(\d+)$/.exec(path)
  if (chain) {
    const index = Number(chain[1])
    if (index >= 6) return new Response('chain-end', { status: 200 })
    return new Response('', { status: 302, headers: { location: `/chain/${index + 1}` } })
  }
  if (path === '/big') {
    return new Response(Buffer.alloc(MAX_RESPONSE_BYTES + 4096, 0x61), {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  if (path === '/echo') {
    const requestBody = typeof init.body === 'string' ? init.body : ''
    const echoed = JSON.stringify({
      method: init.method,
      body: requestBody,
      headers: init.headers,
    })
    return new Response(echoed, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-mock': 'echo' },
    })
  }
  return new Response('mock-body', {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-mock': '1' },
  })
}

/**
 * Install the fetch mock for exactly one test, then restore the real fetch.
 * Scoping it per test (instead of for the whole file) keeps reruns with
 * `--test-isolation=none` from leaking into other test files that need the
 * real fetch (e.g. `retest-send.test.mjs`).
 * @param {string} name
 * @param {() => any} fn
 */
function itWithMockFetch(name, fn) {
  return it(name, async () => {
    const saved = globalThis.fetch
    globalThis.fetch = mockFetch
    try {
      return await fn()
    } finally {
      globalThis.fetch = saved
    }
  })
}

after(async () => {
  await server.close()
  cleanupDir(fixture.dir)
})

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function send(body) {
  return server.request('/cortex-api/cortex/repeater/send', { method: 'POST', body })
}

async function clearHistory() {
  const res = await server.request('/cortex-api/cortex/repeater/history', { method: 'DELETE' })
  assert.equal(res.status, 200, res.text)
}

function expectError(res, status, code) {
  assert.equal(res.status, status, res.text)
  assert.equal(res.json && res.json.code, code, res.text)
  return res.json
}

function targetRejected(status, code, reason) {
  return (err) =>
    err instanceof ApiError &&
    err.status === status &&
    err.code === code &&
    (reason === undefined || Boolean(err.details) && err.details.reason === reason)
}

function requestFor(url, extra = {}) {
  return validateFuzzerRequest({ method: 'GET', url, ...extra })
}

/* ------------------------------------------------------------------------- */
/* Standalone route: no vulnerability required                               */
/* ------------------------------------------------------------------------- */

describe('fuzzer/send: standalone route (no vulnId)', () => {
  itWithMockFetch('sends without a vulnId and keeps the exact RepeaterSendResult shape', async () => {
    fetchCalls = []
    const res = await send({ method: 'GET', url: `${PUBLIC_BASE}/ok` })
    assert.equal(res.status, 200, res.text)
    const payload = res.json
    assert.deepEqual(Object.keys(payload).sort(), ['request', 'response'])
    assert.deepEqual(Object.keys(payload.request).sort(), ['body', 'headers', 'method', 'url'])
    assert.deepEqual(Object.keys(payload.response).sort(), [
      'body',
      'durationMs',
      'headers',
      'status',
      'truncated',
    ])
    assert.equal(payload.request.method, 'GET')
    assert.equal(payload.request.url, `${PUBLIC_BASE}/ok`)
    assert.deepEqual(payload.request.headers, {})
    assert.equal(payload.request.body, '')
    assert.equal(payload.response.status, 200)
    assert.equal(payload.response.body, 'mock-body')
    assert.equal(payload.response.truncated, false)
    assert.equal(typeof payload.response.durationMs, 'number')
    assert.equal(payload.response.headers['x-mock'], '1')
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, `${PUBLIC_BASE}/ok`)
    assert.equal(fetchCalls[0].init.method, 'GET')
    assert.equal(fetchCalls[0].init.redirect, 'manual')
  })

  itWithMockFetch('caps the response at 2 MiB and reports truncation in the public shape', async () => {
    const res = await send({ method: 'GET', url: `${PUBLIC_BASE}/big` })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json.response.truncated, true)
    assert.equal(res.json.response.body.length, MAX_RESPONSE_BYTES)
  })

  itWithMockFetch('passes method, headers and body through to the target', async () => {
    const res = await send({
      method: 'POST',
      url: `${PUBLIC_BASE}/echo`,
      headers: { 'x-custom': 'abc', Host: 'evil.example' },
      body: 'hello fuzzer',
    })
    assert.equal(res.status, 200, res.text)
    const echoed = JSON.parse(res.json.response.body)
    assert.equal(echoed.method, 'POST')
    assert.equal(echoed.body, 'hello fuzzer')
    assert.equal(echoed.headers['x-custom'], 'abc')
    // Host is derived from the URL, never from the caller.
    assert.notEqual(echoed.headers.host, 'evil.example')
  })

  itWithMockFetch('stores history with an empty vulnId when the request omits it', async () => {
    await clearHistory()
    const res = await send({ method: 'GET', url: `${PUBLIC_BASE}/history-empty` })
    assert.equal(res.status, 200, res.text)
    const history = await server.request('/cortex-api/cortex/repeater/history')
    assert.equal(history.status, 200, history.text)
    const entry = history.json.items.find(
      (item) => item.request.url === `${PUBLIC_BASE}/history-empty`,
    )
    assert.ok(entry, 'history should contain the send')
    assert.equal(entry.vulnId, '')
    assert.equal(entry.response.status, 200)
    assert.equal(entry.response.body, 'mock-body')
  })

  itWithMockFetch('treats an unknown vulnId as metadata only (never a DB lookup)', async () => {
    await clearHistory()
    const res = await send({
      method: 'POST',
      url: `${PUBLIC_BASE}/echo`,
      vulnId: 'VULN-00000000-999',
      headers: { 'x-tag': 'kept' },
      body: 'still sent',
    })
    // The old vuln-origin path would 404 here; the fuzzer must not.
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json.response.status, 200)
    const history = await server.request('/cortex-api/cortex/repeater/history')
    const entries = history.json.items.filter((item) => item.vulnId === 'VULN-00000000-999')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].request.method, 'POST')
    assert.equal(entries[0].request.body, 'still sent')
  })

  itWithMockFetch('never fails the send when the history directory is unusable', async () => {
    const savedDir = process.env.CORTEX_REPEATER_DIR
    try {
      const blocker = join(fixture.dir, 'history-blocker')
      writeFileSync(blocker, 'not a directory', 'utf8')
      process.env.CORTEX_REPEATER_DIR = join(blocker, 'repeater')
      const res = await send({ method: 'GET', url: `${PUBLIC_BASE}/history-failure` })
      assert.equal(res.status, 200, res.text)
      assert.equal(res.json.response.status, 200)
    } finally {
      if (savedDir === undefined) delete process.env.CORTEX_REPEATER_DIR
      else process.env.CORTEX_REPEATER_DIR = savedDir
    }
  })
})

/* ------------------------------------------------------------------------- */
/* SSRF target policy through the route                                      */
/* ------------------------------------------------------------------------- */

describe('fuzzer/send: public-target SSRF policy', () => {
  itWithMockFetch('rejects loopback/private/link-local/metadata/userinfo/protocol targets with 403', async () => {
    const cases = [
      ['http://127.0.0.1/', 'loopback'],
      ['http://10.1.2.3/', 'private'],
      ['http://172.16.5.4:8080/', 'private'],
      ['http://192.168.1.10/', 'private'],
      ['http://169.254.169.254/latest/meta-data/', 'metadata'],
      ['http://100.100.100.200/latest/meta-data/', 'metadata'],
      ['http://[::1]/', 'loopback'],
      ['http://[::ffff:127.0.0.1]/', 'loopback'],
      ['http://[fe80::1]/', 'link-local'],
      ['http://[fc00::1]/', 'private'],
      ['http://localhost:8080/', 'loopback'],
      ['http://localhost./', 'loopback'],
      ['http://metadata.google.internal/computeMetadata/v1/', 'metadata'],
      ['http://user:pass@93.184.216.34/', 'userinfo'],
      ['ftp://93.184.216.34/', 'protocol'],
    ]
    fetchCalls = []
    for (const [url, reason] of cases) {
      const res = await send({ method: 'GET', url })
      assert.equal(res.status, 403, `${url}: ${res.text}`)
      assert.equal(res.json.code, 'TARGET_NOT_ALLOWED', url)
      assert.equal(res.json.details && res.json.details.reason, reason, url)
    }
    // All rejections happen before any connection attempt.
    assert.equal(fetchCalls.length, 0)
  })

  itWithMockFetch('re-validates redirect hops and refuses a redirect to loopback', async () => {
    fetchCalls = []
    const res = await send({
      method: 'GET',
      url: `${PUBLIC_BASE}/redirect-private`,
      followRedirects: true,
    })
    assert.equal(res.status, 403, res.text)
    assert.equal(res.json.code, 'TARGET_NOT_ALLOWED')
    assert.equal(res.json.details.reason, 'loopback')
    assert.equal(fetchCalls.length, 1, 'only the first hop may be requested')
  })

  itWithMockFetch('rejects redirects to cloud metadata endpoints', async () => {
    fetchCalls = []
    const res = await send({
      method: 'GET',
      url: `${PUBLIC_BASE}/redirect-metadata`,
      followRedirects: true,
    })
    assert.equal(res.status, 403, res.text)
    assert.equal(res.json.code, 'TARGET_NOT_ALLOWED')
    assert.equal(res.json.details.reason, 'metadata')
    assert.equal(fetchCalls.length, 1)
  })

  itWithMockFetch('follows allowed redirects and caps the chain at 5 hops', async () => {
    fetchCalls = []
    const ok = await send({ method: 'GET', url: `${PUBLIC_BASE}/redirect-ok`, followRedirects: true })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.response.status, 200)
    assert.equal(ok.json.response.body, 'mock-body')
    assert.equal(fetchCalls.length, 2)

    fetchCalls = []
    const capped = await send({ method: 'GET', url: `${PUBLIC_BASE}/chain/0`, followRedirects: true })
    assert.equal(capped.status, 200, capped.text)
    // Five followed hops, the sixth response is returned as-is.
    assert.equal(capped.json.response.status, 302)
    assert.equal(fetchCalls.length, 6)
  })

  itWithMockFetch('does not follow redirects unless asked', async () => {
    fetchCalls = []
    const res = await send({ method: 'GET', url: `${PUBLIC_BASE}/redirect-ok` })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json.response.status, 302)
    assert.equal(fetchCalls.length, 1)
  })

  itWithMockFetch('honours allowNetwork=false', async () => {
    const restricted = await startTestHost({ dbPath: fixture.dbPath, allowNetwork: false })
    try {
      const res = await restricted.request('/cortex-api/cortex/repeater/send', {
        method: 'POST',
        body: { method: 'GET', url: `${PUBLIC_BASE}/ok` },
      })
      expectError(res, 403, 'FORBIDDEN')
    } finally {
      await restricted.close()
    }
  })

  itWithMockFetch('rejects malformed requests with 400 BAD_REQUEST', async () => {
    fetchCalls = []
    const tooManyHeaders = {}
    for (let index = 0; index < 101; index += 1) tooManyHeaders[`x-h${index}`] = 'v'
    const cases = [
      { method: 'GET' },
      { method: 'TRACE', url: `${PUBLIC_BASE}/ok` },
      { method: 'GET', url: 'not-a-url' },
      { method: 'GET', url: '/relative/path' },
      { method: 'GET', url: `${PUBLIC_BASE}/ok`, headers: { 'content-length': '0' } },
      { method: 'GET', url: `${PUBLIC_BASE}/ok`, headers: { Connection: 'keep-alive' } },
      { method: 'GET', url: `${PUBLIC_BASE}/ok`, headers: { 'x-bad': 'a\r\nInjected: yes' } },
      { method: 'GET', url: `${PUBLIC_BASE}/ok`, headers: { 'x-bad': 5 } },
      { method: 'GET', url: `${PUBLIC_BASE}/ok`, headers: tooManyHeaders },
      { method: 'GET', url: `${PUBLIC_BASE}/ok`, followRedirects: 'yes' },
      { method: 'GET', url: `${PUBLIC_BASE}/ok`, body: 'not allowed' },
      { method: 'GET', url: `${PUBLIC_BASE}/ok`, vulnId: 42 },
      { method: 'POST', url: `${PUBLIC_BASE}/ok`, body: 'x'.repeat(256 * 1024 + 1) },
    ]
    for (const body of cases) {
      const res = await send(body)
      expectError(res, 400, 'BAD_REQUEST')
    }
    assert.equal(fetchCalls.length, 0)
  })
})

/* ------------------------------------------------------------------------- */
/* DNS policy (injected resolver, no real network)                           */
/* ------------------------------------------------------------------------- */

describe('fuzzer: DNS target policy', () => {
  itWithMockFetch('rejects a hostname when ANY resolved answer is non-public', async () => {
    await assert.rejects(
      assertTargetAllowed('http://mixed.example.test/', {
        resolveHost: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ],
      }),
      targetRejected(403, 'TARGET_NOT_ALLOWED', 'private'),
    )
    await assert.rejects(
      assertTargetAllowed('http://v6-mixed.example.test/', {
        resolveHost: async () => [
          { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
          { address: '::1', family: 6 },
        ],
      }),
      targetRejected(403, 'TARGET_NOT_ALLOWED', 'loopback'),
    )
  })

  itWithMockFetch('accepts a hostname whose every answer is public', async () => {
    const url = await assertTargetAllowed('http://public.example.test/path', {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    assert.equal(url.href, 'http://public.example.test/path')
  })

  itWithMockFetch('rejects static localhost/metadata names without any DNS query', async () => {
    let resolverCalls = 0
    const resolveHost = async () => {
      resolverCalls += 1
      return [{ address: '93.184.216.34', family: 4 }]
    }
    for (const [url, reason] of [
      ['http://localhost:8080/', 'loopback'],
      ['http://metadata.google.internal/', 'metadata'],
      ['http://metadata/', 'metadata'],
      ['http://instance-data/', 'metadata'],
    ]) {
      await assert.rejects(
        assertTargetAllowed(url, { resolveHost }),
        targetRejected(403, 'TARGET_NOT_ALLOWED', reason),
      )
    }
    assert.equal(resolverCalls, 0)
  })

  itWithMockFetch('maps DNS failure and empty resolution to 502 UPSTREAM_ERROR', async () => {
    await assert.rejects(
      assertTargetAllowed('http://nope.example.test/', {
        resolveHost: async () => {
          const err = new Error('getaddrinfo ENOTFOUND nope.example.test')
          err.code = 'ENOTFOUND'
          throw err
        },
      }),
      (err) =>
        err instanceof ApiError &&
        err.status === 502 &&
        err.code === 'UPSTREAM_ERROR' &&
        err.details.cause === 'ENOTFOUND',
    )
    await assert.rejects(
      assertTargetAllowed('http://empty.example.test/', { resolveHost: async () => [] }),
      (err) => err instanceof ApiError && err.status === 502 && err.code === 'UPSTREAM_ERROR',
    )
  })

  itWithMockFetch('revalidates a hostname resolved by the send path before fetching', async () => {
    fetchCalls = []
    const request = requestFor('http://internal.example.test/secret')
    await assert.rejects(
      sendFuzzerRequest(
        { request },
        { resolveHost: async () => [{ address: '192.168.0.10', family: 4 }] },
      ),
      targetRejected(403, 'TARGET_NOT_ALLOWED', 'private'),
    )
    assert.equal(fetchCalls.length, 0)
  })
})

/* ------------------------------------------------------------------------- */
/* Send limits (injected fetch)                                              */
/* ------------------------------------------------------------------------- */

describe('fuzzer: send limits and error mapping', () => {
  itWithMockFetch('returns the internal result shape and never resolves IP literals', async () => {
    let resolverCalls = 0
    let seenUrl = ''
    let seenInit = null
    let tick = 100
    const result = await sendFuzzerRequest(
      { request: requestFor(`${PUBLIC_BASE}/unit`) },
      {
        resolveHost: async () => {
          resolverCalls += 1
          return []
        },
        fetchImpl: async (url, init) => {
          seenUrl = String(url)
          seenInit = init
          return new Response('unit-body', {
            status: 201,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'x-unit': '1' },
          })
        },
        now: () => {
          tick += 25
          return tick
        },
      },
    )
    assert.equal(resolverCalls, 0, 'IP literals must not be resolved')
    assert.equal(seenUrl, `${PUBLIC_BASE}/unit`)
    assert.equal(seenInit.method, 'GET')
    assert.equal(seenInit.redirect, 'manual')
    assert.equal(result.status, 201)
    assert.equal(result.headers['x-unit'], '1')
    assert.equal(result.body, 'unit-body')
    assert.equal(result.bodyTruncated, false)
    assert.equal(result.durationMs, 25)
  })

  itWithMockFetch('caps response bodies at 2 MiB and flags truncation', async () => {
    const result = await sendFuzzerRequest(
      { request: requestFor(`${PUBLIC_BASE}/big`) },
      {
        fetchImpl: async () =>
          new Response(Buffer.alloc(MAX_RESPONSE_BYTES + 4096, 0x61), {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      },
    )
    assert.equal(result.status, 200)
    assert.equal(result.bodyTruncated, true)
    assert.equal(result.bodyBytes, MAX_RESPONSE_BYTES)
    assert.equal(result.body.length, MAX_RESPONSE_BYTES)
  })

  itWithMockFetch('maps timeouts to 502 UPSTREAM_TIMEOUT', async () => {
    await assert.rejects(
      sendFuzzerRequest(
        { request: requestFor(`${PUBLIC_BASE}/timeout`) },
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

  itWithMockFetch('maps connection failures to 502 UPSTREAM_ERROR with a sanitized cause', async () => {
    await assert.rejects(
      sendFuzzerRequest(
        { request: requestFor(`${PUBLIC_BASE}/destroy`) },
        {
          fetchImpl: async () => {
            const cause = Object.assign(new Error('connect ECONNREFUSED'), {
              code: 'ECONNREFUSED',
            })
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

  itWithMockFetch('revalidates redirect targets inside the send loop', async () => {
    let calls = 0
    await assert.rejects(
      sendFuzzerRequest(
        { request: requestFor(`${PUBLIC_BASE}/redir`, { followRedirects: true }) },
        {
          fetchImpl: async () => {
            calls += 1
            return new Response('', {
              status: 302,
              headers: { location: 'http://10.0.0.5/admin' },
            })
          },
        },
      ),
      targetRejected(403, 'TARGET_NOT_ALLOWED', 'private'),
    )
    assert.equal(calls, 1)
  })
})

/* ------------------------------------------------------------------------- */
/* Validation + classification (pure helpers)                                */
/* ------------------------------------------------------------------------- */

describe('fuzzer: request validation', () => {
  itWithMockFetch('accepts a body without vulnId and keeps vulnId optional metadata', () => {
    const parsed = validateFuzzerRequest({ method: 'GET', url: `${PUBLIC_BASE}/` })
    assert.equal(parsed.vulnId, undefined)
    assert.equal(parsed.followRedirects, false)
    assert.equal(parsed.body, undefined)
    assert.equal(parsed.headers.host, undefined)

    const withVuln = validateFuzzerRequest({
      vulnId: '  VULN-20260101-001  ',
      method: 'GET',
      url: `${PUBLIC_BASE}/`,
    })
    assert.equal(withVuln.vulnId, 'VULN-20260101-001')

    const withHost = validateFuzzerRequest({
      method: 'GET',
      url: `${PUBLIC_BASE}/`,
      headers: { Host: 'evil.example', 'X-Keep': '1' },
    })
    assert.equal(Object.keys(withHost.headers).length, 1)
    assert.equal(withHost.headers['X-Keep'], '1')
  })

  itWithMockFetch('rejects malformed shapes with 400 BAD_REQUEST', () => {
    const badBodies = [
      null,
      [],
      {},
      { method: 'GET' },
      { method: 'get', url: `${PUBLIC_BASE}/` },
      { method: 'TRACE', url: `${PUBLIC_BASE}/` },
      { method: 'GET', url: 'not-a-url' },
      { method: 'GET', url: '/relative' },
      { method: 'GET', url: `${PUBLIC_BASE}/`, followRedirects: 1 },
      { method: 'GET', url: `${PUBLIC_BASE}/`, vulnId: 1 },
      { method: 'GET', url: `${PUBLIC_BASE}/`, vulnId: 'x'.repeat(201) },
      { method: 'GET', url: `${PUBLIC_BASE}/`, headers: [] },
      { method: 'GET', url: `${PUBLIC_BASE}/`, headers: { 'x-bad': 'a\r\nb' } },
      { method: 'GET', url: `${PUBLIC_BASE}/`, headers: { 'transfer-encoding': 'chunked' } },
      { method: 'GET', url: `${PUBLIC_BASE}/`, headers: { upgrade: 'h2c' } },
      { method: 'GET', url: `${PUBLIC_BASE}/`, headers: { 'keep-alive': 'timeout=5' } },
      { method: 'GET', url: `${PUBLIC_BASE}/`, headers: { 'proxy-connection': 'keep-alive' } },
      { method: 'GET', url: `${PUBLIC_BASE}/`, headers: { 'x-bad': 5 } },
      { method: 'POST', url: `${PUBLIC_BASE}/`, body: 5 },
      { method: 'GET', url: `${PUBLIC_BASE}/`, body: 'nope' },
      { method: 'POST', url: `${PUBLIC_BASE}/`, body: 'x'.repeat(256 * 1024 + 1) },
    ]
    for (const body of badBodies) {
      assert.throws(
        () => validateFuzzerRequest(body),
        (err) => err instanceof ApiError && err.status === 400 && err.code === 'BAD_REQUEST',
        JSON.stringify(body).slice(0, 100),
      )
    }
  })

  itWithMockFetch('accepts a 256 KiB body at the boundary', () => {
    const parsed = validateFuzzerRequest({
      method: 'POST',
      url: `${PUBLIC_BASE}/`,
      body: 'x'.repeat(256 * 1024),
    })
    assert.equal(Buffer.byteLength(parsed.body, 'utf8'), 256 * 1024)
  })
})

describe('fuzzer: address classification', () => {
  itWithMockFetch('classifies public addresses as safe and reserved ranges with stable reasons', () => {
    const expected = new Map([
      ['93.184.216.34', null],
      ['8.8.8.8', null],
      ['2606:2800:220:1:248:1893:25c8:1946', null],
      ['127.0.0.1', 'loopback'],
      ['127.9.9.9', 'loopback'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.254', 'private'],
      ['192.168.0.1', 'private'],
      ['100.64.0.1', 'private'],
      ['169.254.1.1', 'link-local'],
      ['169.254.169.254', 'metadata'],
      ['100.100.100.200', 'metadata'],
      ['224.0.0.1', 'multicast'],
      ['239.255.255.250', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['0.0.0.0', 'reserved'],
      ['198.18.0.1', 'reserved'],
      ['203.0.113.1', 'reserved'],
      ['::1', 'loopback'],
      ['::', 'reserved'],
      ['fc00::1', 'private'],
      ['fd12:3456::1', 'private'],
      ['fd00:ec2::254', 'metadata'],
      ['fe80::1', 'link-local'],
      ['ff02::1', 'multicast'],
      ['2001:db8::1', 'reserved'],
      ['::ffff:10.0.0.1', 'private'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['not-an-ip', 'invalid-address'],
    ])
    for (const [address, reason] of expected) {
      assert.equal(classifyAddress(address), reason, address)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* History file (best effort) stays writable for the existing store tests    */
/* ------------------------------------------------------------------------- */

describe('fuzzer: history integration', () => {
  itWithMockFetch('writes at most one entry per send and never a history field on the result', async () => {
    await clearHistory()
    const before = loadHistory().length
    const res = await send({ method: 'GET', url: `${PUBLIC_BASE}/history-one` })
    assert.equal(res.status, 200, res.text)
    assert.equal(loadHistory().length, before + 1)
    assert.equal(Object.keys(res.json).sort().join(','), 'request,response')
  })
})
