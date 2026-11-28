// The browser and context that an e2e file runs on.
//
// E2E_DEVICE selects the device:
// - unset or `chromium`: Chromium with the context options that the file gives.
// - `ipad`: WebKit with `devices['iPad Pro 11']` (834x1194, touch, mobile, the
//   iPad user agent). The file's own options do not apply, but `extra` does.
//
// Only files that call launchFor follow E2E_DEVICE. All other files stay on
// Chromium.
import { chromium, webkit, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';

export type DeviceName = 'chromium' | 'ipad';

export function deviceName(): DeviceName {
  const name = process.env.E2E_DEVICE || 'chromium';
  if (name !== 'chromium' && name !== 'ipad') {
    throw new Error(`E2E_DEVICE=${name}: use "chromium" or "ipad"`);
  }
  return name;
}

/** True when E2E_DEVICE selects the WebKit iPad. Use it to skip a test that is for Chromium only. */
export const onIpad = deviceName() === 'ipad';

/**
 * Launches the browser for E2E_DEVICE and returns it with a new context.
 * `options` is the Chromium context. `extra` goes into every context, on each device.
 */
export async function launchFor(
  name: DeviceName = deviceName(),
  options: BrowserContextOptions = {},
  extra: BrowserContextOptions = {},
): Promise<{ browser: Browser; context: BrowserContext; contextOptions: BrowserContextOptions }> {
  const contextOptions = name === 'ipad'
    ? { ...devices['iPad Pro 11'], ...extra }
    : { ...options, ...extra };
  const browser = name === 'ipad' ? await webkit.launch() : await chromium.launch();
  const context = await browser.newContext(contextOptions);
  return { browser, context, contextOptions };
}

/**
 * Makes `page` a touch-only device. Chromium with touch emulation still has a
 * mouse: at each page load it sends a trusted `pointermove` of type "mouse" at
 * (0, 0), the hover update for the mouse position. When app.js has started
 * before that event, pointerMode.ts marks the page `pointer-fine`, and the
 * touch side layouts do not come (p-yao5z, p-6izja). This listener is on window
 * before the listeners of the app, so it stops each mouse pointer event first.
 * Do not use it on a page that the test drives with `page.mouse`.
 */
export async function touchOnly(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const noMouse = (e: Event) => { if ((e as PointerEvent).pointerType === 'mouse') e.stopImmediatePropagation(); };
    for (const type of ['pointermove', 'pointerdown']) window.addEventListener(type, noMouse, { capture: true });
  });
}
