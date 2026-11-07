/**
 * wxapkg container reader and classic `V1MMWX` decryptor.
 *
 * WeChat desktop stores mini-program packages as `*.wxapkg` files. Two formats
 * show up locally:
 *
 *   - `plain`  byte 0 is `0xBE`; the index/table is in clear text.
 *   - `v1mmwx` 6-byte magic `V1MMWX`; the body is AES-256-CBC encrypted with
 *              a key derived from the appid (see `decryptV1MMWX`).
 *
 * The decryption algorithm below is the classic PC WeChat scheme verified
 * against local WeChat 4.x samples (36/37; the remaining `publicLib` package
 * uses an unknown key and therefore degrades to `unsupported`, never crashes).
 *
 * Newer client versions are expected to change the header/key derivation. Keep
 * the tiny decryptor registry (`registerDecryptor`) so a future scheme can be
 * appended without touching callers.
 *
 * This module only reads bytes; it never writes or executes package content.
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

/** Encrypted package magic. */
export const WXAPKG_HEADER = 'V1MMWX'

/** Error codes surfaced to the unpack pipeline. */
export const ERROR_CODES = Object.freeze({
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  INVALID_PACKAGE: 'INVALID_PACKAGE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  /** Path-jail violation (HTTP/workspace browsing, not package content). */
  INVALID_PATH: 'INVALID_PATH',
  /** Malformed search query (bad regular expression). */
  INVALID_QUERY: 'INVALID_QUERY',
})

/** One `WxapkgError` carries a stable `code` so callers can map to statuses. */
export class WxapkgError extends Error {
  /**
   * @param {string} code one of `ERROR_CODES`
   * @param {string} message human-readable detail
   * @param {object} [details] optional diagnostic payload (paths, sizes, ...)
   */
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'WxapkgError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const HEADER_BYTES = WXAPKG_HEADER.length
const PLAIN_MAGIC = 0xbe
const PLAIN_INDEX_MARK = 0xed
const PLAIN_HEADER_BYTES = 18
const MAX_FILE_COUNT = 20000
const MAX_NAME_BYTES = 4096

const V1MMWX_SALT = 'saltiest'
const V1MMWX_ITERATIONS = 1000
const V1MMWX_KEY_BYTES = 32
/** 6-byte header + one 1024-byte AES block. */
const V1MMWX_MIN_BYTES = HEADER_BYTES + 1024
/** First 1023 plaintext bytes are carried inside the encrypted block. */
const V1MMWX_PLAIN_HEAD_BYTES = 1023
const V1MMWX_IV = Buffer.from('the iv: 16 bytes', 'ascii')
/** Fallback XOR byte when the appid is too short. */
const V1MMWX_FALLBACK_XOR = 0x66

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new TypeError('wxapkg buffer must be a Buffer or Uint8Array')
}

function detectFormatFromBytes(bytes) {
  if (bytes.length >= HEADER_BYTES && bytes.subarray(0, HEADER_BYTES).toString('latin1') === WXAPKG_HEADER) {
    return 'v1mmwx'
  }
  if (bytes.length >= 1 && bytes[0] === PLAIN_MAGIC) return 'plain'
  return 'unknown'
}

/** PBKDF2-HMAC-SHA1 key for the classic V1MMWX scheme. */
function v1mmwxKey(appid) {
  const passphrase = typeof appid === 'string' ? appid : ''
  if (passphrase.length === 0) {
    throw new WxapkgError(ERROR_CODES.DECRYPT_FAILED, 'appid is required to decrypt a V1MMWX wxapkg')
  }
  return pbkdf2Sync(passphrase, V1MMWX_SALT, V1MMWX_ITERATIONS, V1MMWX_KEY_BYTES, 'sha1')
}

/** XOR byte derived from the appid's second-to-last character. */
function v1mmwxXorByte(appid) {
  const passphrase = typeof appid === 'string' ? appid : ''
  if (passphrase.length < 2) return V1MMWX_FALLBACK_XOR
  const code = passphrase.charCodeAt(passphrase.length - 2)
  return Number.isFinite(code) ? code : V1MMWX_FALLBACK_XOR
}

function xorBytes(buffer, keyByte) {
  const out = Buffer.allocUnsafe(buffer.length)
  for (let index = 0; index < buffer.length; index += 1) out[index] = buffer[index] ^ keyByte
  return out
}

