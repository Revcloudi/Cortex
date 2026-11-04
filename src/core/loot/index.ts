/**
 * Local Loot parsing engine public surface (Plan B §8.4).
 *
 * `DatabaseService.importLoot` imports `parseLootFile` from this module and
 * persists the parsed result in one transaction. The parser has no dependency
 * on the database layer, so there is no import cycle (db → loot → shared only).
 */
export type {
  LootParsedHost,
  LootParsedService,
  LootParsedCredential,
  LootParseResult
} from './types'
export {
  LOOT_FORMAT_OPTIONS,
  LOOT_PARSE_LIMITS,
  LOOT_PARSER_FORMATS,
  isLootFormatOption,
  isLootParserFormat
} from './types'
export type { LootFormatOption, LootParserFormat } from './types'
export { parseLootFile } from './parseLoot'
export type { LootParseOptions } from './parseLoot'
export { readZipJsonEntries, sanitizeZipEntryName } from './zip'
