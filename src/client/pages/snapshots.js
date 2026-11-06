// Snapshots page: project selector + includeArchived toggle, parent/child
// session tree and a read-only nine-field snapshot detail. Read-only in v1.
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
  Split,
  KeyValue,
  Mono,
  Pre,
  sevBadge,
} = require('../ui/kit.js')
const { Markdown } = require('../ui/markdown.js')
const { fmtTime, fmtRelative, asArray, asObject, truncate } = require('../lib/format.js')

const { useState, useEffect } = React

const messages = {
  zh: {
    'selector.project': '项目',
    'selector.projectAria': '选择快照项目',
    'selector.allProjects': '全部项目',
    'includeArchived': '包含已归档',
    'list.aria': '快照会话列表',
    'list.empty': '没有快照会话',
    'list.emptyHint': '通过 Cortex MCP 的 manage_snapshot save 保存阶段快照后，会话会显示在这里。',
    'list.clearFilters': '显示全部项目',
    'list.targets': '{count} 个目标',
    'list.children': '子会话 {count}',
    'badge.archived': '已归档',
    'badge.children': '子会话 {count}',
    'detail.empty': '选择一个快照会话查看详情',
    'detail.emptyHint': '会话详情只读显示九个字段、测试接口与关联漏洞。',
    'section.meta': '会话元信息',
    'section.targets': '目标主机（targetHosts）',
    'section.tasks': '未完成任务（unfinishedTasks）',
    'section.paths': '失败路径（failedPaths）',
    'section.interfaces': '测试过的接口（testedInterfaces）',
    'section.notes': '备注（notes）',
    'section.nextSteps': '下一步（nextSteps）',
    'section.related': '关联漏洞（relatedVulnIds）',
    'section.previousState': '上一状态（previousState）',
    'section.children': '子会话（{count}）',
    'meta.sessionId': 'Session ID',
    'meta.projectName': '项目（projectName）',
    'meta.currentPhase': '当前阶段（currentPhase）',
    'meta.parentSessionId': '父会话（parentSessionId）',
    'meta.createdAt': '创建时间',
    'meta.updatedAt': '更新时间',
    'meta.archivedAt': '归档时间',
    'meta.childCount': '子会话数',
    'col.target': '目标',
    'col.method': '方法',
    'col.result': '结果',
    'empty.targets': '没有目标主机记录。',
    'empty.tasks': '没有未完成任务。',
    'empty.paths': '没有失败路径记录。',
    'empty.interfaces': '没有测试接口记录。',
    'empty.notes': '没有备注。',
    'empty.nextSteps': '没有下一步计划。',
    'empty.related': '没有关联漏洞。',
    'empty.previousState': '没有上一状态。',
    'empty.children': '没有子会话。',
    'task.item': '任务 {index}',
    'common.loading': '加载中…',
    'common.refresh': '刷新',
    'common.retry': '重试',
  },
  en: {
    'selector.project': 'Project',
    'selector.projectAria': 'Choose a snapshot project',
    'selector.allProjects': 'All projects',
    'includeArchived': 'Include archived',
    'list.aria': 'Snapshot session list',
    'list.empty': 'No snapshot sessions',
    'list.emptyHint': 'Sessions appear here after manage_snapshot save stores a phase snapshot through the Cortex MCP.',
    'list.clearFilters': 'Show all projects',
    'list.targets': '{count} targets',
    'list.children': '{count} children',
    'badge.archived': 'archived',
    'badge.children': 'children {count}',
    'detail.empty': 'Select a snapshot session to see details',
    'detail.emptyHint': 'The session detail shows the nine snapshot fields, tested interfaces and related vulnerabilities, read-only.',
    'section.meta': 'Session metadata',
    'section.targets': 'Target hosts (targetHosts)',
    'section.tasks': 'Unfinished tasks (unfinishedTasks)',
    'section.paths': 'Failed paths (failedPaths)',
    'section.interfaces': 'Tested interfaces (testedInterfaces)',
    'section.notes': 'Notes (notes)',
    'section.nextSteps': 'Next steps (nextSteps)',
    'section.related': 'Related vulnerabilities (relatedVulnIds)',
    'section.previousState': 'Previous state (previousState)',
    'section.children': 'Child sessions ({count})',
    'meta.sessionId': 'Session ID',
    'meta.projectName': 'Project (projectName)',
    'meta.currentPhase': 'Current phase (currentPhase)',
    'meta.parentSessionId': 'Parent (parentSessionId)',
    'meta.createdAt': 'Created',
    'meta.updatedAt': 'Updated',
    'meta.archivedAt': 'Archived',
    'meta.childCount': 'Child sessions',
    'col.target': 'Target',
    'col.method': 'Method',
    'col.result': 'Result',
    'empty.targets': 'No target hosts recorded.',
    'empty.tasks': 'No unfinished tasks.',
    'empty.paths': 'No failed paths recorded.',
    'empty.interfaces': 'No tested interfaces recorded.',
    'empty.notes': 'No notes.',
    'empty.nextSteps': 'No next steps.',
    'empty.related': 'No related vulnerabilities.',
    'empty.previousState': 'No previous state.',
    'empty.children': 'No child sessions.',
    'task.item': 'Task {index}',
    'common.loading': 'Loading…',
    'common.refresh': 'Refresh',
    'common.retry': 'Retry',
  },
}

