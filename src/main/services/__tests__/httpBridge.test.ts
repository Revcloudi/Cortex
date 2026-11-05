/**
 * HttpBridge tests — runnable without Electron.
 *
 * Intended command (dev machines): `npx tsx --test src/main/services/__tests__/httpBridge.test.ts`
 * In the DSH agent sandbox child processes with piped stdio are blocked
 * (spawn EPERM), so the same file is also verified by compiling it with tsc and
 * running `node --test <compiled.js>`.
 *
 * The certificate/key below are a throwaway self-signed `localhost` fixture for
 * the TLS tests; they are not used anywhere in the application.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import { connect as netConnect, type Socket } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createHttpBridge, isOriginAllowed } from '../HttpBridge'
import type { PocExecutionLimits } from '../../../shared/poc'
import type { PocHttpBridge, PocProxyRuntimeConfig } from '../pocContracts'

/** lockedCount is an implementation diagnostic (not part of the contract). */
function blockedCountOf(bridge: PocHttpBridge): number {
  return (bridge as unknown as { blockedCount?: number }).blockedCount ?? 0
}
import { silentLogger } from '../../../core/logging'

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDBjCCAe6gAwIBAgIJH13q8qQati3CMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMTCWxvY2FsaG9zdDAeFw0yNjExMDQxMTM2NTFaFw0yNzExMDQxMTM2NTFaMBQx
EjAQBgNVBAMTCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALi2ZBXfKluqHvDhATl1t+24JGcZYpJFsCoc5ujg80FAH5pAi1VdEUzz1lo8
UG9ErPc4bFC2wTdBHivkiXsD8dNmUO2RNJLvZFCYGUZNGYdt3v62zOYjXcpIsNy1
mmM2NsrR0n/0AfGUhWnuZTi0zcZT1T4cOKY+XJfCb58OBpsMTRW7O91R1pzh5h0a
VIgMGyzpkbYQxv+7wBPVd2mQp8RkQHvfL72rVwF3BtvquZC4TJPmI9+AgxLXvXBj
v0PzPP2LtTh2HtL7eA7FkEfqNmv7T7pXa1e4W6mIdr4q9SnuC/3afy6AlqTq+i9E
jYfcKpvW31mjhnSad5bScYCJzzkCAwEAAaNbMFkwDAYDVR0TAQH/BAIwADAOBgNV
HQ8BAf8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMBoGA1Ud
EQQTMBGCCWxvY2FsaG9zdIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAZMwiV0+J
5wQnQPYbshuUuao3kjEeF3cUpDdtveM6/QNB5KRFy+6/lgGBRQVk3AvT/rN8o2Ul
+/oeLkDn/1g1KSqR6xrzm2YJjUEEQ+ElG9/XarjCaQs93EdrLw6WrmifFHfYovW7
3d6L/O6Kvm/7CSBzLCqdiBoTVJLgyHYIn6XbB2yompj0BgTRpWlXQLWYg5uiVP3h
2TQETO9lLMJRYsTdGFW6VyQT7bSnd09lUGnUVEDBeITaubFvmJK7eglLcEwHmv0C
TpQW3rr7FmZ/AdKqDS3kzssX6YiVkbR5lpm17xA2eu4nc5Oo2K3vAGa06X0p5EUE
LBGNpurd7kJTQA==
-----END CERTIFICATE-----
`

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC4tmQV3ypbqh7w
4QE5dbftuCRnGWKSRbAqHObo4PNBQB+aQItVXRFM89ZaPFBvRKz3OGxQtsE3QR4r
5Il7A/HTZlDtkTSS72RQmBlGTRmHbd7+tszmI13KSLDctZpjNjbK0dJ/9AHxlIVp
7mU4tM3GU9U+HDimPlyXwm+fDgabDE0VuzvdUdac4eYdGlSIDBss6ZG2EMb/u8AT
1XdpkKfEZEB73y+9q1cBdwbb6rmQuEyT5iPfgIMS171wY79D8zz9i7U4dh7S+3gO
xZBH6jZr+0+6V2tXuFupiHa+KvUp7gv92n8ugJak6vovRI2H3Cqb1t9Zo4Z0mneW
0nGAic85AgMBAAECggEAIFca1fOBVJRIH4+dqcRRJEd55C0/I3IdInp1+W8tWA7U
marUWmlVlp4YuSrXQGwLRquz1zvwP27gy/mTEp1BsWw4Higuxs0wSKYgwrzMC/iy
MvGplV+606h/gt0u/1DmLgOnsex0jKoe48mwIkoRvzg9XUcOqhjAGHgcGAKaKHol
/V36JWsXvxiOOoZqlP4XV75YAJ7hktjSO2BIZfo5Ci0aRVlnQ1LQy/R8NEqG6rJw
X4zppNq4W9MdMantYBwf1QRtEdcPoFeUnGdlCOKWhNBOXBEn73OVN6h3CGGiVx6g
DQ4CGF2SUBUfDQERIaRHfE3324G98zqFHVth6trk4wKBgQDrziY5wgLxO8AP6LGT
A3fJxc1jpkXY/BlNQAWZpsuSuTwE0D7hl9Bv92XDKS5AiBFlAS8jZvjOfv6uYIBc
bUZu7z06dV2cFcpXsTeShM8XSAuEO8m1L1yzDsjawEMlkkRk7vsuhotX1pMjfMSV
eFqB+oXahXyQ2eEPHOPLIIqpXwKBgQDIiBIirp43fQkhx3nJmKTGiSbIczXNl5ld
0VuF2i6Nz8wdaFK6zimcVpjGHkcuxNIS0mpn9mh3VatpVawZpg+QG6opdQ/6TWPi
LPwjhvztPtjM260z2gmE8nrVXcTyMKr0NAdkaipwu66W5eZ4h67hAaoq2JnTPGhv
rJOmq76WZwKBgBWp8d8akPSival4gl/0UJwL/Surif0+ZACx4hHUvh0zwWzbyPsm
3HJ88y9z6Bjrp1V1P2RsQG2QQ0u39/MF4xOsDR8Cy1/crKNT17wxUWldKBm0+HoZ
6NVWhWN7iG+6OWhggFks6T5fq1L2UoU88mvAnW2PF/ui2Mdvqwntam/XAoGAdJzk
ZvTCnyQADnuwr/IrSCTzv7d3v0H8dtlLbtBNKDyBx0wmZ+mBux+EohlzbZgZTca9
CA37/AF+t7eRaCzwee4MiyU/EGC2yA0+5u4V4WUdsCvDUhbmWECl+7QW1nxEvdQP
xG4UlhAeXDP/TXIh2UkdiuMAuR004lQqXM8c+tsCgYBRChKk4jnQCMVByzRjKp8x
+95KNCequK54c40CuYNyoJMPV7MNqaxiNVlbAyzLH4uEjRhPLONV4NV/yx61jFWq
wxIRZbDY/LeE87pP/EpFYwVZqLWMr6pJduASx0+RAxZ9JBVMtLa6cMoEexkvDj7M
URdE6iSbvtlmsteGVrTjOA==
-----END PRIVATE KEY-----
`

