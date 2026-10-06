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
    });

    beforeEach(async () => {
      await dpage.goto(BASE + '/tags/atlas-gesture');
      await dpage.locator('.atlas-layer-handle').waitFor();
    });

    it('a mouse drag on the handle steps the state', async () => {
      let b = await settledBox(dpage, '.atlas-layer-handle');
      await dpage.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await dpage.mouse.down();
      await dpage.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 80, { steps: 6 });
      await dpage.mouse.up();
      await waitState('mapList');
      b = await settledBox(dpage, '.atlas-layer-handle');
      await dpage.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await dpage.mouse.down();
      await dpage.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 80, { steps: 6 });
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
