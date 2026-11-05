/**
 * `src/main/pocConfig.ts` behaviour tests.
 *
 * Covers: file location, `poc`-namespace preservation, atomic writes, env
 * overrides, write-only credentials (view never echoes them), model-required
 * provider upserts, active-provider switching, proxy write-only semantics,
 * model discovery (success / degrade-to-manual / config errors) and connection
 * testing — plus "no credential in logs" assertions.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createPocConfigService,
  POC_API_KEY_ENV,
  POC_BASE_URL_ENV,
  POC_CONFIG_ENV,
  POC_MODEL_ENV,
  POC_MEMORY_DB_CONFIG_DIRECTORY,
  POC_PROXY_URL_ENV
} from '../../../main/pocConfig'
import type { PocConfigService } from '../../../main/services/pocContracts'
import { POC_ERROR_CODES, POC_LIMITS } from '../../../shared/poc'
import {
  captureRejection,
  captureSyncThrow,
  createCapturingLogger,
  createSequenceFetch,
  createTempWorkspace,
  expectPocError,
  jsonResponse,
  type CapturedLog,
  type CapturingLogger,
  type TempWorkspace
} from './testHelpers'

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

interface ServiceBundle {
  service: PocConfigService
  logger: CapturingLogger
}

function createService(workspace: TempWorkspace, env: NodeJS.ProcessEnv = {}): ServiceBundle {
  const logger = createCapturingLogger()
  const service = createPocConfigService({ dbPath: workspace.dbPath, env, logger })
  return { service, logger }
}

function addDeepseek(
  service: PocConfigService,
  options: {
    model?: string
    apiKey?: string
    baseUrl?: string
    setActive?: boolean
    timeoutMs?: number
  } = {}
) {
  return service.upsertProvider({
    preset: 'deepseek',
    model: options.model ?? 'deepseek-chat',
    baseUrl: options.baseUrl,
    credentials: { apiKey: options.apiKey ?? 'sk-file-secret-key-0001' },
    timeoutMs: options.timeoutMs,
    setActive: options.setActive ?? true
  })
}

function readJsonFile(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
  return parsed as Record<string, unknown>
}

function readPocProviders(workspace: TempWorkspace): Array<Record<string, unknown>> {
  const document = readJsonFile(workspace.configPath)
  const poc = document.poc
  if (typeof poc !== 'object' || poc === null) return []
  const providers = (poc as Record<string, unknown>).providers
  return Array.isArray(providers) ? (providers as Array<Record<string, unknown>>) : []
}

function readPocSection(workspace: TempWorkspace): Record<string, unknown> {
  const document = readJsonFile(workspace.configPath)
  const poc = document.poc
  assert.ok(typeof poc === 'object' && poc !== null && !Array.isArray(poc))
  return poc as Record<string, unknown>
}

function assertNoTempFiles(workspace: TempWorkspace): void {
  const leftovers = readdirSync(workspace.dir).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'atomic write must not leave temp files behind')
}

/* ------------------------------------------------------------------------- */
/* Location + missing config                                                 */
/* ------------------------------------------------------------------------- */

test('config path is dirname(data.db)/config.json; missing file = disabled view', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)
    assert.equal(service.configPath, join(workspace.dir, 'config.json'))
    const view = service.view()
    assert.equal(view.path, join(workspace.dir, 'config.json'))
    assert.equal(view.configFileExists, false)
    assert.equal(view.enabled, false)
    assert.equal(view.executionEnabled, true)
    assert.equal(view.activeProviderId, null)
    assert.deepEqual(view.providers, [])
    assert.equal(view.limits.totalTimeoutMs, POC_LIMITS.totalTimeoutMs)
    // Plaintext warning is non-blocking but present before the file exists.
    assert.ok(
      typeof view.permissionWarning === 'string' && view.permissionWarning.includes('明文')
    )
  } finally {
    workspace.dispose()
  }
})

test(':memory: database uses a deterministic OS-temp config path', () => {
  const logger = createCapturingLogger()
  const first = createPocConfigService({ dbPath: ':memory:', env: {}, logger })
  const second = createPocConfigService({ dbPath: ':memory:', env: {}, logger })
  const expected = join(tmpdir(), POC_MEMORY_DB_CONFIG_DIRECTORY, 'config.json')
  assert.equal(first.configPath, expected)
  assert.equal(second.configPath, expected)
})

