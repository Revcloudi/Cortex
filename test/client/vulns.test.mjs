// Tests for src/client/pages/vulns.js (Cortex vulnerabilities page).
//
// Pages are plain CommonJS modules; the shared helper boots jsdom + react-dom/client
// so the real component (hooks, effects, status writes) can be exercised with a
// mocked `api` prop — no fetch mocking needed.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { renderPage, makeT, cleanupDom, loadPage, apiError, flush } from './helpers.mjs'

const require = createRequire(import.meta.url)
const page = loadPage('vulns')
const shellMessages = require('../../src/client/locales.js')
const pageSource = readFileSync(new URL('../../src/client/pages/vulns.js', import.meta.url), 'utf8')

const en = makeT(Object.assign({}, shellMessages.en, page.messages.en))
const zh = makeT(Object.assign({}, shellMessages.zh, page.messages.zh))

afterEach(() => {
  cleanupDom()
})

// ---------------------------------------------------------------- fixtures

const A_ID = 'VULN-20261106-001'
const B_ID = 'VULN-20261106-002'

const summaryA = {
  id: A_ID,
  host: '10.0.0.5:8080',
  vulnName: 'Union SQL Injection',
  vulnType: 'SQLi',
  severity: 'High',
  status: 'Confirmed',
  realm: 'web',
  serviceHost: null,
  targetUrl: 'https://10.0.0.5:8080/api/login',
  entryPoint: '/api/login',
  createdAt: '2026-11-06T10:00:00.000Z',
  retestCount: 2,
  latestRetestAt: '2026-11-06T12:00:00.000Z',
}

const summaryB = {
  id: B_ID,
  host: '10.0.0.5:8080',
  vulnName: 'Stored XSS',
  vulnType: 'XSS',
  severity: 'Medium',
  status: 'Inconclusive',
  realm: 'internal',
  serviceHost: '10.1.0.9:6379',
  targetUrl: 'http://10.1.0.9:6379/profile',
  entryPoint: '/profile',
  createdAt: '2026-11-05T09:00:00.000Z',
  retestCount: 0,
  latestRetestAt: null,
}

const detailA = Object.assign({}, summaryA, {
  description: 'Union-based SQL injection in the login endpoint.',
  impact: 'An attacker can read the whole database.',
  affectedInterfaces: ['POST /api/login'],
  reproductionSteps:
    '### Step 1\n\n```http\nPOST /api/login HTTP/1.1\nHost: 10.0.0.5:8080\nContent-Type: application/json\n\n{"username":"x"}\n```',
  remediation: ['Use parameterized queries', 'Add a WAF rule'],
  cryptoDetails: 'Password hashes use bcrypt cost 10.',
  testBoundaries: 'Not tested: time-based blind injection.',
  retestResults: [{ timeRange: '2026-11-06 12:00', conclusion: 'Still reproducible after the fix.' }],
  relatedVulnIds: [B_ID],
  internalServiceId: null,
})

const detailB = Object.assign({}, summaryB, {
  description: 'Stored XSS in the profile page.',
  impact: 'Session theft via injected script.',
  affectedInterfaces: ['GET /profile'],
  reproductionSteps: '1. Save the payload in the profile field.',
  remediation: ['Escape all user-controlled output'],
  cryptoDetails: '',
  testBoundaries: '',
  retestResults: [],
  relatedVulnIds: [A_ID],
  internalServiceId: 'IS-0001',
})

// ---------------------------------------------------------------- mocked api

