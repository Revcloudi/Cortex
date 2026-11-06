/**
 * Shell tests for the built browser bundle (`client.js`).
 *
 * Loads the *built* bundle the same way the DSH Client module loader would
 * (fake `window.__ModuleLoader__`), resolves `require('react')` to the real dev
 * dependency, calls the factory, and then:
 *   - asserts plugin identity + inject list
 *   - asserts slot registrations (sidebar.panellist id=cortex order=5, main key=cortex)
 *   - asserts zh/en locale dictionaries are registered for the shell and all pages
 *   - asserts CSS delivery: `styles.insert(CSS)` when the builtin exists
 *     (cleanup on teardown) and the component-local <style> fallback in the DOM
 *   - renders the shell into jsdom with a mocked fetch and asserts the
 *     loading / ok / read-only / schema-incompatible / remote-403 states
 *
 * Run: node --test test/client/shell.test.mjs
 * Requires the devDependencies (react, react-dom, jsdom) and a built client.js:
 *   npm install && node scripts/build-client.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { cleanupDom, renderPage, setupDom } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const bundlePath = join(root, 'client.js')
const require = createRequire(import.meta.url)
const React = require('react')

// Node 24 exposes `navigator` as a getter-only accessor; test/client/helpers.mjs
// (Lead-owned) assigns to it from strict-mode ESM, which throws. Make it a plain
// writable data property so setupDom()/cleanupDom() can own it.
{
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  if (descriptor && typeof descriptor.set !== 'function') {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      enumerable: descriptor.enumerable,
      writable: true,
      value: globalThis.navigator,
    })
  }
}

const PAGES = ['overview', 'vulns', 'assets', 'internal', 'snapshots', 'retest']

after(() => {
  delete globalThis.styles
  delete globalThis.fetch
  cleanupDom()
})

// ---------------------------------------------------------------- loaders

/** Load the built bundle exactly like the DSH Client module loader does. */
function loadBundleDefinition() {
  const source = readFileSync(bundlePath, 'utf8')
  const definitions = []
  window.__ModuleLoader__ = {
    load(definition) {
      definitions.push(definition)
    },
  }
  try {
    vm.runInThisContext(source, { filename: 'client.js' })
  } finally {
    delete window.__ModuleLoader__
  }
  assert.equal(definitions.length, 1, 'bundle calls window.__ModuleLoader__.load exactly once')
  return definitions[0]
}

/** Resolve the plugin object; only `react` may be required by the bundle. */
function instantiatePlugin() {
  const definition = loadBundleDefinition()
  assert.equal(definition.id, 'dsh-cortex')
  assert.equal(typeof definition.factory, 'function')
  const required = []
  const plugin = definition.factory((spec) => {
    required.push(spec)
    if (spec === 'react') return React
    throw new Error(`unexpected require(${spec}) in client bundle`)
  })
  assert.ok(required.length >= 1, 'client bundle requires its runtime modules')
  assert.ok(
    required.every((spec) => spec === 'react'),
    `client bundle only requires react (got: ${required.join(', ')})`,
  )
  return plugin
}

/** Fake DSH client context capturing slot/locale/effect registrations. */
function createFakeCtx() {
  const state = {
    slots: [],
    injectOwners: [],
    locales: [],
    effects: [],
    localeSubscribers: [],
  }
  const ctx = {
    locale: {
      register(namespace, locale, dict) {
        state.locales.push({ namespace, locale, dict })
        return () => {}
      },
      getLocale() {
        return { active: 'zh', locales: ['zh', 'en'], revision: 1 }
      },
      subscribe(callback) {
        state.localeSubscribers.push(callback)
        return () => {}
      },
    },
    slots: {
      inject(owner, callback) {
        state.injectOwners.push(owner)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        state.slots.push({ options, component })
        return () => {}
      },
    },
    effect(factory, label) {
      const dispose = factory()
      state.effects.push({ dispose, label })
      return () => {}
    },
  }
  return { ctx, state }
}

function applyPlugin(plugin) {
  const harness = createFakeCtx()
  plugin.apply(harness.ctx)
  return harness
}

