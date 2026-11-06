// Overview page: realm counts, severity/status distribution, hosts/assets,
// projects and the most recent vulnerabilities. Read-only.
// Owner: client-aux.
const {
  h,
  React,
  Button,
  Badge,
  Card,
  Spinner,
  Empty,
  ErrorBox,
  DataTable,
  Mono,
  sevBadge,
  statusBadge,
  realmTone,
} = require('../ui/kit.js')
const { fmtTime, asArray, asObject } = require('../lib/format.js')

const { useState, useEffect } = React

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']
const STATUSES = ['Confirmed', 'Inconclusive', 'Retest_Passed']

const SEVERITY_FILL = {
  Critical: 'var(--dsw-alias-state-error-primary)',
  High: 'var(--dsw-alias-state-warn-primary)',
  Medium: 'var(--dsw-alias-brand-primary)',
  Low: 'var(--dsw-alias-state-success-primary)',
  Info: 'var(--dsw-alias-state-idle-primary)',
}

const messages = {
  zh: {
    'metric.web': 'Web 漏洞',
    'metric.internal': '内网漏洞',
    'metric.total': '漏洞总数',
    'metric.hosts': '涉及 Host',
    'metric.assets': '资产',
    'severity.title': '严重级别分布',
    'severity.aria': '严重级别分布',
    'status.title': '状态分布',
    'status.aria': '状态分布',
    'severity.Critical': '严重',
    'severity.High': '高危',
    'severity.Medium': '中危',
    'severity.Low': '低危',
    'severity.Info': '信息',
    'status.Confirmed': '已确认',
    'status.Inconclusive': '不确定',
    'status.Retest_Passed': '复测通过',
    'realm.web': 'Web',
    'realm.internal': '内网',
    'projects.title': '项目',
    'projects.aria': '项目列表',
    'projects.empty': '暂无项目',
    'projects.emptyHint': '在 Cortex 中记录资产或快照后，项目会显示在这里。',
    'recent.title': '最近漏洞',
    'recent.aria': '最近漏洞',
    'recent.empty': '暂无漏洞记录',
    'recent.emptyHint': '通过 Cortex MCP 记录漏洞后，最近漏洞会显示在这里。',
    'recent.openAll': '打开漏洞页',
    'empty.title': 'Cortex 数据库还没有数据',
    'empty.hint': '通过 Cortex MCP 记录漏洞、资产、内网信息和快照后，这里会显示统计信息。',
    'col.id': 'ID',
    'col.name': '名称',
    'col.host': 'Host',
    'col.severity': '级别',
    'col.status': '状态',
    'col.realm': 'Realm',
    'col.time': '时间',
    'count.row': '{label}：{count}',
  },
  en: {
    'metric.web': 'Web vulnerabilities',
    'metric.internal': 'Internal vulnerabilities',
    'metric.total': 'Total vulnerabilities',
    'metric.hosts': 'Hosts',
    'metric.assets': 'Assets',
    'severity.title': 'Severity distribution',
    'severity.aria': 'Severity distribution',
    'status.title': 'Status distribution',
    'status.aria': 'Status distribution',
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
    'projects.title': 'Projects',
    'projects.aria': 'Project list',
    'projects.empty': 'No projects yet',
    'projects.emptyHint': 'Projects appear here once Cortex has assets or snapshots recorded.',
    'recent.title': 'Recent vulnerabilities',
    'recent.aria': 'Recent vulnerabilities',
    'recent.empty': 'No vulnerabilities recorded',
    'recent.emptyHint': 'Vulnerabilities recorded through the Cortex MCP show up here.',
    'recent.openAll': 'Open vulnerabilities',
    'empty.title': 'The Cortex database is empty',
    'empty.hint': 'Record vulnerabilities, assets, internal data and snapshots through the Cortex MCP to populate this overview.',
    'col.id': 'ID',
    'col.name': 'Name',
    'col.host': 'Host',
    'col.severity': 'Severity',
    'col.status': 'Status',
    'col.realm': 'Realm',
    'col.time': 'Time',
    'count.row': '{label}: {count}',
  },
}

// ---------------------------------------------------------------- helpers

