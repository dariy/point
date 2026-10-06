import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

describe('Atlas layer header', () => {
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

  async function swipe(x: number, y: number, dx: number, dy: number) {
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number, py: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }] });
    await touch('touchStart', x, y);
    for (let i = 1; i <= 6; i++) await touch('touchMove', x + (dx * i) / 6, y + (dy * i) / 6);
    await touch('touchEnd', x + dx, y + dy);
  }

  const headerBox = () => page.locator('#header-mount').boundingBox();

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
      title: 'Atlas header probe', slug: 'atlas-header-probe', content: 'Body.', excerpt: 'Card.',
      status: 'published', tags: ['atlas-header'],
    });
    if (!post.ok && post.status !== 409) throw new Error('Post creation failed: ' + (await post.text()));
  });

  after(async () => {
    await browser?.close();
  });

  it('the header does not move during a swipe in mapList', async () => {
    await page.goto(BASE + '/tags/atlas-header?atlas=list-map');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.atlas-layer-map')!).transform === 'none');
    const before = await headerBox();
    const h = (await page.locator('.atlas-layer-handle').boundingBox())!;
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    // Swipe in two halves and read the header between them.
    await swipe(x, y, 0, 10);
    assert.deepEqual(await headerBox(), before);
    await swipe(x, y, 0, -10);
    assert.deepEqual(await headerBox(), before);
    assert.equal(await page.evaluate(() => document.body.dataset.atlasLayer), 'mapList');
  });

  it('a state change keeps an overlay the user opened in the header', async () => {
    await page.goto(BASE + '/tags/atlas-header');
    await page.locator('.atlas-layer-handle').waitFor();
    // Mark the header element; a relayout or reset would not remove it, a rebuild would.
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'probe-overlay';
      document.querySelector('#header-mount')!.appendChild(el);
      document.body.setAttribute('data-atlas-layer', 'mapList');
    });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#probe-overlay').count(), 1);
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'list'));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#probe-overlay').count(), 1);
  });
});
