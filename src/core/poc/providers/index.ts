/**
 * Provider adapter registry.
 *
 * One independent adapter per preset: every id in `POC_PRESET_IDS` must resolve
 * here, and an unknown id is an explicit configuration error — never a silent
 * fallback to another vendor's client.
 */
import type { PocPresetId } from '../../../shared/poc'
import { POC_ERROR_CODES, createPocError } from '../../../shared/poc'
import type { ProviderAdapter } from './types'
import { createOpenAiCompatibleAdapter } from './openaiCompatible'
import { anthropicAdapter } from './anthropic'
import { hunyuanAdapter } from './hunyuan'
import { commonCodeAdapter } from './commoncode'
import { customAdapter } from './custom'

const ADAPTERS: Record<PocPresetId, ProviderAdapter> = {
  deepseek: createOpenAiCompatibleAdapter('deepseek'),
  glm: createOpenAiCompatibleAdapter('glm'),
  kimi: createOpenAiCompatibleAdapter('kimi'),
  claudecode: anthropicAdapter,
  openai: createOpenAiCompatibleAdapter('openai'),
  openrouter: createOpenAiCompatibleAdapter('openrouter'),
  commoncode: commonCodeAdapter,
  qwen: createOpenAiCompatibleAdapter('qwen'),
  hunyuan: hunyuanAdapter,
  custom: customAdapter
}

/** Resolve the adapter profile for a preset; unknown ids throw INVALID_CONFIG. */
export function getProviderAdapter(preset: PocPresetId): ProviderAdapter {
  const adapter = (ADAPTERS as Record<string, ProviderAdapter | undefined>)[preset]
  if (adapter === undefined) {
    throw createPocError(
      POC_ERROR_CODES.INVALID_CONFIG,
      `未知的 AI 提供商标识：${String(preset)}`
    )
  }
  return adapter
}

/** Convenience for the generator: does this preset accept `response_format`? */
export function supportsJsonMode(preset: PocPresetId): boolean {
  return getProviderAdapter(preset).supportsJsonMode
}

export { createOpenAiCompatibleAdapter, type OpenAiVendorPreset } from './openaiCompatible'
export { anthropicAdapter, ANTHROPIC_DEFAULT_API_VERSION } from './anthropic'
export { hunyuanAdapter, HUNYUAN_TC3_SUPPORTED } from './hunyuan'
export { commonCodeAdapter, COMMONCODE_MANUAL_MODEL_DISCOVERY } from './commoncode'
export { customAdapter, CUSTOM_MANUAL_MODEL_DISCOVERY } from './custom'
export * from './types'
