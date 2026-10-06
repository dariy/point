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

    it('mapList shows the map, hides the footer and sizes the list to about a fifth', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + '/tags/atlas-handle');
      await page.locator('.atlas-layer-handle').waitFor();
      const footerBefore = await page.locator('#footer-mount .site-footer').isVisible();
      assert.ok(footerBefore, 'footer shows in list');
      await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
      const map = page.locator('.atlas-layer-map');
      await map.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#footer-mount .site-footer').isVisible(), false);
      // The slide ends when the transform is gone.
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.atlas-layer-map')!).transform === 'none');
      const m = (await map.boundingBox())!;
      const h = (await page.locator('#header-mount').boundingBox())!;
      assert.ok(Math.abs(m.y - (h.y + h.height)) <= 1, `map top ${m.y} vs header bottom ${h.y + h.height}`);
      const g = (await page.locator('#grid-mount').boundingBox())!;
      const handle = (await page.locator('.atlas-layer-handle').boundingBox())!;
      const list = g.height + handle.height;
      assert.ok(list >= 844 * 0.15 && list <= 844 * 0.25, `list height ${list}`);
      assert.ok(Math.abs(g.y + g.height - 844) <= 1, 'list sits at the bottom');
      assert.ok(Math.abs(m.y + m.height - (handle.y)) <= 1, 'map ends where the list starts');
      await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'list'));
      await page.locator('#footer-mount .site-footer').waitFor({ state: 'visible' });
    });

    it('map fills below the header, collapses the list to a handle over a minimized footer', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + '/tags/atlas-handle');
      await page.locator('.atlas-layer-handle').waitFor();
      await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'map'));
      const map = page.locator('.atlas-layer-map');
      await map.waitFor({ state: 'visible' });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.atlas-layer-map')!).transform === 'none');
      const m = (await map.boundingBox())!;
      const h = (await page.locator('#header-mount').boundingBox())!;
      assert.ok(Math.abs(m.y - (h.y + h.height)) <= 1, `map top ${m.y} vs header bottom ${h.y + h.height}`);
      const handle = (await page.locator('.atlas-layer-handle').boundingBox())!;
      assert.ok(handle.height <= 32, `handle height ${handle.height}`);
      assert.equal(await page.locator('#grid-mount .post-card').first().isVisible(), false, 'no card shows');
      // The minimized footer: copyright only, between the handle and the viewport bottom.
      const footer = page.locator('#footer-mount .site-footer');
      await footer.waitFor({ state: 'visible' });
      const f = (await footer.boundingBox())!;
      assert.ok(Math.abs(f.y + f.height - 844) <= 1, `footer bottom ${f.y + f.height}`);
      assert.ok(Math.abs(handle.y + handle.height - f.y) <= 1, 'handle sits on the footer');
      assert.ok(f.height <= 48, `footer height ${f.height}`);
      assert.ok(Math.abs(m.y + m.height - f.y) <= 1, `map bottom ${m.y + m.height} vs footer top ${f.y}`);
      assert.equal(await page.locator('.footer-copyright').isVisible(), true);
      assert.equal(await page.locator('.footer-right').isVisible(), false);
      assert.equal(await page.locator('.footer-center').isVisible(), false);
      // Without the footer plugin the mount is empty: the handle sits at the page bottom.
      await page.evaluate(() => document.querySelector('#footer-mount')!.replaceChildren());
      await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--atlas-layer-footer-h').trim() === '0px');
      const bare = (await page.locator('.atlas-layer-handle').boundingBox())!;
      assert.ok(Math.abs(bare.y + bare.height - 844) <= 1, 'handle at the bottom with no footer');
      await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'list'));
    });

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
