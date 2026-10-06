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

  describe('handle', () => {
    let cookie = '';
    const api = (path: string, body: unknown, method = 'POST') =>
      fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
        body: JSON.stringify(body),
      });

    before(async () => {
      const res = await api('/api/auth/login', { username: 'the_owner', name: PW });
      if (!res.ok) throw new Error('Login failed: ' + res.status);
      cookie = ((res.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';
      const post = await api('/api/posts', {
        title: 'Atlas handle probe', slug: 'atlas-handle-probe', content: 'Body.', excerpt: 'Card.',
        status: 'published', tags: ['atlas-handle'],
      });
      if (!post.ok && post.status !== 409) throw new Error('Post creation failed: ' + (await post.text()));
    });

    const paths: Array<[string, string]> = [
      ['home', '/'],
      ['tag', '/tags/atlas-handle'],
      ['search', '/search?q=probe'],
    ];

    for (const [name, path] of paths) {
      it(`the ${name} page shows the handle at the top of the post list`, async () => {
        await page.goto(BASE + path);
        const handle = page.locator('.atlas-layer-handle');
        await handle.waitFor();
        assert.equal(await handle.count(), 1);
        assert.equal(await handle.getAttribute('role'), 'button');
        assert.ok(await handle.getAttribute('aria-label'));
        assert.equal(await handle.getAttribute('aria-expanded'), 'false');
        const box = await handle.boundingBox();
        assert.ok(box && box.height <= 24, `handle height ${box?.height}`);
        // It sits directly before the grid, so it is at the top of the list.
        const before = await page.evaluate(
          () => document.querySelector('.atlas-layer-handle')?.nextElementSibling?.id,
        );
        assert.equal(before, 'grid-mount');
      });
    }

    it('there is no handle when the plugin is off', async () => {
      const off = await api('/api/plugins/tags-atlas', { enabled: false }, 'PATCH');
      assert.ok(off.ok, 'disabling failed: ' + off.status);
      // A fresh context: the first one may hold the page shell it fetched while the plugin was on.
      const fresh = await browser!.newContext();
      try {
        const offPage = await fresh.newPage();
        for (const [, path] of paths) {
          await offPage.goto(BASE + path);
          await offPage.locator('#grid-mount').waitFor();
          assert.equal(await offPage.locator('.atlas-layer-handle').count(), 0, path);
        }
      } finally {
        await fresh.close();
        await api('/api/plugins/tags-atlas', { enabled: true }, 'PATCH');
      }
    });
  });
});
