import { z } from 'zod'
import type { VulnerabilityListItem } from './types'

/**
 * Internal operations domain (Plan B).
 *
 * Pure TypeScript + zod on purpose: no Node, Electron, React or SQLite imports,
 * so the renderer, the main process, the CLI and the MCP stdio server all share
 * the exact same contract. The only cross-module types are type-only imports
 * from `./types` (erased at build time), which keeps the runtime dependency
 * graph acyclic.
 *
 * Realm model: Web assets stay in `assets`, internal entities live in their own
 * tables and are bound to a Web entry asset through a `Foothold`. Everything is
 * scoped by `project_name`; nothing internal is ever promoted to a top-level
 * Web asset.
 */

/* ------------------------------------------------------------------ enums -- */

export const REALMS = ['web', 'internal'] as const
export type Realm = (typeof REALMS)[number]

/** UI / query filter: `all` keeps the legacy cross-domain behavior. */
export const REALM_FILTERS = ['web', 'internal', 'all'] as const
export type RealmFilter = (typeof REALM_FILTERS)[number]

export const FOOTHOLD_ACCESS_TYPES = [
  'rce',
  'webshell',
  'ssrf_proxy',
  'credential',
  'vpn',
  'other'
] as const
export type FootholdAccessType = (typeof FOOTHOLD_ACCESS_TYPES)[number]

export const FOOTHOLD_STATUSES = ['planned', 'established', 'degraded', 'lost'] as const
export type FootholdStatus = (typeof FOOTHOLD_STATUSES)[number]

export const PRIVILEGE_LEVELS = ['user', 'admin', 'system', 'domain_admin', 'unknown'] as const
export type PrivilegeLevel = (typeof PRIVILEGE_LEVELS)[number]

export const INTERNAL_HOST_STATES = [
  'unknown',
  'alive',
  'compromised',
  'unreachable',
  'firewalled'
] as const
export type InternalHostState = (typeof INTERNAL_HOST_STATES)[number]

export const SERVICE_STATES = ['open', 'closed', 'filtered', 'unknown'] as const
export type ServiceState = (typeof SERVICE_STATES)[number]

export const CREDENTIAL_TYPES = [
  'password',
  'ntlm_hash',
  'netntlmv2',
  'kerberos_ticket',
  'ssh_key',
  'cert',
  'api_key',
  'other'
] as const
export type CredentialType = (typeof CREDENTIAL_TYPES)[number]

export const CREDENTIAL_STATUSES = ['untested', 'valid', 'invalid', 'expired'] as const
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number]

export const CREDENTIAL_TRIAL_STATUSES = ['attempted', 'success', 'failed', 'blocked'] as const
export type CredentialTrialStatus = (typeof CREDENTIAL_TRIAL_STATUSES)[number]

export const PIVOT_KINDS = ['chain', 'proxy'] as const
export type PivotKind = (typeof PIVOT_KINDS)[number]

export const PIVOT_STATUSES = ['planned', 'established', 'degraded', 'lost'] as const
export type PivotStatus = (typeof PIVOT_STATUSES)[number]

export const PIVOT_HOP_REF_KINDS = ['internal_host', 'internal_service'] as const
export type PivotHopRefKind = (typeof PIVOT_HOP_REF_KINDS)[number]

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number]

export const ENTITY_SOURCES = ['agent', 'loot', 'manual'] as const
export type EntitySource = string

export const LOOT_FORMATS = [
  'bloodhound-json',
  'secretsdump-text',
  'config-env',
  'generic-csv',
  'unknown'
] as const
export type LootFormat = (typeof LOOT_FORMATS)[number]

export const LOOT_IMPORT_STATUSES = ['queued', 'parsed', 'needs_review', 'failed'] as const
export type LootImportStatus = (typeof LOOT_IMPORT_STATUSES)[number]

/**
 * Per-project caps from the plan (§12). The graph/list builders clamp to these
 * and report `truncated` instead of silently dropping data.
 */
