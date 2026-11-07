/**
 * Host handler for the retest repeater used by the ported Cortex UI.
 *
 *   POST /repeater/send { RepeaterSendInput } -> RepeaterSendResult
 *
 * The outbound request is executed by `src/host/retest.js` (origin allowlist
 * derived from the vulnerability + its assets, no redirects unless asked,
 * <= 5 hops, 15 s per hop, 2 MiB capped body, protocol headers forbidden).
 * This module only validates the shared input type and maps the internal
 * result onto the exact shared `RepeaterSendResult` shape.
 *
 * The renderer's RepeaterSendInput uses camelCase; the shared schema accepts
 * that. Request headers/bodies are never logged. A successful send also
 * appends one best-effort entry to the local Repeater history (single-send
 * convenience; a disk failure never changes the response).
 */

import { ApiError, readJsonBody, sendJson } from '../http.js'
import { sendRetest, validateSendRequest } from '../retest.js'
import { recordSendHistory } from './repeater-store.js'

/**
 * @param {{req: import('node:http').IncomingMessage,
 *          res: import('node:http').ServerResponse,
 *          config: {allowNetwork?: boolean},
 *          repository: import('../repository.js').Repository}} ctx
 */
export async function handleSend({ req, res, config, repository }) {
  if (config && config.allowNetwork === false) {
    throw new ApiError(403, 'FORBIDDEN', 'outbound network is disabled')
  }
  const body = await readJsonBody(req)
  const request = validateSendRequest(body)
  // Reuses the tested SSRF-safe path: allowlist + redirect policy + limits.
  const context = repository.getRetestContext(request.vulnId)
  const result = await sendRetest({ request, context })

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
    vulnId: request.vulnId,
    request: responsePayload.request,
    result,
  })
}
