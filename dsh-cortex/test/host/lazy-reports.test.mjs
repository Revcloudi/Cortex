/**
 * Web DSH boots plugin entries in a browser-like runtime where the report
 * renderers (pdfkit/docx and their zlib shims) can fail. Activation must not
 * pull them in; only an explicit docx/pdf export may.
 */
import assert from 'node:assert/strict'
import Module from 'node:module'
import { test } from 'node:test'

test('host activation does not load pdfkit or docx', async () => {
  const originalLoad = Module._load
  const loaded = []
  Module._load = function patchedLoad(request, ...rest) {
    loaded.push(String(request))
    return originalLoad.call(this, request, ...rest)
  }
  try {
    await import('../../src/host/app.js')
  } finally {
    Module._load = originalLoad
  }
  assert.equal(loaded.includes('pdfkit'), false, 'pdfkit must be lazy-loaded')
  assert.equal(loaded.includes('docx'), false, 'docx must be lazy-loaded')
})
