/**
 * Additive columns owned by this plugin (Cortex schema v5 stays unchanged).
 *
 * The desktop/CLI writers already add columns through `migrateSchema`; the
 * plugin cannot rely on the user opening the desktop app first. These columns
 * are added lazily on a writable connection and are never required for a
 * read-only browse (queries fall back to the legacy shape).
 *
 * `PRAGMA user_version` is deliberately untouched.
 */

const FEATURE_COLUMNS = {
  vulnerabilities: {
    client_type: "TEXT NOT NULL DEFAULT ''",
    client_connection: "TEXT NOT NULL DEFAULT ''",
  },
  assets: {
    system_name: "TEXT NOT NULL DEFAULT ''",
  },
}

/** @type {WeakMap<object, Map<string, Set<string>>>} */
const columnCache = new WeakMap()
/** @type {WeakSet<object>} */
const ensured = new WeakSet()

function columnsOf(db, table) {
  const cached = columnCache.get(db)
  if (cached && cached.has(table)) return cached.get(table)
  let names = new Set()
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all()
    names = new Set(rows.map((row) => String(row.name)))
  } catch {
    names = new Set()
  }
  if (!cached) columnCache.set(db, new Map([[table, names]]))
  else cached.set(table, names)
  return names
}

/**
 * True when an optional column is present. Cached per SQLite connection so the
 * hot list/stat queries do not re-read table metadata on every request.
 * @param {any} db
 * @param {'vulnerabilities'|'assets'} table
 * @param {string} column
 */
export function hasColumn(db, table, column) {
  if (!db) return false
  return columnsOf(db, table).has(column)
}

/**
 * Add missing optional columns on a writable connection. Read-only databases
 * are left untouched; callers use `hasColumn()` to degrade gracefully.
 * @param {{db:any, readOnly?:boolean, readOnlyFallback?:boolean}} holder
 * @returns {boolean} true when every feature column is available
 */
export function ensureFeatureColumns(holder) {
  const db = holder && holder.db
  if (!db) return false
  if (ensured.has(db)) return true
  const writable = !holder.readOnly && !holder.readOnlyFallback
  for (const [table, columns] of Object.entries(FEATURE_COLUMNS)) {
    const present = columnsOf(db, table)
    for (const [name, definition] of Object.entries(columns)) {
      if (present.has(name)) continue
      if (!writable) continue
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        present.add(name)
      } catch {
        /* partial/legacy database: leave the column absent */
      }
    }
  }
  ensured.add(db)
  return true
}

export { FEATURE_COLUMNS }
