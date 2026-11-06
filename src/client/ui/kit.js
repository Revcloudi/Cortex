// UI primitives for the Cortex page.
//
// Rules: no DSH Client package imports, no literal colors for chrome (only
// --dsw-alias-* / --dsw-specific-* theme tokens through src/client/styles.js
// classes), accessible markup, keyboard support, reduced-motion friendly.
const React = require('react')
const { useState, useEffect, useRef, useMemo, useCallback } = React
const h = React.createElement

function cx() {
  const out = []
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i]
    if (!value) continue
    out.push(String(value))
  }
  return out.join(' ')
}

const EMPTY_ARRAY = []

// ---------------------------------------------------------------- buttons

function Button(props) {
  const variant = props.variant || 'secondary'
  const className = cx(
    'dshc-btn',
    variant === 'primary' && 'dshc-btn-primary',
    variant === 'ghost' && 'dshc-btn-ghost',
    variant === 'danger' && 'dshc-btn-danger',
    props.size === 'sm' && 'dshc-btn-sm',
    props.className,
  )
  return h(
    'button',
    {
      type: props.type || 'button',
      className,
      title: props.title,
      onClick: props.onClick,
      disabled: props.disabled,
      'aria-label': props['aria-label'],
      'aria-pressed': props['aria-pressed'],
    },
    props.icon ? h(Icon, { name: props.icon, size: 13 }) : null,
    props.children,
  )
}

function IconButton(props) {
  return h(
    'button',
    {
      type: 'button',
      className: cx('dshc-btn', 'dshc-btn-ghost', props.size === 'sm' && 'dshc-btn-sm', props.className),
      title: props.title,
      'aria-label': props['aria-label'] || props.title,
      'aria-pressed': props['aria-pressed'],
      onClick: props.onClick,
      disabled: props.disabled,
    },
    h(Icon, { name: props.icon, size: props.size === 'sm' ? 13 : 15 }),
    props.children || null,
  )
}

// ---------------------------------------------------------------- badges

const TONE_CLASS = {
  neutral: 'dshc-badge-neutral',
  brand: 'dshc-badge-brand',
  success: 'dshc-badge-success',
  warn: 'dshc-badge-warn',
  error: 'dshc-badge-error',
  idle: 'dshc-badge-idle',
}

function Badge(props) {
  const tone = TONE_CLASS[props.tone] ? props.tone : 'neutral'
  return h('span', { className: cx('dshc-badge', TONE_CLASS[tone], props.className), title: props.title }, props.children)
}

function severityTone(severity) {
  switch (String(severity || '').toLowerCase()) {
    case 'critical':
      return 'error'
    case 'high':
      return 'warn'
    case 'medium':
      return 'brand'
    case 'low':
      return 'success'
    case 'info':
      return 'idle'
    default:
      return 'neutral'
  }
}

function statusTone(status) {
  switch (String(status || '').toLowerCase()) {
    case 'confirmed':
      return 'brand'
    case 'retest_passed':
      return 'success'
    case 'inconclusive':
      return 'warn'
    default:
      return 'neutral'
  }
}

function realmTone(realm) {
  return String(realm || '').toLowerCase() === 'internal' ? 'warn' : 'neutral'
}

function sevBadge(severity) {
  return h(Badge, { tone: severityTone(severity) }, severity || '—')
}

function statusBadge(status) {
  return h(Badge, { tone: statusTone(status) }, status || '—')
}

// ---------------------------------------------------------------- surfaces

function Card(props) {
  const head = props.title || props.subtitle || props.actions
  return h(
    'section',
    { className: cx('dshc-card', props.className), style: props.style, 'aria-label': props['aria-label'] || props.title },
    head
      ? h(
          'div',
          { className: 'dshc-card-head' },
          props.title ? h('div', { className: 'dshc-card-title' }, props.title) : null,
          props.subtitle ? h('div', { className: 'dshc-card-sub' }, props.subtitle) : null,
          h('div', { className: 'dshc-spacer' }),
          props.actions ? h('div', { className: 'dshc-header-actions' }, props.actions) : null,
        )
      : null,
    h('div', { className: cx('dshc-card-body', props.flush && 'dshc-card-body-flush') }, props.children),
  )
}

