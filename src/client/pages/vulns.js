// Vulnerabilities page: search/filter/pagination list + detail, status write
// (PATCH /vulns/:id/status), Markdown report download and retest hand-off.
//
// Packaged by scripts/build-client.mjs: CommonJS only, no JSX, no DSH Client
// imports. Every visible string goes through props.t(); styling uses only
// `.dshc-*` classes from src/client/styles.js and theme tokens (never literal
// colors). The page talks to the plugin Host half only through props.api.
const React = require('react')
const {
  h,
  Icon,
  Button,
  Badge,
  Card,
  Section,
  Toolbar,
  Spinner,
  Empty,
  ErrorBox,
  Field,
  Input,
  Select,
  DataTable,
  Split,
  Pager,
  KeyValue,
  Mono,
  severityTone,
  statusTone,
  realmTone,
} = require('../ui/kit.js')
const { Markdown } = require('../ui/markdown.js')
const { fmtTime, asArray, joinMeta } = require('../lib/format.js')

const { useState, useEffect, useRef, useCallback } = React

const PAGE_SIZES = [20, 50, 100]
const DEFAULT_PAGE_SIZE = PAGE_SIZES[0]
const SEVERITY_VALUES = ['Critical', 'High', 'Medium', 'Low', 'Info']
const STATUS_VALUES = ['Confirmed', 'Inconclusive', 'Retest_Passed']
const REALM_VALUES = ['web', 'internal']
const FILTER_KEYS = ['severity', 'status', 'realm']
const SEARCH_DEBOUNCE_MS = 300
const REPORT_BASE = '/cortex-api/reports/'

// The shell unmounts the page when the user switches tabs. Remembering the last
// selected vulnerability in module scope keeps the detail pane when the user
// comes back to the tab (the shell does not provide URL state).
let rememberedSelection = null

// ---------------------------------------------------------------- state helpers

/** @returns {{search:string, severity:string, status:string, realm:string, page:number, pageSize:number}} */
function initialListState() {
  return { search: '', severity: '', status: '', realm: '', page: 1, pageSize: DEFAULT_PAGE_SIZE }
}

/** Build the `GET /vulns` query object (empty filters are omitted). */
function buildListQuery(state) {
  const source = state || initialListState()
  const requestedSize = Number(source.pageSize)
  const pageSize = PAGE_SIZES.indexOf(requestedSize) >= 0 ? requestedSize : DEFAULT_PAGE_SIZE
  const query = {
    page: Math.max(1, Math.floor(Number(source.page) || 1)),
    pageSize,
  }
  if (source.search) query.search = String(source.search)
  if (source.severity) query.severity = String(source.severity)
  if (source.status) query.status = String(source.status)
  if (source.realm) query.realm = String(source.realm)
  return query
}

function withPageReset(state) {
  return state.page === 1 ? state : Object.assign({}, state, { page: 1 })
}

/** A filter change always restarts pagination at page 1. */
function changeFilter(state, key, value) {
  if (FILTER_KEYS.indexOf(key) < 0) return state
  const next = Object.assign({}, state, { [key]: value === undefined || value === null ? '' : String(value) })
  return withPageReset(next)
}

/** A debounced search update restarts pagination at page 1 (no-op when equal). */
function applySearch(state, text) {
  const search = text === undefined || text === null ? '' : String(text)
  if (state && state.search === search) return state
  return withPageReset(Object.assign({}, state, { search }))
}

function changePage(state, page) {
  const next = Math.max(1, Math.floor(Number(page) || 1))
  return next === state.page ? state : Object.assign({}, state, { page: next })
}

function changePageSize(state, size) {
  const next = Number(size)
  if (PAGE_SIZES.indexOf(next) < 0 || next === state.pageSize) return state
  return Object.assign({}, state, { pageSize: next, page: 1 })
}

function isFiltered(state) {
  const source = state || initialListState()
  return !!(source.search || source.severity || source.status || source.realm)
}

function isAbortError(error) {
  return !!error && (error.code === 'ABORTED' || error.name === 'AbortError')
}

function uniqueStrings(values) {
  const seen = Object.create(null)
  const out = []
  for (const value of asArray(values)) {
    const text = value === undefined || value === null ? '' : String(value)
    if (!text || seen[text]) continue
    seen[text] = true
    out.push(text)
  }
  return out
}

