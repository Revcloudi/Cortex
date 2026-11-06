// Assets page: searchable/filtered/paginated asset list with a split detail view
// (tech stack, structured interfaces, interface directory, leaked info,
// test parameters and related vulnerabilities). Read-only.
// Owner: client-aux.
const {
  h,
  React,
  Button,
  Badge,
  Card,
  Toolbar,
  Spinner,
  Empty,
  ErrorBox,
  DataTable,
  Field,
  Input,
  Select,
  Split,
  Pager,
  KeyValue,
  Mono,
  Pre,
  sevBadge,
} = require('../ui/kit.js')
const { fmtTime, fmtRelative, asArray, asObject, truncate } = require('../lib/format.js')

const { useState, useEffect } = React

const ASSET_STATUSES = ['Alive', 'Dead', 'WAF_Blocked']
const ASSET_STATUS_TONE = { Alive: 'success', Dead: 'error', WAF_Blocked: 'warn' }
const INFO_TONE = {
  Credential: 'error',
  API_Key: 'warn',
  Token: 'warn',
  PII: 'warn',
  Internal_IP: 'brand',
  Other: 'neutral',
}

const messages = {
  zh: {
    'search.placeholder': '搜索 host / URL / 项目…',
    'search.aria': '搜索资产',
    'filter.status': '状态',
    'filter.statusAria': '按状态筛选',
    'list.aria': '资产列表',
    'list.interfaces': '{count} 个接口',
    'list.vulns': '{count} 个漏洞',
    'list.empty': '没有匹配的资产',
    'list.emptyHint': '尝试修改搜索关键字或状态筛选，或使用 Cortex MCP 同步资产信息。',
    'list.clearFilters': '清除筛选',
    'list.emptyDb': '还没有登记资产',
    'list.emptyDbHint': '通过 Cortex MCP 的 sync_asset_info 记录 Web 资产后，资产会显示在这里。',
    'detail.empty': '选择一个资产查看详情',
    'detail.emptyHint': '从左侧列表选择资产，查看技术栈、接口、泄露信息与测试参数。',
    'detail.retry': '重试',
    'section.overview': '资产概览',
    'section.interfaces': '结构化接口（{count}）',
    'section.interfaceDir': '接口目录',
    'section.leaked': '泄露信息（{count}）',
    'section.params': '测试参数（{count}）',
    'section.related': '关联漏洞（{count}）',
    'field.hostPort': 'Host / URL',
    'field.host': 'Host',
    'field.project': '项目',
    'field.techStack': '技术栈',
    'field.authRequired': '需要认证',
    'field.status': '状态',
    'field.lastSeen': '最后发现',
    'field.interfaces': '接口数',
    'field.vulns': '漏洞数',
    'value.required': '需要',
    'value.notRequired': '不需要',
    'assetStatus.Alive': 'Alive',
    'assetStatus.Dead': 'Dead',
    'assetStatus.WAF_Blocked': 'WAF 拦截',
    'interface.method': '方法',
    'interface.path': '路径',
    'interface.params': '参数',
    'interface.raw': '原始请求',
    'interface.request': '完整原始 HTTP 请求',
    'interface.noRequest': '没有保存原始请求',
    'interface.aria.expand': '展开接口详情',
    'interface.aria.collapse': '收起接口详情',
    'empty.interfaces': '该资产没有结构化接口记录。',
    'empty.interfaceDir': '没有接口目录记录。',
    'empty.leaked': '没有泄露信息记录。',
    'empty.params': '没有测试参数记录。',
    'empty.related': '没有关联漏洞。',
    'leaked.type': '类型',
    'leaked.value': '值',
    'leaked.source': '来源',
    'leaked.impact': '潜在影响',
    'infoType.Credential': '凭据',
    'infoType.API_Key': 'API Key',
    'infoType.Token': 'Token',
    'infoType.PII': 'PII',
    'infoType.Internal_IP': '内网 IP',
    'infoType.Other': '其他',
    'param.name': '名称',
    'param.endpoint': '端点',
    'param.location': '位置',
    'param.values': '样例值',
    'param.pattern': '枚举规则',
    'param.tested': '已测试',
    'param.notes': '备注',
    'param.valuesAria': '样例值',
    'common.retry': '重试',
    'common.refresh': '刷新',
  },
  en: {
    'search.placeholder': 'Search host / URL / project…',
    'search.aria': 'Search assets',
    'filter.status': 'Status',
    'filter.statusAria': 'Filter by status',
    'list.aria': 'Asset list',
    'list.interfaces': '{count} interfaces',
    'list.vulns': '{count} vulns',
    'list.empty': 'No matching assets',
    'list.emptyHint': 'Change the search text or status filter, or sync asset data through the Cortex MCP.',
    'list.clearFilters': 'Clear filters',
    'list.emptyDb': 'No assets recorded yet',
    'list.emptyDbHint': 'Assets appear here after sync_asset_info records a web asset through the Cortex MCP.',
    'detail.empty': 'Select an asset to see details',
    'detail.emptyHint': 'Pick an asset on the left to inspect its tech stack, interfaces, leaked info and test parameters.',
    'detail.retry': 'Retry',
    'section.overview': 'Asset overview',
    'section.interfaces': 'Structured interfaces ({count})',
    'section.interfaceDir': 'Interface directory',
    'section.leaked': 'Leaked info ({count})',
    'section.params': 'Test parameters ({count})',
    'section.related': 'Related vulnerabilities ({count})',
    'field.hostPort': 'Host / URL',
    'field.host': 'Host',
    'field.project': 'Project',
    'field.techStack': 'Tech stack',
    'field.authRequired': 'Auth required',
    'field.status': 'Status',
    'field.lastSeen': 'Last seen',
    'field.interfaces': 'Interfaces',
    'field.vulns': 'Vulnerabilities',
    'value.required': 'Required',
    'value.notRequired': 'Not required',
    'assetStatus.Alive': 'Alive',
    'assetStatus.Dead': 'Dead',
    'assetStatus.WAF_Blocked': 'WAF blocked',
    'interface.method': 'Method',
    'interface.path': 'Path',
    'interface.params': 'Params',
    'interface.raw': 'Raw request',
    'interface.request': 'Full raw HTTP request',
    'interface.noRequest': 'No raw request stored',
    'interface.aria.expand': 'Expand interface details',
    'interface.aria.collapse': 'Collapse interface details',
    'empty.interfaces': 'This asset has no structured interfaces recorded.',
    'empty.interfaceDir': 'No interface directory recorded.',
    'empty.leaked': 'No leaked info recorded.',
    'empty.params': 'No test parameters recorded.',
    'empty.related': 'No related vulnerabilities.',
    'leaked.type': 'Type',
    'leaked.value': 'Value',
    'leaked.source': 'Source',
    'leaked.impact': 'Potential impact',
    'infoType.Credential': 'Credential',
    'infoType.API_Key': 'API key',
    'infoType.Token': 'Token',
    'infoType.PII': 'PII',
    'infoType.Internal_IP': 'Internal IP',
    'infoType.Other': 'Other',
    'param.name': 'Name',
    'param.endpoint': 'Endpoint',
    'param.location': 'Location',
    'param.values': 'Sample values',
    'param.pattern': 'Enumeration rule',
    'param.tested': 'Tested',
    'param.notes': 'Notes',
    'param.valuesAria': 'Sample values',
    'common.retry': 'Retry',
    'common.refresh': 'Refresh',
  },
}

