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
