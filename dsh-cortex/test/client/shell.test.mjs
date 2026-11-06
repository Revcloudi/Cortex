/**
 * Built-bundle contract tests for `client.js` (DSH client module loader).
 *
 * History: before the original-UI port this file asserted the old DSH-styled
 * renderer contract (zh/en locale namespaces, `ctx.styles` builtin, `/health`
 * header/tabs). That renderer was intentionally replaced by the verbatim Cortex
 * UI port (see docs/cortex-ui-port.md), so those assertions no longer describe
 * the artifact and were retired with it. Rendering fidelity of the ported UI is
 * covered by test/client/cortex-ui.test.mjs (jsdom structural gate).
 *
 * What remains here still holds for any dsh-cortex bundle: the DSH module-loader
 * contract and the slot registrations. No rendering happens, so no ReactDOM
 * browser globals are needed.
 *
 * Run: node --test test/client/shell.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const bundlePath = join(root, 'client.js')
const require = createRequire(import.meta.url)
const React = require('react')

let dom = null
let definition = null

/** Load the built bundle exactly like the DSH client module loader does. */
function loadBundleDefinition() {
  if (definition !== null) return definition
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:63877/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const definitions = []
  dom.window.__ModuleLoader__ = {
    load(entry) {
      definitions.push(entry)
    },
  }
  dom.window.eval(readFileSync(bundlePath, 'utf8'))
  assert.equal(definitions.length, 1, 'bundle calls window.__ModuleLoader__.load exactly once')
  definition = definitions[0]
  return definition
}

/** Instantiate the plugin; only the platform-provided `react` may be required. */
function instantiatePlugin() {
  const entry = loadBundleDefinition()
  assert.equal(entry.id, 'dsh-cortex')
  assert.equal(typeof entry.factory, 'function')
  const required = []
  const plugin = entry.factory((spec) => {
    required.push(spec)
    if (spec === 'react') return React
    throw new Error(`unexpected require(${spec}) in client bundle`)
  })
  return { plugin, required }
}

after(() => {
  try {
    if (dom) dom.window.close()
  } catch {
    /* ignore */
  }
})

test('bundle loads with the DSH module loader and exposes the plugin contract', () => {
  const { plugin, required } = instantiatePlugin()
  assert.equal(plugin.name, 'dsh-cortex')
  assert.equal(typeof plugin.apply, 'function')
  // The plugin object lives in the jsdom realm, so copy arrays before deepEqual.
  assert.deepEqual(Array.from(plugin.inject), ['slots'], 'the plugin injects the slots service')
  assert.deepEqual(required, ['react'], 'bundle self-hosts react-dom and only requires platform React')
})

test('apply() registers sidebar.panellist (id=cortex, order=5) and main (key=cortex)', () => {
  const { plugin } = instantiatePlugin()
  const injected = []
  const registrations = []
  plugin.apply({
    slots: {
      inject(owner, callback) {
        injected.push(owner)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })

  assert.deepEqual(injected, ['sidebar.panellist', 'main'], 'only the two documented slots are injected')
  assert.equal(registrations.length, 2, 'exactly two slot registrations')

  const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(panel, 'sidebar.panellist registration exists')
  assert.equal(panel.options.id, 'cortex')
  assert.equal(panel.options.order, 5, 'Cortex sits between plugins(0) and schedules(10)')
  assert.equal(typeof panel.options.label, 'function')
  assert.equal(panel.options.label(), 'Cortex')
  assert.equal(typeof panel.component, 'function', 'panellist icon component registered')

  const main = registrations.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'main registration exists')
  assert.equal(main.options.key, 'cortex')
  assert.equal(typeof main.component, 'function', 'Cortex page component registered')
})
