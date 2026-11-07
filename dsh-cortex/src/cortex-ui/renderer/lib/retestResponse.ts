/**
 * Response formatting helpers for the retest repeater (Yakit/Burp-style JSON
 * view). Kept away from the TSX component so they are unit-testable.
 */

/** Pretty-print JSON bodies; null when the body is not JSON. */
export function prettyJsonBody(body: string, contentType: string): string | null {
  const trimmed = body.trim()
  if (trimmed.length === 0) return null
  if (!/json/i.test(contentType) && !/^[{[]/.test(trimmed)) return null
  if (trimmed.length > 2_000_000) return null
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return null
  }
}
