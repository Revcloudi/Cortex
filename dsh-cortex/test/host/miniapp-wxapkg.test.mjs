// Unit tests for the wxapkg container reader + classic V1MMWX decryptor.
//
// Synthetic packages are built locally (never real WeChat data). The encrypted
// builder below is an independent implementation of the algorithm, so the
// plugin's `encryptV1MMWX` can be cross-checked against it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WXAPKG_HEADER,
  WxapkgError,
  ERROR_CODES,
  decryptV1MMWX,
  encryptV1MMWX,
  inspectPackage,
  listDecryptors,
  parseWxapkg,
  readPackage,
} from '../../src/host/miniapp/wxapkg.js'

const APPID = 'wxdabf06925a55f410'

/** Build one plaintext wxapkg container from `{name, content}` entries. */
function buildPlainWxapkg(entries) {
  const files = entries.map((entry) => ({
    name: String(entry.name),
    content: Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'utf8'),
  }))
  const indexBytes = files.reduce((total, file) => total + 4 + Buffer.byteLength(file.name) + 4 + 4, 0)
  const bodyStart = 18 + indexBytes
  let cursor = bodyStart
  for (const file of files) {
    file.offset = cursor
    file.size = file.content.length
    cursor += file.content.length
  }
  const buffer = Buffer.alloc(cursor)
  buffer[0] = 0xbe
  buffer.writeUInt32BE(0, 1)
  buffer.writeUInt32BE(indexBytes, 5)
  buffer.writeUInt32BE(cursor - bodyStart, 9)
  buffer[13] = 0xed
  buffer.writeUInt32BE(files.length, 14)
  let offset = 18
  for (const file of files) {
    const nameLength = Buffer.byteLength(file.name)
    buffer.writeUInt32BE(nameLength, offset)
    offset += 4
    buffer.write(file.name, offset, 'utf8')
    offset += nameLength
    buffer.writeUInt32BE(file.offset, offset)
    offset += 4
    buffer.writeUInt32BE(file.size, offset)
    offset += 4
  }
  for (const file of files) file.content.copy(buffer, file.offset)
  return buffer
}

/** Independent V1MMWX encryptor used to verify the plugin's inverse. */
function encryptedFixture(plaintext, appid) {
  const plain = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)
  const key = pbkdf2Sync(String(appid), 'saltiest', 1000, 32, 'sha1')
  const iv = Buffer.from('the iv: 16 bytes', 'utf8')
  const headPlain = Buffer.alloc(1024)
  plain.copy(headPlain, 0, 0, Math.min(plain.length, 1023))
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  const headCipher = Buffer.concat([cipher.update(headPlain), cipher.final()])
  const tailPlain = plain.subarray(1023)
  const xorKey = String(appid).length >= 2 ? String(appid).charCodeAt(String(appid).length - 2) : 0x66
  const tail = Buffer.alloc(tailPlain.length)
  for (let index = 0; index < tailPlain.length; index += 1) tail[index] = tailPlain[index] ^ xorKey
  return Buffer.concat([Buffer.from(WXAPKG_HEADER, 'ascii'), headCipher, tail])
}

function bigEntries() {
  const filler = 'x'.repeat(2000)
  return [
    { name: '/app-config.json', content: JSON.stringify({ pages: ['pages/index/index'] }) },
    { name: '/pages/index/index.js', content: `Page({data:{filler:${JSON.stringify(filler)}}})` },
  ]
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mini-wxapkg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error instanceof WxapkgError && error.code === code)
}

test('plain: parseWxapkg/readPackage/inspectPackage roundtrip', (t) => {
  const dir = tempDir(t)
  const plain = buildPlainWxapkg(bigEntries())
  const filePath = join(dir, '__APP__.wxapkg')
  writeFileSync(filePath, plain)

  const inspected = inspectPackage(filePath)
  assert.equal(inspected.format, 'plain')
  assert.equal(inspected.size, plain.length)
  assert.equal(inspected.headerBytes[0], 0xbe)

  const parsed = parseWxapkg(plain)
  assert.equal(parsed.format, 'plain')
  assert.equal(parsed.files.length, 2)
  assert.equal(parsed.files[0].name, '/app-config.json')
  assert.equal(parsed.files[1].name, '/pages/index/index.js')
  assert.equal(parsed.meta.fileCount, 2)
  assert.equal(parsed.meta.lastMark, 0xed)
  const first = parsed.files[1]
  assert.deepEqual(
    plain.subarray(first.offset, first.offset + first.size).toString('utf8'),
    bigEntries()[1].content,
  )

  const pkg = readPackage(filePath, { appid: APPID })
  assert.equal(pkg.format, 'plain')
  assert.equal(pkg.buffer.toString('hex'), plain.toString('hex'))
  assert.equal(pkg.files.length, 2)
})

