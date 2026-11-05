/**
 * Unified PoC configuration service (`dirname(activeDbPath)/config.json`).
 *
 * Design: docs/EXPLOIT_AS_CODE_POC_DESIGN.md §5.
 *
 * Responsibilities:
 * - read/write ONLY the `poc` namespace while preserving every other top-level
 *   key (config.json may be shared with other Cortex features) and unknown
 *   sibling objects inside `poc`;
 * - atomic writes (temp file + rename) and best-effort permission hardening
 *   (POSIX 0600 / Windows ACL) with a non-blocking `permissionWarning`;
 * - environment overrides (`CORTEX_POC_CONFIG`, `CORTEX_POC_API_KEY`,
 *   `CORTEX_POC_BASE_URL`, `CORTEX_POC_MODEL`, optional `CORTEX_POC_PROXY_URL`)
 *   that win over file values but are never written back to disk;
 * - write-only credential semantics: views never contain API keys / proxy
 *   passwords, and omitted values are kept instead of being erased;
 * - model discovery and connection testing.
 *
 * This module is Electron-free: it only depends on Node built-ins, the shared
 * schema module and the provider adapter layer, so the future `ctx web` server
 * can reuse it. Credentials never leave `getActiveProvider()` /
 * `getProxyRuntime()` (main-process-only methods).
 */
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ZodError } from 'zod'

import type { HubLogger } from '../core/logging'
import {
  dedupeModelOptions,
  describeFetchError,
  getProviderAdapter
} from '../core/poc/providers'
import type { ProviderAdapter, ProviderModelListRequest } from '../core/poc/providers'
import type { PocConfigService, PocProxyRuntimeConfig } from './services/pocContracts'
import type {
  ListPocModelsInput,
  ListPocModelsResult,
  PocConfigFilePoc,
  PocConfigView,
  PocExecutionLimits,
  PocPresetDefinition,
  PocPresetId,
  PocProviderConfig,
  PocProviderView,
  PocProxyConfig,
  PocProxyView,
  SavePocConfigInput,
  TestPocProviderResult,
  UpsertPocProviderInput
} from '../shared/poc'
import {
  POC_CREDENTIAL_FIELD_LABELS,
  POC_ERROR_CODES,
  POC_LIMITS,
  POC_PRESETS,
  PocConfigFilePocSchema,
  PocExecutionLimitsSchema,
  ListPocModelsInputSchema,
  SavePocConfigInputSchema,
  UpsertPocProviderInputSchema,
  createPocError,
  redactPocText
} from '../shared/poc'

/* ------------------------------------------------------------------------- */
/* Constants                                                                 */
/* ------------------------------------------------------------------------- */

/** Path to the shared config file (temporary/CI override, highest priority). */
export const POC_CONFIG_ENV = 'CORTEX_POC_CONFIG'
export const POC_API_KEY_ENV = 'CORTEX_POC_API_KEY'
export const POC_BASE_URL_ENV = 'CORTEX_POC_BASE_URL'
export const POC_MODEL_ENV = 'CORTEX_POC_MODEL'
export const POC_PROXY_URL_ENV = 'CORTEX_POC_PROXY_URL'

/**
 * Deterministic fallback used when the database is `:memory:` (no directory to
 * share). The config still has to live *somewhere* deterministic so repeated
 * services agree; a dedicated directory inside the OS temp dir is used and is
 * never mixed with the real `~/.cortex/config.json`.
 */
export const POC_MEMORY_DB_CONFIG_DIRECTORY = 'cortex-poc-memory'

const MODEL_DISCOVERY_TIMEOUT_MS = 20_000
const MAX_MODEL_LIST_BODY_CHARS = 8_000_000
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

const MISSING_FILE_WARNING =
  '配置文件尚未创建：保存后 AI API Key 与代理密码会以明文写入 config.json，请确认数据目录仅当前用户可读。'
const PERMISSION_WARNING =
  '配置文件以明文保存 AI API Key / 代理密码，但当前系统无法收紧其文件权限（其他用户可能读取）。建议改用 CORTEX_POC_API_KEY 环境变量覆盖，或手动将文件权限限制为仅当前用户。'

/* ------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  )
}

function describeFsError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message
  }
  return String(error)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function formatZodIssues(error: ZodError): string {
  const limit = 6
  const issues = error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join('.')
    return `${path.length > 0 ? path : '(root)'}: ${issue.message}`
  })
  const suffix = error.issues.length > limit ? `；另有 ${error.issues.length - limit} 项` : ''
  return `${issues.join('；')}${suffix}`
}

function createDefaultPoc(): PocConfigFilePoc {
  return PocConfigFilePocSchema.parse({})
}

function requirePresetDefinition(preset: PocPresetId): PocPresetDefinition {
  const definition = (POC_PRESETS as Record<string, PocPresetDefinition | undefined>)[preset]
  if (definition === undefined) {
    throw createPocError(
      POC_ERROR_CODES.INVALID_CONFIG,
      `未知的 AI 提供商标识：${String(preset)}`
    )
  }
  return definition
}

/**
 * Absolute config path: env override first, then `dirname(data.db)/config.json`.
 * A `:memory:` database has no directory, so a deterministic OS-temp fallback is
 * used (see `POC_MEMORY_DB_CONFIG_DIRECTORY`).
 */
