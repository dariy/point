import { describe, it, before, beforeEach, after } from 'node:test';
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
    // Year tags exist before any page asks for the timeline.
    for (const y of ['2025', '2026']) {
      const tag = await api('/api/tags', { name: y, slug: y, kind: 'year' });
      if (!tag.ok && tag.status !== 409) throw new Error('Tag creation failed: ' + (await tag.text()));
      const post = await api('/api/posts', {
        title: 'Year probe ' + y, slug: 'year-probe-' + y, content: 'Body.', excerpt: 'Card.',
        status: 'published', published_at: y + '-06-01T12:00:00Z', tags: [y],
      });
      if (!post.ok && post.status !== 409) throw new Error('Post creation failed: ' + (await post.text()));
    }
  });

  beforeEach(async () => {
    // The view mode is saved between loads: start each test with nothing saved.
    if (page.url().startsWith('http')) await page.evaluate(() => localStorage.clear());
  });

  after(async () => {
    await browser?.close();
  });

  it('a state change rewrites the query and adds no history entry', async () => {
    await page.goto(BASE + '/');
    await page.locator('.atlas-layer-handle').waitFor();
    const before = await page.evaluate(() => history.length);
    await setState('mapList');
    await page.waitForFunction(() => location.search.includes('view=split'));
    await setState('map');
    await page.waitForFunction(() => location.search.includes('view=map'));
    await setState('list');
    await page.waitForFunction(() => location.search.includes('view=list'));
    assert.equal(await page.evaluate(() => history.length), before);
  });

  it('/map redirects to the home list in the map state and keeps old parameters', async () => {
    await page.goto(BASE + '/map?timeline=2019-2020');
    await page.waitForFunction(() => location.pathname === '/');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    const params = new URLSearchParams(await search());
    assert.equal(params.get('view'), 'map');
    assert.equal(params.get('timeline'), '2019-2020');
  });

  for (const [name, value] of [['mapList', 'split'], ['map', 'map']] as const) {
    it(`a reload keeps ${name}`, async () => {
      await page.goto(BASE + `/tags/atlas-url?view=${value}`);
      await page.waitForFunction((n) => document.body.dataset.atlasLayer === n, name);
      await page.reload();
      await page.waitForFunction((n) => document.body.dataset.atlasLayer === n, name);
      assert.equal(await state(), name);
    });
  }

  it('closing a post opened from mapList returns to the same state', async () => {
    await page.goto(BASE + '/tags/atlas-url?view=split');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    await page.locator('#grid-mount .post-card').first().click();
    await page.waitForFunction(() => location.search.includes('slug=') || location.pathname.startsWith('/posts/'));
    await page.goBack();
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    assert.match(await search(), /view=split/);
  });

  const cards = () => page.locator('#grid-mount .post-card').count();

  it('an old place link opens the geo-tag page and keeps the view', async () => {
    await page.goto(BASE + '/?place=urlton&view=split');
    await page.waitForFunction(() => location.pathname === '/tags/urlton');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card').length === 1);
    assert.match(await search(), /view=split/);
    assert.ok(!/place=/.test(await search()));
  });

  it('a deep link with a timeline range keeps the range after a reload', async () => {
    await page.goto(BASE + '/?timeline=2000-2100&view=map');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    const params = new URLSearchParams(await search());
    assert.equal(params.get('timeline'), '2000-2100');
    assert.equal(params.get('view'), 'map');
  });

  it('invalid filter values are ignored without an error', async () => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const q of ['?timeline=abc-def', '?timeline=2020-2010', '?timeline=1-2-3', '?view=bogus&at=x,y,z']) {
      await page.goto(BASE + '/' + q);
      await page.locator('.atlas-layer-handle').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card').length > 0);
      assert.equal(await state(), 'list', q);
    }
    assert.deepEqual(errors, []);
  });

  it('a tag link in map only keeps map only, without a reload', async () => {
    await page.goto(BASE + '/?view=map');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    await page.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true; });
    // Same-page tag link: put one in the header, as a breadcrumb or quick link is.
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.id = 'e2e-tag-link';
      a.href = '/tags/atlas-url';
      a.textContent = 'atlas-url';
      document.querySelector('#header-mount')!.append(a);
    });
    await page.locator('#e2e-tag-link').click({ force: true });
    await page.waitForFunction(() => location.pathname === '/tags/atlas-url');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    assert.match(await search(), /view=map/);
    assert.equal(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept), true);
    assert.match(await page.locator('#header-mount').innerText(), /atlas-url/i);
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
  });

  it('the saved view mode opens when the URL names none; the URL wins; a bad value is ignored', async () => {
    await page.goto(BASE + '/');
    await page.locator('.atlas-layer-handle').waitFor();
    await setState('map');
    await page.waitForFunction(() => localStorage.getItem('atlasLayerState') === 'map');
    await page.goto(BASE + '/');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
    assert.match(await search(), /view=map/);
    await page.goto(BASE + '/?view=split');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    await page.goto(BASE + '/?view=bogus');
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'map');
  });

  it('a year pill on a year tag page opens that year without a reload, and Back restores it', async () => {
    await page.goto(BASE + '/tags/2025?view=list');
    await page.locator('.timeline-pill-btn[data-year="2026"]').waitFor();
    await page.evaluate(() => { (window as unknown as { __kept?: boolean }).__kept = true; });
    await page.locator('.timeline-pill-btn[data-year="2026"]').click();
    await page.waitForFunction(() => location.pathname === '/tags/2026');
    await page.waitForFunction(() => document.querySelector('.timeline-pill-btn.is-active')?.textContent === '2026');
    assert.match(await page.locator('#header-mount').innerText(), /2026/);
    await page.waitForFunction(() => document.querySelector('#grid-mount .post-card')?.textContent?.includes('Year probe 2026'));
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/tags/2025');
    await page.waitForFunction(() => document.querySelector('.timeline-pill-btn.is-active')?.textContent === '2025');
    await page.waitForFunction(() => document.querySelector('#grid-mount .post-card')?.textContent?.includes('Year probe 2025'));
    assert.equal(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept), true);
  });

  it('a double click toggles the timeline; a year-tag page collapses to home', async () => {
    await page.goto(BASE + '/?view=list');
    const all = page.locator('.timeline-pill-btn[data-action="expand"]');
    await all.waitFor();
    await all.click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.timeline-container.is-collapsed').count(), 1, 'one tap does not expand');
    await all.dblclick();
    await page.locator('.timeline-container.is-expanded').waitFor();
    assert.equal(await page.locator('.timeline-pill-btn.is-active').count(), 1);
    await page.locator('.timeline-container').dblclick();
    await page.locator('.timeline-container.is-collapsed').waitFor();

    await page.goto(BASE + '/tags/2025?view=list');
    await page.locator('.timeline-pill-btn.is-active[data-year="2025"]').waitFor();
    await page.locator('.timeline-pill-btn.is-active').dblclick();
    await page.waitForFunction(() => location.pathname !== '/tags/2025');
    await page.locator('.timeline-container.is-collapsed').waitFor();
  });
});
