/**
 * Asset identity layer (Cortex schema v5 compatible).
 *
 * The legacy `assets` table keys every row by `host_port`. That is correct for
 * a web origin, but wrong for a WeChat mini-program: one app can use several
 * domains and several apps can share a domain. This module adds an additive,
 * plugin-owned identity layer instead of rebuilding the Cortex-owned v5 table:
 *
 *   asset_meta       one stable identity per asset
 *   asset_domains    many-to-many domain relationships
 *   miniapp_versions package/version evidence per mini-program
 *   asset_vuln_links optional vulnerability ownership
 *
 * Web assets keep `asset_key === host_port`. Mini-programs get a synthetic
 * `miniapp://<platform>/<appid>/<project-hash>` key and their domains hang off
 * `asset_domains` instead of defining the asset. No `PRAGMA user_version`
 * change is made: the Cortex desktop app continues to see a valid v5 DB.
 */

import { createHash } from 'node:crypto'
import { withBusyRetry } from '../db.js'

export const MINIAPP_SCHEME = 'miniapp:'
export const ASSET_KINDS = ['web', 'miniapp']

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS asset_meta (
  asset_key TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'miniapp')),
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  appid TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  identity_confidence TEXT NOT NULL DEFAULT 'high'
    CHECK (identity_confidence IN ('low', 'medium', 'high')),
  primary_domain TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_name, kind, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_meta_project ON asset_meta(project_name, kind);
CREATE TABLE IF NOT EXISTS asset_domains (
  asset_key TEXT NOT NULL,
  host TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'api',
  source TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'medium',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (asset_key, host, role)
);
CREATE INDEX IF NOT EXISTS idx_asset_domains_host ON asset_domains(host);
CREATE TABLE IF NOT EXISTS miniapp_versions (
  asset_key TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  package_sha256 TEXT NOT NULL,
  package_dir TEXT NOT NULL DEFAULT '',
  scanned_at TEXT NOT NULL,
  tool_version TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (asset_key, package_sha256, version)
);
CREATE TABLE IF NOT EXISTS asset_vuln_links (
  asset_key TEXT NOT NULL,
  vuln_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_key, vuln_id)
);
`

/** Ensure the additive identity tables exist. Write paths only. */
export function ensureAssetIdentityTables(db) {
  db.exec(SCHEMA_SQL)
}

function tableExists(db, table) {
  try {
    return (
      db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) !== undefined
    )
  } catch {
    return false
  }
}

/** Stable project discriminator so the same appid in two projects cannot collide. */
export function projectDiscriminator(projectName) {
  return createHash('sha256')
    .update(String(projectName || ''))
    .digest('hex')
    .slice(0, 10)
}

/** Synthetic, stable asset key for a mini-program. */
export function miniappAssetKey({ platform = 'wechat', appid, projectName = '' } = {}) {
  const normalizedPlatform = String(platform || 'wechat')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 24) || 'wechat'
  const normalizedAppid = String(appid || '')
    .trim()
    .replace(/[^A-Za-z0-9_.@-]+/g, '_')
    .slice(0, 96) || 'unknown'
  return `${MINIAPP_SCHEME}${normalizedPlatform}:${normalizedAppid}:${projectDiscriminator(projectName)}`
}

export function isMiniappAssetKey(value) {
  return typeof value === 'string' && value.startsWith(MINIAPP_SCHEME)
}

/** @returns {Record<string, any>|null} */
export function getAssetMeta(db, assetKey) {
  if (!tableExists(db, 'asset_meta')) return null
  try {
    return db.prepare('SELECT * FROM asset_meta WHERE asset_key = ?').get(assetKey) ?? null
  } catch {
    return null
  }
}

/** @returns {Map<string, Record<string, any>>} */
export function listAssetMeta(db) {
  const out = new Map()
  if (!tableExists(db, 'asset_meta')) return out
  try {
    for (const row of db.prepare('SELECT * FROM asset_meta').all()) out.set(String(row.asset_key), row)
  } catch {
    /* keep the page functional on a partial DB */
  }
  return out
}

/** @returns {Record<string, any>|null} */
export function findMiniappMeta(db, { projectName, platform, externalId }) {
  if (!tableExists(db, 'asset_meta')) return null
  try {
    return (
      db
        .prepare(
          `SELECT * FROM asset_meta
            WHERE project_name = ? AND kind = 'miniapp' AND platform = ? AND external_id = ?`,
        )
        .get(projectName, platform, externalId) ?? null
    )
  } catch {
    return null
  }
}

/** Find an already imported app when the caller did not supply a project. */
export function findMiniappMetaByExternalId(db, { platform, externalId }) {
  if (!tableExists(db, 'asset_meta')) return null
  try {
    return (
      db
        .prepare(
          `SELECT * FROM asset_meta
            WHERE kind = 'miniapp' AND platform = ? AND external_id = ?
            ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(platform, externalId) ?? null
    )
  } catch {
    return null
  }
}