/** Use the Host-provided filter values when present, otherwise static defaults. */
function resolvedValues(provided, fallback) {
  const list = asArray(provided).filter((value) => typeof value === 'string' && value)
  return list.length ? list : fallback.slice()
}

/** Translate an enumeration value (severity/status/realm) with a raw fallback. */
function translateValue(t, group, value) {
  if (value === undefined || value === null || value === '') return '—'
  const text = String(value)
  const key = `${group}.${text}`
  const label = typeof t === 'function' ? t(key) : key
  return label === key ? text : label
}

function makeOptions(t, group, values) {
  return values.map((value) => ({ value, label: translateValue(t, group, value) }))
}

function withAllOption(t, options) {
  return [{ value: '', label: t('common.all') }].concat(options)
}

function reportHref(vulnId) {
  return REPORT_BASE + encodeURIComponent(String(vulnId))
}

function readInitialSelection(nav) {
  const params = nav && nav.params ? nav.params : null
  const fromNav = params && params.vulnId ? String(params.vulnId) : ''
  if (fromNav) {
    rememberedSelection = fromNav
    return fromNav
  }
  return rememberedSelection
}

// ---------------------------------------------------------------- API helpers

function normalizeListResponse(payload, state) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const fallback = state || initialListState()
  const pageSize = Number(source.pageSize) || fallback.pageSize || DEFAULT_PAGE_SIZE
  const total = Number(source.total) || 0
  const pages = Number(source.pages) || Math.max(1, Math.ceil(total / pageSize))
  return {
    items: asArray(source.items),
    total,
    page: Number(source.page) || fallback.page || 1,
    pageSize,
    pages: Math.max(1, pages),
    filters: source.filters && typeof source.filters === 'object' ? source.filters : null,
  }
}

function loadList(api, state) {
  return Promise.resolve(api.get('/vulns', buildListQuery(state))).then((payload) =>
    normalizeListResponse(payload, state),
  )
}

function loadDetail(api, vulnId) {
  return Promise.resolve(api.get(`/vulns/${encodeURIComponent(String(vulnId))}`)).then((payload) => {
    const source = payload && typeof payload === 'object' ? payload : {}
    return {
      vuln: source.vuln && typeof source.vuln === 'object' ? source.vuln : null,
      related: asArray(source.related),
    }
  })
}

/** Status write; the Host validates the enum and returns 403 in read-only mode. */
function saveStatus(api, vulnId, status) {
  return Promise.resolve(api.patch(`/vulns/${encodeURIComponent(String(vulnId))}/status`, { status }))
}

function withVulnStatus(detail, status) {
  if (!detail || !detail.vuln) return detail
  return Object.assign({}, detail, { vuln: Object.assign({}, detail.vuln, { status }) })
}

// ---------------------------------------------------------------- list columns

function buildColumns(t, locale) {
  return [
    {
      key: 'id',
      label: t('list.col.id'),
      width: 88,
      render: (row) => h(Mono, { title: row.id }, row.id || '—'),
    },
    {
      key: 'vulnName',
      label: t('list.col.name'),
      render: (row) => {
        const meta = joinMeta([
          row.vulnType,
          row.retestCount ? t('list.retestCount', { count: row.retestCount }) : '',
        ])
        return h(
          'div',
          { className: 'dshc-col' },
          h('div', { className: 'dshc-clamp2', title: row.vulnName || '' }, row.vulnName || '—'),
          meta ? h('div', { className: 'dshc-small dshc-muted' }, meta) : null,
        )
      },
    },
    {
      key: 'host',
      label: t('list.col.host'),
      width: 120,
      render: (row) =>
        h('span', { className: 'dshc-nowrap dshc-break', title: row.host || '' }, row.host || '—'),
    },
    {
      key: 'severity',
      label: t('list.col.severity'),
      width: 70,
      render: (row) =>
        h(Badge, { tone: severityTone(row.severity) }, translateValue(t, 'severity', row.severity)),
    },
    {
      key: 'status',
      label: t('list.col.status'),
      width: 84,
      render: (row) =>
        h(Badge, { tone: statusTone(row.status) }, translateValue(t, 'status', row.status)),
    },
    {
      key: 'realm',
      label: t('list.col.realm'),
      width: 62,
      render: (row) => h(Badge, { tone: realmTone(row.realm) }, translateValue(t, 'realm', row.realm)),
    },
    {
      key: 'createdAt',
      label: t('list.col.created'),
      width: 108,
      render: (row) =>
        h('span', { className: 'dshc-nowrap dshc-small dshc-muted' }, fmtTime(row.createdAt, locale)),
    },
  ]
}

