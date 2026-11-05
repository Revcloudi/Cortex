/**
 * Provider adapter contracts for the Exploit-as-Code PoC pipeline.
 *
 * Every vendor preset is an independent adapter *profile*: it owns its auth
 * headers, request paths, body field names, model-discovery endpoint and error
 * mapping. There is deliberately no single "OpenAI client" that every vendor
 * silently falls back to — an unknown preset is always an explicit error.
 *
 * These modules are pure TypeScript (no Node imports) so the same code can run
 * in the Electron main process today and in the future `ctx web` server.
 *
 * SECURITY: adapters only ever build requests from the strict
 * `PocProviderConfig` fields. They never log headers or credentials; callers
 * additionally scrub known secret values from returned error strings.
 */
import type {
  ModelOption,
  PocCredentialField,
  PocPresetDefinition,
  PocPresetId,
  PocProviderConfig
} from '../../../shared/poc'
import {
  POC_CREDENTIAL_FIELD_LABELS,
  POC_ERROR_CODES,
  POC_PRESETS,
  createPocError,
  redactPocText
} from '../../../shared/poc'

export type FetchLike = typeof fetch

/* ------------------------------------------------------------------------- */
/* Adapter contract                                                          */
/* ------------------------------------------------------------------------- */

export interface ProviderChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ProviderChatRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

/** Model discovery is always a plain GET with the provider's auth headers. */
export interface ProviderModelListRequest {
  url: string
  headers: Record<string, string>
}

export interface ProviderUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface ParsedProviderChat {
  /** Raw assistant text; JSON extraction happens in the generator. */
  text: string
  usage?: ProviderUsage
}

export interface ProviderChatOptions {
  /** Ask the vendor for a JSON object response when the profile supports it. */
  jsonMode?: boolean
  maxTokens?: number
  temperature?: number
}

export interface ProviderAdapter {
  readonly preset: PocPresetId
  /** True when the vendor accepts an OpenAI-style `response_format` field. */
  readonly supportsJsonMode: boolean
  buildChatRequest(
    provider: PocProviderConfig,
    messages: readonly ProviderChatMessage[],
    options?: ProviderChatOptions
  ): ProviderChatRequest
  parseChatResponse(json: unknown): ParsedProviderChat
  /** `null` means the vendor has no reliable list endpoint (manual entry). */
  listModelsRequest(provider: PocProviderConfig): ProviderModelListRequest | null
  parseModelList(json: unknown): ModelOption[]
  /** Human-readable, secret-free error for a non-2xx HTTP response. */
  normalizeError(status: number, body: string): string
}

/* ------------------------------------------------------------------------- */
/* Small shared helpers (pure; no vendor behavior lives here)                */
/* ------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Runtime guard so IPC/file input can never resolve an unknown preset. */
export function getPocPreset(preset: PocPresetId): PocPresetDefinition {
  const definition = (POC_PRESETS as Record<string, PocPresetDefinition | undefined>)[preset]
  if (definition === undefined) {
    throw createPocError(
      POC_ERROR_CODES.INVALID_CONFIG,
      `未知的 AI 提供商标识：${String(preset)}`
    )
  }
  return definition
}

/** Preset default Base URL applies when the provider does not override it. */
export function resolveProviderBaseUrl(provider: PocProviderConfig): string {
  const explicit = provider.baseUrl.trim()
  if (explicit.length > 0) return explicit
  return getPocPreset(provider.preset).defaultBaseUrl.trim()
}

/**
 * Resolve the Base URL every request must use. Throws `POC_INVALID_CONFIG` when
 * the preset has no default and the user has not supplied one (custom /
 * commoncode), or when the value is not a plain http(s) URL.
 */
