/**
 * Provider adapter profiles: request building, response parsing, model list
 * parsing and error normalization for every preset.
 *
 * The point of these tests is that each vendor is an independent profile — not
 * a single shared OpenAI client — and that no credential leaks through error
 * messages or model lists.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  getProviderAdapter,
  supportsJsonMode
} from '../providers'
import {
  HUNYUAN_TC3_SUPPORTED,
  ANTHROPIC_DEFAULT_API_VERSION
} from '../providers'
import { POC_PRESETS, POC_PRESET_IDS, POC_ERROR_CODES } from '../../../shared/poc'
import type { PocPresetId, PocProviderConfig } from '../../../shared/poc'
import { captureSyncThrow, expectPocError } from './testHelpers'

const API_KEY = 'sk-test-api-key-1234-SECRET'

function makeProvider(
  preset: PocPresetId,
  overrides: Partial<PocProviderConfig> = {}
): PocProviderConfig {
  return {
    id: `poc-${preset}`,
    preset,
    label: POC_PRESETS[preset].label,
    baseUrl: '',
    model: 'test-model',
    credentials: { apiKey: API_KEY },
    timeoutMs: 60_000,
    maxOutputTokens: 4_000,
    ...overrides
  }
}

function parseBody(request: { body: string }): Record<string, unknown> {
  const parsed: unknown = JSON.parse(request.body)
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
  return parsed as Record<string, unknown>
}

/* ------------------------------------------------------------------------- */
/* Registry coverage                                                         */
/* ------------------------------------------------------------------------- */

test('registry resolves every preset to an independent adapter profile', () => {
  const seen = new Set<object>()
  for (const preset of POC_PRESET_IDS) {
    const adapter = getProviderAdapter(preset)
    assert.equal(adapter.preset, preset, `adapter preset mismatch for ${preset}`)
    assert.equal(
      adapter.supportsJsonMode,
      POC_PRESETS[preset].supportsJsonMode,
      `supportsJsonMode mismatch for ${preset}`
    )
    assert.equal(supportsJsonMode(preset), POC_PRESETS[preset].supportsJsonMode)
    assert.equal(typeof adapter.buildChatRequest, 'function')
    assert.equal(typeof adapter.parseChatResponse, 'function')
    assert.equal(typeof adapter.normalizeError, 'function')
    assert.ok(!seen.has(adapter), `preset ${preset} must not share another preset's adapter object`)
    seen.add(adapter)
  }
  assert.equal(seen.size, POC_PRESET_IDS.length)
})

test('unknown preset is an explicit INVALID_CONFIG error (never a fallback)', () => {
  const adapterError = captureSyncThrow(() => getProviderAdapter('nope' as PocPresetId))
  expectPocError(adapterError, POC_ERROR_CODES.INVALID_CONFIG)

  const jsonModeError = captureSyncThrow(() => supportsJsonMode('nope' as PocPresetId))
  expectPocError(jsonModeError, POC_ERROR_CODES.INVALID_CONFIG)
})

test('manual-discovery presets expose null model list requests', () => {
  for (const preset of ['commoncode', 'custom'] as const) {
    const adapter = getProviderAdapter(preset)
    assert.equal(adapter.listModelsRequest(makeProvider(preset, { baseUrl: 'https://x.example/v1' })), null)
  }
  for (const preset of POC_PRESET_IDS) {
    if (preset === 'commoncode' || preset === 'custom') continue
    const request = getProviderAdapter(preset).listModelsRequest(makeProvider(preset))
    assert.ok(request !== null && request.url.length > 0, `${preset} should expose a list endpoint`)
  }
})

/* ------------------------------------------------------------------------- */
/* OpenAI-compatible family                                                  */
/* ------------------------------------------------------------------------- */

test('every OpenAI-compatible vendor builds its own default endpoint', () => {
  for (const preset of ['deepseek', 'glm', 'kimi', 'openai', 'openrouter', 'qwen'] as const) {
    const provider = makeProvider(preset)
    const request = getProviderAdapter(preset).buildChatRequest(provider, [
      { role: 'user', content: 'hello' }
    ])
    assert.equal(request.url, `${POC_PRESETS[preset].defaultBaseUrl}/chat/completions`)
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, `Bearer ${API_KEY}`)
    assert.equal(request.headers['content-type'], 'application/json')
  }
})

