import type { Vulnerability } from '@shared/types'
import { getApi } from './api'

/**
 * Renderer-side cache so a detail sheet can render immediately from a
 * hover/focus prefetch while the fresh record is revalidated over IPC.
 */
const cache = new Map<string, Vulnerability>()

export function prefetchVulnerability(id: string): void {
  if (cache.has(id)) return
  const api = getApi()
  if (!api) return
  void api.getVulnerability(id).then(
    (vulnerability) => {
      if (vulnerability) cache.set(id, vulnerability)
    },
    () => undefined
  )
}

export function getPrefetchedVulnerability(id: string): Vulnerability | null {
  return cache.get(id) ?? null
}

export function invalidateVulnerabilityCache(): void {
  cache.clear()
}
