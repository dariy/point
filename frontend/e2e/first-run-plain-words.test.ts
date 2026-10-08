import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

// US-008: the first-run path (setup → first post → style picker) must not show
// self-hoster terms. This file starts its own server on an empty database and
// reads the visible text of each screen on the way.
const ROOT = path.resolve(import.meta.dirname, '../..');
const BIN = path.join(ROOT, 'point-e2e');
const PORT = process.env.E2E_FIRST_RUN_PORT || '8007';
const BASE = `http://127.0.0.1:${PORT}`;

const BANNED = [/\.env\b/i, /compose/i, /docker/i, /remark42/i];
// An absolute file system path: "/" at a word start, then a typical top-level
// directory. App routes such as "/light" or "/style" do not match.
const ABS_PATH = /(^|[\s"'(=:])\/(home|root|var|srv|opt|tmp|data|usr|etc|mnt|media|app|storage|Users)\//;

describe('First-run path uses plain words', () => {
  let browser: Browser | undefined;
  let server: ChildProcess | undefined;
  let storage = '';

  before(async () => {
    assert.ok(existsSync(BIN), `${BIN} is missing — run scripts/run-e2e.sh`);
    storage = mkdtempSync(path.join(tmpdir(), 'point-first-run-e2e-'));
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
        PHOTO_LIBRARY_PATH: '',
      },
    });
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch { /* not up yet */ }
      if (i > 50) throw new Error('first-run e2e server did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    server?.kill();
    if (storage) rmSync(storage, { recursive: true, force: true });
  });

  async function assertPlain(page: Page, screen: string) {
    const text = await page.evaluate(() => document.body.innerText);
    for (const re of BANNED) assert.doesNotMatch(text, re, `${screen} shows ${re}`);
    assert.doesNotMatch(text, ABS_PATH, `${screen} shows an absolute path`);
    assert.ok(!text.includes(storage), `${screen} shows the storage path`);
  }

  it('shows no self-hoster terms from setup to the style picker', async () => {
    const page = await browser!.newPage();
    await page.goto(`${BASE}/setup`);
    await page.locator('#setup-form').waitFor();
    await assertPlain(page, 'setup');

    await page.fill('#username', 'alex');
    await page.fill('#password', 'devpassword');
    await page.fill('#confirm_password', 'devpassword');
    await page.click('.setup-submit-btn');
    await page.waitForURL(/\/light\/first-post/);
    await page.locator('#first-post-drop').waitFor();
    await assertPlain(page, 'first post: pick');

    const jpeg = readFileSync(path.join(ROOT, 'frontend/images/placeholder.jpg'));
    await page.setInputFiles('#first-post-files', [1, 2].map((n) => ({
      name: `run-${n}.jpg`, mimeType: 'image/jpeg',
      buffer: Buffer.concat([jpeg, Buffer.from(`first-run-${n}`)]),
    })));
    await page.locator('.first-post-item').nth(1).waitFor();
    await assertPlain(page, 'first post: review');

    await page.fill('#first-post-title', 'First light');
    await page.click('#first-post-publish');
    await page.locator('#first-post-look').waitFor();
    await assertPlain(page, 'first post: done');

    await page.click('#first-post-look');
    await page.waitForURL(/\/style/);
    await page.locator('.style-card').first().waitFor();
    await assertPlain(page, 'style picker');
    await page.close();
  });
});
