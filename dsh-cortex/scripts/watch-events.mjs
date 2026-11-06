// Read a bounded slice of the DSH client-plugin SSE graph stream and report what
// the open page would receive: the full graph (entry ids + revisions) and any
// subsequent `rebuilt` frames.
//
// Usage: node scripts/watch-events.mjs [ms=2500]
import http from 'node:http'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:63877'
const durationMs = Number(process.argv[2] || 2500)
const target = new URL('/plugins/events', baseUrl)

const request = http.request(
  {
    host: target.hostname,
    port: target.port || 80,
    path: target.pathname,
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
  },
  (response) => {
    console.log(`status=${response.statusCode} content-type=${response.headers['content-type']}`)
    let buffer = ''
    const timer = setTimeout(() => {
      request.destroy()
      finish()
    }, durationMs)
    response.setEncoding('utf8')
    response.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        handleFrame(frame)
      }
    })
    response.on('error', () => {})
    let finished = false
    function finish() {
      if (finished) return
      finished = true
      clearTimeout(timer)
      console.log(`\nframes summary: graph=${graphFrames} rebuilt=${rebuiltFrames}`)
      if (rebuiltIds.length) console.log(`rebuilt ids: ${rebuiltIds.join(', ')}`)
    }
    let graphFrames = 0
    let rebuiltFrames = 0
    const rebuiltIds = []
    async function fetchBundleInfo(entry) {
      try {
        const bundleResponse = await fetch(new URL('/' + entry.url, baseUrl))
        const body = await bundleResponse.text()
        console.log(
          `  bundle fetch: status=${bundleResponse.status} bytes=${body.length} marker=${body.includes('dsh-cortex client bundle')} iframeSandbox=${body.includes('sandbox: ""') || body.includes('sandbox=""')}`,
        )
      } catch (error) {
        console.log(`  bundle fetch failed: ${error.message}`)
      }
    }
    function handleFrame(raw) {
      const lines = raw.split('\n')
      const event = lines.find((line) => line.startsWith('event:'))
      const dataLine = lines.find((line) => line.startsWith('data:'))
      if (!dataLine) return
      const data = dataLine.slice(5).trim()
      const kind = event ? event.slice(6).trim() : 'message'
      if (kind === 'graph' || kind === 'message' || kind === 'rebuilt') {
        try {
          const payload = JSON.parse(data)
          if (payload.type === 'rebuilt' || kind === 'rebuilt') {
            rebuiltFrames++
            rebuiltIds.push(payload.id || '(no id)')
            console.log(`rebuilt frame: id=${payload.id} rev=${payload.rev}`)
            return
          }
          const graph = payload.graph || payload
          graphFrames++
          const entries = graph.entries || graph.rows || graph.plugins || []
          console.log(`graph frame: rev=${graph.rev} release=${graph.release && graph.release.version} entries=${entries.length}`)
          const ours = entries.filter((entry) => JSON.stringify(entry).includes('dsh-cortex'))
          for (const entry of ours) {
            console.log(`  dsh-cortex entry: id=${entry.id} rev=${entry.rev} url=${entry.url} inject=${JSON.stringify(entry.inject)}`)
            fetchBundleInfo(entry)
          }
          if (!ours.length) console.log(`  WARNING: dsh-cortex entry not found in graph`)
        } catch {
          console.log(`frame (unparsed) kind=${kind}: ${data.slice(0, 300)}`)
        }
      } else {
        console.log(`frame kind=${kind}: ${data.slice(0, 200)}`)
      }
    }
    response.on('end', finish)
  },
)
request.on('error', (error) => {
  console.log(`request error: ${error.message}`)
})
request.end()