// ---------------------------------------------------------------- toolbar + list

function renderToolbar(props, t) {
  const listState = props.listState || initialListState()
  const list = props.list || { phase: 'loading', data: null, error: null }
  const data = list.data || null
  const filtered = isFiltered(listState)

  return h(
    Toolbar,
    {
      right: h(
        'div',
        { className: 'dshc-flex' },
        data ? h('span', { className: 'dshc-muted dshc-small' }, t('common.total', { total: data.total })) : null,
        h(
          Button,
          {
            size: 'sm',
            icon: 'close',
            title: t('filters.resetHint'),
            onClick: props.onReset,
            disabled: !filtered && !props.searchInput,
          },
          t('filters.reset'),
        ),
        h(
          Button,
          { size: 'sm', icon: 'refresh', onClick: props.onRefresh, disabled: list.phase === 'loading' },
          t('common.refresh'),
        ),
      ),
    },
    h(
      Field,
      { label: t('filters.search'), className: 'dshc-grow' },
      h(Input, {
        style: { width: '100%' },
        value: props.searchInput,
        onChange: props.onSearchChange,
        placeholder: t('filters.searchPlaceholder'),
        'aria-label': t('filters.searchAria'),
      }),
    ),
    h(
      Field,
      { label: t('filters.severity') },
      h(Select, {
        value: listState.severity,
        options: withAllOption(
          t,
          makeOptions(t, 'severity', resolvedValues(props.listFilters && props.listFilters.severities, SEVERITY_VALUES)),
        ),
        onChange: (event) => props.onFilterChange('severity', event.target.value),
        'aria-label': t('filters.severityAria'),
      }),
    ),
    h(
      Field,
      { label: t('filters.status') },
      h(Select, {
        value: listState.status,
        options: withAllOption(
          t,
          makeOptions(t, 'status', resolvedValues(props.listFilters && props.listFilters.statuses, STATUS_VALUES)),
        ),
        onChange: (event) => props.onFilterChange('status', event.target.value),
        'aria-label': t('filters.statusAria'),
      }),
    ),
    h(
      Field,
      { label: t('filters.realm') },
      h(Select, {
        value: listState.realm,
        options: withAllOption(
          t,
          makeOptions(t, 'realm', resolvedValues(props.listFilters && props.listFilters.realms, REALM_VALUES)),
        ),
        onChange: (event) => props.onFilterChange('realm', event.target.value),
        'aria-label': t('filters.realmAria'),
      }),
    ),
  )
}

function renderListPane(props, t, locale) {
  const listState = props.listState || initialListState()
  const list = props.list || { phase: 'loading', data: null, error: null }
  const data = list.data || null
  const filtered = isFiltered(listState)

  const empty = h(Empty, {
    icon: 'shield',
    title: filtered ? t('list.emptyFiltered') : t('list.empty'),
    hint: filtered ? t('list.emptyFilteredHint') : t('list.emptyHint'),
  })

  let listBody
  if (!data && list.phase === 'loading') {
    listBody = h(Spinner, { label: t('list.loading') })
  } else if (list.phase === 'error') {
    listBody = h(
      'div',
      { className: 'dshc-card-body' },
      h(ErrorBox, { error: list.error, t, onRetry: props.onRefresh, retryLabel: t('common.retry') }),
    )
  } else {
    const items = data ? data.items : []
    listBody = h(
      React.Fragment,
      null,
      h(DataTable, {
        columns: buildColumns(t, locale),
        rows: items,
        rowKey: 'id',
        dense: true,
        activeKey: props.selectedId,
        onRowActivate: (row) => props.onSelect(row.id),
        ariaLabel: t('list.aria'),
        empty,
      }),
      data
        ? h(Pager, {
            page: data.page || listState.page,
            pages: data.pages,
            total: data.total,
            pageSize: data.pageSize || listState.pageSize,
            onPage: props.onPage,
            onPageSize: props.onPageSize,
            t,
          })
        : null,
    )
  }

  // Split() already renders the list inside a bordered card container.
  return listBody
}

// ---------------------------------------------------------------- status editor