/* ----------------------------- helpers ---------------------------------- */

type AnyServer = Server | import('node:net').Server

function limits(overrides: Partial<PocExecutionLimits> = {}): PocExecutionLimits {
  return {
    totalTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    maxRequests: 20,
    maxResponseBytes: 200_000,
    maxCodeBytes: 64_000,
    ...overrides
  }
}

function proxy(overrides: Partial<PocProxyRuntimeConfig> = {}): PocProxyRuntimeConfig {
  return {
    enabled: true,
    url: '',
    username: '',
    password: '',
    caPath: '',
    allowInsecureTls: false,
    ...overrides
  }
}

function listen(server: AnyServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function close(server: AnyServer): Promise<void> {
  // Destroy keep-alive / tunnel sockets first so close() cannot wait forever on
  // a half-open connection (the CONNECT proxy test keeps a raw tunnel socket).
  const withConnections = server as unknown as { closeAllConnections?: () => void }
  withConnections.closeAllConnections?.()
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/** The embedded self-signed fixture expires; skip tests that need trust in it. */
function isTlsFixtureCurrentlyValid(): boolean {
  try {
    const certificate = new X509Certificate(TLS_CERT)
    const now = Date.now()
    return now >= Date.parse(certificate.validFrom) && now <= Date.parse(certificate.validTo)
  } catch {
    return false
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      data += chunk
    })
    request.on('end', () => resolve(data))
  })
}

