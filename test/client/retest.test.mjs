// Retest page tests (jsdom + react-dom/client through test/client/helpers.mjs).
//
// Covers the P0 contract: ```http step parsing -> step buttons, POST /retest/send
// body/no-redirect default, 3xx+Location follow button re-send with
// followRedirects:true, raw/HTML iframe toggle (empty sandbox), status PATCH via
// the top status editor, read-only disabling and the explicit no-steps empty state.
import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apiError, cleanupDom, flush, loadPage, makeT, renderPage } from './helpers.mjs'

const page = loadPage('retest')
const dict = page.messages.en
const t = makeT(dict)

const TARGET = 'http://127.0.0.1:8080/'

const STEPS_MARKDOWN = [
  '### Step 1: unauthenticated access',
  '',
  '```http',
  'GET /login HTTP/1.1',
  'Host: 127.0.0.1:8080',
  'Accept: text/html',
  '```',
  '',
  '### Step 2: submit credentials',
  '',
  '```http',
  'POST /api/login HTTP/1.1',
  'Host: 127.0.0.1:8080',
  'Content-Type: application/json',
  '',
  '{"username":"admin","password":"changeme"}',
  '```',
].join('\n')

function makeVuln(overrides) {
  return Object.assign(
    {
      id: 'VULN-1',
      host: '127.0.0.1:8080',
      vulnName: 'Reflected XSS in login',
      vulnType: 'XSS',
      severity: 'High',
      status: 'Confirmed',
      realm: 'web',
      serviceHost: null,
      targetUrl: TARGET,
      entryPoint: '/login',
      createdAt: '2026-11-01T10:00:00.000Z',
      retestCount: 1,
      latestRetestAt: null,
      description: 'description',
      impact: 'impact',
      affectedInterfaces: ['/login'],
      reproductionSteps: STEPS_MARKDOWN,
      remediation: [],
      cryptoDetails: '',
      testBoundaries: '',
      retestResults: [],
      relatedVulnIds: [],
      internalServiceId: null,
    },
    overrides || {},
  )
}

function makeSummary(vuln) {
  return {
    id: vuln.id,
    host: vuln.host,
    vulnName: vuln.vulnName,
    vulnType: vuln.vulnType,
    severity: vuln.severity,
    status: vuln.status,
    realm: vuln.realm,
    serviceHost: vuln.serviceHost,
    targetUrl: vuln.targetUrl,
    entryPoint: vuln.entryPoint,
    createdAt: vuln.createdAt,
    retestCount: vuln.retestCount,
    latestRetestAt: vuln.latestRetestAt,
  }
}

function listPayload(items) {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 50,
    pages: 1,
    filters: { severities: [], statuses: [], realms: ['web'] },
  }
}

function detailPayload(vuln) {
  return { vuln, related: [] }
}

function okResponse(overrides) {
  return Object.assign(
    {
      status: 200,
      statusText: 'OK',
      url: `${TARGET}login`,
      finalUrl: `${TARGET}login`,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<h1>hello</h1>',
      bodyBytes: 14,
      bodyTruncated: false,
      contentType: 'text/html; charset=utf-8',
      durationMs: 12,
      redirects: [],
    },
    overrides || {},
  )
}

const REDIRECT_RESPONSE = {
  status: 302,
  statusText: 'Found',
  url: `${TARGET}login`,
  finalUrl: `${TARGET}login`,
  headers: { location: `${TARGET}home` },
  body: '',
  bodyBytes: 0,
  bodyTruncated: false,
  contentType: '',
  durationMs: 5,
  redirects: [],
}

function mockApi(handlers) {
  const calls = { get: [], post: [], patch: [] }
  return {
    calls,
    api: {
      get: (path, query) => {
        calls.get.push({ path, query })
        return Promise.resolve().then(() => handlers.get(path, query))
      },
      post: (path, body) => {
        calls.post.push({ path, body })
        return Promise.resolve().then(() => handlers.post(path, body))
      },
      patch: (path, body) => {
        calls.patch.push({ path, body })
        return Promise.resolve().then(() => handlers.patch(path, body))
      },
      getText: () => Promise.reject(new Error('unexpected getText call')),
    },
  }
}

function handlersFor(vuln, overrides) {
  const base = {
    get(path) {
      if (path === '/vulns') return listPayload([makeSummary(vuln)])
      if (path === `/vulns/${vuln.id}`) return detailPayload(vuln)
      throw new Error(`unexpected GET ${path}`)
    },
    post() {
      return okResponse()
    },
    patch() {
      return { success: true }
    },
  }
  return Object.assign(base, overrides || {})
}

function makeApp(overrides) {
  return Object.assign(
    {
      health: null,
      refreshHealth() {},
      reloadAll() {},
      version: '0.1.0',
      rev: 0,
      readOnly: false,
      locale: 'en',
    },
    overrides || {},
  )
}

