import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, type Browser } from 'playwright';

// US-004: the media picker shows "From Photo Library" only when
// PHOTO_LIBRARY_PATH names a readable directory. The shared e2e server runs
// without the variable, and a server reads it only at start, so this file
// starts one server for each state.
const ROOT = path.resolve(import.meta.dirname, '../..');
const BIN = path.join(ROOT, 'point-e2e');
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

async function startServer(port: string, env: Record<string, string>) {
  const storage = mkdtempSync(path.join(tmpdir(), 'point-library-e2e-'));
  for (const d of ['media/originals', 'media/thumbnails', 'media/variants', 'logs', 'themes']) {
    mkdirSync(path.join(storage, d), { recursive: true });
  }
  const server = spawn(BIN, [], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: port,
      HOST: '127.0.0.1',
      STORAGE_PATH: storage,
      DATABASE_URL: `sqlite:${storage}/point.db`,
      FRONTEND_DIR: process.env.FRONTEND_DIR || path.join(ROOT, 'frontend'),
      SETUP_TOKEN: '',
      PHOTO_LIBRARY_PATH: '',
      ...env,
    },
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch { /* not up yet */ }
    if (i > 50) throw new Error(`photo library e2e server on ${port} did not start`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { base, server, storage };
}

describe('From Photo Library button', () => {
  let browser: Browser | undefined;
  const servers: ChildProcess[] = [];
  const dirs: string[] = [];

  before(async () => {
    assert.ok(existsSync(BIN), `${BIN} is missing — run scripts/run-e2e.sh`);
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const s of servers) s.kill();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** Set up the owner, show the post editor's picker, and return whether the button is visible. */
  async function libraryButtonVisible(port: string, env: Record<string, string>) {
    const { base, server, storage } = await startServer(port, env);
    servers.push(server);
    dirs.push(storage);

    const context = await browser!.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/light/login`);
    await page.evaluate(async (hash) => {
      const post = (url: string, body: unknown) => fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      await post('/api/setup', { name: hash });
      const res = await post('/api/auth/login', { username: 'the_owner', name: hash });
      if (!res.ok) throw new Error('login failed: ' + res.status);
    }, PW);

    // The picker asks /api/system/stats once; wait for that answer.
    const stats = page.waitForResponse((r) => r.url().endsWith('/api/system/stats'));
    await page.goto(`${base}/light/posts/new`);
    await stats;
    // The stats promise resolves in the page right after the response.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
    await page.evaluate(() => document.querySelector('.media-picker-overlay')?.classList.add('active'));
    const visible = await page.locator('#mpd-library-btn').isVisible();
    await context.close();
    return visible;
  }

  it('is absent when PHOTO_LIBRARY_PATH is not set', async () => {
    assert.equal(await libraryButtonVisible(process.env.E2E_LIBRARY_OFF_PORT || '8007', {}), false);
  });

  it('is present when PHOTO_LIBRARY_PATH is a readable directory', async () => {
    const library = mkdtempSync(path.join(tmpdir(), 'point-library-'));
    dirs.push(library);
    assert.equal(
      await libraryButtonVisible(process.env.E2E_LIBRARY_ON_PORT || '8008', { PHOTO_LIBRARY_PATH: library }),
      true,
    );
  });
});
