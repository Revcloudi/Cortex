import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { HubLogger } from '../core/logging'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function capture(window: BrowserWindow, targetDir: string, name: string): Promise<void> {
  if (!window.isVisible()) window.show()
  window.focus()
  await delay(250)
  const image = await window.webContents.capturePage()
  const size = image.getSize()
  if (size.width === 0 || size.height === 0) {
    throw new Error(`capturePage returned an empty image for ${name}`)
  }
  await writeFile(join(targetDir, name), image.toPNG())
}

let window: BrowserWindow

const clickSelector = (selector: string): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const options = { bubbles: true, cancelable: true, view: window, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', options));
      el.dispatchEvent(new MouseEvent('mousedown', options));
      el.dispatchEvent(new PointerEvent('pointerup', options));
      el.dispatchEvent(new MouseEvent('mouseup', options));
      el.dispatchEvent(new MouseEvent('click', options));
      return true;
    })()
  `)

/** Radix Tabs activates on pointer/mouse down; a bare .click() is not enough. */
const activateTab = (testId: string): Promise<unknown> => clickSelector(`[data-testid="${testId}"]`)

const clickRow = (index: number): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('[data-testid="vuln-row"]');
      const row = rows[${index}];
      if (!row) return false;
      row.click();
      return true;
    })()
  `)

const clickCheckbox = (index: number): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const boxes = document.querySelectorAll('[data-testid="vuln-select"]');
      const box = boxes[${index}];
      if (!box) return false;
      box.click();
      return true;
    })()
  `)

const clickAssetRow = (index: number): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('[data-testid="asset-row"]');
      const row = rows[${index}];
      if (!row) return false;
      row.click();
      return true;
    })()
  `)

const clickNav = (label: string): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const buttons = [...document.querySelectorAll('nav[aria-label="主导航"] button')];
      const button = buttons.find((item) => item.textContent?.includes(${JSON.stringify(label)}));
      if (!button) return false;
      button.click();
      return true;
    })()
  `)

/**
 * Real mouse click at the element center. Radix Select listens to native pointer
 * events; synthetic click sequences can open and immediately close the list, so a
 * real mouse down/up reliably captures the popover.
 */
const realClick = async (selector: string): Promise<boolean> => {
  const point = (await window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()
  `)) as { x: number; y: number } | null
  if (!point) return false
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  return true
}

const scrollSheet = (offset: number): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const sheet = document.querySelector('[data-testid="vuln-sheet"]');
      if (!sheet) return false;
      const scrollers = [...sheet.querySelectorAll('*')].filter(
        (el) => el.scrollHeight > el.clientHeight + 40
      );
      scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const scroller = scrollers[0];
      if (!scroller) return false;
      scroller.scrollTop = ${offset};
      return true;
    })()
  `)

/** Scroll the tallest scroller inside a Sheet identified by its test id. */
const scrollSheetByTestId = (testId: string, offset: number): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const sheet = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
      if (!sheet) return false;
      const scrollers = [...sheet.querySelectorAll('*')].filter(
        (el) => el.scrollHeight > el.clientHeight + 40
      );
      scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const scroller = scrollers[0];
      if (!scroller) return false;
      scroller.scrollTop = ${offset};
      return true;
    })()
  `)

const pressEscape = (): void => {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
}

const selectorExists = async (selector: string): Promise<boolean> =>
  (await window.webContents.executeJavaScript(
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`
  )) === true

const waitForSelector = async (
  selector: string,
  exists: boolean,
  timeoutMs = 2500
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await selectorExists(selector)) === exists) return true
    await delay(100)
  }
  return false
}

const closeSelectPopover = async (triggerSelector: string): Promise<void> => {
  if (!(await selectorExists('[role="listbox"]'))) return
  pressEscape()
  if (await waitForSelector('[role="listbox"]', false, 1200)) return
  await realClick(triggerSelector)
  await waitForSelector('[role="listbox"]', false, 800)
}

const ensureSheetClosed = async (): Promise<void> => {
  if (!(await selectorExists('[data-testid="vuln-sheet"]'))) return
  pressEscape()
  if (await waitForSelector('[data-testid="vuln-sheet"]', false, 1500)) return
  const closed = await window.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('[aria-label="关闭详情"]');
      if (!button) return false;
      button.click();
      return true;
    })()
  `)
  if (closed) await waitForSelector('[data-testid="vuln-sheet"]', false, 1500)
}

