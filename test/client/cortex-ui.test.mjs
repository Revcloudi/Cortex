// Faithfulness gate for the ported Cortex UI (original React/Tailwind renderer).
//
// The heavy lifting lives in scripts/smoke-cortex-ui.mjs (also runnable directly):
// it evaluates the real built client.js inside jsdom under platform React 18.3.1,
// renders the captured `main` panel component and asserts the original App
// (sidebar / titlebar / dashboard / asset page) renders inside the shadow root.
//
// This wrapper only maps the harness report onto node:test assertions so
// `node --test` fails loudly when the port regresses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runCortexUiSmoke } from '../../scripts/smoke-cortex-ui.mjs'

test('client: ported Cortex UI renders under platform React 18.3.1', { timeout: 60_000 }, async () => {
  const report = await runCortexUiSmoke()

  const failureLines = report.failures.map((entry) => `  ✗ ${entry.name}\n      ${entry.detail}`).join('\n')
  const consoleLines =
    report.consoleErrors.length > 0 ? `\nconsole.error calls:\n${report.consoleErrors.map((m) => `  ! ${m}`).join('\n')}` : ''
  const errorLines =
    report.windowErrors.length > 0 ? `\npage errors:\n${report.windowErrors.map((m) => `  ! ${m}`).join('\n')}` : ''

  assert.equal(
    report.ok,
    true,
    `ported Cortex UI failed ${report.failures.length}/${report.checks.length} compatibility checks:\n${failureLines}${consoleLines}${errorLines}`
  )

  // A few headline expectations restated at the test layer so the intent of the
  // gate is readable without opening the harness.
  assert.equal(report.structural.topNav, true, 'a single horizontal card row replaces the cloned 236px sidebar')
  assert.deepEqual(
    report.structural.navItems.map((item) => item.id),
    ['nav-dashboard', 'nav-internal', 'nav-nebula', 'nav-assets', 'nav-snapshots', 'nav-retest'],
    'top nav must show the original workbench entries (MCP removed, ai-config hidden)'
  )
  assert.deepEqual(report.structural.metrics, {
    'metric-total': '9',
    'metric-critical': '2',
    'metric-hosts': '1',
    'metric-today': '0'
  })
  assert.equal(report.structural.vulnRows, 9)
  assert.equal(report.structural.assetPage.hostPort, 'http://127.0.0.1:8080/')
  assert.deepEqual(
    report.structural.pagesMounted,
    ['internal', 'snapshots', 'retest (lazy chunk)'],
    'every remaining original non-canvas page must mount'
  )
  assert.equal(report.structural.nebula.bundled, true, 'nebula route + THREE.js must be bundled')
  assert.equal(report.structural.titlebarButtons, 0, 'window controls must stay hidden in the web runtime')
  assert.equal(report.consoleErrors.length, 0, `unexpected console.error output: ${report.consoleErrors.join(' | ')}`)
})
