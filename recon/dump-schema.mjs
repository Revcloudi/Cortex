// Dump the Cortex schema v5 DDL (tables + indexes + triggers) into fixtures/schema5.sql.
// Read-only: opens the live Cortex DB with readOnly=true.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dbPath = process.argv[2] ?? join(homedir(), '.cortex', 'data.db')
const db = new DatabaseSync(dbPath, { readOnly: true })
const version = db.prepare('PRAGMA user_version').get().user_version
if (version !== 5) throw new Error(`expected schema v5, got ${version}`)
const rows = db
  .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name")
  .all()
const out = []
out.push('-- Cortex database schema v5 fixture (DDL only, no data).')
out.push('-- Generated from a real Cortex DB by recon/dump-schema.mjs; do not edit by hand.')
out.push('PRAGMA foreign_keys = OFF;')
out.push('PRAGMA user_version = 5;')
out.push('')
for (const row of rows) out.push(`${row.sql};`)
out.push('')
writeFileSync(join(root, 'fixtures', 'schema5.sql'), out.join('\n'), 'utf8')
mkdirSync(join(root, 'fixtures'), { recursive: true })
writeFileSync(join(root, 'fixtures', 'schema5.sql'), out.join('\n'), 'utf8')
console.log(`wrote fixtures/schema5.sql (${rows.length} statements, ${out.join('\n').length} bytes)`)
db.close()