test('CORTEX_POC_CONFIG overrides the config path and creates its parent directory', () => {
  const workspace = createTempWorkspace()
  try {
    const overridePath = join(workspace.dir, 'nested', 'custom-config.json')
    const { service } = createService(workspace, { [POC_CONFIG_ENV]: overridePath })
    assert.equal(service.configPath, overridePath)
    addDeepseek(service)
    const view = service.view()
    assert.equal(view.path, overridePath)
    assert.equal(view.configFileExists, true)
    assert.ok(view.overriddenByEnv.includes(POC_CONFIG_ENV))
    const document = readJsonFile(overridePath)
    assert.ok(document.poc !== undefined)
  } finally {
    workspace.dispose()
  }
})

/* ------------------------------------------------------------------------- */
/* Namespace preservation + atomic write                                     */
/* ------------------------------------------------------------------------- */

test('save preserves unrelated top-level keys and unknown poc sibling keys', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)
    let view = addDeepseek(service)
    const providerId = view.activeProviderId
    assert.ok(providerId !== null)

    // Another Cortex feature may own other top-level keys / poc siblings.
    const document = readJsonFile(workspace.configPath)
    document['otherFeature'] = { enabled: true, nested: { items: [1, 2, 3] } }
    document['$schemaVersion'] = 1
    const poc = document.poc as Record<string, unknown>
    poc['futureFeature'] = { keep: 'me', n: 42 }
    writeFileSync(workspace.configPath, JSON.stringify(document, null, 2), 'utf8')

    service.reload()
    view = service.save({ activeProviderId: providerId })
    assert.equal(view.activeProviderId, providerId)

    const saved = readJsonFile(workspace.configPath)
    assert.deepEqual(saved['otherFeature'], { enabled: true, nested: { items: [1, 2, 3] } })
    assert.equal(saved['$schemaVersion'], 1)
    const savedPoc = readPocSection(workspace)
    assert.deepEqual(savedPoc['futureFeature'], { keep: 'me', n: 42 })
    assert.equal(readPocProviders(workspace).length, 1)
    assertNoTempFiles(workspace)
  } finally {
    workspace.dispose()
  }
})

/* ------------------------------------------------------------------------- */
/* Environment overrides                                                     */
/* ------------------------------------------------------------------------- */

test('env overrides win in views/effective config but are never written to disk', () => {
  const workspace = createTempWorkspace()
  try {
    const { service: fileService } = createService(workspace)
    addDeepseek(fileService, {
      model: 'deepseek-chat',
      apiKey: 'sk-file-secret-value',
      baseUrl: 'https://file.example/v1'
    })
    const providerId = fileService.view().activeProviderId
    assert.ok(providerId !== null)

    const env = {
      [POC_API_KEY_ENV]: 'env-api-key-value',
      [POC_BASE_URL_ENV]: 'https://env.example/v1',
      [POC_MODEL_ENV]: 'env-model'
    }
    const { service, logger } = createService(workspace, env)
    const view = service.view()
    for (const name of [POC_API_KEY_ENV, POC_BASE_URL_ENV, POC_MODEL_ENV]) {
      assert.ok(view.overriddenByEnv.includes(name), `${name} should be reported as overridden`)
    }
    assert.ok(!view.overriddenByEnv.includes(POC_CONFIG_ENV))
    const providerView = view.providers[0]
    assert.ok(providerView !== undefined)
    assert.equal(providerView.model, 'env-model')
    assert.equal(providerView.baseUrl, 'https://env.example/v1')
    assert.equal(providerView.configured, true)
    // Views never contain secrets — not even env-provided ones.
    const serialized = JSON.stringify(view)
    assert.ok(!serialized.includes('env-api-key-value'))
    assert.ok(!serialized.includes('sk-file-secret-value'))

    const active = service.getActiveProvider()
    assert.ok(active !== null)
    assert.equal(active.credentials.apiKey, 'env-api-key-value')
    assert.equal(active.model, 'env-model')
    assert.equal(active.baseUrl, 'https://env.example/v1')

    // Saving must not copy env values into config.json.
    service.save({ activeProviderId: providerId })
    const rawText = readFileSync(workspace.configPath, 'utf8')
    assert.ok(!rawText.includes('env-api-key-value'))
    assert.ok(!rawText.includes('env-model'))
    assert.ok(!rawText.includes('env.example'))
    const rawProvider = readPocProviders(workspace)[0]
    assert.equal(rawProvider?.model, 'deepseek-chat')
    assert.equal(rawProvider?.baseUrl, 'https://file.example/v1')
    assert.deepEqual(rawProvider?.credentials, { apiKey: 'sk-file-secret-value' })
    // No credential is ever logged.
    for (const name of ['env-api-key-value', 'sk-file-secret-value']) {
      assert.ok(!logger.text().includes(name), `log must not contain ${name}`)
    }
  } finally {
    workspace.dispose()
  }
})

