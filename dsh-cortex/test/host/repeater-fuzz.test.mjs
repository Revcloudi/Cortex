/**
 * Repeater Fuzzer host tests (contract `.cache/fuzzer-contract.md`).
 *
 * Pure unit coverage for `expandFuzzCases()` / validation + real HTTP
 * integration through `startTestHost()` against a throwaway loopback upstream.
 *
 * All repeater state is redirected to a temp `CORTEX_REPEATER_DIR`; the
 * operator's `~/.cortex` is never read or written.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ApiError } from '../../src/host/http.js'
import {
  FUZZ_MODES,
  MAX_FUZZ_CASES,
  expandFuzzCases,
  validateFuzzJobInput,
  validateFuzzTemplate,
} from '../../src/host/cortex/repeater-fuzz.js'
import {
  loadHistory,
  recordSendHistory,
} from '../../src/host/cortex/repeater-store.js'
import {
  cleanupDir,
  createTestDb,
  insertVuln,
  openRawDb,
  startTestHost,
} from './helpers.mjs'

/* ------------------------------------------------------------------------- */
/* Temp repeater root (never the operator's ~/.cortex)                       */
/* ------------------------------------------------------------------------- */

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-cortex-fuzz-'))
const REPEATER_ROOT = join(TEMP_ROOT, 'repeater')
process.env.CORTEX_REPEATER_DIR = REPEATER_ROOT

/* ------------------------------------------------------------------------- */
/* Throwaway upstream                                                        */
/* ------------------------------------------------------------------------- */