function isAbortError(error) {
  return !!error && (error.code === 'ABORTED' || error.name === 'AbortError')
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function goToVulns(nav, vulnId) {
  if (nav && typeof nav.go === 'function') nav.go('vulns', { vulnId })
}

function labelOr(t, key, fallback) {
  const value = t(key)
  return value === key ? fallback : value
}

// ---------------------------------------------------------------- presentational

function MetricCard(props) {
  return h(
    Card,
    { flush: true },
    h(
      'div',
      { className: 'dshc-metric' },
      h('div', { className: 'dshc-metric-value' }, props.value),
      h('div', { className: 'dshc-metric-label' }, props.label),
    ),
  )
}

function DistributionRows(props) {
  const items = asArray(props.items)
  return h(
    'div',
    { className: 'dshc-col', style: { gap: 8 } },
    items.map((item) =>
      h(
        'div',
        {
          key: item.label,
          className: 'dshc-flex',
          style: { gap: 10, flexWrap: 'nowrap' },
          role: 'img',
          'aria-label': props.t('count.row', { label: item.label, count: item.value }),
        },
        h(
          'div',
          { className: 'dshc-small dshc-muted', style: { width: 96, flex: '0 0 96px' } },
          item.label,
        ),
        h(
          'div',
          {
            style: {
              flex: '1 1 auto',
              height: 8,
              borderRadius: 999,
              background: 'var(--dsw-alias-bg-layer-2)',
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              width: `${props.max > 0 ? Math.round((item.value / props.max) * 100) : 0}%`,
              height: '100%',
              borderRadius: 999,
              background: item.fill || 'var(--dsw-alias-brand-primary)',
            },
          }),
        ),
        h(
          'div',
          {
            className: 'dshc-small dshc-num',
            style: { width: 34, flex: '0 0 34px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
          },
          item.value,
        ),
      ),
    ),
  )
}

function ProjectsBlock(props) {
  const projects = asArray(props.projects)
  if (projects.length === 0) {
    return h(Empty, { icon: 'layers', title: props.t('projects.empty'), hint: props.t('projects.emptyHint') })
  }
  return h(
    'div',
    { className: 'dshc-flex', 'aria-label': props.t('projects.aria') },
    projects.map((name) =>
      h(Badge, { key: String(name), tone: 'neutral', title: String(name) }, String(name)),
    ),
  )
}

function RecentTable(props) {
  const { t, locale, nav } = props
  const recent = asArray(props.recent)
  const columns = [
    {
      key: 'id',
      label: t('col.id'),
      width: 150,
      render: (row) => h(Mono, { className: 'dshc-nowrap' }, String(row.id || '—')),
    },
    {
      key: 'vulnName',
      label: t('col.name'),
      render: (row) =>
        h(
          'span',
          { className: 'dshc-clamp2', title: row.vulnName || '' },
          row.vulnName || '—',
        ),
    },
    {
      key: 'host',
      label: t('col.host'),
      width: 180,
      render: (row) => h(Mono, { className: 'dshc-break' }, row.host || '—'),
    },
    {
      key: 'severity',
      label: t('col.severity'),
      width: 92,
      render: (row) => sevBadge(row.severity),
    },
    {
      key: 'status',
      label: t('col.status'),
      width: 112,
      render: (row) => statusBadge(row.status),
    },
    {
      key: 'realm',
      label: t('col.realm'),
      width: 82,
      render: (row) =>
        h(
          Badge,
          { tone: realmTone(row.realm) },
          labelOr(t, `realm.${row.realm}`, row.realm || '—'),
        ),
    },
    {
      key: 'createdAt',
      label: t('col.time'),
      width: 150,
      render: (row) => h('span', { className: 'dshc-small dshc-muted' }, fmtTime(row.createdAt, locale)),
    },
  ]
  return h(DataTable, {
    columns,
    rows: recent,
    rowKey: (row) => row.id,
    onRowActivate: (row) => goToVulns(nav, row.id),
    ariaLabel: t('recent.aria'),
    empty: h(Empty, { icon: 'shield', title: t('recent.empty'), hint: t('recent.emptyHint') }),
  })
}

function OverviewView(props) {
  const { t, locale, nav, phase, data, error, onRetry } = props
  if (phase === 'loading') {
    return h('div', { className: 'dshc-page dshc-col' }, h(Spinner, { label: t('common.loading') }))
  }
  if (phase === 'error') {
    return h(
      'div',
      { className: 'dshc-page dshc-col' },
      h(ErrorBox, { error, t, onRetry }),
    )
  }
  const stats = asObject(data)
  const counts = asObject(stats.counts)
  const bySeverity = asObject(stats.bySeverity)
  const byStatus = asObject(stats.byStatus)
  const projects = asArray(stats.projects)
  const recent = asArray(stats.recent)
  const web = count(counts.web)
  const internal = count(counts.internal)
  const total = count(counts.total)
  const hosts = count(stats.hosts)
  const assets = count(stats.assets)
  const isEmpty = total === 0 && hosts === 0 && assets === 0 && projects.length === 0 && recent.length === 0

  const severityMax = SEVERITIES.reduce((max, name) => Math.max(max, count(bySeverity[name])), 0)
  const statusMax = STATUSES.reduce((max, name) => Math.max(max, count(byStatus[name])), 0)

  const metrics = h(
    'div',
    { className: 'dshc-grid dshc-grid-4' },
    h(MetricCard, { key: 'web', value: web, label: t('metric.web') }),
    h(MetricCard, { key: 'internal', value: internal, label: t('metric.internal') }),
    h(MetricCard, { key: 'total', value: total, label: t('metric.total') }),
    h(MetricCard, { key: 'hosts', value: hosts, label: t('metric.hosts') }),
    h(MetricCard, { key: 'assets', value: assets, label: t('metric.assets') }),
  )

  const distributions = h(
    'div',
    { className: 'dshc-grid dshc-grid-2' },
    h(
      Card,
      { title: t('severity.title') },
      h(DistributionRows, {
        t,
        max: severityMax,
        items: SEVERITIES.map((name) => ({
          label: labelOr(t, `severity.${name}`, name),
          value: count(bySeverity[name]),
          fill: SEVERITY_FILL[name],
        })),
      }),
    ),
    h(
      Card,
      { title: t('status.title') },
      h(DistributionRows, {
        t,
        max: statusMax,
        items: STATUSES.map((name) => ({
          label: labelOr(t, `status.${name}`, name),
          value: count(byStatus[name]),
          fill: 'var(--dsw-alias-brand-primary)',
        })),
      }),
    ),
  )

  const recentCard = h(
    Card,
    {
      title: t('recent.title'),
      flush: true,
      actions: [
        h(
          Button,
          {
            key: 'refresh',
            size: 'sm',
            icon: 'refresh',
            onClick: onRetry,
          },
          t('common.refresh'),
        ),
        h(
          Button,
          {
            key: 'open',
            size: 'sm',
            variant: 'ghost',
            icon: 'chevron-right',
            onClick: () => nav && typeof nav.go === 'function' && nav.go('vulns', {}),
          },
          t('recent.openAll'),
        ),
      ],
    },
    h(RecentTable, { t, locale, nav, recent }),
  )

  const projectsCard = h(
    Card,
    { title: t('projects.title') },
    h(ProjectsBlock, { t, projects }),
  )

  return h(
    'div',
    { className: 'dshc-page dshc-col' },
    metrics,
    isEmpty
      ? h(Card, null, h(Empty, { icon: 'database', title: t('empty.title'), hint: t('empty.hint') }))
      : null,
    isEmpty ? null : distributions,
    isEmpty ? null : recentCard,
    isEmpty ? null : projectsCard,
  )
}

// ---------------------------------------------------------------- page

function Component(props) {
  const { api, rev } = props
  const [state, setState] = useState({ phase: 'loading', data: null, error: null })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    setState({ phase: 'loading', data: null, error: null })
    api.get('/stats').then(
      (data) => {
        if (alive) setState({ phase: 'ok', data, error: null })
      },
      (error) => {
        if (alive && !isAbortError(error)) setState({ phase: 'error', data: null, error })
      },
    )
    return () => {
      alive = false
    }
  }, [api, rev, nonce])

  const onRetry = () => setNonce((value) => value + 1)

  return h(OverviewView, {
    phase: state.phase,
    data: state.data,
    error: state.error,
    onRetry,
    t: props.t,
    locale: props.locale,
    nav: props.nav,
  })
}

module.exports = { id: 'overview', messages, Component }