function createMockApi(options) {
  const opts = options || {}
  const calls = []
  const details = { [A_ID]: Object.assign({}, detailA), [B_ID]: Object.assign({}, detailB) }
  let listErrorUsed = false

  function listResponse(query) {
    const pageSize = Number(query && query.pageSize) || 20
    const page = Number(query && query.page) || 1
    const total = 45
    return {
      items: [summaryA, summaryB],
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      filters: {
        severities: ['Critical', 'High', 'Medium', 'Low', 'Info'],
        statuses: ['Confirmed', 'Inconclusive', 'Retest_Passed'],
        realms: ['web', 'internal'],
      },
    }
  }

  return {
    calls,
    details,
    get(path, query) {
      calls.push({ method: 'GET', path, query })
      if (path === '/vulns') {
        if (opts.listError) return Promise.reject(opts.listError)
        if (opts.listErrorOnce && !listErrorUsed) {
          listErrorUsed = true
          return Promise.reject(opts.listErrorOnce)
        }
        if (opts.listEmpty) {
          return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20, pages: 0, filters: null })
        }
        return Promise.resolve(listResponse(query))
      }
      const match = /^\/vulns\/([^/]+)$/.exec(path)
      if (match) {
        if (opts.detailError) return Promise.reject(opts.detailError)
        const id = decodeURIComponent(match[1])
        const vuln = details[id]
        if (!vuln) return Promise.reject(apiError('NOT_FOUND', 'vulnerability not found'))
        return Promise.resolve({
          vuln: Object.assign({}, vuln),
          related: id === A_ID ? [summaryB] : [summaryA],
        })
      }
      return Promise.reject(new Error(`unexpected GET ${path}`))
    },
    patch(path, body) {
      calls.push({ method: 'PATCH', path, body })
      const match = /^\/vulns\/([^/]+)\/status$/.exec(path)
      if (!match) return Promise.reject(new Error(`unexpected PATCH ${path}`))
      if (opts.patchError) return Promise.reject(opts.patchError)
      const id = decodeURIComponent(match[1])
      if (details[id]) details[id].status = body.status
      return Promise.resolve({ success: true, id, status: body.status })
    },
    post() {
      return Promise.reject(new Error('post is not used by the vulnerabilities page'))
    },
    getText() {
      return Promise.reject(new Error('getText is not used by the vulnerabilities page'))
    },
    abortAll() {},
  }
}

// ---------------------------------------------------------------- render props

function makeProps(overrides) {
  const opts = overrides || {}
  const toasts = []
  const navCalls = []
  const nav = opts.nav || {
    tab: 'vulns',
    params: opts.params || {},
    go: (tab, params) => navCalls.push({ tab, params }),
  }
  const props = {
    api: opts.api,
    t: opts.t || en,
    locale: opts.locale || 'en',
    nav,
    app: Object.assign({ health: {}, version: '0.1.0', readOnly: !!opts.readOnly }, opts.app || {}),
    rev: opts.rev || 0,
    toast: opts.toast || ((text, tone) => toasts.push({ text, tone })),
  }
  props.__toasts = toasts
  props.__navCalls = navCalls
  return props
}

// ---------------------------------------------------------------- DOM helpers

function byAria(nodes, label) {
  return Array.prototype.slice.call(nodes).find((node) => node.getAttribute('aria-label') === label) || null
}

function byText(nodes, text) {
  return (
    Array.prototype.slice
      .call(nodes)
      .find((node) => (node.textContent || '').trim().indexOf(text) >= 0) || null
  )
}

function button(view, label) {
  return byText(view.queryAll('button'), label)
}

function rows(view) {
  return view.queryAll('tbody tr[data-clickable="true"]')
}

function setNativeValue(element, value) {
  const window = element.ownerDocument.defaultView
  const proto = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  descriptor.set.call(element, value)
}

async function click(view, element) {
  assert.ok(element, 'expected a clickable element')
  const window = view.container.ownerDocument.defaultView
  await view.act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  })
  await flush()
}

