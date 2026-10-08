import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

// US-007: apply two presets in the style picker (/style) and check that the
// public home page changes its font family and its header layout.
describe('Style picker', () => {
  let browser: Browser | undefined;
  let page: Page;
  let cookie = '';

  const api = (path: string, body: unknown, method = 'POST') =>
    fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
      body: JSON.stringify(body),
    });

  before(async () => {
    const setup = await api('/api/setup', {
      name: PW, blog_title: 'Style Blog', author_name: 'Style User', email: 'style@example.com',
    });
    if (!setup.ok) throw new Error('Setup failed: ' + setup.status);
    const res = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!res.ok) throw new Error('Login failed: ' + res.status);
    const match = (res.headers.get('set-cookie') || '').match(/session=([^;]+)/);
    if (match) cookie = match[1];

    const post = await api('/api/posts', {
      title: 'Style picker probe', slug: 'style-picker-probe',
      content: 'Body text.', excerpt: 'Card text.', status: 'published',
    });
    if (!post.ok) throw new Error('Post creation failed: ' + await post.text());

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const url = new URL(BASE);
    await context.addCookies([{ name: 'session', value: cookie, domain: url.hostname, path: '/' }]);
    page = await context.newPage();
  });

  after(async () => {
    await browser?.close();
  });

  async function applyPreset(name: string) {
    await page.goto(`${BASE}/style`);
    const card = page.locator(`.style-card[data-name="${name}"]`);
    await card.click();
    await page.locator(`.style-card[data-name="${name}"][aria-pressed="true"]`).waitFor();
    // The preview changes before anything is saved.
    await page.waitForFunction(
      (n) => (document.getElementById('point-theme')?.textContent || '').includes(`preset: "${n}"`),
      name === 'editorial' ? 'Editorial' : 'Gallery',
    );
    await page.locator('#style-apply').click();
    await page.locator(`.style-card[data-name="${name}"] .style-card-badge:not([hidden])`).waitFor();
  }

  async function homeLook() {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.post-card');
    return page.evaluate(() => {
      const header = document.querySelector('.site-header-group')!;
      const identity = document.querySelector('.site-identity')!;
      return {
        font: getComputedStyle(document.body).fontFamily,
        identityLeft: Math.round(identity.getBoundingClientRect().left),
        headerBorder: getComputedStyle(header).borderBottomStyle,
      };
    });
  }

  it('applies two presets and the home page font and header change', async () => {
    await applyPreset('editorial');
    const editorial = await homeLook();
    await applyPreset('gallery');
    const gallery = await homeLook();

    assert.notEqual(editorial.font, gallery.font, 'font family must change');
    assert.ok(
      editorial.identityLeft !== gallery.identityLeft || editorial.headerBorder !== gallery.headerBorder,
      `header layout must change: ${JSON.stringify({ editorial, gallery })}`,
    );
  });
});
