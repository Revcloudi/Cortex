/**
 * OpenAI-compatible vendor profiles: DeepSeek / GLM / Kimi / OpenAI /
 * OpenRouter / Qwen.
 *
 * These vendors happen to share the OpenAI Chat Completions wire format, but
 * each one still gets its own profile object (auth headers, endpoint paths,
 * JSON-mode capability, attribution headers). There is no shared client class:
 * a missing profile is a hard config error rather than a silent fallback.
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
  getPocPreset,
  joinProviderUrl,
  normalizeProviderHttpError,
  parseOpenAiStyleChatResponse,
  parseOpenAiStyleModelList,
  requireCredential,
  requireProviderBaseUrl,
  requireProviderModel,
  toOpenAiMessages
} from './types'

export type OpenAiVendorPreset = 'deepseek' | 'glm' | 'kimi' | 'openai' | 'openrouter' | 'qwen'

interface OpenAiCompatibleProfile {
  readonly preset: OpenAiVendorPreset
  readonly chatPath: string
  readonly modelsPath: string
  readonly supportsJsonMode: boolean
  /**
   * Constant attribution headers only (never user-controlled, never secret).
   * OpenRouter wants an HTTP-Referer and an X-Title for dashboard attribution.
   */
  readonly attributionHeaders?: Readonly<Record<string, string>>
}

const PROFILES: Record<OpenAiVendorPreset, OpenAiCompatibleProfile> = {
  deepseek: {
    preset: 'deepseek',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    supportsJsonMode: true
  },
  glm: {
    preset: 'glm',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    supportsJsonMode: true
  },
  kimi: {
    preset: 'kimi',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    supportsJsonMode: true
  },
  openai: {
    preset: 'openai',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    supportsJsonMode: true
  },
  openrouter: {
    preset: 'openrouter',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    supportsJsonMode: true,
    attributionHeaders: {
      'HTTP-Referer': 'https://github.com/Revcloudi/Cortex',
      'X-Title': 'Cortex'
    }
  },
  qwen: {
    preset: 'qwen',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    supportsJsonMode: true
  }
}

/** Every vendor handled by this profile family (exported for coverage tests). */
export const OPENAI_COMPATIBLE_VENDOR_PRESETS: readonly OpenAiVendorPreset[] = [
  'deepseek',
  'glm',
  'kimi',
  'openai',
  'openrouter',
  'qwen'
]

function buildHeaders(apiKey: string, extra?: Readonly<Record<string, string>>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`,
    ...extra
  }
}

function buildChatRequest(
  profile: OpenAiCompatibleProfile,
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
  if (profile.supportsJsonMode && options?.jsonMode === true) {
    body.response_format = { type: 'json_object' }
  }
  return {
    url: joinProviderUrl(baseUrl, profile.chatPath),
    method: 'POST',
    headers: buildHeaders(apiKey, profile.attributionHeaders),
    body: JSON.stringify(body)
  }
}

/**
 * Create the independent adapter profile for one OpenAI-compatible vendor.
 * Unknown vendor ids fail fast instead of borrowing another vendor's profile.
 */
export function createOpenAiCompatibleAdapter(preset: OpenAiVendorPreset): ProviderAdapter {
  const profile = PROFILES[preset]
  if (profile === undefined) {
    throw new Error(`Unsupported OpenAI-compatible preset: ${String(preset)}`)
  }
  const vendor = getPocPreset(profile.preset).label
  return {
    preset: profile.preset,
    supportsJsonMode: profile.supportsJsonMode,
    buildChatRequest(provider, messages, options): ProviderChatRequest {
      return buildChatRequest(profile, provider, messages, options)
    },
    parseChatResponse(json: unknown): ParsedProviderChat {
      return parseOpenAiStyleChatResponse(json, vendor)
    },
    listModelsRequest(provider: PocProviderConfig): ProviderModelListRequest {
      const baseUrl = requireProviderBaseUrl(provider)
      const apiKey = requireCredential(provider, 'apiKey')
      return {
        url: joinProviderUrl(baseUrl, profile.modelsPath),
        headers: buildHeaders(apiKey, profile.attributionHeaders)
      }
    },
    parseModelList(json: unknown): ModelOption[] {
      return dedupeModelOptions(parseOpenAiStyleModelList(json))
    },
    normalizeError(status: number, body: string): string {
      return normalizeProviderHttpError(vendor, status, body)
    }
  }
}