/**
 * Read package metadata without loading the whole file.
 *
 * @param {string} filePath
 * @returns {{format:'plain'|'v1mmwx'|'unknown', size:number, headerBytes:Buffer}}
 */
export function inspectPackage(filePath) {
  const stats = statSync(filePath)
  const length = Math.min(HEADER_BYTES, stats.size)
  const headerBytes = Buffer.alloc(length)
  if (length > 0) {
    const fd = openSync(filePath, 'r')
    try {
      readSync(fd, headerBytes, 0, length, 0)
    } finally {
      closeSync(fd)
    }
  }
  return { format: detectFormatFromBytes(headerBytes), size: stats.size, headerBytes }
}

/**
 * Decrypt a classic `V1MMWX` package.
 *
 * ```
 * key  = PBKDF2-HMAC-SHA1(appid, 'saltiest', 1000, 32)
 * iv   = 'the iv: 16 bytes'
 * head = AES-256-CBC-decrypt(file[6..1030])   (no auto padding)
 * tail = file[1030..] XOR appid[len-2] (or 0x66)
 * plain = head[0..1023] + tail
 * ```
 *
 * @param {Buffer|Uint8Array} buffer encrypted package bytes
 * @param {string} appid mini-program appid used as the PBKDF2 passphrase
 * @returns {Buffer} the decrypted plain wxapkg bytes
 * @throws {WxapkgError} code `DECRYPT_FAILED` when the input is too short, the
 *   header is wrong, or the key is wrong (no `0xBE` magic after decrypt).
 */