// ---------------------------------------------------------------- helpers

function isAbortError(error) {
  return !!error && (error.code === 'ABORTED' || error.name === 'AbortError')
}

function num(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function goToVulns(nav, vulnId) {
  if (nav && typeof nav.go === 'function') nav.go('vulns', { vulnId })
}

function str(value) {
  return value === undefined || value === null || value === '' ? '' : String(value)
}

/** Flatten sessions into [{session, depth}] with parents before children. */
function flattenTree(sessions) {
  const list = asArray(sessions).filter((item) => item && typeof item === 'object' && item.sessionId)
  const byId = Object.create(null)
  for (const session of list) byId[String(session.sessionId)] = session
  const childMap = Object.create(null)
  const roots = []
  for (const session of list) {
    const parentId = str(session.parentSessionId)
    if (parentId && byId[parentId] && parentId !== String(session.sessionId)) {
      if (!childMap[parentId]) childMap[parentId] = []
      childMap[parentId].push(session)
    } else {
      roots.push(session)
    }
  }
  const out = []
  const seen = Object.create(null)
  const walk = (session, depth) => {
    const id = String(session.sessionId)
    if (seen[id]) return
    seen[id] = true
    out.push({ session, depth })
    for (const child of childMap[id] || []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  for (const session of list) if (!seen[String(session.sessionId)]) walk(session, 0)
  return out
}

// ---------------------------------------------------------------- list

function SessionItem(props) {
  const { session, depth, active, onSelect, t, locale } = props
  const item = asObject(session)
  const childCount = num(item.childCount)
  const title = str(item.currentPhase) || str(item.projectName) || str(item.sessionId)
  return h(
    'button',
    {
      type: 'button',
      className: 'dshc-list-item',
      'data-depth': depth,
      'aria-current': active ? 'true' : undefined,
      style: { paddingLeft: 10 + depth * 16 },
      onClick: () => onSelect(item.sessionId),
    },
    h(
      'span',
      { className: 'dshc-flex', style: { gap: 6, flexWrap: 'nowrap', minWidth: 0, maxWidth: '100%' } },
      h('span', { className: 'dshc-list-main', title, style: { flex: '1 1 auto', minWidth: 0 } }, title || '—'),
      item.archivedAt ? h(Badge, { tone: 'warn', className: 'dshc-small' }, t('badge.archived')) : null,
      childCount > 0 ? h(Badge, { tone: 'neutral', className: 'dshc-small' }, t('badge.children', { count: childCount })) : null,
    ),
    h(
      'span',
      { className: 'dshc-list-meta' },
      item.projectName ? h('span', null, str(item.projectName)) : null,
      h('span', null, t('list.targets', { count: asArray(item.targetHosts).length })),
      item.updatedAt ? h('span', null, fmtRelative(item.updatedAt, locale)) : null,
    ),
  )
}

function SessionTree(props) {
  const { t, locale, sessions, selectedSessionId, onSelect } = props
  const nodes = flattenTree(sessions)
  if (nodes.length === 0) {
    return h(Empty, { icon: 'layers', title: t('list.empty'), hint: t('list.emptyHint') })
  }
  return h(
    'div',
    { role: 'list', 'aria-label': t('list.aria') },
    nodes.map((node) =>
      h(
        'div',
        { key: String(asObject(node.session).sessionId), role: 'listitem' },
        h(SessionItem, {
          session: node.session,
          depth: node.depth,
          active: String(selectedSessionId || '') === String(asObject(node.session).sessionId),
          onSelect,
          t,
          locale,
        }),
      ),
    ),
  )
}

// ---------------------------------------------------------------- detail sections

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
      const summary = asObject(summaries.filter((item) => asObject(item).id === id)[0])
      return h(
        'div',
        { key: id, className: 'dshc-flex' },
        h(
          Button,
          {
            size: 'sm',
            onClick: () => goToVulns(nav, id),
            title: summary.vulnName || id,
          },
          h(Mono, null, id),
          summary.vulnName ? h('span', { className: 'dshc-small' }, truncate(summary.vulnName, 60)) : null,
        ),
        summary.severity ? sevBadge(summary.severity) : null,
      )
    }),
  )
}

