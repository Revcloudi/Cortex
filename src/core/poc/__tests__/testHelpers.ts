/**
 * Shared test helpers for the PoC provider/config/generator tests.
 *
 * These tests run with `npx tsx --test "src/core/poc/__tests__/*.test.ts"`.
 * No npm packages are added: only Node built-ins and the global `fetch` /
 * `Response` implementations from Node 22+ are used.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HubLogger } from '../../logging'

/* ------------------------------------------------------------------------- */
/* Capturing logger (asserts that no credential is ever logged)              */
/* ------------------------------------------------------------------------- */

export interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta: unknown[]
}

export interface CapturingLogger extends HubLogger {
  entries: CapturedLog[]
  /** Serialized form of every log call; assert secrets are absent. */
  text(): string
}

function serializeMeta(meta: unknown[]): string {
  try {
    return JSON.stringify(meta)
  } catch {
    return String(meta)
  }
}

export function createCapturingLogger(): CapturingLogger {
  const entries: CapturedLog[] = []
  const push =
    (level: CapturedLog['level']) =>
    (message: string, ...meta: unknown[]): void => {
      entries.push({ level, message, meta })
    }
  return {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    text(): string {
      return entries.map((entry) => `${entry.message} ${serializeMeta(entry.meta)}`).join('\n')
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Temp workspace                                                             */
/* ------------------------------------------------------------------------- */

export interface TempWorkspace {
  dir: string
  dbPath: string
  configPath: string
  dispose(): void
}

export function createTempWorkspace(prefix = 'cortex-poc-test-'): TempWorkspace {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    dbPath: join(dir, 'data.db'),
    configPath: join(dir, 'config.json'),
    dispose(): void {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/* ------------------------------------------------------------------------- */
/* fetch doubles                                                             */
/* ------------------------------------------------------------------------- */

export interface FetchCall {
  url: string
  init: RequestInit | undefined
}

export type FetchHandler = (
  url: string,
  init: RequestInit | undefined
) => Response | Promise<Response>

export interface SequenceFetch {
  fetchImpl: typeof fetch
  calls: FetchCall[]
}

/**
 * Deterministic fetch stub: the Nth call uses the Nth handler; after the list
 * is exhausted the last handler is reused.
 */
export function createSequenceFetch(handlers: readonly FetchHandler[]): SequenceFetch {
  const calls: FetchCall[] = []
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)]
    if (handler === undefined) throw new Error('createSequenceFetch: no handler registered')
    return handler(url, init)
  }) as typeof fetch
  return { fetchImpl, calls }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } })
}

/** OpenAI-compatible chat completion wrapper around arbitrary assistant text. */
export function completionResponse(content: string, status = 200): Response {
  return jsonResponse(
    {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    },
    status
  )
}

/* ------------------------------------------------------------------------- */
/* Error assertions                                                          */
/* ------------------------------------------------------------------------- */

export async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

/** Assert an error is a coded PoC error (`POC_XXX: message`). */
export function expectPocError(
  error: unknown,
  code: string,
  messageIncludes?: string
): asserts error is Error {
  if (!(error instanceof Error)) {
    throw new Error(`expected a PoC error (${code}), got: ${String(error)}`)
  }
  if (!error.message.startsWith(`${code}:`)) {
    throw new Error(`expected ${code}, got: ${error.message}`)
  }
  if (messageIncludes !== undefined && !error.message.includes(messageIncludes)) {
    throw new Error(`expected message to include "${messageIncludes}", got: ${error.message}`)
  }
}

export function captureSyncThrow(fn: () => unknown): unknown {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}
