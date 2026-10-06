import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

describe('Atlas layer', () => {
  let browser: Browser | undefined;
  let page: Page;

  before(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext()).newPage();

    const res = await fetch(`${BASE}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' }),
    });
    // 409: another e2e file already created the owner.
    if (!res.ok && res.status !== 409) throw new Error('Setup failed: ' + res.status);
  });

  after(async () => {
    await browser?.close();
  });

  it('tags-atlas is enabled', async () => {
    await page.goto(`${BASE}/`);
    const plugins = await page.evaluate(() => JSON.stringify((window as any).__PLUGINS__ ?? []));
    assert.match(plugins, /tags-atlas/);
  });

  it('the home page starts in the list state', async () => {
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'list');
  });
});
