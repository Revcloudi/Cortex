/**
 * Exploit-as-Code PoC types, IPC DTOs and pure helpers.
 *
 * This module is shared by the Electron main process, the preload bridge, the
 * renderer and the `ctx web` HTTP client. It is intentionally free of Node and
 * React imports so every bundle can use it.
 *
 * SECURITY: nothing in this module may be exposed over MCP. PoC artifacts and
 * run evidence are desktop-GUI-only (`poc_artifacts` / `poc_runs`); the MCP
 * layer has its own view types and never queries these tables. See
 * docs/EXPLOIT_AS_CODE_POC_DESIGN.md §11.5.
 */
import { z } from 'zod'
import type { Severity, VulnStatus, VulnerabilityListItem } from './types'

/* ------------------------------------------------------------------------- */
/* Provider presets                                                          */
/* ------------------------------------------------------------------------- */

export const POC_TRANSPORTS = [
  'openai-chat',
  'anthropic-messages',
  'hunyuan',
  'custom'
] as const
export type PocTransport = (typeof POC_TRANSPORTS)[number]

export const POC_MODEL_DISCOVERIES = ['openai-list', 'anthropic-list', 'manual'] as const
export type PocModelDiscovery = (typeof POC_MODEL_DISCOVERIES)[number]

export const POC_CREDENTIAL_FIELDS = ['apiKey', 'secretId', 'secretKey'] as const
export type PocCredentialField = (typeof POC_CREDENTIAL_FIELDS)[number]

export const POC_PRESET_IDS = [
  'deepseek',
  'glm',
  'kimi',
  'claudecode',
  'openai',
  'openrouter',
  'commoncode',
  'qwen',
  'hunyuan',
  'custom'
] as const
export type PocPresetId = (typeof POC_PRESET_IDS)[number]

export interface PocPresetDefinition {
  id: PocPresetId
  label: string
  /** Human note shown in the config page (never contains secrets). */
  hint: string
  transport: PocTransport
  /** Empty string means "the user must provide a base URL" (custom/commoncode). */
  defaultBaseUrl: string
  credentialFields: readonly PocCredentialField[]
  modelDiscovery: PocModelDiscovery
  /** JSON mode (`response_format`) support; adapters may still degrade to text extraction. */
  supportsJsonMode: boolean
  /** Anthropic-style API version header value, when applicable. */
  apiVersion?: string
}

/**
 * Nine vendor presets + `custom`. Every preset is an independent adapter
 * profile: it owns auth headers, request paths, body field names and model
 * discovery. There is deliberately no default model anywhere in this table.
 */