export function resolvePocConfigPath(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = readEnvValue(env, POC_CONFIG_ENV)
  if (override !== undefined) return resolve(override)
  if (dbPath === ':memory:') {
    return join(tmpdir(), POC_MEMORY_DB_CONFIG_DIRECTORY, 'config.json')
  }
  return join(dirname(resolve(dbPath)), 'config.json')
}

/* ------------------------------------------------------------------------- */
/* Loaded state                                                              */
/* ------------------------------------------------------------------------- */

interface LoadedConfig {
  status: 'ok' | 'missing' | 'invalid'
  /** Validation/IO error reason when `status === 'invalid'` (never secrets). */
  error: string | null
  /** Full parsed top-level JSON object; only written back when `status === 'ok'`. */
  document: Record<string, unknown>
  /** Original `poc` object, so unknown sibling keys survive an update. */
  rawPoc: Record<string, unknown>
  poc: PocConfigFilePoc
  permissionWarning: string | null
}

interface EffectivePoc {
  poc: PocConfigFilePoc
  overriddenByEnv: string[]
}

interface ReadForWriteResult {
  document: Record<string, unknown>
  rawPoc: Record<string, unknown>
  poc: PocConfigFilePoc
}

/* ------------------------------------------------------------------------- */
/* Service                                                                   */
/* ------------------------------------------------------------------------- */

class PocConfigServiceImpl implements PocConfigService {
  readonly configPath: string
  private readonly env: NodeJS.ProcessEnv
  private readonly logger: HubLogger
  private loaded: LoadedConfig
  private tmpCounter = 0

  constructor(options: { dbPath: string; env?: NodeJS.ProcessEnv; logger: HubLogger }) {
    this.env = options.env ?? process.env
    this.logger = options.logger
    this.configPath = resolvePocConfigPath(options.dbPath, this.env)
    this.loaded = this.loadFromDisk()
  }

  /* ------------------------------- views ------------------------------- */

  view(): PocConfigView {
    return this.buildView()
  }

  reload(): PocConfigView {
    this.loaded = this.loadFromDisk()
    this.logger.info('PoC 配置已重新加载', {
      path: this.configPath,
      providers: this.loaded.poc.providers.length,
      status: this.loaded.status
    })
    return this.buildView()
  }

  /* ---------------------------- save / mutate -------------------------- */