function Section(props) {
  return h(
    'div',
    { className: cx('dshc-section', props.className) },
    props.title || props.actions
      ? h(
          'div',
          { className: 'dshc-section-head' },
          props.title ? h('div', { className: 'dshc-section-title' }, props.title) : null,
          props.subtitle ? h('div', { className: 'dshc-small dshc-muted' }, props.subtitle) : null,
          h('div', { className: 'dshc-spacer' }),
          props.actions ? h('div', { className: 'dshc-header-actions' }, props.actions) : null,
        )
      : null,
    props.children,
  )
}

function Toolbar(props) {
  return h(
    'div',
    { className: cx('dshc-toolbar', props.className) },
    props.children,
    props.right ? h('div', { className: 'dshc-toolbar-right' }, props.right) : null,
  )
}

function Spinner(props) {
  return h(
    'div',
    { className: 'dshc-spinner', role: 'status', 'aria-live': 'polite' },
    h('span', { className: 'dshc-spinner-dot', 'aria-hidden': 'true' }),
    h('span', null, props.label || 'Loading…'),
  )
}

function Empty(props) {
  return h(
    'div',
    { className: 'dshc-empty' },
    props.icon ? h(Icon, { name: props.icon, size: 22 }) : null,
    props.title ? h('div', { className: 'dshc-empty-title' }, props.title) : null,
    props.hint ? h('div', { className: 'dshc-empty-hint' }, props.hint) : null,
    props.action || null,
  )
}

function describeError(error, t) {
  const translate = typeof t === 'function' ? t : (key) => key
  const code = error && error.code ? String(error.code) : ''
  const map = {
    FORBIDDEN_PEER: 'error.forbiddenPeer',
    FORBIDDEN_HOST: 'error.forbiddenPeer',
    FORBIDDEN_ORIGIN: 'error.forbiddenPeer',
    SCHEMA_INCOMPATIBLE: 'error.schemaIncompatible',
    READ_ONLY: 'error.readOnly',
    NOT_FOUND: 'error.notFound',
    BAD_REQUEST: 'error.badRequest',
    UPSTREAM_ERROR: 'error.upstream',
    UPSTREAM_TIMEOUT: 'error.upstreamTimeout',
    ORIGIN_NOT_ALLOWED: 'error.originNotAllowed',
    INTERNAL: 'error.internal',
    NETWORK: 'error.network',
    TIMEOUT: 'error.network',
  }
  const title = map[code] ? translate(map[code]) : translate('error.generic')
  const detail = error && error.message ? String(error.message) : ''
  return { title, detail, code }
}

function ErrorBox(props) {
  const info = describeError(props.error, props.t)
  return h(
    'div',
    { className: 'dshc-error', role: 'alert' },
    h('div', { className: 'dshc-error-title' }, props.title || info.title),
    info.detail && info.detail !== info.title ? h('div', { className: 'dshc-error-detail dshc-mono' }, info.detail) : null,
    info.code ? h('div', { className: 'dshc-error-detail dshc-small' }, `code: ${info.code}`) : null,
    props.onRetry
      ? h(Button, { size: 'sm', onClick: props.onRetry, icon: 'refresh' }, props.retryLabel || (typeof props.t === 'function' ? props.t('common.retry') : 'Retry'))
      : null,
  )
}

// ---------------------------------------------------------------- form

function Field(props) {
  const id = props.id || `dshc-field-${Math.random().toString(36).slice(2, 8)}`
  return h(
    'div',
    { className: cx('dshc-field', props.className), style: props.style },
    props.label ? h('label', { className: 'dshc-field-label', htmlFor: id }, props.label) : null,
    props.children ? h('div', null, React.cloneElement ? React.cloneElement(props.children, { id }) : props.children) : null,
    props.hint ? h('div', { className: 'dshc-field-hint' }, props.hint) : null,
  )
}

