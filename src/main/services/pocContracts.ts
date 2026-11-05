/**
 * Main-process contracts for AI model configuration and the retest repeater.
 *
 * The generated-JS sandbox pipeline and its `poc_artifacts` / `poc_runs` storage
 * were removed in schema v5. Only provider/model settings, the retest proxy and
 * the raw HTTP bridge remain.
 */
import type { HubLogger } from '../../core/logging'
import type {
  ListPocModelsInput,
  ListPocModelsResult,
  PocConfigView,
  PocExecutionLimits,
  PocProviderConfig,
  SavePocConfigInput,
  TestPocProviderResult,
  UpsertPocProviderInput
} from '../../shared/poc'

export type PocLogger = HubLogger

/* ------------------------------------------------------------------------- */
/* HTTP bridge (main process only; owns proxy auth / TLS / allowlist)        */
/* ------------------------------------------------------------------------- */

export type PocHttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

export interface PocHttpRequest {
  method: PocHttpMethod
  /** Relative path or absolute URL; absolute URLs must stay on an allowed origin. */
  url: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Default true. Set false to inspect a 3xx response. */
  followRedirects?: boolean
}

export interface PocHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
  durationMs: number
  truncated: boolean
}

/** Full proxy configuration with credentials. Stays in the main process. */
export interface PocProxyRuntimeConfig {
  enabled: boolean
  url: string
  username: string
  password: string
  caPath: string
  allowInsecureTls: boolean
}

export interface PocHttpBridgeOptions {
  /** Exactly the vulnerability target origin(s); nothing else is reachable. */
  allowedOrigins: readonly string[]
  proxy: PocProxyRuntimeConfig | null
  limits: PocExecutionLimits
  logger: PocLogger
}

export interface PocHttpBridge {
  request(request: PocHttpRequest, signal: AbortSignal): Promise<PocHttpResponse>
  readonly requestCount: number
  dispose(): void
}

/* ------------------------------------------------------------------------- */
/* Config service                                                            */
/* ------------------------------------------------------------------------- */

export interface PocConfigService {
  /** Absolute path of `dirname(data.db)/config.json`. */
  readonly configPath: string
  view(): PocConfigView
  reload(): PocConfigView
  save(input: SavePocConfigInput): PocConfigView
  upsertProvider(input: UpsertPocProviderInput): PocConfigView
  removeProvider(id: string): PocConfigView
  /** Uses the just-typed credentials or the saved provider's credentials. */
  listModels(input: ListPocModelsInput): Promise<ListPocModelsResult>
  testProvider(id: string): Promise<TestPocProviderResult>
  /** Main-process only: includes credentials, baseUrl resolved to preset default. */
  getActiveProvider(): PocProviderConfig | null
  /** Main-process only: includes proxy username/password. */
  getProxyRuntime(): PocProxyRuntimeConfig | null
  getExecutionLimits(): PocExecutionLimits
}
