// dsh-cortex client bundle — GENERATED FILE, DO NOT EDIT.
// Built from src/client/** by scripts/build-client.mjs. Rebuild with: node scripts/build-client.mjs
// modules: 14; entry: index.js
window.__ModuleLoader__.load({
  id: "dsh-cortex",
  factory: (require) => {
    "use strict";
    const __factories = Object.create(null);
    const __cache = Object.create(null);
    function __resolve(fromId, spec) {
      if (spec === "react") return "@react";
      if (spec.charAt(0) !== ".") throw new Error("module not available: " + spec);
      const parts = fromId.split("/"); parts.pop();
      for (const piece of spec.split("/")) {
        if (!piece || piece === ".") continue;
        if (piece === "..") parts.pop(); else parts.push(piece);
      }
      const id = parts.join("/");
      return id.endsWith(".js") ? id : id + ".js";
    }
    function __load(id) {
      if (__cache[id]) return __cache[id].exports;
      const factory = __factories[id];
      if (!factory) throw new Error("module not found: " + id);
      const module = { exports: {} };
      __cache[id] = module;
      const localRequire = (spec) => spec === "react" ? require("react") : __load(__resolve(id, spec));
      factory(module, module.exports, localRequire);
      return module.exports;
    }
    __factories["ui/kit.js"] = function (module, exports, require) {
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

    };
    __factories["lib/api.js"] = function (module, exports, require) {
// Same-origin API client for the plugin's own Host half (/cortex-api).
// The browser half NEVER touches the filesystem or the Cortex database directly.
const DEFAULT_BASE = '/cortex-api'

class ApiError extends Error {
  constructor(message, options) {
    super(message || 'request failed')
    this.name = 'ApiError'
    const opts = options || {}
    this.status = typeof opts.status === 'number' ? opts.status : 0
    this.code = opts.code || (this.status ? `HTTP_${this.status}` : 'UNKNOWN')
    this.details = opts.details === undefined ? null : opts.details
    this.retryable = opts.retryable !== undefined ? !!opts.retryable : this.status >= 500 || this.status === 0
  }
}

function encodeQuery(query) {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const key of Object.keys(query)) {
    const value = query[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item))
    else params.append(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

function parseErrorPayload(payload, status, statusText) {
  if (!payload || typeof payload !== 'object') {
    return new ApiError(statusText || `HTTP ${status}`, { status })
  }
  const message = typeof payload.error === 'string' && payload.error ? payload.error : statusText || `HTTP ${status}`
  return new ApiError(message, {
    status,
    code: typeof payload.code === 'string' && payload.code ? payload.code : `HTTP_${status}`,
    details: payload.details,
    retryable: status >= 500,
  })
}

function createApi(options) {
  const opts = options || {}
  const base = opts.base || DEFAULT_BASE
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 20000
  const inflight = new Set()

  function abortAll() {
    for (const controller of inflight) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    inflight.clear()
  }

  async function request(path, config) {
    const cfg = config || {}
    const method = cfg.method || 'GET'
    const controller = new AbortController()
    inflight.add(controller)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }, cfg.timeoutMs || timeoutMs)

    const headers = { Accept: cfg.text ? 'text/markdown, text/plain, */*' : 'application/json' }
    let body
    if (cfg.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(cfg.body)
    }

    try {
      const response = await fetch(base + path + encodeQuery(cfg.query), {
        method,
        headers,
        body,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })

      if (!response.ok) {
        let payload = null
        try {
          payload = await response.json()
        } catch {
          /* non-JSON error body */
        }
        const error = parseErrorPayload(payload, response.status, response.statusText)
        if (typeof opts.onError === 'function') {
          try {
            opts.onError(error)
          } catch {
            /* ignore */
          }
        }
        throw error
      }

      if (cfg.text) return await response.text()
      if (cfg.responseType === 'response') return response
      const text = await response.text()
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch {
        throw new ApiError('invalid JSON from Host', { status: 502, code: 'INVALID_JSON' })
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (timedOut) {
        throw new ApiError('request timed out', { status: 0, code: 'TIMEOUT', retryable: true })
      }
      const name = error && error.name
      if (name === 'AbortError') throw new ApiError('request aborted', { status: 0, code: 'ABORTED', retryable: true })
      throw new ApiError('network error: cannot reach the DSH Host', { status: 0, code: 'NETWORK', retryable: true })
    } finally {
      clearTimeout(timer)
      inflight.delete(controller)
    }
  }

  return {
    base,
    abortAll,
    get: (path, query, extra) => request(path, Object.assign({ method: 'GET', query }, extra)),
    getText: (path, query, extra) => request(path, Object.assign({ method: 'GET', query, text: true }, extra)),
    patch: (path, body, extra) => request(path, Object.assign({ method: 'PATCH', body }, extra)),
    post: (path, body, extra) => request(path, Object.assign({ method: 'POST', body }, extra)),
  }
}

function isAbortError(error) {
  return !!error && (error.code === 'ABORTED' || error.name === 'AbortError')
}

module.exports = { ApiError, createApi, isAbortError, encodeQuery }

    };
    __factories["styles.js"] = function (module, exports, require) {
// Styling for the Cortex page. Uses ONLY the DSH theme tokens confirmed by
// cordis_inspect_query (Theme.listTokens); no literal colors for UI chrome.
const CSS = `
.dshc-scope {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  container-type: inline-size;
}
.dshc-scope *, .dshc-scope *::before, .dshc-scope *::after { box-sizing: border-box; }
.dshc-scope button, .dshc-scope input, .dshc-scope select, .dshc-scope textarea { font: inherit; color: inherit; }
.dshc-scope a { color: var(--dsw-alias-brand-primary); }

.dshc-header {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.dshc-title { font-size: 16px; font-weight: 650; letter-spacing: .01em; display: flex; align-items: center; gap: 8px; }
.dshc-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshc-spacer { flex: 1 1 auto; }
.dshc-header-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.dshc-tabs {
  display: flex; gap: 2px; overflow-x: auto; padding: 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  scrollbar-width: thin;
}
.dshc-tab {
  appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  padding: 8px 10px 9px; border-bottom: 2px solid transparent; cursor: pointer;
  white-space: nowrap; border-radius: 6px 6px 0 0; font-size: 13px;
}
.dshc-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.dshc-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dshc-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }

.dshc-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 16px 20px; }
.dshc-page { min-height: 100%; }

.dshc-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 10px 16px 0; padding: 8px 10px; border-radius: 8px; font-size: 12px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
}
.dshc-banner-error { border-color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }

.dshc-grid { display: grid; gap: 12px; }
.dshc-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.dshc-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@container (max-width: 860px) { .dshc-grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 560px) { .dshc-grid-4, .dshc-grid-2 { grid-template-columns: minmax(0, 1fr); } }

.dshc-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  min-width: 0;
}
.dshc-card-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshc-card-title { font-size: 13px; font-weight: 600; }
.dshc-card-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshc-card-body { padding: 12px; min-width: 0; }
.dshc-card-body-flush { padding: 0; }

.dshc-metric { display: flex; flex-direction: column; gap: 2px; padding: 12px; }
.dshc-metric-value { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.dshc-metric-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }

.dshc-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.dshc-toolbar-right { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

.dshc-btn {
  appearance: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 4px 10px; font-size: 12px;
  min-height: 26px; white-space: nowrap;
}
.dshc-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dshc-btn:active { transform: translateY(.5px); }
.dshc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshc-btn[disabled] { opacity: .55; cursor: default; pointer-events: none; }
.dshc-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.dshc-btn-primary:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 86%, var(--dsw-alias-label-primary)); }
.dshc-btn-ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.dshc-btn-ghost:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dshc-btn-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dshc-btn-sm { padding: 2px 8px; min-height: 22px; font-size: 12px; }

.dshc-badge {
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
  padding: 0 7px; min-height: 18px; border-radius: 999px; font-size: 11px; font-weight: 550;
  border: 1px solid var(--dshc-tone, var(--dsw-alias-border-l2));
  color: var(--dshc-tone, var(--dsw-alias-label-secondary));
  background: color-mix(in srgb, var(--dshc-tone, var(--dsw-alias-label-secondary)) 12%, transparent);
}
.dshc-badge-neutral { --dshc-tone: var(--dsw-alias-label-secondary); }
.dshc-badge-brand { --dshc-tone: var(--dsw-alias-brand-primary); }
.dshc-badge-success { --dshc-tone: var(--dsw-alias-state-success-primary); }
.dshc-badge-warn { --dshc-tone: var(--dsw-alias-state-warn-primary); }
.dshc-badge-error { --dshc-tone: var(--dsw-alias-state-error-primary); }
.dshc-badge-idle { --dshc-tone: var(--dsw-alias-state-idle-primary); }

.dshc-input, .dshc-select {
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  border-radius: 7px; padding: 4px 8px; min-height: 26px; min-width: 0; color: var(--dsw-alias-label-primary);
}
.dshc-input:focus-visible, .dshc-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; border-color: transparent; }
.dshc-input::placeholder { color: var(--dsw-alias-label-secondary); }
.dshc-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshc-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshc-field-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }

.dshc-table-wrap { width: 100%; overflow: auto; }
.dshc-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.dshc-table th {
  text-align: left; font-weight: 550; color: var(--dsw-alias-label-secondary); font-size: 11.5px; text-transform: none;
  padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; background: var(--dsw-alias-bg-layer-1);
  position: sticky; top: 0; z-index: 1;
}
.dshc-table td { padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.dshc-table tbody tr:last-child td { border-bottom: 0; }
.dshc-table tbody tr[data-clickable="true"] { cursor: pointer; }
.dshc-table tbody tr[data-clickable="true"]:hover td { background: var(--dsw-alias-bg-layer-2); }
.dshc-table tbody tr[data-active="true"] td { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.dshc-table tbody tr:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshc-table .dshc-num { text-align: right; font-variant-numeric: tabular-nums; }
.dshc-table-dense th, .dshc-table-dense td { padding: 5px 8px; }

.dshc-mono { font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; }
.dshc-pre {
  margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); overflow: auto; max-height: 420px;
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; font-size: 11.5px;
  white-space: pre-wrap; word-break: break-word;
}
.dshc-iframe { width: 100%; min-height: 320px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: #fff; }

.dshc-split { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); gap: 12px; align-items: start; }
@container (max-width: 860px) { .dshc-split { grid-template-columns: minmax(0, 1fr); } }
.dshc-list { display: flex; flex-direction: column; }
.dshc-list-item {
  appearance: none; text-align: left; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: transparent; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 2px;
  color: var(--dsw-alias-label-primary); width: 100%;
}
.dshc-list-item:last-child { border-bottom: 0; }
.dshc-list-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dshc-list-item[aria-current="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.dshc-list-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshc-list-main { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-list-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

.dshc-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; font-size: 12.5px; }
.dshc-kv-k { color: var(--dsw-alias-label-secondary); }
.dshc-kv-v { min-width: 0; overflow-wrap: anywhere; }
.dshc-kv-list { display: flex; flex-direction: column; gap: 6px; }

.dshc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dshc-empty-title { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 13px; }
.dshc-empty-hint { font-size: 12px; max-width: 480px; }

.dshc-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.dshc-error-title { font-weight: 600; color: var(--dsw-alias-state-error-primary); font-size: 12.5px; }
.dshc-error-detail { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }

.dshc-spinner { display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 14px; }
.dshc-spinner-dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: dshc-spin .8s linear infinite; }
@keyframes dshc-spin { to { transform: rotate(360deg); } }

.dshc-pager { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 2px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }

.dshc-modal-backdrop { position: fixed; inset: 0; z-index: 60; background: color-mix(in srgb, #000 32%, transparent); display: flex; align-items: center; justify-content: center; padding: 20px; }
.dshc-modal {
  width: min(560px, 100%); max-height: min(80vh, 720px); overflow: auto;
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0,0,0,.28);
}
.dshc-modal-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshc-modal-title { font-weight: 600; font-size: 14px; flex: 1; }
.dshc-modal-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.dshc-modal-foot { padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; justify-content: flex-end; gap: 8px; }

.dshc-section { display: flex; flex-direction: column; gap: 8px; }
.dshc-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshc-section-title { font-size: 12.5px; font-weight: 600; }
.dshc-hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 10px 0; }
.dshc-md h1, .dshc-md h2, .dshc-md h3, .dshc-md h4 { font-size: 13px; margin: 12px 0 6px; }
.dshc-md h1:first-child, .dshc-md h2:first-child, .dshc-md h3:first-child { margin-top: 0; }
.dshc-md p { margin: 6px 0; }
.dshc-md ul, .dshc-md ol { margin: 6px 0; padding-left: 20px; }
.dshc-md li { margin: 2px 0; }
.dshc-md code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; background: var(--dsw-alias-bg-layer-2); padding: 1px 4px; border-radius: 4px; }
.dshc-md pre { margin: 8px 0; }
.dshc-md table { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.dshc-md th, .dshc-md td { border: 1px solid var(--dsw-alias-border-l1); padding: 4px 8px; text-align: left; }
.dshc-md blockquote { margin: 8px 0; padding: 2px 10px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dshc-clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dshc-clickable { cursor: pointer; }
.dshc-clickable:hover { color: var(--dsw-alias-brand-primary); }
.dshc-scroll-y { overflow-y: auto; }
.dshc-muted { color: var(--dsw-alias-label-secondary); }
.dshc-small { font-size: 11.5px; }
.dshc-nowrap { white-space: nowrap; }
.dshc-break { overflow-wrap: anywhere; }
.dshc-flex { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dshc-flex-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dshc-col { display: flex; flex-direction: column; gap: 8px; }
.dshc-grow { flex: 1 1 auto; min-width: 0; }
.dshc-hidden { display: none !important; }
.dshc-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@media (prefers-reduced-motion: reduce) {
  .dshc-scope *, .dshc-scope *::before, .dshc-scope *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }
}
`
module.exports = { CSS }

    };
    __factories["locales.js"] = function (module, exports, require) {
// Shell-level locale dictionaries (namespace: dsh-cortex).
// Page modules provide their own dictionaries under dsh-cortex.<pageId>.
module.exports = {
  zh: {
    'panel.title': 'Cortex',
    'header.subtitle': '本地漏洞 / 资产 / 内网 / 快照',
    'header.refresh': '刷新',
    'header.refreshHint': '重新读取 Cortex 数据库',
    'header.settings': '设置',
    'header.dbOk': 'DB v{schema}',
    'header.dbReadonly': 'DB 只读',
    'header.dbUnavailable': 'DB 不可用',
    'header.loopback': '仅本机',
    'tabs.label': 'Cortex 页面',
    'tab.overview': '概览',
    'tab.vulns': '漏洞',
    'tab.assets': '资产',
    'tab.internal': '内网',
    'tab.snapshots': '快照',
    'tab.retest': '复测',
    'state.loading': '正在读取 Cortex 数据库…',
    'state.remoteOnly': '仅本机可用',
    'state.remoteOnlyHint': 'Cortex 面板只接受来自 localhost 的访问。请从本机打开 DSH Web UI。',
    'state.schemaIncompatible': '数据库 schema 不兼容',
    'state.schemaIncompatibleHint': '当前 Cortex 数据库的 schema 为 {version}，本插件只支持 v5，且不会自动迁移。请升级 Cortex 或使用兼容版本。',
    'state.dbUnavailable': 'Cortex 数据库不可用',
    'state.dbUnavailableHint': '无法读取 {file}。请确认 Cortex 已初始化数据库，或通过 CORTEX_DB_PATH 指定路径。',
    'state.readonly': '只读模式',
    'state.readonlyHint': '当前为只读模式（CORTEX_DB_READONLY），状态修改与复测追加已禁用。',
    'banner.readonly': '只读模式：写操作已禁用',
    'banner.schema': 'schema v{version} 不兼容：仅显示兼容性提示，不写库',
    'banner.error': '读取失败：{message}',
    'error.retry': '重试',
    'error.generic': '请求失败',
    'error.network': '网络错误，无法连接 DSH Host',
    'error.forbiddenPeer': '非本机访问被拒绝',
    'error.schemaIncompatible': 'Cortex 数据库 schema 不兼容（需要 v5）',
    'error.readOnly': '只读模式，写操作被拒绝',
    'error.notFound': '未找到请求的数据',
    'error.badRequest': '请求参数不合法',
    'error.upstream': '出站请求失败',
    'error.upstreamTimeout': '出站请求超时',
    'error.originNotAllowed': '目标不在允许的 origin 白名单内',
    'error.internal': 'Host 内部错误',
    'common.loading': '加载中…',
    'common.empty': '暂无数据',
    'common.retry': '重试',
    'common.refresh': '刷新',
    'common.close': '关闭',
    'common.cancel': '取消',
    'common.confirm': '确认',
    'common.save': '保存',
    'common.search': '搜索',
    'common.searchPlaceholder': '搜索…',
    'common.prev': '上一页',
    'common.next': '下一页',
    'common.page': '第 {page} / {pages} 页',
    'common.total': '共 {total} 条',
    'common.all': '全部',
    'common.unknown': '未知',
    'common.yes': '是',
    'common.no': '否',
    'common.copy': '复制',
    'common.copied': '已复制',
    'common.download': '下载',
    'common.open': '打开',
    'common.back': '返回',
    'common.more': '更多',
    'common.details': '详情',
    'settings.title': 'Cortex 设置',
    'settings.intro': '本插件由 DSH Host 直接读取本机 Cortex SQLite 数据库，不启动 Cortex 桌面端、CLI、Web 服务或 MCP。',
    'settings.version': '插件版本',
    'settings.dshVersion': 'DSH 版本',
    'settings.node': 'Host Node',
    'settings.dbFile': '数据库文件',
    'settings.schema': 'schema 版本',
    'settings.readonly': '只读模式',
    'settings.loopback': '访问范围',
    'settings.loopbackValue': '仅本机 loopback',
    'settings.dbPathHint': '可用环境变量 CORTEX_DB_PATH 覆盖数据库路径；CORTEX_DB_READONLY=1 强制只读。',
    'settings.reload': '刷新状态',
  },
  en: {
    'panel.title': 'Cortex',
    'header.subtitle': 'Local vulnerabilities / assets / internal / snapshots',
    'header.refresh': 'Refresh',
    'header.refreshHint': 'Re-read the Cortex database',
    'header.settings': 'Settings',
    'header.dbOk': 'DB v{schema}',
    'header.dbReadonly': 'DB read-only',
    'header.dbUnavailable': 'DB unavailable',
    'header.loopback': 'local only',
    'tabs.label': 'Cortex panels',
    'tab.overview': 'Overview',
    'tab.vulns': 'Vulnerabilities',
    'tab.assets': 'Assets',
    'tab.internal': 'Internal',
    'tab.snapshots': 'Snapshots',
    'tab.retest': 'Retest',
    'state.loading': 'Reading the Cortex database…',
    'state.remoteOnly': 'Local access only',
    'state.remoteOnlyHint': 'The Cortex panel only accepts requests from localhost. Open the DSH Web UI on this machine.',
    'state.schemaIncompatible': 'Database schema is not compatible',
    'state.schemaIncompatibleHint': 'The Cortex database schema is {version}; this plugin supports v5 only and never migrates automatically. Upgrade Cortex or use a compatible version.',
    'state.dbUnavailable': 'Cortex database unavailable',
    'state.dbUnavailableHint': 'Cannot read {file}. Make sure Cortex initialized its database, or point CORTEX_DB_PATH at the right file.',
    'state.readonly': 'Read-only mode',
    'state.readonlyHint': 'Read-only mode is active (CORTEX_DB_READONLY); status changes and retest appends are disabled.',
    'banner.readonly': 'Read-only mode: write operations are disabled',
    'banner.schema': 'Incompatible schema v{version}: compatibility notice only, no database writes',
    'banner.error': 'Failed to read: {message}',
    'error.retry': 'Retry',
    'error.generic': 'Request failed',
    'error.network': 'Network error: cannot reach the DSH Host',
    'error.forbiddenPeer': 'Access from non-loopback peers is denied',
    'error.schemaIncompatible': 'Cortex database schema is incompatible (v5 required)',
    'error.readOnly': 'Read-only mode: write rejected',
    'error.notFound': 'Requested data was not found',
    'error.badRequest': 'Invalid request parameters',
    'error.upstream': 'Outbound request failed',
    'error.upstreamTimeout': 'Outbound request timed out',
    'error.originNotAllowed': 'Target is not in the allowed origin list',
    'error.internal': 'Host internal error',
    'common.loading': 'Loading…',
    'common.empty': 'No data',
    'common.retry': 'Retry',
    'common.refresh': 'Refresh',
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.confirm': 'Confirm',
    'common.save': 'Save',
    'common.search': 'Search',
    'common.searchPlaceholder': 'Search…',
    'common.prev': 'Previous',
    'common.next': 'Next',
    'common.page': 'Page {page} / {pages}',
    'common.total': '{total} total',
    'common.all': 'All',
    'common.unknown': 'Unknown',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.download': 'Download',
    'common.open': 'Open',
    'common.back': 'Back',
    'common.more': 'More',
    'common.details': 'Details',
    'settings.title': 'Cortex settings',
    'settings.intro': 'This plugin reads the local Cortex SQLite database directly from the DSH Host. It does not start Cortex desktop, CLI, the Cortex Web server, or MCP.',
    'settings.version': 'Plugin version',
    'settings.dshVersion': 'DSH version',
    'settings.node': 'Host Node',
    'settings.dbFile': 'Database file',
    'settings.schema': 'Schema version',
    'settings.readonly': 'Read-only',
    'settings.loopback': 'Access scope',
    'settings.loopbackValue': 'Loopback on this machine only',
    'settings.dbPathHint': 'CORTEX_DB_PATH overrides the database path; CORTEX_DB_READONLY=1 forces read-only mode.',
    'settings.reload': 'Refresh status',
  },
}

    };
    __factories["lib/format.js"] = function (module, exports, require) {
// Formatting helpers for the Cortex page.
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function localeTag(locale) {
  const active = String(locale || 'en').toLowerCase()
  if (active.indexOf('zh') === 0) return 'zh-CN'
  return 'en-US'
}

function toDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n)
}

/** ISO string -> localized "YYYY/MM/DD HH:mm" (keeps ISO strings, never shifts timezone rules). */
function fmtTime(value, locale) {
  const date = toDate(value)
  if (!date) return value ? String(value) : '—'
  try {
    return date.toLocaleString(localeTag(locale), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }
}

function fmtDate(value, locale) {
  const date = toDate(value)
  if (!date) return value ? String(value) : '—'
  try {
    return date.toLocaleDateString(localeTag(locale), { year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  }
}

function fmtRelative(value, locale, now) {
  const date = toDate(value)
  if (!date) return value ? String(value) : '—'
  const base = typeof now === 'number' ? now : Date.now()
  const diff = base - date.getTime()
  const zh = localeTag(locale) === 'zh-CN'
  if (diff < 0) return fmtTime(value, locale)
  if (diff < MINUTE) return zh ? '刚刚' : 'just now'
  if (diff < HOUR) {
    const n = Math.floor(diff / MINUTE)
    return zh ? `${n} 分钟前` : `${n}m ago`
  }
  if (diff < DAY) {
    const n = Math.floor(diff / HOUR)
    return zh ? `${n} 小时前` : `${n}h ago`
  }
  if (diff < 30 * DAY) {
    const n = Math.floor(diff / DAY)
    return zh ? `${n} 天前` : `${n}d ago`
  }
  return fmtDate(value, locale)
}

function bytes(size) {
  const n = Number(size)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`
}

function truncate(text, max) {
  const value = String(text === undefined || text === null ? '' : text)
  const limit = typeof max === 'number' ? max : 120
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function prettifyKey(value) {
  const text = String(value === undefined || value === null ? '' : value)
  if (!text) return ''
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function plural(count, one, many) {
  return Number(count) === 1 ? one : many
}

function joinMeta(parts, separator) {
  const sep = separator || ' · '
  return asArray(parts)
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join(sep)
}

module.exports = {
  fmtTime,
  fmtDate,
  fmtRelative,
  bytes,
  truncate,
  asArray,
  asObject,
  prettifyKey,
  plural,
  joinMeta,
  localeTag,
}

    };
    __factories["pages/overview.js"] = function (module, exports, require) {
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

    };
    __factories["ui/markdown.js"] = function (module, exports, require) {
// Small safe Markdown renderer (no dangerouslySetInnerHTML).
// Handles the subset Cortex writes: headings, paragraphs, bold/italic/code,
// links, ordered/unordered lists, blockquotes, tables, fenced code blocks and
// horizontal rules. Rendered with React elements only.
const React = require('react')
const h = React.createElement
const { Pre } = require('./kit.js')

const SCHEMES = /^(https?:|mailto:|\/)/i

function renderInline(text, keyPrefix) {
  const source = String(text === undefined || text === null ? '' : text)
  const nodes = []
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g
  let lastIndex = 0
  let match
  let index = 0
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) nodes.push(source.slice(lastIndex, match.index))
    const token = match[0]
    const key = `${keyPrefix || 'i'}-${index++}`
    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(h('strong', { key }, renderInline(token.slice(2, -2), `${key}-b`)))
    } else if (token.startsWith('`')) {
      nodes.push(h('code', { key }, token.slice(1, -1)))
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link && SCHEMES.test(link[2])) {
        const external = /^https?:/i.test(link[2])
        nodes.push(
          h(
            'a',
            external ? { key, href: link[2], target: '_blank', rel: 'noopener noreferrer' } : { key, href: link[2] },
            link[1],
          ),
        )
      } else {
        nodes.push(token)
      }
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(h('em', { key }, renderInline(token.slice(1, -1), `${key}-i`)))
    }
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < source.length) nodes.push(source.slice(lastIndex))
  return nodes.length ? nodes : [source]
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
}

function splitRow(line) {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map((cell) => cell.trim())
}

function renderBlocks(lines, startKey) {
  const blocks = []
  let index = 0
  let key = startKey || 0
  const nextKey = () => `${key++}`

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      continue
    }

    const fence = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence) {
      const language = fence[1]
      index++
      const code = []
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index])
        index++
      }
      index++
      blocks.push(
        h(
          Pre,
          { key: nextKey(), 'aria-label': language ? `${language} code` : 'code' },
          language ? h('div', { className: 'dshc-small dshc-muted' }, language) : null,
          code.join('\n'),
        ),
      )
      continue
    }

    const heading = /^\s*(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (heading) {
      const level = Math.min(4, Math.max(1, heading[1].length))
      blocks.push(h(`h${level}`, { key: nextKey() }, renderInline(heading[2], `h${key}`)))
      index++
      continue
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(h('hr', { key: nextKey(), className: 'dshc-hr' }))
      index++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index++
      }
      blocks.push(h('blockquote', { key: nextKey() }, renderBlocks(quote, key * 100)))
      continue
    }

    if (/^\s*(?:[-*+])\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*(?:[-*+])\s+/.test(lines[index])) {
        items.push(h('li', { key: `${nextKey()}-li` }, renderInline(lines[index].replace(/^\s*(?:[-*+])\s+/, ''), `li${key}`)))
        index++
      }
      blocks.push(h('ul', { key: nextKey() }, items))
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(h('li', { key: `${nextKey()}-li` }, renderInline(lines[index].replace(/^\s*\d+[.)]\s+/, ''), `oli${key}`)))
        index++
      }
      blocks.push(h('ol', { key: nextKey() }, items))
      continue
    }

    if (line.indexOf('|') >= 0 && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitRow(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].indexOf('|') >= 0 && lines[index].trim()) {
        rows.push(splitRow(lines[index]))
        index++
      }
      blocks.push(
        h(
          'table',
          { key: nextKey() },
          h('thead', null, h('tr', null, header.map((cell, i) => h('th', { key: i }, renderInline(cell, `th${i}`))))),
          h(
            'tbody',
            null,
            rows.map((row, rowIndex) =>
              h('tr', { key: rowIndex }, row.map((cell, cellIndex) => h('td', { key: cellIndex }, renderInline(cell, `td${cellIndex}`)))),
            ),
          ),
        ),
      )
      continue
    }

    const paragraph = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(?:```|#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s)/.test(lines[index]) &&
      !(lines[index].indexOf('|') >= 0 && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(lines[index])
      index++
    }
    blocks.push(h('p', { key: nextKey() }, renderInline(paragraph.join(' '), `p${key}`)))
  }
  return blocks
}

function Markdown(props) {
  const text = props.text === undefined || props.text === null ? '' : String(props.text)
  if (!text.trim()) return props.empty === undefined ? h('div', { className: 'dshc-muted dshc-small' }, '—') : props.empty
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return h('div', { className: 'dshc-md ' + (props.className || '') }, renderBlocks(lines, 0))
}

module.exports = { Markdown, renderInline, renderBlocks }

    };
    __factories["pages/vulns.js"] = function (module, exports, require) {
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

    };
    __factories["pages/assets.js"] = function (module, exports, require) {
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

    };
    __factories["pages/internal.js"] = function (module, exports, require) {
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

    };
    __factories["pages/snapshots.js"] = function (module, exports, require) {
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

    };
    __factories["lib/httpparse.js"] = function (module, exports, require) {
// Parse Markdown reproduction steps into concrete HTTP request steps.
//
// Cortex stores reproduction_steps as Markdown with fenced ```http blocks, e.g.
//
//   ### 步骤 1：未认证访问被拒绝
//   ```http
//   GET /login HTTP/1.1
//   Host: 127.0.0.1:8080
//   ```
//
// This module is pure (no DOM, no React) so both the retest page and tests can
// use it. It keeps all steps in order and resolves relative request targets
// against the vulnerability's target URL.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function normalizeMethod(value) {
  const method = String(value || '').toUpperCase()
  return METHODS.indexOf(method) >= 0 ? method : ''
}