// ---------------------------------------------------------------- helpers

function isAbortError(error) {
  return !!error && (error.code === 'ABORTED' || error.name === 'AbortError')
}

function labelOr(t, key, fallback) {
  const value = t(key)
  return value === key ? fallback : value
}

function assetStatusLabel(t, status) {
  if (!status) return t('common.unknown')
  return labelOr(t, `assetStatus.${status}`, String(status))
}

function assetStatusTone(status) {
  return ASSET_STATUS_TONE[String(status || '')] || 'neutral'
}

function goToVulns(nav, vulnId) {
  if (nav && typeof nav.go === 'function') nav.go('vulns', { vulnId })
}

function num(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

// ---------------------------------------------------------------- list

function AssetListItem(props) {
  const { item, t, locale, active, onSelect } = props
  const summary = asObject(item)
  return h(
    'button',
    {
      type: 'button',
      className: 'dshc-list-item',
      'aria-current': active ? 'true' : undefined,
      onClick: () => onSelect(summary.hostPort),
    },
    h(
      'span',
      { className: 'dshc-list-main', title: summary.hostPort || '', style: { minWidth: 0, maxWidth: '100%' } },
      summary.hostPort || '—',
    ),
    h(
      'span',
      { className: 'dshc-list-meta' },
      summary.status
        ? h(Badge, { tone: assetStatusTone(summary.status) }, assetStatusLabel(t, summary.status))
        : null,
      summary.projectName ? h('span', null, summary.projectName) : null,
      h('span', null, t('list.interfaces', { count: num(summary.interfaceCount) })),
      h('span', null, t('list.vulns', { count: num(summary.vulnCount) })),
      summary.lastSeen ? h('span', null, fmtRelative(summary.lastSeen, locale)) : null,
    ),
  )
}

function AssetListPanel(props) {
  const { t, locale, list, selectedHostPort, onSelect } = props
  if (list.phase === 'loading') return h(Spinner, { label: t('common.loading') })
  if (list.phase === 'error') {
    return h(ErrorBox, { error: list.error, t, onRetry: props.onRetry })
  }
  const data = asObject(list.data)
  const items = asArray(data.items)
  if (items.length === 0) {
    const filtered = !!(props.search || props.status)
    return h(Empty, {
      icon: 'server',
      title: filtered ? t('list.empty') : t('list.emptyDb'),
      hint: filtered ? t('list.emptyHint') : t('list.emptyDbHint'),
      action: filtered
        ? h(Button, { size: 'sm', onClick: props.onClearFilters }, t('list.clearFilters'))
        : null,
    })
  }
  return h(
    'div',
    { className: 'dshc-col', style: { gap: 0 } },
    h(
      'div',
      { role: 'list', 'aria-label': t('list.aria') },
      items.map((item) => {
        const summary = asObject(item)
        const key = summary.hostPort || JSON.stringify(summary)
        return h(
          'div',
          { key, role: 'listitem' },
          h(AssetListItem, {
            item: summary,
            t,
            locale,
            active: selectedHostPort === summary.hostPort,
            onSelect,
          }),
        )
      }),
    ),
    h(Pager, {
      page: num(data.page) || 1,
      pages: num(data.pages) || 1,
      total: num(data.total),
      pageSize: props.pageSize,
      onPage: props.onPage,
      onPageSize: props.onPageSize,
      t,
    }),
  )
}

// ---------------------------------------------------------------- detail sections

function InterfaceEntry(props) {
  const { item, t } = props
  const entry = asObject(item)
  const [open, setOpen] = useState(false)
  const params = entry.params === undefined || entry.params === null ? '' : String(entry.params)
  const request = entry.request === undefined || entry.request === null ? '' : String(entry.request)
  const buttonLabel = open ? t('interface.aria.collapse') : t('interface.aria.expand')
  return h(
    'div',
    {
      className: 'dshc-col',
      style: {
        gap: 6,
        padding: '8px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
    },
    h(
      'div',
      { className: 'dshc-flex' },
      entry.method ? h(Badge, { tone: 'brand' }, String(entry.method)) : null,
      h(Mono, { className: 'dshc-break' }, entry.path || '—'),
      h('div', { className: 'dshc-spacer' }),
      h(
        Button,
        {
          size: 'sm',
          variant: 'ghost',
          icon: open ? 'chevron-down' : 'chevron-right',
          'aria-label': buttonLabel,
          title: buttonLabel,
          onClick: () => setOpen((value) => !value),
        },
        t('interface.raw'),
      ),
    ),
    open
      ? h(
          'div',
          { className: 'dshc-col', style: { gap: 6 } },
          params
            ? h(
                'div',
                { className: 'dshc-col', style: { gap: 2 } },
                h('div', { className: 'dshc-small dshc-muted' }, t('interface.params')),
                h(Pre, { 'aria-label': t('interface.params') }, params),
              )
            : null,
          request
            ? h(
                'div',
                { className: 'dshc-col', style: { gap: 2 } },
                h('div', { className: 'dshc-small dshc-muted' }, t('interface.request')),
                h(Pre, { 'aria-label': t('interface.request') }, request),
              )
            : h('div', { className: 'dshc-small dshc-muted' }, t('interface.noRequest')),
        )
      : null,
  )
}

function InterfaceList(props) {
  const interfaces = asArray(props.interfaces)
  if (interfaces.length === 0) {
    return h('div', { className: 'dshc-muted dshc-small' }, props.t('empty.interfaces'))
  }
  return h(
    'div',
    { className: 'dshc-col', style: { gap: 0 } },
    interfaces.map((item, index) =>
      h(InterfaceEntry, {
        key: `${asObject(item).path || 'interface'}-${index}`,
        item,
        t: props.t,
      }),
    ),
  )
}

function LeakedInfoCard(props) {
  const { item, t } = props
  const info = asObject(item)
  const type = String(info.infoType || 'Other')
  return h(
    'div',
    {
      className: 'dshc-col',
      style: {
        gap: 6,
        padding: 10,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
      },
    },
    h(
      'div',
      { className: 'dshc-flex' },
      h(Badge, { tone: INFO_TONE[type] || 'neutral' }, labelOr(t, `infoType.${type}`, type)),
      info.source ? h('span', { className: 'dshc-small dshc-muted dshc-break' }, String(info.source)) : null,
    ),
    info.value
      ? h(
          'div',
          { className: 'dshc-col', style: { gap: 2 } },
          h('div', { className: 'dshc-small dshc-muted' }, t('leaked.value')),
          h(Pre, { 'aria-label': t('leaked.value') }, String(info.value)),
        )
      : null,
    info.potentialImpact
      ? h(
          'div',
          { className: 'dshc-col', style: { gap: 2 } },
          h('div', { className: 'dshc-small dshc-muted' }, t('leaked.impact')),
          h('div', { className: 'dshc-small dshc-break' }, String(info.potentialImpact)),
        )
      : null,
  )
}

function TestParametersTable(props) {
  const { t, locale } = props
  const params = asArray(props.params)
  const columns = [
    {
      key: 'name',
      label: t('param.name'),
      width: 140,
      render: (row) => h(Mono, { className: 'dshc-break' }, row.name || '—'),
    },
    {
      key: 'endpoint',
      label: t('param.endpoint'),
      width: 180,
      render: (row) => h(Mono, { className: 'dshc-break' }, row.endpoint || '—'),
    },
    {
      key: 'location',
      label: t('param.location'),
      width: 90,
      render: (row) => (row.location ? h(Badge, { tone: 'neutral' }, String(row.location)) : '—'),
    },
    {
      key: 'values',
      label: t('param.values'),
      render: (row) => {
        const values = asArray(row.values)
        if (values.length === 0) return '—'
        const text = values.join(', ')
        return h(
          Mono,
          { className: 'dshc-break', title: text },
          truncate(text, 80),
        )
      },
    },
    {
      key: 'pattern',
      label: t('param.pattern'),
      width: 160,
      render: (row) => (row.pattern ? h(Mono, { className: 'dshc-break' }, String(row.pattern)) : '—'),
    },
    {
      key: 'tested',
      label: t('param.tested'),
      width: 86,
      render: (row) =>
        h(Badge, { tone: row.tested ? 'success' : 'idle' }, row.tested ? t('common.yes') : t('common.no')),
    },
    {
      key: 'notes',
      label: t('param.notes'),
      render: (row) => (row.notes ? h('span', { className: 'dshc-small dshc-break' }, String(row.notes)) : '—'),
    },
  ]
  return h(DataTable, {
    columns,
    rows: params,
    rowKey: (row, index) => row.name || index,
    dense: true,
    ariaLabel: t('section.params', { count: params.length }),
  })
}

function RelatedVulns(props) {
  const { t, nav, related, relatedVulnIds } = props
  const summaries = asArray(related)
  const ids = []
  for (const summary of summaries) {
    const id = asObject(summary).id
    if (id && ids.indexOf(String(id)) < 0) ids.push(String(id))
  }
  for (const rawId of asArray(relatedVulnIds)) {
    const id = String(rawId)
    if (id && ids.indexOf(id) < 0) ids.push(id)
  }
  if (ids.length === 0) {
    return h('div', { className: 'dshc-muted dshc-small' }, t('empty.related'))
  }
  return h(
    'div',
    { className: 'dshc-col', style: { gap: 6 } },
    ids.map((id) => {
      const summary = summaries.filter((item) => asObject(item).id === id)[0]
      const data = asObject(summary)
      return h(
        'div',
        { key: id, className: 'dshc-flex' },
        h(
          Button,
          {
            size: 'sm',
            onClick: () => goToVulns(nav, id),
            title: data.vulnName || id,
          },
          h(Mono, null, id),
          data.vulnName ? h('span', { className: 'dshc-small' }, truncate(data.vulnName, 60)) : null,
        ),
        summary ? sevBadge(data.severity) : null,
      )
    }),
  )
}

function AssetDetailView(props) {
  const { t, locale, nav, data, onRetry } = props
  const payload = asObject(data)
  const asset = asObject(payload.asset)
  const related = asArray(payload.related)
  const interfaces = asArray(asset.interfaces)
  const interfaceDir = asArray(asset.interfaceDir)
  const leakedInfos = asArray(asset.leakedInfos)
  const testParameters = asArray(asset.testParameters)

  const overviewItems = [
    [t('field.host'), asset.host ? h(Mono, null, String(asset.host)) : '—'],
    [t('field.project'), asset.projectName || '—'],
    [
      t('field.techStack'),
      asset.techStack ? h('span', { className: 'dshc-break' }, String(asset.techStack)) : '—',
    ],
    [
      t('field.authRequired'),
      h(
        Badge,
        { tone: asset.authRequired ? 'warn' : 'neutral' },
        asset.authRequired ? t('value.required') : t('value.notRequired'),
      ),
    ],
    [
      t('field.status'),
      asset.status ? h(Badge, { tone: assetStatusTone(asset.status) }, assetStatusLabel(t, asset.status)) : '—',
    ],
    [
      t('field.lastSeen'),
      asset.lastSeen
        ? h(
            Badge,
            { tone: 'idle', title: fmtTime(asset.lastSeen, locale) },
            fmtRelative(asset.lastSeen, locale),
          )
        : '—',
    ],
  ]

  return h(
    'div',
    { className: 'dshc-col' },
    h(
      Card,
      {
        title: asset.hostPort || '—',
        subtitle: t('section.overview'),
        actions: [
          h(
            Button,
            { key: 'refresh', size: 'sm', icon: 'refresh', onClick: onRetry },
            t('common.refresh'),
          ),
        ],
      },
      h('div', { className: 'dshc-col' }, h(KeyValue, { items: overviewItems })),
    ),
    h(
      Card,
      { title: t('section.interfaces', { count: interfaces.length }) },
      h(InterfaceList, { interfaces, t }),
    ),
    h(
      Card,
      { title: t('section.interfaceDir') },
      interfaceDir.length === 0
        ? h('div', { className: 'dshc-muted dshc-small' }, t('empty.interfaceDir'))
        : h(
            'div',
            { className: 'dshc-col', style: { gap: 4 } },
            interfaceDir.map((pathText, index) =>
              h(
                'div',
                { key: `${String(pathText)}-${index}`, className: 'dshc-flex' },
                h(Mono, { className: 'dshc-break' }, String(pathText)),
              ),
            ),
          ),
    ),
    h(
      Card,
      { title: t('section.leaked', { count: leakedInfos.length }) },
      leakedInfos.length === 0
        ? h('div', { className: 'dshc-muted dshc-small' }, t('empty.leaked'))
        : h(
            'div',
            { className: 'dshc-grid dshc-grid-2' },
            leakedInfos.map((item, index) =>
              h(LeakedInfoCard, {
                key: `${asObject(item).infoType || 'info'}-${index}`,
                item,
                t,
              }),
            ),
          ),
    ),
    h(
      Card,
      { title: t('section.params', { count: testParameters.length }), flush: testParameters.length > 0 },
      testParameters.length === 0
        ? h('div', { className: 'dshc-muted dshc-small' }, t('empty.params'))
        : h(TestParametersTable, { t, locale, params: testParameters }),
    ),
    h(
      Card,
      { title: t('section.related', { count: related.length }) },
      h(RelatedVulns, { t, nav, related, relatedVulnIds: asset.relatedVulnIds }),
    ),
  )
}

// ---------------------------------------------------------------- page

function Component(props) {
  const { api, rev, nav } = props
  const navParams = asObject(nav && nav.params)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [listNonce, setListNonce] = useState(0)
  const [list, setList] = useState({ phase: 'loading', data: null, error: null })
  const [selectedHostPort, setSelectedHostPort] = useState(
    navParams.hostPort ? String(navParams.hostPort) : null,
  )
  const [detailNonce, setDetailNonce] = useState(0)
  const [detail, setDetail] = useState({ phase: 'idle', data: null, error: null })

  useEffect(() => {
    let alive = true
    setList({ phase: 'loading', data: null, error: null })
    api.get('/assets', { search, status, page, pageSize }).then(
      (data) => {
        if (alive) setList({ phase: 'ok', data, error: null })
      },
      (error) => {
        if (alive && !isAbortError(error)) setList({ phase: 'error', data: null, error })
      },
    )
    return () => {
      alive = false
    }
  }, [api, rev, search, status, page, pageSize, listNonce])

  useEffect(() => {
    if (!selectedHostPort) {
      setDetail({ phase: 'idle', data: null, error: null })
      return undefined
    }
    let alive = true
    setDetail({ phase: 'loading', data: null, error: null })
    api.get(`/assets/${encodeURIComponent(selectedHostPort)}`).then(
      (data) => {
        if (alive) setDetail({ phase: 'ok', data, error: null })
      },
      (error) => {
        if (alive && !isAbortError(error)) setDetail({ phase: 'error', data: null, error })
      },
    )
    return () => {
      alive = false
    }
  }, [api, rev, selectedHostPort, detailNonce])

  const reloadList = () => setListNonce((value) => value + 1)
  const reloadDetail = () => setDetailNonce((value) => value + 1)

  const statusOptions = [{ value: '', label: props.t('common.all') }].concat(
    ASSET_STATUSES.map((value) => ({ value, label: assetStatusLabel(props.t, value) })),
  )

  let detailPanel
  if (!selectedHostPort) {
    detailPanel = h(
      Card,
      null,
      h(Empty, { icon: 'server', title: props.t('detail.empty'), hint: props.t('detail.emptyHint') }),
    )
  } else if (detail.phase === 'loading') {
    detailPanel = h(Card, null, h(Spinner, { label: props.t('common.loading') }))
  } else if (detail.phase === 'error') {
    detailPanel = h(
      Card,
      null,
      h(ErrorBox, { error: detail.error, t: props.t, onRetry: reloadDetail, retryLabel: props.t('detail.retry') }),
    )
  } else {
    detailPanel = h(AssetDetailView, {
      t: props.t,
      locale: props.locale,
      nav,
      data: detail.data,
      onRetry: reloadDetail,
    })
  }

  return h(
    'div',
    { className: 'dshc-page dshc-col' },
    h(
      Toolbar,
      {
        right: h(
          Button,
          {
            size: 'sm',
            icon: 'refresh',
            onClick: () => {
              reloadList()
              if (selectedHostPort) reloadDetail()
            },
          },
          props.t('common.refresh'),
        ),
      },
      h(
        Field,
        { label: props.t('search.aria'), style: { width: 260 } },
        h(Input, {
          value: search,
          placeholder: props.t('search.placeholder'),
          'aria-label': props.t('search.aria'),
          onChange: (event) => {
            setSearch(event.target.value)
            setPage(1)
          },
        }),
      ),
      h(
        Field,
        { label: props.t('filter.status'), style: { width: 170 } },
        h(Select, {
          value: status,
          options: statusOptions,
          'aria-label': props.t('filter.statusAria'),
          onChange: (event) => {
            setStatus(event.target.value)
            setPage(1)
          },
        }),
      ),
    ),
    h(Split, {
      list: h(AssetListPanel, {
        t: props.t,
        locale: props.locale,
        list,
        search,
        status,
        pageSize,
        selectedHostPort,
        onSelect: (hostPort) => setSelectedHostPort(hostPort || null),
        onPage: setPage,
        onPageSize: (size) => {
          setPageSize(size)
          setPage(1)
        },
        onClearFilters: () => {
          setSearch('')
          setStatus('')
          setPage(1)
        },
        onRetry: reloadList,
      }),
      detail: detailPanel,
      emptyDetail: h(Empty, { icon: 'server' }),
      breakpoint: 860,
    }),
  )
}

module.exports = { id: 'assets', messages, Component }