test('CORTEX_POC_API_KEY satisfies provider creation without persisting the env value', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace, { [POC_API_KEY_ENV]: 'env-only-key-value' })
    const view = service.upsertProvider({ preset: 'deepseek', model: 'deepseek-chat' })
    const providerView = view.providers[0]
    assert.ok(providerView !== undefined)
    assert.equal(providerView.configured, true)
    assert.deepEqual(providerView.missingCredentials, [])
    const rawProvider = readPocProviders(workspace)[0]
    assert.deepEqual(rawProvider?.credentials, {})
    assert.ok(!readFileSync(workspace.configPath, 'utf8').includes('env-only-key-value'))
  } finally {
    workspace.dispose()
  }
})

test('CORTEX_POC_PROXY_URL enables a direct-file proxy override at runtime', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace, {
      [POC_PROXY_URL_ENV]: 'http://127.0.0.1:9090'
    })
    const view = service.view()
    assert.ok(view.overriddenByEnv.includes(POC_PROXY_URL_ENV))
    assert.equal(view.proxy.enabled, true)
    assert.equal(view.proxy.url, 'http://127.0.0.1:9090')
    const runtime = service.getProxyRuntime()
    assert.ok(runtime !== null)
    assert.equal(runtime.url, 'http://127.0.0.1:9090')
  } finally {
    workspace.dispose()
  }
})

/* ------------------------------------------------------------------------- */
/* Provider lifecycle                                                        */
/* ------------------------------------------------------------------------- */

test('provider add/update/delete and active switching', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)
    let view = addDeepseek(service, { model: 'deepseek-chat', apiKey: 'sk-first', setActive: true })
    const firstId = view.providers[0]?.id
    assert.ok(firstId !== undefined)
    assert.match(firstId, /^poc-[0-9a-f]{8}$/)
    assert.equal(view.activeProviderId, firstId)
    assert.equal(view.enabled, true)

    view = service.upsertProvider({
      preset: 'glm',
      model: 'glm-4',
      credentials: { apiKey: 'sk-glm' },
      setActive: true
    })
    const secondId = view.providers[1]?.id
    assert.ok(secondId !== undefined)
    assert.equal(view.activeProviderId, secondId)
    assert.equal(view.providers.length, 2)

    // Update model only: omitted credentials are kept.
    view = service.upsertProvider({
      id: firstId,
      preset: 'deepseek',
      model: 'deepseek-reasoner',
      setActive: true
    })
    assert.equal(view.activeProviderId, firstId)
    const active = service.getActiveProvider()
    assert.ok(active !== null)
    assert.equal(active.model, 'deepseek-reasoner')
    assert.equal(active.credentials.apiKey, 'sk-first')

    // Active switching via save() + rejection for unknown id.
    view = service.save({ activeProviderId: secondId })
    assert.equal(view.activeProviderId, secondId)
    const unknownActive = captureSyncThrow(() => service.save({ activeProviderId: 'ghost' }))
    expectPocError(unknownActive, POC_ERROR_CODES.INVALID_CONFIG)
    view = service.save({ activeProviderId: null })
    assert.equal(view.activeProviderId, null)
    assert.equal(service.getActiveProvider(), null)

    // Delete clears active when needed and is idempotently guarded.
    service.save({ activeProviderId: secondId })
    view = service.removeProvider(secondId)
    assert.equal(view.providers.length, 1)
    assert.equal(view.activeProviderId, null)
    const missing = captureSyncThrow(() => service.removeProvider(secondId))
    expectPocError(missing, POC_ERROR_CODES.PROVIDER_NOT_FOUND)

    view = service.removeProvider(firstId)
    assert.equal(view.providers.length, 0)
    assert.equal(view.enabled, false)
  } finally {
    workspace.dispose()
  }
})

