import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';

// The other e2e files share one server and bootstrap it through the API, so
// that server never shows the wizard. This file starts its own server on an
// empty database (US-001: setup with only the account fields).
const ROOT = path.resolve(import.meta.dirname, '../..');
const BIN = path.join(ROOT, 'point-e2e');
const PORT = process.env.E2E_SETUP_PORT || '8006';
const BASE = `http://127.0.0.1:${PORT}`;

describe('Setup wizard on a fresh database', () => {
  let browser: Browser | undefined;
  let server: ChildProcess | undefined;
  let storage = '';

  before(async () => {
    assert.ok(existsSync(BIN), `${BIN} is missing — run scripts/run-e2e.sh`);
    storage = mkdtempSync(path.join(tmpdir(), 'point-setup-e2e-'));
    for (const d of ['media/originals', 'media/thumbnails', 'media/variants', 'logs', 'themes']) {
      mkdirSync(path.join(storage, d), { recursive: true });
    }
    server = spawn(BIN, [], {
      cwd: ROOT,
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT,
        HOST: '127.0.0.1',
        STORAGE_PATH: storage,
        DATABASE_URL: `sqlite:${storage}/point.db`,
        FRONTEND_DIR: process.env.FRONTEND_DIR || path.join(ROOT, 'frontend'),
        SETUP_TOKEN: '',
      },
    });
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch { /* not up yet */ }
      if (i > 50) throw new Error('setup e2e server did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    server?.kill();
    if (storage) rmSync(storage, { recursive: true, force: true });
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
