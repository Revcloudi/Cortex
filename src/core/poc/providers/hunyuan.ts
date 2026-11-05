/**
 * Tencent Hunyuan adapter profile.
 *
 * Hunyuan exposes an OpenAI-compatible HTTP entry for API-Key customers
 * (`Authorization: Bearer <apiKey>`, `{base}/chat/completions`). This profile
 * targets that documented gateway only.
 *
 * OUT OF SCOPE for v1: Tencent Cloud TC3-HMAC-SHA256 request signing
 * (SecretId/SecretKey). Implementing TC3 requires canonical-request signing and
 * clock-skew handling that the shared `PocProviderConfig` does not model yet, so
 * it is documented as a limitation instead of being half-implemented. Model
 * discovery is best-effort: many Hunyuan gateways do not expose `/models`, and
 * the UI always keeps manual model-ID entry available.
 */
import type { ModelOption, PocProviderConfig } from '../../../shared/poc'
import type {
  ParsedProviderChat,
  ProviderAdapter,
  ProviderChatMessage,
  ProviderChatOptions,
  ProviderChatRequest,
  ProviderModelListRequest
} from './types'
import {
  dedupeModelOptions,
  joinProviderUrl,
  normalizeProviderHttpError,
  parseOpenAiStyleChatResponse,
  parseOpenAiStyleModelList,
  requireCredential,
  requireProviderBaseUrl,
  requireProviderModel,
  toOpenAiMessages
} from './types'

const VENDOR_LABEL = '混元（腾讯）'

export const HUNYUAN_TC3_SUPPORTED = false

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`
  }
}

export const hunyuanAdapter: ProviderAdapter = {
  preset: 'hunyuan',
  // Hunyuan's OpenAI-compatible gateway does not consistently support
  // `response_format`; the generator falls back to text JSON extraction.
  supportsJsonMode: false,
  buildChatRequest(
    provider: PocProviderConfig,
    messages: readonly ProviderChatMessage[],
    options?: ProviderChatOptions
  ): ProviderChatRequest {
    const baseUrl = requireProviderBaseUrl(provider)
    const apiKey = requireCredential(provider, 'apiKey')
    const model = requireProviderModel(provider)
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAiMessages(messages),
      temperature: options?.temperature ?? 0.1,
      ...(options?.maxTokens !== 0 ? { max_tokens: options?.maxTokens ?? provider.maxOutputTokens } : {}),
      stream: false
    }
    return {
      url: joinProviderUrl(baseUrl, '/chat/completions'),
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body)
    }
  },
  parseChatResponse(json: unknown): ParsedProviderChat {
    return parseOpenAiStyleChatResponse(json, VENDOR_LABEL)
  },
  /**
   * Best effort only: the caller treats failures/empty lists as "manual model
   * entry", never as a silent default model.
   */
  listModelsRequest(provider: PocProviderConfig): ProviderModelListRequest {
    const baseUrl = requireProviderBaseUrl(provider)
    const apiKey = requireCredential(provider, 'apiKey')
    return {
      url: joinProviderUrl(baseUrl, '/models'),
      headers: authHeaders(apiKey)
    }
  },
  parseModelList(json: unknown): ModelOption[] {
    return dedupeModelOptions(parseOpenAiStyleModelList(json))
  },
  normalizeError(status: number, body: string): string {
    return normalizeProviderHttpError(VENDOR_LABEL, status, body)
  }
}
