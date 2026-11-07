// Unit tests for the display-only JSON/JS formatter used by the file preview.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatContent,
  formatJsText,
  formatJsonText,
  languageOf,
  MAX_FORMAT_OUTPUT_BYTES,
} from '../../src/host/miniapp/format.js'

test('languageOf detects JSON/JS/other files', () => {
  assert.equal(languageOf('app-config.json'), 'json')
  assert.equal(languageOf('app-service.js'), 'js')
  assert.equal(languageOf('page-frame.wxs'), 'js')
  assert.equal(languageOf('index.html'), 'text')
})

test('formatJsonText pretty-prints a single-line config', () => {
  const raw = '{"pages":["pages/index/index"],"tabBar":{"list":[{"text":"首页"}]}}'
  const formatted = formatJsonText(raw)
  assert.ok(formatted !== null)
  assert.match(formatted, /^\{\n {2}"pages": \[/)
  assert.match(formatted, /"text": "首页"/)
  assert.ok(formatted.split('\n').length > 3)
  assert.deepEqual(JSON.parse(formatted), JSON.parse(raw))
})

test('formatJsonText returns null for invalid JSON', () => {
  assert.equal(formatJsonText('{not json'), null)
  assert.equal(formatJsonText('   '), null)
})

test('formatJsText splits minified statements without touching string content', () => {
  const raw = 'const a=1;const b={c:"x;y",d:2};function f(){return a+b.c}'
  const formatted = formatJsText(raw)
  assert.match(formatted, /const a=1;\n/)
  assert.match(formatted, /const b=\{\n {2}c:"x;y", d:2\n\};/)
  assert.match(formatted, /function f\(\)\{\n {2}return a\+b\.c\n\}/)
  assert.ok(formatted.includes('"x;y"'), 'semicolon inside a string stays inside the string')
})

test('formatJsText preserves regex/template literals and comments', () => {
  const raw = 'const r=/[;{}]/g;const t=`a;{b}`;/* c;{} */const s=\'q;{}\';'
  const formatted = formatJsText(raw)
  assert.ok(formatted.includes('/[;{}]/g'))
  assert.ok(formatted.includes('`a;{b}`'))
  assert.ok(formatted.includes("'q;{}'"))
  assert.ok(formatted.includes('/* c;{} */'))
})

test('formatContent formats JSON/JS and leaves other text raw', () => {
  const json = formatContent({ path: 'app-config.json', content: '{"a":1}' })
  assert.equal(json.formatted, true)
  assert.equal(json.language, 'json')
  assert.match(json.text, /\n {2}"a": 1/)

  const js = formatContent({ path: 'app.js', content: 'let a=1;let b=2;' })
  assert.equal(js.formatted, true)
  assert.match(js.text, /let a=1;\nlet b=2;\n/)

  const text = formatContent({ path: 'README.md', content: 'a;b' })
  assert.equal(text.formatted, false)
  assert.equal(text.text, 'a;b')

  const broken = formatContent({ path: 'broken.json', content: '{oops' })
  assert.equal(broken.formatted, false)
  assert.equal(broken.text, '{oops')
})

test('formatJsText output stays under the hard output cap', () => {
  const raw = 'const x=1;'.repeat(200)
  const formatted = formatJsText(raw)
  assert.ok(Buffer.byteLength(formatted) <= MAX_FORMAT_OUTPUT_BYTES)
})