test('plain: structural corruption is rejected with clear codes', () => {
  const good = buildPlainWxapkg(bigEntries())
  const truncated = good.subarray(0, 17)
  assertCode(() => parseWxapkg(truncated), ERROR_CODES.INVALID_PACKAGE)

  const badMark = Buffer.from(good)
  badMark[13] = 0x00
  assertCode(() => parseWxapkg(badMark), ERROR_CODES.INVALID_PACKAGE)

  const badMagic = Buffer.from(good)
  badMagic[0] = 0x42
  assertCode(() => parseWxapkg(badMagic), ERROR_CODES.INVALID_PACKAGE)

  const outOfBounds = Buffer.from(good)
  // first entry: name ends at 18+4+14; offset/size follow.
  const nameLength = outOfBounds.readUInt32BE(18)
  const sizeAt = 18 + 4 + nameLength + 4
  outOfBounds.writeUInt32BE(0xfffffff, sizeAt)
  assertCode(() => parseWxapkg(outOfBounds), ERROR_CODES.INVALID_PACKAGE)
})

test('plain: fileCount / name length limits are enforced', () => {
  const tooMany = Buffer.alloc(18)
  tooMany[0] = 0xbe
  tooMany[13] = 0xed
  tooMany.writeUInt32BE(20001, 14)
  assertCode(() => parseWxapkg(tooMany), ERROR_CODES.LIMIT_EXCEEDED)

  const longName = Buffer.alloc(18 + 4 + 5000)
  longName[0] = 0xbe
  longName[13] = 0xed
  longName.writeUInt32BE(1, 14)
  longName.writeUInt32BE(5000, 18)
  assertCode(() => parseWxapkg(longName), ERROR_CODES.LIMIT_EXCEEDED)
})

test('V1MMWX: independent ciphertext decrypts + parses via readPackage', (t) => {
  const dir = tempDir(t)
  const plain = buildPlainWxapkg(bigEntries())
  const encrypted = encryptedFixture(plain, APPID)
  const filePath = join(dir, '__APP__.wxapkg')
  writeFileSync(filePath, encrypted)

  assert.equal(inspectPackage(filePath).format, 'v1mmwx')
  const decrypted = decryptV1MMWX(encrypted, APPID)
  assert.equal(decrypted.toString('hex'), plain.toString('hex'))

  const pkg = readPackage(filePath, { appid: APPID })
  assert.equal(pkg.format, 'v1mmwx')
  assert.equal(pkg.buffer[0], 0xbe)
  assert.equal(pkg.files.length, 2)
  assert.equal(pkg.meta.fileCount, 2)
})

test('V1MMWX: encryptV1MMWX is the inverse and matches the independent builder', () => {
  const plain = buildPlainWxapkg(bigEntries())
  assert.ok(plain.length > 1023)
  assert.equal(encryptV1MMWX(plain, APPID).toString('hex'), encryptedFixture(plain, APPID).toString('hex'))
  const roundtrip = decryptV1MMWX(encryptV1MMWX(plain, APPID), APPID)
  assert.equal(roundtrip.toString('hex'), plain.toString('hex'))

  // Too short to carry the first 1023 plaintext bytes.
  assertCode(() => encryptV1MMWX(Buffer.alloc(8), APPID), ERROR_CODES.INVALID_PACKAGE)
})

test('V1MMWX: wrong appid fails with DECRYPT_FAILED', () => {
  const plain = buildPlainWxapkg(bigEntries())
  const encrypted = encryptedFixture(plain, APPID)
  assertCode(() => decryptV1MMWX(encrypted, 'wx0000000000000000'), ERROR_CODES.DECRYPT_FAILED)
  assertCode(() => decryptV1MMWX(encrypted, ''), ERROR_CODES.DECRYPT_FAILED)
})

test('V1MMWX: truncated / non-encrypted inputs fail cleanly', (t) => {
  const plain = buildPlainWxapkg(bigEntries())
  const encrypted = encryptedFixture(plain, APPID)
  assertCode(() => decryptV1MMWX(encrypted.subarray(0, 100), APPID), ERROR_CODES.DECRYPT_FAILED)
  assertCode(() => decryptV1MMWX(plain, APPID), ERROR_CODES.DECRYPT_FAILED)

  const dir = tempDir(t)
  const unknown = join(dir, 'unknown.wxapkg')
  writeFileSync(unknown, Buffer.from('not-a-wxapkg-file', 'utf8'))
  assert.equal(inspectPackage(unknown).format, 'unknown')
  assertCode(() => readPackage(unknown, { appid: APPID }), ERROR_CODES.UNSUPPORTED_FORMAT)
  assertCode(() => readPackage(join(dir, 'missing.wxapkg'), { appid: APPID }), ERROR_CODES.INVALID_PACKAGE)
})

test('decryptor registry lists the classic V1MMWX scheme', () => {
  const ids = listDecryptors().map((entry) => entry.id)
  assert.ok(ids.includes('v1mmwx'))
})

test(
  'real sample: CORTEX_WXAPKG_FIXTURE decrypts and parses',
  {
    skip:
      process.env.CORTEX_WXAPKG_FIXTURE && process.env.CORTEX_WXAPKG_FIXTURE_APPID
        ? false
        : 'set CORTEX_WXAPKG_FIXTURE and CORTEX_WXAPKG_FIXTURE_APPID to run',
  },
  () => {
    const pkg = readPackage(process.env.CORTEX_WXAPKG_FIXTURE, {
      appid: process.env.CORTEX_WXAPKG_FIXTURE_APPID,
    })
    assert.ok(['plain', 'v1mmwx'].includes(pkg.format))
    assert.ok(pkg.files.length > 0)
    assert.equal(pkg.buffer[0], 0xbe)
    assert.equal(pkg.meta.fileCount, pkg.files.length)
  },
)