export const POC_PRESETS: Record<PocPresetId, PocPresetDefinition> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: 'OpenAI-compatible · Bearer API Key',
    transport: 'openai-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    credentialFields: ['apiKey'],
    modelDiscovery: 'openai-list',
    supportsJsonMode: true
  },
  glm: {
    id: 'glm',
    label: 'GLM（智谱）',
    hint: 'OpenAI-compatible · Bearer API Key',
    transport: 'openai-chat',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    credentialFields: ['apiKey'],
    modelDiscovery: 'openai-list',
    supportsJsonMode: true
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi（Moonshot）',
    hint: 'OpenAI-compatible · Bearer API Key',
    transport: 'openai-chat',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    credentialFields: ['apiKey'],
    modelDiscovery: 'openai-list',
    supportsJsonMode: true
  },
  claudecode: {
    id: 'claudecode',
    label: 'Claude Code',
    hint: 'Anthropic Messages API · x-api-key + anthropic-version',
    transport: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    credentialFields: ['apiKey'],
    modelDiscovery: 'anthropic-list',
    supportsJsonMode: false,
    apiVersion: '2023-06-01'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    hint: 'OpenAI-compatible · Bearer API Key',
    transport: 'openai-chat',
    defaultBaseUrl: 'https://api.openai.com/v1',
    credentialFields: ['apiKey'],
    modelDiscovery: 'openai-list',
    supportsJsonMode: true
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'OpenAI-compatible · Bearer API Key（模型列表较大，可搜索）',
    transport: 'openai-chat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    credentialFields: ['apiKey'],
    modelDiscovery: 'openai-list',
    supportsJsonMode: true
  },
  commoncode: {
    id: 'commoncode',
    label: 'CommonCode',
    hint: '预设保留：接口格式待确认，需手动填写 Base URL 与模型',
    transport: 'openai-chat',
    defaultBaseUrl: '',
    credentialFields: ['apiKey'],
    modelDiscovery: 'manual',
    supportsJsonMode: false
  },
  qwen: {
    id: 'qwen',
    label: '千问（DashScope）',
    hint: 'OpenAI-compatible · Bearer API Key',
    transport: 'openai-chat',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    credentialFields: ['apiKey'],
    modelDiscovery: 'openai-list',
    supportsJsonMode: true
  },
  hunyuan: {
    id: 'hunyuan',
    label: '混元（腾讯）',
    hint: 'OpenAI-compatible 入口 · API Key；模型发现失败可手填',
    transport: 'hunyuan',
    defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    credentialFields: ['apiKey'],
    modelDiscovery: 'openai-list',
    supportsJsonMode: false
  },
  custom: {
    id: 'custom',
    label: '自定义（OpenAI-compatible）',
    hint: '必须填写 Base URL；只支持 JSON 配置，不执行任意代码',
    transport: 'custom',
    defaultBaseUrl: '',
    credentialFields: ['apiKey'],
    modelDiscovery: 'manual',
    supportsJsonMode: false
  }
}

export const POC_PRESET_LIST: readonly PocPresetDefinition[] = POC_PRESET_IDS.map(
  (id) => POC_PRESETS[id]
)

/** Fixed prompt version stored on every AI-generated artifact. */
export const POC_PROMPT_VERSION = 'poc-gen-v5'

/* ------------------------------------------------------------------------- */
/* Execution limits                                                          */
/* ------------------------------------------------------------------------- */

export const POC_LIMITS = {
  totalTimeoutMs: 10_000,
  requestTimeoutMs: 8_000,
  maxRequests: 50,
  maxResponseBytes: 2_000_000,
  maxCodeBytes: 64_000,
  maxMemoryMb: 64,
  maxLogLines: 200,
  maxLogBytes: 32_768,
  maxEvidenceBytes: 32_768,
  maxGenerationChars: 12_000,
  maxModels: 500
} as const

export const PocExecutionLimitsSchema = z
  .object({
    totalTimeoutMs: z.number().int().min(1_000).max(120_000).default(POC_LIMITS.totalTimeoutMs),
    requestTimeoutMs: z.number().int().min(500).max(60_000).default(POC_LIMITS.requestTimeoutMs),
    maxRequests: z.number().int().min(1).max(500).default(POC_LIMITS.maxRequests),
    maxResponseBytes: z
      .number()
      .int()
      .min(10_000)
      .max(20_000_000)
      .default(POC_LIMITS.maxResponseBytes),
    maxCodeBytes: z.number().int().min(1_000).max(256_000).default(POC_LIMITS.maxCodeBytes)
  })
  .strict()

export type PocExecutionLimits = z.infer<typeof PocExecutionLimitsSchema>

export const PocExecutionLimitsUpdateSchema = PocExecutionLimitsSchema.partial()

/* ------------------------------------------------------------------------- */
/* UI schema (dynamic retest form)                                           */
/* ------------------------------------------------------------------------- */

export const POC_FIELD_TYPES = ['text', 'textarea', 'number', 'secret', 'select'] as const
export type PocFieldType = (typeof POC_FIELD_TYPES)[number]

export const POC_FIELD_KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/

export const PocFieldSchema = z
  .object({
    key: z
      .string()
      .regex(POC_FIELD_KEY_PATTERN, '字段 key 仅允许字母、数字和下划线（1-64 字符）'),
    label: z.string().trim().min(1).max(200),
    type: z.enum(POC_FIELD_TYPES),
    placeholder: z.string().max(500).optional(),
    required: z.boolean().optional(),
    default: z.union([z.string().max(4_000), z.number()]).optional(),
    help: z.string().max(1_000).optional(),
    options: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    maxLength: z.number().int().min(1).max(100_000).optional()
  })
  .strict()