function splitFences(markdown) {
  const text = String(markdown || '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const blocks = []
  let current = null
  let heading = ''
  for (const line of lines) {
    const fence = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence) {
      if (current) {
        blocks.push({ lang: current.lang, lines: current.lines, heading: current.heading })
        current = null
      } else {
        current = { lang: (fence[1] || '').toLowerCase(), lines: [], heading }
      }
      continue
    }
    if (current) current.lines.push(line)
    else {
      const match = /^\s*#{2,6}\s+(.*\S)\s*$/.exec(line)
      if (match) heading = match[1]
    }
  }
  if (current) blocks.push({ lang: current.lang, lines: current.lines, heading: current.heading })
  return blocks
}

/**
 * Parse one raw HTTP request text block.
 * @param {string} raw
 * @param {string} baseUrl used to resolve path-only request targets
 */
function parseHttpBlock(raw, baseUrl) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n')
  let start = 0
  while (start < lines.length && !lines[start].trim()) start++
  if (start >= lines.length) return null

  const requestLine = /^\s*([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?\s*$/.exec(lines[start])
  if (!requestLine) return null
  const method = normalizeMethod(requestLine[1])
  if (!method) return null
  const target = requestLine[2]

  const headers = {}
  let index = start + 1
  for (; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      break
    }
    const header = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(line)
    if (header) headers[header[1]] = header[2].trim()
  }
  const bodyLines = lines.slice(index).filter((line, i, all) => i < all.length)
  const body = bodyLines.join('\n').replace(/\s+$/, '')

  let url = target
  if (!/^https?:\/\//i.test(url)) {
    const base = String(baseUrl || '').trim() || 'http://127.0.0.1/'
    try {
      url = new URL(target, base).toString()
    } catch {
      url = target
    }
  }

  return {
    method,
    url,
    target,
    headers,
    body: body || '',
    raw: lines.slice(start).join('\n').trim(),
  }
}

