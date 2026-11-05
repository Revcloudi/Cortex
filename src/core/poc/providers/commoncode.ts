/**
 * CommonCode adapter profile (reserved preset).
 *
 * The vendor's public interface format is not confirmed by the design doc, so
 * this preset is intentionally conservative:
 * - user MUST supply an explicit http(s) Base URL (there is no guessed default);
 * - chat uses the OpenAI-compatible shape as a reserved placeholder;
 * - model discovery is manual (`/models` is not assumed to exist);
 * - only the fixed set of `PocProviderConfig` fields is used to build requests:
 *   there is no user-supplied header/body/path template and no code evaluation.
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

const VENDOR_LABEL = 'CommonCode'

export const COMMONCODE_MANUAL_MODEL_DISCOVERY = true

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`
  }
}

export const commonCodeAdapter: ProviderAdapter = {
  preset: 'commoncode',
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
  /** Manual model entry only: the reserved preset must not guess endpoints. */
  listModelsRequest(): ProviderModelListRequest | null {
    return null
  },
  /** Kept for symmetry with the adapter contract; manual entry is the path. */
  parseModelList(json: unknown): ModelOption[] {
    return dedupeModelOptions(parseOpenAiStyleModelList(json))
  },
  normalizeError(status: number, body: string): string {
    return normalizeProviderHttpError(VENDOR_LABEL, status, body)
  }
}