  save(rawInput: SavePocConfigInput): PocConfigView {
    const parsed = SavePocConfigInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw createPocError(
        POC_ERROR_CODES.INVALID_CONFIG,
        `配置校验失败：${formatZodIssues(parsed.error)}`
      )
    }
    const input = parsed.data
    this.writePoc((poc) => {
      if (input.activeProviderId !== undefined) {
        if (input.activeProviderId === null) {
          poc.activeProvider = ''
        } else {
          const activeId = input.activeProviderId.trim()
          if (!poc.providers.some((provider) => provider.id === activeId)) {
            throw createPocError(
              POC_ERROR_CODES.INVALID_CONFIG,
              `activeProviderId 指向不存在的 provider：${activeId}`
            )
          }
          poc.activeProvider = activeId
        }
      }
      if (input.proxy !== undefined) this.applyProxyUpdate(poc, input.proxy)
      if (input.execution !== undefined) {
        const merged = { ...poc.execution, ...input.execution }
        const validated = PocExecutionLimitsSchema.safeParse(merged)
        if (!validated.success) {
          throw createPocError(
            POC_ERROR_CODES.INVALID_CONFIG,
            `执行限制无效：${formatZodIssues(validated.error)}`
          )
        }
        poc.execution = validated.data
      }
    })
    return this.buildView()
  }

  upsertProvider(rawInput: UpsertPocProviderInput): PocConfigView {
    // Checked before Zod so the UI gets the dedicated, actionable code.
    if ((rawInput.model ?? '').trim().length === 0) {
      throw createPocError(
        POC_ERROR_CODES.MODEL_REQUIRED,
        '请先查询并选择模型，或手动输入模型 ID'
      )
    }
    const parsed = UpsertPocProviderInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw createPocError(
        POC_ERROR_CODES.INVALID_CONFIG,
        `提供商配置校验失败：${formatZodIssues(parsed.error)}`
      )
    }
    const input = parsed.data
    const preset = requirePresetDefinition(input.preset)
    const model = input.model.trim()
    const envApiKey = readEnvValue(this.env, POC_API_KEY_ENV)

    this.writePoc((poc) => {
      const existingIndex =
        input.id !== undefined
          ? poc.providers.findIndex((provider) => provider.id === input.id)
          : -1
      if (input.id !== undefined && existingIndex < 0) {
        throw createPocError(
          POC_ERROR_CODES.PROVIDER_NOT_FOUND,
          `未找到 AI 提供商：${input.id}`
        )
      }
      const existing = existingIndex >= 0 ? poc.providers[existingIndex] : undefined

      // Base URL: explicit input > existing (same preset) > preset default.
      let baseUrl: string
      if (input.baseUrl !== undefined) {
        baseUrl = input.baseUrl.trim() || preset.defaultBaseUrl.trim()
      } else if (existing !== undefined && existing.preset === input.preset) {
        baseUrl = existing.baseUrl.trim() || preset.defaultBaseUrl.trim()
      } else {
        baseUrl = preset.defaultBaseUrl.trim()
      }
      if (baseUrl.length === 0) {
        throw createPocError(
          POC_ERROR_CODES.INVALID_CONFIG,
          `preset ${input.preset} 没有默认 Base URL，请手动填写 http(s) Base URL`
        )
      }
      if (!isHttpUrl(baseUrl)) {
        throw createPocError(POC_ERROR_CODES.INVALID_CONFIG, 'Base URL 必须是 http(s) 地址')
      }

      // Credentials: write-only merge. Omitted values are kept; empty strings
      // explicitly clear a field. Env-provided values are never persisted.
      const credentials: Record<string, string> = { ...(existing?.credentials ?? {}) }
      if (input.credentials !== undefined) {
        for (const [field, value] of Object.entries(input.credentials)) {
          credentials[field] = value
        }
      }
      const missingCredentialLabels: string[] = []
      for (const field of preset.credentialFields) {
        if ((credentials[field] ?? '').trim().length > 0) continue
        if (field === 'apiKey' && envApiKey !== undefined) continue
        missingCredentialLabels.push(POC_CREDENTIAL_FIELD_LABELS[field])
      }
      if (missingCredentialLabels.length > 0) {
        throw createPocError(
          POC_ERROR_CODES.INVALID_CONFIG,
          `缺少 AI 提供商凭据：${missingCredentialLabels.join('、')}，请先填写`
        )
      }

      let label: string
      if (input.label !== undefined && input.label.trim().length > 0) {
        label = input.label.trim()
      } else if (
        existing !== undefined &&
        existing.preset === input.preset &&
        existing.label.trim().length > 0
      ) {
        label = existing.label.trim()
      } else {
        label = preset.label
      }

      const nextProvider: PocProviderConfig = {
        id: existing?.id ?? this.generateProviderId(poc),
        preset: input.preset,
        label,
        baseUrl,
        model,
        credentials,
        timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        maxOutputTokens:
          input.maxOutputTokens ?? existing?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
      }
      const apiVersion =
        input.apiVersion !== undefined
          ? input.apiVersion.trim()
          : existing !== undefined && existing.preset === input.preset
            ? existing.apiVersion?.trim()
            : preset.apiVersion?.trim()
      if (apiVersion !== undefined && apiVersion.length > 0) {
        nextProvider.apiVersion = apiVersion
      }

      if (existingIndex >= 0) poc.providers[existingIndex] = nextProvider
      else poc.providers.push(nextProvider)
      if (input.setActive === true) poc.activeProvider = nextProvider.id
    })
    return this.buildView()
  }

  removeProvider(id: string): PocConfigView {
    const providerId = typeof id === 'string' ? id.trim() : ''
    if (providerId.length === 0) {
      throw createPocError(POC_ERROR_CODES.PROVIDER_NOT_FOUND, '未指定 AI 提供商 id')
    }
    this.writePoc((poc) => {
      const index = poc.providers.findIndex((provider) => provider.id === providerId)
      if (index < 0) {
        throw createPocError(
          POC_ERROR_CODES.PROVIDER_NOT_FOUND,
          `未找到 AI 提供商：${providerId}`
        )
      }
      poc.providers.splice(index, 1)
      if (poc.activeProvider === providerId) poc.activeProvider = ''
    })
    return this.buildView()
  }

  /* ----------------------------- main-only ----------------------------- */

  getActiveProvider(): PocProviderConfig | null {
    const effective = this.effectivePoc()
    const activeId = effective.poc.activeProvider.trim()
    if (activeId.length === 0) return null
    const provider = effective.poc.providers.find((entry) => entry.id === activeId)
    if (provider === undefined) return null
    return this.normalizeProviderForRuntime(provider)
  }

  getProxyRuntime(): PocProxyRuntimeConfig | null {
    const proxy = this.effectivePoc().poc.proxy
    const url = proxy.url.trim()
    if (!proxy.enabled || url.length === 0) return null
    if (!isHttpUrl(url)) {
      this.logger.warn('PoC 复测代理 URL 无效，已按直连处理', {
        path: this.configPath
      })
      return null
    }
    return {
      enabled: true,
      url,
      username: proxy.username,
      password: proxy.password,
      caPath: proxy.caPath.trim(),
      allowInsecureTls: proxy.allowInsecureTls
    }
  }

  getExecutionLimits(): PocExecutionLimits {
    return { ...this.loaded.poc.execution }
  }

  /* -------------------------- model discovery -------------------------- */

  async listModels(rawInput: ListPocModelsInput): Promise<ListPocModelsResult> {
    const parsed = ListPocModelsInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw createPocError(
        POC_ERROR_CODES.INVALID_CONFIG,
        `查询模型参数无效：${formatZodIssues(parsed.error)}`
      )
    }
    const input = parsed.data
    const preset = requirePresetDefinition(input.preset)
    const adapter = getProviderAdapter(input.preset)
    const effective = this.effectivePoc()
    const envApiKey = readEnvValue(this.env, POC_API_KEY_ENV)
    const envBaseUrl = readEnvValue(this.env, POC_BASE_URL_ENV)

    let baseUrl: string
    let credentials: Record<string, string>
    if (input.providerId !== undefined) {
      const saved = effective.poc.providers.find(
        (provider) => provider.id === input.providerId
      )
      if (saved === undefined) {
        throw createPocError(
          POC_ERROR_CODES.PROVIDER_NOT_FOUND,
          `未找到 AI 提供商：${input.providerId}`
        )
      }
      if (saved.preset !== input.preset) {
        throw createPocError(
          POC_ERROR_CODES.INVALID_CONFIG,
          'provider 的 preset 与查询请求不一致'
        )
      }
      credentials = { ...saved.credentials }
      baseUrl = saved.baseUrl.trim() || preset.defaultBaseUrl.trim()
    } else {
      credentials = { ...(input.credentials ?? {}) }
      baseUrl = (input.baseUrl?.trim() ?? '') || preset.defaultBaseUrl.trim()
    }
    // Env overrides are highest priority but are never written to disk.
    if (envApiKey !== undefined) credentials.apiKey = envApiKey
    if (envBaseUrl !== undefined) baseUrl = envBaseUrl
    baseUrl = baseUrl.trim()

    const missingCredentials = preset.credentialFields.filter(
      (field) => (credentials[field] ?? '').trim().length === 0
    )
    if (missingCredentials.length > 0) {
      throw createPocError(
        POC_ERROR_CODES.INVALID_CONFIG,
        `请先填写 ${missingCredentials
          .map((field) => POC_CREDENTIAL_FIELD_LABELS[field])
          .join('、')} 后再查询模型`
      )
    }
    if (baseUrl.length === 0) {
      throw createPocError(
        POC_ERROR_CODES.INVALID_CONFIG,
        `preset ${input.preset} 没有默认 Base URL，请先填写 Base URL 再查询模型`
      )
    }
    if (!isHttpUrl(baseUrl)) {
      throw createPocError(POC_ERROR_CODES.INVALID_CONFIG, 'Base URL 必须是 http(s) 地址')
    }

    const draftProvider: PocProviderConfig = {
      id: input.providerId ?? 'draft',
      preset: input.preset,
      label: preset.label,
      baseUrl,
      model: '',
      credentials,
      timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS
    }
    const request = adapter.listModelsRequest(draftProvider)
    if (request === null) {
      return {
        models: [],
        source: 'manual',
        warning: `${preset.label} 暂不支持自动查询模型列表，请手动输入模型 ID`
      }
    }
    return this.fetchModelList(adapter, request, credentials)
  }

  private async fetchModelList(
    adapter: ProviderAdapter,
    request: ProviderModelListRequest,
    credentials: Record<string, string>
  ): Promise<ListPocModelsResult> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, MODEL_DISCOVERY_TIMEOUT_MS)
    try {
      // Direct connection: model discovery NEVER uses the retest proxy, so API
      // keys and model traffic cannot be captured by Burp/Yakit by accident.
      const response = await fetch(request.url, {
        method: 'GET',
        headers: request.headers,
        signal: controller.signal
      })
      const bodyText = await response.text()
      if (!response.ok) {
        const warning = this.scrubSecrets(
          adapter.normalizeError(response.status, bodyText),
          credentials
        )
        this.logger.warn('PoC 模型发现请求失败（已降级为手动输入）', {
          status: response.status
        })
        return { models: [], source: 'manual', warning: `${warning}；也可手动输入模型 ID` }
      }
      if (bodyText.length > MAX_MODEL_LIST_BODY_CHARS) {
        return {
          models: [],
          source: 'manual',
          warning: '模型列表响应过大，已忽略；请手动输入模型 ID'
        }
      }
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(bodyText)
      } catch {
        return {
          models: [],
          source: 'manual',
          warning: '模型列表响应不是合法 JSON，请手动输入模型 ID'
        }
      }
      const models = dedupeModelOptions(adapter.parseModelList(parsedJson)).slice(
        0,
        POC_LIMITS.maxModels
      )
      if (models.length === 0) {
        return {
          models: [],
          source: 'manual',
          warning: '模型列表为空或接口不支持，请手动输入模型 ID'
        }
      }
      return { models, source: 'api' }
    } catch (error) {
      const reason = timedOut
        ? `请求超时（${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s）`
        : describeFetchError(error)
      const warning = this.scrubSecrets(`无法获取模型列表：${reason}`, credentials)
      this.logger.warn('PoC 模型发现请求异常（已降级为手动输入）', { reason: warning })
      return { models: [], source: 'manual', warning: `${warning}；请检查网络后重试或手动输入模型 ID` }
    } finally {
      clearTimeout(timer)
    }
  }

  async testProvider(id: string): Promise<TestPocProviderResult> {
    const providerId = typeof id === 'string' ? id.trim() : ''
    if (providerId.length === 0) {
      throw createPocError(POC_ERROR_CODES.PROVIDER_NOT_FOUND, '未指定 AI 提供商 id')
    }
    const effective = this.effectivePoc()
    const saved = effective.poc.providers.find((provider) => provider.id === providerId)
    if (saved === undefined) {
      throw createPocError(
        POC_ERROR_CODES.PROVIDER_NOT_FOUND,
        `未找到 AI 提供商：${providerId}`
      )
    }
    const provider = this.normalizeProviderForRuntime(saved)
    if (provider.model.trim().length === 0) {
      throw createPocError(POC_ERROR_CODES.MODEL_REQUIRED, '请先选择模型后再测试连接')
    }
    const adapter = getProviderAdapter(provider.preset)
    const request = adapter.buildChatRequest(
      provider,
      [{ role: 'user', content: 'Reply with OK' }],
      { maxTokens: Math.min(16, provider.maxOutputTokens), temperature: 0 }
    )
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, provider.timeoutMs)
    const startedAt = Date.now()
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal
      })
      const bodyText = await response.text()
      const latencyMs = Date.now() - startedAt
      if (!response.ok) {
        const error = this.scrubSecrets(
          adapter.normalizeError(response.status, bodyText),
          provider.credentials
        )
        this.logger.warn('PoC 提供商连接测试失败', {
          preset: provider.preset,
          status: response.status
        })
        return { ok: false, latencyMs, error }
      }
      this.logger.info('PoC 提供商连接测试成功', {
        preset: provider.preset,
        model: provider.model,
        latencyMs
      })
      return { ok: true, latencyMs }
    } catch (error) {
      const latencyMs = Date.now() - startedAt
      const reason = timedOut
        ? `连接测试超时（${provider.timeoutMs}ms）`
        : describeFetchError(error)
      this.logger.warn('PoC 提供商连接测试异常', {
        preset: provider.preset,
        reason: timedOut ? 'timeout' : 'network'
      })
      return {
        ok: false,
        latencyMs,
        error: this.scrubSecrets(`连接测试失败：${reason}`, provider.credentials)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /* ------------------------------ internals ---------------------------- */

  private loadFromDisk(): LoadedConfig {
    if (!existsSync(this.configPath)) {
      return {
        status: 'missing',
        error: null,
        document: {},
        rawPoc: {},
        poc: createDefaultPoc(),
        permissionWarning: MISSING_FILE_WARNING
      }
    }
    const permissionWarning = this.auditPermissions()
    let rawText: string
    try {
      rawText = readFileSync(this.configPath, 'utf8')
    } catch (error) {
      const reason = describeFsError(error)
      this.logger.warn('PoC 配置文件读取失败，按默认配置运行', {
        path: this.configPath,
        reason
      })
      return {
        status: 'invalid',
        error: reason,
        document: {},
        rawPoc: {},
        poc: createDefaultPoc(),
        permissionWarning:
          `无法读取配置文件（${reason}），其他用户是否可读无法确认；API Key 以明文保存时请注意文件权限。`
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch {
      this.logger.error('PoC 配置文件不是合法 JSON，保存操作将被拒绝（不覆盖未知数据）', {
        path: this.configPath
      })
      return {
        status: 'invalid',
        error: 'invalid-json',
        document: {},
        rawPoc: {},
        poc: createDefaultPoc(),
        permissionWarning
      }
    }
    if (!isPlainObject(parsed)) {
      this.logger.error('PoC 配置根节点不是对象，保存操作将被拒绝', {
        path: this.configPath
      })
      return {
        status: 'invalid',
        error: 'root-not-object',
        document: {},
        rawPoc: {},
        poc: createDefaultPoc(),
        permissionWarning
      }
    }
    const rawPoc = isPlainObject(parsed.poc) ? parsed.poc : {}
    const validated = PocConfigFilePocSchema.safeParse(rawPoc)
    if (!validated.success) {
      const issues = formatZodIssues(validated.error)
      this.logger.error('PoC 配置校验失败，保存操作将被拒绝', {
        path: this.configPath,
        issues
      })
      return {
        status: 'invalid',
        error: `invalid-poc: ${issues}`,
        document: parsed,
        rawPoc,
        poc: createDefaultPoc(),
        permissionWarning
      }
    }
    const poc = validated.data
    const seenIds = new Set<string>()
    for (const provider of poc.providers) {
      if (seenIds.has(provider.id)) {
        this.logger.error('PoC 配置存在重复的 provider id，保存操作将被拒绝', {
          path: this.configPath,
          providerId: provider.id
        })
        return {
          status: 'invalid',
          error: `duplicate-provider-id: ${provider.id}`,
          document: parsed,
          rawPoc,
          poc: createDefaultPoc(),
          permissionWarning
        }
      }
      seenIds.add(provider.id)
    }
    if (poc.activeProvider.length > 0 && !seenIds.has(poc.activeProvider)) {
      this.logger.warn('PoC 配置 activeProvider 指向不存在的 provider，已按未激活处理', {
        path: this.configPath
      })
      poc.activeProvider = ''
    }
    return {
      status: 'ok',
      error: null,
      document: parsed,
      rawPoc,
      poc,
      permissionWarning
    }
  }

  private readForWrite(): ReadForWriteResult {
    let rawText: string
    try {
      rawText = readFileSync(this.configPath, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { document: {}, rawPoc: {}, poc: createDefaultPoc() }
      }
      throw createPocError(
        POC_ERROR_CODES.CONFIG_UNWRITABLE,
        `无法读取配置文件，已拒绝覆盖：${describeFsError(error)}`
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch {
      throw createPocError(
        POC_ERROR_CODES.CONFIG_UNWRITABLE,
        '配置文件不是合法 JSON，已拒绝覆盖；请手动修复 config.json 后重试'
      )
    }
    if (!isPlainObject(parsed)) {
      throw createPocError(
        POC_ERROR_CODES.CONFIG_UNWRITABLE,
        '配置文件根节点不是对象，已拒绝覆盖；请手动修复 config.json 后重试'
      )
    }
    const rawPoc = isPlainObject(parsed.poc) ? parsed.poc : {}
    const validated = PocConfigFilePocSchema.safeParse(rawPoc)
    if (!validated.success) {
      throw createPocError(
        POC_ERROR_CODES.CONFIG_UNWRITABLE,
        `poc 配置校验失败，已拒绝覆盖：${formatZodIssues(validated.error)}`
      )
    }
    const poc = validated.data
    const seenIds = new Set<string>()
    for (const provider of poc.providers) {
      if (seenIds.has(provider.id)) {
        throw createPocError(
          POC_ERROR_CODES.CONFIG_UNWRITABLE,
          `poc 配置存在重复的 provider id（${provider.id}），已拒绝覆盖`
        )
      }
      seenIds.add(provider.id)
    }
    if (poc.activeProvider.length > 0 && !seenIds.has(poc.activeProvider)) {
      this.logger.warn('PoC 配置 activeProvider 指向不存在的 provider，已清理', {
        path: this.configPath
      })
      poc.activeProvider = ''
    }
    return { document: parsed, rawPoc, poc }
  }

  /**
   * Apply a mutation on a fresh copy of the on-disk config, validate it, write
   * it atomically and only then update the in-memory cache.
   *
   * Unknown top-level keys and unknown `poc` sibling keys are always preserved;
   * a concurrently edited file is merged from disk (last write wins for our
   * fields only).
   */
  private writePoc(mutate: (poc: PocConfigFilePoc) => void): void {
    const base = this.readForWrite()
    const poc: PocConfigFilePoc = {
      ...base.poc,
      providers: base.poc.providers.map((provider) => ({
        ...provider,
        credentials: { ...provider.credentials }
      })),
      proxy: { ...base.poc.proxy },
      execution: { ...base.poc.execution }
    }
    mutate(poc)
    this.assertPocForWrite(poc)
    const nextRawPoc: Record<string, unknown> = {
      ...base.rawPoc,
      activeProvider: poc.activeProvider,
      providers: poc.providers,
      proxy: poc.proxy,
      execution: poc.execution
    }
    const document: Record<string, unknown> = { ...base.document, poc: nextRawPoc }
    this.atomicWrite(document)
    this.loaded = {
      status: 'ok',
      error: null,
      document,
      rawPoc: nextRawPoc,
      poc,
      permissionWarning: this.auditPermissions()
    }
    this.logger.info('PoC 配置已保存', {
      path: this.configPath,
      providers: poc.providers.length,
      activeProvider: poc.activeProvider
    })
  }

  private assertPocForWrite(poc: PocConfigFilePoc): void {
    const ids = new Set<string>()
    for (const provider of poc.providers) {
      if (ids.has(provider.id)) {
        throw createPocError(
          POC_ERROR_CODES.INVALID_CONFIG,
          `provider id 重复：${provider.id}`
        )
      }
      ids.add(provider.id)
    }
    if (poc.activeProvider.length > 0 && !ids.has(poc.activeProvider)) {
      throw createPocError(
        POC_ERROR_CODES.INVALID_CONFIG,
        `activeProvider 指向不存在的 provider：${poc.activeProvider}`
      )
    }
  }

  private applyProxyUpdate(
    poc: PocConfigFilePoc,
    update: NonNullable<SavePocConfigInput['proxy']>
  ): void {
    const proxy: PocProxyConfig = { ...poc.proxy }
    proxy.enabled = update.enabled
    if (update.url !== undefined) proxy.url = update.url.trim()
    // Write-only password: provided = replace; clearPassword = clear; omitted = keep.
    if (update.clearPassword === true) proxy.password = ''
    else if (update.password !== undefined) proxy.password = update.password
    if (update.username !== undefined) proxy.username = update.username
    if (update.caPath !== undefined) proxy.caPath = update.caPath.trim()
    if (update.allowInsecureTls !== undefined) {
      proxy.allowInsecureTls = update.allowInsecureTls
    }
    if (proxy.url.trim().length === 0) {
      // "enabled with empty URL" means direct connection.
      proxy.enabled = false
    } else if (proxy.enabled && !isHttpUrl(proxy.url.trim())) {
      throw createPocError(POC_ERROR_CODES.INVALID_CONFIG, '代理 URL 必须是 http(s) 地址')
    }
    poc.proxy = proxy
  }

  private atomicWrite(document: Record<string, unknown>): void {
    const directory = dirname(this.configPath)
    const payload = `${JSON.stringify(document, null, 2)}\n`
    let tempPath = ''
    try {
      mkdirSync(directory, { recursive: true })
      if (process.platform !== 'win32') {
        try {
          chmodSync(directory, 0o700)
        } catch {
          // Best effort only; the permission audit below reports the state.
        }
      }
      this.tmpCounter += 1
      tempPath = `${this.configPath}.tmp-${process.pid}-${this.tmpCounter}`
      writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 })
      renameSync(tempPath, this.configPath)
    } catch (error) {
      if (tempPath.length > 0) {
        try {
          rmSync(tempPath, { force: true })
        } catch {
          // Leftover temp files are harmless; never mask the original error.
        }
      }
      throw createPocError(
        POC_ERROR_CODES.CONFIG_UNWRITABLE,
        `无法写入配置文件：${describeFsError(error)}`
      )
    }
  }

  /**
   * Best-effort permission tightening. Mirrors `core/paths.ts`
   * `hardenDatabasePermissions`: failure must never block startup or saving.
   * Returns a non-blocking banner string when the plaintext file cannot be
   * protected (or does not exist yet).
   */
  private auditPermissions(): string | null {
    if (!existsSync(this.configPath)) return MISSING_FILE_WARNING
    try {
      if (process.platform === 'win32') return this.hardenWindowsAcl()
      chmodSync(this.configPath, 0o600)
      const mode = statSync(this.configPath).mode & 0o777
      if ((mode & 0o077) !== 0) return PERMISSION_WARNING
      return null
    } catch (error) {
      this.logger.warn('PoC 配置文件权限收紧失败（不阻塞启动）', {
        path: this.configPath,
        reason: describeFsError(error)
      })
      return PERMISSION_WARNING
    }
  }

  private hardenWindowsAcl(): string | null {
    let account: string
    try {
      account = userInfo().username
    } catch {
      account = process.env['USERNAME'] ?? ''
    }
    if (account.length === 0) return PERMISSION_WARNING
    try {
      // Remove inherited ACEs and grant the current user full control, exactly
      // like the database hardening helper.
      const result = spawnSync(
        'icacls',
        [this.configPath, '/inheritance:r', '/grant:r', `${account}:F`],
        { windowsHide: true, stdio: 'ignore', timeout: 5_000 }
      )
      if (result.error !== undefined || result.status !== 0) {
        this.logger.warn('PoC 配置文件 Windows ACL 收紧失败（不阻塞启动）', {
          path: this.configPath,
          exitCode: result.status ?? null
        })
        return PERMISSION_WARNING
      }
      return null
    } catch (error) {
      this.logger.warn('PoC 配置文件 Windows ACL 收紧异常（不阻塞启动）', {
        path: this.configPath,
        reason: describeFsError(error)
      })
      return PERMISSION_WARNING
    }
  }

  private effectivePoc(): EffectivePoc {
    const env = this.env
    const overriddenByEnv: string[] = []
    const configOverride = readEnvValue(env, POC_CONFIG_ENV)
    const apiKeyOverride = readEnvValue(env, POC_API_KEY_ENV)
    const baseUrlOverride = readEnvValue(env, POC_BASE_URL_ENV)
    const modelOverride = readEnvValue(env, POC_MODEL_ENV)
    const proxyUrlOverride = readEnvValue(env, POC_PROXY_URL_ENV)
    if (configOverride !== undefined) overriddenByEnv.push(POC_CONFIG_ENV)
    if (apiKeyOverride !== undefined) overriddenByEnv.push(POC_API_KEY_ENV)
    if (baseUrlOverride !== undefined) overriddenByEnv.push(POC_BASE_URL_ENV)
    if (modelOverride !== undefined) overriddenByEnv.push(POC_MODEL_ENV)
    if (proxyUrlOverride !== undefined) overriddenByEnv.push(POC_PROXY_URL_ENV)

    const providers = this.loaded.poc.providers.map((provider) => {
      const credentials = { ...provider.credentials }
      if (apiKeyOverride !== undefined) credentials.apiKey = apiKeyOverride
      const baseUrl = baseUrlOverride ?? provider.baseUrl
      const model = modelOverride ?? provider.model
      return { ...provider, credentials, baseUrl, model }
    })
    const proxy =
      proxyUrlOverride !== undefined
        ? { ...this.loaded.poc.proxy, enabled: true, url: proxyUrlOverride }
        : this.loaded.poc.proxy
    return {
      poc: { ...this.loaded.poc, providers, proxy },
      overriddenByEnv
    }
  }

  private buildView(): PocConfigView {
    const effective = this.effectivePoc()
    const providers = effective.poc.providers.map((provider) =>
      this.buildProviderView(provider)
    )
    const activeId = effective.poc.activeProvider.trim()
    const activeProviderId =
      activeId.length > 0 && providers.some((provider) => provider.id === activeId)
        ? activeId
        : null
    return {
      path: this.configPath,
      configFileExists: this.loaded.status !== 'missing',
      enabled: providers.some((provider) => provider.configured),
      // Desktop main is responsible for actual sandbox availability; the config
      // service always reports the feature as executable -> UI decides.
      executionEnabled: true,
      activeProviderId,
      providers,
      proxy: this.buildProxyView(effective.poc.proxy),
      limits: { ...effective.poc.execution },
      overriddenByEnv: effective.overriddenByEnv,
      permissionWarning: this.loaded.permissionWarning
    }
  }

  private buildProviderView(provider: PocProviderConfig): PocProviderView {
    const preset = requirePresetDefinition(provider.preset)
    const credentials = provider.credentials
    const missingCredentials = preset.credentialFields.filter(
      (field) => (credentials[field] ?? '').trim().length === 0
    )
    const model = provider.model.trim()
    const baseUrl =
      provider.baseUrl.trim().length > 0
        ? provider.baseUrl.trim()
        : preset.defaultBaseUrl.trim()
    return {
      id: provider.id,
      preset: provider.preset,
      label: provider.label.trim().length > 0 ? provider.label.trim() : preset.label,
      baseUrl,
      model,
      modelDiscovery: preset.modelDiscovery,
      configured: missingCredentials.length === 0 && model.length > 0,
      credentialFields: preset.credentialFields,
      missingCredentials,
      timeoutMs: provider.timeoutMs,
      maxOutputTokens: provider.maxOutputTokens
    }
  }

  private buildProxyView(proxy: PocProxyConfig): PocProxyView {
    const url = proxy.url.trim()
    return {
      enabled: proxy.enabled && url.length > 0 && isHttpUrl(url),
      url,
      caConfigured: proxy.caPath.trim().length > 0,
      allowInsecureTls: proxy.allowInsecureTls
    }
  }

  private normalizeProviderForRuntime(provider: PocProviderConfig): PocProviderConfig {
    const preset = requirePresetDefinition(provider.preset)
    return {
      ...provider,
      credentials: { ...provider.credentials },
      baseUrl:
        provider.baseUrl.trim().length > 0
          ? provider.baseUrl.trim()
          : preset.defaultBaseUrl.trim()
    }
  }

  private generateProviderId(poc: PocConfigFilePoc): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = `poc-${randomBytes(4).toString('hex')}`
      if (!poc.providers.some((provider) => provider.id === candidate)) return candidate
    }
    throw createPocError(POC_ERROR_CODES.INVALID_CONFIG, '无法生成唯一的 provider id')
  }

  /** Remove exact secret values from any user-visible error string. */
  private scrubSecrets(text: string, credentials: Record<string, string>): string {
    const secrets = Object.values(credentials).filter(
      (value) => typeof value === 'string' && value.trim().length >= 4
    )
    return redactPocText(text, secrets)
  }
}

/* ------------------------------------------------------------------------- */
/* Factory                                                                   */
/* ------------------------------------------------------------------------- */

export function createPocConfigService(options: {
  dbPath: string
  env?: NodeJS.ProcessEnv
  logger: HubLogger
}): PocConfigService {
  return new PocConfigServiceImpl(options)
}
