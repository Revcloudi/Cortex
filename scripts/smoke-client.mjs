// Load the built client bundle in Node and exercise plugin registration only
// (no React rendering). Used as a fast smoke check while developing.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(root, 'client.js'), 'utf8')

const fakeReact = {
  createElement: (...args) => ({ type: args[0] || 'div', props: args[1] || {}, children: args.slice(2) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  cloneElement: (element) => element,
  Fragment: 'Fragment',
}

let loaded = null
const window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
const sandbox = { window, console, setTimeout, clearTimeout, fetch }
vm.createContext(sandbox)
vm.runInContext(bundle, sandbox, { filename: 'client.js' })
if (!loaded || loaded.id !== 'dsh-cortex') throw new Error(`bundle id mismatch: ${loaded && loaded.id}`)

const plugin = loaded.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require(${name})`)
})
if (!plugin || typeof plugin.apply !== 'function') throw new Error('plugin.apply missing')
if (plugin.name !== 'dsh-cortex') throw new Error(`plugin.name mismatch: ${plugin.name}`)
if (!Array.isArray(plugin.inject) || plugin.inject.indexOf('slots') < 0 || plugin.inject.indexOf('locale') < 0) {
  throw new Error(`plugin.inject mismatch: ${JSON.stringify(plugin.inject)}`)
}

const registrations = []
const effects = []
const localeRegs = []
const fakeCtx = {
  locale: {
    register: (ns, locale, dict) => {
      localeRegs.push({ ns, locale, keys: Object.keys(dict || {}).length })
      return () => {}
    },
    getLocale: () => ({ active: 'zh', revision: 1, locales: [] }),
    subscribe: () => () => {},
  },
  slots: {
    inject: (key, callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect: (factory) => {
    const dispose = factory()
    effects.push(dispose)
    return () => {}
  },
}

plugin.apply(fakeCtx)

const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
const main = registrations.find((entry) => entry.options.name === 'main')
if (!panel) throw new Error('missing sidebar.panellist registration')
if (panel.options.id !== 'cortex') throw new Error(`panellist id: ${panel.options.id}`)
if (panel.options.order !== 5) throw new Error(`panellist order: ${panel.options.order}`)
if (typeof panel.component !== 'function') throw new Error('panellist component missing')
if (!main) throw new Error('missing main registration')
if (main.options.key !== 'cortex') throw new Error(`main key: ${main.options.key}`)
if (typeof main.component !== 'function') throw new Error('main component missing')
if (!localeRegs.some((entry) => entry.ns === 'dsh-cortex' && entry.locale === 'zh')) throw new Error('missing shell zh locale')
if (!localeRegs.some((entry) => entry.ns === 'dsh-cortex' && entry.locale === 'en')) throw new Error('missing shell en locale')
for (const page of ['overview', 'vulns', 'assets', 'internal', 'snapshots', 'retest']) {
  if (!localeRegs.some((entry) => entry.ns === `dsh-cortex.${page}`)) throw new Error(`missing locale namespace for page ${page}`)
}
const label = typeof panel.options.label === 'function' ? panel.options.label() : panel.options.label
if (label !== 'Cortex') throw new Error(`unexpected label: ${label}`)

for (const dispose of effects) if (typeof dispose === 'function') dispose()

console.log('client smoke OK')
console.log(`  bundle: ${(Buffer.byteLength(bundle) / 1024).toFixed(1)} KiB, id=${loaded.id}`)
console.log(`  registrations: ${registrations.map((entry) => JSON.stringify(entry.options)).join(' | ')}`)
console.log(`  locale registrations: ${localeRegs.length}`)
console.log(`  pages: ${plugin.PAGES.map((page) => page.id).join(', ')}`)
