/**
 * Anthropic Messages adapter profile (Claude Code preset).
 *
 * Wire format differences from OpenAI that this profile owns:
 * - auth via `x-api-key` plus a required `anthropic-version` header;
 * - system prompt is a top-level `system` field, not a message;
 * - `POST {base}/v1/messages`, model discovery `GET {base}/v1/models`;
 * - there is no `response_format`; callers must extract JSON from the text.
 */
import type { ModelOption, PocProviderConfig } from '../../../shared/poc'
import type {
  ParsedProviderChat,
  ProviderAdapter,
  ProviderChatMessage,
  ProviderChatOptions,
  ProviderChatRequest,
  ProviderModelListRequest,
  ProviderUsage
} from './types'
import {
  dedupeModelOptions,
  getPocPreset,
  isRecord,
  joinProviderUrl,
  normalizeProviderHttpError,
  requireCredential,
  requireProviderBaseUrl,
  requireProviderModel
} from './types'

export const ANTHROPIC_DEFAULT_API_VERSION = '2023-06-01'

/** Anthropic docs/version headers must never be empty; preset provides fallback. */
function resolveApiVersion(provider: PocProviderConfig): string {
  const explicit = provider.apiVersion?.trim() ?? ''
  if (explicit.length > 0) return explicit
  const presetVersion = getPocPreset('claudecode').apiVersion?.trim() ?? ''
  return presetVersion.length > 0 ? presetVersion : ANTHROPIC_DEFAULT_API_VERSION
}

/** Accept both `https://api.anthropic.com` and `.../v1` as Base URL. */
function messagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/v1') ? joinProviderUrl(base, '/messages') : joinProviderUrl(base, '/v1/messages')
}

function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/v1') ? joinProviderUrl(base, '/models') : joinProviderUrl(base, '/v1/models')
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!isRecord(block)) continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length > 0 ? parts.join('') : null
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseUsage(json: Record<string, unknown>): ProviderUsage | undefined {
  const usage = json.usage
  if (!isRecord(usage)) return undefined
  const inputTokens = numberOrUndefined(usage.input_tokens ?? usage.prompt_tokens)
  const outputTokens = numberOrUndefined(usage.output_tokens ?? usage.completion_tokens)
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return { inputTokens, outputTokens, totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }
}

export const anthropicAdapter: ProviderAdapter = {
  preset: 'claudecode',
  supportsJsonMode: false,
  buildChatRequest(
    provider: PocProviderConfig,
    messages: readonly ProviderChatMessage[],
    options?: ProviderChatOptions
  ): ProviderChatRequest {
    const baseUrl = requireProviderBaseUrl(provider)
    const apiKey = requireCredential(provider, 'apiKey')
    const model = requireProviderModel(provider)
    const systemParts: string[] = []
    const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const message of messages) {
      if (message.role === 'system') {
        systemParts.push(message.content)
        continue
      }
      chatMessages.push({ role: message.role, content: message.content })
    }
    const body: Record<string, unknown> = {
      model,
      ...(options?.maxTokens !== 0 ? { max_tokens: options?.maxTokens ?? provider.maxOutputTokens } : {}),
      temperature: options?.temperature ?? 0.1,
      messages: chatMessages,
      stream: false
    }
    if (systemParts.length > 0) body.system = systemParts.join('\n\n')
    return {
      url: messagesUrl(baseUrl),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': resolveApiVersion(provider)
      },
      body: JSON.stringify(body)
    }
  },
  parseChatResponse(json: unknown): ParsedProviderChat {
    if (!isRecord(json)) throw new Error('Claude（Anthropic）响应不是 JSON 对象')
    const usage = parseUsage(json)
    // Tolerant extraction: content blocks, plain string content, then legacy fields.
    const text = extractText(json.content) ?? extractText(json.completion) ?? extractText(json.text)
    if (text !== null) return { text, ...(usage === undefined ? {} : { usage }) }
    throw new Error('Claude（Anthropic）响应缺少 content 文本块')
  },
  listModelsRequest(provider: PocProviderConfig): ProviderModelListRequest {
    const baseUrl = requireProviderBaseUrl(provider)
    const apiKey = requireCredential(provider, 'apiKey')
    return {
      url: modelsUrl(baseUrl),
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': resolveApiVersion(provider)
      }
    }
  },
  parseModelList(json: unknown): ModelOption[] {
    if (!isRecord(json)) return []
    const items = Array.isArray(json.data)
      ? json.data
      : Array.isArray(json.models)
        ? json.models
        : []
    const models: ModelOption[] = []
    for (const item of items) {
      if (typeof item === 'string') {
        const id = item.trim()
        if (id.length > 0) models.push({ id })
        continue
      }
      if (!isRecord(item)) continue
      const rawId = item.id ?? item.model ?? item.name
      const id = typeof rawId === 'string' ? rawId.trim() : ''
      if (id.length === 0) continue
      const label =
        typeof item.display_name === 'string' && item.display_name.trim().length > 0
          ? item.display_name.trim()
          : typeof item.displayName === 'string' && item.displayName.trim().length > 0
            ? item.displayName.trim()
            : undefined
      const ownedBy =
        typeof item.owned_by === 'string' && item.owned_by.trim().length > 0
          ? item.owned_by.trim()
          : undefined
      const model: ModelOption = { id }
      if (label !== undefined && label !== id) model.label = label
      if (ownedBy !== undefined) model.ownedBy = ownedBy
      models.push(model)
    }
    return dedupeModelOptions(models)
  },
  normalizeError(status: number, body: string): string {
    return normalizeProviderHttpError('Claude（Anthropic）', status, body)
  }
}