export const INTERNAL_LIMITS = {
  footholds: 100,
  hosts: 300,
  services: 1_000,
  credentials: 500,
  pivots: 100,
  hopsPerRoute: 20,
  reachableSubnetsPerPivot: 20,
  internalVulns: 300,
  lootImports: 100
} as const

/** Read projections use this many rows per entity before truncating. */
export const INTERNAL_SCOPE_SUMMARY_LIMIT = 50

/* ------------------------------------------------------------ entity ids -- */

export const INTERNAL_ID_PREFIXES = {
  foothold: 'FH-',
  internalHost: 'IH-',
  internalService: 'IS-',
  credential: 'CR-',
  pivot: 'PV-',
  lootImport: 'LT-'
} as const

export type InternalEntityKind =
  | 'footholds'
  | 'hosts'
  | 'services'
  | 'credentials'
  | 'pivots'

export const INTERNAL_ENTITY_KINDS: readonly InternalEntityKind[] = [
  'footholds',
  'hosts',
  'services',
  'credentials',
  'pivots'
]

/**
 * Allocate a readable short id, e.g. `FH-3F9A2C71B4D0`. Uses the Web Crypto
 * `randomUUID` available in Node >= 22 and every browser; the fallback keeps
 * this module usable in constrained test environments.
 */
export function generateInternalId(prefix: string, now: Date = new Date()): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  const hex = (
    uuid !== undefined
      ? uuid.replace(/-/g, '')
      : `${now.getTime().toString(16)}${Math.random().toString(16).slice(2)}`
  )
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase()
  return `${prefix}${hex.slice(0, 12).padEnd(12, '0')}`
}

/* --------------------------------------------------------- IP / CIDR utils -- */

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    result = result * 256 + octet
  }
  return result >>> 0
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.')
}

function isValidIpv4(value: string): boolean {
  return ipv4ToInt(value) !== null
}

function isValidIpv6Group(group: string): boolean {
  return /^[0-9a-fA-F]{1,4}$/.test(group)
}

function isValidIpv6(value: string): boolean {
  if (value.length < 2 || value.length > 45) return false
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false
  const compressionCount = value.split('::').length - 1
  if (compressionCount > 1) return false

  const hasCompression = compressionCount === 1
  const [headRaw, tailRaw] = hasCompression ? value.split('::') : [value, '']
  const head = headRaw.length > 0 ? headRaw.split(':') : []
  const tail = hasCompression && tailRaw.length > 0 ? tailRaw.split(':') : []

  const v4Index = head.findIndex((group) => group.includes('.'))
  const tailV4Index = tail.findIndex((group) => group.includes('.'))
  let headGroups = head.length
  let tailGroups = tail.length
  let headV4Counts = 0
  let tailV4Counts = 0

  if (v4Index !== -1) {
    if (v4Index !== head.length - 1 || !isValidIpv4(head[v4Index] as string)) return false
    headGroups = head.length - 1 + 2
    headV4Counts = 1
  }
  if (tailV4Index !== -1) {
    if (tailV4Index !== tail.length - 1 || !isValidIpv4(tail[tailV4Index] as string)) return false
    tailGroups = tail.length - 1 + 2
    tailV4Counts = 1
  }

  for (const [index, group] of head.entries()) {
    if (headV4Counts === 1 && index === head.length - 1) continue
    if (!isValidIpv6Group(group)) return false
  }
  for (const [index, group] of tail.entries()) {
    if (tailV4Counts === 1 && index === tail.length - 1) continue
    if (!isValidIpv6Group(group)) return false
  }

  if (hasCompression) return headGroups + tailGroups <= 7
  return headGroups + tailGroups === 8
}

/** True for a plain IPv4 or IPv6 literal (no CIDR suffix, no brackets). */
export function isValidIp(value: string): boolean {
  const trimmed = value.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (trimmed.length === 0) return false
  return isValidIpv4(trimmed) || isValidIpv6(trimmed)
}

