// Retest page: web vulnerabilities only; parse ```http steps from reproduction_steps;
// send requests with no-redirect default, follow-redirect button, raw/HTML iframe toggle.
//
// Owner: client-retest. No JSX, no DSH imports: plain CommonJS + the shared UI kit.
const {
  h,
  React,
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Input,
  KeyValue,
  Mono,
  Pager,
  Pre,
  Section,
  Select,
  Spinner,
  Split,
  Toolbar,
  severityTone,
  statusTone,
} = require('../ui/kit.js')
const { parseHttpSteps, requestHeadersForSend } = require('../lib/httpparse.js')
const { asArray, bytes, fmtTime, joinMeta } = require('../lib/format.js')

const { useEffect, useMemo, useRef, useState, useCallback } = React

const PAGE_SIZE = 50
const STATUS_VALUES = ['Confirmed', 'Inconclusive', 'Retest_Passed']
const DEFAULT_T = (key) => key

// ------------------------------------------------------------------ helpers

function httpStatusTone(status) {
  const code = Number(status)
  if (!Number.isFinite(code) || code <= 0) return 'neutral'
  if (code >= 200 && code < 300) return 'success'
  if (code >= 300 && code < 400) return 'brand'
  if (code >= 400 && code < 500) return 'warn'
  if (code >= 500) return 'error'
  return 'neutral'
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  const wanted = String(name || '').toLowerCase()
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === wanted) return headers[key]
  }
  return ''
}

function fmtDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(2)} s`
}

function statusLabel(t, status) {
  const raw = status === undefined || status === null || status === '' ? '—' : String(status)
  const key = `status.${raw}`
  const translated = t(key)
  return translated === key ? raw : translated
}

function headersText(headers) {
  if (!headers || typeof headers !== 'object') return ''
  return Object.keys(headers)
    .map((key) => `${key}: ${headers[key]}`)
    .join('\n')
}

function isOriginNotAllowed(error) {
  return !!error && error.code === 'ORIGIN_NOT_ALLOWED'
}

function allowedOriginsOf(error) {
  const details = error && error.details
  const allowed = details && Array.isArray(details.allowed) ? details.allowed : []
  return allowed.map((item) => String(item))
}

// ------------------------------------------------------------------ messages

const messages = {
  zh: {
    'list.searchPlaceholder': '搜索 Web 漏洞…',
    'list.searchAria': '搜索 Web 漏洞',
    'list.reload': '刷新列表',
    'list.loading': '正在读取漏洞列表…',
    'list.emptyTitle': '没有可复测的 Web 漏洞',
    'list.emptyHint': '这里只列出 realm=web 的漏洞；内网漏洞请到「内网」页查看。',
    'list.webOnlyHint': '仅显示 Web 漏洞',
    'detail.selectTitle': '选择一个 Web 漏洞开始复测',
    'detail.selectHint': '从左侧列表选择漏洞，或在「漏洞」页点击「去复测」。',
    'detail.loading': '正在读取漏洞详情…',
    'detail.errorTitle': '读取漏洞详情失败',
    'detail.id': '漏洞 ID',
    'detail.host': 'Host',
    'detail.realm': 'Realm',
    'detail.targetUrl': '目标 URL',
    'detail.entryPoint': '入口',
    'detail.serviceHost': '内网服务',
    'detail.retestCount': '复测次数',
    'detail.latestRetestAt': '最近复测',
    'detail.createdAt': '创建时间',
    'detail.relatedCount': '{count} 个关联漏洞',
    'card.status': '复测结论状态',
    'card.steps': '复测步骤',
    'card.request': '请求预览',
    'card.requestHeaders': '请求头',
    'card.requestBody': '请求体',
    'card.requestHint': '点击上方步骤按钮即按该请求发送；默认不跟随重定向。',
    'card.response': '出站响应',
    'status.current': '当前状态',
    'status.selectAria': '修改漏洞状态',
    'status.saving': '应用中…',
    'status.readOnlyHint': '只读模式：状态修改已禁用。',
    'status.Confirmed': '已确认',
    'status.Inconclusive': '待定',
    'status.Retest_Passed': '复测通过',
    'action.applyStatus': '应用',
    'action.followRedirect': '跟随重定向',
    'steps.count': '共 {count} 个 HTTP 请求块',
    'steps.hint': '默认不跟随重定向；3xx + Location 时会出现「跟随重定向」按钮（最多 5 跳，逐跳校验 allowlist）。',
    'steps.emptyTitle': '没有可复测的 HTTP 步骤',
    'steps.emptyHint': '该漏洞的 reproduction_steps 中没有 ```http 请求块。请用 Markdown 围栏代码块（语言标记 http）写入完整请求：请求行 + 请求头 + 空行 + 可选请求体。',
    'step.label': '步骤 {n}',
    'step.aria': '发送步骤 {n}',
    'resp.sending': '正在发送请求…',
    'resp.statusTitle': 'HTTP 状态',
    'resp.duration': '耗时 {value}',
    'resp.bodyBytes': '响应体 {value}',
    'resp.truncated': '响应体已截断',
    'resp.raw': '原文',
    'resp.html': 'HTML',
    'resp.rawTitle': '响应体原文',
    'resp.url': '请求 URL',
    'resp.finalUrl': '最终 URL',
    'resp.redirects': '重定向链',
    'resp.followHint': 'Location: {location}；最多 5 跳，每跳重新校验 allowlist。',
    'resp.htmlTitle': '响应 HTML（沙箱渲染，脚本不执行）',
    'resp.htmlHint': '已在空 sandbox 的 iframe 中渲染：脚本、表单与顶层导航均被禁用。',
    'resp.emptyBody': '（响应体为空）',
    'error.originHint': '目标 origin 不在 allowlist 内。Host 只会向该漏洞 target_url / 资产 / service_host 对应的 origin 发送请求。',
    'error.allowedOrigins': '允许的 origin：',
    'error.requestUrl': '请求 URL：{url}',
    'toast.sent': '复测请求已发送 — HTTP {status}',
    'toast.sendFailed': '复测请求发送失败',
    'toast.statusSaved': '状态已更新为 {status}',
    'toast.statusFailed': '状态更新失败',
  },
  en: {
    'list.searchPlaceholder': 'Search web vulnerabilities…',
    'list.searchAria': 'Search web vulnerabilities',
    'list.reload': 'Refresh list',
    'list.loading': 'Loading vulnerabilities…',
    'list.emptyTitle': 'No web vulnerabilities to retest',
    'list.emptyHint': 'Only realm=web vulnerabilities are listed here; internal findings live on the Internal tab.',
    'list.webOnlyHint': 'Web vulnerabilities only',
    'detail.selectTitle': 'Select a web vulnerability to retest',
    'detail.selectHint': 'Pick a vulnerability on the left, or use "Retest" from the Vulnerabilities page.',
    'detail.loading': 'Loading vulnerability detail…',
    'detail.errorTitle': 'Failed to load vulnerability detail',
    'detail.id': 'Vulnerability ID',
    'detail.host': 'Host',
    'detail.realm': 'Realm',
    'detail.targetUrl': 'Target URL',
    'detail.entryPoint': 'Entry point',
    'detail.serviceHost': 'Service host',
    'detail.retestCount': 'Retest count',
    'detail.latestRetestAt': 'Latest retest',
    'detail.createdAt': 'Created',
    'detail.relatedCount': '{count} related',
    'card.status': 'Retest status',
    'card.steps': 'Retest steps',
    'card.request': 'Request preview',
    'card.requestHeaders': 'Request headers',
    'card.requestBody': 'Request body',
    'card.requestHint': 'Click a step button above to send that request; redirects are not followed by default.',
    'card.response': 'Outbound response',
    'status.current': 'Current status',
    'status.selectAria': 'Change vulnerability status',
    'status.saving': 'Applying…',
    'status.readOnlyHint': 'Read-only mode: status updates are disabled.',
    'status.Confirmed': 'Confirmed',
    'status.Inconclusive': 'Inconclusive',
    'status.Retest_Passed': 'Retest passed',
    'action.applyStatus': 'Apply',
    'action.followRedirect': 'Follow redirect',
    'steps.count': '{count} HTTP request block(s)',
    'steps.hint': 'Redirects are not followed by default; a "Follow redirect" button appears for 3xx + Location (max 5 hops, allowlist re-checked per hop).',
    'steps.emptyTitle': 'No HTTP steps to retest',
    'steps.emptyHint': 'This vulnerability has no ```http request blocks in reproduction_steps. Add fenced Markdown code blocks tagged http, each holding one full request: request line, headers, a blank line, then an optional body.',
    'step.label': 'Step {n}',
    'step.aria': 'Send step {n}',
    'resp.sending': 'Sending request…',
    'resp.statusTitle': 'HTTP status',
    'resp.duration': 'Duration {value}',
    'resp.bodyBytes': 'Body {value}',
    'resp.truncated': 'Body truncated',
    'resp.raw': 'Raw',
    'resp.html': 'HTML',
    'resp.rawTitle': 'Response body (raw)',
    'resp.url': 'Request URL',
    'resp.finalUrl': 'Final URL',
    'resp.redirects': 'Redirect chain',
    'resp.followHint': 'Location: {location}; max 5 hops, allowlist re-checked on every hop.',
    'resp.htmlTitle': 'Response HTML (sandboxed, scripts disabled)',
    'resp.htmlHint': 'Rendered inside an iframe with an empty sandbox: scripts, forms and top-level navigation are blocked.',
    'resp.emptyBody': '(empty response body)',
    'error.originHint': 'The target origin is not in the allowlist. The Host only sends requests to origins of this vulnerability\'s target_url / asset / service_host.',
    'error.allowedOrigins': 'Allowed origins:',
    'error.requestUrl': 'Request URL: {url}',
    'toast.sent': 'Retest request sent — HTTP {status}',
    'toast.sendFailed': 'Retest request failed',
    'toast.statusSaved': 'Status updated to {status}',
    'toast.statusFailed': 'Status update failed',
  },
}

