/**
 * Package manifest / bundling tests.
 *
 * Validates the DSH bundle contract (`package.json`, exports/files, cordis
 * patch, locale meta, icon) and runs `npm pack --dry-run --json` to assert the
 * tarball contains exactly the runtime artifacts and none of the dev tree.
 *
 * Run: node --test test/manifest.test.mjs
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const read = (path) => readFileSync(join(root, path), 'utf8')
const exists = (path) => existsSync(join(root, path))
const require = createRequire(import.meta.url)

const pkg = JSON.parse(read('package.json'))

/** Required top-level entries of `npm pack`. */
const REQUIRED_PACKED = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'locale/en.json',
  'locale/zh.json',
  'src/cortex-ui/renderer/App.tsx',
  'src/cortex-ui/dsh/entry.tsx',
  'src/cortex-ui/dsh/api.ts',
  'src/cortex-ui/dsh/wrapper.template.js',
  'src/cortex-ui/shared/graph.ts',
  'src/host/app.js',
  'src/host/db.js',
  'src/host/repository.js',
  'src/host/router.js',
  'src/host/cortex/index.js',
  'src/host/cortex/graph-builder.js',
]

/** Path prefixes that must NEVER be published. */
const FORBIDDEN_PACKED_PREFIXES = ['test/', 'fixtures/', 'recon/', 'node_modules/', 'scripts/', 'docs/', '.git/']

let packResult

before(() => {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(command, ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    shell: process.platform === 'win32',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  let parsed = null
  try {
    parsed = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1))
  } catch (error) {
    assert.fail(`cannot parse npm pack --json output: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`)
  }
  packResult = {
    parsed,
    stderr,
    status: result.status,
    files: (parsed[0]?.files ?? []).map((entry) => String(entry.path).replace(/\\/g, '/')),
    raw: parsed[0] ?? null,
  }
})

// ---------------------------------------------------------------- package.json

test('package.json: identity, exports, files and engines match the DSH bundle contract', () => {
  assert.equal(pkg.name, 'dsh-cortex')
  assert.equal(pkg.type, 'module')
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.match(pkg.description, /\S/)

  // exports map: entry, client bundle, icon, locale glob, patch and self.
  assert.ok(pkg.exports, 'exports map is present')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')

  // files whitelist keeps the tarball small and the runtime surface explicit.
  assert.ok(Array.isArray(pkg.files))
  for (const entry of ['index.js', 'client.js', 'src', 'cordis.patch.yml', 'locale', 'icon.svg', 'README.md']) {
    assert.ok(pkg.files.includes(entry), `package.json files[] includes ${entry}`)
  }

  // Node >= 22.19 for node:sqlite; DSH 0.2.2-rc.1 is the verified host.
  assert.match(String(pkg.engines?.node ?? ''), />=\s*22\.19/)
  assert.equal(pkg.main, 'index.js')
})