export function decryptV1MMWX(buffer, appid) {
  const source = asBuffer(buffer)
  if (source.length < V1MMWX_MIN_BYTES) {
    throw new WxapkgError(ERROR_CODES.DECRYPT_FAILED, 'encrypted wxapkg is truncated', {
      size: source.length,
      minSize: V1MMWX_MIN_BYTES,
    })
  }
  if (source.subarray(0, HEADER_BYTES).toString('latin1') !== WXAPKG_HEADER) {
    throw new WxapkgError(ERROR_CODES.DECRYPT_FAILED, 'not a V1MMWX wxapkg (unexpected header)')
  }

  const key = v1mmwxKey(appid)
  let head
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, V1MMWX_IV)
    decipher.setAutoPadding(false)
    head = Buffer.concat([
      decipher.update(source.subarray(HEADER_BYTES, V1MMWX_MIN_BYTES)),
      decipher.final(),
    ])
  } catch (error) {
    throw new WxapkgError(ERROR_CODES.DECRYPT_FAILED, `V1MMWX AES decrypt failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (head.length < 1024) {
    throw new WxapkgError(ERROR_CODES.DECRYPT_FAILED, 'V1MMWX decrypt produced a short block')
  }

  const tail = xorBytes(source.subarray(V1MMWX_MIN_BYTES), v1mmwxXorByte(appid))
  const plain = Buffer.concat([head.subarray(0, V1MMWX_PLAIN_HEAD_BYTES), tail])
  if (plain.length === 0 || plain[0] !== PLAIN_MAGIC) {
    throw new WxapkgError(
      ERROR_CODES.DECRYPT_FAILED,
      'decrypted wxapkg has no 0xBE magic: wrong appid or unsupported client version',
    )
  }
  return plain
}

/**
 * Inverse of {@link decryptV1MMWX} — used by round-trip tests.
 *
 * The first 1023 plaintext bytes are padded with one zero byte, encrypted as a
 * single 1024-byte AES block; the remainder is XOR-obfuscated. The synthetic
 * zero byte is not part of the plaintext so the round trip is byte-exact.
 *
 * @param {Buffer|Uint8Array} buffer plain wxapkg bytes (>= 1023 bytes)
 * @param {string} appid
 * @returns {Buffer}
 * @throws {WxapkgError} code `INVALID_PACKAGE` when the plaintext is too short
 */
export function encryptV1MMWX(buffer, appid) {
  const plain = asBuffer(buffer)
  if (plain.length < V1MMWX_PLAIN_HEAD_BYTES) {
    throw new WxapkgError(
      ERROR_CODES.INVALID_PACKAGE,
      `plain wxapkg is too short to encrypt (${plain.length} < ${V1MMWX_PLAIN_HEAD_BYTES})`,
    )
  }
  const key = v1mmwxKey(appid)
  const block = Buffer.alloc(1024)
  plain.copy(block, 0, 0, V1MMWX_PLAIN_HEAD_BYTES)

  const cipher = createCipheriv('aes-256-cbc', key, V1MMWX_IV)
  cipher.setAutoPadding(false)
  const head = Buffer.concat([cipher.update(block), cipher.final()])
  const tail = xorBytes(plain.subarray(V1MMWX_PLAIN_HEAD_BYTES), v1mmwxXorByte(appid))
  return Buffer.concat([Buffer.from(WXAPKG_HEADER, 'latin1'), head, tail])
}

/**
 * Parse the plain wxapkg table.
 *
 * Layout:
 * ```
 * 0x00  0xBE
 * 0x01  uint32BE info1
 * 0x05  uint32BE indexLength
 * 0x09  uint32BE bodyLength
 * 0x0D  0xED
 * 0x0E  uint32BE fileCount
 * 0x12  fileCount * { uint32BE nameLen, name(UTF-8), uint32BE offset, uint32BE size }
 * ```
 * Entry names are returned as stored (usually starting with `/`); use
 * `safeRelativePath` from `unpack.js` before touching the filesystem.
 *
 * @param {Buffer|Uint8Array} buffer plain package bytes
 * @returns {{format:'plain', files:Array<{name:string, offset:number, size:number}>, meta:{info1:number,indexLength:number,bodyLength:number,lastMark:number,fileCount:number}}}
 * @throws {WxapkgError} `INVALID_PACKAGE` for structural corruption,
 *   `LIMIT_EXCEEDED` for absurd file counts / name lengths.
 */
export function parseWxapkg(buffer) {
  const source = asBuffer(buffer)
  if (source.length < PLAIN_HEADER_BYTES) {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, 'wxapkg is truncated: header needs 18 bytes', {
      size: source.length,
    })
  }
  if (source[0] !== PLAIN_MAGIC) {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, 'not a plain wxapkg (missing 0xBE magic)')
  }

  const info1 = source.readUInt32BE(1)
  const indexLength = source.readUInt32BE(5)
  const bodyLength = source.readUInt32BE(9)
  const lastMark = source[13]
  if (lastMark !== PLAIN_INDEX_MARK) {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, 'not a plain wxapkg (missing 0xED index mark)')
  }

  const fileCount = source.readUInt32BE(14)
  if (fileCount > MAX_FILE_COUNT) {
    throw new WxapkgError(ERROR_CODES.LIMIT_EXCEEDED, `wxapkg declares too many files (${fileCount} > ${MAX_FILE_COUNT})`, {
      fileCount,
      max: MAX_FILE_COUNT,
    })
  }
  if (indexLength > 0 && PLAIN_HEADER_BYTES + indexLength > source.length) {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, 'wxapkg file index exceeds the package size', {
      indexLength,
      size: source.length,
    })
  }

  const files = []
  let cursor = PLAIN_HEADER_BYTES
  for (let index = 0; index < fileCount; index += 1) {
    if (cursor + 4 > source.length) {
      throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `wxapkg file index is truncated at entry ${index}`)
    }
    const nameLength = source.readUInt32BE(cursor)
    cursor += 4
    if (nameLength > MAX_NAME_BYTES) {
      throw new WxapkgError(ERROR_CODES.LIMIT_EXCEEDED, `wxapkg entry ${index} name is too long (${nameLength})`, {
        max: MAX_NAME_BYTES,
      })
    }
    if (cursor + nameLength + 8 > source.length) {
      throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `wxapkg file index is truncated at entry ${index}`)
    }
    const name = source.subarray(cursor, cursor + nameLength).toString('utf8')
    cursor += nameLength
    const offset = source.readUInt32BE(cursor)
    cursor += 4
    const size = source.readUInt32BE(cursor)
    cursor += 4
    if (offset > source.length || size > source.length - offset) {
      throw new WxapkgError(
        ERROR_CODES.INVALID_PACKAGE,
        `wxapkg entry ${JSON.stringify(name)} points outside the package`,
        { offset, size, packageSize: source.length },
      )
    }
    files.push({ name, offset, size })
  }

  return {
    format: 'plain',
    files,
    meta: { info1, indexLength, bodyLength, lastMark, fileCount },
  }
}

/* ------------------------- decryptor registry ------------------------- */

/** @type {Array<{id:string, header?:string, detect:(buffer:Buffer)=>boolean, decrypt:(buffer:Buffer, appid:string)=>Buffer}>} */
const decryptors = []

/**
 * Append a decryptor for a future client version. `detect` receives the raw
 * package buffer and must return `true` for its format; `decrypt` returns the
 * plain package bytes (starting with `0xBE`).
 */
export function registerDecryptor(decryptor) {
  if (
    !decryptor ||
    typeof decryptor.id !== 'string' ||
    decryptor.id.length === 0 ||
    typeof decryptor.detect !== 'function' ||
    typeof decryptor.decrypt !== 'function'
  ) {
    throw new TypeError('decryptor must have { id, detect(buffer), decrypt(buffer, appid) }')
  }
  if (decryptors.some((entry) => entry.id === decryptor.id)) {
    throw new WxapkgError(ERROR_CODES.INVALID_PACKAGE, `decryptor already registered: ${decryptor.id}`)
  }
  decryptors.push(decryptor)
  return decryptor
}

/** Registered decryptor ids (no functions exposed). */
export function listDecryptors() {
  return decryptors.map((entry) => ({ id: entry.id, header: entry.header || '' }))
}

function findDecryptor(buffer) {
  for (const decryptor of decryptors) {
    let matched = false
    try {
      matched = decryptor.detect(buffer) === true
    } catch {
      matched = false
    }
    if (matched) return decryptor
  }
  return null
}

registerDecryptor({
  id: 'v1mmwx',
  header: WXAPKG_HEADER,
  detect: (buffer) =>
    buffer.length >= HEADER_BYTES && buffer.subarray(0, HEADER_BYTES).toString('latin1') === WXAPKG_HEADER,
  decrypt: (buffer, appid) => decryptV1MMWX(buffer, appid),
})

/* ------------------------------ readers ------------------------------ */

/**
 * Read + decrypt + parse a package that is already in memory.
 *
 * @param {Buffer|Uint8Array} buffer raw package bytes
 * @param {{appid?:string, filePath?:string}} [options]
 * @returns {{format:'plain'|'v1mmwx', buffer:Buffer, files:Array<{name:string,offset:number,size:number}>, meta:object}}
 */
export function readPackageBuffer(buffer, { appid = '', filePath = '' } = {}) {
  const raw = asBuffer(buffer)
  const decryptor = findDecryptor(raw)
  let format
  let plain
  if (decryptor) {
    format = decryptor.id
    plain = decryptor.decrypt(raw, appid)
  } else if (raw.length > 0 && raw[0] === PLAIN_MAGIC) {
    format = 'plain'
    plain = raw
  } else {
    const detected = detectFormatFromBytes(raw.subarray(0, HEADER_BYTES))
    throw new WxapkgError(
      ERROR_CODES.UNSUPPORTED_FORMAT,
      `unsupported wxapkg format (${detected === 'unknown' ? 'unknown header' : detected})`,
      { filePath: filePath || '', header: raw.subarray(0, 8).toString('hex') },
    )
  }
  const parsed = parseWxapkg(plain)
  return { format, buffer: plain, files: parsed.files, meta: parsed.meta }
}

/**
 * Read one package from disk.
 *
 * @param {string} filePath
 * @param {{appid?:string}} [options]
 * @returns {{format:'plain'|'v1mmwx', buffer:Buffer, files:Array<{name:string,offset:number,size:number}>, meta:object}}
 * @throws {WxapkgError} `UNSUPPORTED_FORMAT` / `DECRYPT_FAILED` / `INVALID_PACKAGE`
 */
export function readPackage(filePath, { appid = '' } = {}) {
  let raw
  try {
    raw = readFileSync(filePath)
  } catch (error) {
    throw new WxapkgError(
      ERROR_CODES.INVALID_PACKAGE,
      `cannot read wxapkg: ${error instanceof Error ? error.message : String(error)}`,
      { filePath },
    )
  }
  return readPackageBuffer(raw, { appid, filePath })
}