function bridgeFor(
  allowedOrigins: string[],
  overrides: {
    limits?: Partial<PocExecutionLimits>
    proxy?: PocProxyRuntimeConfig | null
    logger?: typeof silentLogger
  } = {}
): PocHttpBridge {
  return createHttpBridge({
    allowedOrigins,
    proxy: overrides.proxy ?? null,
    limits: limits(overrides.limits),
    logger: overrides.logger ?? silentLogger
  })
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cortex-httpbridge-'))
}

/* ---------------------------- allowlist --------------------------------- */

test('isOriginAllowed: relative/absolute/same-origin and scheme rules', () => {
  const allowed = ['http://127.0.0.1:8080']
  assert.equal(isOriginAllowed('/login', allowed).ok, true)
  assert.equal(isOriginAllowed('login.php', allowed).ok, true)
  assert.equal(isOriginAllowed('//127.0.0.1:8080/x', allowed).ok, true)
  assert.equal(isOriginAllowed('http://127.0.0.1:8080/x?a=1', allowed).ok, true)
  assert.equal(isOriginAllowed('http://127.0.0.1:9090/x', allowed).ok, false)
  assert.equal(isOriginAllowed('https://127.0.0.1:8080/x', allowed).ok, false)
  assert.equal(isOriginAllowed('file:///etc/passwd', allowed).ok, false)
  assert.equal(isOriginAllowed('ftp://127.0.0.1:8080/x', allowed).ok, false)
  assert.equal(isOriginAllowed('data:text/plain,hi', allowed).ok, false)
  assert.equal(isOriginAllowed('javascript:alert(1)', allowed).ok, false)
  assert.equal(isOriginAllowed('http://user:pass@127.0.0.1:8080/x', allowed).ok, false)
  assert.equal(isOriginAllowed('/x', []).ok, false)
})

test('relative URL resolves against the vulnerability target origin', async (t) => {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(`path=${request.url ?? ''}`)
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())

  const relative = await bridge.request({ method: 'GET', url: '/hello?x=1' }, new AbortController().signal)
  assert.equal(relative.status, 200)
  assert.equal(relative.body, 'path=/hello?x=1')
  assert.equal(relative.truncated, false)

  const noLeadingSlash = await bridge.request(
    { method: 'GET', url: 'next/page' },
    new AbortController().signal
  )
  assert.equal(noLeadingSlash.body, 'path=/next/page')
  assert.equal(bridge.requestCount, 2)
})

test('absolute target on another origin is blocked and counted', async (t) => {
  const server = createHttpServer((_request, response) => response.end('ok'))
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())

  await assert.rejects(
    bridge.request({ method: 'GET', url: 'http://127.0.0.1:1/x' }, new AbortController().signal),
    /POC_TARGET_NOT_ALLOWED/
  )
  await assert.rejects(
    bridge.request({ method: 'GET', url: 'file:///C:/Windows/win.ini' }, new AbortController().signal),
    /POC_TARGET_NOT_ALLOWED/
  )
  await assert.rejects(
    bridge.request(
      { method: 'GET', url: `http://user:pass@127.0.0.1:${port}/x` },
      new AbortController().signal
    ),
    /POC_TARGET_NOT_ALLOWED/
  )
  assert.ok(blockedCountOf(bridge) >= 3)
  assert.equal(bridge.requestCount, 0)
})

test('DNS-name target resolving to loopback is blocked (rebinding defence)', async (t) => {
  const server = createHttpServer((_request, response) => response.end('ok'))
  const port = await listen(server)
  t.after(() => close(server))
  // The allowed origin host is a DNS name; it resolves to 127.0.0.1/::1.
  const bridge = bridgeFor([`http://localhost:${port}`])
  t.after(() => bridge.dispose())
  await assert.rejects(
    bridge.request({ method: 'GET', url: '/' }, new AbortController().signal),
    /POC_TARGET_NOT_ALLOWED/
  )
})

test('unsupported methods and header injection are rejected', async (t) => {
  const server = createHttpServer((_request, response) => response.end('ok'))
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())
  await assert.rejects(
    bridge.request({ method: 'TRACE' as never, url: '/' }, new AbortController().signal),
    /POC_INVALID_INPUT/
  )
  await assert.rejects(
    bridge.request(
      { method: 'GET', url: '/', headers: { 'x-test': 'ok\r\nInjected: 1' } },
      new AbortController().signal
    ),
    /POC_INVALID_INPUT/
  )
})

