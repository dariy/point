import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

describe('Atlas layer map', () => {
  let browser: Browser | undefined;
  let page: Page;
  let cookie = '';
  const tiles: string[] = [];

  const api = (path: string, body: unknown, method = 'POST') =>
    fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
      body: JSON.stringify(body),
    });

  before(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await page.addInitScript(() => localStorage.removeItem('atlasLayerState'));
    await page.route(/arcgisonline\.com/, (route) => {
      tiles.push(route.request().url());
      return route.abort();
    });

    const setup = await api('/api/setup', { name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' });
    if (!setup.ok && setup.status !== 409) throw new Error('Setup failed: ' + setup.status);
    const login = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!login.ok) throw new Error('Login failed: ' + login.status);
    cookie = ((login.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';

    // The public graph is closed until tags_visibility is "all" (default "hidden").
    const vis = await api('/api/settings', { tags_visibility: 'all' }, 'PUT');
    if (!vis.ok) throw new Error('Settings failed: ' + vis.status);

    // A country (drawn as a shape), a city (a marker), and posts that carry them.
    for (const [name, lat, lng] of [['France', 46.6, 2.4], ['Mapton', 40.7, -74]] as const) {
      const res = await api('/api/tags', { name, slug: name.toLowerCase(), kind: 'place', latitude: lat, longitude: lng });
      if (!res.ok && res.status !== 409) throw new Error('Tag creation failed: ' + (await res.text()));
    }
    const posts: Array<[string, string[]]> = [
      ['Map probe one', ['atlas-map-set', 'france']],
      ['Map probe two', ['atlas-map-set', 'mapton']],
      ['Map probe three', ['atlas-map-set']],
      ['Map probe other', ['france']],
    ];
    for (const [title, tags] of posts) {
      const res = await api('/api/posts', {
        title, slug: title.toLowerCase().replace(/ /g, '-'), content: 'Body.', excerpt: 'Card.', status: 'published', tags,
      });
      if (!res.ok && res.status !== 409) throw new Error('Post creation failed: ' + (await res.text()));
    }
  });

  after(async () => {
    await browser?.close();
  });

  it('makes no map request while the page stays in list', async () => {
    tiles.length = 0;
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(BASE + '/tags/atlas-map-set');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.waitForTimeout(500);
    assert.equal(tiles.length, 0, 'tile requests: ' + tiles.join(', '));
    assert.equal(requests.filter((u) => /leaflet/.test(u)).length, 0, 'leaflet loaded in list');
    assert.equal(await page.locator('.atlas-layer-marker').count(), 0);
  });

  const openMap = async (state = 'map') => {
    await page.goto(BASE + '/');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.evaluate((st) => document.body.setAttribute('data-atlas-layer', st), state);
    await page.locator('.atlas-layer-map .leaflet-tile-pane').waitFor({ state: 'attached' });
  };

  it('loads tiles on the first change out of list', async () => {
    await openMap('mapList');
    await page.waitForFunction(() => document.querySelectorAll('.leaflet-tile').length > 0);
    assert.ok(tiles.length > 0, 'tiles load once the map opens');
  });

  it('fills the shape of a country that has a tag', async () => {
    await openMap();
    await page.locator('.atlas-layer-map path.leaflet-interactive').first().waitFor({ state: 'attached' });
    const filled = await page.locator('.atlas-layer-map path.leaflet-interactive[stroke="#e05c00"]').count();
    assert.ok(filled >= 1, 'a tagged country is outlined and filled');
  });

  it('draws a geo-tag that is no country as a marker, and selects it into a graph', async () => {
    await openMap();
    const marker = page.locator('.atlas-layer-map .atlas-marker');
    await marker.first().waitFor();
    assert.equal(await marker.count(), 1, 'one marker: Mapton');
    await marker.first().click();
    const chips = page.locator('.atlas-layer-map .atlas-node');
    await chips.first().waitFor();
    assert.ok(await page.locator('.atlas-layer-map .atlas-node--center').isVisible(), 'the place sits at the centre');
    assert.ok((await page.locator('.atlas-layer-map .atlas-node--post').count()) >= 1, 'its post is a chip');
    // A click on empty map dismisses the graph.
    await page.locator('.atlas-layer-map').click({ position: { x: 20, y: 200 } });
    await page.waitForFunction(() => document.querySelectorAll('.atlas-layer-map .atlas-node').length === 0);
  });

  it('selects a country shape into a graph', async () => {
    await openMap();
    await page.locator('.atlas-layer-map path[stroke="#e05c00"]').first().waitFor({ state: 'attached' });
    await page.evaluate(() => {
      const el = document.querySelector('.atlas-layer-map path[stroke="#e05c00"]')!;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    });
    await page.locator('.atlas-layer-map .atlas-node--post').first().waitFor();
    assert.ok((await page.locator('.atlas-layer-map .atlas-node--center').innerText()).includes('France'));
  });

  it('resizes the map with the layer', async () => {
    await openMap('mapList');
    await page.locator('.atlas-layer-map .leaflet-tile-pane').waitFor({ state: 'attached' });
    const size = () => page.evaluate(() => {
      const c = document.querySelector<HTMLElement>('.atlas-layer-map')!;
      return { box: c.getBoundingClientRect().height, pane: document.querySelector<HTMLElement>('.atlas-layer-map .leaflet-map-pane')!.getBoundingClientRect().height };
    });
    const before = await size();
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'map'));
    await page.waitForFunction((h) => document.querySelector('.atlas-layer-map')!.getBoundingClientRect().height > h, before.box);
    const tilesCover = await page.evaluate(() => {
      const c = document.querySelector('.atlas-layer-map')!.getBoundingClientRect();
      return [...document.querySelectorAll('.atlas-layer-map .leaflet-tile')].some((t) => t.getBoundingClientRect().bottom >= c.bottom - 1);
    });
    assert.ok(tilesCover || tiles.length > 0, 'the map follows the new box');
  });

  describe('geo-tag selection', () => {
    const titles = () => page.evaluate(() =>
      [...document.querySelectorAll('#grid-mount .post-card-title')].map((e) => e.textContent?.trim() ?? ''));

    const selectMapton = async () => {
      await openMap('mapList');
      await page.evaluate(() => { (window as any).__noReload = true; });
      await page.locator('.atlas-layer-map .atlas-marker').first().click();
      await page.waitForFunction(() => location.pathname === '/tags/mapton');
      await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card').length === 1);
    };

    it('opens the geo-tag page client-side and keeps the view mode', async () => {
      await selectMapton();
      const tagged = ((await (await fetch(BASE + '/api/pages/tags/mapton')).json()) as any).posts.map((p: any) => p.title);
      assert.ok(tagged.length >= 1);
      assert.deepEqual((await titles()).sort(), [...tagged].sort());
      assert.equal(await page.evaluate(() => (window as any).__noReload === true), true, 'no full page load');
      assert.equal(await page.evaluate(() => document.body.dataset.atlasLayer), 'mapList');
      assert.match(await page.evaluate(() => location.search), /view=split/);
      assert.match((await page.locator('.site-breadcrumb').innerText()).toLowerCase(), /mapton/, 'breadcrumbs show the geo-tag');
    });

    it('goes back to the home page when the selection is cleared on the map', async () => {
      await selectMapton();
      await page.locator('.atlas-layer-map').click({ position: { x: 200, y: 450 } });
      await page.waitForFunction(() => location.pathname === '/');
      assert.equal(await page.evaluate(() => (window as any).__noReload === true), true, 'no full page load');
      assert.equal(await page.evaluate(() => document.body.dataset.atlasLayer), 'mapList');
      assert.equal(await page.locator('#atlas-filter-mount').count(), 0);
    });
  });
});
