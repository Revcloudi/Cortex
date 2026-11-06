import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  ApiError,
  assertLoopbackHost,
  assertLoopbackPeer,
  assertSameOriginWrite,
  badRequest,
  describeError,
  normalizeHostHeader,
  parseRequestUrl,
  queryBool01,
  queryEnum,
  queryInt,
  queryString,
} from '../../src/host/http.js'
import {
  cleanupDir,
  createTestDb,
  invokeFake,
  startTestHost,
} from './helpers.mjs'

const fixture = createTestDb()
const server = await startTestHost({ dbPath: fixture.dbPath })

after(async () => {
  await server.close()
  cleanupDir(fixture.dir)
})

function fakeReq({ method = 'GET', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { method, url: '/cortex-api/health', headers, socket: { remoteAddress } }
}

describe('http: loopback fences (unit)', () => {
  it('normalizes Host headers', () => {
    assert.equal(normalizeHostHeader('127.0.0.1:63877'), '127.0.0.1')
    assert.equal(normalizeHostHeader('localhost:1234'), 'localhost')
    assert.equal(normalizeHostHeader('[::1]:63877'), '::1')
    assert.equal(normalizeHostHeader('::1'), '::1')
    assert.equal(normalizeHostHeader('evil.example:80'), 'evil.example')
    assert.equal(normalizeHostHeader(''), '')
    assert.equal(normalizeHostHeader(undefined), '')
  })

  it('accepts only loopback peers', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.doesNotThrow(() => assertLoopbackPeer(fakeReq({ remoteAddress: address })))
    }
    for (const address of ['10.0.0.1', '192.168.1.5', '::ffff:10.0.0.1', '']) {
      assert.throws(
        () => assertLoopbackPeer(fakeReq({ remoteAddress: address })),
        (err) => err instanceof ApiError && err.status === 403 && err.code === 'FORBIDDEN_PEER',
      )
    }
  })

  it('accepts only loopback Host headers', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:63877', 'localhost:1', '[::1]:80', '::1']) {
      assert.doesNotThrow(() => assertLoopbackHost(fakeReq({ headers: { host } })))
    }
    for (const host of ['evil.example', '127.0.0.2:80', '10.0.0.1:8080', '', 'example.test:80']) {
      assert.throws(
        () => assertLoopbackHost(fakeReq({ headers: { host } })),
        (err) => err instanceof ApiError && err.status === 403 && err.code === 'FORBIDDEN_HOST',
      )
    }
    assert.throws(
      () => assertLoopbackHost(fakeReq({ headers: {} })),
      (err) => err.code === 'FORBIDDEN_HOST',
    )
  })

  it('enforces the same-origin write fence', () => {
    const jsonHeaders = { 'content-type': 'application/json' }
    assert.doesNotThrow(() =>
      assertSameOriginWrite(fakeReq({ method: 'PATCH', headers: { ...jsonHeaders } })),
    )
    assert.doesNotThrow(() =>
      assertSameOriginWrite(
        fakeReq({ method: 'POST', headers: { ...jsonHeaders, origin: 'http://127.0.0.1:63877' } }),
      ),
    )
    assert.doesNotThrow(() =>
      assertSameOriginWrite(
        fakeReq({
          method: 'POST',
          headers: { ...jsonHeaders, origin: 'http://localhost:1', 'sec-fetch-site': 'same-origin' },
        }),
      ),
    )
    assert.throws(
      () =>
        assertSameOriginWrite(
          fakeReq({ method: 'PATCH', headers: { ...jsonHeaders, origin: 'https://evil.example' } }),
        ),
      (err) => err.status === 403 && err.code === 'FORBIDDEN_ORIGIN',
    )
    assert.throws(
      () =>
        assertSameOriginWrite(
          fakeReq({ method: 'PATCH', headers: { ...jsonHeaders, 'sec-fetch-site': 'cross-site' } }),
        ),
      (err) => err.status === 403 && err.code === 'FORBIDDEN_ORIGIN',
    )
    assert.throws(
      () => assertSameOriginWrite(fakeReq({ method: 'POST', headers: {} })),
      (err) => err.status === 403 && err.code === 'FORBIDDEN_CONTENT_TYPE',
    )
    // Non-write methods need no content type.
    assert.doesNotThrow(() => assertSameOriginWrite(fakeReq({ method: 'GET', headers: {} })))
  })
})

