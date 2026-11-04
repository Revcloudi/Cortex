import { inflateRawSync } from 'node:zlib'
import { LOOT_PARSE_LIMITS } from './types'

/**
 * Minimal, dependency-free ZIP reader for BloodHound archives (Plan B §8.4).
 *
 * Security posture — this file is treated as hostile input:
 * - the central directory is parsed manually and every offset/length is
 *   bounds-checked before touching memory;
 * - only regular `*.json` entries are read, directories and other payloads are
 *   skipped;
 * - entry names are sanitized: absolute paths, drive letters and `..` segments
 *   are rejected (zip-slip defense) even though nothing is ever extracted to
 *   disk;
 * - entry count, per-entry size and total uncompressed size are capped;
 * - decompression uses `inflateRawSync` with `maxOutputLength`, so a zip bomb
 *   aborts instead of exhausting memory;
 * - only deflate and stored entries are supported; anything else is skipped
 *   with a warning.
 *
 * Nothing here ever writes a temporary file or executes archive content.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_MARKER = 0xffffffff
const ZIP64_ENTRY_COUNT = 0xffff
const EOCD_MIN_SIZE = 22
const EOCD_MAX_COMMENT = 65_535
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30

const STORED_METHOD = 0
const DEFLATE_METHOD = 8

export interface ZipJsonEntry {
  name: string
  data: Buffer
}

export interface ZipReadResult {
  entries: ZipJsonEntry[]
  warnings: string[]
  /** True when the archive as a whole is unusable / rejected by a hard cap. */
  fatal: boolean
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT)
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/**
 * Normalize one archive path. Returns null when the name must be rejected.
 * Paths never leave memory, but rejecting traversal keeps logs and future
 * extraction code honest.
 */
export function sanitizeZipEntryName(raw: string): string | null {
  const name = raw.replace(/\\/g, '/').trim()
  if (name.length === 0 || name.length > 1_024) return null
  if (name.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(name)) return null
  const segments = name.split('/')
  if (segments.some((segment) => segment === '..')) return null
  return name
}

function decodeEntryName(buffer: Buffer, start: number, length: number): string {
  return buffer.toString('utf8', start, start + length)
}

/** True when the entry should be considered a JSON payload candidate. */
function isJsonEntryName(name: string): boolean {
  return name.toLowerCase().endsWith('.json')
}

/**
 * Read every `*.json` entry of a ZIP archive into memory. The returned entries
 * are already size-capped; `fatal` marks archives that were rejected entirely.
 */