/** Parse one CIDR string; returns the normalized network or null when invalid. */
export function normalizeCidr(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0) return null
  const address = trimmed.slice(0, slash)
  const prefixText = trimmed.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefixText)) return null
  const prefix = Number(prefixText)

  if (isValidIpv4(address)) {
    if (prefix > 32) return null
    const addressInt = ipv4ToInt(address) as number
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return `${intToIpv4((addressInt & mask) >>> 0)}/${prefix}`
  }

  if (isValidIpv6(address)) {
    if (prefix > 128) return null
    // Keep the address text as typed (compression is display-only); lowercase it.
    return `${address}/${prefix}`
  }

  return null
}

/** True when `value` is a CIDR with a valid address family and prefix length. */
export function isValidCidr(value: string): boolean {
  return normalizeCidr(value) !== null
}

/**
 * Subnet bucket used by the heatmap: the host's own `subnet` when valid,
 * otherwise the derived /24 (IPv4) or /64 (IPv6) prefix. Unknown rows fall
 * back to the documented `unknown` bucket instead of pretending they are alive.
 */
export function deriveHostSubnet(ip: string, declaredSubnet = ''): string {
  const declared = declaredSubnet.trim()
  if (declared.length > 0) {
    const normalized = normalizeCidr(declared)
    if (normalized !== null) return normalized
  }
  const value = ip.trim()
  if (isValidIpv4(value)) {
    const addressInt = ipv4ToInt(value) as number
    return `${intToIpv4((addressInt & 0xffffff00) >>> 0)}/24`
  }
  if (isValidIpv6(value)) {
    const groups = value.split('::')
    const head = (groups[0] ?? '').split(':').filter((group) => group.length > 0)
    const padding = groups.length === 2 ? 4 : 0
    const prefixGroups = [...head, ...Array.from({ length: padding }, () => '0')].slice(0, 4)
    return `${(prefixGroups.join(':') || '0:0:0:0')}::/64`
  }
  return 'unknown'
}

/* --------------------------------------------------------- secret masking -- */

/**
 * Credential secrets are high sensitivity: everything the UI / MCP / CLI
 * receives is masked. Only a long single-line secret keeps its last 4 chars so
 * a human can recognize the record; multi-line material (SSH keys, tickets) is
 * fully hidden. Returns the empty string when there is no secret.
 */
export function maskSecret(secret: string): string {
  const value = secret.trim()
  if (value.length === 0) return ''
  if (value.includes('\n') || value.includes('\r')) return '••••••••••••'
  if (value.length < 12) return '•'.repeat(Math.max(6, Math.min(12, value.length)))
  return `${'•'.repeat(6)}${value.slice(-4)}`
}

/* ----------------------------------------------------------- output types -- */

export interface Foothold {
  id: string
  project_name: string
  /** `assets.host_port` of the entry Web asset. */
  entry_host_port: string
  /** Optional `vulnerabilities.id` of the initial-access finding. */
  entry_vuln_id: string
  access_type: FootholdAccessType
  privilege_level: PrivilegeLevel
  status: FootholdStatus
  evidence: string
  notes: string
  established_at: string
  last_verified_at: string
  created_at: string
  updated_at: string
  /** Internal hosts recorded as reachable from this foothold (`foothold_hosts`). */
  host_ids: string[]
}

export interface InternalHost {
  id: string
  project_name: string
  ip: string
  hostname: string
  os: string
  subnet: string
  state: InternalHostState
  source: string
  confidence: ConfidenceLevel
  last_seen: string
  created_at: string
  updated_at: string
  /** Derived: number of known services on this host. */
  service_count: number
}

export interface InternalService {
  id: string
  project_name: string
  host_id: string
  port: number
  protocol: string
  service: string
  banner: string
  state: ServiceState
  source: string
  last_seen: string
  created_at: string
  updated_at: string
  /** Derived: the owning host's IP / hostname (filled by read projections). */
  host_ip: string
  host_hostname: string
}

/**
 * Renderer/MCP facing credential. `secret` is never returned: only a masked
 * preview plus its length, so the UI can render "••••••1234" and a "有密钥"
 * hint without exposing the value.
 */
