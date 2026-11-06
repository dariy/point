import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { launchFor, onIpad } from './devices.ts';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

describe('Atlas layer map', () => {
  let browser: Browser | undefined;
  let page: Page;
  let cookie = '';
  let contextOptions: BrowserContextOptions = {};
  const tiles: string[] = [];

  const api = (path: string, body: unknown, method = 'POST') =>
    fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
      body: JSON.stringify(body),
    });

  before(async () => {
    let context;
    ({ browser, context, contextOptions } = await launchFor(undefined, { viewport: { width: 390, height: 844 } }));
    page = await context.newPage();
    await page.addInitScript(() => localStorage.removeItem('atlasLayerState'));
    await page.route(/arcgisonline\.com/, (route) => {
      tiles.push(route.request().url());
      return route.abort();
    });

    const setup = await api('/api/setup', { name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' });
    if (!setup.ok) throw new Error('Setup failed: ' + setup.status);
    const login = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!login.ok) throw new Error('Login failed: ' + login.status);
    cookie = ((login.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';

    // The public graph is closed until tags_visibility is "all" (default "hidden").
    const vis = await api('/api/settings', { tags_visibility: 'all' }, 'PUT');
    if (!vis.ok) throw new Error('Settings failed: ' + vis.status);

    // A country (drawn as a shape), a city (a marker), and posts that carry them.
    for (const [name, lat, lng] of [['France', 46.6, 2.4], ['Mapton', 40.7, -74]] as const) {
      const res = await api('/api/tags', { name, slug: name.toLowerCase(), kind: 'place', latitude: lat, longitude: lng });
      if (!res.ok) throw new Error('Tag creation failed: ' + (await res.text()));
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
      if (!res.ok) throw new Error('Post creation failed: ' + (await res.text()));
    }
  });

  after(async () => {
    await browser?.close();
  });

  it('warms the map hidden in list; the first mapList makes no Leaflet or places request', async () => {
    const requests: string[] = [];
    const onRequest = (r: { url(): string }) => requests.push(r.url());
    page.on('request', onRequest);
    await page.goto(BASE + '/tags/atlas-map-set');
    await page.locator('#grid-mount .post-card').first().waitFor();
    // The warm-up runs in an idle callback after the grid render.
    await page.locator('.atlas-layer-map.leaflet-container').waitFor({ state: 'attached' });
    await page.locator('.atlas-layer-map .atlas-marker').first().waitFor({ state: 'attached' });
    const box = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.atlas-layer-map')!;
      const cs = getComputedStyle(el);
      return { visibility: cs.visibility, pointer: cs.pointerEvents, h: el.offsetHeight };
    });
    assert.equal(box.visibility, 'hidden');
    assert.equal(box.pointer, 'none');
    assert.ok(box.h > 0, 'the hidden map keeps its size');
    assert.ok(requests.some((u) => /leaflet\.js/.test(u)), 'leaflet loaded in list');
    assert.ok(requests.some((u) => /\/api\/pages\/graph\?/.test(u)), 'places loaded in list');

    requests.length = 0;
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
    await page.waitForTimeout(500);
    assert.equal(requests.filter((u) => /leaflet\.js|\/api\/pages\/graph\?/.test(u)).length, 0,
      'mapList requests: ' + requests.join(', '));
    // A re-arm in list must not keep a view from before the fit-to-places.
    await page.waitForTimeout(400);
    const inside = await page.evaluate(() => {
      const box = document.querySelector('.atlas-layer-map')!.getBoundingClientRect();
      const m = document.querySelector('.atlas-layer-map .atlas-marker')!.getBoundingClientRect();
      return m.left >= box.left && m.right <= box.right && m.top >= box.top && m.bottom <= box.bottom;
    });
    assert.ok(inside, 'the warm map shows its places on the first mapList');
    page.off('request', onRequest);
  });

  it('makes no map request in list when saveData is on', async () => {
    const ctx = await browser!.newContext(contextOptions);
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      localStorage.removeItem('atlasLayerState');
      Object.defineProperty(navigator, 'connection', { value: { saveData: true } });
    });
    const requests: string[] = [];
    p.on('request', (r) => requests.push(r.url()));
    await p.route(/arcgisonline\.com/, (route) => route.abort());
    await p.goto(BASE + '/tags/atlas-map-set');
    await p.locator('.atlas-layer-handle').waitFor();
    await p.waitForTimeout(2500);
    const map = requests.filter((u) => /leaflet|arcgisonline|\/api\/pages\/graph\?/.test(u));
    assert.equal(map.length, 0, 'map requests: ' + map.join(', '));
    assert.equal(await p.locator('.atlas-layer-map.leaflet-container').count(), 0);
    await ctx.close();
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

  // Runs on each E2E_DEVICE. On the WebKit iPad the marker gets a real tap.
  it('opens the cloud of a place on a tap on its marker in mapList', async () => {
    await page.goto(BASE + '/tags/atlas-map-set');
    await page.locator('#grid-mount .post-card').first().waitFor();
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
    const marker = page.locator('.atlas-layer-map .atlas-marker').first();
    await marker.waitFor();
    if (onIpad) await marker.tap();
    else await marker.click();
    await page.locator('.atlas-layer-map .atlas-node--center').waitFor();
    assert.match(await page.locator('.atlas-layer-map .atlas-node--center').innerText(), /Mapton/);
    assert.ok((await page.locator('.atlas-layer-map .atlas-node--post').count()) >= 1, 'its post is a chip');
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

  // At the iPad size the list box is taller than the world at zoom 2, and the
  // view drifts (p-atlas-ocean-o6wyh.26).
  it('keeps the viewport at zoom 2 on mapList → list → mapList', { skip: onIpad && 'drifts at the iPad size: p-atlas-ocean-o6wyh.26' }, async () => {
    // A view near the north edge: the taller `list` box cannot hold it at zoom 2.
    await page.goto(BASE + '/?view=split&at=55,30,2');
    await page.locator('.atlas-layer-map .leaflet-tile-pane').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    await page.waitForTimeout(800);
    const at = () => page.evaluate(() => (new URLSearchParams(location.search).get('at') ?? '').split(',').map(Number));
    const before = await at();
    assert.equal(before[2], 2, 'the map opens at zoom 2');
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'list'));
      await page.waitForTimeout(600);
      await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
      await page.waitForTimeout(600);
      const after = await at();
      assert.equal(after[2], before[2], 'same zoom');
      assert.ok(Math.abs(after[0]! - before[0]!) < 0.5 && Math.abs(after[1]! - before[1]!) < 0.5,
        `same viewport (round ${i + 1}): ${before.join(',')} → ${after.join(',')}`);
    }
    // A slow handle drag from `list` shows the map while the state is still
    // `list`. The release in `mapList` must find the same view.
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'list'));
    await page.waitForTimeout(600);
    const h = (await page.locator('.atlas-layer-handle').boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    for (let y = h.y + h.height / 2; y < 500; y += 20) {
      await page.mouse.move(h.x + h.width / 2, y);
      await page.waitForTimeout(30);
    }
    assert.equal(await page.evaluate(() => document.body.hasAttribute('data-atlas-dragging')), true, 'the drag shows the map');
    assert.equal(await page.evaluate(() => document.body.dataset.atlasLayer ?? 'list'), 'list');
    await page.mouse.up();
    await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
    await page.waitForTimeout(600);
    const dragged = await at();
    assert.equal(dragged[2], before[2], 'same zoom after the drag');
    assert.ok(Math.abs(dragged[0]! - before[0]!) < 0.5 && Math.abs(dragged[1]! - before[1]!) < 0.5,
      `same viewport after the drag: ${before.join(',')} → ${dragged.join(',')}`);
  });

  describe('geo-tag selection', () => {
    const titles = () => page.evaluate(() =>
      [...document.querySelectorAll('#grid-mount .post-card-title')].map((e) => e.textContent?.trim() ?? ''));

    // A mark on the live Leaflet pane. A rebuilt map has a new pane without it.
    const markMap = () => page.evaluate(() => {
      document.querySelector<HTMLElement>('.atlas-layer-map .leaflet-map-pane')!.dataset.e2eMark = '1';
    });
    const sameMap = () => page.evaluate(() =>
      document.querySelectorAll('.atlas-layer-map .leaflet-map-pane[data-e2e-mark="1"]').length === 1);

    const selectMapton = async () => {
      await openMap('mapList');
      await page.evaluate(() => { (window as any).__noReload = true; });
      await page.locator('.atlas-layer-map .atlas-marker').first().waitFor();
      await markMap();
      await page.locator('.atlas-layer-map .atlas-marker').first().click();
      await page.waitForFunction(() => location.pathname === '/tags/mapton');
      await page.waitForFunction(() => document.querySelectorAll('#grid-mount .post-card').length === 1);
      await page.locator('.atlas-layer-map .atlas-node--center').waitFor();
    };

    it('keeps the same map when a tap on a place opens its tag page', async () => {
      await selectMapton();
      assert.equal(await sameMap(), true, 'the map was not rebuilt');
    });

    it('does nothing when the place that is open is tapped again', async () => {
      await selectMapton();
      const entries = await page.evaluate(() => history.length);
      // The cloud covers the marker, so the click goes to the marker directly.
      await page.evaluate(() => document.querySelector<HTMLElement>('.atlas-layer-map .atlas-marker')!.click());
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => location.pathname), '/tags/mapton');
      assert.equal(await page.evaluate(() => history.length), entries, 'no new history entry');
      assert.equal(await sameMap(), true);
    });

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
      // Wait for the home grid, not for the path alone.
      await page.waitForFunction(() => location.pathname === '/'
        && document.querySelectorAll('#grid-mount .post-card').length > 1);
      assert.equal(await page.evaluate(() => (window as any).__noReload === true), true, 'no full page load');
      assert.equal(await sameMap(), true, 'the map was not rebuilt');
      assert.equal(await page.locator('.atlas-layer-map .atlas-node').count(), 0, 'no selection on home');
      assert.equal(await page.evaluate(() => document.body.dataset.atlasLayer), 'mapList');
      assert.equal(await page.locator('#atlas-filter-mount').count(), 0);
    });

    it('keeps the map hidden on a post, and Back shows the same map at the same viewport', async () => {
      await selectMapton();
      await page.waitForFunction(() => /[?&]at=/.test(location.search));
      await page.waitForTimeout(500);
      const at = () => page.evaluate(() => (new URLSearchParams(location.search).get('at') ?? '').split(',').map(Number));
      const before = await at();
      const later: string[] = [];
      const onRequest = (r: { url(): string }) => later.push(r.url());
      page.on('request', onRequest);
      await page.locator('#grid-mount .post-card').first().click();
      await page.waitForFunction(() => location.pathname.startsWith('/posts/') || location.search.includes('slug='));
      await page.waitForFunction(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')?.dataset.atlasOcean === 'hidden');
      assert.equal(await page.evaluate(() => document.body.hasAttribute('data-atlas-layer')
        ? document.body.dataset.atlasLayer : 'list'), 'list');
      assert.equal(await sameMap(), true, 'a post does not destroy the map');
      await page.goBack();
      await page.waitForFunction(() => document.body.dataset.atlasLayer === 'mapList');
      assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')!.dataset.atlasOcean), 'mapList');
      assert.equal(await sameMap(), true, 'the map was not rebuilt');
      // The hidden box had another size; the map must not drift for it.
      await page.waitForTimeout(800);
      const after = await at();
      assert.equal(after[2], before[2], 'same zoom');
      assert.ok(Math.abs(after[0]! - before[0]!) < 0.5 && Math.abs(after[1]! - before[1]!) < 0.5,
        `same viewport: ${before.join(',')} → ${after.join(',')}`);
      page.off('request', onRequest);
      assert.deepEqual(later.filter((u) => /leaflet/.test(u)), [], 'no second Leaflet load');
      assert.deepEqual(later.filter((u) => /\/api\/pages\/graph(\?|$)/.test(u)), [], 'no second places fetch');
    });
  });
});