async function changeSelect(view, select, value) {
  assert.ok(select, 'expected a select element')
  const window = select.ownerDocument.defaultView
  await view.act(async () => {
    setNativeValue(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await flush()
}

async function typeInto(view, input, value) {
  assert.ok(input, 'expected an input element')
  const window = input.ownerDocument.defaultView
  await view.act(async () => {
    setNativeValue(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await flush()
}

async function waitForDebounce(view) {
  await view.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 380))
  })
  await flush()
}

function callsFor(api, method, path) {
  return api.calls.filter((call) => call.method === method && (path === undefined || call.path === path))
}

function lastCall(api, method, path) {
  const matches = callsFor(api, method, path)
  return matches.length ? matches[matches.length - 1] : null
}

async function renderVulns(overrides) {
  const props = makeProps(overrides)
  const view = await renderPage(page.Component, props)
  return { view, props }
}

// ---------------------------------------------------------------- tests

test('module contract: id, bilingual messages and Component', () => {
  assert.deepEqual(Object.keys(page).sort(), ['Component', 'id', 'messages'])
  assert.equal(page.id, 'vulns')
  assert.equal(typeof page.Component, 'function')
  const zhKeys = Object.keys(page.messages.zh).sort()
  const enKeys = Object.keys(page.messages.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh/en dictionaries must expose the same keys')
  assert.ok(zhKeys.length >= 50, `expected a complete dictionary, got ${zhKeys.length} keys`)
})

test('source only uses kit classes / no DSH imports / no literal colors', () => {
  assert.ok(!/dangerouslySetInnerHTML/.test(pageSource), 'no raw HTML injection')
  assert.ok(!/@deepseek-ai|dsh-client/.test(pageSource), 'no DSH client imports')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(pageSource), 'no literal hex colors')
  assert.ok(!/\bfrom\s+['"]/.test(pageSource), 'CommonJS only')
})

test('list: GET /vulns renders columns, rows, retest count and pager', async () => {
  const api = createMockApi()
  const { view } = await renderVulns({ api })
  try {
    const firstCall = api.calls[0]
    assert.deepEqual(firstCall, { method: 'GET', path: '/vulns', query: { page: 1, pageSize: 20 } })

    const text = view.text()
    for (const key of [
      'list.col.id',
      'list.col.name',
      'list.col.host',
      'list.col.severity',
      'list.col.status',
      'list.col.realm',
      'list.col.created',
    ]) {
      assert.ok(text.indexOf(en(key)) >= 0, `missing column header ${key}`)
    }
    assert.ok(text.indexOf(A_ID) >= 0)
    assert.ok(text.indexOf(B_ID) >= 0)
    assert.ok(text.indexOf(summaryA.vulnName) >= 0)
    assert.ok(text.indexOf(summaryB.vulnName) >= 0)
    assert.ok(text.indexOf('10.0.0.5:8080') >= 0)
    assert.ok(text.indexOf(en('severity.High')) >= 0)
    assert.ok(text.indexOf(en('status.Confirmed')) >= 0)
    assert.ok(text.indexOf(en('realm.internal')) >= 0)
    assert.ok(text.indexOf(en('list.retestCount', { count: 2 })) >= 0, 'retest count shown in the list')
    assert.ok(view.query('.dshc-pager'), 'pager rendered')
    assert.ok(text.indexOf(en('common.total', { total: 45 })) >= 0)
    assert.equal(rows(view).length, 2)
    // no selection yet -> detail pane shows its empty state
    assert.ok(text.indexOf(en('detail.noSelection')) >= 0)
  } finally {
    await view.unmount()
  }
})

test('filters: select changes hit GET /vulns and always reset to page 1', async () => {
  const api = createMockApi()
  const { view } = await renderVulns({ api })
  try {
    // move to page 2 first
    await click(view, button(view, en('common.next')))
    assert.deepEqual(lastCall(api, 'GET', '/vulns').query, { page: 2, pageSize: 20 })

    // severity filter -> page restart
    const severity = byAria(view.queryAll('select'), en('filters.severityAria'))
    await changeSelect(view, severity, 'High')
    assert.deepEqual(lastCall(api, 'GET', '/vulns').query, { page: 1, pageSize: 20, severity: 'High' })

    // status filter
    const status = byAria(view.queryAll('select'), en('filters.statusAria'))
    await changeSelect(view, status, 'Inconclusive')
    assert.deepEqual(lastCall(api, 'GET', '/vulns').query, {
      page: 1,
      pageSize: 20,
      severity: 'High',
      status: 'Inconclusive',
    })

    // realm filter
    const realm = byAria(view.queryAll('select'), en('filters.realmAria'))
    await changeSelect(view, realm, 'internal')
    assert.deepEqual(lastCall(api, 'GET', '/vulns').query, {
      page: 1,
      pageSize: 20,
      severity: 'High',
      status: 'Inconclusive',
      realm: 'internal',
    })

    // page size select (owned by the shared Pager) also restarts at page 1
    const pageSize = byAria(view.queryAll('select'), 'Page size')
    assert.ok(pageSize, 'pager page-size select exists')
    await changeSelect(view, pageSize, '50')
    assert.deepEqual(lastCall(api, 'GET', '/vulns').query, {
      page: 1,
      pageSize: 50,
      severity: 'High',
      status: 'Inconclusive',
      realm: 'internal',
    })

    // reset clears every filter and the page size
    await click(view, button(view, en('filters.reset')))
    assert.deepEqual(lastCall(api, 'GET', '/vulns').query, { page: 1, pageSize: 20 })
    assert.equal(byAria(view.queryAll('select'), en('filters.severityAria')).value, '')

    // the toolbar refresh button re-issues the list request
    const beforeRefresh = callsFor(api, 'GET', '/vulns').length
    await click(view, button(view, en('common.refresh')))
    assert.ok(callsFor(api, 'GET', '/vulns').length > beforeRefresh, 'refresh triggers a reload')
  } finally {
    await view.unmount()
  }
})

test('search: debounced input becomes a GET /vulns search query', async () => {
  const api = createMockApi()
  const { view } = await renderVulns({ api })
  try {
    const input = view.query('input[aria-label="' + en('filters.searchAria') + '"]')
    assert.ok(input, 'search input exists')
    const callsBefore = callsFor(api, 'GET', '/vulns').length
    await typeInto(view, input, 'sqli')
    await waitForDebounce(view)
    const after = lastCall(api, 'GET', '/vulns')
    assert.ok(callsFor(api, 'GET', '/vulns').length > callsBefore, 'a request was issued after the search')
    assert.equal(after.query.search, 'sqli')
    assert.equal(after.query.page, 1)
  } finally {
    await view.unmount()
  }
})

test('states: loading spinner, empty list and error + retry', async () => {
  const emptyApi = createMockApi({ listEmpty: true })
  const emptyView = await renderVulns({ api: emptyApi })
  try {
    assert.ok(emptyView.view.text().indexOf(en('list.empty')) >= 0)
    assert.ok(emptyView.view.query('.dshc-empty'))
  } finally {
    await emptyView.view.unmount()
  }

  const failingApi = createMockApi({ listErrorOnce: apiError('INTERNAL', 'boom') })
  const errorView = await renderVulns({ api: failingApi })
  try {
    assert.ok(errorView.view.query('.dshc-error'), 'ErrorBox rendered for a failed list request')
    assert.ok(errorView.view.text().indexOf(en('common.retry')) >= 0)
    // retry re-issues the request and recovers
    await click(errorView.view, button(errorView.view, en('common.retry')))
    assert.ok(rows(errorView.view).length === 2, 'list recovers after retry')
  } finally {
    await errorView.view.unmount()
  }
})

test('loading: list shows a Spinner while the first request is pending', async () => {
  let resolveList
  const api = createMockApi()
  const originalGet = api.get
  api.get = (path, query) => {
    if (path === '/vulns') {
      api.calls.push({ method: 'GET', path, query })
      return new Promise((resolve) => {
        resolveList = () => resolve({ items: [summaryA], total: 1, page: 1, pageSize: 20, pages: 1, filters: null })
      })
    }
    return originalGet(path, query)
  }
  const { view } = await renderVulns({ api })
  try {
    assert.ok(view.query('.dshc-spinner'), 'spinner while loading')
    resolveList()
    await flush()
    assert.ok(rows(view).length === 1)
  } finally {
    await view.unmount()
  }
})

test('detail: row activation loads GET /vulns/:id and renders every section', async () => {
  const api = createMockApi()
  const { view, props } = await renderVulns({ api })
  try {
    await click(view, rows(view)[0])
    assert.ok(callsFor(api, 'GET', '/vulns/' + A_ID).length === 1, 'detail request issued')
    assert.equal(rows(view)[0].getAttribute('aria-selected'), 'true')

    const text = view.text()
    assert.ok(text.indexOf('Union SQL Injection') >= 0)
    assert.ok(text.indexOf(detailA.description) >= 0, 'description section')
    assert.ok(text.indexOf(detailA.impact) >= 0, 'impact section')
    assert.ok(text.indexOf('POST /api/login HTTP/1.1') >= 0, 'Markdown reproduction code block')
    assert.ok(text.indexOf('Use parameterized queries') >= 0, 'remediation list')
    assert.ok(text.indexOf('Still reproducible after the fix.') >= 0, 'retest history')
    assert.ok(text.indexOf('Not tested: time-based blind injection.') >= 0, 'test boundaries')
    assert.ok(text.indexOf('Password hashes use bcrypt cost 10.') >= 0, 'crypto details')
    assert.ok(text.indexOf(en('detail.field.targetUrl')) >= 0, 'meta KeyValue')
    assert.ok(text.indexOf('https://10.0.0.5:8080/api/login') >= 0)
    // related vulnerability (clickable)
    assert.ok(byAria(view.queryAll('button'), en('detail.openRelated', { id: B_ID })), 'related vulnerability button')

    // Markdown report download anchor
    const reportLink = view.query('a[download]')
    assert.ok(reportLink, 'report download anchor exists')
    assert.equal(reportLink.getAttribute('href'), '/cortex-api/reports/' + A_ID)
    assert.equal(reportLink.getAttribute('download'), A_ID + '.md')

    // "Retest" hands the selected vulnerability to the retest page
    await click(view, button(view, en('detail.retest')))
    assert.deepEqual(props.__navCalls[0], { tab: 'retest', params: { vulnId: A_ID } })

    // clicking a related vulnerability loads it
    await click(view, byAria(view.queryAll('button'), en('detail.openRelated', { id: B_ID })))
    assert.ok(callsFor(api, 'GET', '/vulns/' + B_ID).length === 1)
    assert.ok(view.text().indexOf(detailB.description) >= 0)
  } finally {
    await view.unmount()
  }
})

test('status: Apply PATCHes /vulns/:id/status then refreshes list + detail', async () => {
  const api = createMockApi()
  const { view, props } = await renderVulns({ api })
  try {
    await click(view, rows(view)[0])
    const statusSelect = byAria(view.queryAll('select'), en('detail.statusEditorAria'))
    assert.ok(statusSelect, 'status editor select exists')

    await changeSelect(view, statusSelect, 'Retest_Passed')
    const apply = button(view, en('detail.applyStatus'))
    assert.ok(apply, 'apply button exists')
    assert.equal(apply.disabled, false, 'apply enabled once a different status is chosen')

    await click(view, apply)
    const patchCall = lastCall(api, 'PATCH', '/vulns/' + A_ID + '/status')
    assert.ok(patchCall, 'PATCH issued')
    assert.deepEqual(patchCall.body, { status: 'Retest_Passed' })

    assert.ok(props.__toasts.length >= 1)
    const lastToast = props.__toasts[props.__toasts.length - 1]
    assert.equal(lastToast.tone, 'ok')
    assert.ok(lastToast.text.indexOf(en('status.Retest_Passed')) >= 0)

    // list + detail are refreshed after a successful write
    const patchIndex = api.calls.indexOf(patchCall)
    const after = api.calls.slice(patchIndex + 1)
    assert.ok(after.some((call) => call.method === 'GET' && call.path === '/vulns'), 'list refreshed')
    assert.ok(after.some((call) => call.method === 'GET' && call.path === '/vulns/' + A_ID), 'detail refreshed')
    assert.equal(button(view, en('detail.applyStatus')).disabled, true, 'apply disabled again')
  } finally {
    await view.unmount()
  }
})

test('status: failed PATCH shows an error toast and keeps the editor usable', async () => {
  const api = createMockApi({ patchError: apiError('READ_ONLY', 'read only') })
  const { view, props } = await renderVulns({ api })
  try {
    await click(view, rows(view)[0])
    const statusSelect = byAria(view.queryAll('select'), en('detail.statusEditorAria'))
    await changeSelect(view, statusSelect, 'Inconclusive')
    await click(view, button(view, en('detail.applyStatus')))
    const lastToast = props.__toasts[props.__toasts.length - 1]
    assert.equal(lastToast.tone, 'error')
    assert.ok(lastToast.text.indexOf(en('detail.readOnly')) >= 0)
  } finally {
    await view.unmount()
  }
})

test('read-only: status writes are disabled and explained', async () => {
  const api = createMockApi()
  const { view } = await renderVulns({ api, readOnly: true })
  try {
    await click(view, rows(view)[0])
    const statusSelect = byAria(view.queryAll('select'), en('detail.statusEditorAria'))
    assert.ok(statusSelect, 'status editor still rendered')
    assert.equal(statusSelect.disabled, true, 'status select disabled in read-only mode')
    assert.equal(button(view, en('detail.applyStatus')).disabled, true, 'apply disabled in read-only mode')
    assert.ok(view.text().indexOf(en('detail.readOnly')) >= 0, 'read-only explanation shown')
    // report download and retest hand-off remain available
    assert.ok(view.query('a[download]'))
    assert.ok(button(view, en('detail.retest')))
  } finally {
    await view.unmount()
  }
})

test('selection is remembered when the page remounts (tab revisit)', async () => {
  const firstApi = createMockApi()
  const first = await renderVulns({ api: firstApi })
  try {
    await click(first.view, rows(first.view)[1])
    assert.ok(callsFor(firstApi, 'GET', '/vulns/' + B_ID).length === 1)
  } finally {
    await first.view.unmount()
  }

  const secondApi = createMockApi()
  const second = await renderVulns({ api: secondApi })
  try {
    assert.ok(
      callsFor(secondApi, 'GET', '/vulns/' + B_ID).length === 1,
      'remembered selection is re-opened on remount',
    )
    assert.ok(second.view.text().indexOf(detailB.description) >= 0)
  } finally {
    await second.view.unmount()
  }
})

test('deep link: nav.params.vulnId opens that vulnerability', async () => {
  const api = createMockApi()
  const { view } = await renderVulns({ api, params: { vulnId: A_ID } })
  try {
    assert.ok(callsFor(api, 'GET', '/vulns/' + A_ID).length === 1, 'deep linked detail request')
    assert.ok(view.text().indexOf(detailA.description) >= 0)
  } finally {
    await view.unmount()
  }
})

test('detail error: unknown vulnerability renders an ErrorBox with retry', async () => {
  const api = createMockApi()
  const { view } = await renderVulns({ api, params: { vulnId: 'VULN-DOES-NOT-EXIST' } })
  try {
    assert.ok(callsFor(api, 'GET', '/vulns/VULN-DOES-NOT-EXIST').length === 1)
    assert.ok(view.query('.dshc-error'), 'detail ErrorBox rendered')
    assert.ok(view.text().indexOf(en('error.notFound')) >= 0)
  } finally {
    await view.unmount()
  }
})

test('locales: zh labels render for list, detail and read-only mode', async () => {
  const api = createMockApi()
  const { view } = await renderVulns({ api, t: zh, locale: 'zh', readOnly: true })
  try {
    const text = view.text()
    assert.ok(text.indexOf(zh('list.col.name')) >= 0)
    assert.ok(text.indexOf(zh('severity.High')) >= 0)
    await click(view, rows(view)[0])
    assert.ok(view.text().indexOf(zh('detail.description')) >= 0)
    assert.ok(view.text().indexOf(zh('detail.readOnly')) >= 0)
  } finally {
    await view.unmount()
  }
})
