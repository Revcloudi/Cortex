import { z } from 'zod'

/**
 * Raw HTTP request sent from the retest repeater or the standalone Web Fuzzer
 * (main-process proxy applies).
 */
export interface RepeaterSendInput {
  /**
   * Optional finding id. It is metadata for history/collections only and never
   * selects the target policy; the standalone Web Fuzzer omits it entirely.
   */
  vulnId?: string
  method: string
  /**
   * Relative path/query or absolute URL. The repeater resolves it against the
   * finding target; the standalone Web Fuzzer requires an absolute http(s) URL.
   */
  url: string
  headers: Record<string, string>
  body?: string
  followRedirects: boolean
}

export interface RepeaterSendResult {
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body: string
  }
  response: {
    status: number
    headers: Record<string, string>
    body: string
    durationMs: number
    truncated: boolean
  }
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export const RepeaterSendInputSchema = z
  .object({
    vulnId: z.string().trim().min(1).max(200).optional(),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    url: z.string().trim().min(1).max(8_000),
    headers: z
      .record(z.string(), z.string().max(16_384))
      .default({})
      .refine((headers) => Object.keys(headers).length <= 100, '请求头数量过多')
      .refine(
        (headers) => Object.keys(headers).every((name) => HEADER_NAME.test(name)),
        '请求头名称不合法'
      ),
    body: z.string().max(1_000_000).optional(),
    followRedirects: z.boolean().default(true)
  })
  .strict()

export type RepeaterSendInputParsed = z.infer<typeof RepeaterSendInputSchema>