export function requireProviderBaseUrl(provider: PocProviderConfig): string {
  const baseUrl = resolveProviderBaseUrl(provider)
  if (baseUrl.length === 0) {
    throw createPocError(
      POC_ERROR_CODES.INVALID_CONFIG,
      `preset ${provider.preset} 没有默认 Base URL，请手动填写 http(s) Base URL`
    )
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw createPocError(POC_ERROR_CODES.INVALID_CONFIG, `Base URL 不是合法 URL：${baseUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createPocError(POC_ERROR_CODES.INVALID_CONFIG, 'Base URL 必须是 http(s) 地址')
  }
  return baseUrl
}

/** Join a Base URL with an endpoint path without doubling or dropping slashes. */
export function joinProviderUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

export function readCredential(
  provider: PocProviderConfig,
  field: PocCredentialField
): string {
  const value = provider.credentials?.[field]
  return typeof value === 'string' ? value.trim() : ''
}

/** Read a required credential or fail with a config error (never logs value). */
export function requireCredential(
  provider: PocProviderConfig,
  field: PocCredentialField
): string {
  const value = readCredential(provider, field)
  if (value.length === 0) {
    throw createPocError(
      POC_ERROR_CODES.NOT_CONFIGURED,
      `缺少 AI 提供商凭据：${POC_CREDENTIAL_FIELD_LABELS[field]}，请先在配置页填写`
    )
  }
  return value
}

/** `provider.model` must always be chosen by the user — there is no default. */
export function requireProviderModel(provider: PocProviderConfig): string {
  const model = provider.model.trim()
  if (model.length === 0) {
    throw createPocError(
      POC_ERROR_CODES.MODEL_REQUIRED,
      '请先查询并选择模型，或手动输入模型 ID'
    )
  }
  return model
}

export function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '请求已中止或超时'
    if (error.name === 'TimeoutError') return '请求超时'
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message.length > 0) {
      return `${error.message}（${cause.message}）`
    }
    if (cause !== undefined) {
      const text = String(cause)
      if (text.length > 0) return `${error.message}（${text}）`
    }
    if (error.message.length > 0) return error.message
    return error.name
  }
  return typeof error === 'string' ? error : '未知网络错误'
}

const SECRET_LIKE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(sk|pk|api|key|token)[-_][A-Za-z0-9_-]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9+/_-]{60,}={0,2}/g,
  /\b[0-9a-fA-F]{40,}\b/g
]

/**
 * Redact secret-looking tokens from an error body/excerpt. Deliberately coarse:
 * error bodies are user-visible, and a false positive only loses debug detail.
 */
export function sanitizeErrorExcerpt(text: string, maxLength = 300): string {
  let sanitized = text
  for (const pattern of SECRET_LIKE_PATTERNS) sanitized = sanitized.replace(pattern, '[REDACTED]')
  sanitized = redactPocText(sanitized)
  sanitized = sanitized.replace(/\s+/g, ' ').trim()
  if (sanitized.length <= maxLength) return sanitized
  return `${sanitized.slice(0, maxLength)}…`
}

/** Best-effort extraction of the vendor's `error.message`-style field. */
export function extractProviderErrorMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed)) return null
    const error = parsed.error
    if (typeof error === 'string' && error.trim().length > 0) return error
    if (isRecord(error)) {
      const nested = error.message ?? error.msg ?? error.detail
      if (typeof nested === 'string' && nested.trim().length > 0) return nested
    }
    const message = parsed.message ?? parsed.msg ?? parsed.error_description
    if (typeof message === 'string' && message.trim().length > 0) return message
  } catch {
    // Not JSON: fall through to the raw excerpt.
  }
  return null
}

/**
 * Normalize vendor HTTP failures into actionable, secret-free messages.
 * 401/403/429/5xx get dedicated wording so the UI can explain what to fix.
 */
export function normalizeProviderHttpError(
  vendor: string,
  status: number,
  body: string
): string {
  const detail = extractProviderErrorMessage(body)
  const excerpt = sanitizeErrorExcerpt(detail ?? body)
  const suffix = excerpt.length > 0 ? `：${excerpt}` : ''
  if (status === 401) {
    return `${vendor} 认证失败（401）：API Key 无效、已过期或没有权限，请在配置页检查凭据`
  }
  if (status === 403) {
    return `${vendor} 拒绝访问（403）：当前凭据无权使用该模型或接口${suffix}`
  }
  if (status === 404) {
    return `${vendor} 接口不存在（404）：请检查 Base URL 与模型 ID${suffix}`
  }
  if (status === 408) {
    return `${vendor} 请求超时（408），请稍后重试`
  }
  if (status === 429) {
    return `${vendor} 请求过于频繁或额度不足（429），请稍后重试或检查账户余额`
  }
  if (status >= 500 && status <= 599) {
    return `${vendor} 服务暂时不可用（${status}）${suffix}`
  }
  if (status === 400) {
    return `${vendor} 请求参数无效（400）${suffix}`
  }
  return `${vendor} 请求失败（${status}）${suffix}`
}

/* ------------------------------------------------------------------------- */
/* Shared parsing helpers for OpenAI-chat-style payloads                     */
/* ------------------------------------------------------------------------- */

export function toOpenAiMessages(
  messages: readonly ProviderChatMessage[]
): Array<{ role: string; content: string }> {
  return messages.map((message) => ({ role: message.role, content: message.content }))
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (!isRecord(part)) continue
    if (typeof part.text === 'string') parts.push(part.text)
  }
  return parts.length > 0 ? parts.join('') : null
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseOpenAiUsage(json: Record<string, unknown>): ProviderUsage | undefined {
  const usage = json.usage
  if (!isRecord(usage)) return undefined
  const inputTokens = numberOrUndefined(usage.prompt_tokens ?? usage.input_tokens)
  const outputTokens = numberOrUndefined(usage.completion_tokens ?? usage.output_tokens)
  const totalTokens = numberOrUndefined(usage.total_tokens)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return { inputTokens, outputTokens, totalTokens }
}

/**
 * Tolerant parser for OpenAI-compatible chat responses:
 * `choices[0].message.content` (string or content-parts), then legacy
 * `choices[0].text`, then common gateway wrappers.
 */
export function parseOpenAiStyleChatResponse(
  json: unknown,
  vendor: string
): ParsedProviderChat {
  if (!isRecord(json)) throw new Error(`${vendor}响应不是 JSON 对象`)
  const usage = parseOpenAiUsage(json)
  const choices = json.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0]
    if (isRecord(first)) {
      const message = first.message
      if (isRecord(message)) {
        const text = extractTextContent(message.content)
        if (text !== null) return { text, ...(usage === undefined ? {} : { usage }) }
      }
      if (typeof first.text === 'string') {
        return { text: first.text, ...(usage === undefined ? {} : { usage }) }
      }
    }
  }
  if (typeof json.output_text === 'string') {
    return { text: json.output_text, ...(usage === undefined ? {} : { usage }) }
  }
  if (typeof json.result === 'string') {
    return { text: json.result, ...(usage === undefined ? {} : { usage }) }
  }
  throw new Error(`${vendor}响应缺少 choices[0].message.content`)
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/**
 * Tolerant parser for OpenAI-style model lists: `{ data: [...] }` (canonical),
 * `{ models: [...] }`, a bare array, string arrays and `reasoning` markers.
 * Empty / unknown shapes return `[]` so the caller can fall back to manual.
 */
export function parseOpenAiStyleModelList(json: unknown): ModelOption[] {
  let items: unknown[] | null = null
  if (Array.isArray(json)) items = json
  else if (isRecord(json)) {
    if (Array.isArray(json.data)) items = json.data
    else if (Array.isArray(json.models)) items = json.models
    else if (Array.isArray(json.result)) items = json.result
  }
  if (items === null) return []
  const models: ModelOption[] = []
  for (const item of items) {
    if (typeof item === 'string') {
      const id = item.trim()
      if (id.length > 0) models.push({ id })
      continue
    }
    if (!isRecord(item)) continue
    const id = firstNonEmptyString(item.id, item.model, item.name)
    if (id === null) continue
    const label = firstNonEmptyString(item.display_name, item.displayName, item.label, item.name)
    const ownedBy = firstNonEmptyString(item.owned_by, item.ownedBy, item.owner)
    const model: ModelOption = { id }
    if (label !== null && label !== id) model.label = label
    if (ownedBy !== null) model.ownedBy = ownedBy
    models.push(model)
  }
  return models
}

/** Deduplicate by id and order deterministically; capping is caller policy. */
export function dedupeModelOptions(models: readonly ModelOption[]): ModelOption[] {
  const byId = new Map<string, ModelOption>()
  for (const model of models) {
    const id = model.id.trim()
    if (id.length === 0) continue
    const existing = byId.get(id)
    if (existing === undefined) {
      byId.set(id, { ...model, id })
      continue
    }
    if (existing.label === undefined && model.label !== undefined) {
      byId.set(id, { ...existing, label: model.label })
    }
    if (existing.ownedBy === undefined && model.ownedBy !== undefined) {
      byId.set(id, { ...existing, ownedBy: model.ownedBy })
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}
