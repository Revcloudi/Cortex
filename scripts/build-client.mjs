// Build the browser half of dsh-cortex.
//
// Source modules in src/client/** are plain CommonJS (`module.exports`, relative
// `require('./x')`, `require('react')` only for external). This script packages
// them into a single self-contained artifact that the DSH Client module loader
// accepts:
//
//   window.__ModuleLoader__.load({ id: "dsh-cortex", factory(require) { ... } })
//
// No third-party bundler is used: the module graph is small, deterministic and
// fully owned by this package.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const clientRoot = join(root, 'src', 'client')
const outFile = process.argv[2] ? join(root, process.argv[2]) : join(root, 'client.js')
const PLUGIN_ID = 'dsh-cortex'
const ENTRY = 'index.js'

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

const dirnamePosix = (id) => id.split('/').slice(0, -1).join('/')
const joinPosix = (base, spec) => {
  const parts = base ? base.split('/') : []
  for (const piece of spec.split('/')) {
    if (!piece || piece === '.') continue
    if (piece === '..') parts.pop()
    else parts.push(piece)
  }
  return parts.join('/')
}

const files = walk(clientRoot)
const modules = new Map()
for (const file of files) {
  const id = relative(clientRoot, file).split('\\').join('/')
  const source = readFileSync(file, 'utf8')
  if (/^\s*(?:import|export)\s/m.test(source)) {
    throw new Error(`${id}: ESM syntax is not supported in client modules; use CommonJS (module.exports/require)`)
  }
  const deps = []
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = match[1]
    if (spec === 'react') {
      deps.push({ spec, target: null })
      continue
    }
    if (!spec.startsWith('.')) throw new Error(`${id}: external module "${spec}" is not available; only 'react' may be required`)
    const target = joinPosix(dirnamePosix(id), spec.endsWith('.js') ? spec : spec + '.js')
    if (!modules.has(target) && !files.some((f) => relative(clientRoot, f).split('\\').join('/') === target)) {
      throw new Error(`${id}: cannot resolve require("${spec}") -> ${target}`)
    }
    deps.push({ spec, target })
  }
  modules.set(id, { source, deps })
}
if (!modules.has(ENTRY)) throw new Error(`missing entry module src/client/${ENTRY}`)

// Topological order with cycle detection.
const order = []
const state = new Map() // 0 = visiting, 1 = done
function visit(id, stack) {
  const mark = state.get(id)
  if (mark === 1) return
  if (mark === 0) throw new Error(`require() cycle: ${[...stack, id].join(' -> ')}`)
  state.set(id, 0)
  for (const dep of modules.get(id).deps) if (dep.target) visit(dep.target, [...stack, id])
  state.set(id, 1)
  order.push(id)
}
visit(ENTRY, [])

// Syntax-check every module body in a CommonJS wrapper.
for (const [id, mod] of modules) {
  try {
    new vm.Script(`(function (module, exports, require) {\n${mod.source}\n})`, { filename: `src/client/${id}` })
  } catch (err) {
    throw new Error(`src/client/${id}: ${err.message}`)
  }
}

const lines = []
lines.push('// dsh-cortex client bundle — GENERATED FILE, DO NOT EDIT.')
lines.push('// Built from src/client/** by scripts/build-client.mjs. Rebuild with: node scripts/build-client.mjs')
lines.push(`// modules: ${order.length}; entry: ${ENTRY}`)
lines.push('window.__ModuleLoader__.load({')
lines.push(`  id: ${JSON.stringify(PLUGIN_ID)},`)
lines.push('  factory: (require) => {')
lines.push('    "use strict";')
lines.push('    const __factories = Object.create(null);')
lines.push('    const __cache = Object.create(null);')
lines.push('    function __resolve(fromId, spec) {')
lines.push('      if (spec === "react") return "@react";')
lines.push('      if (spec.charAt(0) !== ".") throw new Error("module not available: " + spec);')
lines.push('      const parts = fromId.split("/"); parts.pop();')
lines.push('      for (const piece of spec.split("/")) {')
lines.push('        if (!piece || piece === ".") continue;')
lines.push('        if (piece === "..") parts.pop(); else parts.push(piece);')
lines.push('      }')
lines.push('      const id = parts.join("/");')
lines.push('      return id.endsWith(".js") ? id : id + ".js";')
lines.push('    }')
lines.push('    function __load(id) {')
lines.push('      if (__cache[id]) return __cache[id].exports;')
lines.push('      const factory = __factories[id];')
lines.push('      if (!factory) throw new Error("module not found: " + id);')
lines.push('      const module = { exports: {} };')
lines.push('      __cache[id] = module;')
lines.push('      const localRequire = (spec) => spec === "react" ? require("react") : __load(__resolve(id, spec));')
lines.push('      factory(module, module.exports, localRequire);')
lines.push('      return module.exports;')
lines.push('    }')
for (const id of order) {
  lines.push(`    __factories[${JSON.stringify(id)}] = function (module, exports, require) {`)
  lines.push(modules.get(id).source)
  lines.push('    };')
}
lines.push(`    return __load(${JSON.stringify(ENTRY)});`)
lines.push('  },')
lines.push('});')
lines.push('')

const output = lines.join('\n')
writeFileSync(outFile, output, 'utf8')
const kb = (Buffer.byteLength(output) / 1024).toFixed(1)
console.log(`built client.js — ${order.length} modules, ${kb} KiB: ${order.join(', ')}`)