function baseProps(api, extra) {
  return Object.assign(
    {
      api,
      t,
      locale: 'en',
      nav: { tab: 'retest', params: { vulnId: 'VULN-1' }, go() {} },
      app: makeApp(),
      rev: 0,
      toast: () => {},
    },
    extra || {},
  )
}

const activeViews = []

async function open(api, extra) {
  const view = await renderPage(page.Component, baseProps(api, extra))
  activeViews.push(view)
  return view
}

function buttons(view) {
  return Array.from(view.container.querySelectorAll('button'))
}

function buttonText(button) {
  return (button.textContent || '').trim()
}

function findByText(view, text) {
  return buttons(view).find((button) => buttonText(button).includes(text))
}

function stepButtons(view) {
  return buttons(view).filter((button) => /^Step \d/.test(buttonText(button)))
}

afterEach(async () => {
  while (activeViews.length) {
    const view = activeViews.pop()
    try {
      await view.unmount()
    } catch {
      /* ignore teardown errors */
    }
  }
})

after(() => {
  cleanupDom()
})

test('parses every ```http block into a step button and loads web-realm vulnerabilities only', async () => {
  const vuln = makeVuln()
  const { api, calls } = mockApi(handlersFor(vuln))
  const view = await open(api)

  const listCall = calls.get.find((call) => call.path === '/vulns')
  assert.ok(listCall, 'the left panel must call GET /vulns')
  assert.equal(listCall.query.realm, 'web')
  assert.equal(listCall.query.page, 1)
  assert.equal(listCall.query.pageSize, 50)
  assert.ok(
    calls.get.some((call) => call.path === '/vulns/VULN-1'),
    'nav.params.vulnId must load GET /vulns/:id',
  )

  const steps = stepButtons(view)
  assert.equal(steps.length, 2)
  assert.match(buttonText(steps[0]), /^Step 1/)
  assert.match(buttonText(steps[1]), /^Step 2/)
  assert.ok(view.text().includes('Step 1: unauthenticated access'))
  assert.ok(view.text().includes('Step 2: submit credentials'))
})

test('sends POST /retest/send with parsed request and followRedirects=false by default', async () => {
  const vuln = makeVuln()
  const { api, calls } = mockApi(handlersFor(vuln))
  const view = await open(api)

  await view.act(async () => {
    stepButtons(view)[0].click()
  })
  await flush()

  assert.equal(calls.post.length, 1)
  assert.equal(calls.post[0].path, '/retest/send')
  assert.deepEqual(calls.post[0].body, {
    vulnId: 'VULN-1',
    method: 'GET',
    url: `${TARGET}login`,
    headers: { Accept: 'text/html' },
    body: '',
    followRedirects: false,
  })
  assert.ok(view.text().includes('200 OK'))
  assert.ok(view.text().includes('12 ms'))
  assert.ok(view.text().includes('14 B'))

  await view.act(async () => {
    stepButtons(view)[1].click()
  })
  await flush()

  assert.equal(calls.post.length, 2)
  assert.equal(calls.post[1].body.method, 'POST')
  assert.equal(calls.post[1].body.url, `${TARGET}api/login`)
  assert.equal(calls.post[1].body.body, '{"username":"admin","password":"changeme"}')
  assert.deepEqual(calls.post[1].body.headers, { 'Content-Type': 'application/json' })
  assert.equal(calls.post[1].body.followRedirects, false)
})

test('302 + Location shows a follow button that re-sends the same step with followRedirects=true', async () => {
  const vuln = makeVuln()
  let postCount = 0
  const handlers = handlersFor(vuln, {
    post() {
      postCount += 1
      if (postCount === 1) return REDIRECT_RESPONSE
      return okResponse({
        body: 'welcome home',
        url: `${TARGET}login`,
        finalUrl: `${TARGET}home`,
        redirects: [{ url: `${TARGET}login`, status: 302, location: `${TARGET}home` }],
      })
    },
  })
  const { api, calls } = mockApi(handlers)
  const view = await open(api)

  await view.act(async () => {
    stepButtons(view)[0].click()
  })
  await flush()
  assert.ok(view.text().includes('302 Found'))

  const follow = findByText(view, dict['action.followRedirect'])
  assert.ok(follow, 'follow-redirect button must appear for 3xx + Location')

  await view.act(async () => {
    follow.click()
  })
  await flush()

  assert.equal(calls.post.length, 2)
  const first = calls.post[0].body
  const second = calls.post[1].body
  assert.equal(second.followRedirects, true)
  assert.equal(second.vulnId, first.vulnId)
  assert.equal(second.method, first.method)
  assert.equal(second.url, first.url)
  assert.deepEqual(second.headers, first.headers)
  assert.equal(second.body, first.body)
  assert.ok(view.text().includes(`${TARGET}home`))
  assert.ok(view.text().includes(dict['resp.redirects']))
  assert.equal(findByText(view, dict['action.followRedirect']), undefined, 'follow button disappears after the followed response')
})