function renderStatusEditor(props, t, vuln) {
  const editValues = uniqueStrings(STATUS_VALUES.concat(vuln.status ? [vuln.status] : []))
  const statusValue = props.statusDraft || vuln.status || ''
  const canApply = !props.readOnly && !props.saving && !!props.statusDraft && props.statusDraft !== vuln.status
  return h(
    'div',
    { className: 'dshc-flex' },
    h('span', { className: 'dshc-small dshc-muted' }, t('detail.statusLabel')),
    h(Select, {
      value: statusValue,
      options: editValues.map((value) => ({ value, label: translateValue(t, 'status', value) })),
      onChange: (event) => props.onStatusDraftChange(event.target.value),
      disabled: !!props.readOnly,
      'aria-label': t('detail.statusEditorAria'),
    }),
    h(
      Button,
      { variant: 'primary', size: 'sm', icon: 'check', onClick: props.onApplyStatus, disabled: !canApply },
      t('detail.applyStatus'),
    ),
    props.saving ? h('span', { className: 'dshc-small dshc-muted' }, t('detail.saving')) : null,
    props.readOnly
      ? h(
          'span',
          { className: 'dshc-flex dshc-small dshc-muted' },
          h(Icon, { name: 'warning', size: 12 }),
          t('detail.readOnly'),
        )
      : null,
  )
}

// ---------------------------------------------------------------- related vulns

function renderRelated(props, t, detail, vuln) {
  const related = asArray(detail.related).filter((item) => item && item.id)
  if (related.length) {
    return h(
      'div',
      { className: 'dshc-col' },
      related.map((item) =>
        h(
          'button',
          {
            key: item.id,
            type: 'button',
            className: 'dshc-btn dshc-btn-ghost',
            onClick: () => props.onSelect(item.id),
            'aria-label': t('detail.openRelated', { id: item.id }),
          },
          h(Mono, null, item.id),
          h('span', { className: 'dshc-grow' }, item.vulnName || item.id),
          h(Badge, { tone: severityTone(item.severity) }, translateValue(t, 'severity', item.severity)),
          h(Badge, { tone: statusTone(item.status) }, translateValue(t, 'status', item.status)),
        ),
      ),
    )
  }
  const ids = uniqueStrings(vuln.relatedVulnIds)
  if (!ids.length) return h('span', { className: 'dshc-muted dshc-small' }, '—')
  return h(
    'div',
    { className: 'dshc-flex' },
    ids.map((id) =>
      h(
        Button,
        { key: id, size: 'sm', onClick: () => props.onSelect(id), title: t('detail.openRelated', { id }) },
        id,
      ),
    ),
  )
}

// ---------------------------------------------------------------- detail pane