const upstream = http.createServer((req, res) => {
  const parsed = new URL(req.url || '/', 'http://127.0.0.1')
  const path = parsed.pathname
  if (path === '/echo') {
    const x = parsed.searchParams.get('x') ?? ''
    const y = parsed.searchParams.get('y') ?? ''
    const body = `hit:${x}:${y}`
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(body)
    return
  }
  if (path === '/redirect') {
    const to = parsed.searchParams.get('to') ?? ''
    if (to === 'evil') {
      res.writeHead(302, { location: 'http://evil.example.test/steal' })
      res.end()
      return
    }
    res.writeHead(302, { location: '/echo?x=redirected' })
    res.end()
    return
  }
  if (path === '/slow') {
    const i = parsed.searchParams.get('i') ?? ''
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`slow:${i}`)
    }, 120)
    return
  }
  if (path === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('z'.repeat(300 * 1024))
    return
  }
  if (path === '/destroy') {
    req.socket.destroy()
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamAddress = upstream.address()
const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress ? upstreamAddress.port : 0
const upstreamBase = `http://127.0.0.1:${upstreamPort}`

const VULN_ID = 'VULN-FUZZ-001'

const fixture = createTestDb()
{
  const db = openRawDb(fixture.dbPath)
  try {
    insertVuln(db, {
      id: VULN_ID,
      host: `127.0.0.1:${upstreamPort}`,
      entry_point: '/echo',
      vuln_name: 'Local fuzz target',
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

/** @type {string} */
let firstCompletedJobId = ''

after(async () => {
  await server.close()
  await new Promise((resolve) => upstream.close(resolve))
  cleanupDir(fixture.dir)
  cleanupDir(TEMP_ROOT)
})

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

const FUZZ_PATH = '/cortex-api/cortex/repeater/fuzz'

/** @param {{status:number, text:string, json:any}} res */
function expectOk(res) {
  assert.equal(res.status, 200, res.text)
  return res.json
}

/** @param {{status:number, json:any, text:string}} res @param {number} status @param {string} code */
function expectError(res, status, code) {
  assert.equal(res.status, status, res.text)
  assert.equal(res.json && res.json.code, code, res.text)
  return res.json
}

/** @param {Record<string, any>} body */
function createFuzzJob(body) {
  return server.request(FUZZ_PATH, { method: 'POST', body })
}

/** @param {string} jobId @param {string} [query] */
function getFuzzJob(jobId, query = '') {
  return server.request(`${FUZZ_PATH}/${jobId}${query}`)
}

/** @param {Record<string, any>} template @param {Record<string, any>} attack */
function expand(template, attack) {
  return expandFuzzCases({ template, attack })
}

/** @param {() => any} fn @param {(err: ApiError) => boolean} [check] */
function expectBadRequest(fn, check) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ApiError, 'expected ApiError')
    assert.equal(err.status, 400, err.message)
    assert.equal(err.code, 'BAD_REQUEST', err.message)
    if (check) assert.ok(check(err), 'unexpected error details')
    return true
  })
}

/** @param {string} jobId @param {(state: any) => boolean} predicate @param {number} [timeoutMs] */
async function waitForJob(jobId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const res = await getFuzzJob(jobId, '?offset=0&limit=1000')
    assert.equal(res.status, 200, res.text)
    last = res.json
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`fuzz job did not reach the expected state: ${JSON.stringify(last && last.job)}`)
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const MARKED_TEMPLATE = () => ({
  method: 'GET',
  url: 'http://127.0.0.1:9/a/§one§?two=§two§',
  headers: { 'X-Mark': 'v-§three§' },
  body: '',
})

/* ------------------------------------------------------------------------- */
/* Unit: expandFuzzCases                                                     */
/* ------------------------------------------------------------------------- */

describe('repeater-fuzz: expandFuzzCases', () => {
  it('exposes the contract constants', () => {
    assert.deepEqual(FUZZ_MODES, ['sniper', 'battering_ram', 'pitchfork', 'cluster_bomb'])
    assert.equal(MAX_FUZZ_CASES, 2000)
  })

  it('sniper: position-major ordering, totals and base text', () => {
    const result = expand(MARKED_TEMPLATE(), { mode: 'sniper', payloadSets: [['1', '2']] })
    assert.equal(result.mode, 'sniper')
    assert.equal(result.total, 6)
    assert.deepEqual(result.positions, [
      { index: 0, field: 'url' },
      { index: 1, field: 'url' },
      { index: 2, field: 'header', name: 'X-Mark' },
    ])
    // Position 0 first: both payloads, other positions keep their base text.
    assert.equal(result.cases[0].request.url, 'http://127.0.0.1:9/a/1?two=two')
    assert.equal(result.cases[0].request.headers['X-Mark'], 'v-three')
    assert.equal(result.cases[1].request.url, 'http://127.0.0.1:9/a/2?two=two')
    // Then position 1.
    assert.equal(result.cases[2].request.url, 'http://127.0.0.1:9/a/one?two=1')
    assert.equal(result.cases[3].request.url, 'http://127.0.0.1:9/a/one?two=2')
    // Then position 2 (header).
    assert.equal(result.cases[4].request.headers['X-Mark'], 'v-1')
    assert.equal(result.cases[5].request.headers['X-Mark'], 'v-2')
    assert.deepEqual(result.cases[0].payloads, ['1', 'two', 'three'])
    assert.equal(result.cases[0].payloadBrief, 'pos1=1')
    assert.equal(result.cases[4].payloadBrief, 'pos3=1')
  })

  it('battering_ram: set #1 applied to every position in payload order', () => {
    const result = expand(MARKED_TEMPLATE(), { mode: 'battering_ram', payloadSets: [['x', 'y']] })
    assert.equal(result.total, 2)
    assert.equal(result.cases[0].request.url, 'http://127.0.0.1:9/a/x?two=x')
    assert.equal(result.cases[0].request.headers['X-Mark'], 'v-x')
    assert.equal(result.cases[0].payloadBrief, 'pos1=x&pos2=x&pos3=x')
    assert.equal(result.cases[1].request.url, 'http://127.0.0.1:9/a/y?two=y')
  })

  it('pitchfork: parallel advance, stops at the shortest used set', () => {
    const result = expand(MARKED_TEMPLATE(), {
      mode: 'pitchfork',
      payloadSets: [
        ['1', '2', '3'],
        ['a', 'b'],
        ['h1', 'h2'],
      ],
    })
    assert.equal(result.total, 2)
    assert.equal(result.cases[0].request.url, 'http://127.0.0.1:9/a/1?two=a')
    assert.equal(result.cases[0].request.headers['X-Mark'], 'v-h1')
    assert.equal(result.cases[1].request.url, 'http://127.0.0.1:9/a/2?two=b')
    assert.equal(result.cases[1].request.headers['X-Mark'], 'v-h2')
  })

  it('cluster_bomb: cartesian product, last position varies fastest', () => {
    const result = expand(MARKED_TEMPLATE(), {
      mode: 'cluster_bomb',
      payloadSets: [
        ['1', '2'],
        ['a', 'b', 'c'],
        ['h1', 'h2'],
      ],
    })
    assert.equal(result.total, 12)
    const combos = result.cases.map((item) => item.payloads)
    assert.deepEqual(combos.slice(0, 6), [
      ['1', 'a', 'h1'],
      ['1', 'a', 'h2'],
      ['1', 'b', 'h1'],
      ['1', 'b', 'h2'],
      ['1', 'c', 'h1'],
      ['1', 'c', 'h2'],
    ])
    assert.deepEqual(combos[11], ['2', 'c', 'h2'])
    assert.equal(result.cases[11].request.url, 'http://127.0.0.1:9/a/2?two=c')
  })

  it('orders body positions after URL and header positions', () => {
    const template = {
      method: 'POST',
      url: 'http://127.0.0.1:9/echo',
      headers: { 'Content-Type': 'text/plain' },
      body: 'a=§1§&b=§2§',
    }
    const result = expand(template, { mode: 'pitchfork', payloadSets: [['x'], ['y']] })
    assert.deepEqual(result.positions, [
      { index: 0, field: 'body' },
      { index: 1, field: 'body' },
    ])
    assert.equal(result.total, 1)
    assert.equal(result.cases[0].request.body, 'a=x&b=y')
    assert.equal(result.cases[0].request.headers['Content-Type'], 'text/plain')
  })

  it('rejects unclosed and absent § markers', () => {
    expectBadRequest(() =>
      expand({ ...MARKED_TEMPLATE(), url: 'http://127.0.0.1:9/a/§one' }, {
        mode: 'sniper',
        payloadSets: [['1']],
      }),
    )
    expectBadRequest(() =>
      expand({ ...MARKED_TEMPLATE(), headers: { 'X-Mark': 'v-§x' } }, {
        mode: 'sniper',
        payloadSets: [['1']],
      }),
    )
    expectBadRequest(() =>
      expand({ ...MARKED_TEMPLATE(), body: 'a=§b' }, { mode: 'sniper', payloadSets: [['1']] }),
    )
    expectBadRequest(() =>
      expand(
        { method: 'GET', url: 'http://127.0.0.1:9/plain', headers: {}, body: '' },
        { mode: 'sniper', payloadSets: [['1']] },
      ),
    )
  })

  it('caps positions at 100 and cases at 2000', () => {
    const manyPositions = `http://127.0.0.1:9/?${Array.from(
      { length: 101 },
      (_value, index) => `p${index}=§§`,
    ).join('&')}`
    expectBadRequest(
      () =>
        expand(
          { method: 'GET', url: manyPositions, headers: {}, body: '' },
          { mode: 'battering_ram', payloadSets: [['1']] },
        ),
      (err) => err.details && err.details.maxPositions === 100,
    )

    const payloads = Array.from({ length: 2001 }, (_value, index) => String(index % 10))
    expectBadRequest(
      () =>
        expand(
          { method: 'GET', url: 'http://127.0.0.1:9/?a=§§', headers: {}, body: '' },
          { mode: 'sniper', payloadSets: [payloads] },
        ),
      (err) => err.details && err.details.maxCases === 2000,
    )
  })

  it('rejects bad modes and payload-set shapes/counts', () => {
    const template = MARKED_TEMPLATE()
    expectBadRequest(() => expand(template, { mode: 'scan', payloadSets: [['1']] }))
    expectBadRequest(() => expand(template, { mode: 'sniper' }))
    expectBadRequest(() => expand(template, { mode: 'sniper', payloadSets: 'nope' }))
    expectBadRequest(() => expand(template, { mode: 'sniper', payloadSets: [[1, 2]] }))
    expectBadRequest(() => expand(template, { mode: 'sniper', payloadSets: [[]] }))
    expectBadRequest(() => expand(template, { mode: 'battering_ram', payloadSets: [[]] }))
    expectBadRequest(() =>
      expand(template, { mode: 'pitchfork', payloadSets: [['a', 'b']] }),
    )
    expectBadRequest(() =>
      expand(template, { mode: 'cluster_bomb', payloadSets: [['1'], []] }),
    )
    // Payload byte cap (2 MiB).
    expectBadRequest(
      () =>
        expand(template, {
          mode: 'sniper',
          payloadSets: [['a'.repeat(2 * 1024 * 1024 + 1)]],
        }),
      (err) => err.details && err.details.maxBytes === 2 * 1024 * 1024,
    )
  })
})

/* ------------------------------------------------------------------------- */
/* Unit: template / job input validation (reuses retest.js rules)            */
/* ------------------------------------------------------------------------- */

describe('repeater-fuzz: validation', () => {
  it('validates the template with the single-send rules', () => {
    const valid = validateFuzzTemplate(MARKED_TEMPLATE())
    assert.equal(valid.method, 'GET')
    assert.equal(valid.url, MARKED_TEMPLATE().url)
    assert.equal(valid.body, '')

    expectBadRequest(() =>
      validateFuzzTemplate({
        method: 'GET',
        url: 'http://127.0.0.1:9/',
        headers: { 'content-length': '1' },
      }),
    )
    expectBadRequest(() =>
      validateFuzzTemplate({ method: 'get', url: 'http://127.0.0.1:9/?a=§§' }),
    )
    expectBadRequest(() =>
      validateFuzzTemplate({ method: 'GET', url: 'ftp://127.0.0.1/x' }),
    )
    expectBadRequest(() =>
      validateFuzzTemplate({ method: 'GET', url: 'http://user:pass@127.0.0.1:9/x' }),
    )
    expectBadRequest(() =>
      validateFuzzTemplate({ method: 'GET', url: 'http://169.254.169.254/latest/' }),
    )
    expectBadRequest(() =>
      validateFuzzTemplate({
        method: 'POST',
        url: 'http://127.0.0.1:9/x',
        body: 'a'.repeat(256 * 1024 + 1),
      }),
    )
    expectBadRequest(() =>
      validateFuzzTemplate({ method: 'GET', url: 'http://127.0.0.1:9/x', body: 'nope' }),
    )
  })

  it('drops the Host header silently (URL host wins)', () => {
    const normalized = validateFuzzTemplate({
      method: 'GET',
      url: 'http://127.0.0.1:9/?a=§§',
      headers: { Host: 'evil.example', Accept: '*/*' },
    })
    assert.deepEqual(normalized.headers, { Accept: '*/*' })
  })

  it('validates job options with strict numeric bounds', () => {
    const validBody = {
      vulnId: VULN_ID,
      request: { method: 'GET', url: 'http://127.0.0.1:9/?a=§§', headers: {}, body: '' },
      attack: { mode: 'sniper', payloadSets: [['1', '2']] },
    }
    const options = [
      { concurrency: 0 },
      { concurrency: 11 },
      { concurrency: '5' },
      { concurrency: 1.5 },
      { delayMs: -1 },
      { delayMs: 2001 },
      { followRedirects: 'yes' },
      { stopOnConsecutiveErrors: 1 },
    ]
    for (const override of options) {
      expectBadRequest(() => validateFuzzJobInput({ ...validBody, options: override }))
    }
    const normalized = validateFuzzJobInput({
      ...validBody,
      options: {
        concurrency: 10,
        delayMs: 2000,
        followRedirects: true,
        stopOnConsecutiveErrors: true,
      },
    })
    assert.equal(normalized.options.concurrency, 10)
    assert.equal(normalized.options.delayMs, 2000)
    assert.equal(normalized.options.followRedirects, true)
    assert.equal(normalized.options.stopOnConsecutiveErrors, true)
    assert.equal(normalized.expansion.total, 2)
    assert.equal(normalized.payloadBytes, 2)
  })
})

/* ------------------------------------------------------------------------- */
/* Integration: create + poll + results + exports                            */
/* ------------------------------------------------------------------------- */

describe('repeater-fuzz: HTTP job lifecycle', () => {
  it('creates a 3x2 sniper job, polls to completion and serves results/baseline', async () => {
    const res = await createFuzzJob({
      vulnId: VULN_ID,
      request: {
        method: 'GET',
        url: `${upstreamBase}/echo?x=§x§&y=§y§`,
        headers: { 'X-Fuzz': 'yes' },
        body: '',
      },
      attack: { mode: 'sniper', payloadSets: [['a', 'bb', 'ccc']] },
      options: { concurrency: 2, delayMs: 0, followRedirects: false, stopOnConsecutiveErrors: false },
    })
    assert.equal(res.status, 200, res.text)
    const created = res.json
    assert.deepEqual(Object.keys(created).sort(), ['baseline', 'jobId', 'mode', 'status', 'total'])
    assert.equal(created.mode, 'sniper')
    assert.equal(created.total, 6)
    assert.equal(created.status, 'running')
    assert.equal(created.baseline, null)
    assert.match(created.jobId, /^[0-9a-f-]{36}$/i)
    firstCompletedJobId = created.jobId

    const done = await waitForJob(created.jobId, (state) => state.job.status === 'completed')
    assert.equal(done.job.status, 'completed')
    assert.equal(done.job.total, 6)
    assert.equal(done.job.completed, 6)
    assert.equal(done.job.failed, 0)
    assert.equal(done.job.stoppedReason, null)
    assert.equal(done.job.positions, 2)
    assert.equal(done.job.target.origin, upstreamBase)
    assert.equal(done.job.target.method, 'GET')
    assert.equal(done.count, 6)
    assert.equal(done.results.length, 6)
    assert.equal(typeof done.job.createdAt, 'string')
    assert.equal(typeof done.job.startedAt, 'string')
    assert.equal(typeof done.job.finishedAt, 'string')

    // Baseline was sent automatically, before the cases. The base text inside
    // the § markers (x / y) is the original request value.
    assert.equal(done.job.baseline.status, 200)
    assert.equal(done.job.baseline.length, 'hit:x:y'.length)
    assert.equal(done.job.baseline.error, null)

    // Sniper 3 payloads x 2 positions: pos0 cases then pos1 cases.
    const byIndex = new Map(done.results.map((row) => [row.index, row]))
    for (let index = 0; index < 3; index += 1) {
      assert.equal(byIndex.get(index).status, 200)
      assert.equal(byIndex.get(index).error, null)
      assert.equal(byIndex.get(index).errorCode, null)
      assert.equal(byIndex.get(index).truncated, false)
      assert.match(byIndex.get(index).payloadBrief, new RegExp(`^pos1=`))
    }
    assert.equal(byIndex.get(0).length, 'hit:a:y'.length)
    assert.equal(byIndex.get(1).length, 'hit:bb:y'.length)
    assert.equal(byIndex.get(2).length, 'hit:ccc:y'.length)
    assert.equal(byIndex.get(3).length, 'hit:x:a'.length)
    assert.equal(byIndex.get(4).length, 'hit:x:bb'.length)
    assert.equal(byIndex.get(5).length, 'hit:x:ccc'.length)
    assert.match(byIndex.get(0).contentType, /^text\/plain/)

    // Pagination is index-ordered.
    const page = expectOk(await getFuzzJob(created.jobId, '?offset=2&limit=2'))
    assert.deepEqual(
      page.results.map((row) => row.index),
      [2, 3],
    )
    assert.equal(page.offset, 2)
    assert.equal(page.limit, 2)
    assert.equal(page.count, 6)

    // Full result detail.
    const detail = expectOk(await getFuzzJob(created.jobId, '/results/0'))
    assert.equal(detail.result.index, 0)
    assert.equal(detail.result.request.url, `${upstreamBase}/echo?x=a&y=y`)
    assert.equal(detail.result.request.headers['X-Fuzz'], 'yes')
    assert.equal(detail.result.response.status, 200)
    assert.equal(detail.result.response.body, 'hit:a:y')
    assert.equal(detail.result.response.bodyBytes, 'hit:a:y'.length)
    assert.equal(detail.result.response.truncated, false)
    assert.equal(detail.result.error, null)
    assert.deepEqual(detail.result.payloads, ['a', 'y'])

    const baseline = expectOk(await getFuzzJob(created.jobId, '/results/baseline'))
    assert.equal(baseline.result.index, 'baseline')
    assert.equal(baseline.result.response.status, 200)
    assert.equal(baseline.result.response.body, 'hit:x:y')

    // Out-of-range and unknown ids are 404.
    expectError(await getFuzzJob(created.jobId, '/results/6'), 404, 'NOT_FOUND')
    expectError(await getFuzzJob(randomUUID()), 404, 'NOT_FOUND')
  })

  it('reports the real upstream length while capping the stored body', async () => {
    const created = expectOk(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: {
          method: 'GET',
          url: `${upstreamBase}/big?x=§x§`,
          headers: {},
          body: '',
        },
        attack: { mode: 'battering_ram', payloadSets: [['1']] },
        options: { concurrency: 1 },
      }),
    )
    const done = await waitForJob(created.jobId, (state) => state.job.status === 'completed')
    const expectedBytes = 300 * 1024
    assert.equal(done.job.baseline.length, expectedBytes)
    assert.equal(done.job.baseline.truncated, true)
    assert.equal(done.results[0].length, expectedBytes)
    assert.equal(done.results[0].truncated, true)

    const detail = expectOk(await getFuzzJob(created.jobId, '/results/0'))
    assert.equal(detail.result.response.bodyBytes, expectedBytes)
    assert.equal(Buffer.byteLength(detail.result.response.body, 'utf8'), 256 * 1024)
    assert.equal(detail.result.response.truncated, true)
  })

  it('records an allowlist-breaking case as that row error while others succeed', async () => {
    const created = expectOk(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: {
          method: 'GET',
          url: `${upstreamBase}/redirect?to=§to§`,
          headers: {},
          body: '',
        },
        attack: { mode: 'battering_ram', payloadSets: [['safe', 'evil']] },
        options: { concurrency: 1, followRedirects: true },
      }),
    )
    assert.equal(created.total, 2)
    const done = await waitForJob(created.jobId, (state) => state.job.status === 'completed')
    assert.equal(done.job.completed, 1)
    assert.equal(done.job.failed, 1)
    assert.equal(done.count, 2)

    const byIndex = new Map(done.results.map((row) => [row.index, row]))
    assert.equal(byIndex.get(0).status, 200)
    assert.equal(byIndex.get(0).error, null)
    assert.equal(byIndex.get(1).status, null)
    assert.equal(byIndex.get(1).errorCode, 'ORIGIN_NOT_ALLOWED')
    assert.ok(byIndex.get(1).error && byIndex.get(1).error.length > 0)

    const detail = expectOk(await getFuzzJob(created.jobId, '/results/1'))
    assert.equal(detail.result.response, null)
    assert.equal(detail.result.errorCode, 'ORIGIN_NOT_ALLOWED')
    assert.match(detail.result.request.url, /to=evil$/)
  })

  it('cancels a running job, stops scheduling and keeps produced results', async () => {
    const payloads = Array.from({ length: 20 }, (_value, index) => String(index + 1))
    const created = expectOk(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: {
          method: 'GET',
          url: `${upstreamBase}/slow?i=§i§`,
          headers: {},
          body: '',
        },
        attack: { mode: 'sniper', payloadSets: [payloads] },
        options: { concurrency: 2 },
      }),
    )
    assert.equal(created.total, 20)

    const running = await waitForJob(created.jobId, (state) => state.job.status === 'running' && state.count >= 1)
    assert.ok(running.count < 20)

    const cancelPath = `${FUZZ_PATH}/${created.jobId}/cancel`
    const cancelled = expectOk(await server.request(cancelPath, { method: 'POST', body: {} }))
    assert.deepEqual(Object.keys(cancelled).sort(), ['jobId', 'status'])
    assert.equal(cancelled.status, 'cancelled')

    // Let in-flight requests finish; they must still be recorded.
    await sleep(500)
    const done = await waitForJob(created.jobId, (state) => state.job.status === 'cancelled')
    assert.equal(done.job.status, 'cancelled')
    assert.equal(done.job.stoppedReason, 'cancelled')
    assert.equal(done.job.total, 20)
    assert.ok(done.count >= 1)
    assert.ok(done.count < 20, `expected < 20 produced results, got ${done.count}`)
    assert.equal(done.results.length, done.count)
    assert.equal(done.job.completed + done.job.failed, done.count)

    // Idempotent: already cancelled jobs keep their status.
    const again = expectOk(await server.request(cancelPath, { method: 'POST', body: {} }))
    assert.equal(again.status, 'cancelled')
  })

  it('stops after 5 consecutive network errors when enabled', async () => {
    const created = expectOk(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: {
          method: 'GET',
          url: `${upstreamBase}/destroy?i=§i§`,
          headers: {},
          body: '',
        },
        attack: { mode: 'sniper', payloadSets: [['1', '2', '3', '4', '5']] },
        options: { concurrency: 1, stopOnConsecutiveErrors: true },
      }),
    )
    assert.equal(created.total, 5)
    const done = await waitForJob(created.jobId, (state) => state.job.status !== 'running')
    assert.equal(done.job.status, 'cancelled')
    assert.equal(done.job.stoppedReason, 'network_errors')
    assert.equal(done.count, 5)
    assert.equal(done.job.failed, 5)
    for (const row of done.results) {
      assert.equal(row.status, null)
      assert.ok(['UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT'].includes(row.errorCode))
    }
  })

  it('exports CSV and JSON files with the contract header and counts', async () => {
    const created = expectOk(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: {
          method: 'GET',
          url: `${upstreamBase}/echo?x=§x§`,
          headers: {},
          body: '',
        },
        attack: { mode: 'sniper', payloadSets: [['a', 'bb', 'ccc']] },
        options: { concurrency: 3 },
      }),
    )
    await waitForJob(created.jobId, (state) => state.job.status === 'completed')

    const csv = expectOk(
      await server.request(`${FUZZ_PATH}/${created.jobId}/export?format=csv`),
    )
    assert.deepEqual(Object.keys(csv).sort(), ['count', 'format', 'savedPaths'])
    assert.equal(csv.format, 'csv')
    assert.equal(csv.count, 3)
    assert.equal(csv.savedPaths.length, 1)
    assert.equal(existsSync(csv.savedPaths[0]), true)
    assert.ok(csv.savedPaths[0].startsWith(join(REPEATER_ROOT, 'exports')))
    const csvLines = readFileSync(csv.savedPaths[0], 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    assert.equal(csvLines.length, 4)
    assert.equal(csvLines[0], 'index,payload,status,length,duration_ms,error')
    assert.equal(csvLines[1].split(',')[0], '0')
    assert.equal(csvLines[2].split(',')[0], '1')
    assert.equal(csvLines[3].split(',')[0], '2')

    const json = expectOk(
      await server.request(`${FUZZ_PATH}/${created.jobId}/export?format=json`),
    )
    assert.equal(json.format, 'json')
    assert.equal(json.count, 3)
    assert.equal(existsSync(json.savedPaths[0]), true)
    const exported = JSON.parse(readFileSync(json.savedPaths[0], 'utf8'))
    assert.equal(exported.job.jobId, created.jobId)
    assert.equal(exported.job.status, 'completed')
    assert.equal(exported.results.length, 3)
    assert.deepEqual(
      exported.results.map((row) => row.index),
      [0, 1, 2],
    )

    expectError(
      await server.request(`${FUZZ_PATH}/${created.jobId}/export?format=xml`),
      400,
      'BAD_REQUEST',
    )
    expectError(await server.request(`${FUZZ_PATH}/${created.jobId}/export`), 400, 'BAD_REQUEST')
    expectError(
      await server.request(`${FUZZ_PATH}/${randomUUID()}/export?format=csv`),
      404,
      'NOT_FOUND',
    )
  })
})

