import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

describe('Atlas layer list', () => {
  let browser: Browser | undefined;
  let page: Page;
  let cookie = '';

  const api = (path: string, body: unknown) =>
    fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
      body: JSON.stringify(body),
    });

  const setState = (state: string) => page.evaluate((s) => document.body.setAttribute('data-atlas-layer', s), state);
  const titles = () => page.evaluate(() =>
    [...document.querySelectorAll('#grid-mount .post-card-title')].map((e) => e.textContent?.trim() ?? ''));
  before(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await page.addInitScript(() => localStorage.removeItem('atlasLayerState'));
    const setup = await api('/api/setup', { name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' });
    if (!setup.ok) throw new Error('Setup failed: ' + setup.status);
    const login = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!login.ok) throw new Error('Login failed: ' + login.status);
    cookie = ((login.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';
    for (let i = 1; i <= 12; i++) {
      const title = `List probe ${i}`;
      const res = await api('/api/posts', {
        title, slug: `list-probe-${i}`, content: 'Body.', excerpt: 'Card.', status: 'published', tags: [],
      });
      if (!res.ok) throw new Error('Post creation failed: ' + (await res.text()));
    }
  });

  after(async () => {
    await browser?.close();
  });

  it('map+list shows several posts, and the first post survives list → map+list → list', async () => {
    await page.goto(BASE + '/');
    await page.waitForSelector('#grid-mount .post-card');
    await page.waitForTimeout(1200);
    const firstBefore = (await titles())[0];
    assert.ok(firstBefore);

    await setState('mapList');
    await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card').length > 1);
    const strip = await titles();
    assert.ok(strip.length > 1, `map+list shows several posts, got ${strip.length}`);
    assert.equal(strip[0], firstBefore);

    await setState('list');
    await page.waitForTimeout(1200);
    await page.waitForSelector('#grid-mount .post-card');
    assert.equal((await titles())[0], firstBefore);
  });

  it('map+list pages with the paginator, not a sideways scroll', async () => {
    await page.goto(BASE + '/?view=split');
    await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card').length > 1);
    const first = (await titles())[0];
    const pageOf = () => new URL(page.url()).searchParams.get('page');
    assert.ok(!pageOf() || pageOf() === '1');
    // The first fetch uses the list page size; the re-fit trims it to the strip.
    await page.waitForFunction(() => {
      const gm = document.querySelector('#grid-mount')!;
      return gm.scrollWidth <= gm.clientWidth + 1;
    }, null, { timeout: 5000 });
    const next = page.locator('#footer-mount .footer-pagination .page-next');
    assert.ok(await next.isVisible(), 'the paginator shows in the footer');
    assert.equal(await page.locator('#pagination-mount').isVisible(), false);
    await next.click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('page') === '2');
    await page.waitForFunction((f) => document.querySelector('#grid-mount .post-card-title')?.textContent?.trim() !== f, first);
  });

  it('the narrow footer line hides the copyright and folds the actions into the burger', async () => {
    await page.goto(BASE + '/?view=split');
    await page.locator('#footer-mount .footer-pagination .pagination').waitFor();
    assert.equal(await page.locator('.footer-copyright').isVisible(), false, 'copyright hidden at 390px');
    const theme = page.locator('#footer-mount #theme-toggle');
    const burger = page.locator('#footer-slider-btn');
    assert.equal(await theme.isVisible(), false, 'theme toggle folded');
    await burger.click();
    await theme.waitFor({ state: 'visible' });
    const t = (await theme.boundingBox())!;
    const b = (await burger.boundingBox())!;
    assert.ok(t.y + t.height <= b.y, 'the popover is above the burger');
    await page.keyboard.press('Escape');
    await theme.waitFor({ state: 'hidden' });
    await burger.click();
    await theme.waitFor({ state: 'visible' });
    await page.mouse.click(5, 300);
    await theme.waitFor({ state: 'hidden' });
  });

  it('map hides the footer paginator', async () => {
    await page.goto(BASE + '/?view=map');
    await page.locator('#footer-mount .site-footer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.footer-pagination').isVisible(), false);
    assert.equal(await page.locator('.footer-copyright').isVisible(), true);
  });
});