export type PocField = z.infer<typeof PocFieldSchema>

export const PocUiSchemaSchema = z
  .object({
    fields: z.array(PocFieldSchema).max(20)
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const [index, field] of value.fields.entries()) {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: `字段 key 重复：${field.key}`
        })
      }
      seen.add(field.key)
      if (field.type === 'select' && (field.options === undefined || field.options.length === 0)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'options'],
          message: 'select 字段必须提供 options'
        })
      }
    }
  })

export type PocUiSchema = z.infer<typeof PocUiSchemaSchema>

export const EMPTY_POC_UI_SCHEMA: PocUiSchema = { fields: [] }

/** Strict shape a model must return (also used by the manual "new version" path). */
export const PocGenerationSchema = z
  .object({
    ui_schema: PocUiSchemaSchema,
    js_code: z.string().trim().min(1).max(POC_LIMITS.maxCodeBytes)
  })
  .strict()

export type PocGeneration = z.infer<typeof PocGenerationSchema>

/* ------------------------------------------------------------------------- */
/* Artifacts and runs                                                        */
/* ------------------------------------------------------------------------- */

export const POC_ARTIFACT_STATUSES = ['draft', 'approved', 'disabled'] as const
export type PocArtifactStatus = (typeof POC_ARTIFACT_STATUSES)[number]

export const POC_ARTIFACT_SOURCES = ['ai', 'manual', 'import'] as const
export type PocArtifactSource = (typeof POC_ARTIFACT_SOURCES)[number]

export const POC_RUN_STATUSES = [
  'queued',
  'running',
  'success',
  'failure',
  'inconclusive',
  'timeout',
  'blocked',
  'aborted'
] as const
export type PocRunStatus = (typeof POC_RUN_STATUSES)[number]

export interface PocArtifact {
  id: string
  vuln_id: string
  version: number
  ui_schema: PocUiSchema
  js_code: string
  code_hash: string
  status: PocArtifactStatus
  model: string
  prompt_version: string
  generated_at: string
  approved_at: string
  source: PocArtifactSource
  notes: string
  created_at: string
  updated_at: string
}

export interface PocArtifactSummary {
  id: string
  version: number
  status: PocArtifactStatus
  source: PocArtifactSource
  model: string
  code_hash: string
  updated_at: string
}

export interface PocRun {
  id: string
  artifact_id: string
  vuln_id: string
  base_url: string
  status: PocRunStatus
  request_count: number
  started_at: string
  finished_at: string
  evidence: string
  logs_excerpt: string
  error: string
}

export interface PocRunSummary {
  id: string
  status: PocRunStatus
  started_at: string
  finished_at: string
  request_count: number
}

export interface PocCandidate {
  vuln: VulnerabilityListItem
  latestArtifact: PocArtifactSummary | null
  artifactCount: number
  lastRun: PocRunSummary | null
}

export interface PocSummary {
  drafts: number
  approved: number
  totalArtifacts: number
  running: number
}

/** One streamed sandbox log line (`poc:log`). */
export interface PocLogEvent {
  runId: string
  seq: number
  level: 'log' | 'warn' | 'error'
  text: string
  at: string
}

/** Read-only proxy metadata injected into the sandbox; never contains auth. */
export interface PocProxyInfo {
  readonly enabled: boolean
  readonly url: string
  readonly protocol: string
}

export type PocInputValue = string | number

/* ------------------------------------------------------------------------- */
/* Configuration file (dirname(data.db)/config.json → `poc` namespace)       */
/* ------------------------------------------------------------------------- */

export const POC_CONFIG_SCHEMA_VERSION = 1

export const POC_CREDENTIAL_FIELD_LABELS: Record<PocCredentialField, string> = {
  apiKey: 'API Key',
  secretId: 'SecretId',
  secretKey: 'SecretKey'
}