test('deepseek adapter: JSON mode, max_tokens, model list and error normalization', () => {
  const adapter = getProviderAdapter('deepseek')
  const provider = makeProvider('deepseek', {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    maxOutputTokens: 1_234
  })
  const request = adapter.buildChatRequest(
    provider,
    [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' }
    ],
    { jsonMode: true }
  )
  assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions')
  const body = parseBody(request)
  assert.equal(body.model, 'deepseek-chat')
  assert.equal(body.temperature, 0.1)
  assert.equal(body.max_tokens, 1_234)
  assert.deepEqual(body.response_format, { type: 'json_object' })
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'user prompt' }
  ])

  // No response_format when JSON mode was not requested.
  const plainBody = parseBody(adapter.buildChatRequest(provider, [{ role: 'user', content: 'x' }]))
  assert.equal(plainBody.response_format, undefined)

  const listRequest = adapter.listModelsRequest(provider)
  assert.ok(listRequest !== null)
  assert.equal(listRequest.url, 'https://api.deepseek.com/v1/models')
  assert.equal(listRequest.headers.authorization, `Bearer ${API_KEY}`)

  // Dedupe + deterministic ordering; tolerant of string arrays and labels.
  const models = adapter.parseModelList({
    data: [
      { id: 'deepseek-chat', owned_by: 'deepseek' },
      { id: 'deepseek-reasoner' },
      { id: 'deepseek-chat', name: 'DeepSeek Chat' }
    ]
  })
  assert.deepEqual(
    models.map((model) => model.id),
    ['deepseek-chat', 'deepseek-reasoner']
  )
  assert.equal(models[0]?.ownedBy, 'deepseek')
  assert.deepEqual(adapter.parseModelList({ unexpected: true }), [])

  const chat = adapter.parseChatResponse({
    choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
  })
  assert.equal(chat.text, '{"ok":true}')
  assert.deepEqual(chat.usage, { inputTokens: 5, outputTokens: 7, totalTokens: 12 })

  const error = adapter.normalizeError(
    401,
    '{"error":{"message":"bad key sk-abcdefghijklmnop123456"}}'
  )
  assert.match(error, /401/)
  assert.match(error, /API Key/)
  assert.ok(!error.includes('sk-abcdefghijklmnop123456'), 'error must not echo secret-looking values')
})

test('base URL overrides are normalized (no double slash) and validated as http(s)', () => {
  const adapter = getProviderAdapter('openai')
  const request = adapter.buildChatRequest(
    makeProvider('openai', { baseUrl: 'https://gateway.example/v1/', model: 'gpt-test' }),
    [{ role: 'user', content: 'x' }]
  )
  assert.equal(request.url, 'https://gateway.example/v1/chat/completions')

  const invalid = captureSyncThrow(() =>
    adapter.buildChatRequest(makeProvider('openai', { baseUrl: 'file:///etc/passwd' }), [
      { role: 'user', content: 'x' }
    ])
  )
  expectPocError(invalid, POC_ERROR_CODES.INVALID_CONFIG)
})

test('openrouter adds constant attribution headers but no extra secrets', () => {
  const request = getProviderAdapter('openrouter').buildChatRequest(
    makeProvider('openrouter'),
    [{ role: 'user', content: 'x' }]
  )
  assert.equal(request.headers['HTTP-Referer'], 'https://github.com/Revcloudi/Cortex')
  assert.equal(request.headers['X-Title'], 'Cortex')
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`)
  // Authorization is the only credential-bearing header.
  const credentialHeaders = Object.entries(request.headers).filter(([, value]) =>
    value.includes(API_KEY)
  )
  assert.deepEqual(credentialHeaders.map(([name]) => name), ['authorization'])
})

/* ------------------------------------------------------------------------- */
/* Anthropic Messages family                                                 */
/* ------------------------------------------------------------------------- */

test('anthropic adapter: x-api-key + anthropic-version, system field, no response_format', () => {
  const adapter = getProviderAdapter('claudecode')
  assert.equal(adapter.supportsJsonMode, false)
  const provider = makeProvider('claudecode', {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-test',
    maxOutputTokens: 512
  })
  const request = adapter.buildChatRequest(
    provider,
    [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' }
    ],
    { jsonMode: true }
  )
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(request.headers['x-api-key'], API_KEY)
  assert.equal(request.headers['anthropic-version'], ANTHROPIC_DEFAULT_API_VERSION)
  assert.equal(request.headers.authorization, undefined)
  const body = parseBody(request)
  assert.equal(body.system, 'system prompt')
  assert.equal(body.max_tokens, 512)
  assert.equal(body.response_format, undefined)
  assert.deepEqual(body.messages, [{ role: 'user', content: 'user prompt' }])

  // apiVersion override + /v1-suffixed base URL must not double the prefix.
  const customVersion = adapter.buildChatRequest(
    makeProvider('claudecode', { baseUrl: 'https://gateway.example/v1', apiVersion: '2024-01-01' }),
    [{ role: 'user', content: 'x' }]
  )
  assert.equal(customVersion.url, 'https://gateway.example/v1/messages')
  assert.equal(customVersion.headers['anthropic-version'], '2024-01-01')
  assert.equal(
    adapter.listModelsRequest(provider)?.url,
    'https://api.anthropic.com/v1/models'
  )
})

test('anthropic response parsing is tolerant and model list parsing works', () => {
  const adapter = getProviderAdapter('claudecode')
  const blocks = adapter.parseChatResponse({
    content: [
      { type: 'text', text: '{"ui_schema":' },
      { type: 'text', text: '{"fields":[]}}' }
    ],
    usage: { input_tokens: 3, output_tokens: 5 }
  })
  assert.equal(blocks.text, '{"ui_schema":{"fields":[]}}')
  assert.deepEqual(blocks.usage, { inputTokens: 3, outputTokens: 5, totalTokens: 8 })

  assert.equal(adapter.parseChatResponse({ content: 'plain text' }).text, 'plain text')
  assert.equal(adapter.parseChatResponse({ completion: 'legacy' }).text, 'legacy')
  assert.throws(() => adapter.parseChatResponse({ content: [] }))

  const models = adapter.parseModelList({
    data: [
      { id: 'claude-a', display_name: 'Claude A' },
      { id: 'claude-b', type: 'model' }
    ]
  })
  assert.deepEqual(models, [{ id: 'claude-a', label: 'Claude A' }, { id: 'claude-b' }])
  assert.deepEqual(adapter.parseModelList({ data: 'nope' }), [])
  assert.match(adapter.normalizeError(429, 'rate limited'), /429/)
})

/* ------------------------------------------------------------------------- */
/* Hunyuan family                                                            */
/* ------------------------------------------------------------------------- */

test('hunyuan adapter is an independent OpenAI-compatible profile (TC3 out of scope)', () => {
  assert.equal(HUNYUAN_TC3_SUPPORTED, false)
  const adapter = getProviderAdapter('hunyuan')
  assert.equal(adapter.preset, 'hunyuan')
  assert.equal(adapter.supportsJsonMode, false)

  // No explicit baseUrl: preset default applies.
  const request = adapter.buildChatRequest(makeProvider('hunyuan'), [
    { role: 'user', content: 'hello' }
  ])
  assert.equal(
    request.url,
    `${POC_PRESETS.hunyuan.defaultBaseUrl}/chat/completions`
  )
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`)
  const body = parseBody(request)
  assert.equal(body.response_format, undefined, 'hunyuan must not send response_format')

  const listRequest = adapter.listModelsRequest(makeProvider('hunyuan'))
  assert.ok(listRequest !== null)
  assert.equal(listRequest.url, `${POC_PRESETS.hunyuan.defaultBaseUrl}/models`)

  const chat = adapter.parseChatResponse({
    choices: [{ message: { content: 'OK' } }]
  })
  assert.equal(chat.text, 'OK')
  assert.match(adapter.normalizeError(500, 'server error'), /500/)
})

