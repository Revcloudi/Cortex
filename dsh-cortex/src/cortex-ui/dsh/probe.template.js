// Temporary acceptance probe injected only when CORTEX_UI_PROBE=1 (dev builds).
// It mounts the ported App offscreen and posts structure/interaction facts to a
// local collector. The default build contains none of this code.
function runAcceptanceProbe() {
  const ui = globalThis.__DSH_CORTEX_UI__
  const UI_CSS = globalThis.__DSH_CORTEX_CSS__
  const errors = []
  window.addEventListener('error', (event) => errors.push(String(event.message || event.error).slice(0, 200)))
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:-20000px;top:0;width:1920px;height:1080px;visibility:hidden;pointer-events:none;'
  document.body.appendChild(host)
  const handle = ui.mount(host, UI_CSS)
  const shadow = () => host.shadowRoot
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (fn, timeout) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      try {
        const value = fn()
        if (value) return value
      } catch (error) {
        /* wait */
      }
      await sleep(120)
    }
    return null
  }
  const finish = (report) => {
    report.kind = 'dsh-cortex-acceptance-probe'
    report.at = new Date().toISOString()
    report.errors = errors.slice(0, 8)
    fetch('http://127.0.0.1:47654/diag', {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(report),
    })
    try {
      handle.destroy()
    } catch (error) {
      /* ignore */
    }
    try {
      host.remove()
    } catch (error) {
      /* ignore */
    }
  }
  void (async () => {
    const report = {}
    await waitFor(() => shadow() && shadow().querySelector('tbody tr'), 20000)
    report.layout = {
      navCount: shadow() ? shadow().querySelectorAll('[data-testid^="nav-"]').length : 0,
      fontFaces: document.querySelector('style[data-dsh-cortex-fonts]')?.textContent.match(/@font-face/g)?.length ?? 0,
    }

    // Retest page must list real web vulnerabilities.
    try {
      shadow().querySelector('[data-testid="nav-retest"]')?.click()
      const page = await waitFor(() => shadow() && shadow().querySelector('[data-testid="retest-page"]'), 12000)
      await sleep(2500)
      const rows = shadow() ? shadow().querySelectorAll('[data-testid="retest-page"] tbody tr').length : 0
      const pageText = (page?.textContent || '').replace(/\s+/g, ' ')
      report.retest = {
        pageFound: !!page,
        rows,
        sample: pageText.slice(0, 360),
        hasError: /加载失败|无法加载|error|failed/i.test(pageText.slice(0, 800)),
      }
    } catch (error) {
      report.retest = { error: String(error && error.message ? error.message : error) }
    }

    // Nebula: left command column collapsed by default + fullscreen toggle.
    try {
      shadow().querySelector('[data-testid="nav-nebula"]')?.click()
      const fullscreenButton = await waitFor(
        () => shadow() && shadow().querySelector('[data-testid="fullscreen"]'),
        15000,
      )
      const section = shadow() && shadow().querySelector('section')
      const hud = shadow() && shadow().querySelector('[data-testid="hud-column"]')
      const motionButton = shadow() && shadow().querySelector('[data-testid="motion-toggle"]')
      report.nebula = {
        hudAriaHidden: hud ? hud.getAttribute('aria-hidden') : null,
        hudInert: hud ? hud.hasAttribute('inert') : null,
        hudTransform: hud ? getComputedStyle(hud).transform : null,
        motionPressed: motionButton ? motionButton.getAttribute('aria-pressed') : null,
      }
      const measure = () => {
        if (!section) return null
        const rect = section.getBoundingClientRect()
        return {
          position: getComputedStyle(section).position,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
        }
      }
      if (fullscreenButton && section) {
        const before = measure()
        fullscreenButton.click()
        await sleep(240)
        const full = measure()
        const toolbar = shadow() && shadow().querySelector('[data-testid="nebula-toolbar"]')
        const hudActive = shadow() && shadow().querySelector('[data-testid="hud-column"]')
        const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null
        report.nebula.fullscreen = {
          before,
          full,
          toolbarInFullscreen: toolbarRect
            ? { top: Math.round(toolbarRect.top), right: Math.round(toolbarRect.right), bottom: Math.round(toolbarRect.bottom) }
            : null,
          hudAriaHiddenInFullscreen: hudActive ? hudActive.getAttribute('aria-hidden') : null,
        }
        fullscreenButton.click()
        await sleep(240)
        report.nebula.fullscreen.restored = measure()
      }
    } catch (error) {
      report.nebula = { error: String(error && error.message ? error.message : error) }
    }
    finish(report)
  })().catch((error) => finish({ probeError: String(error && error.stack ? error.stack : error) }))
}