function Input(props) {
  return h('input', {
    className: cx('dshc-input', props.className),
    style: props.style,
    id: props.id,
    type: props.type || 'text',
    value: props.value === undefined || props.value === null ? '' : props.value,
    placeholder: props.placeholder,
    onChange: props.onChange,
    onKeyDown: props.onKeyDown,
    disabled: props.disabled,
    'aria-label': props['aria-label'],
    spellCheck: false,
  })
}

function Select(props) {
  return h(
    'select',
    {
      className: cx('dshc-select', props.className),
      style: props.style,
      id: props.id,
      value: props.value,
      onChange: props.onChange,
      disabled: props.disabled,
      'aria-label': props['aria-label'],
    },
    (props.options || []).map((option) =>
      h('option', { key: String(option.value), value: option.value }, option.label),
    ),
  )
}

// ---------------------------------------------------------------- tables

function DataTable(props) {
  const columns = Array.isArray(props.columns) ? props.columns : EMPTY_ARRAY
  const rows = Array.isArray(props.rows) ? props.rows : EMPTY_ARRAY
  const clickable = typeof props.onRowActivate === 'function'
  const keyOf = (row, index) => {
    if (typeof props.rowKey === 'function') return props.rowKey(row, index)
    if (props.rowKey && row && row[props.rowKey] !== undefined) return row[props.rowKey]
    return index
  }
  return h(
    'div',
    { className: 'dshc-table-wrap' },
    h(
      'table',
      { className: cx('dshc-table', props.dense && 'dshc-table-dense'), 'aria-label': props.ariaLabel },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          columns.map((column) =>
            h(
              'th',
              {
                key: column.key || column.label,
                scope: 'col',
                style: { width: column.width, textAlign: column.align || 'left' },
                title: column.title,
              },
              column.label,
            ),
          ),
        ),
      ),
      h(
        'tbody',
        null,
        rows.length === 0
          ? h('tr', null, h('td', { colSpan: Math.max(1, columns.length) }, props.empty || h(Empty, { title: '—' })))
          : rows.map((row, index) => {
              const key = keyOf(row, index)
              const isActive = props.activeKey !== undefined && String(props.activeKey) === String(key)
              return h(
                'tr',
                {
                  key: String(key),
                  'data-clickable': clickable ? 'true' : 'false',
                  'data-active': isActive ? 'true' : 'false',
                  'aria-selected': clickable ? isActive : undefined,
                  tabIndex: clickable ? 0 : undefined,
                  onClick: clickable ? () => props.onRowActivate(row, index) : undefined,
                  onKeyDown: clickable
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          props.onRowActivate(row, index)
                        }
                      }
                    : undefined,
                },
                columns.map((column) =>
                  h(
                    'td',
                    {
                      key: column.key || column.label,
                      style: Object.assign({ textAlign: column.align || 'left' }, column.cellStyle),
                      className: column.align === 'right' ? 'dshc-num' : undefined,
                    },
                    column.render ? column.render(row, index) : row[column.key],
                  ),
                ),
              )
            }),
      ),
    ),
    props.footer || null,
  )
}

// ---------------------------------------------------------------- layout

function useIsNarrow(breakpoint) {
  const query = `(max-width: ${breakpoint || 860}px)`
  const read = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    try {
      return window.matchMedia(query).matches
    } catch {
      return false
    }
  }
  const [narrow, setNarrow] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    let media
    try {
      media = window.matchMedia(query)
    } catch {
      return undefined
    }
    const onChange = () => setNarrow(media.matches)
    if (media.addEventListener) media.addEventListener('change', onChange)
    else if (media.addListener) media.addListener(onChange)
    return () => {
      if (media.removeEventListener) media.removeEventListener('change', onChange)
      else if (media.removeListener) media.removeListener(onChange)
    }
  }, [query])
  return narrow
}

function Split(props) {
  const narrow = useIsNarrow(props.breakpoint)
  const list = h(
    'div',
    { className: 'dshc-card', style: narrow ? { maxHeight: '36vh', overflow: 'auto' } : { maxHeight: 'calc(100vh - 240px)', overflow: 'auto' } },
    props.list,
  )
  const detail = h('div', { style: { minWidth: 0 } }, props.detail || props.emptyDetail || null)
  if (narrow) return h('div', { className: 'dshc-col' }, list, detail)
  return h('div', { className: 'dshc-split' }, list, detail)
}