function findSlot(state, name) {
  return state.slots.find((entry) => entry.options && entry.options.name === name)
}

function disposeEffects(state) {
  for (const effect of [...state.effects].reverse()) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
}

// ---------------------------------------------------------------- fetch mocks

function jsonResponse(payload, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return JSON.stringify(payload)
    },
    async json() {
      return payload
    },
  }
}

function healthPayload(overrides = {}) {
  const db = Object.assign(
    {
      available: true,
      schemaVersion: 5,
      compatible: true,
      readOnly: false,
      busy: false,
      dbFile: 'data.db',
      error: null,
    },
    overrides.db,
  )
  return {
    ok: true,
    plugin: 'dsh-cortex',
    version: '0.1.0',
    dsh: { version: '0.2.2-rc.1' },
    sqlite: true,
    db,
    server: { loopbackOnly: true, time: '2026-11-06T12:00:00.000Z' },
    ...overrides.top,
  }
}

function installFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return handler(url, options || {})
  }
  return calls
}

// ---------------------------------------------------------------- registration

test('bundle loads with the DSH module loader and exposes the plugin contract', () => {
  setupDom()
  const plugin = instantiatePlugin()

  assert.equal(plugin.name, 'dsh-cortex')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('slots'), 'inject declares slots')
  assert.ok(plugin.inject.includes('locale'), 'inject declares locale')
  assert.ok(Array.isArray(plugin.PAGES) && plugin.PAGES.length === 6, 'all six pages are bundled')
  assert.deepEqual(plugin.PAGES.map((page) => page.id), PAGES)
})

test('apply() registers sidebar.panellist (id=cortex, order=5) and main (key=cortex)', () => {
  setupDom()
  const plugin = instantiatePlugin()
  const { state } = applyPlugin(plugin)

  assert.deepEqual(state.injectOwners, ['sidebar.panellist', 'main'], 'slot injections target the documented owners')

  const panel = findSlot(state, 'sidebar.panellist')
  assert.ok(panel, 'sidebar.panellist registration exists')
  assert.equal(panel.options.name, 'sidebar.panellist')
  assert.equal(panel.options.id, 'cortex')
  assert.equal(panel.options.order, 5, 'Cortex sits between plugins(0) and schedules(10)')
  assert.equal(typeof panel.component, 'function', 'panellist icon component registered')
  assert.equal(typeof panel.options.label, 'function')
  assert.equal(panel.options.label(), 'Cortex')

  const main = findSlot(state, 'main')
  assert.ok(main, 'main registration exists')
  assert.equal(main.options.name, 'main')
  assert.equal(main.options.key, 'cortex', 'list id addresses the matching main panel')
  assert.equal(typeof main.component, 'function', 'Cortex page component registered')

  // Only those two slots are claimed (no DOM writes / root replacement).
  assert.equal(state.slots.length, 2)

  // Effects were registered and can be disposed without throwing.
  assert.ok(state.effects.length >= 2, 'plugin registers at least stylesheet + teardown effects')
  disposeEffects(state)
})

test('apply() registers zh + en dictionaries for the shell and every page namespace', () => {
  setupDom()
  const plugin = instantiatePlugin()
  const { state } = applyPlugin(plugin)

  const namespaceOf = (entry) => entry.namespace
  const localesFor = (namespace) => state.locales.filter((entry) => entry.namespace === namespace)

  for (const namespace of ['dsh-cortex', ...PAGES.map((page) => `dsh-cortex.${page}`)]) {
    const entries = localesFor(namespace)
    assert.ok(entries.some((entry) => entry.locale === 'zh'), `${namespace} has a zh dictionary`)
    assert.ok(entries.some((entry) => entry.locale === 'en'), `${namespace} has an en dictionary`)
    for (const entry of entries) {
      assert.equal(typeof entry.dict, 'object')
      assert.ok(Object.keys(entry.dict).length > 0, `${namespace}/${entry.locale} dictionary is not empty`)
      for (const value of Object.values(entry.dict)) assert.equal(typeof value, 'string')
    }
  }

  const shellZh = localesFor('dsh-cortex').find((entry) => entry.locale === 'zh')
  assert.equal(shellZh.dict['panel.title'], 'Cortex')
  assert.ok(shellZh.dict['state.schemaIncompatible'])
  const shellEn = localesFor('dsh-cortex').find((entry) => entry.locale === 'en')
  assert.notEqual(shellZh.dict['state.schemaIncompatible'], shellEn.dict['state.schemaIncompatible'])
  assert.equal(namespaceOf(shellZh), 'dsh-cortex')

  disposeEffects(state)
})

