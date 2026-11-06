// Internal page: project selector, stats and read-only tables for footholds,
// hosts, services, credentials (masked only), pivots and the optional relation
// graph edge list. Read-only.
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
  Select,
  KeyValue,
  Mono,
} = require('../ui/kit.js')
const { fmtTime, fmtRelative, asArray, asObject, truncate } = require('../lib/format.js')

const { useState, useEffect } = React

const messages = {
  zh: {
    'selector.project': '项目',
    'selector.projectAria': '选择内网项目',
    'selector.empty': '没有项目',
    'stat.footholds': 'Foothold',
    'stat.hosts': '主机',
    'stat.services': '服务',
    'stat.credentials': '凭据',
    'stat.pivots': 'Pivot',
    'empty.projects': '还没有内网作战数据',
    'empty.projectsHint': '通过 Cortex MCP 的 sync_internal_scope 登记 foothold、内网主机、服务与 pivot 后，这里会显示数据。',
    'empty.overview': '该项目还没有内网作战数据',
    'empty.overviewHint': '该项目已登记，但 footholds / hosts / services / credentials / pivots 都为空。',
    'table.footholds': 'Footholds',
    'table.hosts': '内网主机',
    'table.services': '内网服务',
    'table.credentials': '凭据（已脱敏）',
    'table.pivots': 'Pivots',
    'table.empty': '暂无记录',
    'table.emptyHint': '该表当前没有数据。',
    'col.id': 'ID',
    'col.entryHostPort': '入口',
    'col.entryVulnId': '入口漏洞',
    'col.accessType': '访问类型',
    'col.privilege': '权限级别',
    'col.status': '状态',
    'col.hostIds': '可达主机',
    'col.established': '建立时间',
    'col.lastVerified': '最后验证',
    'col.notes': '备注',
    'col.ip': 'IP',
    'col.hostname': '主机名',
    'col.os': '操作系统',
    'col.subnet': '网段',
    'col.state': '状态',
    'col.source': '来源',
    'col.confidence': '可信度',
    'col.lastSeen': '最后发现',
    'col.hostId': 'Host ID',
    'col.port': '端口',
    'col.protocol': '协议',
    'col.service': '服务',
    'col.banner': 'Banner',
    'col.username': '用户名',
    'col.domain': '域',
    'col.type': '类型',
    'col.secret': '密码（脱敏）',
    'col.secretLength': '长度',
    'col.footholdId': 'Foothold ID',
    'col.kind': '类型',
    'col.local': '本地端点',
    'col.tool': '工具',
    'col.hops': '跳数链路',
    'col.reachable': '可达网段',
    'graph.title': '关系图（边列表）',
    'graph.nodes': '节点',
    'graph.edges': '边',
    'graph.empty': '没有关系边。',
    'graph.unavailable': '关系图暂不可用。',
    'graph.col.from': '起点',
    'graph.col.to': '终点',
    'graph.col.kind': '关系',
    'accessType.rce': 'RCE',
    'accessType.webshell': 'WebShell',
    'accessType.ssrf_proxy': 'SSRF 代理',
    'accessType.credential': '凭据',
    'accessType.vpn': 'VPN',
    'accessType.other': '其他',
    'privilege.user': '普通用户',
    'privilege.admin': '管理员',
    'privilege.system': 'SYSTEM',
    'privilege.domain_admin': '域管',
    'privilege.unknown': '未知',
    'footholdStatus.planned': '计划中',
    'footholdStatus.established': '已建立',
    'footholdStatus.degraded': '降级',
    'footholdStatus.lost': '已丢失',
    'hostState.unknown': '未知',
    'hostState.alive': '存活',
    'hostState.compromised': '已失陷',
    'hostState.unreachable': '不可达',
    'hostState.firewalled': '防火墙隔离',
    'serviceState.open': '开放',
    'serviceState.closed': '关闭',
    'serviceState.filtered': '过滤',
    'serviceState.unknown': '未知',
    'credStatus.untested': '未测试',
    'credStatus.valid': '有效',
    'credStatus.invalid': '无效',
    'credStatus.expired': '过期',
    'pivotKind.chain': '链路',
    'pivotKind.proxy': '代理',
    'pivotStatus.planned': '计划中',
    'pivotStatus.established': '已建立',
    'pivotStatus.degraded': '降级',
    'pivotStatus.lost': '已丢失',
    'secretLen': '长度 {count}',
    'common.refresh': '刷新',
    'common.retry': '重试',
  },
  en: {
    'selector.project': 'Project',
    'selector.projectAria': 'Choose an internal project',
    'selector.empty': 'No projects',
    'stat.footholds': 'Footholds',
    'stat.hosts': 'Hosts',
    'stat.services': 'Services',
    'stat.credentials': 'Credentials',
    'stat.pivots': 'Pivots',
    'empty.projects': 'No internal operations data yet',
    'empty.projectsHint': 'Register footholds, internal hosts, services and pivots through the Cortex MCP sync_internal_scope and they appear here.',
    'empty.overview': 'This project has no internal operations data',
    'empty.overviewHint': 'The project exists but its footholds / hosts / services / credentials / pivots are all empty.',
    'table.footholds': 'Footholds',
    'table.hosts': 'Internal hosts',
    'table.services': 'Internal services',
    'table.credentials': 'Credentials (masked)',
    'table.pivots': 'Pivots',
    'table.empty': 'No records',
    'table.emptyHint': 'This table currently has no data.',
    'col.id': 'ID',
    'col.entryHostPort': 'Entry',
    'col.entryVulnId': 'Entry vuln',
    'col.accessType': 'Access type',
    'col.privilege': 'Privilege',
    'col.status': 'Status',
    'col.hostIds': 'Hosts',
    'col.established': 'Established',
    'col.lastVerified': 'Last verified',
    'col.notes': 'Notes',
    'col.ip': 'IP',
    'col.hostname': 'Hostname',
    'col.os': 'OS',
    'col.subnet': 'Subnet',
    'col.state': 'State',
    'col.source': 'Source',
    'col.confidence': 'Confidence',
    'col.lastSeen': 'Last seen',
    'col.hostId': 'Host ID',
    'col.port': 'Port',
    'col.protocol': 'Protocol',
    'col.service': 'Service',
    'col.banner': 'Banner',
    'col.username': 'Username',
    'col.domain': 'Domain',
    'col.type': 'Type',
    'col.secret': 'Secret (masked)',
    'col.secretLength': 'Length',
    'col.footholdId': 'Foothold ID',
    'col.kind': 'Kind',
    'col.local': 'Local endpoint',
    'col.tool': 'Tool',
    'col.hops': 'Hops',
    'col.reachable': 'Reachable subnets',
    'graph.title': 'Relation graph (edge list)',
    'graph.nodes': 'nodes',
    'graph.edges': 'edges',
    'graph.empty': 'No relation edges.',
    'graph.unavailable': 'The relation graph is not available.',
    'graph.col.from': 'From',
    'graph.col.to': 'To',
    'graph.col.kind': 'Relation',
    'accessType.rce': 'RCE',
    'accessType.webshell': 'WebShell',
    'accessType.ssrf_proxy': 'SSRF proxy',
    'accessType.credential': 'Credential',
    'accessType.vpn': 'VPN',
    'accessType.other': 'Other',
    'privilege.user': 'User',
    'privilege.admin': 'Admin',
    'privilege.system': 'SYSTEM',
    'privilege.domain_admin': 'Domain admin',
    'privilege.unknown': 'Unknown',
    'footholdStatus.planned': 'Planned',
    'footholdStatus.established': 'Established',
    'footholdStatus.degraded': 'Degraded',
    'footholdStatus.lost': 'Lost',
    'hostState.unknown': 'Unknown',
    'hostState.alive': 'Alive',
    'hostState.compromised': 'Compromised',
    'hostState.unreachable': 'Unreachable',
    'hostState.firewalled': 'Firewalled',
    'serviceState.open': 'Open',
    'serviceState.closed': 'Closed',
    'serviceState.filtered': 'Filtered',
    'serviceState.unknown': 'Unknown',
    'credStatus.untested': 'Untested',
    'credStatus.valid': 'Valid',
    'credStatus.invalid': 'Invalid',
    'credStatus.expired': 'Expired',
    'pivotKind.chain': 'Chain',
    'pivotKind.proxy': 'Proxy',
    'pivotStatus.planned': 'Planned',
    'pivotStatus.established': 'Established',
    'pivotStatus.degraded': 'Degraded',
    'pivotStatus.lost': 'Lost',
    'secretLen': 'len {count}',
    'common.refresh': 'Refresh',
    'common.retry': 'Retry',
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

function num(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function goToVulns(nav, vulnId) {
  if (nav && typeof nav.go === 'function') nav.go('vulns', { vulnId })
}

const HOST_STATE_TONE = {
  alive: 'success',
  compromised: 'error',
  unreachable: 'idle',
  firewalled: 'warn',
  unknown: 'neutral',
}
const FOOTHOLD_STATUS_TONE = { planned: 'idle', established: 'success', degraded: 'warn', lost: 'error' }
const SERVICE_STATE_TONE = { open: 'success', closed: 'neutral', filtered: 'warn', unknown: 'idle' }
const CRED_STATUS_TONE = { untested: 'idle', valid: 'success', invalid: 'error', expired: 'warn' }
const PIVOT_STATUS_TONE = { planned: 'idle', established: 'success', degraded: 'warn', lost: 'error' }
const PRIVILEGE_TONE = {
  user: 'neutral',
  admin: 'warn',
  system: 'error',
  domain_admin: 'error',
  unknown: 'idle',
}

function stateBadge(t, prefix, value, toneMap) {
  if (!value) return '—'
  const key = `${prefix}.${value}`
  const label = labelOr(t, key, String(value))
  return h(Badge, { tone: (toneMap && toneMap[String(value)]) || 'neutral' }, label)
}

function hostEndpoint(pivot) {
  const host = pivot.localHost ? String(pivot.localHost) : ''
  const port = pivot.localPort ? String(pivot.localPort) : ''
  const protocol = pivot.localProtocol ? String(pivot.localProtocol) : ''
  const base = host + (port ? `:${port}` : '')
  return (base || '—') + (protocol ? `/${protocol}` : '')
}

function hopsText(hops) {
  const list = asArray(hops)
  if (list.length === 0) return ''
  return list
    .map((rawHop) => {
      const hop = asObject(rawHop)
      const seq = num(hop.seq)
      const kind = hop.refKind ? String(hop.refKind) : 'ref'
      const label = hop.label ? String(hop.label) : hop.refId ? String(hop.refId) : ''
      let text = `${kind}:${label}`
      if (hop.via) text += ` via ${hop.via}`
      return seq ? `${seq}. ${text}` : text
    })
    .join(' → ')
}

function TableCard(props) {
  const rows = asArray(props.rows)
  return h(
    Card,
    {
      title: props.title,
      flush: true,
      actions: h(Badge, { tone: 'neutral' }, String(rows.length)),
    },
    h(DataTable, {
      columns: props.columns,
      rows,
      rowKey: props.rowKey,
      dense: true,
      ariaLabel: props.title,
      empty: h(Empty, { title: props.t('table.empty'), hint: props.t('table.emptyHint') }),
    }),
  )
}

function statsCounts(overview) {
  const stats = asObject(overview.stats)
  const counts = [
    ['footholds', asArray(overview.footholds).length],
    ['hosts', asArray(overview.hosts).length],
    ['services', asArray(overview.services).length],
    ['credentials', asArray(overview.credentials).length],
    ['pivots', asArray(overview.pivots).length],
  ]
  return counts.map((entry) => [entry[0], num(stats[entry[0]]) || entry[1]])
}

// ---------------------------------------------------------------- tables

function FootholdTable(props) {
  const { t, nav } = props
  const columns = [
    { key: 'id', label: t('col.id'), width: 150, render: (row) => h(Mono, { className: 'dshc-nowrap' }, row.id || '—') },
    {
      key: 'entryHostPort',
      label: t('col.entryHostPort'),
      render: (row) => h(Mono, { className: 'dshc-break' }, row.entryHostPort || '—'),
    },
    {
      key: 'entryVulnId',
      label: t('col.entryVulnId'),
      width: 150,
      render: (row) =>
        row.entryVulnId
          ? h(
              Button,
              {
                size: 'sm',
                variant: 'ghost',
                onClick: () => goToVulns(nav, row.entryVulnId),
                title: row.entryVulnId,
              },
              h(Mono, null, String(row.entryVulnId)),
            )
          : '—',
    },
    {
      key: 'accessType',
      label: t('col.accessType'),
      width: 110,
      render: (row) =>
        row.accessType ? labelOr(t, `accessType.${row.accessType}`, String(row.accessType)) : '—',
    },
    {
      key: 'privilegeLevel',
      label: t('col.privilege'),
      width: 110,
      render: (row) =>
        row.privilegeLevel
          ? h(
              Badge,
              { tone: PRIVILEGE_TONE[String(row.privilegeLevel)] || 'neutral' },
              labelOr(t, `privilege.${row.privilegeLevel}`, String(row.privilegeLevel)),
            )
          : '—',
    },
    {
      key: 'status',
      label: t('col.status'),
      width: 100,
      render: (row) => stateBadge(t, 'footholdStatus', row.status, FOOTHOLD_STATUS_TONE),
    },
    {
      key: 'hostIds',
      label: t('col.hostIds'),
      width: 90,
      align: 'right',
      render: (row) => asArray(row.hostIds).length,
    },
    {
      key: 'establishedAt',
      label: t('col.established'),
      width: 150,
      render: (row) => h('span', { className: 'dshc-small dshc-muted' }, fmtTime(row.establishedAt, props.locale)),
    },
    {
      key: 'notes',
      label: t('col.notes'),
      render: (row) =>
        row.notes ? h('span', { className: 'dshc-small dshc-break', title: String(row.notes) }, truncate(row.notes, 80)) : '—',
    },
  ]
  return h(TableCard, {
    t,
    title: t('table.footholds'),
    columns,
    rows: asArray(props.rows),
    rowKey: (row, index) => row.id || index,
  })
}

function HostTable(props) {
  const { t } = props
  const columns = [
    { key: 'id', label: t('col.id'), width: 150, render: (row) => h(Mono, { className: 'dshc-nowrap' }, row.id || '—') },
    { key: 'ip', label: t('col.ip'), width: 140, render: (row) => h(Mono, null, row.ip || '—') },
    { key: 'hostname', label: t('col.hostname'), render: (row) => row.hostname || '—' },
    { key: 'os', label: t('col.os'), width: 120, render: (row) => row.os || '—' },
    { key: 'subnet', label: t('col.subnet'), width: 120, render: (row) => h(Mono, null, row.subnet || '—') },
    {
      key: 'state',
      label: t('col.state'),
      width: 100,
      render: (row) => stateBadge(t, 'hostState', row.state, HOST_STATE_TONE),
    },
    { key: 'confidence', label: t('col.confidence'), width: 90, render: (row) => row.confidence || '—' },
    {
      key: 'lastSeen',
      label: t('col.lastSeen'),
      width: 120,
      render: (row) =>
        row.lastSeen ? h('span', { className: 'dshc-small dshc-muted' }, fmtRelative(row.lastSeen, props.locale)) : '—',
    },
  ]
  return h(TableCard, {
    t,
    title: t('table.hosts'),
    columns,
    rows: asArray(props.rows),
    rowKey: (row, index) => row.id || index,
  })
}

function ServiceTable(props) {
  const { t } = props
  const columns = [
    { key: 'id', label: t('col.id'), width: 150, render: (row) => h(Mono, { className: 'dshc-nowrap' }, row.id || '—') },
    { key: 'hostId', label: t('col.hostId'), width: 130, render: (row) => h(Mono, null, row.hostId || '—') },
    { key: 'port', label: t('col.port'), width: 70, align: 'right', render: (row) => (row.port ? String(row.port) : '—') },
    { key: 'protocol', label: t('col.protocol'), width: 90, render: (row) => row.protocol || '—' },
    { key: 'service', label: t('col.service'), width: 120, render: (row) => row.service || '—' },
    {
      key: 'banner',
      label: t('col.banner'),
      render: (row) =>
        row.banner
          ? h('span', { className: 'dshc-small dshc-break', title: String(row.banner) }, truncate(row.banner, 70))
          : '—',
    },
    {
      key: 'state',
      label: t('col.state'),
      width: 90,
      render: (row) => stateBadge(t, 'serviceState', row.state, SERVICE_STATE_TONE),
    },
    {
      key: 'lastSeen',
      label: t('col.lastSeen'),
      width: 120,
      render: (row) =>
        row.lastSeen ? h('span', { className: 'dshc-small dshc-muted' }, fmtRelative(row.lastSeen, props.locale)) : '—',
    },
  ]
  return h(TableCard, {
    t,
    title: t('table.services'),
    columns,
    rows: asArray(props.rows),
    rowKey: (row, index) => row.id || index,
  })
}

// Credentials: the Host DTO never contains the raw `secret`. Only `secretMasked`
// and `secretLength` are rendered here — never touch a `secret` field, even if a
// future/old Host leaks one.
function CredentialTable(props) {
  const { t } = props
  const columns = [
    { key: 'id', label: t('col.id'), width: 150, render: (row) => h(Mono, { className: 'dshc-nowrap' }, row.id || '—') },
    { key: 'username', label: t('col.username'), render: (row) => row.username || '—' },
    { key: 'domain', label: t('col.domain'), width: 120, render: (row) => row.domain || '—' },
    {
      key: 'type',
      label: t('col.type'),
      width: 120,
      render: (row) => (row.type ? h(Badge, { tone: 'neutral' }, String(row.type)) : '—'),
    },
    {
      key: 'secretMasked',
      label: t('col.secret'),
      width: 200,
      render: (row) =>
        row.secretMasked
          ? h(
              'div',
              { className: 'dshc-flex' },
              h(Mono, null, String(row.secretMasked)),
              h(
                'span',
                { className: 'dshc-small dshc-muted' },
                t('secretLen', { count: num(row.secretLength) }),
              ),
            )
          : '—',
    },
  ]
  return h(TableCard, {
    t,
    title: t('table.credentials'),
    columns,
    rows: asArray(props.rows),
    rowKey: (row, index) => row.id || index,
  })
}

function PivotTable(props) {
  const { t } = props
  const columns = [
    { key: 'id', label: t('col.id'), width: 150, render: (row) => h(Mono, { className: 'dshc-nowrap' }, row.id || '—') },
    { key: 'footholdId', label: t('col.footholdId'), width: 150, render: (row) => h(Mono, null, row.footholdId || '—') },
    {
      key: 'kind',
      label: t('col.kind'),
      width: 90,
      render: (row) =>
        row.kind ? h(Badge, { tone: row.kind === 'proxy' ? 'brand' : 'neutral' }, labelOr(t, `pivotKind.${row.kind}`, String(row.kind))) : '—',
    },
    { key: 'local', label: t('col.local'), width: 180, render: (row) => h(Mono, { className: 'dshc-break' }, hostEndpoint(asObject(row))) },
    { key: 'tool', label: t('col.tool'), width: 110, render: (row) => row.tool || '—' },
    {
      key: 'status',
      label: t('col.status'),
      width: 100,
      render: (row) => stateBadge(t, 'pivotStatus', row.status, PIVOT_STATUS_TONE),
    },
    {
      key: 'hops',
      label: t('col.hops'),
      render: (row) => {
        const text = hopsText(row.hops)
        return text ? h(Mono, { className: 'dshc-break', title: text }, text) : '—'
      },
    },
    {
      key: 'reachableSubnets',
      label: t('col.reachable'),
      width: 160,
      render: (row) => {
        const subnets = asArray(row.reachableSubnets)
        return subnets.length ? h(Mono, { className: 'dshc-break' }, subnets.join(', ')) : '—'
      },
    },
  ]
  return h(TableCard, {
    t,
    title: t('table.pivots'),
    columns,
    rows: asArray(props.rows),
    rowKey: (row, index) => row.id || index,
  })
}

function GraphCard(props) {
  const { t, graph } = props
  const payload = asObject(graph.data)
  const nodes = asArray(payload.nodes)
  const edges = asArray(payload.edges)
  const columns = [
    { key: 'from', label: t('graph.col.from'), render: (row) => h(Mono, { className: 'dshc-break' }, row.from || '—') },
    { key: 'to', label: t('graph.col.to'), render: (row) => h(Mono, { className: 'dshc-break' }, row.to || '—') },
    { key: 'kind', label: t('graph.col.kind'), width: 140, render: (row) => row.kind || '—' },
  ]
  return h(
    Card,
    {
      title: t('graph.title'),
      subtitle: `${t('graph.nodes')} ${nodes.length} · ${t('graph.edges')} ${edges.length}`,
      flush: true,
    },
    graph.phase === 'loading'
      ? h(Spinner, { label: t('common.loading') })
      : graph.phase === 'error'
        ? h('div', { className: 'dshc-muted dshc-small', style: { padding: 12 } }, t('graph.unavailable'))
        : edges.length === 0
          ? h(Empty, { icon: 'network', title: t('graph.empty') })
          : h(DataTable, { columns, rows: edges, rowKey: (row, index) => `${row.from}-${row.to}-${index}`, dense: true, ariaLabel: t('graph.title') }),
  )
}

function InternalView(props) {
  const { t, locale, nav, phase, data, error, onRetry, graph } = props
  if (phase === 'loading' || phase === 'idle') {
    return h('div', { className: 'dshc-page dshc-col' }, h(Spinner, { label: t('common.loading') }))
  }
  if (phase === 'error') {
    return h('div', { className: 'dshc-page dshc-col' }, h(ErrorBox, { error, t, onRetry }))
  }
  if (phase === 'empty' || !data) {
    return h(
      'div',
      { className: 'dshc-page dshc-col' },
      h(Card, null, h(Empty, { icon: 'network', title: t('empty.projects'), hint: t('empty.projectsHint') })),
    )
  }

  const overview = asObject(data)
  const footholds = asArray(overview.footholds)
  const hosts = asArray(overview.hosts)
  const services = asArray(overview.services)
  const credentials = asArray(overview.credentials)
  const pivots = asArray(overview.pivots)
  const counts = statsCounts(overview)
  const total = counts.reduce((sum, entry) => sum + entry[1], 0)

  const statsRow = h(
    'div',
    { className: 'dshc-flex' },
    counts.map((entry) =>
      h(
        Badge,
        { key: entry[0], tone: entry[1] > 0 ? 'brand' : 'neutral' },
        `${t(`stat.${entry[0]}`)} ${entry[1]}`,
      ),
    ),
  )

  if (total === 0) {
    return h(
      'div',
      { className: 'dshc-page dshc-col' },
      statsRow,
      h(Card, null, h(Empty, { icon: 'network', title: t('empty.overview'), hint: t('empty.overviewHint') })),
    )
  }

  const projectName = String(overview.project || '')
  const projectCard = h(
    Card,
    { title: t('selector.project') },
    h(KeyValue, {
      items: [
        [t('selector.project'), projectName || '—'],
        [t('stat.footholds'), counts[0][1]],
        [t('stat.hosts'), counts[1][1]],
        [t('stat.services'), counts[2][1]],
        [t('stat.credentials'), counts[3][1]],
        [t('stat.pivots'), counts[4][1]],
      ],
    }),
  )

  return h(
    'div',
    { className: 'dshc-page dshc-col' },
    statsRow,
    projectCard,
    h(FootholdTable, { t, locale, nav, rows: footholds }),
    h(HostTable, { t, locale, rows: hosts }),
    h(ServiceTable, { t, locale, rows: services }),
    h(CredentialTable, { t, locale, rows: credentials }),
    h(PivotTable, { t, locale, rows: pivots }),
    h(GraphCard, { t, graph: graph || { phase: 'ok', data: null } }),
  )
}

// ---------------------------------------------------------------- page

function Component(props) {
  const { api, rev, nav } = props
  const navParams = asObject(nav && nav.params)
  const [project, setProject] = useState(navParams.project ? String(navParams.project) : '')
  const [projectsState, setProjectsState] = useState({ phase: 'loading', data: null, error: null })
  const [projectsNonce, setProjectsNonce] = useState(0)
  const [overviewState, setOverviewState] = useState({ phase: 'idle', data: null, error: null })
  const [overviewNonce, setOverviewNonce] = useState(0)
  const [graphState, setGraphState] = useState({ phase: 'idle', data: null, error: null })

  useEffect(() => {
    let alive = true
    setProjectsState({ phase: 'loading', data: null, error: null })
    api.get('/internal/projects').then(
      (data) => {
        if (!alive) return
        setProjectsState({ phase: 'ok', data, error: null })
        const projects = asArray(asObject(data).projects)
        const first = projects.length > 0 ? asObject(projects[0]).projectName : ''
        setProject((current) => current || first || '')
      },
      (error) => {
        if (alive && !isAbortError(error)) setProjectsState({ phase: 'error', data: null, error })
      },
    )
    return () => {
      alive = false
    }
  }, [api, rev, projectsNonce])

  useEffect(() => {
    if (!project) {
      setOverviewState({ phase: 'empty', data: null, error: null })
      setGraphState({ phase: 'idle', data: null, error: null })
      return undefined
    }
    let alive = true
    setOverviewState({ phase: 'loading', data: null, error: null })
    setGraphState({ phase: 'loading', data: null, error: null })
    api.get('/internal/overview', { project }).then(
      (data) => {
        if (alive) setOverviewState({ phase: 'ok', data, error: null })
      },
      (error) => {
        if (alive && !isAbortError(error)) setOverviewState({ phase: 'error', data: null, error })
      },
    )
    api.get('/internal/graph', { project }).then(
      (data) => {
        if (alive) setGraphState({ phase: 'ok', data, error: null })
      },
      (error) => {
        if (alive && !isAbortError(error)) setGraphState({ phase: 'error', data: null, error })
      },
    )
    return () => {
      alive = false
    }
  }, [api, rev, project, overviewNonce])

  const reload = () => {
    setProjectsNonce((value) => value + 1)
    setOverviewNonce((value) => value + 1)
  }

  const projects = asArray(asObject(projectsState.data).projects)
  const projectOptions = projects.map((item) => {
    const entry = asObject(item)
    return { value: entry.projectName, label: entry.projectName || '—' }
  })
  if (project && !projectOptions.some((option) => option.value === project)) {
    projectOptions.unshift({ value: project, label: project })
  }

  const phase =
    projectsState.phase === 'loading' && !projectsState.data
      ? 'loading'
      : projectsState.phase === 'error'
        ? 'error'
        : projects.length === 0 && !project
          ? 'empty'
          : overviewState.phase

  const error = projectsState.phase === 'error' ? projectsState.error : overviewState.error

  if (projectsState.phase === 'error') {
    return h(
      'div',
      { className: 'dshc-page dshc-col' },
      h(ErrorBox, { error: projectsState.error, t: props.t, onRetry: reload }),
    )
  }

  return h(
    'div',
    { className: 'dshc-page dshc-col' },
    h(
      Toolbar,
      {
        right: h(Button, { size: 'sm', icon: 'refresh', onClick: reload }, props.t('common.refresh')),
      },
      h(
        'div',
        { className: 'dshc-flex', style: { gap: 8 } },
        h('span', { className: 'dshc-small dshc-muted' }, props.t('selector.project')),
        h(Select, {
          value: project,
          options: projectOptions,
          'aria-label': props.t('selector.projectAria'),
          disabled: projectsState.phase === 'loading' && projects.length === 0,
          onChange: (event) => setProject(event.target.value),
        }),
      ),
    ),
    h(InternalView, {
      t: props.t,
      locale: props.locale,
      nav,
      phase,
      data: overviewState.data,
      error,
      graph: graphState,
      onRetry: reload,
    }),
  )
}

module.exports = { id: 'internal', messages, Component }