describe('http: query validation helpers', () => {
  const params = (search) => new URLSearchParams(search)

  it('validates enums and integers', () => {
    assert.equal(queryEnum(params('realm=web'), 'realm', ['web', 'internal']), 'web')
    assert.equal(queryEnum(params(''), 'realm', ['web']), undefined)
    assert.throws(() => queryEnum(params('realm=all'), 'realm', ['web']), ApiError)
    assert.equal(queryInt(params('page=3'), 'page', { min: 1 }), 3)
    assert.throws(() => queryInt(params('page=0'), 'page', { min: 1 }), ApiError)
    assert.throws(() => queryInt(params('pageSize=101'), 'pageSize', { min: 1, max: 100 }), ApiError)
    assert.throws(() => queryInt(params('page=1.5'), 'page', { min: 1 }), ApiError)
    assert.equal(queryBool01(params('includeArchived=1'), 'includeArchived'), true)
    assert.equal(queryBool01(params('includeArchived=0'), 'includeArchived'), false)
    assert.throws(() => queryBool01(params('includeArchived=2'), 'includeArchived'), ApiError)
  })

  it('caps query value lengths', () => {
    assert.equal(queryString(params('search=abc'), 'search', { max: 400 }), 'abc')
    assert.throws(() => queryString(params(`search=${'a'.repeat(401)}`), 'search', { max: 400 }), ApiError)
    assert.throws(() => queryString(params(`project=${'a'.repeat(201)}`), 'project'), ApiError)
    assert.equal(queryString(params('search='), 'search'), undefined)
  })

  it('parses request URLs and rejects malformed ones', () => {
    const parsed = parseRequestUrl({ url: '/cortex-api/vulns?realm=web&page=2' })
    assert.equal(parsed.pathname, '/cortex-api/vulns')
    assert.equal(parsed.searchParams.get('realm'), 'web')
  })
})

describe('http: error envelope', () => {
  it('maps ApiError and unknown errors without leaking internals', () => {
    const api = describeError(new ApiError(400, 'BAD_REQUEST', 'param bad', { param: 'page' }))
    assert.deepEqual(api, {
      status: 400,
      body: { error: 'param bad', code: 'BAD_REQUEST', details: { param: 'page' } },
    })
    assert.deepEqual(describeError(new ApiError(404, 'NOT_FOUND', 'not found')), {
      status: 404,
      body: { error: 'not found', code: 'NOT_FOUND' },
    })
    const unknown = describeError(new Error('C:\\Users\\secret\\data.db SQL SELECT'))
    assert.deepEqual(unknown, { status: 500, body: { error: 'internal error', code: 'INTERNAL' } })
    assert.equal(JSON.stringify(unknown).includes('data.db'), false)
  })
})

