import { describe, it, before, after } from 'node:test';
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

  const center = async (sel: string) => {
    const b = (await page.locator(sel).boundingBox())!;
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
});
