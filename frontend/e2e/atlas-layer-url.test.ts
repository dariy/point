import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

describe('Atlas layer URL state', () => {
  let browser: Browser | undefined;
  let page: Page;
  let cookie = '';

  const api = (path: string, body: unknown) =>
    fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
      body: JSON.stringify(body),
    });

  const state = () => page.evaluate(() => document.body.dataset.atlasLayer);
  const setState = (s: string) => page.evaluate((v) => document.body.setAttribute('data-atlas-layer', v), s);
  const search = () => page.evaluate(() => location.search);

  before(async () => {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await ctx.newPage();
    const setup = await api('/api/setup', { name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' });
    if (!setup.ok && setup.status !== 409) throw new Error('Setup failed: ' + setup.status);
    const login = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!login.ok) throw new Error('Login failed: ' + login.status);
    cookie = ((login.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';
    const post = await api('/api/posts', {
      title: 'Atlas url probe', slug: 'atlas-url-probe', content: 'Body.', excerpt: 'Card.',
      status: 'published', tags: ['atlas-url'],
    });
    if (!post.ok && post.status !== 409) throw new Error('Post creation failed: ' + (await post.text()));
  });

  after(async () => {
    await browser?.close();
  });

  it('a state change rewrites the query and adds no history entry', async () => {
    await page.goto(BASE + '/');
    await page.locator('.atlas-layer-handle').waitFor();
    const before = await page.evaluate(() => history.length);
    await setState('mapList');
    await page.waitForFunction(() => location.search.includes('atlas=list-map'));
    await setState('map');
    await page.waitForFunction(() => location.search.includes('atlas=map'));
    await setState('list');
    await page.waitForFunction(() => !location.search.includes('atlas'));
    assert.equal(await page.evaluate(() => history.length), before);
  });

  it('/map redirects to the home list in the map state and keeps old parameters', async () => {
    await page.goto(BASE + '/map?timeline=2019-2020');
    await page.waitForFunction(() => location.pathname === '/');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    const params = new URLSearchParams(await search());
    assert.equal(params.get('atlas'), 'map');
    assert.equal(params.get('timeline'), '2019-2020');
  });

  for (const [name, value] of [['mapList', 'list-map'], ['map', 'map']] as const) {
    it(`a reload keeps ${name}`, async () => {
      await page.goto(BASE + `/tags/atlas-url?atlas=${value}`);
      await page.waitForFunction((n) => document.body.dataset.atlasLayer === n, name);
      await page.reload();
      await page.waitForFunction((n) => document.body.dataset.atlasLayer === n, name);
      assert.equal(await state(), name);
    });
  }

  it('closing a post opened from mapList returns to the same state', async () => {
    await page.goto(BASE + '/tags/atlas-url?atlas=list-map');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    await page.locator('#grid-mount .post-card').first().click();
    await page.waitForFunction(() => location.search.includes('slug=') || location.pathname.startsWith('/posts/'));
    await page.goBack();
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    assert.match(await search(), /atlas=list-map/);
  });
});