export const PocProviderConfigSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    preset: z.enum(POC_PRESET_IDS),
    label: z.string().trim().max(200).default(''),
    baseUrl: z.string().trim().max(2_000).default(''),
    model: z.string().trim().max(300).default(''),
    credentials: z.record(z.string().max(100), z.string().max(8_000)).default({}),
    apiVersion: z.string().trim().max(50).optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
    maxOutputTokens: z.number().int().min(64).max(64_000).default(8_192)
  })
  .strict()

export type PocProviderConfig = z.infer<typeof PocProviderConfigSchema>

export const PocProxyConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    url: z.string().trim().max(2_000).default(''),
    username: z.string().max(500).default(''),
    password: z.string().max(2_000).default(''),
    caPath: z.string().trim().max(4_000).default(''),
    allowInsecureTls: z.boolean().default(false)
  })
  .strict()

export type PocProxyConfig = z.infer<typeof PocProxyConfigSchema>

export const PocConfigFilePocSchema = z
  .object({
    activeProvider: z.string().trim().max(100).default(''),
    providers: z.array(PocProviderConfigSchema).max(20).default([]),
    proxy: PocProxyConfigSchema.default({
      enabled: false,
      url: '',
      username: '',
      password: '',
      caPath: '',
      allowInsecureTls: false
    }),
    execution: PocExecutionLimitsSchema.default({
      totalTimeoutMs: POC_LIMITS.totalTimeoutMs,
      requestTimeoutMs: POC_LIMITS.requestTimeoutMs,
      maxRequests: POC_LIMITS.maxRequests,
      maxResponseBytes: POC_LIMITS.maxResponseBytes,
      maxCodeBytes: POC_LIMITS.maxCodeBytes
    })
  })
  .loose()

export type PocConfigFilePoc = z.infer<typeof PocConfigFilePocSchema>

/* ------------------------------------------------------------------------- */
/* IPC views / DTOs (never contain credentials)                              */
/* ------------------------------------------------------------------------- */

export interface PocProviderView {
  id: string
  preset: PocPresetId
  label: string
  baseUrl: string
  model: string
  modelDiscovery: PocModelDiscovery
  /** Credentials complete AND a user-selected model exists. */
  configured: boolean
  credentialFields: readonly PocCredentialField[]
  missingCredentials: readonly string[]
  timeoutMs: number
  maxOutputTokens: number
}

export interface PocProxyView {
  enabled: boolean
  url: string
  caConfigured: boolean
  allowInsecureTls: boolean
}

export interface PocConfigView {
  /** Absolute path of `dirname(data.db)/config.json`. */
  path: string
  configFileExists: boolean
  /** At least one provider is fully configured (model selected + credentials). */
  enabled: boolean
  /** Desktop sandbox availability; false when the sandbox runtime failed to load. */
  executionEnabled: boolean
  activeProviderId: string | null
  providers: PocProviderView[]
  proxy: PocProxyView
  limits: PocExecutionLimits
  /** Environment variable names currently overriding file values. */
  overriddenByEnv: string[]
  /** Permission / plaintext warning shown as a non-blocking banner. */
  permissionWarning: string | null
}

export interface ModelOption {
  id: string
  label?: string
  ownedBy?: string
}

export interface ListPocModelsInput {
  providerId?: string
  preset: PocPresetId
  baseUrl?: string
  /** Only for this call; never persisted or logged. */
  credentials?: Record<string, string>
}

export interface ListPocModelsResult {
  models: ModelOption[]
  source: 'api' | 'manual'
  warning?: string
}

export interface TestPocProviderResult {
  ok: boolean
  latencyMs: number
  error?: string
}

export interface SavePocConfigInput {
  activeProviderId?: string | null
  proxy?: {
    enabled: boolean
    url?: string
    username?: string
    password?: string
    clearPassword?: boolean
    caPath?: string
    allowInsecureTls?: boolean
  }
  execution?: Partial<PocExecutionLimits>
}

export interface UpsertPocProviderInput {
  id?: string
  preset: PocPresetId
  label?: string
  baseUrl?: string
  /** Required: the user must pick/enter a model after querying. No defaults. */
  model: string
  credentials?: Record<string, string>
  apiVersion?: string
  timeoutMs?: number
  maxOutputTokens?: number
  setActive?: boolean
}

