// Client page tests for the auxiliary pages (overview / assets / internal / snapshots).
//
// Renders the real CommonJS page modules into jsdom through test/client/helpers.mjs
// (react-dom/client + act, so loading effects actually run), with mocked `api`
// objects that return fixture-shaped DTOs from docs/contracts.md §2.5.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { renderPage, makeT, loadPage, apiError, cleanupDom, flush } from './helpers.mjs'
import shellMessages from '../../src/client/locales.js'

after(() => cleanupDom())

// ---------------------------------------------------------------- fixtures

const ISO = '2026-11-01T08:00:00.000Z'

function vulnSummary(overrides) {
  return Object.assign(
    {
      id: 'VULN-20261104-001',
      host: 'https://a.example.com',
      vulnName: 'SQL injection in login',
      vulnType: 'SQLi',
      severity: 'High',
      status: 'Confirmed',
      realm: 'web',
      serviceHost: '',
      targetUrl: 'https://a.example.com/login',
      entryPoint: '/login',
      createdAt: ISO,
      retestCount: 0,
      latestRetestAt: null,
    },
    overrides,
  )
}

const STATS = {
  counts: { web: 9, internal: 4, total: 13 },
  bySeverity: { Critical: 2, High: 4, Medium: 3, Low: 3, Info: 1 },
  byStatus: { Confirmed: 9, Inconclusive: 3, Retest_Passed: 1 },
  hosts: 7,
  assets: 1,
  projects: ['demo-project'],
  recent: [
    vulnSummary({ id: 'VULN-20261104-001', vulnName: 'SQL injection in login' }),
    vulnSummary({
      id: 'VULN-20261104-002',
      vulnName: 'IDOR on order API',
      realm: 'internal',
      severity: 'Critical',
      status: 'Inconclusive',
      host: '10.0.1.10',
    }),
  ],
}

const HOST_PORT = 'https://a.example.com:8443/login'

const ASSET_SUMMARY = {
  hostPort: HOST_PORT,
  host: 'a.example.com',
  projectName: 'demo-project',
  techStack: 'nginx, Node.js',
  authRequired: true,
  status: 'Alive',
  lastSeen: '2026-11-05T10:00:00.000Z',
  interfaceCount: 1,
  vulnCount: 1,
}

const ASSET_DETAIL = Object.assign({}, ASSET_SUMMARY, {
  interfaces: [
    {
      path: '/api/users',
      method: 'GET',
      params: '?id=1',
      request: 'GET /api/users HTTP/1.1\nHost: a.example.com\n\n',
    },
  ],
  interfaceDir: ['/api/users', '/login'],
  leakedInfos: [
    {
      infoType: 'API_Key',
      value: 'AKIA_TEST_VALUE_123',
      source: 'static/main.js',
      potentialImpact: 'API access with service account',
    },
  ],
  testParameters: [
    {
      name: 'orderId',
      endpoint: '/api/orders',
      location: 'query',
      values: ['1001', '1002'],
      pattern: '^[0-9]{4}$',
      source: 'static/main.js',
      tested: true,
      notes: 'sequential ids',
    },
  ],
  relatedVulnIds: ['VULN-20261104-002'],
})

const ASSETS_LIST = {
  items: [ASSET_SUMMARY],
  total: 1,
  page: 1,
  pageSize: 20,
  pages: 1,
  projects: ['demo-project'],
}

const INTERNAL_PROJECTS = {
  projects: [
    { projectName: 'acme-internal', footholds: 1, hosts: 1, services: 1, credentials: 1, pivots: 1 },
  ],
}