function TextList(props) {
  const items = asArray(props.items)
  if (items.length === 0) {
    return h('div', { className: 'dshc-muted dshc-small' }, props.empty)
  }
  return h(
    'ul',
    { className: 'dshc-col', style: { gap: 4, margin: 0, paddingLeft: 20 } },
    items.map((item, index) =>
      h('li', { key: index, className: 'dshc-small dshc-break' }, str(item)),
    ),
  )
}

function TestedInterfacesTable(props) {
  const { t } = props
  const rows = asArray(props.rows)
  const columns = [
    {
      key: 'target',
      label: t('col.target'),
      render: (row) => h(Mono, { className: 'dshc-break' }, str(row.target) || '—'),
    },
    {
      key: 'method',
      label: t('col.method'),
      width: 110,
      render: (row) => (row.method ? h(Badge, { tone: 'brand' }, str(row.method)) : '—'),
    },
    {
      key: 'result',
      label: t('col.result'),
      render: (row) =>
        row.result ? h('span', { className: 'dshc-small dshc-break', title: str(row.result) }, str(row.result)) : '—',
    },
  ]
  return h(DataTable, {
    columns,
    rows,
    rowKey: (row, index) => `${str(row.target)}-${index}`,
    dense: true,
    ariaLabel: t('section.interfaces'),
    empty: h(Empty, { title: t('empty.interfaces') }),
  })
}