export interface ListPocCandidatesQuery {
  search?: string
  status?: 'all' | 'none' | 'draft' | 'approved' | 'disabled'
  severity?: Severity
}

export interface SavePocArtifactInput {
  /** When editing an existing artifact, its id; a new version is created. */
  artifactId?: string
  vulnId: string
  ui_schema: PocUiSchema
  js_code: string
  notes?: string
}

export interface RunPocInput {
  artifactId: string
  baseUrl: string
  /** In-memory only: never persisted, logged or sent to a model. */
  inputs: Record<string, PocInputValue>
}

export interface AppendPocRetestInput {
  vulnId: string
  /** Optional run/artifact source for the prefilled evidence. */
  runId?: string
  timeRange: string
  conclusion: string
  status?: VulnStatus
}

export interface AppendPocRetestResult {
  retestIndex: number
  status: string
}

/* ------------------------------------------------------------------------- */
/* Zod schemas for IPC / HTTP boundary validation                            */
/* ------------------------------------------------------------------------- */

export const PocIdSchema = z.string().trim().min(1).max(100)
export const PocVulnIdSchema = z.string().trim().min(1).max(100)
export const PocBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_000)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'baseUrl 必须是 http(s) URL')

export const PocArtifactStatusSchema = z.enum(POC_ARTIFACT_STATUSES)

export const PocCandidateQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    status: z.enum(['all', 'none', 'draft', 'approved', 'disabled']).optional(),
    severity: z.enum(['Critical', 'High', 'Medium', 'Low', 'Info']).optional()
  })
  .strict()

export const SavePocArtifactInputSchema = z
  .object({
    artifactId: PocIdSchema.optional(),
    vulnId: PocVulnIdSchema,
    ui_schema: PocUiSchemaSchema,
    js_code: z.string().min(1).max(POC_LIMITS.maxCodeBytes),
    notes: z.string().max(2_000).optional()
  })
  .strict()

export const RunPocInputSchema = z
  .object({
    artifactId: PocIdSchema,
    baseUrl: PocBaseUrlSchema,
    inputs: z
      .record(
        z.string().regex(POC_FIELD_KEY_PATTERN),
        z.union([z.string().max(20_000), z.number().finite()])
      )
      .refine((value) => Object.keys(value).length <= 50, 'inputs 最多 50 个字段')
  })
  .strict()

export const AppendPocRetestInputSchema = z
  .object({
    vulnId: PocVulnIdSchema,
    runId: PocIdSchema.optional(),
    timeRange: z.string().trim().min(1).max(200),
    conclusion: z.string().trim().min(1).max(50_000),
    status: z.enum(['Confirmed', 'Inconclusive', 'Retest_Passed']).optional()
  })
  .strict()

/**
 * Credentials object accepted from the renderer / HTTP boundary.
 *
 * NOTE: zod v4 `z.record(z.enum(...), ...)` is an *exhaustive* record and would
 * require every credential field (`apiKey` + `secretId` + `secretKey`) on every
 * provider. Provider presets only use a subset, so validate a plain string-keyed
 * record and reject unknown fields explicitly.
 */
export const PocCredentialsSchema = z
  .record(z.string().max(100), z.string().max(8_000))
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (!(POC_CREDENTIAL_FIELDS as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `未知凭据字段：${key}（支持 ${POC_CREDENTIAL_FIELDS.join(' / ')}）`
        })
      }
    }
  })

export const UpsertPocProviderInputSchema = z
  .object({
    id: PocIdSchema.optional(),
    preset: z.enum(POC_PRESET_IDS),
    label: z.string().trim().max(200).optional(),
    baseUrl: z.string().trim().max(2_000).optional(),
    model: z.string().trim().min(1, '请先查询并选择模型，或手动输入模型 ID').max(300),
    credentials: PocCredentialsSchema.optional(),
    apiVersion: z.string().trim().max(50).optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    maxOutputTokens: z.number().int().min(64).max(64_000).optional(),
    setActive: z.boolean().optional()
  })
  .strict()