test('provider creation requires a model, credentials and an explicit Base URL where needed', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)

    const noModel = captureSyncThrow(() =>
      service.upsertProvider({ preset: 'deepseek', model: '   ', credentials: { apiKey: 'k' } })
    )
    expectPocError(noModel, POC_ERROR_CODES.MODEL_REQUIRED)

    const noCredentials = captureSyncThrow(() =>
      service.upsertProvider({ preset: 'deepseek', model: 'deepseek-chat' })
    )
    expectPocError(noCredentials, POC_ERROR_CODES.INVALID_CONFIG, 'API Key')

    const customNoBaseUrl = captureSyncThrow(() =>
      service.upsertProvider({
        preset: 'custom',
        model: 'custom-model',
        credentials: { apiKey: 'k' }
      })
    )
    expectPocError(customNoBaseUrl, POC_ERROR_CODES.INVALID_CONFIG, 'Base URL')

    const customWithBaseUrl = service.upsertProvider({
      preset: 'custom',
      baseUrl: 'https://custom.example/v1',
      model: 'custom-model',
      credentials: { apiKey: 'k' }
    })
    assert.equal(customWithBaseUrl.providers[0]?.baseUrl, 'https://custom.example/v1')
    assert.equal(customWithBaseUrl.providers[0]?.modelDiscovery, 'manual')

    const invalidPreset = captureSyncThrow(() =>
      // Runtime validation must reject an unknown preset (renderer input).
      service.upsertProvider({
        preset: 'nope' as never,
        model: 'm',
        credentials: { apiKey: 'k' }
      })
    )
    expectPocError(invalidPreset, POC_ERROR_CODES.INVALID_CONFIG)

    const unknownCredentialField = captureSyncThrow(() =>
      service.upsertProvider({
        preset: 'deepseek',
        model: 'deepseek-chat',
        credentials: { apiKey: 'k', adminToken: 'nope' }
      })
    )
    expectPocError(unknownCredentialField, POC_ERROR_CODES.INVALID_CONFIG, '未知凭据字段')

    const unknownId = captureSyncThrow(() =>
      service.upsertProvider({
        id: 'poc-missing',
        preset: 'deepseek',
        model: 'deepseek-chat',
        credentials: { apiKey: 'k' }
      })
    )
    expectPocError(unknownId, POC_ERROR_CODES.PROVIDER_NOT_FOUND)
  } finally {
    workspace.dispose()
  }
})

test('a changed credential still requires a freshly selected model', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)
    const view = addDeepseek(service, { model: 'deepseek-chat', apiKey: 'sk-old-key' })
    const providerId = view.providers[0]?.id
    assert.ok(providerId !== undefined)

    const resetModel = captureSyncThrow(() =>
      service.upsertProvider({
        id: providerId,
        preset: 'deepseek',
        model: '',
        credentials: { apiKey: 'sk-new-key' }
      })
    )
    expectPocError(resetModel, POC_ERROR_CODES.MODEL_REQUIRED)

    service.upsertProvider({
      id: providerId,
      preset: 'deepseek',
      model: 'deepseek-chat',
      credentials: { apiKey: 'sk-new-key' }
    })
    const active = service.getActiveProvider()
    assert.ok(active !== null)
    assert.equal(active.credentials.apiKey, 'sk-new-key')
    // Old credential is replaced, not merged into a list.
    assert.deepEqual(readPocProviders(workspace)[0]?.credentials, { apiKey: 'sk-new-key' })
  } finally {
    workspace.dispose()
  }
})

/* ------------------------------------------------------------------------- */
/* Views never echo credentials                                              */
/* ------------------------------------------------------------------------- */