/**
 * Parse a vulnerability's reproduction_steps into ordered HTTP steps.
 * @returns {{index:number,title:string,method:string,url:string,headers:object,body:string,raw:string}[]}
 */
function parseHttpSteps(markdown, baseUrl) {
  const blocks = splitFences(markdown)
  const steps = []
  for (const block of blocks) {
    if (block.lang !== 'http') continue
    const parsed = parseHttpBlock(block.lines.join('\n'), baseUrl)
    if (!parsed) continue
    steps.push({
      index: steps.length + 1,
      title: block.heading || '',
      method: parsed.method,
      url: parsed.url,
      target: parsed.target,
      headers: parsed.headers,
      body: parsed.body,
      raw: parsed.raw,
    })
  }
  return steps
}

/** Map parsed headers to an object the Host accepts (drops hop-by-hop headers). */
function requestHeadersForSend(headers) {
  const output = {}
  const blocked = { host: 1, 'content-length': 1, connection: 1, 'transfer-encoding': 1, 'proxy-connection': 1 }
  for (const key of Object.keys(headers || {})) {
    if (blocked[String(key).toLowerCase()]) continue
    output[key] = String(headers[key])
  }
  return output
}

module.exports = { METHODS, parseHttpBlock, parseHttpSteps, requestHeadersForSend, normalizeMethod }

    };
    __factories["pages/retest.js"] = function (module, exports, require) {
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

    };
    __factories["index.js"] = function (module, exports, require) {
// Client half entry: registers the Cortex sidebar entry (sidebar.panellist) and
// the full Cortex workbench page (main key "cortex").
//
// The page talks to the plugin's own Host half only through same-origin
// `fetch('/cortex-api/...')`; it never touches the filesystem or SQLite.
const React = require('react')
const { h, cx, Button, IconButton, Badge, Icon, KeyValue, Modal, Tabs, describeError, ErrorBox, Spinner } = require('./ui/kit.js')
const { createApi, isAbortError } = require('./lib/api.js')
const { CSS } = require('./styles.js')
const SHELL_MESSAGES = require('./locales.js')

const PAGES = [
  require('./pages/overview.js'),
  require('./pages/vulns.js'),
  require('./pages/assets.js'),
  require('./pages/internal.js'),
  require('./pages/snapshots.js'),
  require('./pages/retest.js'),
]

const PLUGIN_NAME = 'dsh-cortex'
const NS = 'dsh-cortex'
const PAGE_NS = `${NS}.`
const FALLBACK_VERSION = '0.1.0'
const { useState, useEffect, useRef, useMemo, useCallback } = React

let pluginCtx = null
let activeApi = null
const DICTS = Object.create(null)

// ---------------------------------------------------------------- i18n

function normalizeLocale(active) {
  const value = String(active || 'en').toLowerCase()
  if (value.indexOf('zh') === 0) return 'zh'
  return 'en'
}

function buildDictionaries() {
  DICTS[NS] = SHELL_MESSAGES
  for (const page of PAGES) {
    DICTS[PAGE_NS + page.id] = page.messages || {}
  }
}

function makeT(namespace, activeLocale) {
  const lang = normalizeLocale(activeLocale)
  const pageDict = DICTS[namespace] || {}
  const shellDict = DICTS[NS] || {}
  return function translate(key, vars) {
    const candidates = [
      pageDict[lang] && pageDict[lang][key],
      pageDict.en && pageDict.en[key],
      shellDict[lang] && shellDict[lang][key],
      shellDict.en && shellDict.en[key],
    ]
    let value = key
    for (const candidate of candidates) {
      if (candidate !== undefined && candidate !== null) {
        value = candidate
        break
      }
    }
    if (vars && typeof value === 'string') {
      for (const name of Object.keys(vars)) value = value.split(`{${name}}`).join(String(vars[name]))
    }
    return value
  }
}

function readLocale() {
  try {
    if (pluginCtx && pluginCtx.locale && typeof pluginCtx.locale.getLocale === 'function') return pluginCtx.locale.getLocale()
  } catch {
    /* ignore */
  }
  return { active: 'en', revision: 0 }
}

function useLocaleSnapshot() {
  const [snapshot, setSnapshot] = useState(readLocale)
  useEffect(() => {
    let unsubscribe
    try {
      if (pluginCtx && pluginCtx.locale && typeof pluginCtx.locale.subscribe === 'function') {
        unsubscribe = pluginCtx.locale.subscribe(() => setSnapshot(readLocale()))
      }
    } catch {
      /* locale service optional */
    }
    return () => {
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe()
        } catch {
          /* ignore */
        }
      }
    }
  }, [])
  return snapshot
}