function SnapshotDetailView(props) {
  const { t, locale, nav, data, onRetry, onOpenSession } = props
  const payload = asObject(data)
  const session = asObject(payload.session)
  const children = asArray(payload.children)
  const relatedVulns = asArray(payload.relatedVulns)
  const targetHosts = asArray(session.targetHosts)
  const unfinishedTasks = asArray(session.unfinishedTasks)
  const failedPaths = asArray(session.failedPaths)
  const testedInterfaces = asArray(session.testedInterfaces)
  const previousState = session.previousState === undefined ? null : session.previousState

  const metaItems = [
    [t('meta.sessionId'), h(Mono, null, str(session.sessionId) || '—')],
    [t('meta.projectName'), str(session.projectName) || '—'],
    [t('meta.currentPhase'), str(session.currentPhase) || '—'],
    [t('meta.parentSessionId'), session.parentSessionId ? h(Mono, null, str(session.parentSessionId)) : '—'],
    [t('meta.createdAt'), session.createdAt ? fmtTime(session.createdAt, locale) : '—'],
    [t('meta.updatedAt'), session.updatedAt ? fmtTime(session.updatedAt, locale) : '—'],
    [t('meta.archivedAt'), session.archivedAt ? fmtTime(session.archivedAt, locale) : '—'],
    [t('meta.childCount'), num(session.childCount)],
  ]

  let previousStateText = ''
  if (previousState !== null && previousState !== undefined) {
    try {
      previousStateText = JSON.stringify(previousState, null, 2)
    } catch {
      previousStateText = String(previousState)
    }
  }

  const targetContent =
    targetHosts.length === 0
      ? h('div', { className: 'dshc-muted dshc-small' }, t('empty.targets'))
      : h(
          'div',
          { className: 'dshc-flex' },
          targetHosts.map((target, index) =>
            h(Badge, { key: `${str(target)}-${index}`, tone: 'neutral' }, h(Mono, null, str(target))),
          ),
        )

  return h(
    'div',
    { className: 'dshc-col' },
    h(
      Card,
      {
        title: str(session.projectName) || str(session.sessionId) || '—',
        subtitle: str(session.currentPhase) || t('section.meta'),
        actions: [
          h(Button, { key: 'refresh', size: 'sm', icon: 'refresh', onClick: onRetry }, t('common.refresh')),
        ],
      },
      h(
        'div',
        { className: 'dshc-col' },
        h(
          'div',
          { className: 'dshc-flex' },
          session.archivedAt ? h(Badge, { tone: 'warn' }, t('badge.archived')) : null,
          num(session.childCount) > 0 ? h(Badge, { tone: 'neutral' }, t('badge.children', { count: num(session.childCount) })) : null,
          h(Badge, { tone: 'neutral' }, str(session.sessionId) || '—'),
        ),
        h(KeyValue, { items: metaItems }),
      ),
    ),
    h(Card, { title: t('section.targets') }, targetContent),
    h(Card, { title: t('section.tasks') }, h(TextList, { items: unfinishedTasks, empty: t('empty.tasks') })),
    h(Card, { title: t('section.paths') }, h(TextList, { items: failedPaths, empty: t('empty.paths') })),
    h(
      Card,
      { title: t('section.interfaces'), flush: testedInterfaces.length > 0 },
      h(TestedInterfacesTable, { t, rows: testedInterfaces }),
    ),
    h(Card, { title: t('section.notes') }, h(Markdown, { text: session.notes, empty: h('div', { className: 'dshc-muted dshc-small' }, t('empty.notes')) })),
    h(Card, { title: t('section.nextSteps') }, h(Markdown, { text: session.nextSteps, empty: h('div', { className: 'dshc-muted dshc-small' }, t('empty.nextSteps')) })),
    h(Card, { title: t('section.related') }, h(RelatedVulns, { t, nav, related: relatedVulns, relatedVulnIds: session.relatedVulnIds })),
    h(
      Card,
      { title: t('section.previousState') },
      previousStateText
        ? h(Pre, { 'aria-label': t('section.previousState') }, previousStateText)
        : h('div', { className: 'dshc-muted dshc-small' }, t('empty.previousState')),
    ),
    children.length > 0
      ? h(
          Card,
          { title: t('section.children', { count: children.length }) },
          h(
            'div',
            { className: 'dshc-col', style: { gap: 6 } },
            children.map((child) => {
              const entry = asObject(child)
              const id = str(entry.sessionId)
              return h(
                'div',
                { key: id, className: 'dshc-flex' },
                h(
                  Button,
                  {
                    size: 'sm',
                    icon: 'chevron-right',
                    onClick: () => onOpenSession && onOpenSession(id),
                    title: id,
                  },
                  h(Mono, null, str(entry.currentPhase) || str(entry.projectName) || id),
                ),
                entry.archivedAt ? h(Badge, { tone: 'warn' }, t('badge.archived')) : null,
                h('span', { className: 'dshc-small dshc-muted' }, id),
              )
            }),
          ),
        )
      : null,
  )
}

// ---------------------------------------------------------------- page