const INTERNAL_OVERVIEW = {
  project: 'acme-internal',
  footholds: [
    {
      id: 'FH-1',
      entryHostPort: 'https://a.example.com/login',
      entryVulnId: 'VULN-20261104-001',
      accessType: 'rce',
      privilegeLevel: 'user',
      status: 'established',
      evidence: 'webshell uploaded',
      notes: 'first foothold',
      establishedAt: ISO,
      lastVerifiedAt: '2026-11-05T10:00:00.000Z',
      hostIds: ['IH-1'],
    },
  ],
  hosts: [
    {
      id: 'IH-1',
      ip: '10.0.1.10',
      hostname: 'app01',
      os: 'linux',
      subnet: '10.0.1.0/24',
      state: 'alive',
      source: 'scan',
      confidence: 'high',
      lastSeen: '2026-11-05T10:00:00.000Z',
    },
  ],
  services: [
    {
      id: 'IS-1',
      hostId: 'IH-1',
      port: 22,
      protocol: 'tcp',
      service: 'ssh',
      banner: 'OpenSSH 9.0',
      state: 'open',
      source: 'scan',
      lastSeen: '2026-11-05T10:00:00.000Z',
    },
  ],
  credentials: [
    {
      id: 'CR-1',
      type: 'password',
      username: 'admin',
      domain: 'ACME',
      source: 'loot',
      hostId: 'IH-1',
      serviceId: 'IS-1',
      confidence: 'high',
      status: 'valid',
      notes: 'found in config',
      secretMasked: 'ab••••z',
      secretLength: 8,
      // A hostile fixture: no Host DTO should expose the raw secret, and the
      // page must never render it even if one appears.
      secret: 'SUPER_SECRET_VALUE',
    },
  ],
  pivots: [
    {
      id: 'PV-1',
      footholdId: 'FH-1',
      kind: 'chain',
      localHost: '127.0.0.1',
      localPort: 1080,
      localProtocol: 'socks5',
      tool: 'chisel',
      status: 'established',
      notes: 'through app01',
      establishedAt: ISO,
      lastVerifiedAt: '2026-11-05T10:00:00.000Z',
      hops: [{ seq: 1, refKind: 'host', refId: 'IH-1', label: 'app01', via: 'SSH' }],
      reachableSubnets: ['10.0.2.0/24'],
    },
  ],
  stats: { footholds: 1, hosts: 1, services: 1, credentials: 1, pivots: 1 },
}

const INTERNAL_GRAPH = {
  nodes: [
    { id: 'FH-1', kind: 'foothold', label: 'FH-1' },
    { id: 'IH-1', kind: 'host', label: 'app01', sub: '10.0.1.10' },
  ],
  edges: [{ from: 'FH-1', to: 'IH-1', kind: 'reaches' }],
}

const SESSION_PARENT = {
  sessionId: 'S-PARENT',
  projectName: 'demo-project',
  currentPhase: 'recon',
  targetHosts: ['https://a.example.com'],
  parentSessionId: null,
  archivedAt: null,
  createdAt: ISO,
  updatedAt: '2026-11-05T09:00:00.000Z',
  nextSteps: 'continue to exploit phase',
  relatedVulnIds: ['VULN-20261104-003'],
  childCount: 1,
}

const SESSION_CHILD = {
  sessionId: 'S-CHILD',
  projectName: 'demo-project',
  currentPhase: 'exploit',
  targetHosts: ['https://a.example.com'],
  parentSessionId: 'S-PARENT',
  archivedAt: null,
  createdAt: ISO,
  updatedAt: '2026-11-05T09:30:00.000Z',
  nextSteps: 'run exploit',
  relatedVulnIds: [],
  childCount: 0,
}

const SESSION_ARCHIVED = {
  sessionId: 'S-ARCHIVED',
  projectName: 'demo-project',
  currentPhase: 'archived-phase',
  targetHosts: ['https://old.example.com'],
  parentSessionId: null,
  archivedAt: '2026-10-01T00:00:00.000Z',
  createdAt: ISO,
  updatedAt: '2026-10-01T00:00:00.000Z',
  nextSteps: '',
  relatedVulnIds: [],
  childCount: 0,
}

