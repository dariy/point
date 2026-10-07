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

  /** One touch drag from (x, y) by (dx, dy), in steps. */
  async function swipe(x: number, y: number, dx: number, dy: number) {
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number, py: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }] });
    await touch('touchStart', x, y);
    for (let i = 1; i <= 6; i++) await touch('touchMove', x + (dx * i) / 6, y + (dy * i) / 6);
    await touch('touchEnd', x + dx, y + dy);
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
    if (!setup.ok && setup.status !== 409) throw new Error('Setup failed: ' + setup.status);
    const login = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!login.ok) throw new Error('Login failed: ' + login.status);
    cookie = ((login.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';
    const post = await api('/api/posts', {
      title: 'Atlas gesture probe', slug: 'atlas-gesture-probe', content: 'Body.', excerpt: 'Card.',
      status: 'published', tags: ['atlas-gesture'],
    });
    if (!post.ok && post.status !== 409) throw new Error('Post creation failed: ' + (await post.text()));
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

  it('the handle buttons change the state and a tap on one starts no drag', async () => {
    await page.goto(BASE + '/tags/atlas-gesture');
    await page.locator('.atlas-layer-handle').waitFor();
    const btn = (label: string) => page.locator(`.atlas-layer-handle__btn[aria-label="${label}"]`);
    const tapBtn = async (label: string) => {
      await page.locator('.atlas-layer-handle__btn').first().waitFor();
      const b = await settledBox(page, `.atlas-layer-handle__btn[aria-label="${label}"]`);
      assert.ok(b.width >= 44 && b.height >= 44, `${label} target ${b.width}x${b.height}`);
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    };
    const to = (v: string) => page.waitForFunction((x) => document.body.dataset.atlasLayer === x, v);

    assert.equal(await page.locator('.atlas-layer-handle__btn').count(), 1);
    await tapBtn('Restore map and list');
    await to('mapList');
    assert.equal(await page.locator('.atlas-layer-handle__btn').count(), 2);
    await tapBtn('Maximize map');
    await to('map');
    assert.equal(await page.locator('.atlas-layer-handle__btn').count(), 1);
    await tapBtn('Restore map and list');
    await to('mapList');
    await tapBtn('Maximize list');
    await to('list');
    await page.waitForTimeout(300);
    assert.equal(await state(), 'list');

    await btn('Restore map and list').focus();
    await page.keyboard.press('Enter');
    await to('mapList');
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
