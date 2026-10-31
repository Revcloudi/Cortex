import type { ZodError } from 'zod'
import { DatabaseError } from '../core/db/DatabaseService'
import { formatZodError } from '../shared/validation'

/**
 * HTTP error mapping for the Web API.
 *
 * The renderer shows these messages, so they must stay user-safe: no SQL, no
 * absolute paths, no stack traces and no internal identifiers. Validation
 * errors name the offending field (the same text the desktop IPC bridge uses).
 */

/** A route-level failure with an intentional status and a user-safe message. */
export class WebApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'WebApiError'
    this.status = status
  }
}

/** 400 for a failed zod validation: `<scope>: field: reason; field2: reason`. */
export function invalidInput(scope: string, error: ZodError): WebApiError {
  return new WebApiError(400, `${scope}: ${formatZodError(error)}`)
}

/** 404 helper for routes that address a row by path parameter. */
export function notFound(message: string): WebApiError {
  return new WebApiError(404, message)
}

export interface HttpErrorPayload {
  status: number
  message: string
  /** Message is safe to send to the client as JSON `error`. */
  expose: boolean
}

/**
 * Map an arbitrary thrown value to a safe HTTP response.
 *
 * `DatabaseError` messages are localized user-facing statements that never
 * contain SQL or file paths; internal failures collapse to a generic 500 so no
 * implementation detail leaks over the wire.
 */
export function toHttpError(error: unknown): HttpErrorPayload {
  if (error instanceof WebApiError) {
    return { status: error.status, message: error.message, expose: true }
  }
  if (error instanceof DatabaseError) {
    if (error.code === 'NOT_FOUND') {
      return { status: 404, message: error.message, expose: true }
    }
    if (error.code === 'INVALID_INPUT') {
      return { status: 400, message: error.message, expose: true }
    }
    if (error.code === 'STALE') {
      return { status: 409, message: error.message, expose: true }
    }
    return { status: 500, message: 'Internal database error', expose: false }
  }
  // better-sqlite3 wraps SQLite errors in plain Error instances carrying a code.
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  if (code === 'SQLITE_READONLY' || code === 'SQLITE_READONLY_DBMOVED') {
    return {
      status: 403,
      message:
        'The database was opened read-only by the Web server; this action needs write permission on the SQLite file.',
      expose: true
    }
  }
  return { status: 500, message: 'Internal server error', expose: false }
}