// ---------------------------------------------------------------- sidebar icon

function PanelIcon(props) {
  const size = props && typeof props.size === 'number' ? props.size : 16
  const active = !!(props && props.active)
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.25,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block', opacity: active ? 1 : 0.9 },
    },
    h('path', { d: 'M8 1.6 13.2 4.4v7.2L8 14.4 2.8 11.6V4.4L8 1.6Z', opacity: 0.65 }),
    h('circle', { cx: 8, cy: 8, r: 2.1 }),
    h('circle', { cx: 8, cy: 1.9, r: 1.15, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 13, cy: 4.4, r: 1.15, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 13, cy: 11.6, r: 1.15, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 8, cy: 14.1, r: 1.15, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 3, cy: 11.6, r: 1.15, fill: 'currentColor', stroke: 'none' }),
    h('circle', { cx: 3, cy: 4.4, r: 1.15, fill: 'currentColor', stroke: 'none' }),
  )
}

// ---------------------------------------------------------------- state panel

function StatePanel(props) {
  return h(
    'div',
    { className: 'dshc-body' },
    h(
      'div',
      { className: 'dshc-card', style: { maxWidth: 640, margin: '24px auto' } },
      h(
        'div',
        { className: 'dshc-card-body' },
        h(
          'div',
          { className: 'dshc-col', style: { alignItems: 'flex-start', gap: 10 } },
          h(
            'div',
            { className: 'dshc-title' },
            h(Icon, { name: props.icon || 'warning', size: 18 }),
            props.title,
          ),
          props.hint ? h('div', { className: 'dshc-muted', style: { fontSize: 12.5 } }, props.hint) : null,
          props.code ? h('div', { className: 'dshc-mono dshc-small dshc-muted' }, props.code) : null,
          props.action || null,
        ),
      ),
    ),
  )
}

