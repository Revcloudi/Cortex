/**
 * Host half entry point (contract §2.1).
 *
 * ```js
 * const host = createCortexHost({ config })
 * webServer.register({ kind: 'prefix', path: '/cortex-api', handler: host.handler })
 * // later
 * await host.dispose()
 * ```
 *
 * `handler(req, res)` never throws and never rejects: every failure is mapped
 * onto the JSON error envelope. `dispose()` closes the SQLite connection and is
 * idempotent. The database is opened lazily on the first request.
 *
 * Requests under `/cortex-api/cortex/**` are delegated by `router.js` to the
 * ported Cortex UI dispatcher (`src/host/cortex/index.js`); this factory only
 * wires the shared DatabaseHolder/Repository/config into both halves.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseHolder } from './db.js'
import { sendError } from './http.js'
import { Repository } from './repository.js'
import { createRouter } from './router.js'
import { getConfiguredDbPath } from './cortex/settings.js'

export const PLUGIN_NAME = 'dsh-cortex'

/** Verified DSH version from docs/dsh-api-confirmed.md. */
export const DSH_VERSION = '0.2.2-rc.1'

const FALLBACK_VERSION = '0.1.0'

function readPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    if (pkg && typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
  } catch {
    /* package.json is optional at runtime; fall back to the known version */
  }
  return FALLBACK_VERSION
}

/**
 * Resolve effective config: explicit `config` wins, environment variables fill
 * the gaps (contract §2.1/§2.2).
 * @param {{dbPath?:string, readOnly?:boolean, allowNetwork?:boolean}|undefined} config
 */
export function resolveHostConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  let dbPath = typeof cfg.dbPath === 'string' && cfg.dbPath.length > 0 ? cfg.dbPath : undefined
  if (dbPath === undefined) {
    const envPath = process.env.CORTEX_DB_PATH
    if (typeof envPath === 'string' && envPath.length > 0) dbPath = envPath
  }
  // A path chosen from the plugin's database setup screen (web DSH) is used
  // when neither the plugin config nor the environment overrides it.
  if (dbPath === undefined) {
    const saved = getConfiguredDbPath()
    if (typeof saved === 'string' && saved.length > 0) dbPath = saved
  }
  if (dbPath === undefined) dbPath = join(homedir(), '.cortex', 'data.db')
  const readOnly = cfg.readOnly === true || process.env.CORTEX_DB_READONLY === '1'
  const allowNetwork = cfg.allowNetwork === false ? false : true
  return { dbPath, readOnly, allowNetwork }
}

/**
 * Create the host half.
 * @param {{config?: {dbPath?:string, readOnly?:boolean, allowNetwork?:boolean}}} [options]
 * @returns {{handler: (req: any, res: any) => Promise<void>, dispose: () => Promise<void>}}
 */
export function createCortexHost(options = {}) {
  let resolved
  try {
    resolved = resolveHostConfig(options && options.config)
  } catch {
    resolved = {
      dbPath: join(homedir(), '.cortex', 'data.db'),
      readOnly: true,
      allowNetwork: false,
    }
  }

  const holder = new DatabaseHolder({ dbPath: resolved.dbPath, readOnly: resolved.readOnly })
  const repository = new Repository(holder)
  const router = createRouter({
    holder,
    repository,
    config: resolved,
    version: readPluginVersion(),
    dshVersion: DSH_VERSION,
  })

  let disposed = false

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  function handler(req, res) {
    if (disposed) {
      try {
        res.statusCode = 500
        sendError(res, new Error('host is disposed'))
      } catch {
        /* response is gone */
      }
      return Promise.resolve()
    }
    return Promise.resolve()
      .then(() => router(req, res))
      .catch((err) => {
        try {
          sendError(res, err)
        } catch {
          /* response is gone */
        }
      })
  }

  function dispose() {
    if (disposed) return Promise.resolve()
    disposed = true
    try {
      holder.close()
    } catch {
      /* ignore close failures */
    }
    return Promise.resolve()
  }

  return {
    handler,
    dispose,
    /**
     * Data access handed to the plugin's agent tools (non-MCP access to the
     * same Cortex database). The holder is shared with the HTTP half, so both
     * transports see the same connection and compatibility state.
     */
    dataAccess: { holder, config: resolved, repository },
  }
}