const SNAPSHOT_DETAIL = {
  session: {
    sessionId: 'S-PARENT',
    projectName: 'demo-project',
    currentPhase: 'recon',
    targetHosts: ['https://a.example.com', 'https://b.example.com'],
    parentSessionId: null,
    archivedAt: null,
    createdAt: ISO,
    updatedAt: '2026-11-05T09:00:00.000Z',
    nextSteps: 'continue to exploit phase',
    relatedVulnIds: ['VULN-20261104-003'],
    unfinishedTasks: ['finish recon on api host'],
    failedPaths: ['WAF blocked the upload path'],
    testedInterfaces: [
      { target: 'https://a.example.com/api/login', method: 'GET', result: '200 OK' },
    ],
    notes: '### recon notes\n\nfound login page and api host',
    previousState: { currentPhase: 'previous-phase-xyz' },
    childCount: 1,
  },
  children: [
    {
      sessionId: 'S-CHILD',
      projectName: 'demo-project',
      currentPhase: 'exploit',
      parentSessionId: 'S-PARENT',
      childCount: 0,
    },
  ],
  relatedVulns: [
    vulnSummary({ id: 'VULN-20261104-003', vulnName: 'IDOR on API', severity: 'Critical' }),
  ],
}

// ---------------------------------------------------------------- harness

function tFor(page, locale) {
  return makeT(Object.assign({}, shellMessages[locale] || {}, page.messages[locale] || {}))
}

function makeApi(handler) {
  const calls = []
  const api = {
    calls,
    get: async (path, query) => {
      calls.push({ path, query })
      return handler(path, query, calls.length)
    },
    getText: async () => {
      throw new Error('getText should not be used by read-only pages')
    },
    patch: async () => {
      throw new Error('patch should not be used by read-only pages')
    },
    post: async () => {
      throw new Error('post should not be used by read-only pages')
    },
  }
  return api
}

async function mount(name, handler, overrides) {
  const page = loadPage(name)
  const api = makeApi(handler)
  const navCalls = []
  const props = Object.assign(
    {
      api,
      t: tFor(page, 'en'),
      locale: 'en',
      nav: { tab: name, params: {}, go: (tab, params) => navCalls.push({ tab, params }) },
      app: {
        health: null,
        refreshHealth: () => {},
        reloadAll: () => {},
        version: '0.1.0',
        rev: 0,
        readOnly: false,
        locale: 'en',
      },
      rev: 0,
      toast: () => {},
    },
    overrides || {},
  )
  const view = await renderPage(page.Component, props)
  await flush(2)
  return { page, api, view, props, navCalls }
}