export interface Credential {
  id: string
  project_name: string
  type: CredentialType
  username: string
  domain: string
  secret_preview: string
  secret_length: number
  source: string
  host_id: string | null
  service_id: string | null
  confidence: ConfidenceLevel
  status: CredentialStatus
  notes: string
  created_at: string
  updated_at: string
}

export interface PivotHop {
  seq: number
  ref_kind: PivotHopRefKind
  ref_id: string
  label: string
  via: string
}

export interface Pivot {
  id: string
  project_name: string
  foothold_id: string
  kind: PivotKind
  local_host: string
  local_port: number
  local_protocol: string
  tool: string
  status: PivotStatus
  notes: string
  established_at: string
  last_verified_at: string
  created_at: string
  updated_at: string
}

export interface PivotWithHops extends Pivot {
  hops: PivotHop[]
  reachable_subnets: string[]
}

export interface CredentialTrial {
  id: string
  credential_id: string
  service_id: string | null
  action: string
  status: CredentialTrialStatus
  notes: string
  attempted_at: string
}

export interface LootImportSummary {
  hosts: number
  services: number
  credentials: number
  warnings: string[]
  needs_review: number
}

export interface LootImport {
  id: string
  project_name: string
  entry_host_port: string
  filename: string
  sha256: string
  format: LootFormat
  parser: string
  status: LootImportStatus
  summary: LootImportSummary
  error: string
  created_at: string
}

export interface InternalScopeCounts {
  footholds: number
  hosts: number
  services: number
  credentials: number
  pivots: number
}

export interface InternalCounts extends InternalScopeCounts {
  internal_vulns: number
  loot_imports: number
}

export interface InternalProjectSummary {
  project_name: string
  counts: InternalScopeCounts
}

/** Result of one `sync_internal_scope` call. */
export interface SyncInternalScopeResult {
  project_name: string
  created: Record<InternalEntityKind, number>
  updated: Record<InternalEntityKind, number>
  ids: Record<InternalEntityKind, string[]>
  warnings: string[]
}

/** Asset-scoped / project-scoped summary returned by `query_asset_context`. */
export interface InternalScopeSummary {
  counts: InternalScopeCounts
  footholds: Foothold[]
  hosts: InternalHost[]
  services: InternalService[]
  credentials?: Credential[]
  pivots: PivotWithHops[]
  /** True when any entity list was cut to `INTERNAL_SCOPE_SUMMARY_LIMIT`. */
  truncated: boolean
}

/* ------------------------------------------------------- derived views -- */

export interface CredentialSuggestion {
  /** Stable `${credential_id}::${service_id}` key. */
  id: string
  credential_id: string
  service_id: string
  host_id: string
  ip: string
  port: number
  service: string
  /** Protocol of the target service (`tcp` / `udp` / ...), for matrix columns. */
  protocol: string
  /** Deterministic rule that produced this candidate (i18n key in the UI). */
  rule: CredentialRuleId
  action: CredentialAction
  /** English fallback text for CLI / MCP JSON consumers. */
  reason: string
  caveat: string
  confidence: ConfidenceLevel
  /** Latest recorded trial for this credential × service pair, when any. */
  trial: CredentialTrial | null
}

export const CREDENTIAL_ACTIONS = [
  'pass_the_hash',
  'relay_or_crack',
  'login',
  'key_login',
  'ticket_use',
  'api_call'
] as const
export type CredentialAction = (typeof CREDENTIAL_ACTIONS)[number]

export const CREDENTIAL_RULES = [
  'ntlm_hash_smb',
  'netntlmv2_smb',
  'password_login',
  'ssh_key_ssh',
  'kerberos_ticket',
  'api_key_http'
] as const
export type CredentialRuleId = (typeof CREDENTIAL_RULES)[number]

export interface SubnetHeatmapHost {
  id: string
  ip: string
  hostname: string
  state: InternalHostState
  confidence: ConfidenceLevel
  service_count: number
  last_seen: string
}

export interface SubnetHeatmapBucket {
  subnet: string
  host_count: number
  service_count: number
  by_state: Record<InternalHostState, number>
  hosts: SubnetHeatmapHost[]
}

