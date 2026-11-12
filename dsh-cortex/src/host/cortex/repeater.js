/**
 * Host handler for the standalone Web Fuzzer used by the ported Cortex UI.
 *
 *   POST /cortex-api/cortex/repeater/send { method, url, headers?, body?,
 *                                           followRedirects?, vulnId? }
 *        -> RepeaterSendResult
 *
 * This is the independent fuzzer path: it never requires a vulnerability row
 * and `vulnId` is optional history metadata only. The outbound request is
 * executed by `src/host/fuzzer.js` with its own public-target SSRF policy
 * (http(s) only, no loopback/private/link-local/metadata targets, DNS answers
 * revalidated, redirects revalidated per hop, 2 MiB capped body, protocol
 * headers forbidden). It does NOT use the vulnerability-origin allowlist of
 * `src/host/retest.js`.
 *
 * The renderer's request uses camelCase; request headers/bodies are never
 * logged. A successful send also appends one best-effort entry to the local
 * Repeater history (a disk failure never changes the response; a missing
 * `vulnId` is stored as `''`).
 */

import { ApiError, readJsonBody, sendJson } from '../http.js'
import { sendFuzzerRequest, validateFuzzerRequest } from '../fuzzer.js'
import { recordSendHistory } from './repeater-store.js'

/**
 * @param {{req: import('node:http').IncomingMessage,
 *          res: import('node:http').ServerResponse,
 *          config: {allowNetwork?: boolean}}} ctx
 */
export async function handleSend({ req, res, config }) {
  if (config && config.allowNetwork === false) {
    throw new ApiError(403, 'FORBIDDEN', 'outbound network is disabled')
  }
  const body = await readJsonBody(req)
  const request = validateFuzzerRequest(body)
  const result = await sendFuzzerRequest({ request })

  const responsePayload = {
    request: {
      method: request.method,
      url: request.url instanceof URL ? request.url.href : String(request.url),
      headers: request.headers,
      body: request.body === undefined || request.body === null ? '' : String(request.body),
    },
    response: {
      status: result.status,
      headers: result.headers,
      body: result.body,
      durationMs: result.durationMs,
      truncated: result.bodyTruncated === true,
    },
  }

  // Best-effort local history (contract): a disk failure must never fail the
  // send, and the response shape returned to the renderer stays unchanged.
  // Respond first so the renderer never waits for the history write.
  sendJson(res, 200, responsePayload)
  recordSendHistory({
    // `vulnId` may be absent; the store persists `''` in that case.
    vulnId: request.vulnId,
    request: responsePayload.request,
    result,
  })
}