async function clickNode(view, node) {
  assert.ok(node, 'expected a clickable node')
  await view.act(async () => {
    node.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await flush(2)
}

async function typeInto(view, node, value) {
  const win = globalThis.window
  await view.act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')
    descriptor.set.call(node, value)
    node.dispatchEvent(new win.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await flush(2)
}

async function chooseOption(view, node, value) {
  const win = globalThis.window
  await view.act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')
    descriptor.set.call(node, value)
    node.dispatchEvent(new win.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await flush(2)
}

function findByText(view, selector, text) {
  return view.queryAll(selector).filter((node) => (node.textContent || '').indexOf(text) >= 0)[0]
}

function callsFor(api, path) {
  return api.calls.filter((call) => call.path === path)
}

// ---------------------------------------------------------------- overview

test('overview renders stats, distributions and recent vulnerabilities', async () => {
  const { view, api, navCalls } = await mount('overview', (path) => {
    assert.equal(path, '/stats')
    return STATS
  })
  try {
    const text = view.text()
    // metric cards + labels
    for (const label of ['Web vulnerabilities', 'Internal vulnerabilities', 'Total vulnerabilities', 'Hosts', 'Assets']) {
      assert.ok(text.indexOf(label) >= 0, `missing metric label ${label}`)
    }
    for (const value of ['9', '4', '13', '7']) assert.ok(text.indexOf(value) >= 0)
    // severity + status distributions
    for (const label of ['Critical', 'High', 'Medium', 'Low', 'Info', 'Confirmed', 'Inconclusive', 'Retest passed']) {
      assert.ok(text.indexOf(label) >= 0, `missing distribution label ${label}`)
    }
    // projects + recent list
    assert.ok(text.indexOf('demo-project') >= 0)
    assert.ok(text.indexOf('SQL injection in login') >= 0)
    assert.ok(text.indexOf('IDOR on order API') >= 0)
    assert.ok(text.indexOf('Internal') >= 0)
    assert.ok(callsFor(api, '/stats').length === 1)

    // clicking a recent row navigates to the vulnerabilities detail
    const row = view.query('tr[data-clickable="true"]')
    await clickNode(view, row)
    assert.deepEqual(navCalls[0], { tab: 'vulns', params: { vulnId: 'VULN-20261104-001' } })
  } finally {
    await view.unmount()
  }
})

test('overview reloads when rev changes, and renders a friendly empty state', async () => {
  const { view, api, props } = await mount('overview', () => STATS)
  try {
    await view.rerender(Object.assign({}, props, { rev: 1 }))
    await flush(2)
    assert.equal(callsFor(api, '/stats').length, 2)
  } finally {
    await view.unmount()
  }

  const empty = await mount('overview', () => ({
    counts: { web: 0, internal: 0, total: 0 },
    bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 },
    byStatus: { Confirmed: 0, Inconclusive: 0, Retest_Passed: 0 },
    hosts: 0,
    assets: 0,
    projects: [],
    recent: [],
  }))
  try {
    const text = empty.view.text()
    assert.ok(text.indexOf('The Cortex database is empty') >= 0)
    assert.ok(text.indexOf('Record vulnerabilities') >= 0)
  } finally {
    await empty.view.unmount()
  }
})

test('overview error state offers retry and recovers', async () => {
  let attempts = 0
  const { view } = await mount('overview', () => {
    attempts += 1
    if (attempts === 1) throw apiError('NETWORK')
    return STATS
  })
  try {
    assert.ok(view.query('.dshc-error'), 'expected an error box')
    assert.ok(view.text().indexOf('Network error: cannot reach the DSH Host') >= 0)
    const retry = view.query('.dshc-error button')
    await clickNode(view, retry)
    assert.equal(attempts, 2)
    assert.ok(view.text().indexOf('SQL injection in login') >= 0)
    assert.equal(view.query('.dshc-error'), null)
  } finally {
    await view.unmount()
  }
})

test('overview renders Chinese copy for locale zh', async () => {
  const page = loadPage('overview')
  const api = makeApi(() => STATS)
  const view = await renderPage(page.Component, {
    api,
    t: tFor(page, 'zh'),
    locale: 'zh',
    nav: { tab: 'overview', params: {}, go: () => {} },
    app: {},
    rev: 0,
    toast: () => {},
  })
  try {
    const text = view.text()
    assert.ok(text.indexOf('漏洞总数') >= 0)
    assert.ok(text.indexOf('最近漏洞') >= 0)
    assert.ok(text.indexOf('metric.total') < 0, 'untranslated key leaked into the UI')
  } finally {
    await view.unmount()
  }
})

// ---------------------------------------------------------------- assets

test('assets list opens an encoded detail URL and shows every detail section', async () => {
  const { view, api, navCalls } = await mount('assets', (path) => {
    if (path === '/assets') return ASSETS_LIST
    if (path === '/assets/' + encodeURIComponent(HOST_PORT)) {
      return { asset: ASSET_DETAIL, related: [vulnSummary({ id: 'VULN-20261104-002', vulnName: 'IDOR on order API' })] }
    }
    throw apiError('NOT_FOUND')
  })
  try {
    assert.ok(view.text().indexOf(HOST_PORT) >= 0)
    assert.ok(view.text().indexOf('Alive') >= 0)

    const item = view.query('button.dshc-list-item')
    await clickNode(view, item)

    // hostPort must be encodeURIComponent'd in the detail path
    assert.equal(callsFor(api, '/assets/' + encodeURIComponent(HOST_PORT)).length, 1)

    const text = view.text()
    assert.ok(text.indexOf('nginx, Node.js') >= 0)
    assert.ok(text.indexOf('/api/users') >= 0)
    assert.ok(text.indexOf('AKIA_TEST_VALUE_123') >= 0)
    assert.ok(text.indexOf('API access with service account') >= 0)
    assert.ok(text.indexOf('orderId') >= 0)
    assert.ok(text.indexOf('1001, 1002') >= 0)
    assert.ok(text.indexOf('^[0-9]{4}$') >= 0)
    assert.ok(text.indexOf('VULN-20261104-002') >= 0)

    // expandable raw request
    const rawButton = findByText(view, 'button', 'Raw request')
    await clickNode(view, rawButton)
    assert.ok(view.text().indexOf('GET /api/users HTTP/1.1') >= 0)

    // related vulnerability navigates to the vulns tab
    const relatedButton = findByText(view, 'button', 'VULN-20261104-002')
    await clickNode(view, relatedButton)
    assert.deepEqual(navCalls[0], { tab: 'vulns', params: { vulnId: 'VULN-20261104-002' } })
  } finally {
    await view.unmount()
  }
})

test('assets search, status filter and pagination hit GET /assets', async () => {
  const { view, api } = await mount('assets', (path) => {
    if (path === '/assets') return Object.assign({}, ASSETS_LIST, { total: 60, pages: 3 })
    throw apiError('NOT_FOUND')
  })
  try {
    const lastListCall = () => callsFor(api, '/assets').slice(-1)[0]
    assert.equal(lastListCall().query.page, 1)
    assert.equal(lastListCall().query.pageSize, 20)

    const nextButton = findByText(view, 'button', 'Next')
    await clickNode(view, nextButton)
    assert.equal(lastListCall().query.page, 2)

    const search = view.query('input.dshc-input')
    await typeInto(view, search, 'acme')
    assert.equal(lastListCall().query.search, 'acme')
    assert.equal(lastListCall().query.page, 1)

    const status = view.queryAll('select.dshc-select')[0]
    await chooseOption(view, status, 'WAF_Blocked')
    assert.equal(lastListCall().query.status, 'WAF_Blocked')
  } finally {
    await view.unmount()
  }
})

test('assets empty list shows the database hint; detail errors can be retried', async () => {
  const empty = await mount('assets', () => ({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    pages: 0,
    projects: [],
  }))
  try {
    const text = empty.view.text()
    assert.ok(text.indexOf('No assets recorded yet') >= 0)
    assert.ok(text.indexOf('sync_asset_info') >= 0)
    assert.ok(text.indexOf('Select an asset to see details') >= 0)
  } finally {
    await empty.view.unmount()
  }

  let detailAttempts = 0
  const { view } = await mount('assets', (path) => {
    if (path === '/assets') return ASSETS_LIST
    detailAttempts += 1
    if (detailAttempts === 1) throw apiError('NOT_FOUND')
    return { asset: ASSET_DETAIL, related: [] }
  })
  try {
    await clickNode(view, view.query('button.dshc-list-item'))
    assert.ok(view.query('.dshc-error'))
    assert.ok(view.text().indexOf('Requested data was not found') >= 0)
    await clickNode(view, view.query('.dshc-error button'))
    assert.equal(detailAttempts, 2)
    assert.ok(view.text().indexOf('nginx, Node.js') >= 0)
  } finally {
    await view.unmount()
  }
})

// ---------------------------------------------------------------- internal

test('internal auto-selects the first project and renders all tables with masked credentials', async () => {
  const { view, api } = await mount('internal', (path) => {
    if (path === '/internal/projects') return INTERNAL_PROJECTS
    if (path === '/internal/overview') return INTERNAL_OVERVIEW
    if (path === '/internal/graph') return INTERNAL_GRAPH
    throw apiError('NOT_FOUND')
  })
  try {
    const projectCalls = callsFor(api, '/internal/projects')
    const overviewCalls = callsFor(api, '/internal/overview')
    assert.equal(projectCalls.length, 1)
    assert.equal(overviewCalls.length, 1)
    assert.equal(overviewCalls[0].query.project, 'acme-internal')
    assert.equal(view.query('select.dshc-select').value, 'acme-internal')

    const text = view.text()
    // stats badges + tables
    for (const label of ['Footholds', 'Internal hosts', 'Internal services', 'Credentials (masked)', 'Pivots']) {
      assert.ok(text.indexOf(label) >= 0, `missing table ${label}`)
    }
    assert.ok(text.indexOf('https://a.example.com/login') >= 0)
    assert.ok(text.indexOf('10.0.1.10') >= 0)
    assert.ok(text.indexOf('OpenSSH 9.0') >= 0)
    assert.ok(text.indexOf('admin') >= 0)
    assert.ok(text.indexOf('ACME') >= 0)
    assert.ok(text.indexOf('ab••••z') >= 0)
    assert.ok(text.indexOf('len 8') >= 0)
    assert.ok(text.indexOf('host:app01 via SSH') >= 0)
    assert.ok(text.indexOf('10.0.2.0/24') >= 0)
    // optional relation graph edge list
    assert.ok(text.indexOf('Relation graph (edge list)') >= 0)
    assert.ok(text.indexOf('reaches') >= 0)
    // raw credential secret must never be rendered
    assert.equal(text.indexOf('SUPER_SECRET_VALUE'), -1, 'raw credential secret must not be rendered')
  } finally {
    await view.unmount()
  }
})

test('internal empty database and empty project both show helpful empty states', async () => {
  const noProjects = await mount('internal', (path) => {
    if (path === '/internal/projects') return { projects: [] }
    throw new Error('overview must not be requested without a project')
  })
  try {
    const text = noProjects.view.text()
    assert.ok(text.indexOf('No internal operations data yet') >= 0)
    assert.ok(text.indexOf('sync_internal_scope') >= 0)
    assert.equal(noProjects.api.calls.filter((call) => call.path === '/internal/overview').length, 0)
  } finally {
    await noProjects.view.unmount()
  }

  const emptyProject = await mount('internal', (path) => {
    if (path === '/internal/projects') {
      return { projects: [{ projectName: 'empty-proj', footholds: 0, hosts: 0, services: 0, credentials: 0, pivots: 0 }] }
    }
    if (path === '/internal/overview') {
      return {
        project: 'empty-proj',
        footholds: [],
        hosts: [],
        services: [],
        credentials: [],
        pivots: [],
        stats: { footholds: 0, hosts: 0, services: 0, credentials: 0, pivots: 0 },
      }
    }
    if (path === '/internal/graph') return { nodes: [], edges: [] }
    throw apiError('NOT_FOUND')
  })
  try {
    const text = emptyProject.view.text()
    assert.ok(text.indexOf('This project has no internal operations data') >= 0)
    assert.ok(text.indexOf('empty-proj') >= 0)
  } finally {
    await emptyProject.view.unmount()
  }
})

// ---------------------------------------------------------------- snapshots

test('snapshots renders a parent/child tree and a read-only nine-field detail', async () => {
  const { view, api, props, navCalls } = await mount('snapshots', (path) => {
    if (path === '/snapshots') {
      return { projects: ['demo-project'], sessions: [SESSION_PARENT, SESSION_CHILD] }
    }
    if (path === '/snapshots/' + encodeURIComponent('S-PARENT')) return SNAPSHOT_DETAIL
    throw apiError('NOT_FOUND')
  })
  try {
    assert.equal(callsFor(api, '/snapshots')[0].query.includeArchived, 0)
    const nodes = view.queryAll('button.dshc-list-item')
    assert.equal(nodes.length, 2)
    assert.ok(nodes.some((node) => node.getAttribute('data-depth') === '1'), 'child session should be nested')

    await clickNode(view, nodes[0])
    assert.equal(callsFor(api, '/snapshots/' + encodeURIComponent('S-PARENT')).length, 1)

    const text = view.text()
    // nine fields + previousState + children
    assert.ok(text.indexOf('demo-project') >= 0)
    assert.ok(text.indexOf('https://a.example.com') >= 0)
    assert.ok(text.indexOf('https://b.example.com') >= 0)
    assert.ok(text.indexOf('finish recon on api host') >= 0)
    assert.ok(text.indexOf('WAF blocked the upload path') >= 0)
    assert.ok(text.indexOf('200 OK') >= 0)
    assert.ok(text.indexOf('found login page and api host') >= 0)
    assert.ok(text.indexOf('continue to exploit phase') >= 0)
    assert.ok(text.indexOf('previous-phase-xyz') >= 0)
    assert.ok(text.indexOf('VULN-20261104-003') >= 0)
    assert.ok(text.indexOf('Child sessions') >= 0 || text.indexOf('children') >= 0)
    // read-only: no write buttons on the page
    assert.equal(view.queryAll('input[type="text"]').length, 0)

    await clickNode(view, findByText(view, 'button', 'VULN-20261104-003'))
    assert.deepEqual(navCalls[0], { tab: 'vulns', params: { vulnId: 'VULN-20261104-003' } })

    // rev bump (shell refresh) must reload both the tree and the open detail
    await view.rerender(Object.assign({}, props, { rev: 1 }))
    await flush(2)
    assert.equal(callsFor(api, '/snapshots').length, 2)
    assert.equal(callsFor(api, '/snapshots/' + encodeURIComponent('S-PARENT')).length, 2)
  } finally {
    await view.unmount()
  }
})

test('snapshots includeArchived toggle reloads with archived sessions', async () => {
  const { view, api } = await mount('snapshots', (path, query) => {
    if (path !== '/snapshots') throw apiError('NOT_FOUND')
    const includeArchived = Number(query.includeArchived) === 1
    return {
      projects: ['demo-project'],
      sessions: includeArchived
        ? [SESSION_PARENT, SESSION_CHILD, SESSION_ARCHIVED]
        : [SESSION_PARENT, SESSION_CHILD],
    }
  })
  try {
    assert.ok(view.text().indexOf('archived-phase') < 0)
    const calls = callsFor(api, '/snapshots')
    assert.equal(calls[0].query.includeArchived, 0)

    const checkbox = view.query('input[type="checkbox"]')
    assert.ok(checkbox, 'expected includeArchived checkbox')
    await clickNode(view, checkbox)
    const after = callsFor(api, '/snapshots')
    assert.equal(after[after.length - 1].query.includeArchived, 1)
    assert.ok(view.text().indexOf('archived-phase') >= 0)
    assert.ok(view.text().indexOf('archived') >= 0)
  } finally {
    await view.unmount()
  }
})

test('snapshots empty list and detail errors have explicit states', async () => {
  const empty = await mount('snapshots', (path) => {
    if (path === '/snapshots') return { projects: [], sessions: [] }
    throw apiError('NOT_FOUND')
  })
  try {
    assert.ok(empty.view.text().indexOf('No snapshot sessions') >= 0)
    assert.ok(empty.view.text().indexOf('manage_snapshot') >= 0)
    assert.ok(empty.view.text().indexOf('Select a snapshot session') >= 0)
  } finally {
    await empty.view.unmount()
  }

  let detailAttempts = 0
  const broken = await mount('snapshots', (path) => {
    if (path === '/snapshots') {
      return { projects: ['demo-project'], sessions: [SESSION_PARENT, SESSION_CHILD] }
    }
    detailAttempts += 1
    if (detailAttempts === 1) throw apiError('NOT_FOUND')
    return SNAPSHOT_DETAIL
  })
  try {
    await clickNode(broken.view, broken.view.queryAll('button.dshc-list-item')[0])
    assert.ok(broken.view.query('.dshc-error'))
    assert.ok(broken.view.text().indexOf('Requested data was not found') >= 0)
    await clickNode(broken.view, broken.view.query('.dshc-error button'))
    assert.equal(detailAttempts, 2)
    assert.ok(broken.view.text().indexOf('finish recon on api host') >= 0)
  } finally {
    await broken.view.unmount()
  }
})

// ---------------------------------------------------------------- contract

test('every auxiliary page exports the page contract', () => {
  for (const name of ['overview', 'assets', 'internal', 'snapshots']) {
    const page = loadPage(name)
    assert.equal(page.id, name)
    assert.equal(typeof page.Component, 'function')
    assert.ok(page.messages.zh && page.messages.en, `${name} needs zh + en messages`)
    const zhKeys = Object.keys(page.messages.zh)
    assert.ok(zhKeys.length >= 10, `${name} zh dictionary is too small`)
    for (const key of zhKeys) {
      assert.ok(
        page.messages.en[key] !== undefined,
        `${name}: missing en translation for "${key}"`,
      )
    }
  }
})