function KeyValue(props) {
  const items = Array.isArray(props.items) ? props.items : EMPTY_ARRAY
  return h(
    'div',
    { className: 'dshc-kv', style: props.style },
    items.map((item, index) => {
      const key = Array.isArray(item) ? item[0] : item.k
      const value = Array.isArray(item) ? item[1] : item.v
      return h(
        React.Fragment,
        { key: `${key}-${index}` },
        h('div', { className: 'dshc-kv-k' }, key),
        h('div', { className: 'dshc-kv-v' }, value === undefined || value === null || value === '' ? '—' : value),
      )
    }),
  )
}

function Mono(props) {
  return h('span', { className: cx('dshc-mono', props.className), title: props.title }, props.children)
}

function Pre(props) {
  return h('pre', { className: cx('dshc-pre', props.className), style: props.style, 'aria-label': props['aria-label'] }, props.children)
}

// ---------------------------------------------------------------- tabs / pager / modal

function Tabs(props) {
  const items = Array.isArray(props.items) ? props.items : EMPTY_ARRAY
  const refs = useRef({})
  const onKeyDown = (event) => {
    const index = items.findIndex((item) => item.id === props.value)
    if (index < 0) return
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % items.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else return
    event.preventDefault()
    const target = items[next]
    if (typeof props.onChange === 'function') props.onChange(target.id)
    const node = refs.current[target.id]
    if (node && node.focus) node.focus()
  }
  return h(
    'div',
    { className: 'dshc-tabs', role: 'tablist', 'aria-label': props.ariaLabel, onKeyDown },
    items.map((item) =>
      h(
        'button',
        {
          key: item.id,
          ref: (node) => {
            refs.current[item.id] = node
          },
          type: 'button',
          role: 'tab',
          id: `dshc-tab-${item.id}`,
          'aria-selected': props.value === item.id ? 'true' : 'false',
          tabIndex: props.value === item.id ? 0 : -1,
          className: 'dshc-tab',
          onClick: () => props.onChange && props.onChange(item.id),
        },
        item.label,
      ),
    ),
  )
}

function Pager(props) {
  const t = typeof props.t === 'function' ? props.t : (key, vars) => {
    if (key === 'common.page') return `Page ${vars.page} / ${vars.pages}`
    if (key === 'common.total') return `${vars.total} total`
    return key
  }
  const pages = Math.max(1, Number(props.pages) || 1)
  const page = Math.min(pages, Math.max(1, Number(props.page) || 1))
  const sizes = props.pageSizes || [20, 50, 100]
  return h(
    'div',
    { className: 'dshc-pager' },
    h(Button, { size: 'sm', disabled: page <= 1, onClick: () => props.onPage(page - 1) }, t('common.prev')),
    h('span', null, t('common.page', { page, pages })),
    h(Button, { size: 'sm', disabled: page >= pages, onClick: () => props.onPage(page + 1) }, t('common.next')),
    h('span', { className: 'dshc-muted' }, t('common.total', { total: props.total || 0 })),
    h('div', { className: 'dshc-spacer' }),
    props.onPageSize
      ? h(
          'label',
          { className: 'dshc-flex' },
          h('span', { className: 'dshc-muted dshc-small' }, 'pageSize'),
          h(Select, {
            value: props.pageSize,
            options: sizes.map((size) => ({ value: size, label: String(size) })),
            onChange: (event) => props.onPageSize(Number(event.target.value)),
            'aria-label': 'Page size',
          }),
        )
      : null,
  )
}