test('every exports / files path exists on disk', () => {
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue
    if (key.includes('*')) {
      // locale glob: at least en + zh must exist.
      const dir = target.slice(2, target.lastIndexOf('/'))
      for (const locale of ['en', 'zh']) {
        assert.ok(exists(`${dir}/${locale}.json`), `exports ${key} target ${dir}/${locale}.json exists`)
      }
      continue
    }
    assert.ok(exists(target), `exports[${JSON.stringify(key)}] -> ${target} exists`)
  }

  for (const entry of pkg.files) {
    const full = join(root, entry)
    assert.ok(existsSync(full), `files[] entry ${entry} exists`)
    const stats = statSync(full)
    assert.ok(stats.isFile() || stats.isDirectory(), `files[] entry ${entry} is a file or directory`)
  }

  // Static entry sanity: host entry wires createCortexHost and the plugin contract.
  const indexSource = read('index.js')
  assert.match(indexSource, /createCortexHost/)
  assert.match(indexSource, /export\s+const\s+name\s*=\s*['"]dsh-cortex['"]/)
  assert.match(indexSource, /webServer/)

  // The generated client bundle is loadable by the DSH module loader.
  const clientSource = read('client.js')
  assert.match(clientSource, /window\.__ModuleLoader__\.load\(/)
  assert.match(clientSource, /id:\s*["']dsh-cortex["']/)
  assert.ok(Buffer.byteLength(clientSource) > 5 * 1024, 'client.js is a real built bundle')
})

test('DSH declarations: bundle patch + web client platform', () => {
  assert.ok(pkg.dsh, 'package.json dsh section is present')
  assert.equal(pkg.dsh.bundle?.patch, './cordis.patch.yml')
  assert.ok(exists('cordis.patch.yml'))
  assert.equal(pkg.dsh.client?.platform, 'web')
  assert.equal(pkg.dsh.client?.immediately, true)
})

// ---------------------------------------------------------------- locale + icon

test('locale dictionaries expose bilingual meta.title / meta.description', () => {
  const locales = {}
  for (const locale of ['en', 'zh']) {
    const path = `locale/${locale}.json`
    assert.ok(exists(path), `${path} exists`)
    const dict = JSON.parse(read(path))
    locales[locale] = dict
    assert.equal(typeof dict.meta?.title, 'string', `${path} meta.title is a string`)
    assert.equal(typeof dict.meta?.description, 'string', `${path} meta.description is a string`)
    assert.ok(dict.meta.title.trim().length > 0, `${path} meta.title is not empty`)
    assert.ok(dict.meta.description.trim().length > 20, `${path} meta.description is descriptive`)
  }
  assert.equal(locales.zh.meta.title, 'Cortex')
  assert.notEqual(locales.zh.meta.description, locales.en.meta.description, 'zh/en descriptions are localized')
  // The plugin id must never be translated away.
  assert.equal(locales.en.meta.title, locales.zh.meta.title)
})

test('icon.svg is well-formed XML, <= 256KiB and a real SVG', () => {
  const iconPath = join(root, 'icon.svg')
  const source = readFileSync(iconPath, 'utf8')
  const bytes = Buffer.byteLength(source)
  assert.ok(bytes > 0 && bytes <= 256 * 1024, `icon.svg size ${bytes} within 256KiB`)
  assert.match(source, /^\s*<svg[\s>]/m)

  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('')
  const parser = new dom.window.DOMParser()
  const doc = parser.parseFromString(source, 'image/svg+xml')
  const parserErrors = doc.getElementsByTagName('parsererror')
  assert.equal(parserErrors.length, 0, `icon.svg XML parse error: ${parserErrors[0]?.textContent ?? ''}`)
  assert.equal(doc.documentElement.tagName.toLowerCase(), 'svg')
  assert.equal(doc.documentElement.getAttribute('xmlns'), 'http://www.w3.org/2000/svg')
  assert.ok(doc.documentElement.getAttribute('viewBox'), 'svg has a viewBox')
  dom.window.close()
})

// ---------------------------------------------------------------- cordis patch

test('cordis.patch.yml inserts exactly one dsh-cortex bundle row', () => {
  const yaml = read('cordis.patch.yml')
  assert.match(yaml, /^-\s*insert:/m, 'patch starts an insert block')
  // Normalize quotes: id/name may be single-, double-quoted or bare.
  const normalized = yaml.replace(/['"]/g, '')
  assert.match(normalized, /^-\s*insert:/m)
  assert.match(normalized, /^\s+-\s+id:\s*dsh-cortex\s*$/m, 'patch row id is dsh-cortex')
  assert.match(normalized, /^\s+name:\s*dsh-cortex\s*$/m, 'patch row name is dsh-cortex')

  const insertIndex = normalized.search(/^-\s*insert:/m)
  const idIndex = normalized.search(/id:\s*dsh-cortex/m)
  const nameIndex = normalized.search(/name:\s*dsh-cortex/m)
  assert.ok(idIndex > insertIndex && nameIndex > insertIndex, 'id/name live under the insert block')
  assert.ok(nameIndex > idIndex, 'patch row defines id before name')
  // No absolute local paths / secrets in the published patch.
  assert.ok(!/[A-Za-z]:\\/.test(yaml), 'cordis.patch.yml has no absolute Windows path')
})

// ---------------------------------------------------------------- npm pack

test('npm pack --dry-run --json succeeds and includes the runtime artifacts', () => {
  assert.equal(packResult.status, 0, `npm pack failed: ${packResult.stderr}`)
  assert.ok(Array.isArray(packResult.parsed) && packResult.parsed.length === 1, 'npm pack returns exactly one entry')
  assert.equal(packResult.raw.name, 'dsh-cortex')
  assert.equal(packResult.raw.version, pkg.version)
  assert.ok(packResult.files.length >= 20, `packed ${packResult.files.length} files (expected >= 20)`)

  for (const required of REQUIRED_PACKED) {
    assert.ok(packResult.files.includes(required), `npm pack includes ${required}`)
  }

  // Every packed path is a real file on disk.
  for (const packed of packResult.files) {
    assert.ok(exists(packed), `packed file ${packed} exists on disk`)
    assert.ok(!packed.endsWith('/'), `packed entry ${packed} is a file`)
  }

  // locale + src coverage by pattern (future pages/modules stay packaged).
  assert.ok(packResult.files.some((path) => path.startsWith('src/cortex-ui/')), 'src/cortex-ui/** included')
  assert.ok(packResult.files.some((path) => path.startsWith('src/host/')), 'src/host/** included')
  assert.ok(packResult.files.filter((path) => /^locale\/.*\.json$/.test(path)).length >= 2, 'locale/*.json included')
  assert.ok(packResult.files.every((path) => !path.includes('\\')), 'packed paths use forward slashes')
  assert.ok(packResult.files.every((path) => !path.startsWith('./')), 'packed paths are relative and normalized')
})

test('npm pack excludes dev-only trees (tests, fixtures, recon, node_modules, scripts, docs)', () => {
  for (const packed of packResult.files) {
    for (const prefix of FORBIDDEN_PACKED_PREFIXES) {
      assert.ok(!packed.startsWith(prefix), `npm pack must not include ${prefix} (found ${packed})`)
    }
    assert.ok(!/(^|\/)node_modules\//.test(packed), `npm pack must not include nested node_modules (${packed})`)
    assert.ok(!packed.endsWith('.tgz'), `npm pack must not include tarballs (${packed})`)
    assert.ok(!/(^|\/)\.env(\.|$)/.test(packed), `npm pack must not include .env (${packed})`)
  }
  // Sanity: the dev tree really is present locally (otherwise the assertions above are vacuous).
  for (const dir of ['test', 'fixtures', 'recon', 'scripts', 'docs']) {
    assert.ok(exists(dir), `dev tree ${dir}/ exists locally but is not packed`)
  }
  const relativeToRoot = relative(root, join(root, 'test', 'manifest.test.mjs'))
  assert.equal(relativeToRoot.replace(/\\/g, '/'), 'test/manifest.test.mjs')
})