function renderDetailPane(props, t, locale) {
  const detail = props.detail || { phase: 'idle', vuln: null, related: [], error: null }
  const vuln = detail.vuln || null

  if (!props.selectedId) {
    return h(Empty, {
      icon: 'shield',
      title: t('detail.noSelection'),
      hint: t('detail.noSelectionHint'),
    })
  }
  if (!vuln && detail.phase === 'error') {
    return h(ErrorBox, { error: detail.error, t, onRetry: props.onRefresh, retryLabel: t('common.retry') })
  }
  if (!vuln && detail.phase === 'ok') {
    return h(Empty, { icon: 'warning', title: t('detail.notFound') })
  }
  if (!vuln) return h(Spinner, { label: t('detail.loading') })

  const actions = h(
    'div',
    { className: 'dshc-flex' },
    h(
      'a',
      {
        href: reportHref(vuln.id),
        download: `${vuln.id}.md`,
        className: 'dshc-btn dshc-btn-sm',
        title: t('detail.downloadHint'),
        'aria-label': t('detail.download'),
      },
      h(Icon, { name: 'download', size: 13 }),
      h('span', null, t('detail.download')),
    ),
    h(Button, { size: 'sm', icon: 'play', onClick: props.onRetest }, t('detail.retest')),
  )

  const badges = h(
    'div',
    { className: 'dshc-flex' },
    h(Badge, { tone: severityTone(vuln.severity) }, translateValue(t, 'severity', vuln.severity)),
    h(Badge, { tone: statusTone(vuln.status) }, translateValue(t, 'status', vuln.status)),
    h(Badge, { tone: realmTone(vuln.realm) }, translateValue(t, 'realm', vuln.realm)),
    h(Mono, null, vuln.id || '—'),
    vuln.retestCount ? h(Badge, { tone: 'neutral' }, t('list.retestCount', { count: vuln.retestCount })) : null,
  )

  const metaItems = [
    [t('detail.field.vulnType'), vuln.vulnType || '—'],
    [t('detail.field.host'), h(Mono, null, vuln.host || '—')],
    [t('detail.field.createdAt'), fmtTime(vuln.createdAt, locale)],
    [t('detail.field.latestRetestAt'), vuln.latestRetestAt ? fmtTime(vuln.latestRetestAt, locale) : '—'],
    [t('detail.field.retestCount'), String(vuln.retestCount || 0)],
  ]
  if (vuln.targetUrl) metaItems.push([t('detail.field.targetUrl'), h(Mono, null, vuln.targetUrl)])
  if (vuln.entryPoint) metaItems.push([t('detail.field.entryPoint'), h(Mono, null, vuln.entryPoint)])
  if (vuln.serviceHost) metaItems.push([t('detail.field.serviceHost'), h(Mono, null, vuln.serviceHost)])
  if (vuln.internalServiceId) {
    metaItems.push([t('detail.field.internalServiceId'), h(Mono, null, vuln.internalServiceId)])
  }

  const affected = asArray(vuln.affectedInterfaces)
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .filter(Boolean)
  const remediation = asArray(vuln.remediation).filter(Boolean)
  const retests = asArray(vuln.retestResults)
  const dash = () => h('span', { className: 'dshc-muted dshc-small' }, '—')

  const retestHistory = retests.length
    ? h(
        'div',
        { className: 'dshc-col' },
        retests.map((entry, index) =>
          h(
            'div',
            { key: `retest-${index}`, className: 'dshc-col' },
            h(
              'div',
              { className: 'dshc-flex dshc-small' },
              h(Badge, { tone: 'neutral' }, t('detail.retestIndex', { index: index + 1 })),
              h(Mono, { title: t('detail.retestTimeRange') }, entry && entry.timeRange ? String(entry.timeRange) : '—'),
            ),
            h(Markdown, { text: entry && entry.conclusion, empty: '—' }),
            index < retests.length - 1 ? h('hr', { className: 'dshc-hr' }) : null,
          ),
        ),
      )
    : dash()

  const sections = [
    h(
      Section,
      { key: 'description', title: t('detail.description') },
      h(Markdown, { text: vuln.description, empty: '—' }),
    ),
    h(Section, { key: 'impact', title: t('detail.impact') }, h(Markdown, { text: vuln.impact, empty: '—' })),
    h(
      Section,
      { key: 'interfaces', title: t('detail.interfaces') },
      affected.length
        ? h(Markdown, { text: affected.map((item) => `- \`${item}\``).join('\n') })
        : dash(),
    ),
    h(
      Section,
      { key: 'reproduction', title: t('detail.reproduction') },
      h(Markdown, { text: vuln.reproductionSteps, empty: '—' }),
    ),
    h(
      Section,
      { key: 'remediation', title: t('detail.remediation') },
      remediation.length
        ? h('ul', null, remediation.map((item, index) => h('li', { key: index }, String(item))))
        : dash(),
    ),
    h(Section, { key: 'retests', title: t('detail.retests') }, retestHistory),
    h(Section, { key: 'related', title: t('detail.related') }, renderRelated(props, t, detail, vuln)),
  ]
  if (vuln.cryptoDetails) {
    sections.push(h(Section, { key: 'crypto', title: t('detail.crypto') }, h(Markdown, { text: vuln.cryptoDetails })))
  }
  if (vuln.testBoundaries) {
    sections.push(
      h(Section, { key: 'boundaries', title: t('detail.testBoundaries') }, h(Markdown, { text: vuln.testBoundaries })),
    )
  }

  return h(
    Card,
    { title: vuln.vulnName || vuln.id, subtitle: joinMeta([vuln.id, vuln.host]), actions },
    h(
      'div',
      { className: 'dshc-col' },
      badges,
      renderStatusEditor(props, t, vuln),
      h('hr', { className: 'dshc-hr' }),
      h(Section, { title: t('detail.meta') }, h(KeyValue, { items: metaItems })),
      sections,
    ),
  )
}

// ---------------------------------------------------------------- view

/**
 * Pure view used by Component. Props (all supplied by Component):
 * {t, locale, listState, searchInput, list, listFilters, selectedId, detail,
 *  statusDraft, saving, readOnly, onSearchChange, onFilterChange, onReset,
 *  onRefresh, onSelect, onPage, onPageSize, onStatusDraftChange,
 *  onApplyStatus, onRetest}
 */