test('config view and proxy view never contain credential fields or values', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)
    addDeepseek(service, { apiKey: 'sk-view-secret-value-9e8d7c' })
    const view = service.save({
      proxy: {
        enabled: true,
        url: 'http://127.0.0.1:8080',
        username: 'proxy-user-secret',
        password: 'proxy-pass-secret',
        caPath: '/tmp/ca-secret.pem',
        allowInsecureTls: true
      }
    })
    const serialized = JSON.stringify(view)
    for (const secret of [
      'sk-view-secret-value-9e8d7c',
      'proxy-user-secret',
      'proxy-pass-secret',
      '/tmp/ca-secret.pem'
    ]) {
      assert.ok(!serialized.includes(secret), `view must not echo ${secret}`)
    }
    assert.deepEqual(Object.keys(view.proxy).sort(), [
      'allowInsecureTls',
      'caConfigured',
      'enabled',
      'url'
    ])
    assert.equal(view.proxy.enabled, true)
    assert.equal(view.proxy.caConfigured, true)
    assert.equal(view.proxy.allowInsecureTls, true)
    // Main-process-only runtime config does include them.
    const runtime = service.getProxyRuntime()
    assert.ok(runtime !== null)
    assert.equal(runtime.username, 'proxy-user-secret')
    assert.equal(runtime.password, 'proxy-pass-secret')
  } finally {
    workspace.dispose()
  }
})

/* ------------------------------------------------------------------------- */
/* Proxy / execution write semantics                                         */
/* ------------------------------------------------------------------------- */

test('proxy credentials are write-only and enabled-with-empty-url means direct', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)
    let view = service.save({
      proxy: { enabled: true, url: 'http://127.0.0.1:8080', username: 'u1', password: 'p1' }
    })
    assert.equal(view.proxy.enabled, true)
    let runtime = service.getProxyRuntime()
    assert.ok(runtime !== null)
    assert.equal(runtime.password, 'p1')

    // Omitted password/username are kept.
    view = service.save({ proxy: { enabled: true } })
    runtime = service.getProxyRuntime()
    assert.ok(runtime !== null)
    assert.equal(runtime.username, 'u1')
    assert.equal(runtime.password, 'p1')
    assert.equal(view.proxy.enabled, true)

    // clearPassword wins; username can be replaced.
    service.save({ proxy: { enabled: true, username: 'u2', clearPassword: true } })
    runtime = service.getProxyRuntime()
    assert.ok(runtime !== null)
    assert.equal(runtime.username, 'u2')
    assert.equal(runtime.password, '')

    // Disabled proxy => direct.
    view = service.save({ proxy: { enabled: false } })
    assert.equal(view.proxy.enabled, false)
    assert.equal(service.getProxyRuntime(), null)

    // Enabled but empty URL normalizes to direct instead of failing.
    view = service.save({ proxy: { enabled: true, url: '' } })
    assert.equal(view.proxy.enabled, false)
    assert.equal(service.getProxyRuntime(), null)

    // Non http(s) proxy URL is rejected when enabled.
    const badUrl = captureSyncThrow(() =>
      service.save({ proxy: { enabled: true, url: 'socks5://127.0.0.1:1080' } })
    )
    expectPocError(badUrl, POC_ERROR_CODES.INVALID_CONFIG)
  } finally {
    workspace.dispose()
  }
})

test('execution limits merge partially and stay validated', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)
    const view = service.save({ execution: { totalTimeoutMs: 5_000 } })
    assert.equal(view.limits.totalTimeoutMs, 5_000)
    assert.equal(view.limits.maxRequests, POC_LIMITS.maxRequests)
    assert.equal(service.getExecutionLimits().totalTimeoutMs, 5_000)

    const invalid = captureSyncThrow(() =>
      service.save({ execution: { totalTimeoutMs: 10 } })
    )
    expectPocError(invalid, POC_ERROR_CODES.INVALID_CONFIG)
  } finally {
    workspace.dispose()
  }
})

/* ------------------------------------------------------------------------- */
/* Invalid files                                                             */
/* ------------------------------------------------------------------------- */