// ------------------------------------------------------------------ page

function Component(props) {
  const t = typeof props.t === 'function' ? props.t : DEFAULT_T
  const api = props.api
  const toast = typeof props.toast === 'function' ? props.toast : () => {}
  const locale = props.locale || 'en'
  const rev = Number(props.rev) || 0
  const readOnly = !!(props.app && props.app.readOnly)
  const navParams = (props.nav && props.nav.params) || {}
  const navVulnId = navParams.vulnId === undefined || navParams.vulnId === null ? '' : String(navParams.vulnId)

  // List state (left panel): GET /vulns?realm=web only.
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [listReload, setListReload] = useState(0)
  const [listState, setListState] = useState({ phase: 'loading', data: null, error: null })

  // Selection + detail state.
  const [selectedId, setSelectedId] = useState(navVulnId || null)
  const [detailReload, setDetailReload] = useState(0)
  const [detailState, setDetailState] = useState({ phase: navVulnId ? 'loading' : 'idle', vuln: null, error: null })

  // Status editor state.
  const [statusValue, setStatusValue] = useState('')
  const [statusSaving, setStatusSaving] = useState(false)
  const [statusError, setStatusError] = useState(null)

  // Send / response state.
  const [activeStepIndex, setActiveStepIndex] = useState(null)
  const [sendState, setSendState] = useState(null)
  const [responseMode, setResponseMode] = useState('raw')

  const sendSeqRef = useRef(0)
  const navIdRef = useRef(navVulnId || null)

  // Debounce the search box (300ms) and return to page 1.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // nav.params.vulnId -> selection (re-checked when the shell bumps rev).
  useEffect(() => {
    if (!navVulnId) return
    if (navIdRef.current === navVulnId) return
    navIdRef.current = navVulnId
    setSelectedId(navVulnId)
  }, [navVulnId, rev])

  // Load the web vulnerability list.
  useEffect(() => {
    let cancelled = false
    setListState((previous) => ({ phase: 'loading', data: previous.data, error: null }))
    api
      .get('/vulns', { realm: 'web', search: search || undefined, page, pageSize: PAGE_SIZE })
      .then((data) => {
        if (!cancelled) setListState({ phase: 'ok', data: data || null, error: null })
      })
      .catch((error) => {
        if (!cancelled) setListState((previous) => ({ phase: 'error', data: previous.data, error }))
      })
    return () => {
      cancelled = true
    }
  }, [api, rev, search, page, listReload])

  // Load the selected vulnerability detail.
  useEffect(() => {
    if (!selectedId) {
      setDetailState({ phase: 'idle', vuln: null, error: null })
      return undefined
    }
    let cancelled = false
    setDetailState((previous) => ({
      phase: 'loading',
      vuln: previous.vuln && previous.vuln.id === selectedId ? previous.vuln : null,
      error: null,
    }))
    api
      .get(`/vulns/${encodeURIComponent(selectedId)}`)
      .then((data) => {
        if (cancelled) return
        const vuln = data && data.vuln ? data.vuln : null
        const parsedSteps = vuln ? parseHttpSteps(vuln.reproductionSteps || '', vuln.targetUrl || '') : []
        setDetailState({ phase: 'ok', vuln, related: asArray(data && data.related), error: null })
        setStatusValue(vuln && vuln.status ? vuln.status : '')
        setActiveStepIndex(parsedSteps.length ? parsedSteps[0].index : null)
        setSendState(null)
        setResponseMode('raw')
        setStatusError(null)
      })
      .catch((error) => {
        if (!cancelled) setDetailState({ phase: 'error', vuln: null, error })
      })
    return () => {
      cancelled = true
    }
  }, [api, selectedId, rev, detailReload])

  const vuln = detailState.vuln
  const related = asArray(detailState.related)
  const steps = useMemo(() => {
    if (!vuln) return []
    return parseHttpSteps(vuln.reproductionSteps || '', vuln.targetUrl || '')
  }, [vuln])
  const activeStep = useMemo(() => {
    for (const step of steps) if (step.index === activeStepIndex) return step
    return null
  }, [steps, activeStepIndex])
  const sending = !!(sendState && sendState.phase === 'sending')

  const sendStep = useCallback(
    (step, followRedirects) => {
      if (!vuln || !step) return
      const request = {
        vulnId: vuln.id,
        method: step.method,
        url: step.url,
        headers: requestHeadersForSend(step.headers),
        body: step.body || '',
        followRedirects: !!followRedirects,
      }
      const seq = sendSeqRef.current + 1
      sendSeqRef.current = seq
      setActiveStepIndex(step.index)
      setResponseMode('raw')
      setSendState({ phase: 'sending', step, request, response: null, error: null })
      api
        .post('/retest/send', request)
        .then((response) => {
          if (sendSeqRef.current !== seq) return
          setSendState({ phase: 'ok', step, request, response: response || {}, error: null })
          const status = response && response.status
          const tone = Number(status) >= 200 && Number(status) < 400 ? 'ok' : 'info'
          toast(t('toast.sent', { status: status === undefined || status === null ? '—' : status }), tone)
        })
        .catch((error) => {
          if (sendSeqRef.current !== seq) return
          setSendState({ phase: 'error', step, request, response: null, error })
          toast(t('toast.sendFailed'), 'error')
        })
    },
    [api, vuln, t, toast],
  )

  const applyStatus = useCallback(() => {
    if (!vuln || readOnly || !statusValue) return
    setStatusSaving(true)
    setStatusError(null)
    api
      .patch(`/vulns/${encodeURIComponent(vuln.id)}/status`, { status: statusValue })
      .then(() => {
        toast(t('toast.statusSaved', { status: statusLabel(t, statusValue) }), 'ok')
        setListState((previous) => {
          if (!previous.data || !Array.isArray(previous.data.items)) return previous
          return {
            ...previous,
            data: {
              ...previous.data,
              items: previous.data.items.map((item) => (item.id === vuln.id ? { ...item, status: statusValue } : item)),
            },
          }
        })
        setDetailReload((value) => value + 1)
      })
      .catch((error) => {
        setStatusError(error)
        toast(t('toast.statusFailed'), 'error')
      })
      .finally(() => {
        setStatusSaving(false)
      })
  }, [api, vuln, readOnly, statusValue, t, toast])

  // ---------------------------------------------------------------- list panel

  const listItems = asArray(listState.data && listState.data.items).filter(
    (item) => item && String(item.realm || 'web').toLowerCase() !== 'internal',
  )

  const listPanel = h(
    'div',
    { className: 'dshc-col', style: { padding: 10 } },
    h(
      Toolbar,
      null,
      h(Input, {
        type: 'search',
        value: searchInput,
        placeholder: t('list.searchPlaceholder'),
        'aria-label': t('list.searchAria'),
        onChange: (event) => setSearchInput(event.target.value),
      }),
      h(Button, {
        size: 'sm',
        icon: 'refresh',
        title: t('list.reload'),
        disabled: listState.phase === 'loading',
        onClick: () => setListReload((value) => value + 1),
      }),
    ),
    listState.error ? h(ErrorBox, { error: listState.error, t, onRetry: () => setListReload((value) => value + 1) }) : null,
    listState.phase === 'loading' && listItems.length === 0 ? h(Spinner, { label: t('list.loading') }) : null,
    listState.phase !== 'loading' && !listState.error && listItems.length === 0
      ? h(Empty, { icon: 'shield', title: t('list.emptyTitle'), hint: t('list.emptyHint') })
      : null,
    listItems.length
      ? h(
          'div',
          { className: 'dshc-list' },
          listItems.map((item) =>
            h(
              'button',
              {
                key: String(item.id),
                type: 'button',
                className: 'dshc-list-item',
                'aria-current': String(selectedId) === String(item.id) ? 'true' : undefined,
                onClick: () => setSelectedId(String(item.id)),
              },
              h('span', { className: 'dshc-list-main' }, item.vulnName || item.id || '—'),
              h(
                'span',
                { className: 'dshc-list-meta' },
                h(Badge, { tone: severityTone(item.severity) }, item.severity || '—'),
                h(Badge, { tone: statusTone(item.status) }, statusLabel(t, item.status)),
                h(Mono, { className: 'dshc-small' }, item.id || '—'),
              ),
            ),
          ),
        )
      : null,
    listState.data && Number(listState.data.pages) > 1
      ? h(Pager, {
          page: Number(listState.data.page) || page,
          pages: Number(listState.data.pages) || 1,
          total: Number(listState.data.total) || listItems.length,
          pageSize: PAGE_SIZE,
          t,
          onPage: setPage,
        })
      : null,
    h('div', { className: 'dshc-small dshc-muted' }, t('list.webOnlyHint')),
  )

  // -------------------------------------------------------------- detail panel

  function renderStatusCard() {
    const options = STATUS_VALUES.map((value) => ({ value, label: statusLabel(t, value) }))
    return h(
      Card,
      { title: t('card.status') },
      h(
        'div',
        { className: 'dshc-col' },
        h(
          'div',
          { className: 'dshc-flex' },
          h('span', { className: 'dshc-small dshc-muted' }, t('status.current')),
          h(Badge, { tone: statusTone(vuln.status) }, statusLabel(t, vuln.status)),
          h('div', { className: 'dshc-spacer' }),
          h(Select, {
            value: statusValue,
            options,
            disabled: readOnly || statusSaving || !statusValue,
            'aria-label': t('status.selectAria'),
            onChange: (event) => setStatusValue(event.target.value),
          }),
          h(
            Button,
            {
              size: 'sm',
              variant: 'primary',
              icon: 'check',
              disabled: readOnly || statusSaving || !statusValue,
              title: readOnly ? t('status.readOnlyHint') : t('action.applyStatus'),
              onClick: applyStatus,
            },
            statusSaving ? t('status.saving') : t('action.applyStatus'),
          ),
        ),
        readOnly ? h('div', { className: 'dshc-small dshc-muted' }, t('status.readOnlyHint')) : null,
        statusError ? h(ErrorBox, { error: statusError, t }) : null,
      ),
    )
  }

  function renderInfoCard() {
    const items = [
      [t('detail.id'), h(Mono, null, vuln.id || '—')],
      [t('detail.host'), vuln.host || '—'],
      [t('detail.realm'), vuln.realm || '—'],
      [t('detail.targetUrl'), vuln.targetUrl ? h(Mono, { className: 'dshc-break' }, vuln.targetUrl) : '—'],
      [t('detail.entryPoint'), vuln.entryPoint || '—'],
      [t('detail.retestCount'), String(Number(vuln.retestCount) || 0)],
      [t('detail.latestRetestAt'), vuln.latestRetestAt ? fmtTime(vuln.latestRetestAt, locale) : '—'],
      [t('detail.createdAt'), vuln.createdAt ? fmtTime(vuln.createdAt, locale) : '—'],
    ]
    if (vuln.serviceHost) items.push([t('detail.serviceHost'), vuln.serviceHost])
    return h(
      Card,
      {
        title: vuln.vulnName || vuln.id || '—',
        subtitle: joinMeta([vuln.id, vuln.host, vuln.targetUrl]),
        actions: h(
          'div',
          { className: 'dshc-flex' },
          h(Badge, { tone: severityTone(vuln.severity) }, vuln.severity || '—'),
          h(Badge, { tone: statusTone(vuln.status) }, statusLabel(t, vuln.status)),
          related.length ? h(Badge, { tone: 'neutral' }, t('detail.relatedCount', { count: related.length })) : null,
        ),
      },
      h(KeyValue, { items }),
    )
  }

  function renderStepsCard() {
    if (steps.length === 0) {
      return h(
        Card,
        { title: t('card.steps') },
        h(Empty, { icon: 'play', title: t('steps.emptyTitle'), hint: t('steps.emptyHint') }),
      )
    }
    return h(
      Card,
      { title: t('card.steps'), subtitle: t('steps.count', { count: steps.length }) },
      h(
        'div',
        { className: 'dshc-col' },
        h(
          'div',
          { className: 'dshc-flex' },
          steps.map((step) =>
            h(
              Button,
              {
                key: `step-${step.index}`,
                size: 'sm',
                variant: activeStepIndex === step.index ? 'primary' : 'secondary',
                icon: 'play',
                disabled: sending,
                'aria-label': t('step.aria', { n: step.index }),
                'aria-pressed': activeStepIndex === step.index ? 'true' : undefined,
                onClick: () => sendStep(step, false),
              },
              t('step.label', { n: step.index }),
              step.title ? h('span', { className: 'dshc-small dshc-muted' }, step.title) : null,
            ),
          ),
        ),
        h('div', { className: 'dshc-small dshc-muted' }, t('steps.hint')),
      ),
    )
  }

  function renderRequestCard() {
    if (!activeStep) return null
    const requestHeaders = headersText(activeStep.headers)
    return h(
      Card,
      {
        title: t('card.request'),
        actions: h(Badge, { tone: 'neutral' }, activeStep.method),
      },
      h(
        'div',
        { className: 'dshc-col' },
        h('div', { className: 'dshc-mono dshc-break' }, `${activeStep.method} ${activeStep.url}`),
        requestHeaders ? h(Pre, { 'aria-label': t('card.requestHeaders') }, requestHeaders) : null,
        activeStep.body ? h(Pre, { 'aria-label': t('card.requestBody') }, activeStep.body) : null,
        h('div', { className: 'dshc-small dshc-muted' }, t('card.requestHint')),
      ),
    )
  }

  function renderRedirectChain(response) {
    const redirects = asArray(response && response.redirects)
    if (redirects.length === 0) return null
    return h(
      Section,
      { title: t('resp.redirects') },
      h(
        'div',
        { className: 'dshc-col' },
        redirects.map((hop, index) =>
          h(
            'div',
            { key: `redirect-${index}`, className: 'dshc-flex dshc-small' },
            h(Mono, null, `#${index + 1}`),
            h(Mono, { className: 'dshc-break' }, String((hop && hop.url) || '—')),
            h(Badge, { tone: httpStatusTone(hop && hop.status) }, String((hop && hop.status) === undefined ? '—' : hop.status)),
            h(Mono, { className: 'dshc-break' }, String((hop && hop.location) || '—')),
          ),
        ),
      ),
    )
  }

  function renderResponse() {
    if (!sendState) return null
    const response = sendState.response
    const error = sendState.error
    const status = response ? response.status : null
    const location = headerValue(response && response.headers, 'location')
    const canFollow = !!(response && (Number(status) >= 300 && Number(status) < 400) && location)
    const allowedOrigins = allowedOriginsOf(error)
    const originNotAllowed = isOriginNotAllowed(error)
    const request = sendState.request || {}

    let content
    if (sendState.phase === 'sending') {
      content = h(Spinner, { label: t('resp.sending') })
    } else if (sendState.phase === 'error') {
      content = h(
        'div',
        { className: 'dshc-col' },
        h(ErrorBox, { error, t, onRetry: () => sendStep(sendState.step, !!request.followRedirects) }),
        originNotAllowed ? h('div', { className: 'dshc-small dshc-muted' }, t('error.originHint')) : null,
        allowedOrigins.length
          ? h(
              'div',
              { className: 'dshc-col' },
              h('div', { className: 'dshc-small dshc-muted' }, t('error.allowedOrigins')),
              h(Pre, null, allowedOrigins.join('\n')),
            )
          : null,
        request.url ? h('div', { className: 'dshc-small dshc-muted dshc-break' }, t('error.requestUrl', { url: request.url })) : null,
      )
    } else if (response) {
      const urlItems = []
      if (response.url) urlItems.push([t('resp.url'), h(Mono, { className: 'dshc-break' }, String(response.url))])
      if (response.finalUrl && response.finalUrl !== response.url) {
        urlItems.push([t('resp.finalUrl'), h(Mono, { className: 'dshc-break' }, String(response.finalUrl))])
      }
      const bodyText = response.body === undefined || response.body === null ? '' : String(response.body)
      content = h(
        'div',
        { className: 'dshc-col' },
        h(
          'div',
          { className: 'dshc-flex' },
          h(
            Badge,
            { tone: httpStatusTone(status), title: t('resp.statusTitle') },
            `${status === undefined || status === null ? '—' : status}${response.statusText ? ` ${response.statusText}` : ''}`,
          ),
          h('span', { className: 'dshc-small dshc-muted' }, t('resp.duration', { value: fmtDuration(response.durationMs) })),
          h('span', { className: 'dshc-small dshc-muted' }, t('resp.bodyBytes', { value: bytes(response.bodyBytes) })),
          response.contentType ? h('span', { className: 'dshc-mono dshc-small' }, String(response.contentType)) : null,
          response.bodyTruncated ? h(Badge, { tone: 'warn' }, t('resp.truncated')) : null,
          h('div', { className: 'dshc-spacer' }),
          h(
            'div',
            { className: 'dshc-flex' },
            h(
              Button,
              {
                size: 'sm',
                variant: responseMode === 'raw' ? 'primary' : 'secondary',
                'aria-pressed': responseMode === 'raw' ? 'true' : undefined,
                onClick: () => setResponseMode('raw'),
              },
              t('resp.raw'),
            ),
            h(
              Button,
              {
                size: 'sm',
                variant: responseMode === 'html' ? 'primary' : 'secondary',
                'aria-pressed': responseMode === 'html' ? 'true' : undefined,
                onClick: () => setResponseMode('html'),
              },
              t('resp.html'),
            ),
          ),
        ),
        urlItems.length ? h(KeyValue, { items: urlItems }) : null,
        renderRedirectChain(response),
        canFollow
          ? h(
              'div',
              { className: 'dshc-flex' },
              h(
                Button,
                { size: 'sm', variant: 'primary', icon: 'play', disabled: sending, onClick: () => sendStep(sendState.step, true) },
                t('action.followRedirect'),
              ),
              h('span', { className: 'dshc-small dshc-muted dshc-break' }, t('resp.followHint', { location })),
            )
          : null,
        responseMode === 'html'
          ? h(
              'div',
              { className: 'dshc-col' },
              h('iframe', {
                className: 'dshc-iframe',
                sandbox: '',
                srcDoc: bodyText,
                title: t('resp.htmlTitle'),
              }),
              h('div', { className: 'dshc-small dshc-muted' }, t('resp.htmlHint')),
            )
          : h(Pre, { 'aria-label': t('resp.rawTitle') }, bodyText || t('resp.emptyBody')),
      )
    } else {
      content = h(Empty, { title: t('resp.emptyBody') })
    }

    return h(
      Card,
      {
        title: t('card.response'),
        actions: h(
          'div',
          { className: 'dshc-flex' },
          h(Badge, { tone: 'neutral' }, `${request.method || '—'} ${request.url || ''}`.trim()),
        ),
      },
      content,
    )
  }

  let detailPanel
  if (!selectedId) {
    detailPanel = h(Card, null, h(Empty, { icon: 'play', title: t('detail.selectTitle'), hint: t('detail.selectHint') }))
  } else if (detailState.phase === 'error') {
    detailPanel = h(
      Card,
      { title: t('detail.errorTitle') },
      h(ErrorBox, { error: detailState.error, t, onRetry: () => setDetailReload((value) => value + 1) }),
    )
  } else if (!vuln) {
    detailPanel = h(Card, null, h(Spinner, { label: t('detail.loading') }))
  } else {
    detailPanel = h(
      'div',
      { className: 'dshc-col' },
      renderStatusCard(),
      renderInfoCard(),
      renderStepsCard(),
      renderRequestCard(),
      renderResponse(),
    )
  }

  return h(Split, { list: listPanel, detail: detailPanel, breakpoint: 860 })
}

module.exports = { id: 'retest', messages, Component }