function Toast(props) {
  useEffect(() => {
    if (!props.toast) return undefined
    const timer = setTimeout(() => props.onDone(), 4200)
    return () => clearTimeout(timer)
  }, [props.toast, props.onDone])
  if (!props.toast) return null
  const tone = props.toast.tone || 'info'
  return h(
    'div',
    {
      role: 'status',
      'aria-live': 'polite',
      style: {
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 70,
        maxWidth: 420,
        padding: '9px 12px',
        borderRadius: 9,
        fontSize: 12.5,
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        border: `1px solid ${
          tone === 'error'
            ? 'var(--dsw-alias-state-error-primary)'
            : tone === 'ok'
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-border-l2)'
        }`,
        boxShadow: '0 10px 28px rgba(0,0,0,.24)',
      },
    },
    props.toast.text,
  )
}

// ---------------------------------------------------------------- page shell

function CortexPage() {
  const localeSnapshot = useLocaleSnapshot()
  const lang = normalizeLocale(localeSnapshot.active)
  const t = useMemo(() => makeT(NS, localeSnapshot.active), [localeSnapshot.revision, localeSnapshot.active])

  const [route, setRoute] = useState({ tab: 'overview', params: {} })
  const [rev, setRev] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const [healthState, setHealthState] = useState({ phase: 'loading', health: null, error: null })
  const [fatal, setFatal] = useState(null)

  const apiRef = useRef(null)
  if (!apiRef.current) {
    apiRef.current = createApi({
      onError: (error) => {
        if (!error) return
        if (error.code === 'SCHEMA_INCOMPATIBLE' || error.code === 'FORBIDDEN_PEER' || error.code === 'FORBIDDEN_HOST') {
          setFatal(error)
        }
      },
    })
  }
  const api = apiRef.current

  useEffect(() => {
    activeApi = api
    return () => {
      try {
        api.abortAll()
      } catch {
        /* ignore */
      }
      if (activeApi === api) activeApi = null
    }
  }, [api])

  const loadHealth = useCallback(async () => {
    setHealthState((previous) => ({ phase: 'loading', health: previous.health, error: null }))
    try {
      const health = await api.get('/health')
      setHealthState({ phase: 'ok', health, error: null })
    } catch (error) {
      if (isAbortError(error)) return
      setHealthState({ phase: 'error', health: null, error })
    }
  }, [api])

  useEffect(() => {
    loadHealth()
  }, [loadHealth])

  const showToast = useCallback((text, tone) => {
    setToast({ text: String(text || ''), tone: tone || 'info', id: Date.now() + Math.random() })
  }, [])

  const refreshAll = useCallback(() => {
    setFatal(null)
    setRev((value) => value + 1)
    loadHealth()
  }, [loadHealth])

  const go = useCallback((tab, params) => {
    setRoute({ tab: tab || 'overview', params: params || {} })
  }, [])

  const health = healthState.health
  const healthOk = healthState.phase === 'ok' && health && health.db && health.db.available && health.db.compatible
  const readOnly = !!(health && health.db && health.db.readOnly)
  const version = (health && health.version) || FALLBACK_VERSION

  const fatalError =
    fatal ||
    (healthState.phase === 'error' ? healthState.error : null) ||
    (healthState.phase === 'ok' && health && health.db && !health.db.compatible ? { code: 'SCHEMA_INCOMPATIBLE', message: 'schema incompatible' } : null)

  let body
  if (healthState.phase === 'loading' && !health) {
    body = h(StatePanel, { icon: 'database', title: t('state.loading'), action: h(Spinner, null) })
  } else if (fatalError) {
    const error = fatalError
    const code = error && error.code
    if (code === 'FORBIDDEN_PEER' || code === 'FORBIDDEN_HOST' || code === 'FORBIDDEN_ORIGIN') {
      body = h(StatePanel, { icon: 'shield', title: t('state.remoteOnly'), hint: t('state.remoteOnlyHint'), code })
    } else if (code === 'SCHEMA_INCOMPATIBLE') {
      const schema =
        (error && error.details && error.details.schemaVersion) ??
        (health && health.db ? health.db.schemaVersion : '?')
      body = h(StatePanel, {
        icon: 'warning',
        title: t('state.schemaIncompatible'),
        hint: t('state.schemaIncompatibleHint', { version: schema === null || schema === undefined ? '?' : schema }),
        code,
        action: h(Button, { onClick: refreshAll, icon: 'refresh' }, t('common.retry')),
      })
    } else {
      const info = describeError(error, t)
      body = h(
        'div',
        { className: 'dshc-body' },
        h(ErrorBox, { error, t, onRetry: refreshAll }),
        h('div', { className: 'dshc-muted dshc-small', style: { marginTop: 8 } }, info.code ? `code: ${info.code}` : ''),
      )
    }
  } else if (healthState.phase === 'ok' && health && health.db && !health.db.available) {
    body = h(StatePanel, {
      icon: 'database',
      title: t('state.dbUnavailable'),
      hint: t('state.dbUnavailableHint', { file: health.db.dbFile || 'data.db' }),
      code: health.db.error || '',
      action: h(Button, { onClick: refreshAll, icon: 'refresh' }, t('common.retry')),
    })
  } else {
    const page = PAGES.filter((item) => item.id === route.tab)[0] || PAGES[0]
    const pageT = makeT(PAGE_NS + page.id, localeSnapshot.active)
    const nav = { tab: route.tab, params: route.params || {}, go }
    const app = {
      health,
      refreshHealth: loadHealth,
      reloadAll: refreshAll,
      version,
      rev,
      readOnly,
      locale: lang,
    }
    body = h(
      'div',
      { className: 'dshc-body', role: 'tabpanel', id: `dshc-panel-${page.id}`, 'aria-labelledby': `dshc-tab-${page.id}` },
      h(page.Component, {
        key: page.id,
        api,
        t: pageT,
        locale: lang,
        nav,
        app,
        rev,
        toast: showToast,
      }),
    )
  }

  const dbBadge = healthOk
    ? h(
        Badge,
        { tone: readOnly ? 'warn' : 'success', className: 'dshc-small' },
        readOnly ? t('header.dbReadonly') : t('header.dbOk', { schema: health.db.schemaVersion }),
      )
    : health && health.db && !health.db.available
      ? h(Badge, { tone: 'error', className: 'dshc-small' }, t('header.dbUnavailable'))
      : null

  return h(
    'div',
    { className: 'dshc-scope' },
    h('style', null, CSS),
    h(
      'header',
      { className: 'dshc-header' },
      h(
        'div',
        { className: 'dshc-title' },
        h(Icon, { name: 'layers', size: 17 }),
        h('span', null, t('panel.title')),
        h(Badge, { tone: 'neutral', className: 'dshc-small' }, `v${version}`),
      ),
      h('div', { className: 'dshc-sub' }, t('header.subtitle')),
      h('div', { className: 'dshc-spacer' }),
      h('div', { className: 'dshc-header-actions' }, dbBadge, h(Badge, { tone: 'neutral', className: 'dshc-small' }, t('header.loopback'))),
      h(
        Button,
        { size: 'sm', icon: 'refresh', onClick: refreshAll, disabled: healthState.phase === 'loading', title: t('header.refreshHint') },
        t('header.refresh'),
      ),
      h(IconButton, { icon: 'settings', title: t('header.settings'), onClick: () => setSettingsOpen(true) }),
    ),
    healthOk
      ? h(Tabs, {
          items: PAGES.map((page) => ({ id: page.id, label: t(`tab.${page.id}`) })),
          value: route.tab,
          ariaLabel: t('tabs.label'),
          onChange: (tab) => go(tab, {}),
        })
      : null,
    readOnly && healthOk
      ? h('div', { className: 'dshc-banner' }, h(Icon, { name: 'warning', size: 14 }), t('banner.readonly'))
      : null,
    fatal && healthOk
      ? h(
          'div',
          { className: 'dshc-banner dshc-banner-error' },
          h(Icon, { name: 'warning', size: 14 }),
          t('banner.error', { message: fatal.message || fatal.code || '' }),
        )
      : null,
    body,
    h(Toast, { toast, onDone: () => setToast(null) }),
    h(
      Modal,
      {
        open: settingsOpen,
        title: t('settings.title'),
        onClose: () => setSettingsOpen(false),
        closeLabel: t('common.close'),
        footer: h(Button, { onClick: () => setSettingsOpen(false) }, t('common.close')),
      },
      h('div', { className: 'dshc-muted', style: { fontSize: 12.5 } }, t('settings.intro')),
      health
        ? h(KeyValue, {
            items: [
              [t('settings.version'), version],
              [t('settings.dshVersion'), (health.dsh && health.dsh.version) || '0.2.2-rc.1'],
              [t('settings.dbFile'), (health.db && health.db.dbFile) || 'data.db'],
              [t('settings.schema'), health.db && health.db.schemaVersion !== null ? `v${health.db.schemaVersion}` : '—'],
              [t('settings.readonly'), health.db && health.db.readOnly ? t('common.yes') : t('common.no')],
              [t('settings.loopback'), t('settings.loopbackValue')],
            ],
          })
        : h(Spinner, null),
      h('div', { className: 'dshc-small dshc-muted' }, t('settings.dbPathHint')),
      h(Button, { size: 'sm', icon: 'refresh', onClick: refreshAll }, t('settings.reload')),
    ),
  )
}

