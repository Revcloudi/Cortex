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

/** Select the n-th retest-lab candidate (so a PoC-bearing finding is captured). */
const clickPocCandidate = (index: number): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('[data-testid="retest-candidate-row"]');
      const row = rows[${index}];
      if (!row) return false;
      row.click();
      return true;
    })()
  `)

/** Click the n-th option of an open HUD dropdown (`role="listbox"`). */
const clickRoleOption = (index: number): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const options = document.querySelectorAll('[role="option"]');
      const option = options[${index}];
      if (!option) return false;
      option.click();
      return true;
    })()
  `)

/** Close the plain `role="dialog"` overlay (database picker) via its X button. */
const closeDialogOverlay = (): Promise<unknown> =>
  window.webContents.executeJavaScript(`
    (() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      const button = dialog.querySelector('button');
      if (!button) return false;
      button.click();
      return true;
    })()
  `)

/** Scroll the page until an element carrying `testId` is centered (capture helper). */
const scrollToTestId = (testId: string): Promise<unknown> => {
  const selector = `[data-testid="${testId}"]`
  return window.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return true;
    })()
  `)
}

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
    await waitForSelector('[data-testid="mcp-page"]', true)
    await delay(900)
    await captureStep('10-mcp-page.png')

    // Language switch check: the sidebar toggle flips the whole UI to English.
    const toggled = await clickSelector('[data-testid="lang-toggle"]')
    if (toggled) {
      await delay(700)
      await captureStep('28-mcp-page-en.png')
    }

    // Database picker entry point (the native file dialog is not opened here).
    const dbOpened = await clickSelector('[data-testid="db-button"]')
    if (dbOpened) {
      await delay(600)
      await captureStep('29-db-picker.png')
      // The picker is a plain role="dialog" overlay (not Radix), so close it via
      // its header button before continuing; Escape would not dismiss it.
      const closed = await closeDialogOverlay()
      if (!closed) logger.warn('[capture] database picker close button not found')
      await delay(500)
    }
  } catch (error) {
    logger.warn('[capture] failed to capture MCP page', error)
  }

  /*
   * Internal operations domain (Plan B). The English toggle above leaves the UI
   * in EN; flip it back first so the new screens are captured in the primary
   * language, then also re-check one EN frame at the end for i18n coverage.
   */
  try {
    await clickSelector('[data-testid="lang-toggle"]')
    await delay(500)

    // Dashboard: Web (default) / internal-summary tabs.
    await clickNav('漏洞看板')
    await delay(500)
    const internalTab = await clickSelector('[data-testid="dashboard-tab-internal"]')
    if (internalTab) {
      await waitForSelector('[data-testid="dashboard-internal-panel"]', true)
      await delay(900)
      await captureStep('30-dashboard-internal-tab.png')
      await clickSelector('[data-testid="dashboard-tab-web"]')
      await delay(500)
    } else {
      logger.warn('[capture] dashboard internal tab not found')
    }
  } catch (error) {
    logger.warn('[capture] failed to capture dashboard internal tab', error)
  }

  try {
    // Internal operations page: overview cards + heatmap.
    await clickNav('内网作战')
    await waitForSelector('[data-testid="internal-page"]', true)
    await delay(1400)
    await captureStep('31-internal-overview.png')

    const heatmapScrolled = await scrollToTestId('internal-heatmap')
    if (heatmapScrolled) {
      await delay(500)
    }
    const bucketClicked = await clickSelector('[data-testid="internal-heatmap-bucket"]')
    if (bucketClicked) {
      await delay(700)
      await captureStep('32-internal-heatmap.png')
      await clickSelector('[data-testid="internal-heatmap-clear"]')
      await delay(500)
    } else {
      logger.warn('[capture] internal heatmap bucket not found')
    }

    const matrixScrolled = await scrollToTestId('internal-matrix-row')
    if (matrixScrolled) {
      await delay(700)
      await captureStep('33-internal-credential-matrix.png')
    } else {
      logger.warn('[capture] internal credential matrix not found')
    }

    const routeScrolled = await scrollToTestId('internal-route-lane')
    if (routeScrolled) {
      await delay(700)
      await captureStep('34-internal-routes.png')
    } else {
      logger.warn('[capture] internal route view not found')
    }

    const lootScrolled = await scrollToTestId('internal-loot-form')
    if (lootScrolled) {
      await delay(700)
      await captureStep('35-internal-loot.png')
    } else {
      logger.warn('[capture] internal loot panel not found')
    }

    const vulnScrolled = await scrollToTestId('internal-vuln-row')
    if (vulnScrolled) {
      await delay(700)
      await captureStep('36-internal-vulns.png')
    } else {
      logger.warn('[capture] internal vulnerability list not found')
    }
  } catch (error) {
    logger.warn('[capture] failed to capture internal operations page', error)
  }

  try {
    // Entry asset detail: foothold / reachable-internal section.
    await clickNav('资产库')
    await delay(600)
    const assetOpened = await clickAssetRow(0)
    if (assetOpened) {
      await waitForSelector('[data-testid="asset-sheet"]', true)
      await delay(900)
      const internalAssetTab = await clickSelector('[data-testid="asset-tab-internal"]')
      if (internalAssetTab) {
        await delay(800)
        await captureStep('37-asset-internal-entry.png')
      } else {
        logger.warn('[capture] asset internal tab not found')
      }
      pressEscape()
      await delay(400)
    }
  } catch (error) {
    logger.warn('[capture] failed to capture asset internal entry', error)
  }

  try {
    // Memory Nebula: realm switch (web / internal / all) + attack-path overlay.
    await clickNav('记忆星云')
    // The nebula chunk is lazy + heavy under software rendering: wait for the
    // control panel instead of a fixed delay.
    await waitForSelector('[data-testid="realm-internal"]', true, 10_000)
    await delay(2_600)
    const internalRealm = await clickSelector('[data-testid="realm-internal"]')
    if (internalRealm) {
      await delay(2200)
      // The attack-path overlay is ON by default with the first pivot route
      // auto-selected, so this frame already shows the highlighted path.
      await captureStep('38-nebula-internal-realm.png')
      // Switch to the other pivot route (established chain) for a second frame.
      const pickerOpened = await clickSelector('[aria-label="选择路由"]')
      if (pickerOpened) {
        await waitForSelector('[role="listbox"]', true)
        await delay(400)
        const routePicked = await clickRoleOption(1)
        if (routePicked) {
          await delay(1800)
          await captureStep('39-nebula-attack-path.png')
        } else {
          logger.warn('[capture] second nebula route option not found')
        }
      } else {
        logger.warn('[capture] nebula route picker did not open')
      }
      await clickSelector('[data-testid="realm-all"]')
      await delay(2200)
      await captureStep('40-nebula-all-realms.png')
    } else {
      logger.warn('[capture] nebula realm switch not found')
    }
  } catch (error) {
    logger.warn('[capture] failed to capture nebula realms', error)
  }

  try {
    // One English frame of the internal page for i18n coverage.
    await clickNav('内网作战')
    await waitForSelector('[data-testid="internal-page"]', true)
    await delay(600)
    const toggledToEnglish = await clickSelector('[data-testid="lang-toggle"]')
    if (toggledToEnglish) {
      await delay(800)
      await captureStep('41-internal-overview-en.png')
      await clickSelector('[data-testid="lang-toggle"]')
      await delay(400)
    }
  } catch (error) {
    logger.warn('[capture] failed to capture English internal page', error)
  }

  try {
    /*
     * Exploit-as-Code retest lab (desktop only): left nav card, candidate list
     * + workspace, provider/config dialog. The DB used for capture should
     * contain Web vulnerabilities (and optionally a draft PoC artifact) so the
     * workspace renders a form/code panel instead of the empty state.
     */
    const opened = await clickSelector('[data-testid="nav-retest"]')
    if (!opened) {
      logger.warn('[capture] retest lab nav card not found')
    } else {
      await waitForSelector('[data-testid="retest-page"]', true, 5_000)
      await delay(900)
      await captureStep('42-retest-lab.png')

      const selected = await clickSelector('[data-testid="retest-candidate-row"]')
      if (selected) {
        await waitForSelector('[data-testid="retest-workspace"]', true, 4_000)
        await delay(1_000)
        await captureStep('43-retest-workspace.png')
        const runScrolled = await scrollToTestId('retest-run-button')
        if (runScrolled) {
          await delay(500)
          await captureStep('44-retest-run-panel.png')
        }

        // Pick a candidate that owns a PoC artifact (if the seeded/real DB has
        // one) so the dynamic form + code panel + run history are captured too.
        const richCandidate = await clickPocCandidate(6)
        if (richCandidate) {
          await delay(1_000)
          await scrollToTestId('retest-workspace')
          await delay(400)
          await captureStep('47-retest-workspace-artifact.png')
          const historyScrolled = await scrollToTestId('retest-run-button')
          if (historyScrolled) {
            // Scroll further to the log terminal / run history section.
            await window.webContents.executeJavaScript(`
              (() => {
                const scroller = document.querySelector('[data-testid="retest-page"] main, [data-testid="retest-page"]')
                const target = document.querySelector('[data-testid="retest-console"]') ?? document.querySelector('[data-testid="retest-run-button"]')
                if (target) target.scrollIntoView({ block: 'start' })
                return true
              })()
            `)
            await delay(700)
            await captureStep('48-retest-console-history.png')
          }
        } else {
          logger.warn('[capture] no PoC-bearing retest candidate to capture')
        }
      } else {
        logger.warn('[capture] retest lab has no Web candidate row')
      }

      const configOpened = await clickSelector('[data-testid="retest-config-open"]')
      if (configOpened) {
        await waitForSelector('[data-testid="retest-config-panel"]', true, 3_000)
        await delay(700)
        await captureStep('45-retest-config.png')
        pressEscape()
        await delay(400)
      } else {
        logger.warn('[capture] retest config dialog did not open')
      }

      // English frame for i18n coverage.
      const toggled = await clickSelector('[data-testid="lang-toggle"]')
      if (toggled) {
        await delay(700)
        await captureStep('46-retest-lab-en.png')
        await clickSelector('[data-testid="lang-toggle"]')
        await delay(400)
      }
    }
  } catch (error) {
    logger.warn('[capture] failed to capture retest lab', error)
  }
}