test('styles builtin: apply() calls styles.insert(CSS) once and its cleanup runs on teardown', () => {
  setupDom()
  const inserts = []
  const disposals = []
  globalThis.styles = {
    insert(css) {
      inserts.push(css)
      return () => {
        disposals.push(true)
      }
    },
  }
  try {
    const plugin = instantiatePlugin()
    const { state } = applyPlugin(plugin)

    assert.equal(inserts.length, 1, 'styles.insert called exactly once')
    assert.equal(typeof inserts[0], 'string')
    assert.ok(inserts[0].length > 1000, 'inserted CSS is the real stylesheet')
    assert.match(inserts[0], /--dsw-alias-/, 'CSS uses DSH theme tokens')
    assert.ok(
      state.effects.some((effect) => /stylesheet/i.test(effect.label || '')),
      'stylesheet insertion is owned by a ctx.effect',
    )

    disposeEffects(state)
    assert.equal(disposals.length, 1, 'styles.insert disposer runs when the plugin is unloaded')
  } finally {
    delete globalThis.styles
  }
})

test('component-local CSS fallback: rendered DOM carries a <style> element with theme tokens', async () => {
  setupDom()
  const plugin = instantiatePlugin()
  const { state } = applyPlugin(plugin)
  const main = findSlot(state, 'main')

  const calls = installFetch(() => jsonResponse(healthPayload()))
  const view = await renderPage(main.component, {})
  try {
    const html = view.html()
    assert.match(html, /<style[^>]*>/, 'CortexPage renders a local <style> element')
    assert.match(view.text(), /Cortex/)
    const styleNode = view.query('style')
    assert.ok(styleNode, 'style element is in the DOM')
    assert.match(styleNode.textContent, /--dsw-alias-/, 'fallback CSS keeps DSH theme tokens')
    assert.ok(styleNode.textContent.length > 1000)
    assert.ok(calls.length >= 1)
    assert.equal(calls[0].url, '/cortex-api/health')
    assert.ok(calls[0].url.startsWith('/cortex-api/'), 'browser talks only to its own /cortex-api')
  } finally {
    await view.unmount()
    disposeEffects(state)
  }
})

// ---------------------------------------------------------------- UI states

test('health ok: header, six tabs and loopback badge render', async () => {
  setupDom()
  const plugin = instantiatePlugin()
  const { state } = applyPlugin(plugin)
  const main = findSlot(state, 'main')

  const calls = installFetch(() => jsonResponse(healthPayload()))
  const view = await renderPage(main.component, {})
  try {
    const text = view.text()
    assert.match(text, /Cortex/, 'panel title')
    assert.match(text, /仅本机/, 'loopback-only badge')
    assert.match(text, /本地漏洞 \/ 资产 \/ 内网 \/ 快照/, 'zh subtitle from shell locale')
    // Six page tabs in the documented order, accessible as role=tab.
    const tabs = view.queryAll('[role="tab"]')
    assert.equal(tabs.length, 6, 'six tabs render')
    assert.deepEqual(
      tabs.map((tab) => tab.textContent),
      ['概览', '漏洞', '资产', '内网', '快照', '复测'],
    )
    assert.ok(view.query('[role="tablist"]'))
    assert.ok(view.query('#dshc-panel-overview'), 'default page mounts overview')
    assert.equal(view.queryAll('#dshc-tab-overview').length, 1)
    assert.ok(!text.includes('正在读取 Cortex 数据库'), 'no loading placeholder after success')
    // Health is fetched once from the internal prefix route.
    assert.ok(calls.some((call) => call.url === '/cortex-api/health'))
    assert.ok(calls.every((call) => call.url.startsWith('/cortex-api/')))
  } finally {
    await view.unmount()
    disposeEffects(state)
  }
})