describe('http: live loopback server', () => {
  it('serves /health with the contract shape and no absolute DB path', async () => {
    const res = await server.request('/cortex-api/health')
    assert.equal(res.status, 200)
    const body = res.json
    assert.equal(body.ok, true)
    assert.equal(body.plugin, 'dsh-cortex')
    assert.equal(typeof body.version, 'string')
    assert.equal(body.dsh.version, '0.2.2-rc.1')
    assert.equal(body.sqlite, true)
    assert.deepEqual(Object.keys(body.db).sort(), [
      'available',
      'busy',
      'compatible',
      'dbFile',
      'error',
      'readOnly',
      'schemaVersion',
    ])
    assert.equal(body.db.available, true)
    assert.equal(body.db.schemaVersion, 5)
    assert.equal(body.db.compatible, true)
    assert.equal(body.db.dbFile, 'data.db')
    assert.equal(body.db.readOnly, false)
    assert.equal(body.server.loopbackOnly, true)
    assert.equal(JSON.stringify(body).includes(fixture.dir), false)
    assert.equal(JSON.stringify(body).includes('.cortex'), false)
    assert.equal(res.headers['cache-control'], 'no-store')
  })

  it('allows the loopback Host header and rejects non-loopback Host via node:http', async () => {
    // The helper uses node:http (not fetch) so the Host header is controllable.
    const allowed = await server.request('/cortex-api/health', { headers: { host: `127.0.0.1:${server.port}` } })
    assert.equal(allowed.status, 200)

    const localhost = await server.request('/cortex-api/health', { headers: { host: 'localhost' } })
    assert.equal(localhost.status, 200)

    const evil = await server.request('/cortex-api/health', { headers: { host: 'evil.example:443' } })
    assert.equal(evil.status, 403)
    assert.equal(evil.json.code, 'FORBIDDEN_HOST')

    const ipv6 = await server.request('/cortex-api/health', { headers: { host: '[::1]:63877' } })
    assert.equal(ipv6.status, 200)
  })

  it('rejects non-loopback peers at the handler boundary', async () => {
    const { res, json } = await invokeFake(server.host, {
      method: 'GET',
      url: '/cortex-api/health',
      headers: { host: '127.0.0.1' },
      socket: { remoteAddress: '10.1.2.3' },
    })
    assert.equal(res.statusCode, 403)
    assert.equal(json.code, 'FORBIDDEN_PEER')

    const allowed = await invokeFake(server.host, {
      method: 'GET',
      url: '/cortex-api/health',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    })
    assert.equal(allowed.res.statusCode, 200)
    assert.equal(allowed.json.ok, true)
  })

  it('rejects OPTIONS and unknown routes, and wrong methods on known paths', async () => {
    const options = await server.request('/cortex-api/health', { method: 'OPTIONS' })
    assert.equal(options.status, 405)
    assert.equal(options.json.code, 'METHOD_NOT_ALLOWED')

    const unknown = await server.request('/cortex-api/nope')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.code, 'NOT_FOUND')

    const wrongMethod = await server.request('/cortex-api/health', { method: 'DELETE' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.json.code, 'METHOD_NOT_ALLOWED')

    const wrongMethod2 = await server.request('/cortex-api/vulns/VULN-20260101-001', { method: 'POST' })
    assert.equal(wrongMethod2.status, 405)
  })

  it('never emits CORS headers', async () => {
    const res = await server.request('/cortex-api/vulns', { headers: { origin: 'http://127.0.0.1:63877' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
    assert.equal(res.headers['access-control-allow-credentials'], undefined)
  })

  it('enforces write Origin / Sec-Fetch-Site / Content-Type checks', async () => {
    const path = '/cortex-api/vulns/VULN-20260101-002/status'

    const noContentType = await server.request(path, {
      method: 'PATCH',
      rawBody: JSON.stringify({ status: 'Confirmed' }),
    })
    assert.equal(noContentType.status, 403)
    assert.equal(noContentType.json.code, 'FORBIDDEN_CONTENT_TYPE')

    const evilOrigin = await server.request(path, {
      method: 'PATCH',
      body: { status: 'Confirmed' },
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(evilOrigin.status, 403)
    assert.equal(evilOrigin.json.code, 'FORBIDDEN_ORIGIN')

    const crossSite = await server.request(path, {
      method: 'PATCH',
      body: { status: 'Confirmed' },
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossSite.status, 403)
    assert.equal(crossSite.json.code, 'FORBIDDEN_ORIGIN')

    const allowed = await server.request(path, {
      method: 'PATCH',
      body: { status: 'Confirmed' },
      headers: { origin: `http://127.0.0.1:${server.port}`, 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.json.ok, true)
  })

  it('validates query parameters strictly', async () => {
    for (const path of [
      '/cortex-api/vulns?pageSize=101',
      '/cortex-api/vulns?page=0',
      '/cortex-api/vulns?page=abc',
      '/cortex-api/vulns?realm=bogus',
      '/cortex-api/vulns?severity=critical',
      '/cortex-api/vulns?status=Open',
      `/cortex-api/vulns?search=${'a'.repeat(401)}`,
      `/cortex-api/internal/overview?project=${'a'.repeat(201)}`,
      '/cortex-api/snapshots?includeArchived=2',
      '/cortex-api/assets?status=Bogus',
    ]) {
      const res = await server.request(path)
      assert.equal(res.status, 400, path)
      assert.equal(res.json.code, 'BAD_REQUEST', path)
    }
  })

  it('caps request bodies at 1 MiB', async () => {
    const path = '/cortex-api/vulns/VULN-20260101-001/retest'
    const huge = JSON.stringify({ timeRange: 'x', conclusion: 'y'.repeat(1024 * 1024 + 10) })
    const res = await server.request(path, {
      method: 'POST',
      rawBody: huge,
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'BAD_REQUEST')
  })

  it('rejects malformed, empty and non-object JSON bodies', async () => {
    const path = '/cortex-api/vulns/VULN-20260101-001/status'
    const headers = { 'content-type': 'application/json' }
    const malformed = await server.request(path, { method: 'PATCH', rawBody: '{not json', headers })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.json.code, 'BAD_REQUEST')

    const empty = await server.request(path, { method: 'PATCH', rawBody: '', headers })
    assert.equal(empty.status, 400)

    const arrayBody = await server.request(path, { method: 'PATCH', rawBody: '[1,2,3]', headers })
    assert.equal(arrayBody.status, 400)
  })

  it('serves unknown routes with the contract 404 envelope', async () => {
    const res = await server.request('/cortex-api/vulns/one/two/three')
    assert.equal(res.status, 404)
    assert.equal(res.json.code, 'NOT_FOUND')
    assert.equal(typeof res.json.error, 'string')
  })

  it('keeps helper error constructors consistent', () => {
    assert.equal(badRequest('x').status, 400)
    assert.equal(badRequest('x').code, 'BAD_REQUEST')
  })
})