/* ------------------------------ headers --------------------------------- */

test('hop-by-hop and proxy headers are stripped; Cookie/Authorization kept', async (t) => {
  let received: Record<string, string | string[] | undefined> = {}
  const server = createHttpServer((request, response) => {
    received = request.headers
    response.end('ok')
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())

  await bridge.request(
    {
      method: 'GET',
      url: '/',
      headers: {
        Cookie: 'session=abc',
        Authorization: 'Bearer token-value',
        'Proxy-Connection': 'keep-alive',
        'Proxy-Authorization': 'Basic xxx',
        Connection: 'keep-alive',
        'Keep-Alive': 'timeout=5',
        TE: 'trailers',
        Trailer: 'x',
        'Transfer-Encoding': 'chunked',
        Upgrade: 'websocket'
      }
    },
    new AbortController().signal
  )
  assert.equal(received['cookie'], 'session=abc')
  assert.equal(received['authorization'], 'Bearer token-value')
  for (const name of [
    'proxy-connection',
    'proxy-authorization',
    'keep-alive',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ]) {
    assert.equal(received[name], undefined, `${name} must not be forwarded`)
  }
})

test('POST body is forwarded and duplicate response headers are collapsed', async (t) => {
  let body = ''
  const server = createHttpServer(async (request, response) => {
    body = await readBody(request)
    response.setHeader('x-multi', ['one', 'two'])
    response.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/'])
    response.end('done')
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())

  const result = await bridge.request(
    { method: 'POST', url: '/', body: 'hello=world' },
    new AbortController().signal
  )
  assert.equal(result.status, 200)
  assert.equal(body, 'hello=world')
  assert.equal(result.headers['x-multi'], 'one, two')
  assert.equal(result.headers['set-cookie'], 'a=1; Path=/\nb=2; Path=/')
})

/* ------------------------------ redirects ------------------------------- */

test('same-origin redirects are followed manually (each hop validated)', async (t) => {
  const server = createHttpServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { location: '/final' })
      response.end()
      return
    }
    response.end('final')
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())
  const result = await bridge.request({ method: 'GET', url: '/start' }, new AbortController().signal)
  assert.equal(result.status, 200)
  assert.equal(result.body, 'final')
  assert.equal(bridge.requestCount, 2)
})

test('followRedirects=false exposes the login 302 and Set-Cookie', async (t) => {
  const server = createHttpServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(302, {
        location: '/',
        'set-cookie': 'session=abc123; HttpOnly; Path=/'
      })
      response.end()
      return
    }
    response.end('final')
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())
  const result = await bridge.request(
    { method: 'POST', url: '/login', followRedirects: false },
    new AbortController().signal
  )
  assert.equal(result.status, 302)
  assert.match(result.headers['set-cookie'] ?? '', /session=abc123/)
  assert.equal(result.headers.location, '/')
  assert.equal(bridge.requestCount, 1)
})

test('cross-origin redirect is blocked', async (t) => {
  const other = createHttpServer((_request, response) => response.end('other'))
  const otherPort = await listen(other)
  t.after(() => close(other))
  const server = createHttpServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${otherPort}/steal` })
    response.end()
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())
  await assert.rejects(
    bridge.request({ method: 'GET', url: '/redirect' }, new AbortController().signal),
    /POC_TARGET_NOT_ALLOWED/
  )
  assert.ok(blockedCountOf(bridge) >= 1)
})

test('redirect loop is capped at 5 hops', async (t) => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(301, { location: '/loop' })
    response.end()
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())
  await assert.rejects(
    bridge.request({ method: 'GET', url: '/loop' }, new AbortController().signal),
    /重定向次数超过上限/
  )
  assert.equal(bridge.requestCount, 6)
})

/* ------------------------------- limits --------------------------------- */

test('response larger than maxResponseBytes is truncated', async (t) => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200)
    response.end('x'.repeat(50_000))
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`], { limits: { maxResponseBytes: 1_000 } })
  t.after(() => bridge.dispose())
  const result = await bridge.request({ method: 'GET', url: '/' }, new AbortController().signal)
  assert.equal(result.truncated, true)
  assert.equal(Buffer.byteLength(result.body, 'utf8'), 1_000)
})