test('invalid JSON blocks saving without clobbering the file', () => {
  const workspace = createTempWorkspace()
  try {
    writeFileSync(workspace.configPath, '{ definitely not json', 'utf8')
    const { service } = createService(workspace)
    const view = service.view()
    assert.equal(view.configFileExists, true)
    assert.equal(view.enabled, false)
    const error = captureSyncThrow(() => service.save({}))
    expectPocError(error, POC_ERROR_CODES.CONFIG_UNWRITABLE)
    assert.equal(readFileSync(workspace.configPath, 'utf8'), '{ definitely not json')
  } finally {
    workspace.dispose()
  }
})

test('unknown preset in the file is a config failure, not a silent vendor fallback', () => {
  const workspace = createTempWorkspace()
  try {
    writeFileSync(
      workspace.configPath,
      JSON.stringify({
        poc: {
          providers: [
            { id: 'poc-bad', preset: 'nope', baseUrl: 'https://x.example', model: 'm' }
          ]
        }
      }),
      'utf8'
    )
    const { service } = createService(workspace)
    assert.deepEqual(service.view().providers, [])
    const error = captureSyncThrow(() => service.save({}))
    expectPocError(error, POC_ERROR_CODES.CONFIG_UNWRITABLE)
  } finally {
    workspace.dispose()
  }
})

test('unknown activeProvider in the file clears to null; reload sees external edits', () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)
    addDeepseek(service)
    const document = readJsonFile(workspace.configPath)
    const poc = document.poc as Record<string, unknown>
    poc.activeProvider = 'ghost-provider'
    writeFileSync(workspace.configPath, JSON.stringify(document, null, 2), 'utf8')
    let view = service.reload()
    assert.equal(view.activeProviderId, null)

    // External add of a second provider is picked up by reload().
    const providers = poc.providers as Array<Record<string, unknown>>
    providers.push({
      id: 'poc-external',
      preset: 'glm',
      label: 'GLM',
      baseUrl: '',
      model: 'glm-4',
      credentials: { apiKey: 'sk-glm-external' },
      timeoutMs: 60_000,
      maxOutputTokens: 4_000
    })
    poc.activeProvider = 'poc-external'
    writeFileSync(workspace.configPath, JSON.stringify(document, null, 2), 'utf8')
    view = service.reload()
    assert.equal(view.providers.length, 2)
    assert.equal(view.activeProviderId, 'poc-external')
    const active = service.getActiveProvider()
    assert.ok(active !== null)
    // Preset default Base URL fills the empty file value.
    assert.equal(active.baseUrl, 'https://open.bigmodel.cn/api/paas/v4')
  } finally {
    workspace.dispose()
  }
})

/* ------------------------------------------------------------------------- */
/* Model discovery                                                           */
/* ------------------------------------------------------------------------- */

test('listModels returns deduped/sorted/capped API results without logging keys', async (t) => {
  const workspace = createTempWorkspace()
  t.after(() => workspace.dispose())
  const { service, logger } = createService(workspace)
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const data: Array<Record<string, unknown>> = []
  for (let index = 0; index < 510; index += 1) {
    data.push({ id: `model-${String(index).padStart(4, '0')}`, owned_by: 'vendor' })
  }
  data.push({ id: 'model-0001', owned_by: 'vendor' })
  let requestedUrl = ''
  let authorization = ''
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    authorization = headers.get('authorization') ?? ''
    return jsonResponse({ object: 'list', data })
  }) as typeof fetch

  const result = await service.listModels({
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    credentials: { apiKey: 'sk-discovery-key-value' }
  })
  assert.equal(result.source, 'api')
  assert.equal(result.warning, undefined)
  // Deduped (510 unique after removing the duplicate) and capped at 500.
  assert.equal(result.models.length, POC_LIMITS.maxModels)
  assert.equal(result.models[0]?.id, 'model-0000')
  assert.equal(result.models.at(-1)?.id, 'model-0499')
  const ids = result.models.map((model) => model.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual([...ids].sort((a, b) => a.localeCompare(b)), ids)
  assert.equal(requestedUrl, 'https://api.deepseek.com/v1/models')
  assert.equal(authorization, 'Bearer sk-discovery-key-value')
  assert.ok(!logger.text().includes('sk-discovery-key-value'))
})

