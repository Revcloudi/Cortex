// Read-only Cortex DB recon. Never writes. Run: node recon/inspect-db.mjs [dbPath]
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dbPath = process.argv[2] ?? join(homedir(), '.cortex', 'data.db')
const db = new DatabaseSync(dbPath, { readOnly: true })
const q = (sql, ...args) => db.prepare(sql).all(...args)

const out = {}
out.userVersion = q('PRAGMA user_version')
out.journalMode = q('PRAGMA journal_mode')
out.tables = q("SELECT name, type FROM sqlite_master WHERE type IN ('table','view','index','trigger') ORDER BY type, name")
out.tableInfo = {}
const keyTables = [
  'vulnerabilities', 'assets', 'internal_hosts', 'internal_services', 'footholds', 'foothold_hosts',
  'pivots', 'pivot_hops', 'pivot_reachability', 'credentials', 'credential_trials',
  'snapshot_sessions', 'loot_imports',
]
let tableNames = new Set(q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name))
for (const t of keyTables) {
  if (!tableNames.has(t)) { out.tableInfo[t] = 'MISSING'; continue }
  out.tableInfo[t] = {
    columns: q(`PRAGMA table_info(${JSON.stringify(t)})`),
    count: q(`SELECT COUNT(*) AS c FROM ${t}`)[0].c,
    indexes: q(`PRAGMA index_list(${JSON.stringify(t)})`),
  }
}
// samples with secrets redacted
const redact = (row, secretCols = []) => {
  const copy = { ...row }
  for (const c of secretCols) if (c in copy && copy[c] != null) {
    copy[c] = `«redacted len=${String(copy[c]).length}»`
  }
  return copy
}
out.samples = {}
out.samples.vulnerabilities = q('SELECT * FROM vulnerabilities ORDER BY rowid DESC LIMIT 2').map(r => redact(r))
out.samples.assets = q('SELECT * FROM assets LIMIT 2').map(r => redact(r))
out.samples.internal_hosts = q('SELECT * FROM internal_hosts LIMIT 2').map(r => redact(r))
out.samples.internal_services = q('SELECT * FROM internal_services LIMIT 2').map(r => redact(r))
out.samples.footholds = q('SELECT * FROM footholds LIMIT 2').map(r => redact(r))
out.samples.credentials = q('SELECT * FROM credentials LIMIT 2').map(r => redact(r, ['secret', 'password', 'token', 'hash', 'value', 'private_key']))
out.samples.snapshot_sessions = q('SELECT * FROM snapshot_sessions LIMIT 2').map(r => redact(r))
out.samples.loot_imports = q('SELECT * FROM loot_imports LIMIT 2').map(r => redact(r))
out.samples.pivots = q('SELECT * FROM pivots LIMIT 2').map(r => redact(r))
out.samples.pivot_hops = q('SELECT * FROM pivot_hops LIMIT 2').map(r => redact(r))
out.samples.pivot_reachability = q('SELECT * FROM pivot_reachability LIMIT 2').map(r => redact(r))
out.samples.foothold_hosts = q('SELECT * FROM foothold_hosts LIMIT 2').map(r => redact(r))
out.samples.credential_trials = q('SELECT * FROM credential_trials LIMIT 2').map(r => redact(r))

// distinct enum-ish values
out.distinct = {
  severity: q('SELECT severity, COUNT(*) c FROM vulnerabilities GROUP BY severity'),
  status: q('SELECT status, COUNT(*) c FROM vulnerabilities GROUP BY status'),
  realm: q('SELECT realm, COUNT(*) c FROM vulnerabilities GROUP BY realm'),
  assetStatus: q('SELECT status, COUNT(*) c FROM assets GROUP BY status'),
  projects: q("SELECT DISTINCT project_name FROM assets WHERE project_name IS NOT NULL AND project_name != ''"),
  snapshotProjects: q("SELECT DISTINCT project_name FROM snapshot_sessions WHERE project_name IS NOT NULL"),
}
console.log(JSON.stringify(out, null, 2))
db.close()
