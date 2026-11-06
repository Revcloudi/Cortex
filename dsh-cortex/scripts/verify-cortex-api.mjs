// Live verification of the ported Cortex UI's Host API against the running DSH.
// Read-only: GET endpoints + POST /graph (derived view). No writes.
const base = (process.env.DSH_WEB_URL || 'http://127.0.0.1:63877') + '/cortex-api'
const results = []
function check(name, condition, extra) {
  results.push({ name, ok: !!condition, extra })
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${!condition && extra !== undefined ? ` :: ${String(extra).slice(0, 300)}` : ''}`)
}
async function req(path, init) {
  const response = await fetch(base + path, {
    ...(init || {}),
    headers: Object.assign({ Accept: 'application/json' }, init && init.headers),
  })
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body, text }
}

const health = await req('/health')
check('legacy /health 200', health.status === 200, health.status)

const rev = await req('/cortex/rev')
check('GET /cortex/rev 200', rev.status === 200, `${rev.status} ${rev.text.slice(0, 120)}`)
check('rev numeric', rev.body && typeof rev.body.rev === 'number', JSON.stringify(rev.body).slice(0, 120))

const stats = await req('/cortex/stats?realm=all')
check('GET /cortex/stats 200', stats.status === 200, `${stats.status} ${stats.text.slice(0, 200)}`)
check('stats has totals', !!(stats.body && (stats.body.total !== undefined || stats.body.totals !== undefined)), JSON.stringify(stats.body && Object.keys(stats.body)))

const vulns = await req('/cortex/vulns?page=1&pageSize=5')
check('GET /cortex/vulns 200', vulns.status === 200, `${vulns.status} ${vulns.text.slice(0, 200)}`)
check('vulns items[]', vulns.body && Array.isArray(vulns.body.items), JSON.stringify(vulns.body && Object.keys(vulns.body)))
check('vulns total 13 (live DB)', vulns.body && vulns.body.total === 13, vulns.body && vulns.body.total)
const v = vulns.body && vulns.body.items && vulns.body.items[0]
check('vuln shape camelCase', !!(v && v.vuln_name !== undefined || (v && v.vulnName !== undefined)), v && JSON.stringify(Object.keys(v)))
if (v) {
  const id = v.vuln_id || v.vulnId || v.id
  const detail = await req(`/cortex/vulns/${encodeURIComponent(id)}`)
  check('GET /cortex/vulns/:id 200', detail.status === 200, detail.status)
  check('detail has reproduction_steps', !!(detail.body && (detail.body.reproduction_steps !== undefined || detail.body.reproductionSteps !== undefined)))
}

const assets = await req('/cortex/assets')
check('GET /cortex/assets 200', assets.status === 200, `${assets.status} ${assets.text.slice(0, 160)}`)
check('assets array (1 live)', Array.isArray(assets.body) && assets.body.length === 1, Array.isArray(assets.body) ? assets.body.length : 'not-array')
const asset = Array.isArray(assets.body) && assets.body[0]
if (asset) {
  const hostPort = asset.host_port || asset.hostPort
  const detail = await req(`/cortex/assets/${encodeURIComponent(hostPort)}`)
  check('GET /cortex/assets/:hostPort 200', detail.status === 200, detail.status)
  check('asset detail interfaces', !!(detail.body && Array.isArray(detail.body.interfaces) && detail.body.interfaces.length > 0), detail.body && JSON.stringify(Object.keys(detail.body)))
}

const snapshots = await req('/cortex/snapshots?includeArchived=1')
check('GET /cortex/snapshots 200', snapshots.status === 200, `${snapshots.status} ${snapshots.text.slice(0, 160)}`)
check('snapshots sessions', !!(snapshots.body && (Array.isArray(snapshots.body.sessions) || Array.isArray(snapshots.body.items))), JSON.stringify(snapshots.body && Object.keys(snapshots.body)))

const dbInfo = await req('/cortex/db/info')
check('GET /cortex/db/info 200', dbInfo.status === 200, dbInfo.status)
check('db info no absolute path', !JSON.stringify(dbInfo.body).includes('C:\\\\Users'), JSON.stringify(dbInfo.body).slice(0, 200))
const appInfo = await req('/cortex/app/info')
check('GET /cortex/app/info 200', appInfo.status === 200, appInfo.status)

const graph = await req('/cortex/graph', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scope: { kind: 'all' }, realm: 'all' }),
})
check('POST /cortex/graph 200', graph.status === 200, `${graph.status} ${graph.text.slice(0, 240)}`)
check('graph nodes/links', !!(graph.body && Array.isArray(graph.body.nodes) && Array.isArray(graph.body.links)), graph.body && JSON.stringify(Object.keys(graph.body)))
if (graph.body && graph.body.nodes) console.log(`     graph: ${graph.body.nodes.length} nodes / ${graph.body.links.length} links`)

const internalProjects = await req('/cortex/internal/projects')
check('GET /cortex/internal/projects 200', internalProjects.status === 200, `${internalProjects.status} ${internalProjects.text.slice(0, 160)}`)
const internalOverview = await req('/cortex/internal/overview')
check('GET /cortex/internal/overview 200', internalOverview.status === 200, `${internalOverview.status} ${internalOverview.text.slice(0, 160)}`)
check('internal overview no secret', !JSON.stringify(internalOverview.body).includes('"secret"'), 'secret key present')

const failed = results.filter((entry) => !entry.ok)
console.log(`\ncortex-api live verification: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((entry) => entry.name).join('; '))
  process.exitCode = 1
}
