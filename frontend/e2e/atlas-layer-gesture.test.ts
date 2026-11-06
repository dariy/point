import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

describe('Atlas layer gestures', () => {
  let browser: Browser | undefined;
  let page: Page;
  let cdp: CDPSession;
  let cookie = '';

  const api = (path: string, body: unknown) =>
    fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
      body: JSON.stringify(body),
    });

  const state = () => page.evaluate(() => document.body.dataset.atlasLayer);

  /**
   * Under load the map can still slide over the handle after the handle settles,
   * and a touch then lands on the map. Wait until no transition runs.
   */
  const settled = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));

  /** One touch drag from (x, y) by (dx, dy), in steps. */
  async function swipe(x: number, y: number, dx: number, dy: number) {
    await settled();
    // Explicit timestamps 10ms apart: a short swipe changes the state as a flick,
    // and under load the real arrival times spread out until it is no flick.
    const t0 = Date.now() / 1000;
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number, py: number, i: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }], timestamp: t0 + i * 0.01,
      });
    await touch('touchStart', x, y, 0);
    for (let i = 1; i <= 6; i++) await touch('touchMove', x + (dx * i) / 6, y + (dy * i) / 6, i);
    await touch('touchEnd', x + dx, y + dy, 7);
  }

  /** Box of `sel` once two reads 120ms apart agree (the layout may still be sliding). */
  const settledBox = async (p: Page, sel: string) => {
    let prev = JSON.stringify(await p.locator(sel).boundingBox());
    for (let i = 0; i < 25; i++) {
      await p.waitForTimeout(120);
      const cur = JSON.stringify(await p.locator(sel).boundingBox());
      if (cur === prev) return JSON.parse(cur) as { x: number; y: number; width: number; height: number };
      prev = cur;
    }
    throw new Error('box never settled: ' + sel);
  };

  const center = async (sel: string) => {
    const b = await settledBox(page, sel);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  before(async () => {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    page = await ctx.newPage();
    await page.addInitScript(() => localStorage.removeItem('atlasLayerState'));
    cdp = await ctx.newCDPSession(page);
    const setup = await api('/api/setup', { name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' });
    if (!setup.ok) throw new Error('Setup failed: ' + setup.status);
    const login = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!login.ok) throw new Error('Login failed: ' + login.status);
    cookie = ((login.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';
    const post = await api('/api/posts', {
      title: 'Atlas gesture probe', slug: 'atlas-gesture-probe', content: 'Body.', excerpt: 'Card.',
      status: 'published', tags: ['atlas-gesture'],
    });
    if (!post.ok) throw new Error('Post creation failed: ' + (await post.text()));
  });

  after(async () => {
    await browser?.close();
  });

  it('swipes down on the handle through each state, and up back', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    let c = await center('.atlas-layer-handle');
    await swipe(c.x, c.y, 0, 80);
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    c = await center('.atlas-layer-handle');
    await swipe(c.x, c.y, 0, 80);
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    c = await center('.atlas-layer-handle');
    await swipe(c.x, c.y, 0, -80);
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    c = await center('.atlas-layer-handle');
    await swipe(c.x, c.y, 0, -80);
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'list');
    assert.equal(await page.locator('.atlas-layer-handle').getAttribute('aria-expanded'), 'false');
  });

  it('a short drag snaps back and a tap on the handle cycles', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    const c = await center('.atlas-layer-handle');
    await swipe(c.x, c.y, 0, 20);
    await page.waitForTimeout(300);
    assert.equal(await state(), 'list');
    await page.touchscreen.tap(c.x, c.y);
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    assert.equal(await page.locator('.atlas-layer-handle').getAttribute('aria-expanded'), 'true');
  });

  it('a free drag keeps map and list on screen and snaps to the nearest position on release', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800); // the first fit may re-render the grid; a drag must not start before it
    const to = (v: string) => page.waitForFunction((x) => document.body.dataset.atlasLayer === x, v);
    // Handle centre in each state: the snap positions.
    const at: Record<string, number> = {};
    for (const st of ['list', 'mapList', 'map']) {
      await page.evaluate((x) => document.body.setAttribute('data-atlas-layer', x), st);
      await to(st);
      at[st] = (await center('.atlas-layer-handle')).y;
    }
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'list'));
    await to('list');
    assert.ok(at.list! < at.mapList! && at.mapList! < at.map!, JSON.stringify(at));

    /** Slow drag of the handle to `y`; returns the boxes seen while the finger is still down. */
    async function dragTo(y: number, stepMs = 40) {
      const c = await center('.atlas-layer-handle');
      await settled();
      const t = (type: 'touchStart' | 'touchMove' | 'touchEnd', py: number) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: c.x, y: py }] });
      await t('touchStart', c.y);
      for (let i = 1; i <= 8; i++) {
        await t('touchMove', c.y + ((y - c.y) * i) / 8);
        await page.waitForTimeout(stepMs);
      }
      await page.waitForTimeout(150);
      const mid = {
        dragging: await page.evaluate(() => document.body.hasAttribute('data-atlas-dragging')),
        target: await page.evaluate(() => document.body.dataset.atlasDragTarget),
        strip: await page.evaluate(() => getComputedStyle(document.querySelector('#grid-mount .posts-grid')!).display === 'flex'),
        map: await page.locator('.atlas-layer-map').boundingBox(),
        handle: await page.locator('.atlas-layer-handle').boundingBox(),
        grid: await page.locator('#grid-mount').boundingBox(),
      };
      await t('touchEnd', y);
      return mid;
    }

    // list -> a point between mapList and map, nearer mapList
    let mid = await dragTo(at.mapList! + 20);
    assert.ok(mid.dragging);
    assert.equal(mid.target, 'mapList', 'the drag shows the layout of the state it snaps to');
    assert.ok(mid.strip, 'the cards take the map+list layout during the drag');
    assert.ok(mid.map && mid.map.height > 100, 'map visible during the drag');
    assert.ok(mid.grid && mid.grid.height > 20, 'list visible during the drag');
    assert.ok(Math.abs(mid.handle!.y + mid.handle!.height / 2 - (at.mapList! + 20)) < 8, 'handle follows the finger');
    await to('mapList');
    await page.waitForFunction(() => !document.body.hasAttribute('data-atlas-dragging'));

    await dragTo(at.map! - 15);
    await to('map');
    await dragTo(at.mapList! - 40);
    await to('mapList');
    mid = await dragTo(at.list! + 30);
    assert.equal(mid.target, 'list');
    assert.ok(!mid.strip, 'the cards take the list layout during the drag');
    await to('list');
    // After the release the map does not fold a second time.
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.atlas-layer-map')!).visibility), 'hidden');
    // A slow drag (no flick) to a point nearer map than mapList
    await dragTo(at.mapList! + (at.map! - at.mapList!) * 0.7, 250);
    await to('map');
  });

  it('a swipe inside the map never changes the state', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.atlas-layer-map')!).transform === 'none');
    const m = (await page.locator('.atlas-layer-map').boundingBox())!;
    const x = m.x + m.width / 2;
    await swipe(x, m.y + 40, 0, 120);
    await swipe(x, m.y + m.height - 40, 0, -120);
    await page.waitForTimeout(300);
    assert.equal(await state(), 'mapList');
  });

  it('a horizontal swipe on the card row does not change the state', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.atlas-layer-map')!).transform === 'none');
    const g = (await page.locator('#grid-mount').boundingBox())!;
    await swipe(g.x + g.width - 20, g.y + g.height / 2, -150, 6);
    await page.waitForTimeout(300);
    assert.equal(await state(), 'mapList');
  });

  it('a pull down on a card at scroll top opens the map', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    // The root keeps the browser pull-to-refresh off (css/public/layout.css).
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY), 'auto');
    const c = await center('#grid-mount .post-card');
    await swipe(c.x, c.y, 0, 150);
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
  });

  it('the same pull after a scroll does not change the state', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    // One post fits the viewport: make the page tall enough to scroll 200px.
    await page.evaluate(() => {
      document.body.style.minHeight = '3000px';
      window.scrollTo({ top: 200, behavior: 'instant' });
    });
    await page.waitForFunction(() => window.scrollY === 200);
    const c = await center('#grid-mount .post-card');
    await swipe(c.x, c.y, 0, 150);
    await page.waitForTimeout(300);
    assert.equal(await state(), 'list');
    assert.ok(!(await page.evaluate(() => document.body.hasAttribute('data-atlas-dragging'))));
  });

  /** Centre of a point on the footer line that is not a button, link, input or paginator. */
  const footerBackground = () => page.evaluate(() => {
    const r = document.querySelector('#footer-mount .site-footer')!.getBoundingClientRect();
    const y = r.top + r.height / 2;
    for (let x = r.left + 4; x < r.right; x += 4) {
      const el = document.elementFromPoint(x, y);
      if (el?.closest('#footer-mount') && !el.closest('button, a, input, .pagination')) return { x, y };
    }
    throw new Error('no footer background');
  });

  it('a swipe up on the footer in map goes to mapList', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'map'));
    await settledBox(page, '#footer-mount .site-footer');
    const p = await footerBackground();
    await swipe(p.x, p.y, 0, -80);
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
  });

  it('a tap on a footer button does not change the state', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
    const b = await settledBox(page, '#footer-mount .site-footer button:visible >> nth=0');
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(300);
    assert.equal(await state(), 'mapList');
    assert.ok(!(await page.evaluate(() => document.body.hasAttribute('data-atlas-dragging'))));
  });

  describe('touch landscape', () => {
    let spage: Page;
    let scdp: CDPSession;
    const W = 844;
    const H = 390;
    const sstate = () => spage.evaluate(() => document.body.dataset.atlasLayer);
    const waitState = (v: string) => spage.waitForFunction((x) => document.body.dataset.atlasLayer === x, v);
    const ssettled = () => spage.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));

    /** One touch drag from (x, y) by (dx, dy) in steps. `stepMs` > 0 is a slow drag, no flick. */
    async function sswipe(x: number, y: number, dx: number, dy: number, stepMs = 0) {
      await ssettled();
      const t0 = Date.now() / 1000;
      const gap = stepMs > 0 ? stepMs / 1000 : 0.01;
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number, py: number, i: number) =>
        scdp.send('Input.dispatchTouchEvent', {
          type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }], timestamp: t0 + i * gap,
        });
      await touch('touchStart', x, y, 0);
      for (let i = 1; i <= 6; i++) {
        await touch('touchMove', x + (dx * i) / 6, y + (dy * i) / 6, i);
        if (stepMs > 0) await spage.waitForTimeout(stepMs);
      }
      await touch('touchEnd', x + dx, y + dy, 7);
    }

    const box = async (sel: string) => (await settledBox(spage, sel));
    const centreOf = async (sel: string) => {
      const b = await box(sel);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const open = async (view: string) => {
      await spage.goto(`${BASE}/tags/atlas-side?view=${view}`);
      await spage.locator('.atlas-layer-handle').waitFor();
      await spage.waitForFunction(() => document.body.hasAttribute('data-atlas-side'));
      await spage.locator('#grid-mount .post-card').first().waitFor();
      await spage.waitForTimeout(600); // the column fit may re-render the grid
    };

    before(async () => {
      for (let i = 1; i <= 16; i++) {
        const post = await api('/api/posts', {
          title: `Atlas side ${i}`, slug: `atlas-side-${i}`, content: 'Body.', excerpt: 'Card.',
          status: 'published', tags: ['atlas-side'],
        });
        if (!post.ok) throw new Error('Post creation failed: ' + (await post.text()));
      }
      const ctx = await browser!.newContext({ viewport: { width: W, height: H }, hasTouch: true, isMobile: true });
      spage = await ctx.newPage();
      // A mouse event sets pointer-fine and ends the side layout: only touch input here.
      await spage.addInitScript(() => { localStorage.removeItem('atlasLayerState'); localStorage.removeItem('pointerFine'); });
      scdp = await ctx.newCDPSession(spage);
    });

    it('in mapList the handle is a vertical bar on the map right edge', async () => {
      await open('split');
      const m = await box('body > .atlas-layer-map');
      const h = await box('.atlas-layer-handle');
      const label = JSON.stringify({ m, h });
      assert.ok(Math.abs(h.x + h.width - (m.x + m.width)) <= 1, 'the handle ends at the map right edge: ' + label);
      assert.ok(h.width <= 40 && h.height >= H - 1, 'the handle is a vertical bar: ' + label);
      const g = (await box('.atlas-layer-handle__grip'));
      assert.ok(g.height > g.width, 'the grip is vertical: ' + JSON.stringify(g));
      // In map the bar is on the right edge of the full map.
      await spage.evaluate(() => document.body.setAttribute('data-atlas-layer', 'map'));
      const m2 = await box('body > .atlas-layer-map');
      const h2 = await box('.atlas-layer-handle');
      assert.ok(Math.abs(m2.width - W) <= 1, 'the full map is as wide as the viewport: ' + JSON.stringify(m2));
      assert.ok(Math.abs(h2.x + h2.width - W) <= 1 && h2.width <= 40, 'the bar is on the right edge: ' + JSON.stringify(h2));
    });

    it('a horizontal swipe on the handle steps the state', async () => {
      await open('split');
      let c = await centreOf('.atlas-layer-handle');
      await sswipe(c.x, c.y, 120, 0);
      await waitState('map');
      c = await centreOf('.atlas-layer-handle');
      await sswipe(c.x, c.y, -120, 0);
      await waitState('mapList');
      c = await centreOf('.atlas-layer-handle');
      await sswipe(c.x, c.y, -120, 0);
      await waitState('list');
      // In list the handle is the bar at the top of the list; a swipe right opens the map.
      c = await centreOf('.atlas-layer-handle');
      await sswipe(c.x, c.y, 120, 0);
      await waitState('mapList');
      // A vertical swipe on the vertical bar does not change the state.
      c = await centreOf('.atlas-layer-handle');
      await sswipe(c.x, c.y, 0, 120);
      await spage.waitForTimeout(300);
      assert.equal(await sstate(), 'mapList');
    });

    it('a free drag follows the finger in x and snaps to the nearest width', async () => {
      await open('split');
      const c = await centreOf('.atlas-layer-handle');
      await ssettled();
      const t = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number) =>
        scdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: c.y }] });
      // Slow, to a point nearer map than mapList.
      const to = c.x + (W - c.x) * 0.7;
      await t('touchStart', c.x);
      for (let i = 1; i <= 8; i++) {
        await t('touchMove', c.x + ((to - c.x) * i) / 8);
        await spage.waitForTimeout(40);
      }
      await spage.waitForTimeout(150);
      const mid = await spage.evaluate(() => ({
        dragging: document.body.hasAttribute('data-atlas-dragging'),
        target: document.body.dataset.atlasDragTarget,
        map: document.querySelector('body > .atlas-layer-map')!.getBoundingClientRect().toJSON(),
        handle: document.querySelector('.atlas-layer-handle')!.getBoundingClientRect().toJSON(),
        grid: document.querySelector('#grid-mount')!.getBoundingClientRect().toJSON(),
        gridTransform: document.querySelector<HTMLElement>('#grid-mount')!.style.transform,
      }));
      await t('touchEnd', to);
      const label = JSON.stringify(mid);
      assert.ok(mid.dragging, 'dragging: ' + label);
      assert.equal(mid.target, 'map', 'the drag shows the layout of the state it snaps to');
      assert.ok(Math.abs(mid.handle.x + mid.handle.width / 2 - to) < 8, 'the handle follows the finger: ' + label);
      assert.ok(Math.abs(mid.map.x + mid.map.width - (mid.handle.x + mid.handle.width)) <= 1, 'the map width follows the handle: ' + label);
      assert.ok(mid.grid.x >= mid.map.x + mid.map.width - 1, 'the list is right of the map: ' + label);
      // The page swipe (core/gridPager.ts) ignores a gesture on the handle: the list does not slide.
      assert.equal(mid.gridTransform, '', 'the list does not page: ' + label);
      assert.ok(Math.abs(mid.grid.x - (mid.map.x + mid.map.width)) <= 1, 'the list starts at the map edge: ' + label);
      await waitState('map');
      await spage.waitForFunction(() => !document.body.hasAttribute('data-atlas-dragging'));
      const m = await box('body > .atlas-layer-map');
      assert.ok(Math.abs(m.width - W) <= 1, 'the map settles at the full width: ' + JSON.stringify(m));
      assert.equal(await spage.evaluate(() => document.body.style.getPropertyValue('--atlas-layer-map-w')), '', 'the drag width is gone');
    });

    it('a swipe on the list column scrolls it, and a swipe on the map pans the map', async () => {
      await open('split');
      const g = await box('#grid-mount');
      assert.ok(await spage.evaluate(() => { const gm = document.querySelector('#grid-mount')!; return gm.scrollHeight > gm.clientHeight; }), 'the column overflows');
      await sswipe(g.x + g.width / 2, g.y + g.height - 30, 0, -150);
      await spage.waitForFunction(() => document.querySelector('#grid-mount')!.scrollTop > 0);
      assert.equal(await sstate(), 'mapList');
      assert.ok(!(await spage.evaluate(() => document.body.hasAttribute('data-atlas-dragging'))));
      // A horizontal swipe on the column does not change the state either.
      await sswipe(g.x + g.width - 30, g.y + g.height / 2, -150, 0);
      await spage.waitForTimeout(300);
      assert.equal(await sstate(), 'mapList');
      const m = await box('body > .atlas-layer-map');
      const pane = () => spage.evaluate(() => getComputedStyle(document.querySelector('.atlas-layer-map .leaflet-map-pane')!).transform);
      const before = await pane();
      await sswipe(m.x + m.width / 2, m.y + m.height / 2, -120, 40);
      await spage.waitForFunction((b) => getComputedStyle(document.querySelector('.atlas-layer-map .leaflet-map-pane')!).transform !== b, before);
      assert.equal(await sstate(), 'mapList');
    });

    it('a pull down on the list at scroll top opens the split', async () => {
      await open('list');
      const c = await centreOf('#grid-mount .post-card >> nth=0');
      await sswipe(c.x, c.y, 0, 150);
      await waitState('mapList');
      await spage.waitForFunction(() => !document.body.hasAttribute('data-atlas-dragging'));
      const m = await box('body > .atlas-layer-map');
      assert.ok(Math.abs(m.width - Math.min(H, W - 320)) <= 1, 'the split map: ' + JSON.stringify(m));
    });

    it('a tap on the handle cycles, and the arrow keys step', async () => {
      await open('split');
      const c = await centreOf('.atlas-layer-handle');
      await spage.touchscreen.tap(c.x, c.y);
      await waitState('map');
      await spage.locator('.atlas-layer-handle').focus();
      await spage.keyboard.press('ArrowLeft');
      await waitState('mapList');
      await spage.keyboard.press('ArrowRight');
      await waitState('map');
      await spage.keyboard.press('Escape');
      await waitState('list');
    });
  });

  describe('desktop', () => {
    let dpage: Page;
    const dstate = () => dpage.evaluate(() => document.body.dataset.atlasLayer);
    const waitState = (v: string) => dpage.waitForFunction((x) => document.body.dataset.atlasLayer === x, v);

    before(async () => {
      const ctx = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
      dpage = await ctx.newPage();
      // Each test starts in `list`: a state that an earlier test sets is saved (US-007) and would load next.
      await dpage.addInitScript(() => localStorage.removeItem('atlasLayerState'));
    });

    beforeEach(async () => {
      await dpage.goto(BASE + '/tags/atlas-gesture');
      await dpage.locator('.atlas-layer-handle').waitFor();
    });

    it('a mouse drag on the handle steps the state', async () => {
      let b = await settledBox(dpage, '.atlas-layer-handle');
      await dpage.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await dpage.mouse.down();
      await dpage.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 500, { steps: 6 });
      await dpage.mouse.up();
      await waitState('mapList');
      b = await settledBox(dpage, '.atlas-layer-handle');
      await dpage.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await dpage.mouse.down();
      await dpage.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 500, { steps: 6 });
      await dpage.mouse.up();
      await waitState('list');
    });

    it('the wheel over the handle steps once per gesture', async () => {
      const b = await settledBox(dpage, '.atlas-layer-handle');
      await dpage.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      for (let i = 0; i < 4; i++) await dpage.mouse.wheel(0, 40);
      await waitState('mapList');
      await dpage.waitForTimeout(400);
      assert.equal(await dstate(), 'mapList');
      const b2 = await settledBox(dpage, '.atlas-layer-handle');
      await dpage.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
      await dpage.mouse.wheel(0, -40);
      await waitState('list');
    });

    it('the wheel over the map does not change the state', async () => {
      await dpage.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
      await dpage.waitForFunction(() => getComputedStyle(document.querySelector('.atlas-layer-map')!).transform === 'none');
      const m = await settledBox(dpage, '.atlas-layer-map');
      await dpage.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
      await dpage.mouse.wheel(0, 120);
      await dpage.waitForTimeout(400);
      assert.equal(await dstate(), 'mapList');
    });

    it('the keyboard drives the handle', async () => {
      const h = dpage.locator('.atlas-layer-handle');
      await h.focus();
      await dpage.keyboard.press('Enter');
      await waitState('mapList');
      await dpage.keyboard.press('ArrowDown');
      await waitState('map');
      await dpage.keyboard.press('ArrowUp');
      await waitState('mapList');
      await dpage.keyboard.press('Space');
      await waitState('map');
      await dpage.keyboard.press('Space');
      await waitState('list');
      await dpage.keyboard.press('ArrowDown');
      await dpage.keyboard.press('Escape');
      await waitState('list');
      assert.equal(await h.getAttribute('aria-expanded'), 'false');
      assert.equal(await h.locator('[aria-live]').textContent(), 'List');
      await dpage.keyboard.press('ArrowDown');
      await waitState('mapList');
      assert.equal(await h.locator('[aria-live]').textContent(), 'Map and list');
    });
  });
});
