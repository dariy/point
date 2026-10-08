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
    await page.addInitScript(() => localStorage.removeItem('atlasLayerState'));

    const res = await fetch(`${BASE}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' }),
    });
    if (!res.ok) throw new Error('Setup failed: ' + res.status);
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
      if (!post.ok) throw new Error('Post creation failed: ' + (await post.text()));
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
        assert.ok(box && box.height <= 34, `handle height ${box?.height}`);
        // It sits directly before the grid, so it is at the top of the list.
        const before = await page.evaluate(
          () => document.querySelector('.atlas-layer-handle')?.nextElementSibling?.id,
        );
        assert.equal(before, 'grid-mount');
      });
    }

    // The footer is the bottom bar: fixed at the viewport bottom, one line high.
    const bottomBar = async () => {
      const footer = page.locator('#footer-mount .site-footer');
      await footer.waitFor({ state: 'visible' });
      const f = (await footer.boundingBox())!;
      assert.ok(Math.abs(f.y + f.height - 844) <= 1, `footer bottom ${f.y + f.height}`);
      assert.ok(f.height <= 80, `footer is one line, height ${f.height}`);
      return f;
    };

    it('mapList shows the map over a strip that stands on the one-line footer', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + '/tags/atlas-handle');
      await page.locator('.atlas-layer-handle').waitFor();
      const footerBefore = await page.locator('#footer-mount .site-footer').isVisible();
      assert.ok(footerBefore, 'footer shows in list');
      await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
      const map = page.locator('.atlas-layer-map');
      await map.waitFor({ state: 'visible' });
      // The slide ends when the transform is gone.
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.atlas-layer-map')!).transform === 'none');
      const f = await bottomBar();
      const m = (await map.boundingBox())!;
      const h = (await page.locator('#header-mount').boundingBox())!;
      assert.ok(Math.abs(m.y - (h.y + h.height)) <= 1, `map top ${m.y} vs header bottom ${h.y + h.height}`);
      const g = (await page.locator('#grid-mount').boundingBox())!;
      const handle = (await page.locator('.atlas-layer-handle').boundingBox())!;
      assert.equal(await page.locator('#pagination-mount').isVisible(), false, 'no paginator under the cards');
      // The card row is clamp(96px, 22dvh, 220px) high (--atlas-layer-row-h).
      assert.ok(Math.abs(g.height - 844 * 0.22) <= 1, `card row height ${g.height}`);
      assert.ok(Math.abs(g.y + g.height - f.y) <= 1, 'the cards stand on the footer');
      assert.ok(Math.abs(handle.y + handle.height - g.y) <= 1, 'the handle sits on the cards');
      assert.ok(Math.abs(m.y + m.height - handle.y) <= 1, 'map ends where the list starts');
      await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'list'));
      await page.locator('#footer-mount .site-footer').waitFor({ state: 'visible' });
    });

    it('a drag shows the one-line footer under the handle', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + '/tags/atlas-handle');
      await page.locator('.atlas-layer-handle').waitFor();
      await page.evaluate(() => {
        document.body.dataset.atlasDragTarget = 'list';
        document.body.setAttribute('data-atlas-dragging', '');
      });
      await bottomBar();
      await page.evaluate(() => {
        document.body.removeAttribute('data-atlas-dragging');
        document.body.removeAttribute('data-atlas-drag-target');
      });
    });

    it('map fills below the header, collapses the list to a handle on the one-line footer', async () => {
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
      const f = await bottomBar();
      assert.ok(Math.abs(handle.y + handle.height - f.y) <= 1, 'handle sits on the footer');
      assert.ok(Math.abs(m.y + m.height - f.y) <= 1, `map bottom ${m.y + m.height} vs footer top ${f.y}`);
      assert.equal(await page.locator('.footer-copyright').isVisible(), true);
      assert.equal(await page.locator('#footer-slider-btn').isVisible(), true);
      assert.equal(await page.locator('.footer-pagination').isVisible(), false, 'no paginator in map');
      // Without the footer plugin the mount is empty: the handle sits at the page bottom.
      await page.evaluate(() => document.querySelector('#footer-mount')!.replaceChildren());
      await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--atlas-layer-footer-h').trim() === '0px');
      const bare = (await page.locator('.atlas-layer-handle').boundingBox())!;
      assert.ok(Math.abs(bare.y + bare.height - 844) <= 1, 'handle at the bottom with no footer');
      await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'list'));
    });

    describe('strip geometry', () => {
      // More posts than one strip page at 1440px, so the next page arrow is enabled.
      before(async () => {
        for (let i = 0; i < 9; i++) {
          const post = await api('/api/posts', {
            title: `Atlas strip probe ${i}`, slug: `atlas-strip-probe-${i}`, content: 'Body.', excerpt: 'Card.',
            status: 'published', tags: ['atlas-strip'],
          });
          if (!post.ok) throw new Error('Post creation failed: ' + (await post.text()));
        }
      });

      const open = async (width: number, height: number, view: string) => {
        await page.setViewportSize({ width, height });
        await page.goto(`${BASE}/tags/atlas-strip?view=${view}`);
        await page.locator('.atlas-layer-handle').waitFor();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.atlas-layer-map')!).transform === 'none');
      };

      it('at 390x844 the strip cards fill the row', async () => {
        await open(390, 844, 'split');
        await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card-slot').length >= 2);
        const boxes = await page.locator('#grid-mount .post-card-slot').evaluateAll((els) =>
          els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => ({ right: r.right, width: r.width })));
        assert.ok(boxes.length >= 2, `${boxes.length} cards show`);
        const gap = 390 - boxes[boxes.length - 1].right;
        assert.ok(gap >= 0 && gap < 16, `right gap ${gap}`);
      });

      it('at 1440x900 the page arrows hide in mapList and map', async () => {
        for (const view of ['split', 'map']) {
          await open(1440, 900, view);
          const next = page.locator('.page-nav-arrow.page-nav-next');
          await next.waitFor({ state: 'attached' });
          if (view === 'split') assert.equal(await next.isDisabled(), false, 'a second page exists');
          assert.equal(await next.isVisible(), false, `next arrow in ${view}`);
        }
      });

      it('at 844x390 the legend is one button, clear of the zoom control', async () => {
        await open(844, 390, 'split');
        const legend = page.locator('.atlas-layer-map .atlas-legend');
        const zoom = page.locator('.atlas-layer-map .leaflet-control-zoom');
        await legend.waitFor();
        await zoom.waitFor();
        assert.equal(await page.locator('.atlas-layer-map .atlas-toggle').first().isVisible(), false, 'toggles fold away');
        const more = legend.locator('.atlas-legend__more');
        const apart = async () => {
          const l = (await legend.boundingBox())!;
          const z = (await zoom.boundingBox())!;
          return l.x >= z.x + z.width || l.y >= z.y + z.height;
        };
        assert.ok(await apart(), 'closed legend clear of the zoom control');
        await more.click();
        assert.equal(await more.getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('.atlas-layer-map .atlas-toggle').first().isVisible(), true, 'toggles open');
        assert.ok(await apart(), 'open legend clear of the zoom control');
      });
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