/**
 * Everything the internal operations page needs for its visualizations
 * (heatmap / credential matrix / route view). Bounded by `INTERNAL_LIMITS`.
 */
export interface InternalGraphData {
  project_name: string
  generated_at: string
  counts: InternalCounts
  footholds: Foothold[]
  hosts: InternalHost[]
  services: InternalService[]
  credentials: Credential[]
  pivots: PivotWithHops[]
  trials: CredentialTrial[]
  heatmap: SubnetHeatmapBucket[]
  suggestions: CredentialSuggestion[]
  truncated: boolean
  warnings: string[]
}

/** Home-page projection: counts, entity lists and the internal vulnerability list. */
export interface InternalOverview {
  project_name: string
  counts: InternalCounts
  footholds: Foothold[]
  hosts: InternalHost[]
  services: InternalService[]
  credentials: Credential[]
  pivots: PivotWithHops[]
  trials: CredentialTrial[]
  internal_vulns: VulnerabilityListItem[]
  loot_imports: LootImport[]
  warnings: string[]
  /** All projects that own at least one internal entity (overview selector). */
  projects: InternalProjectSummary[]
}

/* ------------------------------------------------------------ pure helpers -- */

const HTTP_SERVICE_HINTS = new Set(['http', 'https', 'http-proxy', 'web', 'gitea', 'jenkins'])
const HTTP_PORTS = new Set([80, 443, 3000, 5000, 8000, 8008, 8080, 8081, 8443, 8888, 9000, 9090])
const LOGIN_PORTS: Record<number, string> = {
  22: 'ssh',
  1433: 'mssql',
  3389: 'rdp',
  5985: 'winrm',
  5986: 'winrm'
}

function isSmbService(service: InternalService): boolean {
  return service.port === 445 || service.service.toLowerCase() === 'smb'
}

function isSshService(service: InternalService): boolean {
  return service.port === 22 || service.service.toLowerCase() === 'ssh'
}

function isHttpService(service: InternalService): boolean {
  const name = service.service.toLowerCase()
  const protocol = service.protocol.toLowerCase()
  if (HTTP_SERVICE_HINTS.has(name) || protocol === 'http' || protocol === 'https') return true
  return HTTP_PORTS.has(service.port)
}

function ruleFor(
  credential: Credential,
  service: InternalService
): Pick<CredentialSuggestion, 'rule' | 'action' | 'reason' | 'caveat' | 'confidence'> | null {
  switch (credential.type) {
    case 'ntlm_hash':
      if (!isSmbService(service)) return null
      return {
        rule: 'ntlm_hash_smb',
        action: 'pass_the_hash',
        reason: 'NTLM hash with SMB (445) — Pass-the-Hash candidate',
        caveat: 'Candidate only; requires a valid NTLM logon and account privileges.',
        confidence: 'high'
      }
    case 'netntlmv2':
      if (!isSmbService(service)) return null
      return {
        rule: 'netntlmv2_smb',
        action: 'relay_or_crack',
        reason: 'NetNTLMv2 response with SMB (445) — relay / offline cracking candidate',
        caveat: 'NetNTLMv2 cannot be used for Pass-the-Hash; relay or cracking only.',
        confidence: 'medium'
      }
    case 'password':
      if (!isSmbService(service) && !LOGIN_PORTS[service.port] && !isSshService(service)) return null
      return {
        rule: 'password_login',
        action: 'login',
        reason: 'Plaintext password with a remote login service — login candidate',
        caveat: 'Candidate only; lockout policies and MFA may apply.',
        confidence: 'medium'
      }
    case 'ssh_key':
      if (!isSshService(service)) return null
      return {
        rule: 'ssh_key_ssh',
        action: 'key_login',
        reason: 'SSH private key with SSH (22) — key login candidate',
        caveat: 'Candidate only; the key may be encrypted or not authorized.',
        confidence: 'high'
      }
    case 'kerberos_ticket':
      if (!(service.port === 88 || isSmbService(service) || service.port === 5985)) return null
      return {
        rule: 'kerberos_ticket',
        action: 'ticket_use',
        reason: 'Kerberos ticket with a Kerberos / SMB / WinRM service — ticket use candidate',
        caveat: 'Candidate only; ticket validity and target SPN are not verified.',
        confidence: 'medium'
      }
    case 'api_key':
      if (!isHttpService(service)) return null
      return {
        rule: 'api_key_http',
        action: 'api_call',
        reason: 'API key with an HTTP service — API call candidate',
        caveat: 'Candidate only; the key scope and endpoint are unverified.',
        confidence: 'low'
      }
    default:
      return null
  }
}

