/**
 * Custom provider adapter profile (OpenAI-compatible, user supplied Base URL).
 *
 * This exists for vendors that are not in the preset table. Safety constraints:
 * - Base URL is required and must be http(s);
 * - only the documented OpenAI-compatible chat route is used (`/chat/completions`);
 * - `/models` is not assumed, so model selection is manual;
 * - headers/body are built exclusively from the strict `PocProviderConfig`
 *   allowlist — no arbitrary headers, path templates, scripts or `eval`.
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

const VENDOR_LABEL = '自定义 OpenAI-compatible'

export const CUSTOM_MANUAL_MODEL_DISCOVERY = true

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`
  }
}

export const customAdapter: ProviderAdapter = {
  preset: 'custom',
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
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body)
    }
  },
  parseChatResponse(json: unknown): ParsedProviderChat {
    return parseOpenAiStyleChatResponse(json, VENDOR_LABEL)
  },
  /** Manual model discovery: custom gateways have no assumed list endpoint. */
  listModelsRequest(): ProviderModelListRequest | null {
    return null
  },
  parseModelList(json: unknown): ModelOption[] {
    return dedupeModelOptions(parseOpenAiStyleModelList(json))
  },
  normalizeError(status: number, body: string): string {
    return normalizeProviderHttpError(VENDOR_LABEL, status, body)
  }
}