test('health loading: loading placeholder renders while /health is pending', async () => {
  setupDom()
  const plugin = instantiatePlugin()
  const { state } = applyPlugin(plugin)
  const main = findSlot(state, 'main')

  globalThis.fetch = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(healthPayload())), 30_000)
      const signal = options.signal
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }
    })

  const view = await renderPage(main.component, {})
  try {
    assert.match(view.text(), /正在读取 Cortex 数据库/, 'loading state text')
    assert.equal(view.queryAll('[role="tab"]').length, 0, 'tabs hidden while loading')
  } finally {
    await view.unmount()
    disposeEffects(state)
  }
})

test('health schema-incompatible: 409-style state renders without throwing', async () => {
  setupDom()
  const plugin = instantiatePlugin()
  const { state } = applyPlugin(plugin)
  const main = findSlot(state, 'main')

  installFetch(() =>
    jsonResponse(
      healthPayload({
        top: { ok: true },
        db: { schemaVersion: 4, compatible: false },
      }),
    ),
  )
  const view = await renderPage(main.component, {})
  try {
    const text = view.text()
    assert.match(text, /数据库 schema 不兼容/, 'schema incompatible title')
    assert.match(text, /schema 为 4|v5/, 'mentions the actual and supported schema versions')
    assert.match(text, /不会自动迁移/, 'explicitly states no auto migration')
    assert.equal(view.queryAll('[role="tab"]').length, 0, 'no data tabs for incompatible schema')
  } finally {
    await view.unmount()
    disposeEffects(state)
  }
})

test('remote 403: non-loopback access state renders without throwing', async () => {
  setupDom()
  const plugin = instantiatePlugin()
  const { state } = applyPlugin(plugin)
  const main = findSlot(state, 'main')

  const calls = installFetch(() =>
    jsonResponse(
      { error: 'forbidden peer', code: 'FORBIDDEN_PEER' },
      { status: 403, statusText: 'Forbidden' },
    ),
  )
  const view = await renderPage(main.component, {})
  try {
    const text = view.text()
    assert.match(text, /仅本机可用/, 'remote-only state title')
    assert.match(text, /localhost/, 'explains loopback requirement')
    assert.match(text, /FORBIDDEN_PEER/, 'shows diagnostic code')
    assert.equal(calls.length, 1)
    assert.equal(view.queryAll('[role="tab"]').length, 0)
  } finally {
    await view.unmount()
    disposeEffects(state)
  }
})

test('read-only mode: banner renders and data tabs stay available', async () => {
  setupDom()
  const plugin = instantiatePlugin()
  const { state } = applyPlugin(plugin)
  const main = findSlot(state, 'main')

  installFetch(() => jsonResponse(healthPayload({ db: { readOnly: true } })))
  const view = await renderPage(main.component, {})
  try {
    const text = view.text()
    assert.match(text, /只读模式：写操作已禁用/, 'read-only banner')
    assert.equal(view.queryAll('[role="tab"]').length, 6, 'tabs still render in read-only mode')
  } finally {
    await view.unmount()
    disposeEffects(state)
  }
})

test('health db-unavailable: empty-state guidance renders (no crash on missing DB)', async () => {
  setupDom()
  const plugin = instantiatePlugin()
  const { state } = applyPlugin(plugin)
  const main = findSlot(state, 'main')

  installFetch(() =>
    jsonResponse(
      healthPayload({
        db: {
          available: false,
          schemaVersion: null,
          compatible: true,
          error: 'database file is missing',
        },
      }),
    ),
  )
  const view = await renderPage(main.component, {})
  try {
    const text = view.text()
    assert.match(text, /Cortex 数据库不可用/, 'db unavailable title')
    assert.match(text, /CORTEX_DB_PATH/, 'mentions the path override')
    assert.equal(view.queryAll('[role="tab"]').length, 0)
  } finally {
    await view.unmount()
    disposeEffects(state)
  }
})