// ---------------------------------------------------------------- plugin lifecycle

function apply(ctx) {
  pluginCtx = ctx
  buildDictionaries()

  // Preferred: the DSH Client builtin stylesheet service (package-owned CSS,
  // removed with the Client run). Feature-detected because the builtin surface
  // differs between Harness builds; the component-local <style> element in
  // CortexPage is the documented fallback.
  try {
    ctx.effect(() => {
      let dispose
      try {
        if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
          dispose = styles.insert(CSS)
        }
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] styles.insert unavailable, using component-local style`, error)
      }
      return () => {
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    }, `${PLUGIN_NAME}: stylesheet`)
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] stylesheet effect failed`, error)
  }

  // Localized dictionaries (zh + en baseline). Failures must not blank the slot.
  try {
    for (const page of PAGES) {
      const namespace = PAGE_NS + page.id
      const messages = page.messages || {}
      for (const locale of ['zh', 'en']) {
        if (messages[locale]) ctx.locale.register(namespace, locale, messages[locale])
      }
    }
    for (const locale of ['zh', 'en']) ctx.locale.register(NS, locale, SHELL_MESSAGES[locale])
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] locale registration failed`, error)
  }

  // Abort outstanding requests when the plugin is unloaded.
  try {
    ctx.effect(() => {
      return () => {
        try {
          if (activeApi) activeApi.abortAll()
        } catch {
          /* ignore */
        }
      }
    }, `${PLUGIN_NAME}: abort requests on unload`)
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] teardown effect failed`, error)
  }

  const label = () => {
    try {
      return makeT(NS, readLocale().active)('panel.title')
    } catch {
      return 'Cortex'
    }
  }

  try {
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({ name: 'sidebar.panellist', id: 'cortex', order: 5, label }, PanelIcon),
    )
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] sidebar.panellist registration failed`, error)
  }

  try {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'cortex' }, CortexPage))
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] main panel registration failed`, error)
  }
}

module.exports = {
  name: PLUGIN_NAME,
  inject: ['slots', 'locale'],
  apply,
  // exported for tests
  PAGES,
  PanelIcon,
  makeT,
  normalizeLocale,
  buildDictionaries,
}

    };
    return __load("index.js");
  },
});
