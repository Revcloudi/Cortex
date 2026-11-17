/**
 * Same-origin client for the internal-operations delete routes.
 *
 * These routes are plugin additions (the vendored `CortexApi` only exposes the
 * read projections), so the UI calls them directly instead of widening the
 * shared IPC surface.
 */

const API_BASE = '/cortex-api/cortex'

export type InternalEntityKind = 'hosts' | 'services' | 'footholds' | 'credentials' | 'pivots'

export class InternalAdminError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'InternalAdminError'
    this.code = code
    this.status = status
  }
}

export async function deleteInternalEntity(
  kind: InternalEntityKind,
  id: string
): Promise<{ deleted: boolean; id: string }> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/internal/${kind}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    })
  } catch (cause) {
    throw new InternalAdminError(
      'NETWORK_ERROR',
      cause instanceof Error ? cause.message : String(cause),
      0
    )
  }
  const text = await response.text().catch(() => '')
  let payload: any = null
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  if (!response.ok) {
    throw new InternalAdminError(
      (payload && payload.code) || `HTTP_${response.status}`,
      (payload && (payload.error || payload.message)) || `HTTP ${response.status}`,
      response.status
    )
  }
  return payload
}