export const PocProxyUpdateSchema = z
  .object({
    enabled: z.boolean(),
    url: z.string().trim().max(2_000).optional(),
    username: z.string().max(500).optional(),
    password: z.string().max(2_000).optional(),
    clearPassword: z.boolean().optional(),
    caPath: z.string().trim().max(4_000).optional(),
    allowInsecureTls: z.boolean().optional()
  })
  .strict()

export const SavePocConfigInputSchema = z
  .object({
    activeProviderId: PocIdSchema.nullable().optional(),
    proxy: PocProxyUpdateSchema.optional(),
    execution: PocExecutionLimitsUpdateSchema.optional()
  })
  .strict()

export const ListPocModelsInputSchema = z
  .object({
    providerId: PocIdSchema.optional(),
    preset: z.enum(POC_PRESET_IDS),
    baseUrl: z.string().trim().max(2_000).optional(),
    credentials: PocCredentialsSchema.optional()
  })
  .strict()

export const TestPocProviderInputSchema = z
  .object({
    id: PocIdSchema
  })
  .strict()

/* ------------------------------------------------------------------------- */
/* Error codes                                                               */
/* ------------------------------------------------------------------------- */

export const POC_ERROR_CODES = {
  DESKTOP_ONLY: 'POC_DESKTOP_ONLY',
  UNSUPPORTED_REALM: 'POC_UNSUPPORTED_REALM',
  NOT_CONFIGURED: 'POC_NOT_CONFIGURED',
  MODEL_REQUIRED: 'POC_MODEL_REQUIRED',
  INVALID_CONFIG: 'POC_INVALID_CONFIG',
  CONFIG_UNWRITABLE: 'POC_CONFIG_UNWRITABLE',
  PROVIDER_NOT_FOUND: 'POC_PROVIDER_NOT_FOUND',
  MODEL_DISCOVERY_FAILED: 'POC_MODEL_DISCOVERY_FAILED',
  GENERATION_FAILED: 'POC_GENERATION_FAILED',
  ARTIFACT_NOT_FOUND: 'POC_ARTIFACT_NOT_FOUND',
  ARTIFACT_MISMATCH: 'POC_ARTIFACT_MISMATCH',
  HASH_MISMATCH: 'POC_ARTIFACT_HASH_MISMATCH',
  INVALID_CODE: 'POC_INVALID_CODE',
  CODE_TOO_LARGE: 'POC_CODE_TOO_LARGE',
  INVALID_INPUT: 'POC_INVALID_INPUT',
  RUN_BUSY: 'POC_RUN_BUSY',
  RUN_NOT_FOUND: 'POC_RUN_NOT_FOUND',
  TARGET_NOT_ALLOWED: 'POC_TARGET_NOT_ALLOWED',
  BASE_URL_UNAVAILABLE: 'POC_BASE_URL_UNAVAILABLE',
  SANDBOX_UNAVAILABLE: 'POC_SANDBOX_UNAVAILABLE',
  ABORTED: 'POC_ABORTED'
} as const

export type PocErrorCode = (typeof POC_ERROR_CODES)[keyof typeof POC_ERROR_CODES]

/** Errors crossing IPC keep their machine-readable code as a message prefix. */
export function createPocError(code: PocErrorCode, message: string): Error {
  return new Error(`${code}: ${message}`)
}

export function parsePocError(message: string): { code: PocErrorCode | null; message: string } {
  const match = /^(POC_[A-Z_]+):\s*([\s\S]*)$/.exec(message)
  if (match === null) return { code: null, message }
  const code = match[1] as PocErrorCode
  return { code: code in POC_ERROR_CODES ? code : null, message: match[2] ?? '' }
}

/* ------------------------------------------------------------------------- */
/* Pure helpers                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Only Web findings are eligible. Internal-realm findings — including legacy
 * rows that carry a `service_host` or a structured `internal_service_id` — are
 * rejected by the UI *and* re-checked in the main process.
 */
