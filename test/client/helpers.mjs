// Shared helpers for client page tests.
//
// Pages are plain CommonJS modules that require('react'), so tests can load the
// source page directly (no bundle needed) and render it into jsdom.
//
// Usage:
//   import { renderPage, makeT, loadPage, apiError, cleanupDom } from './helpers.mjs'
//   const page = loadPage('vulns')
//   const view = await renderPage(page.Component, { api, t, nav, app, rev: 0, toast: () => {} })
//   assert.match(view.html(), /.../)
//   await view.unmount()
//   cleanupDom()
import { JSDOM } from 'jsdom'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let currentDom = null
const previousGlobals = new Map()

function setGlobal(name, value) {
  if (!previousGlobals.has(name)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  // Node 24 exposes some globals (navigator, Event, ...) as getter-only
  // accessors, so plain assignment throws in strict-mode ESM.
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  })
}

function restoreGlobals() {
  for (const [name, descriptor] of previousGlobals) {
    try {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    } catch {
      /* ignore */
    }
  }
  previousGlobals.clear()
}

export function setupDom() {
  if (currentDom) return currentDom
  currentDom = new JSDOM('<!doctype html><html><body><div id="dsh-cortex-test-root"></div></body></html>', {
    url: 'http://127.0.0.1:63877/',
    pretendToBeVisual: true,
  })
  const { window } = currentDom
  setGlobal('window', window)
  setGlobal('document', window.document)
  setGlobal('navigator', window.navigator)
  setGlobal('HTMLElement', window.HTMLElement)
  setGlobal('Node', window.Node)
  setGlobal('Event', window.Event)
  setGlobal('MouseEvent', window.MouseEvent)
  setGlobal('KeyboardEvent', window.KeyboardEvent)
  setGlobal('getComputedStyle', window.getComputedStyle.bind(window))
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })
  }
  setGlobal('matchMedia', window.matchMedia.bind(window))
  return currentDom
}

export function cleanupDom() {
  if (!currentDom) return
  try {
    currentDom.window.close()
  } catch {
    /* ignore */
  }
  currentDom = null
  restoreGlobals()
}

export function loadPage(name) {
  return require(`../../src/client/pages/${name}.js`)
}

export function loadKit() {
  return require('../../src/client/ui/kit.js')
}

/** Translate stub: dictionary[key] fallback to key. */
export function makeT(dict) {
  const table = dict || {}
  return function t(key, vars) {
    let value = table[key] !== undefined ? table[key] : key
    if (vars) for (const name of Object.keys(vars)) value = String(value).split(`{${name}}`).join(String(vars[name]))
    return value
  }
}

/** Flush microtasks + one macrotask inside act(). */
export async function flush(extraTicks = 3) {
  const { act } = require('react')
  for (let index = 0; index < extraTicks; index++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

export async function renderPage(Component, props) {
  setupDom()
  const { act } = require('react')
  const { createRoot } = require('react-dom/client')
  const React = require('react')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = async (nextProps) => {
    await act(async () => {
      root.render(React.createElement(Component, nextProps || props))
    })
    await flush()
  }
  await render(props)
  return {
    container,
    html: () => container.innerHTML,
    text: () => container.textContent,
    query: (selector) => container.querySelector(selector),
    queryAll: (selector) => Array.prototype.slice.call(container.querySelectorAll(selector)),
    rerender: render,
    act,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** Basic ApiError-shaped error for page error-state tests. */
export function apiError(code, message, details) {
  const error = new Error(message || code)
  error.name = 'ApiError'
  error.code = code
  error.status = 400
  error.details = details === undefined ? null : details
  return error
}