test('raw/HTML toggle renders the response body in an iframe with an empty sandbox attribute', async () => {
  const vuln = makeVuln()
  const { api } = mockApi(handlersFor(vuln))
  const view = await open(api)

  await view.act(async () => {
    stepButtons(view)[0].click()
  })
  await flush()

  assert.equal(view.query('iframe'), null, 'raw mode must not render an iframe')
  assert.ok(view.text().includes('<h1>hello</h1>'), 'raw mode must render the response body text')

  await view.act(async () => {
    findByText(view, dict['resp.html']).click()
  })
  await flush()

  const iframe = view.query('iframe')
  assert.ok(iframe, 'HTML mode must render an iframe')
  assert.equal(iframe.getAttribute('sandbox'), '')
  assert.equal(iframe.getAttribute('srcdoc'), '<h1>hello</h1>')

  await view.act(async () => {
    findByText(view, dict['resp.raw']).click()
  })
  await flush()
  assert.equal(view.query('iframe'), null, 'switching back to raw removes the iframe')

  const source = readFileSync(new URL('../../src/client/pages/retest.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('dangerouslySetInnerHTML'), 'the page must never use dangerouslySetInnerHTML')
})

test('status editor PATCHes /vulns/:id/status, toasts and reloads the detail', async () => {
  const vuln = makeVuln()
  const toastCalls = []
  const { api, calls } = mockApi(handlersFor(vuln))
  const view = await open(api, { toast: (message, tone) => toastCalls.push({ message, tone }) })

  const select = view.query('select')
  assert.ok(select, 'status editor select must be rendered')
  assert.equal(select.value, 'Confirmed')

  select.value = 'Retest_Passed'
  await view.act(async () => {
    select.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  })
  await flush()

  const apply = findByText(view, dict['action.applyStatus'])
  assert.ok(apply, 'Apply button must be rendered')
  assert.equal(apply.disabled, false)

  await view.act(async () => {
    apply.click()
  })
  await flush()

  assert.equal(calls.patch.length, 1)
  assert.equal(calls.patch[0].path, '/vulns/VULN-1/status')
  assert.deepEqual(calls.patch[0].body, { status: 'Retest_Passed' })
  assert.ok(
    toastCalls.some((entry) => entry.tone === 'ok'),
    'a success toast must be shown',
  )
  assert.equal(
    calls.get.filter((call) => call.path === '/vulns/VULN-1').length,
    2,
    'the detail must be reloaded after the PATCH',
  )
})

test('read-only mode disables the status editor', async () => {
  const vuln = makeVuln()
  const { api } = mockApi(handlersFor(vuln))
  const view = await open(api, { app: makeApp({ readOnly: true }) })

  const apply = findByText(view, dict['action.applyStatus'])
  assert.ok(apply)
  assert.equal(apply.disabled, true)
  assert.equal(view.query('select').disabled, true)
  assert.ok(view.text().includes(dict['status.readOnlyHint']))
})

test('shows an explicit empty state when reproduction_steps has no ```http blocks', async () => {
  const vuln = makeVuln({ reproductionSteps: '### 步骤 1\n没有可解析的 http 请求块。' })
  const { api } = mockApi(handlersFor(vuln))
  const view = await open(api)

  assert.equal(stepButtons(view).length, 0)
  assert.ok(view.text().includes(dict['steps.emptyTitle']))
  assert.ok(view.text().includes('reproduction_steps'))
  assert.ok(view.text().includes('```http'))
})

test('ORIGIN_NOT_ALLOWED error shows the allowed origins from error.details', async () => {
  const vuln = makeVuln()
  const allowed = ['http://127.0.0.1:8080', 'https://example.test']
  const toastCalls = []
  const handlers = handlersFor(vuln, {
    post() {
      throw apiError('ORIGIN_NOT_ALLOWED', 'origin not allowed', { allowed })
    },
  })
  const { api } = mockApi(handlers)
  const view = await open(api, { toast: (message, tone) => toastCalls.push({ message, tone }) })

  await view.act(async () => {
    stepButtons(view)[0].click()
  })
  await flush()

  assert.ok(view.query('[role="alert"]'), 'an ErrorBox alert must be rendered')
  assert.ok(view.text().includes(dict['error.allowedOrigins']))
  assert.ok(view.text().includes('http://127.0.0.1:8080'))
  assert.ok(view.text().includes('https://example.test'))
  assert.ok(
    toastCalls.some((entry) => entry.tone === 'error'),
    'a failure toast must be shown',
  )
})