export function isPocEligibleVuln(vuln: {
  realm: string
  service_host: string
  internal_service_id: string
}): boolean {
  return (
    vuln.realm === 'web' &&
    vuln.service_host.trim() === '' &&
    vuln.internal_service_id.trim() === ''
  )
}

/**
 * Derive the only origin a PoC may talk to from the stored vulnerability.
 *
 * The retest lab never guesses the scheme: a `target_url` that does not parse
 * as an absolute http(s) URL means "no executable target", and the UI asks the
 * user to fix the vulnerability record instead of inventing an origin.
 */
export function derivePocBaseUrl(vuln: { target_url: string }): string | null {
  const target = vuln.target_url.trim()
  if (target.length === 0) return null
  try {
    const url = new URL(target)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

/** True when `baseUrl` is exactly the vulnerability target origin. */
export function isPocBaseUrlAllowed(vuln: { target_url: string }, baseUrl: string): boolean {
  const allowed = derivePocBaseUrl(vuln)
  if (allowed === null) return false
  try {
    return new URL(baseUrl).origin === allowed
  } catch {
    return false
  }
}

/** Strip a Markdown JSON fence (` ```json ... ``` `) if the model produced one. */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed)
  if (fenced !== null && fenced[1] !== undefined) return fenced[1].trim()
  return trimmed
}

export interface PocCodeLintResult {
  ok: boolean
  /** Hard violations: the code must not be saved / generated. */
  errors: string[]
  /** Non-blocking hints (e.g. APIs that are unavailable in the sandbox). */
  warnings: string[]
}

/** Tokens that have no legitimate place in a retest script. */
const FORBIDDEN_CODE_TOKENS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bimport\s*\(/, label: 'import(' },
  { pattern: /\bchild_process\b/, label: 'child_process' },
  { pattern: /\bprocess\s*\.\s*(?:binding|mainModule|dlopen|env|exit|kill)\b/, label: 'process' },
  { pattern: /\bWebAssembly\b/, label: 'WebAssembly' },
  { pattern: /\beval\s*\(/, label: 'eval(' },
  { pattern: /\bnew\s+Function\b/, label: 'new Function' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket' },
  { pattern: /\bWorker\b/, label: 'Worker' }
]

const UNAVAILABLE_CODE_APIS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\brequire\.resolve\b/, label: 'require.resolve' }
]

/**
 * Structural checks required for a script to be runnable at all: size cap and
 * the async-function signature. These are hard errors; API-token lint below is
 * advisory because the sandbox enforces the real boundary at execution time.
 */
export function pocCodeStructureErrors(
  code: string,
  maxCodeBytes: number = POC_LIMITS.maxCodeBytes
): string[] {
  const errors: string[] = []
  const byteLength = new TextEncoder().encode(code).byteLength
  if (byteLength > maxCodeBytes) {
    errors.push(`代码超过 ${maxCodeBytes} 字节上限（当前 ${byteLength}）`)
  }
  if (!/^\s*async\s+(?:function\s*\(|\(\s*[A-Za-z0-9_,\s]*\)\s*=>)/m.test(code)) {
    errors.push('代码必须是 `async function (baseUrl, inputs, proxy) { ... }` 或 async 箭头函数形式')
  }
  if (/\{\s*\.\.\.\s*\}/.test(code)) {
    errors.push('代码包含占位符 `{...}`，不是可执行实现，请重新生成')
  }
  return errors
}

/**
 * Static lint for retest scripts. This is a usability/compatibility filter, not
 * the security boundary — the sandbox never exposes these host APIs.
 */
export function lintPocCode(
  code: string,
  maxCodeBytes: number = POC_LIMITS.maxCodeBytes
): PocCodeLintResult {
  const errors: string[] = pocCodeStructureErrors(code, maxCodeBytes)
  const warnings: string[] = []
  for (const token of FORBIDDEN_CODE_TOKENS) {
    if (token.pattern.test(code)) errors.push(`禁止使用 ${token.label}`)
  }
  for (const token of UNAVAILABLE_CODE_APIS) {
    if (token.pattern.test(code)) warnings.push(`沙箱内不提供 ${token.label}`)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** Long random-looking strings are likely tokens; keep logs readable. */
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/_-]{80,}={0,2}/g
const LONG_HEX_PATTERN = /\b[0-9a-fA-F]{64,}\b/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Redact credentials from sandbox logs / evidence before they are streamed to
 * the renderer or written to SQLite. `secrets` are exact input values (Cookie /
 * password / token fields); they are always removed verbatim.
 *
 * This is best-effort defense in depth, not a replacement for never logging the
 * values in the first place.
 */
export function redactPocText(text: string, secrets: readonly string[] = []): string {
  let result = text
  for (const secret of secrets) {
    const value = secret.trim()
    if (value.length < 4) continue
    result = result.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED]')
  }
  result = result
    .replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*:\s*[^\r\n]*/gi,
      '$1: [REDACTED]'
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)\b(\s*[=:]\s*)(["']?)[^\s"'&,;}\]]+/gi,
      '$1$2$3[REDACTED]'
    )
    .replace(
      /"(apiKey|api_key|token|access_token|password|secret|clientSecret|authorization|cookie)"\s*:\s*"[^"]*"/gi,
      '"$1":"[REDACTED]"'
    )
  result = result
    .replace(LONG_BASE64_PATTERN, '[REDACTED_B64]')
    .replace(LONG_HEX_PATTERN, '[REDACTED_HEX]')
  return result
}