function Modal(props) {
  const panelRef = useRef(null)
  useEffect(() => {
    if (!props.open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (props.onClose) props.onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = panelRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    const timer = setTimeout(() => {
      if (panelRef.current) {
        const focusable = panelRef.current.querySelector('button, input, select, textarea, [tabindex]')
        if (focusable && focusable.focus) focusable.focus()
      }
    }, 0)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      clearTimeout(timer)
    }
  }, [props.open, props.onClose])
  if (!props.open) return null
  return h(
    'div',
    {
      className: 'dshc-modal-backdrop',
      onMouseDown: (event) => {
        if (event.target === event.currentTarget && props.onClose) props.onClose()
      },
    },
    h(
      'div',
      {
        className: 'dshc-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': props.title,
        ref: panelRef,
      },
      h(
        'div',
        { className: 'dshc-modal-head' },
        h('div', { className: 'dshc-modal-title' }, props.title),
        h(IconButton, { icon: 'close', title: props.closeLabel || 'Close', onClick: props.onClose }),
      ),
      h('div', { className: 'dshc-modal-body' }, props.children),
      props.footer ? h('div', { className: 'dshc-modal-foot' }, props.footer) : null,
    ),
  )
}

// ---------------------------------------------------------------- icons (16px grid, linear)

const ICON_PATHS = {
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V6H10',
  settings:
    'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M13.2 9.7l.9.6-1 1.7-1-.4a4.6 4.6 0 0 1-1.2.7l-.2 1h-2l-.2-1a4.6 4.6 0 0 1-1.2-.7l-1 .4-1-1.7.9-.6a4.8 4.8 0 0 1 0-1.4l-.9-.6 1-1.7 1 .4a4.6 4.6 0 0 1 1.2-.7l.2-1h2l.2 1c.4.2.8.4 1.2.7l1-.4 1 1.7-.9.6c.1.5.1.9 0 1.4Z',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.5 10.5 14 14',
  close: 'M4 4l8 8M12 4l-8 8',
  'chevron-right': 'M6 3.5 10.5 8 6 12.5',
  'chevron-down': 'M3.5 6 8 10.5 12.5 6',
  warning: 'M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.2v.3',
  database: 'M8 5.5c3 0 5.5-.7 5.5-1.5S11 2.5 8 2.5 2.5 3.2 2.5 4 5 5.5 8 5.5Zm5.5-1.5v9c0 .8-2.5 1.5-5.5 1.5S2.5 13.8 2.5 13V4m11 4.5c0 .8-2.5 1.5-5.5 1.5s-5.5-.7-5.5-1.5',
  external: 'M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3',
  check: 'M3 8.5 6.5 12l6.5-8',
  play: 'M4.5 3.5v9l8-4.5-8-4.5Z',
  download: 'M8 2.5v7M5 7l3 2.5L11 7M3 13h10',
  'arrow-left': 'M12.5 8h-9M7 3.5 3.5 8 7 12.5',
  shield: 'M8 2.5 13 4.5v4c0 3-2.2 4.8-5 5.5-2.8-.7-5-2.5-5-5.5v-4L8 2.5Z',
  server: 'M2.5 4.5h11v3h-11v-3Zm0 5h11v3h-11v-3ZM12 6h.01M12 11h.01',
  network: 'M8 2.5v3M4 13.5 8 9l4 4.5M3 8.5h10v3H3v-3Z',
  layers: 'M8 2.5 14 6l-6 3.5L2 6l6-3.5ZM2 10l6 3.5L14 10',
}

function Icon(props) {
  const size = props.size || 16
  const path = ICON_PATHS[props.name] || ICON_PATHS.database
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { flex: 'none', display: 'block' },
    },
    path.split(' M').map((segment, index) => h('path', { key: index, d: index === 0 ? segment : `M${segment}` })),
  )
}

module.exports = {
  h,
  React,
  cx,
  Icon,
  Button,
  IconButton,
  Badge,
  severityTone,
  statusTone,
  realmTone,
  sevBadge,
  statusBadge,
  Card,
  Section,
  Toolbar,
  Spinner,
  Empty,
  ErrorBox,
  describeError,
  Field,
  Input,
  Select,
  DataTable,
  useIsNarrow,
  Split,
  KeyValue,
  Mono,
  Pre,
  Tabs,
  Pager,
  Modal,
}