test('listModels degrades to manual model entry for API failures/empty lists', async (t) => {
  const workspace = createTempWorkspace()
  t.after(() => workspace.dispose())
  const { service, logger } = createService(workspace)
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const input = {
    preset: 'deepseek' as const,
    baseUrl: 'https://api.deepseek.com/v1',
    credentials: { apiKey: 'sk-degrade-key-value' }
  }

  const serverError = createSequenceFetch([
    () => jsonResponse({ error: { message: 'upstream unavailable' } }, 503)
  ])
  globalThis.fetch = serverError.fetchImpl
  const degraded = await service.listModels(input)
  assert.equal(degraded.source, 'manual')
  assert.deepEqual(degraded.models, [])
  assert.ok((degraded.warning ?? '').length > 0)
  assert.match(degraded.warning ?? '', /503|暂时不可用/)

  const network = createSequenceFetch([
    () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND')
    }
  ])
  globalThis.fetch = network.fetchImpl
  const offline = await service.listModels(input)
  assert.equal(offline.source, 'manual')
  assert.match(offline.warning ?? '', /无法获取模型列表/)

  globalThis.fetch = createSequenceFetch([
    () => jsonResponse({ data: [] })
  ]).fetchImpl
  const empty = await service.listModels(input)
  assert.equal(empty.source, 'manual')
  assert.match(empty.warning ?? '', /为空|手动输入/)

  // Manual-discovery presets never hit the network.
  const manualFetch = createSequenceFetch([() => jsonResponse({ data: [{ id: 'x' }] })])
  globalThis.fetch = manualFetch.fetchImpl
  const manual = await service.listModels({
    preset: 'custom',
    baseUrl: 'https://custom.example/v1',
    credentials: { apiKey: 'sk-manual-key-value' }
  })
  assert.equal(manual.source, 'manual')
  assert.equal(manualFetch.calls.length, 0)

  assert.ok(!logger.text().includes('sk-degrade-key-value'))
  assert.ok(!logger.text().includes('sk-manual-key-value'))
})

test('listModels validates config and provider selection before any request', async () => {
  const workspace = createTempWorkspace()
  try {
    const { service } = createService(workspace)
    const missingCredentials = await captureRejection(
      service.listModels({ preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })
    )
    expectPocError(missingCredentials, POC_ERROR_CODES.INVALID_CONFIG)
    const missingBaseUrl = await captureRejection(
      service.listModels({ preset: 'custom', credentials: { apiKey: 'sk-key-value' } })
    )
    expectPocError(missingBaseUrl, POC_ERROR_CODES.INVALID_CONFIG, 'Base URL')
    const unknownPreset = await captureRejection(
      service.listModels({
        preset: 'nope' as never,
        credentials: { apiKey: 'sk-key-value' }
      })
    )
    expectPocError(unknownPreset, POC_ERROR_CODES.INVALID_CONFIG)
    const unknownProvider = await captureRejection(
      service.listModels({ providerId: 'poc-missing', preset: 'deepseek' })
    )
    expectPocError(unknownProvider, POC_ERROR_CODES.PROVIDER_NOT_FOUND)
  } finally {
    workspace.dispose()
  }
})

test('listModels with providerId uses the saved credentials and env overrides', async (t) => {
  const workspace = createTempWorkspace()
  t.after(() => workspace.dispose())
  const { service } = createService(workspace)
  const view = addDeepseek(service, { apiKey: 'sk-saved-provider-key' })
  const providerId = view.activeProviderId
  assert.ok(providerId !== null)
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const saved = createSequenceFetch([
    () => jsonResponse({ data: [{ id: 'deepseek-chat' }] })
  ])
  globalThis.fetch = saved.fetchImpl
  const result = await service.listModels({ providerId, preset: 'deepseek' })
  assert.equal(result.source, 'api')
  const headers = new Headers(saved.calls[0]?.init?.headers)
  assert.equal(headers.get('authorization'), 'Bearer sk-saved-provider-key')

  // Env override wins over the saved file credential for discovery too.
  const envService = createService(workspace, { [POC_API_KEY_ENV]: 'env-discovery-key' })
  const envFetch = createSequenceFetch([
    () => jsonResponse({ data: [{ id: 'deepseek-chat' }] })
  ])
  globalThis.fetch = envFetch.fetchImpl
  await envService.service.listModels({ providerId, preset: 'deepseek' })
  const envHeaders = new Headers(envFetch.calls[0]?.init?.headers)
  assert.equal(envHeaders.get('authorization'), 'Bearer env-discovery-key')
})