test('maxRequests hard cap stops the run', async (t) => {
  const server = createHttpServer((_request, response) => response.end('ok'))
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`], { limits: { maxRequests: 2 } })
  t.after(() => bridge.dispose())
  const signal = new AbortController().signal
  await bridge.request({ method: 'GET', url: '/' }, signal)
  await bridge.request({ method: 'GET', url: '/' }, signal)
  await assert.rejects(bridge.request({ method: 'GET', url: '/' }, signal), /maxRequests=2/)
  assert.equal(bridge.requestCount, 2)
})

test('per-request timeout is enforced and clamped to the configured limit', async (t) => {
  const server = createHttpServer((_request, response) => {
    setTimeout(() => response.end('late'), 5_000)
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`], { limits: { requestTimeoutMs: 400 } })
  t.after(() => bridge.dispose())
  const startedAt = Date.now()
  await assert.rejects(
    bridge.request({ method: 'GET', url: '/slow', timeoutMs: 30_000 }, new AbortController().signal),
    /超时/
  )
  assert.ok(Date.now() - startedAt < 2_500, 'timeout must use the clamped limit')
})

test('external AbortSignal cancels an in-flight request', async (t) => {
  const server = createHttpServer((_request, response) => {
    setTimeout(() => response.end('late'), 5_000)
  })
  const port = await listen(server)
  t.after(() => close(server))
  const bridge = bridgeFor([`http://127.0.0.1:${port}`])
  t.after(() => bridge.dispose())
  const controller = new AbortController()
  const pending = bridge.request({ method: 'GET', url: '/slow' }, controller.signal)
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, /POC_ABORTED/)
})

/* -------------------------------- proxy --------------------------------- */

test('HTTP proxy: absolute-form request + Basic auth, never logged', async (t) => {
  const seen: Array<{ url: string; auth: string | undefined }> = []
  const proxyServer = createHttpServer((request, response) => {
    seen.push({ url: request.url ?? '', auth: request.headers['proxy-authorization'] })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('proxied')
  })
  const proxyPort = await listen(proxyServer)
  t.after(() => close(proxyServer))
  const warnLines: string[] = []
  const logger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (message: string): void => {
      warnLines.push(message)
    },
    error: (): void => undefined
  }
  const bridge = bridgeFor(['http://target.internal:8080'], {
    proxy: proxy({ url: `http://127.0.0.1:${proxyPort}`, username: 'burp', password: 'secret-pass' }),
    logger
  })
  t.after(() => bridge.dispose())
  const result = await bridge.request(
    { method: 'GET', url: 'http://target.internal:8080/admin?x=1' },
    new AbortController().signal
  )
  assert.equal(result.status, 200)
  assert.equal(result.body, 'proxied')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.url, 'http://target.internal:8080/admin?x=1')
  assert.equal(seen[0]?.auth, `Basic ${Buffer.from('burp:secret-pass').toString('base64')}`)
  const allLogged = warnLines.join('\n')
  assert.equal(allLogged.includes('secret-pass'), false)
  assert.equal(allLogged.includes('burp'), false)
})

test('HTTPS proxy CONNECT tunnel reaches the TLS target', async (t) => {
  const httpsServer = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, (_request, response) => {
    response.end('secure')
  })
  const httpsPort = await listen(httpsServer)
  t.after(() => close(httpsServer))
  const connectTargets: string[] = []
  const tunnelSockets = new Set<Socket>()
  const proxyServer = createTcpServer((socket: Socket) => {
    tunnelSockets.add(socket)
    socket.once('close', () => tunnelSockets.delete(socket))
    socket.once('data', (chunk: Buffer) => {
      const header = chunk.toString('utf8')
      const match = /^CONNECT ([^ ]+) HTTP\//.exec(header)
      if (match?.[1] !== undefined) connectTargets.push(match[1])
      if (match?.[1] === undefined) {
        socket.destroy()
        return
      }
      const [host, portText] = match[1].split(':')
      const upstream = netConnect(Number(portText), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('close', () => tunnelSockets.delete(upstream))
      upstream.on('error', () => socket.destroy())
    })
  })
  const proxyPort = await listen(proxyServer)
  t.after(() => {
    for (const socket of tunnelSockets) socket.destroy()
    return close(proxyServer)
  })
  const bridge = bridgeFor([`https://127.0.0.1:${httpsPort}`], {
    proxy: proxy({
      url: `http://127.0.0.1:${proxyPort}`,
      username: 'u',
      password: 'p',
      allowInsecureTls: true
    })
  })
  t.after(() => bridge.dispose())
  const result = await bridge.request(
    { method: 'GET', url: `https://127.0.0.1:${httpsPort}/` },
    new AbortController().signal
  )
  assert.equal(result.status, 200)
  assert.equal(result.body, 'secure')
  assert.equal(connectTargets.length, 1)
  assert.equal(connectTargets[0], `127.0.0.1:${httpsPort}`)
})

