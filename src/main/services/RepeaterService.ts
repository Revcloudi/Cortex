/**
 * Manual retest repeater: sends user-edited raw HTTP requests through the
 * retest-scoped proxy. It deliberately does not execute generated JavaScript.
 */
import type { DatabaseService } from '../../core/db/DatabaseService'
import type { HubLogger } from '../../core/logging'
import type { RepeaterSendInput, RepeaterSendResult } from '../../shared/repeater'
import { createPocError, POC_ERROR_CODES } from '../../shared/poc'
import { HttpBridge } from './HttpBridge'
import type { PocConfigService, PocHttpMethod } from './pocContracts'

export interface RepeaterService {
  send(input: RepeaterSendInput): Promise<RepeaterSendResult>
  dispose(): void
}

export function createRepeaterService(options: {
  db: DatabaseService
  config: PocConfigService
  logger: HubLogger
}): RepeaterService {
  const { db, config, logger } = options
  const bridges = new Set<HttpBridge>()

  return {
    async send(input) {
      const vuln = db.getById(input.vulnId)
      if (vuln === null) {
        throw createPocError(POC_ERROR_CODES.ARTIFACT_NOT_FOUND, '未找到该漏洞')
      }
      if (vuln.realm !== 'web' || vuln.service_host !== '' || vuln.internal_service_id !== '') {
        throw createPocError(POC_ERROR_CODES.INVALID_INPUT, '重放仅支持 Web 漏洞')
      }
      const origin = new URL(vuln.target_url).origin
      const bridge = new HttpBridge({
        allowedOrigins: [origin],
        proxy: config.getProxyRuntime(),
        limits: config.getExecutionLimits(),
        logger
      })
      bridges.add(bridge)
      try {
        const response = await bridge.request(
          {
            method: input.method as PocHttpMethod,
            url: input.url,
            headers: input.headers,
            body: input.body,
            timeoutMs: config.getExecutionLimits().requestTimeoutMs,
            followRedirects: input.followRedirects
          },
          new AbortController().signal
        )
        return {
          request: {
            method: input.method,
            url: input.url,
            headers: input.headers,
            body: input.body ?? ''
          },
          response
        }
      } finally {
        bridges.delete(bridge)
        bridge.dispose()
      }
    },
    dispose() {
      for (const bridge of bridges) bridge.dispose()
      bridges.clear()
    }
  }
}