/**
 * Cortex development-only visual smoke test. Enabled by CTX_CAPTURE_DIR (legacy
 * PDH_CAPTURE_DIR): captures the dashboard, Markdown reproduction evidence,
 * remediation, crypto, and MCP pages, after which the caller quits the app.
 * Never runs unless the env var is set.
 */
export async function runCaptureMode(
  targetWindow: BrowserWindow,
  targetDir: string,
  logger: HubLogger
): Promise<void> {
  window = targetWindow
  await mkdir(targetDir, { recursive: true })
  await delay(3200)

  const captureStep = async (name: string): Promise<void> => {
    try {
      await capture(window, targetDir, name)
      logger.info(`[capture] ${name} -> ${join(targetDir, name)}`)
    } catch (error) {
      logger.warn(`[capture] failed to capture ${name}`, error)
    }
  }

  await captureStep('01-dashboard.png')

  try {
    await clickSelector('[data-testid="vuln-multiselect"]')
    await waitForSelector('[data-testid="vuln-select"]', true)
    await delay(300)
    await clickCheckbox(0)
    await clickCheckbox(1)
    await delay(350)
    await captureStep('11-bulk-selection.png')

    const nextPageClicked = await clickSelector('[data-testid="vuln-page-next"]')
    if (nextPageClicked) {
      await delay(700)
      await captureStep('19-vuln-page-2.png')
      await clickSelector('[data-testid="vuln-page-prev"]')
      await delay(500)
    }

    await clickSelector('[data-testid="vuln-multiselect"]')
    await waitForSelector('[data-testid="vuln-select"]', false)
    await delay(300)
  } catch (error) {
    logger.warn('[capture] failed to capture bulk-selection / pagination state', error)
  }

  try {
    await realClick('[data-testid="status-filter"]')
    const opened = await waitForSelector('[role="listbox"]', true)
    if (!opened) logger.warn('[capture] dashboard status select did not open')
    await delay(350)
    await captureStep('02-filter-select-open.png')
    await closeSelectPopover('[data-testid="status-filter"]')
    await delay(350)
  } catch (error) {
    logger.warn('[capture] failed to capture dashboard status select', error)
  }

  try {
    await clickRow(0)
    await waitForSelector('[data-testid="vuln-sheet"]', true)
    await delay(900)
    await captureStep('03-detail-overview.png')

    await scrollSheet(430)
    await delay(500)
    await captureStep('04-detail-reproduction-http.png')

    await activateTab('tab-remediation')
    await delay(600)
    await captureStep('05-detail-remediation.png')

    await activateTab('tab-boundaries')
    await delay(600)
    await captureStep('06-detail-boundaries.png')

    await realClick('[data-testid="vuln-status"]')
    const statusOpened = await waitForSelector('[role="listbox"]', true)
    if (!statusOpened) logger.warn('[capture] detail status select did not open')
    await delay(350)
    await captureStep('07-detail-status-select-open.png')
    await closeSelectPopover('[data-testid="vuln-status"]')
    await delay(350)

    await activateTab('tab-retests')
    await delay(600)
    await scrollSheet(340)
    await delay(350)
    await captureStep('18-detail-retests.png')
    await scrollSheet(0)

    await activateTab('tab-crypto')
    await delay(600)
    await captureStep('08-detail-crypto.png')
  } catch (error) {
    logger.warn('[capture] failed to capture vulnerability detail views', error)
  }

  try {
    await ensureSheetClosed()
    await delay(350)
    await clickRow(3)
    await waitForSelector('[data-testid="vuln-sheet"]', true)
    await delay(900)
    await activateTab('tab-crypto')
    await delay(600)
    await captureStep('09-detail-crypto-content.png')
  } catch (error) {
    logger.warn('[capture] failed to capture crypto details', error)
  }

  try {
    await ensureSheetClosed()
    await delay(350)
    await clickNav('资产库')
    await waitForSelector('[data-testid="asset-row"]', true)
    await delay(600)
    await captureStep('12-assets.png')

    await clickAssetRow(0)
    await waitForSelector('[data-testid="asset-sheet"]', true)
    await delay(900)
    await captureStep('13-asset-detail.png')

    const deleteOpened = await clickSelector('[data-testid="asset-delete"]')
    if (deleteOpened) {
      await waitForSelector('[data-testid="asset-delete-confirm"]', true)
      await delay(400)
      await captureStep('24-asset-delete-confirm.png')
      pressEscape()
      await delay(300)
    }

    await activateTab('asset-tab-parameters')
    await delay(600)
    await captureStep('27-asset-parameters.png')

    await activateTab('asset-tab-interfaces')
    await delay(600)
    await captureStep('14-asset-interfaces.png')

    const expandedRequest = await clickSelector('[data-testid="asset-interface-row"]')
    if (expandedRequest) {
      await waitForSelector('[data-testid="asset-interface-request"]', true)
      await delay(500)
      await captureStep('20-asset-interface-request.png')
    } else {
      logger.warn('[capture] asset interface row not found for request capture')
    }

    await activateTab('asset-tab-leaks')
    await delay(600)
    await captureStep('15-asset-leaks.png')

    await activateTab('asset-tab-related')
    await delay(600)
    await captureStep('16-asset-related.png')

    const openedRelated = await clickSelector('[data-testid="asset-related-vuln"]')
    if (openedRelated) {
      await waitForSelector('[data-testid="vuln-sheet"]', true)
      await delay(900)
      await captureStep('17-asset-related-vuln.png')
      pressEscape()
      await delay(350)
    }
    pressEscape()
    await delay(350)
  } catch (error) {
    logger.warn('[capture] failed to capture asset library', error)
  }

  try {
    await ensureSheetClosed()
    await delay(350)
    await clickNav('认知快照')
    await waitForSelector('[data-testid="snapshot-row"]', true)
    await delay(600)
    await captureStep('21-snapshots.png')

    await clickSelector('[data-testid="snapshot-row"]')
    await waitForSelector('[data-testid="snapshot-sheet"]', true)
    await delay(900)
    await captureStep('22-snapshot-detail.png')

    const childOpened = await clickSelector('[data-testid="snapshot-child-session"]')
    if (childOpened) {
      await delay(700)
      await captureStep('25-snapshot-child-detail.png')
    }

    const scrolledSnapshot = await scrollSheetByTestId('snapshot-sheet', 640)
    if (scrolledSnapshot) {
      await delay(500)
      await captureStep('23-snapshot-detail-details.png')
    }
    pressEscape()
    await delay(400)

    await clickSelector('[data-testid="snapshot-row"]')
    await waitForSelector('[data-testid="snapshot-sheet"]', true)
    await delay(700)
    const deleteOpened = await clickSelector('[data-testid="snapshot-delete"]')
    if (deleteOpened) {
      await waitForSelector('[data-testid="snapshot-delete-confirm"]', true)
      await delay(400)
      await captureStep('26-snapshot-delete-confirm.png')
      pressEscape()
      await delay(300)
    }
    pressEscape()
    await delay(350)
  } catch (error) {
    logger.warn('[capture] failed to capture cognitive snapshots', error)
  }

  try {
    await ensureSheetClosed()
    await delay(350)
    await clickNav('MCP 接入')
    await waitForSelector('[data-testid="mcp-transport"]', true)
    await delay(900)
    await captureStep('10-mcp-page.png')

    // Language switch check: the sidebar toggle flips the whole UI to English.
    const toggled = await clickSelector('[data-testid="lang-toggle"]')
    if (toggled) {
      await delay(700)
      await captureStep('28-mcp-page-en.png')
    }
  } catch (error) {
    logger.warn('[capture] failed to capture MCP page', error)
  }
}
