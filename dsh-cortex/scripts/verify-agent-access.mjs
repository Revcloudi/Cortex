// Conversation-level (non-MCP) verification against the running plugin API.
// Proves the agent can read the Cortex library and update a status from chat
// through the plugin's own /cortex-api/cortex routes, without any MCP server.
const base = (process.env.DSH_WEB_URL || 'http://127.0.0.1:63877') + '/cortex-api/cortex'
const results = []
function check(name, condition, extra) {
  results.push({ name, ok: !!condition, extra })
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${!condition && extra !== undefined ? ` :: ${String(extra).slice(0, 240)}` : ''}`)
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

// 1. Read the vulnerability library.
const vulns = await req('/vulns?realm=all&pageSize=200')
check('list vulnerabilities', vulns.status === 200 && Array.isArray(vulns.body.items), `${vulns.status} ${vulns.text.slice(0, 160)}`)
const first = vulns.body && vulns.body.items && vulns.body.items[0]
check('library has records', !!(first && first.id), vulns.body && vulns.body.total)

// 2. Read one full record.
if (first) {
  const detail = await req(`/vulns/${encodeURIComponent(first.id)}`)
  check('read vulnerability detail', detail.status === 200 && !!detail.body, `${detail.status}`)
  check('detail has reproduction_steps', !!(detail.body && typeof detail.body.reproduction_steps === 'string'))
}

// 3. Update + restore its status (write proof, no evidence changed).
if (first) {
  const original = first.status
  const target = original === 'Inconclusive' ? 'Confirmed' : 'Inconclusive'
  const patch = await fetch(`${base}/vulns/${encodeURIComponent(first.id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: target }),
  })
  check('update vulnerability status', patch.status === 200, patch.status)
  const after = await req(`/vulns/${encodeURIComponent(first.id)}`)
  check('status persisted', after.body && after.body.status === target, after.body && after.body.status)
  const restore = await fetch(`${base}/vulns/${encodeURIComponent(first.id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: original }),
  })
  check('status restored', restore.status === 200, restore.status)
  const restored = await req(`/vulns/${encodeURIComponent(first.id)}`)
  check('original status back', restored.body && restored.body.status === original, restored.body && restored.body.status)
}

// 4. Other operations: assets, snapshots, internal scope, memory graph.
const assets = await req('/assets')
check('list assets', assets.status === 200 && Array.isArray(assets.body), assets.status)
if (Array.isArray(assets.body) && assets.body[0]) {
  const hostPort = assets.body[0].host_port
  const asset = await req(`/assets/${encodeURIComponent(hostPort)}`)
  check('read asset detail', asset.status === 200 && Array.isArray(asset.body.interfaces), asset.status)
}
const snapshots = await req('/snapshots?includeArchived=1')
const snapshotItems = snapshots.body && (snapshots.body.items || snapshots.body.sessions)
check('list snapshots', snapshots.status === 200 && Array.isArray(snapshotItems), snapshots.status)
if (snapshotItems && snapshotItems[0]) {
  const sessionId = snapshotItems[0].session_id
  const snapshot = await req(`/snapshots/${encodeURIComponent(sessionId)}`)
  check('read snapshot detail', snapshot.status === 200 && !!snapshot.body, snapshot.status)
}
const internal = await req('/internal/overview')
check('internal overview', internal.status === 200, internal.status)
const graph = await req('/graph', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scope: { kind: 'all' }, realm: 'all' }),
})
check('memory graph', graph.status === 200 && Array.isArray(graph.body.nodes), `${graph.status}`)
if (graph.body && graph.body.nodes) console.log(`     graph: ${graph.body.nodes.length} nodes / ${graph.body.links.length} links`)

const failed = results.filter((entry) => !entry.ok)
console.log(`\nnon-MCP conversation access: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exitCode = 1
