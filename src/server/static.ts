import { existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, normalize, resolve, sep } from 'node:path'
import { sendHtml, sendText } from './security'

/**
 * Static SPA serving for the built Web UI (`out/web`).
 *
 * Safety rules:
 * - the requested path is decoded, normalised and proven to stay inside
 *   `webRoot` (no `..`, no absolute path, no null byte) before any file access;
 * - unknown assets with an extension return 404 instead of the HTML shell;
 * - only client-side routes (no extension) fall back to `index.html`;
 * - directory listings are never produced.
 */

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}

/** Vite emits content-hashed files under `assets/`; they never change under one name. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
const INDEX_CACHE = 'no-store'
const OTHER_CACHE = 'no-cache'

export interface StaticServer {
  /** True when `<webRoot>/index.html` exists (i.e. `npm run build:web` ran). */
  hasIndex: boolean
  /** Write a response and return true, or return false when nothing matched. */
  serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean
}

/** Resolve a URL path to a file inside `root`, or null when it tries to escape. */
function safeFileInside(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\u0000')) return null
  const relative = decoded.replace(/^[/\\]+/, '')
  if (relative.length === 0) return null
  const target = resolve(root, normalize(relative))
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null
  return target
}

function missingBuildHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Cortex Web · 前端资源未构建</title></head>
<body style="font-family:-apple-system,'Segoe UI',sans-serif;padding:40px;line-height:1.7;color:#1f2937">
<h1 style="font-size:18px">Web 前端资源未构建 / Web assets not built</h1>
<p>未找到 Web 静态资源目录：<code>out/web</code>。</p>
<p>请先在仓库根目录运行：</p>
<pre style="background:#f3f4f6;padding:12px;border-radius:8px">npm run build:web
npm run build:server
npm run build:cli</pre>
<p>然后重新执行 <code>ctx web</code>。</p>
</body></html>`
}

export function createStaticServer(webRoot: string): StaticServer {
  const root = resolve(webRoot)
  const indexFile = resolve(root, 'index.html')
  const hasIndex = existsSync(indexFile)

  const serveFile = (
    req: IncomingMessage,
    res: ServerResponse,
    filePath: string,
    cacheControl: string
  ): void => {
    const data = readFileSync(filePath)
    res.statusCode = 200
    res.setHeader(
      'Content-Type',
      MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    )
    res.setHeader('Content-Length', data.byteLength)
    res.setHeader('Cache-Control', cacheControl)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(data)
  }

  return {
    hasIndex,
    serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') return false
      if (!hasIndex) {
        sendHtml(res, 503, missingBuildHtml())
        return true
      }
      if (pathname === '/' || pathname.length === 0) {
        serveFile(req, res, indexFile, INDEX_CACHE)
        return true
      }

      const filePath = safeFileInside(root, pathname)
      if (filePath !== null && existsSync(filePath)) {
        const stat = statSync(filePath)
        if (stat.isFile()) {
          const cacheControl = pathname.startsWith('/assets/') ? IMMUTABLE_CACHE : OTHER_CACHE
          serveFile(req, res, filePath, cacheControl)
          return true
        }
      }

      // A missing hashed asset must 404: serving the HTML shell with a JS MIME
      // type would be blocked by nosniff and hide the real problem.
      if (extname(pathname).length > 0) {
        sendText(res, 404, 'Not found')
        return true
      }

      // Client-side route: hand the SPA shell to the router.
      serveFile(req, res, indexFile, INDEX_CACHE)
      return true
    }
  }
}
