/**
 * Seed a development database with the bundled demo fixtures.
 *
 * Usage:
 *   npm run seed:demo                     # ./data/cortex.dev.db
 *   npm run seed:demo -- --db path.db     # custom SQLite file
 *   npm run seed:demo -- --force          # overwrite an already populated file
 *
 * Note: the desktop app's real database lives at `~/.cortex/data.db` (override
 * with `CTX_DB_PATH`). The easiest way to populate it is the "载入示例数据"
 * button in the empty state of the dashboard.
 */
import { createDemoVulnerabilities } from '../src/core/db/demoVulns'
import { DatabaseService } from '../src/core/db/DatabaseService'

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const dbPath = getArg('--db') ?? 'data/cortex.dev.db'
const force = process.argv.includes('--force')

const db = new DatabaseService(dbPath)
const existing = db.count()

if (existing > 0 && !force) {
  console.log(`Database ${dbPath} already contains ${existing} vulnerabilities. Use --force to overwrite.`)
  db.close()
  process.exit(0)
}

const fixtures = createDemoVulnerabilities()
for (const vuln of fixtures) {
  db.saveVulnerability(vuln)
}

console.log(`Seeded ${fixtures.length} demo vulnerabilities into ${dbPath}`)
console.table(db.getStats())
db.close()
