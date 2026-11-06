// Same-origin API client for the plugin's own Host half (/cortex-api).
// The browser half NEVER touches the filesystem or the Cortex database directly.
const DEFAULT_BASE = '/cortex-api'

class ApiError extends Error {
  constructor(message, options) {
    super(message || 'request failed')
    this.name = 'ApiError'
    const opts = options || {}
    this.status = typeof opts.status === 'number' ? opts.status : 0
    this.code = opts.code || (this.status ? `HTTP_${this.status}` : 'UNKNOWN')
    this.details = opts.details === undefined ? null : opts.details
    this.retryable = opts.retryable !== undefined ? !!opts.retryable : this.status >= 500 || this.status === 0
  }
}

function encodeQuery(query) {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const key of Object.keys(query)) {
    const value = query[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item))
    else params.append(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

function parseErrorPayload(payload, status, statusText) {
  if (!payload || typeof payload !== 'object') {
    return new ApiError(statusText || `HTTP ${status}`, { status })
  }
  const message = typeof payload.error === 'string' && payload.error ? payload.error : statusText || `HTTP ${status}`
  return new ApiError(message, {
    status,
    code: typeof payload.code === 'string' && payload.code ? payload.code : `HTTP_${status}`,
    details: payload.details,
    retryable: status >= 500,
  })
}

function createApi(options) {
  const opts = options || {}
  const base = opts.base || DEFAULT_BASE
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 20000
  const inflight = new Set()

  function abortAll() {
    for (const controller of inflight) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    inflight.clear()
  }

  async function request(path, config) {
    const cfg = config || {}
    const method = cfg.method || 'GET'
    const controller = new AbortController()
    inflight.add(controller)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }, cfg.timeoutMs || timeoutMs)

    const headers = { Accept: cfg.text ? 'text/markdown, text/plain, */*' : 'application/json' }
    let body
    if (cfg.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(cfg.body)
    }

    try {
      const response = await fetch(base + path + encodeQuery(cfg.query), {
        method,
        headers,
        body,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })

      if (!response.ok) {
        let payload = null
        try {
          payload = await response.json()
        } catch {
          /* non-JSON error body */
        }
        const error = parseErrorPayload(payload, response.status, response.statusText)
        if (typeof opts.onError === 'function') {
          try {
            opts.onError(error)
          } catch {
            /* ignore */
          }
        }
        throw error
      }

      if (cfg.text) return await response.text()
      if (cfg.responseType === 'response') return response
      const text = await response.text()
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch {
        throw new ApiError('invalid JSON from Host', { status: 502, code: 'INVALID_JSON' })
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (timedOut) {
        throw new ApiError('request timed out', { status: 0, code: 'TIMEOUT', retryable: true })
      }
      const name = error && error.name
      if (name === 'AbortError') throw new ApiError('request aborted', { status: 0, code: 'ABORTED', retryable: true })
      throw new ApiError('network error: cannot reach the DSH Host', { status: 0, code: 'NETWORK', retryable: true })
    } finally {
      clearTimeout(timer)
      inflight.delete(controller)
    }
  }

  return {
    base,
    abortAll,
    get: (path, query, extra) => request(path, Object.assign({ method: 'GET', query }, extra)),
    getText: (path, query, extra) => request(path, Object.assign({ method: 'GET', query, text: true }, extra)),
    patch: (path, body, extra) => request(path, Object.assign({ method: 'PATCH', body }, extra)),
    post: (path, body, extra) => request(path, Object.assign({ method: 'POST', body }, extra)),
  }
}

function isAbortError(error) {
  return !!error && (error.code === 'ABORTED' || error.name === 'AbortError')
}

module.exports = { ApiError, createApi, isAbortError, encodeQuery }
