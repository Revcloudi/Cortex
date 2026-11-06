// Parse Markdown reproduction steps into concrete HTTP request steps.
//
// Cortex stores reproduction_steps as Markdown with fenced ```http blocks, e.g.
//
//   ### 步骤 1：未认证访问被拒绝
//   ```http
//   GET /login HTTP/1.1
//   Host: 127.0.0.1:8080
//   ```
//
// This module is pure (no DOM, no React) so both the retest page and tests can
// use it. It keeps all steps in order and resolves relative request targets
// against the vulnerability's target URL.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function normalizeMethod(value) {
  const method = String(value || '').toUpperCase()
  return METHODS.indexOf(method) >= 0 ? method : ''
}

function splitFences(markdown) {
  const text = String(markdown || '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const blocks = []
  let current = null
  let heading = ''
  for (const line of lines) {
    const fence = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence) {
      if (current) {
        blocks.push({ lang: current.lang, lines: current.lines, heading: current.heading })
        current = null
      } else {
        current = { lang: (fence[1] || '').toLowerCase(), lines: [], heading }
      }
      continue
    }
    if (current) current.lines.push(line)
    else {
      const match = /^\s*#{2,6}\s+(.*\S)\s*$/.exec(line)
      if (match) heading = match[1]
    }
  }
  if (current) blocks.push({ lang: current.lang, lines: current.lines, heading: current.heading })
  return blocks
}

/**
 * Parse one raw HTTP request text block.
 * @param {string} raw
 * @param {string} baseUrl used to resolve path-only request targets
 */
function parseHttpBlock(raw, baseUrl) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n')
  let start = 0
  while (start < lines.length && !lines[start].trim()) start++
  if (start >= lines.length) return null

  const requestLine = /^\s*([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?\s*$/.exec(lines[start])
  if (!requestLine) return null
  const method = normalizeMethod(requestLine[1])
  if (!method) return null
  const target = requestLine[2]

  const headers = {}
  let index = start + 1
  for (; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      break
    }
    const header = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(line)
    if (header) headers[header[1]] = header[2].trim()
  }
  const bodyLines = lines.slice(index).filter((line, i, all) => i < all.length)
  const body = bodyLines.join('\n').replace(/\s+$/, '')

  let url = target
  if (!/^https?:\/\//i.test(url)) {
    const base = String(baseUrl || '').trim() || 'http://127.0.0.1/'
    try {
      url = new URL(target, base).toString()
    } catch {
      url = target
    }
  }

  return {
    method,
    url,
    target,
    headers,
    body: body || '',
    raw: lines.slice(start).join('\n').trim(),
  }
}

/**
 * Parse a vulnerability's reproduction_steps into ordered HTTP steps.
 * @returns {{index:number,title:string,method:string,url:string,headers:object,body:string,raw:string}[]}
 */
function parseHttpSteps(markdown, baseUrl) {
  const blocks = splitFences(markdown)
  const steps = []
  for (const block of blocks) {
    if (block.lang !== 'http') continue
    const parsed = parseHttpBlock(block.lines.join('\n'), baseUrl)
    if (!parsed) continue
    steps.push({
      index: steps.length + 1,
      title: block.heading || '',
      method: parsed.method,
      url: parsed.url,
      target: parsed.target,
      headers: parsed.headers,
      body: parsed.body,
      raw: parsed.raw,
    })
  }
  return steps
}

/** Map parsed headers to an object the Host accepts (drops hop-by-hop headers). */
function requestHeadersForSend(headers) {
  const output = {}
  const blocked = { host: 1, 'content-length': 1, connection: 1, 'transfer-encoding': 1, 'proxy-connection': 1 }
  for (const key of Object.keys(headers || {})) {
    if (blocked[String(key).toLowerCase()]) continue
    output[key] = String(headers[key])
  }
  return output
}

module.exports = { METHODS, parseHttpBlock, parseHttpSteps, requestHeadersForSend, normalizeMethod }
