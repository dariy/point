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

  const api = (path: string, body: unknown, method = 'POST') =>
    fetch(BASE + path, {
      method,
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
    const vis = await api('/api/settings', { tags_visibility: 'all' }, 'PUT');
    if (!vis.ok) throw new Error('Settings failed: ' + vis.status);
    const place = await api('/api/tags', { name: 'Urlton', slug: 'urlton', kind: 'place', latitude: 40.7, longitude: -74 });
    if (!place.ok && place.status !== 409) throw new Error('Tag creation failed: ' + (await place.text()));
    const placed = await api('/api/posts', {
      title: 'Atlas url place', slug: 'atlas-url-place', content: 'Body.', excerpt: 'Card.',
      status: 'published', tags: ['urlton'],
    });
    if (!placed.ok && placed.status !== 409) throw new Error('Post creation failed: ' + (await placed.text()));
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

  const cards = () => page.locator('#grid-mount .post-card').count();

  it('a deep link with place and atlas restores the filter and the map selection', async () => {
    await page.goto(BASE + '/?place=urlton&atlas=list-map');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    await page.locator('.atlas-filter-chip').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card').length === 1);
    await page.locator('.atlas-layer-map .atlas-marker').first().waitFor();
    await page.waitForFunction(() => /[?&]place=urlton/.test(location.search) && /atlas=list-map/.test(location.search));
    await page.reload();
    await page.locator('.atlas-filter-chip').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card').length === 1);
    assert.equal(await cards(), 1);
    assert.match(await search(), /atlas=list-map/);
  });

  it('a deep link with a timeline range keeps the range after a reload', async () => {
    await page.goto(BASE + '/?timeline=2000-2100&atlas=map');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    const params = new URLSearchParams(await search());
    assert.equal(params.get('timeline'), '2000-2100');
    assert.equal(params.get('atlas'), 'map');
  });

  it('invalid filter values are ignored without an error', async () => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const q of ['?place=no-such-place-xyz', '?timeline=abc-def', '?timeline=2020-2010', '?timeline=1-2-3', '?atlas=bogus&view=x,y,z']) {
      await page.goto(BASE + '/' + q);
      await page.locator('.atlas-layer-handle').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card').length > 0);
      assert.equal(await state(), 'list', q);
      assert.equal(await page.locator('.atlas-filter-chip').count(), 0, q);
    }
    assert.deepEqual(errors, []);
  });
});
