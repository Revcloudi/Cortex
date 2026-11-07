/**
 * Database setup API for environments where the Host cannot open the default
 * `~/.cortex/data.db` (notably a Web DSH server running as another user or in
 * a sandbox). The browser cannot read local files, so the Host must be pointed
 * at a Cortex v5 SQLite file it can read.
 */

const BASE = '/cortex-api/cortex'

export interface DatabaseStatus {
  dbPath: string
  schemaVersion: number
  compatible: boolean
  exists: boolean
  sizeBytes: number
  walSizeBytes: number
  lastModifiedAt: string | null
  readOnly: boolean
  readOnlyFallback: boolean
  openError: string | null
}

export interface ProbeFailure {
  message: string
  detail: string | null
  code: string | null
}

export interface DatabaseCandidate {
  id: string
  label: string
  exists: boolean
  sizeBytes: number
}

export interface DatabaseCandidates {
  platform: string
  defaultPath: string
  candidates: DatabaseCandidate[]
}

export class DatabaseApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'DatabaseApiError'
    this.code = code
    this.status = status
  }
}

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => '')
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Force the Host to open the DB (a data route) and report the failure detail. */
export async function probeDatabase(): Promise<{ ok: true } | { ok: false; failure: ProbeFailure }> {
  try {
    const response = await fetch(`${BASE}/stats?realm=web`, { cache: 'no-store' })
    if (response.ok) return { ok: true }
    const payload = await readEnvelope(response)
    const message =
      (typeof payload.error === 'string' && payload.error) ||
      (typeof payload.message === 'string' && payload.message) ||
      `HTTP ${response.status}`
    const details =
      payload.details !== null && typeof payload.details === 'object'
        ? (payload.details as Record<string, unknown>)
        : {}
    return {
      ok: false,
      failure: {
        message,
        detail: typeof details.error === 'string' ? details.error : null,
        code: typeof payload.code === 'string' ? payload.code : null
      }
    }
  } catch (cause) {
    return {
      ok: false,
      failure: {
        message: cause instanceof Error ? cause.message : String(cause),
        detail: null,
        code: 'NETWORK_ERROR'
      }
    }
  }
}

export async function getDatabaseStatus(): Promise<DatabaseStatus> {
  const response = await fetch(`${BASE}/db/info`, { cache: 'no-store' })
  const payload = await readEnvelope(response)
  if (!response.ok) {
    throw new DatabaseApiError(
      typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
      typeof payload.code === 'string' ? payload.code : `HTTP_${response.status}`,
      response.status
    )
  }
  const status = payload as unknown as Partial<DatabaseStatus>
  return {
    dbPath: typeof status.dbPath === 'string' ? status.dbPath : '',
    schemaVersion: typeof status.schemaVersion === 'number' ? status.schemaVersion : 0,
    compatible: status.compatible === true,
    exists: status.exists === true,
    sizeBytes: typeof status.sizeBytes === 'number' ? status.sizeBytes : 0,
    walSizeBytes: typeof status.walSizeBytes === 'number' ? status.walSizeBytes : 0,
    lastModifiedAt: typeof status.lastModifiedAt === 'string' ? status.lastModifiedAt : null,
    readOnly: status.readOnly === true,
    readOnlyFallback: status.readOnlyFallback === true,
    openError: typeof status.openError === 'string' ? status.openError : null
  }
}

export async function configureDatabase(path: string): Promise<DatabaseStatus> {
  const response = await fetch(`${BASE}/db/configure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ path })
  })
  const payload = await readEnvelope(response)
  if (!response.ok) {
    throw new DatabaseApiError(
      typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
      typeof payload.code === 'string' ? payload.code : `HTTP_${response.status}`,
      response.status
    )
  }
  const status = payload as unknown as Partial<DatabaseStatus>
  return {
    dbPath: typeof status.dbPath === 'string' ? status.dbPath : '',
    schemaVersion: typeof status.schemaVersion === 'number' ? status.schemaVersion : 0,
    compatible: status.compatible === true,
    exists: status.exists === true,
    sizeBytes: typeof status.sizeBytes === 'number' ? status.sizeBytes : 0,
    walSizeBytes: typeof status.walSizeBytes === 'number' ? status.walSizeBytes : 0,
    lastModifiedAt: typeof status.lastModifiedAt === 'string' ? status.lastModifiedAt : null,
    readOnly: status.readOnly === true,
    readOnlyFallback: status.readOnlyFallback === true,
    openError: typeof status.openError === 'string' ? status.openError : null
  }
}

/**
 * Candidate checks are cheap on the Host (file stat only); labels stay in
 * `~` form so the UI works on Windows, macOS and Linux and does not expose an
 * absolute server path.
 */
export async function getDatabaseCandidates(): Promise<DatabaseCandidates> {
  const response = await fetch(`${BASE}/db/candidates`, { cache: 'no-store' })
  const payload = await readEnvelope(response)
  if (!response.ok) {
    throw new DatabaseApiError(
      typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
      typeof payload.code === 'string' ? payload.code : `HTTP_${response.status}`,
      response.status
    )
  }
  const rawCandidates = Array.isArray(payload.candidates) ? payload.candidates : []
  return {
    platform: typeof payload.platform === 'string' ? payload.platform : '',
    defaultPath: typeof payload.defaultPath === 'string' ? payload.defaultPath : '~/.cortex/data.db',
    candidates: rawCandidates
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        label: typeof entry.label === 'string' ? entry.label : '',
        exists: entry.exists === true,
        sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : 0
      }))
      .filter((entry) => entry.id !== '' && entry.label !== '')
  }
}