/* ------------------------------------------------------------------------- */
/* Manual / custom family                                                    */
/* ------------------------------------------------------------------------- */

test('commoncode and custom require an explicit http(s) base URL and use manual discovery', () => {
  for (const preset of ['commoncode', 'custom'] as const) {
    const adapter = getProviderAdapter(preset)
    const missingBaseUrl = captureSyncThrow(() =>
      adapter.buildChatRequest(makeProvider(preset), [{ role: 'user', content: 'x' }])
    )
    expectPocError(missingBaseUrl, POC_ERROR_CODES.INVALID_CONFIG, 'Base URL')

    const request = adapter.buildChatRequest(
      makeProvider(preset, { baseUrl: 'https://manual.example/v1' }),
      [{ role: 'user', content: 'x' }]
    )
    assert.equal(request.url, 'https://manual.example/v1/chat/completions')
    // Strict known-field allowlist: nothing user-controlled beyond these.
    assert.deepEqual(
      Object.keys(parseBody(request)).sort(),
      ['max_tokens', 'messages', 'model', 'stream', 'temperature']
    )
    assert.deepEqual(Object.keys(request.headers).sort(), [
      'accept',
      'authorization',
      'content-type'
    ])
    assert.equal(adapter.listModelsRequest(makeProvider(preset, { baseUrl: 'https://manual.example/v1' })), null)
    assert.deepEqual(adapter.parseModelList({ data: [{ id: 'manual-model' }] }), [
      { id: 'manual-model' }
    ])
  }
})

test('missing credentials fail with NOT_CONFIGURED before any request', () => {
  const adapters = ['deepseek', 'claudecode', 'hunyuan', 'custom'] as const
  for (const preset of adapters) {
    const provider = makeProvider(preset, {
      baseUrl: 'https://manual.example/v1',
      credentials: {}
    })
    const request = captureSyncThrow(() =>
      getProviderAdapter(preset).buildChatRequest(provider, [{ role: 'user', content: 'x' }])
    )
    expectPocError(request, POC_ERROR_CODES.NOT_CONFIGURED)
  }
})

test('missing model fails with MODEL_REQUIRED for every preset', () => {
  for (const preset of POC_PRESET_IDS) {
    const provider = makeProvider(preset, {
      baseUrl: POC_PRESETS[preset].defaultBaseUrl || 'https://manual.example/v1',
      model: ''
    })
    const request = captureSyncThrow(() =>
      getProviderAdapter(preset).buildChatRequest(provider, [{ role: 'user', content: 'x' }])
    )
    expectPocError(request, POC_ERROR_CODES.MODEL_REQUIRED)
  }
})
