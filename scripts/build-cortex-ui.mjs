// Build the ported Cortex UI into the plugin's client.js.
//
// Pipeline:
//   1. Tailwind CLI  → build/cortex-ui/tailwind.css  (utilities for the vendored TSX)
//   2. esbuild CSS   → inlines @fontsource woff2 as data URLs
//   3. esbuild JS    → IIFE bundle exposing globalThis.__DSH_CORTEX_UI__ (React from platform)
//   4. compose       → root client.js (ModuleLoader wrapper + styles + logo data URL)
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const uiRoot = join(root, 'src', 'cortex-ui')
const buildDir = join(root, 'build', 'cortex-ui')
mkdirSync(buildDir, { recursive: true })
const requireFromRoot = createRequire(join(root, 'package.json'))

const started = Date.now()
function log(message) {
  console.log(`[build-cortex-ui] ${message}`)
}

// ---------------------------------------------------------------- 1. Tailwind
const tailwindBin = join(root, 'node_modules', 'tailwindcss', 'lib', 'cli.js')
if (!existsSync(tailwindBin)) throw new Error(`tailwindcss CLI not found: ${tailwindBin}`)
const tailwindOut = join(buildDir, 'tailwind.css')
const tailwindResult = spawnSync(
  process.execPath,
  [
    tailwindBin,
    '-c',
    join(uiRoot, 'tailwind.config.cjs'),
    '-i',
    join(uiRoot, 'dsh', 'tailwind-entry.css'),
    '-o',
    tailwindOut,
    '--minify',
  ],
  { cwd: uiRoot, encoding: 'utf8' },
)
if (tailwindResult.status !== 0) {
  throw new Error(`tailwind failed (${tailwindResult.status}):\n${tailwindResult.stderr || tailwindResult.stdout}`)
}
log(`tailwind: ${(readFileSync(tailwindOut).length / 1024).toFixed(1)} KiB`)

// ---------------------------------------------------------------- 2. CSS bundle
const cssEntry = join(buildDir, 'css-entry.css')
writeFileSync(
  cssEntry,
  [
    "@import '@fontsource-variable/inter';",
    "@import '@fontsource-variable/jetbrains-mono';",
    "@import './tailwind.css';",
    "@import '../../src/cortex-ui/dsh/css-overrides.css';",
    '',
  ].join('\n'),
  'utf8',
)
const cssOut = join(buildDir, 'styles.inlined.css')
await build({
  absWorkingDir: root,
  entryPoints: [cssEntry],
  bundle: true,
  outfile: cssOut,
  minify: true,
  loader: {
    '.woff2': 'dataurl',
    '.woff': 'dataurl',
    '.ttf': 'dataurl',
    '.svg': 'dataurl',
    '.png': 'dataurl',
  },
  logLevel: 'warning',
})
const styles = readFileSync(cssOut, 'utf8')
log(`styles inlined: ${(Buffer.byteLength(styles) / 1024).toFixed(1)} KiB`)

// ---------------------------------------------------------------- 3. JS bundle
const reactShim = join(uiRoot, 'shims', 'react.cjs')
const jsxShim = join(uiRoot, 'shims', 'jsx-runtime.cjs')
const jsxDevShim = join(uiRoot, 'shims', 'jsx-dev-runtime.cjs')
const sonnerShim = join(uiRoot, 'dsh', 'sonner-shim.tsx')
const uiOut = join(buildDir, 'cortex-ui.iife.js')

/** Plugin-resolved paths skip esbuild's extension probing, so resolve manually. */
function resolveTarget(base) {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.css`,
    `${base}.json`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.js'),
    join(base, 'index.jsx'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return base
}

const aliasPlugin = {
  name: 'cortex-ui-aliases',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^react$/ }, () => ({ path: reactShim }))
    buildApi.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: jsxShim }))
    buildApi.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({ path: jsxDevShim }))
    buildApi.onResolve({ filter: /^react-dom$/ }, () => ({ path: requireFromRoot.resolve('react-dom') }))
    buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: requireFromRoot.resolve('react-dom/client') }))
    buildApi.onResolve({ filter: /^sonner$/ }, () => ({ path: sonnerShim }))
    buildApi.onResolve({ filter: /^@renderer\// }, (args) => ({
      path: resolveTarget(join(uiRoot, 'renderer', args.path.slice('@renderer/'.length))),
    }))
    buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
      path: resolveTarget(join(uiRoot, 'shared', args.path.slice('@shared/'.length))),
    }))
  },
}

await build({
  absWorkingDir: uiRoot,
  entryPoints: [join(uiRoot, 'dsh', 'entry.tsx')],
  bundle: true,
  outfile: uiOut,
  format: 'iife',
  globalName: 'DSH_CORTEX_UI_IIFE',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  minify: process.env.CORTEX_UI_DEBUG === '1' ? false : true,
  sourcemap: false,
  loader: {
    '.svg': 'dataurl',
    '.png': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: "var process = typeof process !== 'undefined' ? process : { env: { NODE_ENV: 'production' }, platform: 'browser', version: '' };",
  },
  footer: {
    js: 'globalThis.__DSH_CORTEX_UI__ = DSH_CORTEX_UI_IIFE;',
  },
  plugins: [aliasPlugin],
  logLevel: 'warning',
  legalComments: 'none',
})
const uiBundle = readFileSync(uiOut, 'utf8')
log(`ui bundle: ${(Buffer.byteLength(uiBundle) / 1024).toFixed(1)} KiB`)

// ---------------------------------------------------------------- 4. Compose client.js
const logoPath = join(uiRoot, 'renderer', 'assets', 'logo-mark.svg')
const logo = readFileSync(logoPath, 'utf8')
const logoUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(logo)}`

const template = readFileSync(join(uiRoot, 'dsh', 'wrapper.template.js'), 'utf8')
const client = template
  .replace('__CORTEX_UI_STYLES__', JSON.stringify(styles))
  .replace('__CORTEX_LOGO_DATA_URL__', JSON.stringify(logoUrl))
  .replace('__CORTEX_UI_BUNDLE__', () => uiBundle)

const clientPath = join(root, 'client.js')
writeFileSync(clientPath, client, 'utf8')
// Syntax check the generated artifact before it can reach the live page.
new vm.Script(client, { filename: 'client.js' })

log(
  `client.js: ${(Buffer.byteLength(client) / 1024).toFixed(1)} KiB, ${((Date.now() - started) / 1000).toFixed(1)}s`,
)
