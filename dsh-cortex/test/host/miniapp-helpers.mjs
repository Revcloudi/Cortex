/**
 * Fixtures for the mini-program host tests.
 *
 * Synthetic packages are generated locally (never committed real WeChat data),
 * and the environment is redirected into a temp tree so scans can never touch
 * the developer's real WeChat cache or ~/.cortex database.
 */

import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** Build one plaintext wxapkg container from `{name, content}` entries. */
export function buildPlainWxapkg(files) {
  const entries = (files || []).map((file) => ({
    name: String(file.name),
    content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), 'utf8'),
  }))
  const headerBytes = 18
  const indexBytes = entries.reduce(
    (total, entry) => total + 4 + Buffer.byteLength(entry.name, 'utf8') + 4 + 4,
    0,
  )
  const bodyStart = headerBytes + indexBytes
  let cursor = bodyStart
  for (const entry of entries) {
    entry.offset = cursor
    entry.size = entry.content.length
    cursor += entry.content.length
  }
  const buffer = Buffer.alloc(cursor)
  buffer[0] = 0xbe
  buffer.writeUInt32BE(0, 1)
  buffer.writeUInt32BE(indexBytes, 5)
  buffer.writeUInt32BE(cursor - bodyStart, 9)
  buffer[13] = 0xed
  buffer.writeUInt32BE(entries.length, 14)
  let offset = 18
  for (const entry of entries) {
    const nameLength = Buffer.byteLength(entry.name, 'utf8')
    buffer.writeUInt32BE(nameLength, offset)
    offset += 4
    buffer.write(entry.name, offset, 'utf8')
    offset += nameLength
    buffer.writeUInt32BE(entry.offset, offset)
    offset += 4
    buffer.writeUInt32BE(entry.size, offset)
    offset += 4
  }
  for (const entry of entries) entry.content.copy(buffer, entry.offset)
  return buffer
}

/**
 * Classic PC WeChat `V1MMWX` encryption (inverse of the plugin decryptor).
 * Kept here as an independent fixture generator: the plugin's own
 * `encryptV1MMWX` round-trip test lives in its unit tests.
 */
export function encryptV1MMWX(plaintext, appid) {
  const plain = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')
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
  return Buffer.concat([Buffer.from('V1MMWX', 'ascii'), headCipher, tail])
}

export function buildEncryptedWxapkg(files, appid) {
  return encryptV1MMWX(buildPlainWxapkg(files), appid)
}

/** A package whose decrypted body is intentionally not a wxapkg. */
export function buildUndecryptableWxapkg(appid) {
  const invalid = Buffer.alloc(2048, 0x41)
  invalid[0] = 0x00
  return encryptV1MMWX(invalid, appid)
}

/** Representative mini-program content used by API/tool tests. */
export function sampleFiles({ marker = 'MINIAPP-UNIQUE-MARKER' } = {}) {
  const filler = 'const filler="' + 'x'.repeat(1800) + '";'
  return [
    {
      name: '/app-config.json',
      content: JSON.stringify({
        pages: ['pages/index/index', 'pages/order/detail'],
        subPackages: [{ root: 'packageA', pages: ['pages/a/a'] }],
        global: { window: { navigationBarTitleText: '测试健康商城' } },
        page: {
          'pages/index/index.html': { window: { navigationBarTitleText: '测试健康商城' } },
          'pages/order/detail.html': { window: { navigationBarTitleText: '订单详情' } },
        },
      }),
    },
    {
      name: '/app-service.js',
      content: [
        'const API="https://api.demo-target.test/v1";',
        'wx.request({url:"https://api.demo-target.test/api/order/detail",method:"POST"});',
        'const cfg={apiKey:"sk-abcdefghijklmnopqrstuvwxyz123456",tenantId:"10001",userId:"20002"};',
        'const other="/api/user/profile?id=42&tenantId=10001";',
        `// marker: ${marker}`,
        filler,
      ].join('\n'),
    },
    {
      name: '/pages/index/index.js',
      content: `Page({data:{title:"${marker}"}})`,
    },
    {
      name: '/packageA/pages/a/a.js',
      content: 'const x="/api/package/a";',
    },
    {
      name: '/assets/logo.png',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]),
    },
  ]
}

/**
 * Create `<base>/<user>/applet/packages/<appid>/<version>/*.wxapkg`.
 * @param {string} base directory acting as the fake xwechat `users` root
 */
export function writeFakePackage(
  base,
  { user = 'userhash', appid, version, files, encrypted = false, fileName = '__APP__.wxapkg' },
) {
  const dir = join(base, user, 'applet', 'packages', appid, String(version))
  mkdirSync(dir, { recursive: true })
  const buffer = encrypted ? buildEncryptedWxapkg(files, appid) : buildPlainWxapkg(files)
  writeFileSync(join(dir, fileName), buffer)
  return { dir, file: join(dir, fileName) }
}

/** Create a real-looking encrypted package that cannot be decrypted. */
export function writeUndecryptablePackage(base, { user = 'userhash', appid, version }) {
  const dir = join(base, user, 'applet', 'packages', appid, String(version))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '__APP__.wxapkg'), buildUndecryptableWxapkg(appid))
  return { dir, file: join(dir, '__APP__.wxapkg') }
}

/**
 * Redirect every miniapp-related path into a temp tree. Tests must call this
 * before touching the store (the singleton is keyed/lazy, reset it after).
 */
export function isolateMiniappEnv(baseDir, { roots = [] } = {}) {
  const home = join(baseDir, 'home')
  mkdirSync(home, { recursive: true })
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.APPDATA = join(home, 'AppData', 'Roaming')
  process.env.LOCALAPPDATA = join(home, 'AppData', 'Local')
  process.env.CORTEX_PLUGIN_DB = join(baseDir, 'plugin.db')
  process.env.CORTEX_MINIAPP_WORKSPACE = join(baseDir, 'workspace')
  process.env.CORTEX_MINIAPP_ROOTS = roots.join(delimiter)
  return {
    home,
    pluginDb: process.env.CORTEX_PLUGIN_DB,
    workspace: process.env.CORTEX_MINIAPP_WORKSPACE,
    roots,
  }
}

/** Write a `manifest`-free arbitrary text file for tree/read/search tests. */
export function writeTextFile(root, relative, content) {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  return target
}