/* ------------------------------------------------------------------------- */
/* Integration: disk layout, list, restart recovery                          */
/* ------------------------------------------------------------------------- */

describe('repeater-fuzz: persistence and restart recovery', () => {
  it('persists meta/results/baseline and lists the job newest first', async () => {
    const created = expectOk(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: {
          method: 'GET',
          url: `${upstreamBase}/echo?x=§x§`,
          headers: {},
          body: '',
        },
        attack: { mode: 'battering_ram', payloadSets: [['one', 'two']] },
        options: { concurrency: 1 },
      }),
    )
    await waitForJob(created.jobId, (state) => state.job.status === 'completed')

    const jobDir = join(REPEATER_ROOT, 'fuzz', created.jobId)
    const meta = JSON.parse(readFileSync(join(jobDir, 'meta.json'), 'utf8'))
    assert.equal(meta.jobId, created.jobId)
    assert.equal(meta.status, 'completed')
    assert.equal(meta.completed, 2)
    assert.equal(meta.failed, 0)
    assert.equal(meta.template.url, `${upstreamBase}/echo?x=§x§`)
    assert.equal(meta.positions, 1)
    assert.equal(meta.payloadBytes, 'one'.length + 'two'.length)
    const resultLines = readFileSync(join(jobDir, 'results.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    assert.equal(resultLines.length, 2)
    assert.equal(existsSync(join(jobDir, 'baseline.json')), true)

    const list = expectOk(await server.request(`${FUZZ_PATH}?limit=20`))
    assert.ok(Array.isArray(list.jobs))
    const listed = list.jobs.find((job) => job.jobId === created.jobId)
    assert.ok(listed, 'completed job should be listed')
    assert.deepEqual(Object.keys(listed).sort(), [
      'completed',
      'createdAt',
      'failed',
      'finishedAt',
      'jobId',
      'mode',
      'status',
      'stoppedReason',
      'targetUrl',
      'total',
      'vulnId',
    ])
    assert.equal(listed.status, 'completed')
    assert.equal(listed.targetUrl, `${upstreamBase}/echo?x=§x§`)
    for (let index = 1; index < list.jobs.length; index += 1) {
      assert.ok(
        String(list.jobs[index - 1].createdAt) >= String(list.jobs[index].createdAt),
        'jobs must be newest first',
      )
    }
  })

  it('marks a stale on-disk running job as interrupted from a fresh host', async () => {
    const staleJobId = randomUUID()
    const staleDir = join(REPEATER_ROOT, 'fuzz', staleJobId)
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(
      join(staleDir, 'meta.json'),
      JSON.stringify({
        jobId: staleJobId,
        vulnId: VULN_ID,
        mode: 'sniper',
        status: 'running',
        total: 2,
        completed: 1,
        failed: 0,
        concurrency: 1,
        delayMs: 0,
        followRedirects: false,
        stopOnConsecutiveErrors: false,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        finishedAt: null,
        stoppedReason: null,
        target: { method: 'GET', url: `${upstreamBase}/echo`, origin: upstreamBase },
        baseline: null,
        positions: 1,
        payloadBytes: 0,
      }),
      'utf8',
    )

    const staleRow = (index) =>
      JSON.stringify({
        index,
        payloadBrief: `pos1=${index}`,
        payloads: [String(index)],
        request: { method: 'GET', url: `${upstreamBase}/echo`, headers: {}, body: '' },
        response: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: 'ok',
          bodyBytes: 2,
          truncated: false,
          durationMs: 1,
          contentType: 'text/plain',
        },
        error: null,
        errorCode: null,
      })
    writeFileSync(
      join(staleDir, 'results.jsonl'),
      `${staleRow(0)}\n${staleRow(1)}\n`,
      'utf8',
    )

    const fresh = await startTestHost({ dbPath: fixture.dbPath })
    try {
      const res = await fresh.request(`${FUZZ_PATH}/${staleJobId}`)
      const body = expectOk(res)
      assert.equal(body.job.status, 'interrupted')
      assert.equal(body.job.stoppedReason, 'host_restart')
      assert.equal(typeof body.job.finishedAt, 'string')
      // The durable JSONL rows win over the stale persisted meta counters.
      assert.equal(body.job.completed, 1)
      assert.equal(body.count, 2)
      assert.deepEqual(
        body.results.map((row) => row.index),
        [0, 1],
      )
      const persisted = JSON.parse(readFileSync(join(staleDir, 'meta.json'), 'utf8'))
      assert.equal(persisted.status, 'interrupted')
      assert.equal(persisted.stoppedReason, 'host_restart')
      assert.equal(typeof persisted.finishedAt, 'string')
    } finally {
      await fresh.close()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* Integration: single-send history                                          */
/* ------------------------------------------------------------------------- */

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

    expectError(
      await server.request('/cortex-api/cortex/repeater/history?limit=0'),
      400,
      'BAD_REQUEST',
    )
    expectError(
      await server.request('/cortex-api/cortex/repeater/history?limit=51'),
      400,
      'BAD_REQUEST',
    )
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

/* ------------------------------------------------------------------------- */
/* Integration: collections                                                  */
/* ------------------------------------------------------------------------- */

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

/* ------------------------------------------------------------------------- */
/* Integration: strict validation / guards                                   */
/* ------------------------------------------------------------------------- */

describe('repeater-fuzz: validation and guards', () => {
  it('rejects invalid create bodies and query values', async () => {
    const baseRequest = {
      method: 'GET',
      url: `${upstreamBase}/echo?x=§x§`,
      headers: {},
      body: '',
    }
    expectError(
      await createFuzzJob({
        vulnId: 'VULN-DOES-NOT-EXIST',
        request: baseRequest,
        attack: { mode: 'sniper', payloadSets: [['1']] },
      }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: { ...baseRequest, url: `${upstreamBase}/echo` },
        attack: { mode: 'sniper', payloadSets: [['1']] },
      }),
      400,
      'BAD_REQUEST',
    )
    expectError(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: baseRequest,
        attack: { mode: 'sniper', payloadSets: [['1']] },
        options: { concurrency: 11 },
      }),
      400,
      'BAD_REQUEST',
    )

    const tooMany = expectError(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: baseRequest,
        attack: {
          mode: 'sniper',
          payloadSets: [Array.from({ length: 2001 }, (_value, index) => String(index % 10))],
        },
      }),
      400,
      'BAD_REQUEST',
    )
    assert.equal(tooMany.details.maxCases, 2000)

    const tooLarge = expectError(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: baseRequest,
        attack: { mode: 'sniper', payloadSets: [['a'.repeat(2 * 1024 * 1024 + 1)]] },
      }),
      400,
      'BAD_REQUEST',
    )
    assert.equal(tooLarge.details.maxBytes, 2 * 1024 * 1024)

    const bodyTooLarge = expectError(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: baseRequest,
        attack: { mode: 'sniper', payloadSets: [['a'.repeat(8 * 1024 * 1024 + 600 * 1024)]] },
      }),
      400,
      'BAD_REQUEST',
    )
    assert.equal(bodyTooLarge.details.maxBytes, 8 * 1024 * 1024)

    expectError(
      await getFuzzJob(firstCompletedJobId, '?limit=0'),
      400,
      'BAD_REQUEST',
    )
    expectError(
      await getFuzzJob(firstCompletedJobId, '?limit=1001'),
      400,
      'BAD_REQUEST',
    )
    expectError(
      await getFuzzJob(firstCompletedJobId, '?offset=-1'),
      400,
      'BAD_REQUEST',
    )
    expectError(await getFuzzJob('not-a-job-id'), 404, 'NOT_FOUND')
    expectError(
      await getFuzzJob(firstCompletedJobId, '/results/not-a-number'),
      404,
      'NOT_FOUND',
    )
    expectError(
      await server.request(`${FUZZ_PATH}/${randomUUID()}`, { method: 'DELETE' }),
      405,
      'METHOD_NOT_ALLOWED',
    )
  })

  it('accepts a fully escaped 2 MiB payload list under the 8 MiB request cap', async () => {
    // Quotes/backslashes double when JSON-encoded: 2 MiB of payloads becomes a
    // ~4 MiB request body and must not be mistaken for an oversized body.
    const escapedPayload = '"\\'.repeat(1024 * 1024)
    assert.equal(Buffer.byteLength(escapedPayload, 'utf8'), 2 * 1024 * 1024)
    const created = expectOk(
      await createFuzzJob({
        vulnId: VULN_ID,
        request: {
          method: 'POST',
          url: `${upstreamBase}/echo`,
          headers: { 'Content-Type': 'text/plain' },
          body: 'x=§§',
        },
        attack: { mode: 'sniper', payloadSets: [[escapedPayload]] },
        options: { concurrency: 1 },
      }),
    )
    assert.equal(created.total, 1)
    // The expanded body exceeds the per-case 256 KiB rule, so the row is a
    // per-case error; creating the job itself must succeed.
    const done = await waitForJob(created.jobId, (state) => state.job.status !== 'running')
    assert.equal(done.count, 1)
    assert.equal(done.job.failed, 1)
    assert.equal(done.results[0].errorCode, 'BAD_REQUEST')
  })

  it('requires a JSON body for cancel', async () => {
    expectError(
      await server.request(`${FUZZ_PATH}/${firstCompletedJobId}/cancel`, { method: 'POST' }),
      403,
      'FORBIDDEN_CONTENT_TYPE',
    )
    expectError(
      await server.request(`${FUZZ_PATH}/${firstCompletedJobId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
      400,
      'BAD_REQUEST',
    )
  })

  it('honours config.allowNetwork=false for job creation', async () => {
    const restricted = await startTestHost({ dbPath: fixture.dbPath, allowNetwork: false })
    try {
      const res = await restricted.request(FUZZ_PATH, {
        method: 'POST',
        body: {
          vulnId: VULN_ID,
          request: { method: 'GET', url: `${upstreamBase}/echo?x=§x§`, headers: {}, body: '' },
          attack: { mode: 'sniper', payloadSets: [['1']] },
        },
      })
      const body = expectError(res, 403, 'FORBIDDEN')
      assert.equal(typeof body.error, 'string')
    } finally {
      await restricted.close()
    }
  })

  it('serves db:false routes without a database and blocks create with 409', async () => {
    const missingDir = mkdtempSync(join(tmpdir(), 'dsh-cortex-nodb-'))
    const missingDb = join(missingDir, 'missing.db')
    const noDb = await startTestHost({ dbPath: missingDb })
    try {
      const history = expectOk(await noDb.request('/cortex-api/cortex/repeater/history'))
      assert.ok(Array.isArray(history.items))
      const jobs = expectOk(await noDb.request(FUZZ_PATH))
      assert.ok(Array.isArray(jobs.jobs))
      const res = await noDb.request(FUZZ_PATH, {
        method: 'POST',
        body: {
          vulnId: VULN_ID,
          request: { method: 'GET', url: `${upstreamBase}/echo?x=§x§`, headers: {}, body: '' },
          attack: { mode: 'sniper', payloadSets: [['1']] },
        },
      })
      expectError(res, 409, 'SCHEMA_INCOMPATIBLE')
    } finally {
      await noDb.close()
      cleanupDir(missingDir)
    }
  })
})