/** Truncate by UTF-8 bytes without splitting a surrogate pair. */
export function truncatePocText(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= maxBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (encoder.encode(text.slice(0, mid)).byteLength <= maxBytes) low = mid
    else high = mid - 1
  }
  return `${text.slice(0, low)}\n[truncated]`
}

/**
 * Sanitize a retest conclusion before it is appended to `retest_results`.
 *
 * `retest_results` is visible to MCP agents (it is part of the public
 * vulnerability record), so the PoC code, request headers and Cookie values must
 * never be copied into it. The UI prefills the sanitized evidence; this is the
 * main-process backstop.
 */
export function sanitizePocRetestConclusion(
  conclusion: string,
  options: { secrets?: readonly string[]; jsCode?: string } = {}
): string {
  let result = conclusion
  const code = options.jsCode?.trim() ?? ''
  if (code.length > 0) {
    result = result.split(code).join('')
  }
  // Drop fenced JS/TS blocks entirely: retest conclusions quote traffic, not scripts.
  result = result.replace(/```(?:js|javascript|ts|typescript)\s*\n[\s\S]*?```/gi, '')
  result = redactPocText(result, options.secrets ?? [])
  // Never keep a full script signature even if it fell out of a fence.
  result = result.replace(/\basync\s+function\s*\(\s*baseUrl[\s\S]*$/i, '')
  result = result.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return truncatePocText(result.trim(), 50_000)
}

/** Normalize user form values against the artifact UI schema (unknown keys dropped). */
export function normalizePocInputs(
  uiSchema: PocUiSchema,
  raw: Record<string, unknown>
): Record<string, PocInputValue> {
  const out: Record<string, PocInputValue> = {}
  for (const field of uiSchema.fields) {
    const value = raw[field.key]
    if (value === undefined || value === null) continue
    if (field.type === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[field.key] = value
      else if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) out[field.key] = parsed
      }
      continue
    }
    if (typeof value === 'string') {
      const maxLength = field.maxLength ?? 20_000
      out[field.key] = value.slice(0, maxLength)
    } else if (typeof value === 'number') {
      out[field.key] = String(value)
    }
  }
  return out
}

/** Secret input values for log redaction (never persisted anywhere). */
export function collectPocSecretValues(
  uiSchema: PocUiSchema,
  inputs: Record<string, PocInputValue>
): string[] {
  const secrets: string[] = []
  for (const field of uiSchema.fields) {
    if (field.type !== 'secret') continue
    const value = inputs[field.key]
    if (typeof value === 'string' && value.trim().length >= 4) secrets.push(value.trim())
    else if (typeof value === 'number') secrets.push(String(value))
  }
  return secrets
}