function Component(props) {
  const { api, rev, nav } = props
  const navParams = asObject(nav && nav.params)
  const [project, setProject] = useState(navParams.project ? String(navParams.project) : '')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [listNonce, setListNonce] = useState(0)
  const [list, setList] = useState({ phase: 'loading', data: null, error: null })
  const [selectedSessionId, setSelectedSessionId] = useState(
    navParams.sessionId ? String(navParams.sessionId) : null,
  )
  const [detailNonce, setDetailNonce] = useState(0)
  const [detail, setDetail] = useState({ phase: 'idle', data: null, error: null })

  useEffect(() => {
    let alive = true
    setList({ phase: 'loading', data: null, error: null })
    api.get('/snapshots', { project, includeArchived: includeArchived ? 1 : 0 }).then(
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
  }, [api, rev, project, includeArchived, listNonce])

  useEffect(() => {
    if (!selectedSessionId) {
      setDetail({ phase: 'idle', data: null, error: null })
      return undefined
    }
    let alive = true
    setDetail({ phase: 'loading', data: null, error: null })
    api.get(`/snapshots/${encodeURIComponent(selectedSessionId)}`).then(
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
  }, [api, rev, selectedSessionId, detailNonce])

  const reloadList = () => setListNonce((value) => value + 1)
  const reloadDetail = () => setDetailNonce((value) => value + 1)

  const payload = asObject(list.data)
  const projects = asArray(payload.projects)
  const sessions = asArray(payload.sessions)
  const projectOptions = [{ value: '', label: props.t('selector.allProjects') }].concat(
    projects.map((name) => ({ value: String(name), label: String(name) })),
  )
  if (project && !projectOptions.some((option) => option.value === project)) {
    projectOptions.push({ value: project, label: project })
  }

  let listPanel
  if (list.phase === 'loading') {
    listPanel = h(Spinner, { label: props.t('common.loading') })
  } else if (list.phase === 'error') {
    listPanel = h(ErrorBox, { error: list.error, t: props.t, onRetry: reloadList })
  } else {
    listPanel = h(SessionTree, {
      t: props.t,
      locale: props.locale,
      sessions,
      selectedSessionId,
      onSelect: (sessionId) => setSelectedSessionId(sessionId || null),
    })
  }

  let detailPanel
  if (!selectedSessionId) {
    detailPanel = h(
      Card,
      null,
      h(Empty, { icon: 'layers', title: props.t('detail.empty'), hint: props.t('detail.emptyHint') }),
    )
  } else if (detail.phase === 'loading') {
    detailPanel = h(Card, null, h(Spinner, { label: props.t('common.loading') }))
  } else if (detail.phase === 'error') {
    detailPanel = h(
      Card,
      null,
      h(ErrorBox, { error: detail.error, t: props.t, onRetry: reloadDetail }),
    )
  } else {
    detailPanel = h(SnapshotDetailView, {
      t: props.t,
      locale: props.locale,
      nav,
      data: detail.data,
      onRetry: reloadDetail,
      onOpenSession: (sessionId) => setSelectedSessionId(sessionId || null),
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
              if (selectedSessionId) reloadDetail()
            },
          },
          props.t('common.refresh'),
        ),
      },
      h(
        'div',
        { className: 'dshc-flex', style: { gap: 8 } },
        h('span', { className: 'dshc-small dshc-muted' }, props.t('selector.project')),
        h(Select, {
          value: project,
          options: projectOptions,
          'aria-label': props.t('selector.projectAria'),
          onChange: (event) => setProject(event.target.value),
        }),
      ),
      h(
        'label',
        { className: 'dshc-flex dshc-small', style: { gap: 6, cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: includeArchived,
          'aria-label': props.t('includeArchived'),
          onChange: (event) => setIncludeArchived(!!event.target.checked),
        }),
        h('span', null, props.t('includeArchived')),
      ),
    ),
    h(Split, {
      list: listPanel,
      detail: detailPanel,
      emptyDetail: h(Empty, { icon: 'layers' }),
      breakpoint: 860,
    }),
  )
}

module.exports = { id: 'snapshots', messages, Component }