/**
 * Deterministic local rule engine for the credential/service matrix (§8.2).
 * It never connects or authenticates; it only ranks "where could this material
 * be worth trying" and always carries reason / caveat / confidence.
 */
export function buildCredentialSuggestions(input: {
  credentials: readonly Credential[]
  services: readonly InternalService[]
  trials?: readonly CredentialTrial[]
}): CredentialSuggestion[] {
  const trialByPair = new Map<string, CredentialTrial>()
  for (const trial of input.trials ?? []) {
    if (trial.service_id === null) continue
    trialByPair.set(`${trial.credential_id}::${trial.service_id}`, trial)
  }

  const suggestions: CredentialSuggestion[] = []
  for (const credential of input.credentials) {
    for (const service of input.services) {
      const rule = ruleFor(credential, service)
      if (rule === null) continue
      const pairKey = `${credential.id}::${service.id}`
      suggestions.push({
        id: pairKey,
        credential_id: credential.id,
        service_id: service.id,
        host_id: service.host_id,
        ip: service.host_ip,
        port: service.port,
        service: service.service,
        protocol: service.protocol,
        ...rule,
        trial: trialByPair.get(pairKey) ?? null
      })
    }
  }
  return suggestions
}

/** Bucket hosts by subnet /24 (IPv4) or /64 (IPv6) for the heatmap (§8.1). */
export function buildSubnetHeatmap(
  hosts: readonly InternalHost[],
  services: readonly InternalService[]
): SubnetHeatmapBucket[] {
  const serviceCountByHost = new Map<string, number>()
  for (const service of services) {
    serviceCountByHost.set(service.host_id, (serviceCountByHost.get(service.host_id) ?? 0) + 1)
  }

  const buckets = new Map<string, SubnetHeatmapBucket>()
  for (const host of hosts) {
    const subnet = deriveHostSubnet(host.ip, host.subnet)
    let bucket = buckets.get(subnet)
    if (bucket === undefined) {
      bucket = {
        subnet,
        host_count: 0,
        service_count: 0,
        by_state: {
          unknown: 0,
          alive: 0,
          compromised: 0,
          unreachable: 0,
          firewalled: 0
        },
        hosts: []
      }
      buckets.set(subnet, bucket)
    }
    const serviceCount = serviceCountByHost.get(host.id) ?? host.service_count
    bucket.host_count += 1
    bucket.service_count += serviceCount
    bucket.by_state[host.state] += 1
    bucket.hosts.push({
      id: host.id,
      ip: host.ip,
      hostname: host.hostname,
      state: host.state,
      confidence: host.confidence,
      service_count: serviceCount,
      last_seen: host.last_seen
    })
  }

  const naturalCompare = (a: string, b: string): number => {
    const left = a.split(/(\d+)/)
    const right = b.split(/(\d+)/)
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const leftPart = left[index] ?? ''
      const rightPart = right[index] ?? ''
      const leftNumber = Number.parseInt(leftPart, 10)
      const rightNumber = Number.parseInt(rightPart, 10)
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        if (leftNumber !== rightNumber) return leftNumber - rightNumber
      } else if (leftPart !== rightPart) {
        return leftPart < rightPart ? -1 : 1
      }
    }
    return 0
  }

  return [...buckets.values()].sort((a, b) => {
    if (a.subnet === 'unknown') return 1
    if (b.subnet === 'unknown') return -1
    return naturalCompare(a.subnet, b.subnet)
  })
}

/* ------------------------------------------------------------ zod inputs -- */