/** @returns {Record<string, any>[]} */
export function listAssetDomains(db, assetKey) {
  if (!tableExists(db, 'asset_domains')) return []
  try {
    return db
      .prepare('SELECT host, role, source, confidence, first_seen, last_seen FROM asset_domains WHERE asset_key = ? ORDER BY host ASC')
      .all(assetKey)
  } catch {
    return []
  }
}

/** @returns {Map<string, number>} */
export function listAssetDomainCounts(db) {
  const out = new Map()
  if (!tableExists(db, 'asset_domains')) return out
  try {
    for (const row of db
      .prepare('SELECT asset_key, COUNT(*) AS count FROM asset_domains GROUP BY asset_key')
      .all()) {
      out.set(String(row.asset_key), Number(row.count) || 0)
    }
  } catch {
    /* optional metadata */
  }
  return out
}

/** @returns {Record<string, any>[]} */
export function listMiniappVersions(db, assetKey) {
  if (!tableExists(db, 'miniapp_versions')) return []
  try {
    return db
      .prepare(
        `SELECT version, package_sha256, package_dir, scanned_at, tool_version, metadata_json
           FROM miniapp_versions WHERE asset_key = ? ORDER BY scanned_at DESC`,
      )
      .all(assetKey)
  } catch {
    return []
  }
}

/** @returns {string[]} */
export function listLinkedVulnIds(db, assetKey) {
  if (!tableExists(db, 'asset_vuln_links')) return []
  try {
    return db
      .prepare('SELECT vuln_id FROM asset_vuln_links WHERE asset_key = ? ORDER BY vuln_id ASC')
      .all(assetKey)
      .map((row) => String(row.vuln_id))
  } catch {
    return []
  }
}

/** Store a vulnerability ownership link; safe to call after a vuln insert. */
export function linkVulnerability(db, assetKey, vulnId) {
  if (!assetKey || !vulnId) return
  ensureAssetIdentityTables(db)
  db.prepare(
    `INSERT INTO asset_vuln_links (asset_key, vuln_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(asset_key, vuln_id) DO NOTHING`,
  ).run(assetKey, vulnId, new Date().toISOString())
}

/**
 * JSON-friendly asset identity for API/UI responses.
 * @param {Record<string, any>|null} meta
 */
export function metaView(meta) {
  if (!meta) {
    return {
      asset_id: '',
      kind: 'web',
      external_id: '',
      display_name: '',
      appid: '',
      platform: '',
      identity_confidence: 'high',
      primary_domain: '',
    }
  }
  return {
    asset_id: String(meta.asset_key || ''),
    kind: String(meta.kind || 'web'),
    external_id: String(meta.external_id || ''),
    display_name: String(meta.display_name || ''),
    appid: String(meta.appid || ''),
    platform: String(meta.platform || ''),
    identity_confidence: String(meta.identity_confidence || 'medium'),
    primary_domain: String(meta.primary_domain || ''),
  }
}

/**
 * Create or update one mini-program asset and its domain/version evidence.
 * Caller owns the surrounding transaction.
 *
 * @param {any} db
 * @param {{
 *   projectName: string,
 *   appid: string,
 *   appName: string,
 *   platform: string,
 *   version: string,
 *   packageHash: string,
 *   packageDir: string,
 *   domains: Array<{host:string,count?:number,examples?:string[]}>,
 *   metadata?: Record<string, any>,
 * }} input
 * @returns {{assetKey:string, created:boolean, meta:Record<string,any>, domains:Record<string,any>[]}}
 */
