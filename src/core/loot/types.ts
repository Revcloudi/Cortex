import type {
  ConfidenceLevel,
  CredentialType,
  InternalHostState,
  LootFormat,
  ServiceState
} from '../../shared/internal'

/**
 * Local Loot parsing contracts (Plan B §8.4 / §11).
 *
 * Loot files are untrusted input: the parser runs entirely in-process, never
 * executes file content, never touches the network and never logs secrets. The
 * database layer consumes the parsed result and persists it inside one
 * transaction; the raw file itself is never stored in SQLite (only its sha256
 * and this summary).
 */

export interface LootParsedHost {
  ip: string
  hostname?: string
  os?: string
  subnet?: string
  state?: InternalHostState
}

export interface LootParsedService {
  /** IP of the owning internal host (`LootParsedHost.ip`). */
  host_ip: string
  port: number
  protocol?: string
  service?: string
  banner?: string
  state?: ServiceState
}

export interface LootParsedCredential {
  type: CredentialType
  username?: string
  domain?: string
  /** Raw secret material; never logged, only passed to the credential store. */
  secret: string
  /** Provenance label: `<format>:<filename>` only, never secret content. */
  source: string
  host_ip?: string
  service_ip?: string
  service_port?: number
  confidence?: ConfidenceLevel
  notes?: string
}

export interface LootParseResult {
  format: LootFormat
  parser: string
  /** SHA-256 (hex) of the whole file, always computed — even for unknown formats. */
  sha256: string
  status: 'parsed' | 'needs_review'
  hosts: LootParsedHost[]
  services: LootParsedService[]
  credentials: LootParsedCredential[]
  warnings: string[]
}

/**
 * Hard safety caps. Every parser path enforces these before allocating or
 * emitting data, so a hostile file cannot exhaust memory or create huge
 * database writes.
 */
export const LOOT_PARSE_LIMITS = {
  /** Input file cap (20 MB). */
  maxFileBytes: 20 * 1024 * 1024,
  /** Per-collection cap for emitted hosts / services / credentials. */
  maxEntries: 500,
  /** Total uncompressed bytes read from a ZIP archive (80 MB). */
  maxUncompressedBytes: 80 * 1024 * 1024,
  /** Maximum number of JSON entries extracted from one ZIP archive. */
  maxZipEntries: 64,
  /** Maximum number of lines inspected by the text parsers. */
  maxTextLines: 200_000,
  /** Longest single line the text parsers will inspect. */
  maxLineLength: 200_000,
  /** Longest secret stored in a credential (mirrors the zod contract). */
  maxSecretLength: 50_000,
  /** Longest service banner stored (mirrors the zod contract). */
  maxBannerLength: 10_000
} as const

/** Formats the local parser can handle (without `auto` / `unknown`). */
export const LOOT_PARSER_FORMATS = [
  'bloodhound-json',
  'secretsdump-text',
  'config-env',
  'generic-csv'
] as const
export type LootParserFormat = (typeof LOOT_PARSER_FORMATS)[number]

/** Values accepted by the `ctx loot import --format` flag. */
export const LOOT_FORMAT_OPTIONS = ['auto', ...LOOT_PARSER_FORMATS] as const
export type LootFormatOption = (typeof LOOT_FORMAT_OPTIONS)[number]

export function isLootParserFormat(value: string): value is LootParserFormat {
  return (LOOT_PARSER_FORMATS as readonly string[]).includes(value)
}

export function isLootFormatOption(value: string): value is LootFormatOption {
  return (LOOT_FORMAT_OPTIONS as readonly string[]).includes(value)
}