function VulnsView(props) {
  const t = props.t
  const locale = props.locale
  const list = props.list || { phase: 'loading', data: null, error: null }
  const viewProps = Object.assign({}, props, {
    listFilters: props.listFilters || (list.data && list.data.filters) || null,
  })
  return h(
    'div',
    { className: 'dshc-page' },
    renderToolbar(viewProps, t),
    h(Split, { list: renderListPane(viewProps, t, locale), detail: renderDetailPane(viewProps, t, locale) }),
  )
}

// ---------------------------------------------------------------- component

function Component(props) {
  const { api, t, locale, nav, app, rev, toast } = props
  const readOnly = !!(app && app.readOnly)
  const [listState, setListState] = useState(initialListState)
  const [searchInput, setSearchInput] = useState('')
  const [list, setList] = useState({ phase: 'loading', data: null, error: null })
  const [selectedId, setSelectedId] = useState(() => readInitialSelection(nav))
  const [detail, setDetail] = useState({ phase: 'idle', vuln: null, related: [], error: null })
  const [statusDraft, setStatusDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const listToken = useRef(0)
  const detailToken = useRef(0)

  const selectVuln = useCallback((id) => {
    const next = id ? String(id) : null
    rememberedSelection = next
    setSelectedId(next)
    setStatusDraft('')
  }, [])

  const navVulnId = nav && nav.params && nav.params.vulnId ? String(nav.params.vulnId) : ''

  // The overview page can deep-link into a specific vulnerability.
  useEffect(() => {
    if (navVulnId) selectVuln(navVulnId)
  }, [navVulnId, selectVuln])

  // Debounced search box -> query state (which always restarts at page 1).
  useEffect(() => {
    if (searchInput === listState.search) return undefined
    const timer = setTimeout(() => {
      setListState((previous) => applySearch(previous, searchInput))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, listState.search])

  // Server-side list load; `rev` is bumped by the shell on manual refresh.
  useEffect(() => {
    const token = listToken.current + 1
    listToken.current = token
    let cancelled = false
    setList((previous) => ({
      phase: previous.data ? 'refreshing' : 'loading',
      data: previous.data,
      error: null,
    }))
    loadList(api, listState)
      .then((data) => {
        if (cancelled || listToken.current !== token) return
        setList({ phase: 'ok', data, error: null })
      })
      .catch((error) => {
        if (cancelled || listToken.current !== token || isAbortError(error)) return
        setList({ phase: 'error', data: null, error })
      })
    return () => {
      cancelled = true
    }
  }, [api, rev, listState, reloadNonce])

  // Detail load for the selected vulnerability (refetched after status writes).
  useEffect(() => {
    if (!selectedId) {
      setDetail({ phase: 'idle', vuln: null, related: [], error: null })
      return undefined
    }
    const token = detailToken.current + 1
    detailToken.current = token
    let cancelled = false
    setDetail((previous) => {
      const keep = previous.vuln && previous.vuln.id === selectedId
      return {
        phase: 'loading',
        vuln: keep ? previous.vuln : null,
        related: keep ? previous.related : [],
        error: null,
      }
    })
    loadDetail(api, selectedId)
      .then((result) => {
        if (cancelled || detailToken.current !== token) return
        setDetail({ phase: 'ok', vuln: result.vuln, related: result.related, error: null })
        setStatusDraft('')
      })
      .catch((error) => {
        if (cancelled || detailToken.current !== token || isAbortError(error)) return
        setDetail({ phase: 'error', vuln: null, related: [], error })
      })
    return () => {
      cancelled = true
    }
  }, [api, rev, selectedId, reloadNonce])

  const onSearchChange = useCallback((event) => {
    setSearchInput(event && event.target ? event.target.value : '')
  }, [])

  const onFilterChange = useCallback((key, value) => {
    setListState((previous) => changeFilter(previous, key, value))
  }, [])

  const onReset = useCallback(() => {
    setSearchInput('')
    setListState(initialListState())
  }, [])

  const onRefresh = useCallback(() => {
    setReloadNonce((value) => value + 1)
  }, [])

  const onPage = useCallback((page) => {
    setListState((previous) => changePage(previous, page))
  }, [])

  const onPageSize = useCallback((size) => {
    setListState((previous) => changePageSize(previous, size))
  }, [])

  const onStatusDraftChange = useCallback((value) => {
    setStatusDraft(value === undefined || value === null ? '' : String(value))
  }, [])

  const onApplyStatus = useCallback(() => {
    if (readOnly || saving || !detail.vuln) return
    const nextStatus = statusDraft || detail.vuln.status
    if (!nextStatus || nextStatus === detail.vuln.status) return
    setSaving(true)
    saveStatus(api, detail.vuln.id, nextStatus)
      .then(() => {
        setStatusDraft('')
        setDetail((previous) => withVulnStatus(previous, nextStatus))
        setReloadNonce((value) => value + 1)
        if (typeof toast === 'function') {
          toast(t('toast.statusSaved', { status: translateValue(t, 'status', nextStatus) }), 'ok')
        }
      })
      .catch((error) => {
        if (isAbortError(error)) return
        const message =
          error && error.code === 'READ_ONLY'
            ? t('detail.readOnly')
            : (error && error.message) || String(error)
        if (typeof toast === 'function') toast(t('toast.statusFailed', { message }), 'error')
      })
      .finally(() => setSaving(false))
  }, [api, detail, readOnly, saving, statusDraft, t, toast])

  const onRetest = useCallback(() => {
    if (detail.vuln && nav && typeof nav.go === 'function') {
      nav.go('retest', { vulnId: detail.vuln.id })
    }
  }, [detail, nav])

  return h(VulnsView, {
    t,
    locale,
    listState,
    searchInput,
    list,
    listFilters: list.data ? list.data.filters : null,
    selectedId,
    detail,
    statusDraft,
    saving,
    readOnly,
    onSearchChange,
    onFilterChange,
    onReset,
    onRefresh,
    onSelect: selectVuln,
    onPage,
    onPageSize,
    onStatusDraftChange,
    onApplyStatus,
    onRetest,
  })
}

// ---------------------------------------------------------------- i18n

const messages = {
  zh: {
    'filters.search': '搜索',
    'filters.searchAria': '搜索漏洞',
    'filters.searchPlaceholder': '搜索 ID / 名称 / Host',
    'filters.severity': '严重级别',
    'filters.severityAria': '按严重级别筛选',
    'filters.status': '状态',
    'filters.statusAria': '按状态筛选',
    'filters.realm': 'Realm',
    'filters.realmAria': '按 Realm 筛选',
    'filters.reset': '重置筛选',
    'filters.resetHint': '清除搜索与所有筛选条件',
    'list.aria': '漏洞列表',
    'list.loading': '正在加载漏洞列表…',
    'list.empty': '暂无漏洞',
    'list.emptyHint': '数据库中还没有漏洞记录。',
    'list.emptyFiltered': '没有匹配的漏洞',
    'list.emptyFilteredHint': '当前搜索/筛选条件下没有结果，可重置筛选后重试。',
    'list.col.id': 'ID',
    'list.col.name': '名称',
    'list.col.host': 'Host',
    'list.col.severity': '级别',
    'list.col.status': '状态',
    'list.col.realm': 'Realm',
    'list.col.created': '时间',
    'list.retestCount': '复测 {count} 次',
    'detail.noSelection': '选择一条漏洞',
    'detail.noSelectionHint': '在列表中选择漏洞，查看详情、复测历史、关联漏洞与报告。',
    'detail.loading': '正在加载漏洞详情…',
    'detail.notFound': '漏洞不存在或已被删除',
    'detail.statusLabel': '状态',
    'detail.statusEditorAria': '变更漏洞状态',
    'detail.applyStatus': '应用',
    'detail.saving': '保存中…',
    'detail.readOnly': '只读模式：状态修改已禁用',
    'detail.download': '下载报告',
    'detail.downloadHint': '下载 Markdown 报告',
    'detail.retest': '去复测',
    'detail.meta': '元信息',
    'detail.description': '描述',
    'detail.impact': '影响',
    'detail.interfaces': '受影响接口',
    'detail.reproduction': '复现步骤',
    'detail.remediation': '修复建议',
    'detail.retests': '复测记录',
    'detail.related': '关联漏洞',
    'detail.crypto': '加密细节',
    'detail.testBoundaries': '测试边界',
    'detail.retestIndex': '复测 {index}',
    'detail.retestTimeRange': '时间范围',
    'detail.noRetests': '暂无复测记录',
    'detail.openRelated': '打开关联漏洞 {id}',
    'detail.field.vulnType': '类型',
    'detail.field.host': 'Host',
    'detail.field.createdAt': '创建时间',
    'detail.field.latestRetestAt': '最近复测',
    'detail.field.retestCount': '复测次数',
    'detail.field.targetUrl': '目标 URL',
    'detail.field.entryPoint': '入口',
    'detail.field.serviceHost': '内网服务',
    'detail.field.internalServiceId': '内网服务 ID',
    'severity.Critical': '严重',
    'severity.High': '高',
    'severity.Medium': '中',
    'severity.Low': '低',
    'severity.Info': '信息',
    'status.Confirmed': '已确认',
    'status.Inconclusive': '不确定',
    'status.Retest_Passed': '复测通过',
    'realm.web': 'Web',
    'realm.internal': '内网',
    'toast.statusSaved': '状态已更新为 {status}',
    'toast.statusFailed': '状态更新失败：{message}',
  },
  en: {
    'filters.search': 'Search',
    'filters.searchAria': 'Search vulnerabilities',
    'filters.searchPlaceholder': 'Search ID / name / host',
    'filters.severity': 'Severity',
    'filters.severityAria': 'Filter by severity',
    'filters.status': 'Status',
    'filters.statusAria': 'Filter by status',
    'filters.realm': 'Realm',
    'filters.realmAria': 'Filter by realm',
    'filters.reset': 'Reset filters',
    'filters.resetHint': 'Clear the search box and all filters',
    'list.aria': 'Vulnerability list',
    'list.loading': 'Loading vulnerabilities…',
    'list.empty': 'No vulnerabilities',
    'list.emptyHint': 'The Cortex database has no vulnerability records yet.',
    'list.emptyFiltered': 'No matching vulnerabilities',
    'list.emptyFilteredHint': 'Nothing matches the current search and filters. Reset the filters and try again.',
    'list.col.id': 'ID',
    'list.col.name': 'Name',
    'list.col.host': 'Host',
    'list.col.severity': 'Severity',
    'list.col.status': 'Status',
    'list.col.realm': 'Realm',
    'list.col.created': 'Created',
    'list.retestCount': '{count} retests',
    'detail.noSelection': 'Select a vulnerability',
    'detail.noSelectionHint':
      'Pick a vulnerability from the list to see its details, retest history, related vulnerabilities and report.',
    'detail.loading': 'Loading vulnerability details…',
    'detail.notFound': 'The vulnerability does not exist or was deleted',
    'detail.statusLabel': 'Status',
    'detail.statusEditorAria': 'Change vulnerability status',
    'detail.applyStatus': 'Apply',
    'detail.saving': 'Saving…',
    'detail.readOnly': 'Read-only mode: status changes are disabled',
    'detail.download': 'Download report',
    'detail.downloadHint': 'Download the Markdown report',
    'detail.retest': 'Retest',
    'detail.meta': 'Metadata',
    'detail.description': 'Description',
    'detail.impact': 'Impact',
    'detail.interfaces': 'Affected interfaces',
    'detail.reproduction': 'Reproduction steps',
    'detail.remediation': 'Remediation',
    'detail.retests': 'Retest history',
    'detail.related': 'Related vulnerabilities',
    'detail.crypto': 'Crypto details',
    'detail.testBoundaries': 'Test boundaries',
    'detail.retestIndex': 'Retest {index}',
    'detail.retestTimeRange': 'Time range',
    'detail.noRetests': 'No retests recorded',
    'detail.openRelated': 'Open related vulnerability {id}',
    'detail.field.vulnType': 'Type',
    'detail.field.host': 'Host',
    'detail.field.createdAt': 'Created',
    'detail.field.latestRetestAt': 'Last retest',
    'detail.field.retestCount': 'Retests',
    'detail.field.targetUrl': 'Target URL',
    'detail.field.entryPoint': 'Entry point',
    'detail.field.serviceHost': 'Service host',
    'detail.field.internalServiceId': 'Internal service ID',
    'severity.Critical': 'Critical',
    'severity.High': 'High',
    'severity.Medium': 'Medium',
    'severity.Low': 'Low',
    'severity.Info': 'Info',
    'status.Confirmed': 'Confirmed',
    'status.Inconclusive': 'Inconclusive',
    'status.Retest_Passed': 'Retest passed',
    'realm.web': 'Web',
    'realm.internal': 'Internal',
    'toast.statusSaved': 'Status updated to {status}',
    'toast.statusFailed': 'Failed to update status: {message}',
  },
}

module.exports = { id: 'vulns', messages, Component }
