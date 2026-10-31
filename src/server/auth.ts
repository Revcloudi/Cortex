import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  WEB_SESSION_COOKIE,
  WEB_SESSION_MAX_AGE_SECONDS,
  WEB_TOKEN_QUERY_PARAM
} from '../shared/web'
import { isHostHeaderAllowed, readCookie } from './security'

/**
 * Authentication for the local/intranet Web UI.
 *
 * - Every `ctx web` run generates a fresh 32-byte random token (base64url).
 * - The first screen (`GET /?token=...`) exchanges it for an HttpOnly +
 *   SameSite=Strict session cookie, then redirects so the token disappears from
 *   the URL, history and `Referer` chains.
 * - Programmatic clients (curl / verification scripts) may also send
 *   `Authorization: Bearer <token>`; the token is never accepted from a query
 *   string anywhere except the one-shot bootstrap URL.
 * - Comparison is constant-time via SHA-256 digests.
 * - Mutating requests additionally pass the Origin / Referer / Sec-Fetch-Site
 *   gate below, which blocks cross-site request forgery even with a cookie.
 */

/** 32 random bytes, URL-safe (43 chars). Never logged, never persisted. */
export function generateWebToken(): string {
  return randomBytes(32).toString('base64url')
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** Constant-time comparison; length differences are absorbed by hashing first. */
function tokensEqual(candidate: string, expected: string): boolean {
  return timingSafeEqual(tokenDigest(candidate), tokenDigest(expected))
}

export interface WebAuthOptions {
  /** Fixed token for automated verification; omitted in normal runs. */
  token?: string
  /** Hostnames accepted in the `Host` header (DNS-rebinding defence). */
  allowedHostnames: ReadonlySet<string>
}

export class WebAuth {
  readonly token: string
  private readonly allowedHostnames: ReadonlySet<string>

  constructor(options: WebAuthOptions) {
    const override = options.token?.trim()
    this.token = override !== undefined && override.length > 0 ? override : generateWebToken()
    this.allowedHostnames = options.allowedHostnames
  }

  /** `Host:` must name this machine (loopback / its own interface / opt-in proxy host). */
  isHostAllowed(hostHeader: string | undefined): boolean {
    return isHostHeaderAllowed(hostHeader, this.allowedHostnames)
  }

  verifyToken(candidate: string | null | undefined): boolean {
    if (typeof candidate !== 'string' || candidate.length === 0) return false
    return tokensEqual(candidate, this.token)
  }

  readSessionToken(req: IncomingMessage): string | null {
    return readCookie(req.headers.cookie, WEB_SESSION_COOKIE)
  }

  readBearerToken(req: IncomingMessage): string | null {
    const raw = req.headers.authorization
    if (typeof raw !== 'string') return null
    const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
    return match?.[1]?.trim() ?? null
  }

  /** Cookie session or Bearer token; everything else is a 401. */
  isAuthorized(req: IncomingMessage): boolean {
    return (
      this.verifyToken(this.readSessionToken(req)) || this.verifyToken(this.readBearerToken(req))
    )
  }

  /** True only for the one-shot `/?token=...` bootstrap URL. */
  hasBootstrapToken(url: URL): boolean {
    return this.verifyToken(url.searchParams.get(WEB_TOKEN_QUERY_PARAM))
  }

  /**
   * HttpOnly + SameSite=Strict session cookie.
   *
   * `Secure` is intentionally not set: the supported deployments are plain
   * loopback/intranet HTTP; adding `Secure` would silently break them. A TLS
   * reverse proxy is expected to terminate TLS and keep the upstream on HTTP.
   */
  setSessionCookie(res: ServerResponse): void {
    res.setHeader(
      'Set-Cookie',
      `${WEB_SESSION_COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${WEB_SESSION_MAX_AGE_SECONDS}`
    )
  }

  /**
   * Origin / Referer verification for mutating requests.
   *
   * `true` = same origin, `false` = cross-origin (reject), `null` = neither
   * header present (non-browser client; must authenticate with a Bearer token).
   */
  checkRequestOrigin(req: IncomingMessage): boolean | null {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.trim().length > 0) {
      return this.originAllowed(origin)
    }
    const referer = req.headers.referer
    if (typeof referer === 'string' && referer.trim().length > 0) {
      return this.originAllowed(referer)
    }
    return null
  }

  /**
   * `Sec-Fetch-Site` is browser-supplied; `same-origin` / `none` are the only
   * values a genuine same-origin request can carry. `null` when absent.
   */
  checkFetchSite(req: IncomingMessage): boolean | null {
    const raw = req.headers['sec-fetch-site']
    if (typeof raw !== 'string') return null
    const value = raw.trim().toLowerCase()
    return value === 'same-origin' || value === 'none'
  }

  private originAllowed(value: string): boolean {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return false
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return this.isHostAllowed(url.host)
  }
}

/**
 * Rendered for unauthenticated HTML requests. Static, self-contained and
 * script-free: no token echo, no external resources, no auto-refresh.
 */
export function unauthorizedPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cortex Web · 需要登录</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fbfaf8;
         color: #1f2937; font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", sans-serif; }
  main { width: min(520px, calc(100vw - 48px)); border: 1px solid #e5e7eb; border-radius: 12px;
         background: #fff; padding: 28px 30px; box-shadow: 0 24px 80px -32px rgba(15,23,42,.28); }
  h1 { margin: 0 0 10px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 8px 0; color: #4b5563; }
  code { font-family: ui-monospace, Consolas, monospace; background: #f3f4f6; padding: 1px 5px;
         border-radius: 4px; font-size: 12px; }
  .hint { margin-top: 18px; padding-top: 14px; border-top: 1px solid #f3f4f6; font-size: 12px; color: #6b7280; }
</style>
</head>
<body>
<main>
  <h1>需要访问令牌 / Token required</h1>
  <p>此页面由本机或内网的 <code>ctx web</code> 服务提供，必须使用启动时打印的一次性登录链接打开。</p>
  <p>Open the one-time token URL printed by the <code>ctx web</code> command that started this server.</p>
  <p class="hint">如果服务已重启，请回到终端重新复制登录链接；令牌不会保存在浏览器或服务端日志中。<br>
  If the server restarted, copy the fresh login URL from the terminal. The token is never logged or persisted.</p>
</main>
</body>
</html>`
}