export function upsertMiniappIdentity(db, input) {
  ensureAssetIdentityTables(db)
  const now = new Date().toISOString()
  const platform = String(input.platform || 'wechat').toLowerCase()
  const appid = String(input.appid || '').trim()
  const externalId = String(input.packageHash || appid || 'unknown')
  const existing = findMiniappMeta(db, {
    projectName: input.projectName,
    platform,
    externalId: appid || externalId,
  })
  const assetKey = existing
    ? String(existing.asset_key)
    : miniappAssetKey({ platform, appid: appid || externalId, projectName: input.projectName })
  const domains = Array.isArray(input.domains) ? input.domains : []
  const primary = domains.length > 0 ? String(domains[0].host || '') : ''
  const displayName = String(input.appName || appid || '').trim()
  const metadataJson = JSON.stringify(input.metadata || {})
  const confidence = appid ? 'high' : 'low'

  db.prepare(
    `INSERT INTO asset_meta
       (asset_key, project_name, kind, external_id, display_name, appid, platform,
        identity_confidence, primary_domain, metadata_json, created_at, updated_at)
     VALUES (?, ?, 'miniapp', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_key) DO UPDATE SET
       project_name = excluded.project_name,
       external_id = excluded.external_id,
       display_name = excluded.display_name,
       appid = excluded.appid,
       platform = excluded.platform,
       identity_confidence = excluded.identity_confidence,
       primary_domain = excluded.primary_domain,
       metadata_json = excluded.metadata_json,
       updated_at = excluded.updated_at`,
  ).run(
    assetKey,
    input.projectName,
    appid || externalId,
    displayName,
    appid,
    platform,
    confidence,
    primary,
    metadataJson,
    now,
    now,
  )

  for (const domain of domains) {
    const host = String(domain.host || '').trim().toLowerCase()
    if (host.length === 0) continue
    db.prepare(
      `INSERT INTO asset_domains
         (asset_key, host, role, source, confidence, first_seen, last_seen)
       VALUES (?, ?, 'api', ?, ?, ?, ?)
       ON CONFLICT(asset_key, host, role) DO UPDATE SET
         source = excluded.source,
         confidence = excluded.confidence,
         last_seen = excluded.last_seen`,
    ).run(
      assetKey,
      host,
      `miniapp:${appid || externalId}`,
      Number(domain.count || 0) > 1 ? 'high' : 'medium',
      now,
      now,
    )
  }

  if (input.packageHash) {
    db.prepare(
      `INSERT INTO miniapp_versions
         (asset_key, version, package_sha256, package_dir, scanned_at, tool_version, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_key, package_sha256, version) DO UPDATE SET
         package_dir = excluded.package_dir,
         scanned_at = excluded.scanned_at,
         tool_version = excluded.tool_version,
         metadata_json = excluded.metadata_json`,
    ).run(
      assetKey,
      String(input.version || ''),
      String(input.packageHash),
      String(input.packageDir || ''),
      now,
      'dsh-cortex',
      metadataJson,
    )
  }

  return {
    assetKey,
    created: !existing,
    meta: getAssetMeta(db, assetKey) || {},
    domains: listAssetDomains(db, assetKey),
  }
}

/** Remove all sidecar identity rows for a deleted asset. */
export function deleteAssetIdentity(db, assetKey) {
  if (!assetKey) return
  for (const table of ['asset_meta', 'asset_domains', 'miniapp_versions', 'asset_vuln_links']) {
    if (!tableExists(db, table)) continue
    try {
      if (table === 'asset_meta' || table === 'asset_vuln_links') {
        db.prepare(`DELETE FROM ${table} WHERE asset_key = ?`).run(assetKey)
      } else if (table === 'asset_domains') {
        db.prepare('DELETE FROM asset_domains WHERE asset_key = ?').run(assetKey)
      } else {
        db.prepare('DELETE FROM miniapp_versions WHERE asset_key = ?').run(assetKey)
      }
    } catch {
      /* optional metadata table */
    }
  }
}

/** Run a write transaction with the standard busy retry. */
export function withAssetWrite(db, fn) {
  return withBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw error
    }
  })
}


