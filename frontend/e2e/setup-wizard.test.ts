import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';

// scripts/run-e2e.sh gives each e2e file a server on an empty database, so
// this server shows the wizard (US-001: setup with only the account fields).
const ROOT = path.resolve(import.meta.dirname, '../..');
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';

describe('Setup wizard on a fresh database', () => {
  let browser: Browser | undefined;

  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  it('completes with username and password only and logs the owner in', async () => {
    const page = await browser!.newPage();
    await page.goto(`${BASE}/setup`);
    await page.locator('#setup-form').waitFor();

    const ids = await page.locator('#setup-form input').evaluateAll(
      (els) => els.map((e) => e.id));
    assert.deepEqual(ids, ['username', 'password', 'confirm_password']);

    await page.fill('#username', 'alex');
    await page.fill('#password', 'devpassword');
    await page.fill('#confirm_password', 'devpassword');
    await page.click('.setup-submit-btn');
    await page.waitForURL(/\/light\/first-post/);

    const me = await page.evaluate(async () => (await fetch('/api/auth/me')).status);
    assert.equal(me, 200, 'owner is logged in after setup');

    const settings = await page.evaluate(async () => (await fetch('/api/settings')).json());
    const title = settings.blog_title ?? settings.settings?.blog_title;
    assert.equal(title, 'Alex');
    await page.close();
  });

  // US-005: setup → upload 3 images → publish → the post is on the home page.
  it('publishes the first photos as a post on the public home page', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/light/login`);
    await page.evaluate(async () => {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('devpassword'));
      const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alex', name: hash }),
      });
    });
    await page.goto(`${BASE}/light/first-post`);
    await page.locator('#first-post-drop').waitFor();
    assert.equal(await page.locator('input[type=file]').count(), 1);

    // Trailing bytes keep each JPEG valid but give it its own hash.
    const jpeg = readFileSync(path.join(ROOT, 'frontend/images/placeholder.jpg'));
    const files = [1, 2, 3].map((n) => ({
      name: `first-${n}.jpg`, mimeType: 'image/jpeg',
      buffer: Buffer.concat([jpeg, Buffer.from(`first-post-${n}`)]),
    }));
    await page.setInputFiles('#first-post-files', files);
    await page.locator('.first-post-item').nth(2).waitFor();
    assert.equal(await page.locator('.first-post-item').count(), 3);

    await page.fill('#first-post-title', 'First light');
    await page.click('#first-post-publish');
    await page.locator('#first-post-look').waitFor();

    await page.goto(`${BASE}/`);
    await page.getByText('First light').first().waitFor();
    await context.close();
  });
});