export function readZipJsonEntries(
  buffer: Buffer,
  limits: typeof LOOT_PARSE_LIMITS = LOOT_PARSE_LIMITS
): ZipReadResult {
  const warnings: string[] = []
  const entries: ZipJsonEntry[] = []
  const reject = (message: string): ZipReadResult => ({
    entries: [],
    warnings: [...warnings, message],
    fatal: true
  })

  if (buffer.length < EOCD_MIN_SIZE) {
    return reject('ZIP 解析失败：文件过小，不是有效的 ZIP 归档')
  }

  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset < 0) {
    return reject('ZIP 解析失败：未找到中央目录结尾记录（EOCD）')
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  const centralSize = buffer.readUInt32LE(eocdOffset + 12)
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (totalEntries === ZIP64_ENTRY_COUNT || centralOffset === ZIP64_MARKER) {
    return reject('ZIP 解析失败：暂不支持 ZIP64 归档')
  }
  if (centralOffset + centralSize > buffer.length) {
    return reject('ZIP 解析失败：中央目录越界，文件可能已损坏')
  }

  // First pass: collect metadata for every central-directory record.
  interface CentralRecord {
    name: string
    method: number
    compressedSize: number
    uncompressedSize: number
    localOffset: number
  }
  const records: CentralRecord[] = []
  let cursor = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > buffer.length) {
      return reject('ZIP 解析失败：中央目录记录越界，文件可能已损坏')
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      return reject('ZIP 解析失败：中央目录记录签名不正确，文件可能已损坏')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const nameStart = cursor + CENTRAL_HEADER_SIZE
    if (nameStart + nameLength > buffer.length) {
      return reject('ZIP 解析失败：条目名越界，文件可能已损坏')
    }
    const rawName = decodeEntryName(buffer, nameStart, nameLength)
    const name = sanitizeZipEntryName(rawName)
    if (name !== null) {
      records.push({ name, method, compressedSize, uncompressedSize, localOffset })
    }
    cursor = nameStart + nameLength + extraLength + commentLength
  }

  const jsonRecords = records.filter((record) => isJsonEntryName(record.name))
  if (jsonRecords.length === 0) {
    return reject('ZIP 归档中没有可解析的 *.json 条目（仅支持 BloodHound JSON 导出）')
  }
  if (jsonRecords.length > limits.maxZipEntries) {
    return reject(
      `ZIP 归档包含 ${jsonRecords.length} 个 JSON 条目，超过上限 ${limits.maxZipEntries}，已拒绝解压`
    )
  }

  const declaredTotal = jsonRecords.reduce((sum, record) => sum + record.uncompressedSize, 0)
  if (declaredTotal > limits.maxUncompressedBytes) {
    return reject(
      `ZIP 解压后总大小（声明 ${declaredTotal} 字节）超过上限 ${limits.maxUncompressedBytes}，已拒绝解压`
    )
  }

  // Second pass: bound-check the local header and decompress within the budget.
  let remainingBudget = limits.maxUncompressedBytes
  const skipped: string[] = []
  for (const record of jsonRecords) {
    const offset = record.localOffset
    if (offset + LOCAL_HEADER_SIZE > buffer.length) {
      return reject('ZIP 解析失败：本地文件头越界，文件可能已损坏')
    }
    if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
      return reject('ZIP 解析失败：本地文件头签名不正确，文件可能已损坏')
    }
    const localNameLength = buffer.readUInt16LE(offset + 26)
    const localExtraLength = buffer.readUInt16LE(offset + 28)
    const dataStart = offset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength
    const dataEnd = dataStart + record.compressedSize
    if (dataEnd > buffer.length) {
      return reject('ZIP 解析失败：条目数据越界，文件可能已损坏')
    }

    const declaredSize = record.uncompressedSize
    if (declaredSize > limits.maxFileBytes) {
      skipped.push(`${record.name}（单条解压后超过 ${limits.maxFileBytes} 字节）`)
      continue
    }

    const compressed = buffer.subarray(dataStart, dataEnd)
    const budget = Math.min(limits.maxFileBytes, remainingBudget)
    let data: Buffer
    if (record.method === STORED_METHOD) {
      if (compressed.length > budget) {
        skipped.push(`${record.name}（超出剩余解压预算）`)
        continue
      }
      data = compressed
    } else if (record.method === DEFLATE_METHOD) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: budget })
      } catch {
        warnings.push(`ZIP 条目 ${record.name} 解压失败或超出大小上限，已跳过`)
        continue
      }
    } else {
      skipped.push(`${record.name}（不支持的压缩方法 ${record.method}）`)
      continue
    }

    if (data.length > limits.maxFileBytes) {
      skipped.push(`${record.name}（解压后超过 ${limits.maxFileBytes} 字节）`)
      continue
    }
    remainingBudget -= data.length
    if (remainingBudget <= 0) {
      return reject(`ZIP 解压后总大小超过上限 ${limits.maxUncompressedBytes}，已拒绝继续解压`)
    }
    entries.push({ name: record.name, data })
  }

  if (skipped.length > 0) {
    warnings.push(`ZIP 中 ${skipped.length} 个条目被跳过：${skipped.slice(0, 5).join('、')}`)
  }
  if (entries.length === 0) {
    return { entries: [], warnings: [...warnings, 'ZIP 中没有可用的 JSON 条目'], fatal: true }
  }
  return { entries, warnings, fatal: false }
}