const optionalId = z.string().trim().min(1).max(100).optional()
const confidenceDefault = z.enum(CONFIDENCE_LEVELS).default('medium')

export const FootholdInputSchema = z
  .object({
    id: optionalId,
    entry_host_port: z.string().trim().min(1).max(4_000),
    entry_vuln_id: z.string().trim().max(100).default(''),
    access_type: z.enum(FOOTHOLD_ACCESS_TYPES),
    privilege_level: z.enum(PRIVILEGE_LEVELS).default('unknown'),
    status: z.enum(FOOTHOLD_STATUSES).default('established'),
    evidence: z.string().max(20_000).default(''),
    notes: z.string().max(20_000).default(''),
    established_at: z.string().max(64).default(''),
    /**
     * Internal hosts this foothold reaches (`foothold_hosts`). Additive field:
     * the join table exists in the plan, and this is how an agent records it
     * without inventing a second MCP tool.
     */
    host_ids: z.array(z.string().trim().min(1).max(100)).max(300).default([])
  })
  .strict()

export type FootholdInput = z.output<typeof FootholdInputSchema>

export const InternalHostInputSchema = z
  .object({
    id: optionalId,
    ip: z
      .string()
      .trim()
      .min(1, 'ip 不能为空')
      .max(64)
      .refine(isValidIp, 'ip 必须是合法的 IPv4 / IPv6 字面量'),
    hostname: z.string().trim().max(255).default(''),
    os: z.string().trim().max(100).default(''),
    subnet: z
      .string()
      .trim()
      .max(64)
      .default('')
      .refine((value) => value.length === 0 || isValidCidr(value), 'subnet 必须是合法 CIDR，如 10.0.1.0/24'),
    state: z.enum(INTERNAL_HOST_STATES).default('unknown'),
    source: z.string().trim().max(200).default('agent'),
    confidence: confidenceDefault,
    last_seen: z.string().trim().max(64).default('')
  })
  .strict()

export type InternalHostInput = z.output<typeof InternalHostInputSchema>

export const InternalServiceInputSchema = z
  .object({
    id: optionalId,
    host_id: z.string().trim().min(1, 'host_id 不能为空').max(100),
    port: z.number().int().min(1).max(65_535),
    protocol: z.string().trim().max(20).default(''),
    service: z.string().trim().max(100).default(''),
    banner: z.string().max(10_000).default(''),
    state: z.enum(SERVICE_STATES).default('open'),
    source: z.string().trim().max(200).default('agent')
  })
  .strict()

export type InternalServiceInput = z.output<typeof InternalServiceInputSchema>

export const CredentialInputSchema = z
  .object({
    id: optionalId,
    type: z.enum(CREDENTIAL_TYPES),
    username: z.string().trim().max(255).default(''),
    domain: z.string().trim().max(255).default(''),
    secret: z.string().max(50_000).default(''),
    source: z.string().trim().max(2_000).default('agent'),
    host_id: z.string().trim().max(100).optional(),
    service_id: z.string().trim().max(100).optional(),
    confidence: confidenceDefault,
    status: z.enum(CREDENTIAL_STATUSES).default('untested'),
    notes: z.string().max(10_000).default('')
  })
  .strict()

export type CredentialInput = z.output<typeof CredentialInputSchema>

export const PivotInputSchema = z
  .object({
    id: optionalId,
    foothold_id: z.string().trim().min(1, 'foothold_id 不能为空').max(100),
    kind: z.enum(PIVOT_KINDS),
    local_endpoint: z
      .object({
        host: z.string().trim().max(255).default('127.0.0.1'),
        port: z.number().int().min(0).max(65_535).default(0),
        protocol: z.string().trim().max(20).default('')
      })
      .default({ host: '127.0.0.1', port: 0, protocol: '' }),
    hops: z
      .array(
        z
          .object({
            ref_kind: z.enum(PIVOT_HOP_REF_KINDS),
            ref_id: z.string().trim().min(1).max(100),
            label: z.string().trim().max(255).default(''),
            via: z.string().trim().max(255).default('')
          })
          .strict()
      )
      .max(INTERNAL_LIMITS.hopsPerRoute)
      .default([]),
    reachable_subnets: z
      .array(
        z
          .string()
          .trim()
          .max(64)
          .refine(isValidCidr, 'reachable_subnets 必须是合法 CIDR')
      )
      .max(INTERNAL_LIMITS.reachableSubnetsPerPivot)
      .default([]),
    tool: z.string().trim().max(100).default(''),
    status: z.enum(PIVOT_STATUSES).default('planned'),
    notes: z.string().max(10_000).default('')
  })
  .strict()