/* ------------------------------------------------------------------------- */
/* testProvider                                                              */
/* ------------------------------------------------------------------------- */

test('testProvider sends a minimal request and normalizes failures', async (t) => {
  const workspace = createTempWorkspace()
  t.after(() => workspace.dispose())
  const { service, logger } = createService(workspace)
  const view = addDeepseek(service, { apiKey: 'sk-test-provider-key-value' })
  const providerId = view.activeProviderId
  assert.ok(providerId !== null)
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const successFetch = createSequenceFetch([
    () =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'OK' } }]
      })
  ])
  globalThis.fetch = successFetch.fetchImpl
  const success = await service.testProvider(providerId)
  assert.equal(success.ok, true)
  assert.ok(success.latencyMs >= 0)
  assert.equal(success.error, undefined)
  const sentBody = JSON.parse(String(successFetch.calls[0]?.init?.body)) as Record<string, unknown>
  assert.equal(sentBody.model, 'deepseek-chat')
  assert.ok(Array.isArray(sentBody.messages))
  assert.ok(Number(sentBody.max_tokens) <= 16)

  globalThis.fetch = createSequenceFetch([
    () => jsonResponse({ error: { message: 'invalid key' } }, 401)
  ]).fetchImpl
  const unauthorized = await service.testProvider(providerId)
  assert.equal(unauthorized.ok, false)
  assert.match(unauthorized.error ?? '', /401/)

  const missing = await captureRejection(service.testProvider('poc-missing'))
  expectPocError(missing, POC_ERROR_CODES.PROVIDER_NOT_FOUND)
  assert.ok(!logger.text().includes('sk-test-provider-key-value'))
})

test('testProvider requires a selected model', async (t) => {
  const workspace = createTempWorkspace()
  t.after(() => workspace.dispose())
  const { service } = createService(workspace)
  const view = addDeepseek(service)
  const providerId = view.activeProviderId
  assert.ok(providerId !== null)
  // Simulate a saved provider whose model was never selected.
  const document = readJsonFile(workspace.configPath)
  const poc = document.poc as Record<string, unknown>
  const providers = poc.providers as Array<Record<string, unknown>>
  const first = providers[0]
  assert.ok(first !== undefined)
  first.model = ''
  writeFileSync(workspace.configPath, JSON.stringify(document, null, 2), 'utf8')
  service.reload()
  const error = await captureRejection(service.testProvider(providerId))
  expectPocError(error, POC_ERROR_CODES.MODEL_REQUIRED)
})

test('testProvider reports timeouts as a normalized error', async (t) => {
  const workspace = createTempWorkspace()
  t.after(() => workspace.dispose())
  const { service } = createService(workspace)
  const view = addDeepseek(service, { timeoutMs: 1_000 })
  const providerId = view.activeProviderId
  assert.ok(providerId !== null)
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })) as typeof fetch
  const result = await service.testProvider(providerId)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /超时/)
})

/* ------------------------------------------------------------------------- */
/* Logging redaction                                                         */
/* ------------------------------------------------------------------------- */

test('no provider credential or proxy password is ever logged during save/save cycles', () => {
  const workspace = createTempWorkspace()
  try {
    const { service, logger } = createService(workspace)
    addDeepseek(service, { apiKey: 'sk-log-secret-provider' })
    service.save({
      proxy: {
        enabled: true,
        url: 'http://127.0.0.1:8080',
        username: 'log-user-secret',
        password: 'log-pass-secret'
      },
      execution: { maxRequests: 10 }
    })
    const entries: CapturedLog[] = logger.entries
    assert.ok(entries.length > 0, 'config service should log at least one operation')
    const logged = logger.text()
    for (const secret of ['sk-log-secret-provider', 'log-user-secret', 'log-pass-secret']) {
      assert.ok(!logged.includes(secret), `logs must not contain ${secret}`)
    }
  } finally {
    workspace.dispose()
  }
})