test('invalid proxy configuration fails closed with POC_INVALID_CONFIG', async (t) => {
  const socks = bridgeFor(['http://target.internal:8080'], {
    proxy: proxy({ url: 'socks5://127.0.0.1:1080' })
  })
  t.after(() => socks.dispose())
  await assert.rejects(
    socks.request({ method: 'GET', url: 'http://target.internal:8080/' }, new AbortController().signal),
    /POC_INVALID_CONFIG/
  )
})

/* -------------------------- TLS / insecure mode ------------------------- */

test('TLS verification is on by default for self-signed targets', async (t) => {
  const httpsServer = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, (_request, response) => {
    response.end('secure')
  })
  const httpsPort = await listen(httpsServer)
  t.after(() => close(httpsServer))
  const bridge = bridgeFor([`https://127.0.0.1:${httpsPort}`])
  t.after(() => bridge.dispose())
  await assert.rejects(
    bridge.request({ method: 'GET', url: `https://127.0.0.1:${httpsPort}/` }, new AbortController().signal)
  )
})

test('allowInsecureTls disables verification only for that bridge and logs a marker', async (t) => {
  const httpsServer = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, (_request, response) => {
    response.end('secure')
  })
  const httpsPort = await listen(httpsServer)
  t.after(() => close(httpsServer))
  const warnings: string[] = []
  const logger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (message: string): void => {
      warnings.push(message)
    },
    error: (): void => undefined
  }
  const bridge = bridgeFor([`https://127.0.0.1:${httpsPort}`], {
    proxy: proxy({ enabled: false, url: '', allowInsecureTls: true }),
    logger
  })
  t.after(() => bridge.dispose())
  const result = await bridge.request(
    { method: 'GET', url: `https://127.0.0.1:${httpsPort}/` },
    new AbortController().signal
  )
  assert.equal(result.status, 200)
  assert.equal(result.body, 'secure')
  assert.ok(
    warnings.some((line) => line.includes('TLS verification disabled')),
    'the per-run insecure TLS marker must be logged'
  )
  assert.equal(process.env['NODE_TLS_REJECT_UNAUTHORIZED'], undefined)
})

test('unreadable caPath fails closed at bridge creation', () => {
  const dir = makeTempDir()
  try {
    assert.throws(
      () =>
        bridgeFor(['https://example.test'], {
          proxy: proxy({ caPath: join(dir, 'missing-ca.pem') })
        }),
      /POC_INVALID_CONFIG/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'CA bundle from caPath is loaded into the TLS agent',
  { skip: isTlsFixtureCurrentlyValid() ? false : 'embedded TLS fixture certificate has expired' },
  async (t) => {
    const dir = makeTempDir()
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const caPath = join(dir, 'ca.pem')
    writeFileSync(caPath, TLS_CERT, 'utf8')
    const httpsServer = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, (_request, response) => {
      response.end('trusted')
    })
    const httpsPort = await listen(httpsServer)
    t.after(() => close(httpsServer))
    const bridge = bridgeFor([`https://127.0.0.1:${httpsPort}`], {
      proxy: proxy({ enabled: false, url: '', caPath })
    })
    t.after(() => bridge.dispose())
    const result = await bridge.request(
      { method: 'GET', url: `https://127.0.0.1:${httpsPort}/` },
      new AbortController().signal
    )
    assert.equal(result.status, 200)
    assert.equal(result.body, 'trusted')
  }
)

test('disposed bridge refuses further requests', async () => {
  const bridge = bridgeFor(['http://127.0.0.1:1'])
  bridge.dispose()
  await assert.rejects(
    bridge.request({ method: 'GET', url: '/' }, new AbortController().signal),
    /POC_ABORTED/
  )
})