export type PivotInput = z.output<typeof PivotInputSchema>

/** Explicit deletions for `sync_internal_scope` (never inferred from absence). */
export const SyncInternalScopeRemovedSchema = z
  .object({
    foothold_ids: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    host_ids: z.array(z.string().trim().min(1).max(100)).max(500).default([]),
    service_ids: z.array(z.string().trim().min(1).max(2_000)).default([]),
    credential_ids: z.array(z.string().trim().min(1).max(100)).max(500).default([]),
    pivot_ids: z.array(z.string().trim().min(1).max(100)).max(100).default([])
  })
  .strict()

export type SyncInternalScopeRemoved = z.output<typeof SyncInternalScopeRemovedSchema>

/**
 * Input surface of the `sync_internal_scope` MCP tool.
 *
 * - `merge` (default): upsert by id, natural-key upsert without id, never deletes.
 * - `replace`: only the arrays that were provided are replaced (rows absent from
 *   the payload are removed for that entity kind); omitted arrays stay untouched.
 * - `removed`: explicit deletion lists, always honored.
 */
export const SyncInternalScopeInputSchema = z
  .object({
    project_name: z.string().trim().min(1, 'project_name 不能为空').max(120),
    mode: z.enum(['merge', 'replace']).default('merge'),
    footholds: z.array(FootholdInputSchema).max(50).optional(),
    hosts: z.array(InternalHostInputSchema).max(500).optional(),
    services: z.array(InternalServiceInputSchema).max(2_000).optional(),
    credentials: z.array(CredentialInputSchema).max(500).optional(),
    pivots: z.array(PivotInputSchema).max(100).optional(),
    removed: SyncInternalScopeRemovedSchema.optional()
  })
  .strict()

export type SyncInternalScopeInput = z.output<typeof SyncInternalScopeInputSchema>

/** Record one credential trial from the GUI/CLI (never auto-attempted). */
export const RecordCredentialTrialInputSchema = z
  .object({
    credential_id: z.string().trim().min(1, 'credential_id 不能为空').max(100),
    service_id: z.string().trim().min(1).max(100).optional(),
    action: z.string().trim().max(100).default(''),
    status: z.enum(CREDENTIAL_TRIAL_STATUSES),
    notes: z.string().max(2_000).default('')
  })
  .strict()

export type RecordCredentialTrialInput = z.input<typeof RecordCredentialTrialInputSchema>

/** Loot file import (local parse only; the file itself is never executed). */
export const LOOT_IMPORT_FORMAT_HINTS = [
  'auto',
  'bloodhound-json',
  'secretsdump-text',
  'config-env',
  'generic-csv'
] as const
export type LootImportFormatHint = (typeof LOOT_IMPORT_FORMAT_HINTS)[number]

export const ImportLootInputSchema = z
  .object({
    project_name: z.string().trim().min(1, 'project_name 不能为空').max(120),
    entry_host_port: z.string().trim().max(4_000).default(''),
    file_path: z.string().trim().min(1, 'file_path 不能为空').max(4_000),
    /** Parser override; `auto` (default) detects the format from name + content. */
    format: z.enum(LOOT_IMPORT_FORMAT_HINTS).default('auto')
  })
  .strict()

/** API-facing input type: `format` / `entry_host_port` keep their defaults optional. */
export type ImportLootInput = z.input<typeof ImportLootInputSchema>

/** Normalize an entry host reference the same way assets are stored. */
export function normalizeEntryHostPort(value: string): string {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString()
    } catch {
      return trimmed
    }
  }
  return trimmed.toLowerCase()
}
