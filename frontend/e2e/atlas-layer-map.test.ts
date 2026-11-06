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

  it('keeps the viewport at zoom 2 on mapList → list → mapList', async () => {
    // A view near the north edge: the `mapList` box can hold it at zoom 2, the
    // taller `list` box cannot. At zoom 2 the world is 1024 px tall. On the
    // phone the boxes are about 500 and 780 px, so lat 55 fits only the first.
    // On the iPad the `mapList` box is 795 px (it holds lat 37.3 at most) and
    // the `list` box (1121 px) is taller than the world. Lat 55 is clamped
    // there before the first hide, so the iPad starts at lat 30.
    const lat = onIpad ? 30 : 55;
    await page.goto(BASE + `/?view=split&at=${lat},30,2`);
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

  // A tap on the post's sheet widget opens the full map at the place, with its
  // cloud, and the post's chip has the focus (p-atlas-ocean-o6wyh.12).
  describe('sheet widget', () => {
    before(async () => {
      const on = await api('/api/plugins/immersive-sheet', { enabled: true }, 'PATCH');
      assert.ok(on.ok, 'immersive-sheet on: ' + on.status);
    });
    after(async () => {
      await api('/api/plugins/immersive-sheet', { enabled: false }, 'PATCH');
    });

    it('opens the cloud of the place on a tap on the widget, with the focus on the post chip', async () => {
      const viewport = page.viewportSize();
      // The header shows the immersive toggle at a tablet width.
      const size = { width: 820, height: 1180 };
      try {
        await page.setViewportSize(size);
        await page.goto(BASE + '/posts/map-probe-two');
        await page.locator('.immersive-toggle-btn').first().click();
        await page.locator('.immersive-sheet-hint').click();
        await page.locator('.immersive-sheet-map').waitFor();
        await page.locator('.atlas-layer-map .atlas-marker').first().waitFor();
        await page.waitForTimeout(800);
        // A tap in the slot, away from the marker.
        const slot = (await page.locator('.immersive-sheet-map').boundingBox())!;
        const x = slot.x + slot.width / 2 + 30;
        const y = slot.y + slot.height / 2 + 20;
        // A resize during the tween, as the iOS toolbar does (p-atlas-ocean-o6wyh.12).
        const resize = page.waitForTimeout(150).then(() => page.setViewportSize({ width: size.width, height: size.height - 30 }));
        if (onIpad) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        await resize;
        await page.waitForURL(/\/tags\/mapton\?/);
        await page.locator('.atlas-layer-map .atlas-node--center').waitFor({ timeout: 5000 });
        assert.match(await page.locator('.atlas-layer-map .atlas-node--center').innerText(), /Mapton/);
        await page.waitForTimeout(800);
        const state = await page.evaluate(() => ({
          presentation: document.querySelector<HTMLElement>('body > .atlas-layer-map')!.dataset.atlasOcean,
          nodes: document.querySelectorAll('.atlas-layer-map .atlas-node').length,
          focus: document.querySelector('.atlas-layer-map .atlas-node--post.atlas-node--sel')?.textContent ?? null,
        }));
        assert.equal(state.presentation, 'full', JSON.stringify(state));
        assert.ok(state.nodes >= 2, 'the place and its post are chips: ' + JSON.stringify(state));
        assert.match(state.focus ?? '', /Map probe two/, 'the post chip has the focus: ' + JSON.stringify(state));
      } finally {
        if (viewport) await page.setViewportSize(viewport);
      }
    });
  });

  // The slot is a keyboard control: Tab to it, Enter opens the full map
  // (p-atlas-ocean-o6wyh.19). The ocean above it is aria-hidden in window mode.
  describe('sheet widget keyboard', () => {
    before(async () => {
      const on = await api('/api/plugins/immersive-sheet', { enabled: true }, 'PATCH');
      assert.ok(on.ok, 'immersive-sheet on: ' + on.status);
    });
    after(async () => {
      await api('/api/plugins/immersive-sheet', { enabled: false }, 'PATCH');
    });

    it('opens the full map on Enter on the focused slot', async () => {
      const viewport = page.viewportSize();
      try {
        await page.setViewportSize({ width: 820, height: 1180 });
        await page.goto(BASE + '/posts/map-probe-two');
        await page.locator('.immersive-toggle-btn').first().click();
        await page.locator('.immersive-sheet-hint').click();
        const slot = page.locator('.immersive-sheet-map');
        await slot.waitFor();
        await page.waitForFunction(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')?.dataset.atlasOcean === 'window');
        assert.equal(await slot.getAttribute('role'), 'button');
        assert.equal(await slot.getAttribute('aria-label'), 'Open on the map: Mapton');
        assert.equal(await page.locator('body > .atlas-layer-map').getAttribute('aria-hidden'), 'true', 'one name for a screen reader');
        // Tab from the control before the slot in the sheet.
        await page.locator('.immersive-sheet-grip').focus();
        let focused = false;
        for (let i = 0; i < 20 && !focused; i++) {
          await page.keyboard.press('Tab');
          focused = await slot.evaluate((el) => el === document.activeElement);
        }
        assert.ok(focused, 'Tab reaches the slot');
        const ring = await slot.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { style: cs.outlineStyle, offset: parseFloat(cs.outlineOffset) };
        });
        assert.equal(ring.style, 'solid', 'a focus ring: ' + JSON.stringify(ring));
        assert.ok(ring.offset > 0, 'the ring is outside the clip: ' + JSON.stringify(ring));
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/tags\/mapton\?/);
        assert.equal(new URL(page.url()).searchParams.get('view'), 'map', page.url());
        await page.waitForFunction(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')?.dataset.atlasOcean === 'full');
        assert.equal(await page.locator('body > .atlas-layer-map').getAttribute('aria-hidden'), null, 'the full map is not hidden');
      } finally {
        if (viewport) await page.setViewportSize(viewport);
      }
    });
  });

  // The widget shows an expand hint in its top-right corner, above the map.
  // A tap on the hint opens the full map, as a tap on the widget does
  // (p-atlas-ocean-o6wyh.20).
  describe('sheet widget expand hint', () => {
    before(async () => {
      const on = await api('/api/plugins/immersive-sheet', { enabled: true }, 'PATCH');
      assert.ok(on.ok, 'immersive-sheet on: ' + on.status);
    });
    after(async () => {
      await api('/api/plugins/immersive-sheet', { enabled: false }, 'PATCH');
    });

    it('shows the hint on the slot corner; a tap on it opens the full map; it comes back on Back', async () => {
      const viewport = page.viewportSize();
      try {
        await page.setViewportSize({ width: 820, height: 1180 });
        await page.goto(BASE + '/posts/map-probe-two');
        await page.locator('.immersive-toggle-btn').first().click();
        await page.locator('.immersive-sheet-hint').click();
        const slot = page.locator('.immersive-sheet-map');
        await slot.waitFor();
        const hint = page.locator('body > .atlas-layer-map > .atlas-window-hint');
        await page.waitForFunction(() => {
          const el = document.querySelector('body > .atlas-layer-map > .atlas-window-hint');
          return !!el && getComputedStyle(el).opacity === '1';
        });
        // The sheet slides in: read both boxes in one frame, once the slot stops.
        const corner = await page.waitForFunction(() => {
          const s = document.querySelector('.immersive-sheet-map')!.getBoundingClientRect();
          const h = document.querySelector('body > .atlas-layer-map > .atlas-window-hint')!.getBoundingClientRect();
          const w = window as unknown as { __slotY?: number };
          const still = w.__slotY === s.top;
          w.__slotY = s.top;
          return still && { right: s.right - h.right, top: h.top - s.top, width: h.width };
        }, undefined, { polling: 100 }).then((h) => h.jsonValue() as Promise<{ right: number; top: number; width: number }>);
        assert.equal(Math.round(corner.width), 24, 'a 24 px hint');
        assert.ok(Math.abs(corner.right - 8) <= 1, `8 px from the right: ${JSON.stringify(corner)}`);
        assert.ok(Math.abs(corner.top - 8) <= 1, `8 px from the top: ${JSON.stringify(corner)}`);
        const hintBox = (await hint.boundingBox())!;
        assert.equal(await hint.evaluate((el) => getComputedStyle(el).pointerEvents), 'none', 'the hint takes no taps');
        // The hint is the top element at its centre: above the map panes.
        const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.atlas-window-hint') != null,
          { x: hintBox.x + hintBox.width / 2, y: hintBox.y + hintBox.height / 2 });
        assert.equal(top, false, 'pointer-events none: the hit goes through to the map');
        await page.mouse.click(hintBox.x + hintBox.width / 2, hintBox.y + hintBox.height / 2);
        await page.waitForURL(/\/tags\/mapton\?/);
        await page.waitForFunction(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')?.dataset.atlasOcean === 'full');
        assert.equal(await hint.evaluate((el) => getComputedStyle(el).visibility), 'hidden', 'no hint on the full map');
        await page.goBack();
        await page.waitForFunction(() => {
          const el = document.querySelector<HTMLElement>('body > .atlas-layer-map');
          return el?.dataset.atlasOcean === 'window' && el.dataset.atlasWindowHint === 'on';
        });
      } finally {
        if (viewport) await page.setViewportSize(viewport);
      }
    });
  });

  // The widget shows the place's cloud with one ring, inside the slot. A
  // return from the full map closes the tag page cloud, then opens the
  // widget cloud again (p-atlas-ocean-o6wyh.14).
  describe('sheet widget cloud', () => {
    before(async () => {
      const on = await api('/api/plugins/immersive-sheet', { enabled: true }, 'PATCH');
      assert.ok(on.ok, 'immersive-sheet on: ' + on.status);
    });
    after(async () => {
      await api('/api/plugins/immersive-sheet', { enabled: false }, 'PATCH');
    });

    const widgetCloud = async () => {
      // The cloud can open again on a return: wait for the place chip first.
      await page.waitForFunction(() => /Mapton/.test(document.querySelector('.atlas-layer-map .atlas-node--center')?.textContent ?? ''), null, { timeout: 5000 });
      await page.waitForTimeout(300);
      return cloudNow();
    };
    const cloudNow = () => page.evaluate(() => {
      const slot = document.querySelector('.immersive-sheet-map')!.getBoundingClientRect();
      const chips = [...document.querySelectorAll('.atlas-layer-map .atlas-node')].map((el) => el.getBoundingClientRect());
      return {
        slot: { w: Math.round(slot.width), h: Math.round(slot.height) },
        nodes: chips.length,
        center: document.querySelector('.atlas-layer-map .atlas-node--center')?.textContent ?? null,
        outside: chips.filter((r) => r.left < slot.left - 1 || r.top < slot.top - 1 || r.right > slot.right + 1 || r.bottom > slot.bottom + 1).length,
      };
    });

    it('shows the place cloud with one ring in the slot, and again after a return', async () => {
      const viewport = page.viewportSize();
      const size = { width: 820, height: 1180 };
      try {
        await page.setViewportSize(size);
        await page.goto(BASE + '/posts/map-probe-two');
        await page.locator('.immersive-toggle-btn').first().click();
        await page.locator('.immersive-sheet-hint').click();
        await page.locator('.immersive-sheet-map').waitFor();
        await page.locator('.atlas-layer-map .atlas-node--center').waitFor({ timeout: 5000 });
        await page.waitForTimeout(500);
        const first = await widgetCloud();
        assert.equal(first.slot.w, first.slot.h, 'a square slot: ' + JSON.stringify(first));
        assert.equal(first.slot.w, 288, 'at 18rem: ' + JSON.stringify(first));
        assert.match(first.center ?? '', /Mapton/);
        // The centre and one ring (4 chips at most at the first radius).
        assert.ok(first.nodes >= 2 && first.nodes <= 5, JSON.stringify(first));
        assert.equal(first.outside, 0, 'no chip is cut by the slot edge: ' + JSON.stringify(first));

        const slot = (await page.locator('.immersive-sheet-map').boundingBox())!;
        if (onIpad) await page.touchscreen.tap(slot.x + 10, slot.y + slot.height - 10);
        else await page.mouse.click(slot.x + 10, slot.y + slot.height - 10);
        await page.waitForURL(/\/tags\/mapton\?/);
        await page.waitForFunction(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')?.dataset.atlasOcean === 'full');
        await page.locator('.atlas-layer-map .atlas-node--post.atlas-node--sel').waitFor({ timeout: 5000 });

        await page.goBack();
        await page.waitForURL(/\/posts\/map-probe-two/);
        await page.waitForFunction(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')?.dataset.atlasOcean === 'window');
        await page.waitForTimeout(800);
        const back = await widgetCloud();
        assert.match(back.center ?? '', /Mapton/);
        assert.ok(back.nodes >= 2 && back.nodes <= 5, 'the widget cloud, not the tag page cloud: ' + JSON.stringify(back));
        assert.equal(back.outside, 0, JSON.stringify(back));
      } finally {
        if (viewport) await page.setViewportSize(viewport);
      }
    });
  });

  // A rotation (landscape ↔ portrait) on an iPad: the map follows its box
  // (p-atlas-ocean-o6wyh.11). Each test starts in portrait and turns twice.
  describe('rotation', () => {
    const PORTRAIT = { width: 820, height: 1180 };
    const LANDSCAPE = { width: 1180, height: 820 };
    let viewport: { width: number; height: number } | null = null;
    before(() => { viewport = page.viewportSize(); });
    after(async () => { if (viewport) await page.setViewportSize(viewport); });

    /** The map box, the viewport widths and the Mapton marker centre. */
    const measure = () => page.evaluate(() => {
      const c = document.querySelector<HTMLElement>('body > .atlas-layer-map')!;
      const box = c.getBoundingClientRect();
      const m = document.querySelector('.atlas-layer-map .atlas-marker')!.getBoundingClientRect();
      return {
        inner: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
        box: { left: box.left, top: box.top, width: box.width, height: box.height },
        marker: { x: m.left + m.width / 2, y: m.top + m.height / 2 },
        at: (new URLSearchParams(location.search).get('at') ?? '').split(',').map(Number),
        side: document.body.hasAttribute('data-atlas-side'),
      };
    });

    const turn = async (size: { width: number; height: number }) => {
      await page.setViewportSize(size);
      await page.waitForTimeout(700);
    };

    for (const [state, presentation] of [['mapList', 'mapList'], ['map', 'full']] as const) {
      it(`keeps the width and the centre of the map in ${state}`, async () => {
        await page.setViewportSize(PORTRAIT);
        await page.goto(BASE + '/tags/atlas-map-set');
        await page.locator('#grid-mount .post-card').first().waitFor();
        await page.evaluate((st) => document.body.setAttribute('data-atlas-layer', st), state);
        await page.locator('.atlas-layer-map .atlas-marker').first().waitFor();
        await page.waitForTimeout(700);
        assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')!.dataset.atlasOcean), presentation);
        const start = await measure();
        const fromCentre = (s: typeof start) => ({
          x: s.marker.x - (s.box.left + s.box.width / 2), y: s.marker.y - (s.box.top + s.box.height / 2),
        });
        for (const size of [LANDSCAPE, PORTRAIT]) {
          await turn(size);
          const now = await measure();
          const label = `${state} at ${size.width}x${size.height}: ${JSON.stringify(now)}`;
          assert.equal(now.inner, size.width, label);
          assert.equal(now.client, size.width, 'no wide layout viewport: ' + label);
          assert.equal(now.scroll, size.width, 'nothing is wider than the viewport: ' + label);
          // Touch in landscape (the iPad) puts mapList on the side: a square map, a 20rem column.
          const sideMap = state === 'mapList' && now.side;
          assert.equal(now.side, onIpad && size.width > size.height, 'the side layout is for touch in landscape: ' + label);
          const width = sideMap ? Math.min(size.height, size.width - 320) : size.width;
          assert.equal(Math.round(now.box.width), width, 'the map width: ' + label);
          const a = fromCentre(start);
          const b = fromCentre(now);
          assert.ok(Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2, 'the map keeps its centre: ' + label);
          // Two px of the Web Mercator world at this zoom (a resize pan rounds to whole px).
          const tol = (2 * 360) / (256 * 2 ** start.at[2]!);
          assert.equal(now.at[2], start.at[2], 'same zoom: ' + label);
          assert.ok(Math.abs(now.at[0]! - start.at[0]!) < tol && Math.abs(now.at[1]! - start.at[1]!) < tol, `the URL view stays: ${start.at.join(',')} → ${label}`);
        }
      });
    }

    it('keeps the place at the centre of the sheet widget', async () => {
      const on = await api('/api/plugins/immersive-sheet', { enabled: true }, 'PATCH');
      assert.ok(on.ok, 'immersive-sheet on: ' + on.status);
      try {
        await page.setViewportSize(PORTRAIT);
        await page.goto(BASE + '/posts/map-probe-two');
        await page.locator('.immersive-toggle-btn').first().click();
        await page.locator('.immersive-sheet-hint').click();
        await page.locator('.immersive-sheet-map').waitFor();
        await page.locator('.atlas-layer-map .atlas-marker').first().waitFor();
        await page.waitForTimeout(800);
        const widget = () => page.evaluate(() => {
          const c = document.querySelector<HTMLElement>('body > .atlas-layer-map')!;
          const box = c.getBoundingClientRect();
          const slot = document.querySelector('.immersive-sheet-map')!.getBoundingClientRect();
          const scroller = document.querySelector('.immersive-sheet-scroll')!.getBoundingClientRect();
          const m = document.querySelector('.atlas-layer-map .atlas-marker')!.getBoundingClientRect();
          // inset(top right bottom left), with the short forms of CSS.
          const v = (c.style.clipPath.match(/inset\(([^)]*)\)/)?.[1] ?? '').split(/\s+/).map(parseFloat);
          const [t, r = t, b = t, l = r] = v;
          const top = Math.max(slot.top, scroller.top);
          const bottom = Math.min(slot.bottom, scroller.bottom);
          return {
            presentation: c.dataset.atlasOcean,
            clip: { top: t, right: r, bottom: b, left: l },
            want: { top: top - box.top, right: box.right - slot.right, bottom: box.bottom - bottom, left: slot.left - box.left },
            marker: { x: m.left + m.width / 2, y: m.top + m.height / 2 },
            centre: { x: slot.left + slot.width / 2, y: slot.top + slot.height / 2 },
          };
        });
        const check = (w: Awaited<ReturnType<typeof widget>>, label: string) => {
          const text = `${label}: ${JSON.stringify(w)}`;
          assert.equal(w.presentation, 'window', text);
          for (const k of ['top', 'right', 'bottom', 'left'] as const) {
            assert.ok(Math.abs(w.clip[k]! - w.want[k]) <= 1, `the clip is the slot (${k}): ${text}`);
          }
          assert.ok(Math.abs(w.marker.x - w.centre.x) <= 2 && Math.abs(w.marker.y - w.centre.y) <= 2,
            'the place is at the slot centre: ' + text);
        };
        // WebKit can deliver the resize late under load: wait up to 3 s for the window to settle.
        const settled = async (label: string) => {
          const end = Date.now() + 3000;
          for (;;) {
            const w = await widget();
            try {
              check(w, label);
              return;
            } catch (e) {
              if (Date.now() > end) throw e;
              await page.waitForTimeout(100);
            }
          }
        };
        await settled('portrait');
        for (const size of [LANDSCAPE, PORTRAIT]) {
          await turn(size);
          await settled(`${size.width}x${size.height}`);
        }
      } finally {
        await api('/api/plugins/immersive-sheet', { enabled: false }, 'PATCH');
      }
    });
  });

  // Epic decision 13: a place shows its name when the label has space, else the dot only.
  describe('labels', () => {
    // Four places in a column, 0.5° apart: one point at zoom 2, about 45 px apart at zoom 7.
    const column: Array<[string, number, number]> = [['Lbl Alpha', 10, 3], ['Lbl Beta', 10.5, 1], ['Lbl Gamma', 11, 1], ['Lbl Delta', 11.5, 1]];

    before(async () => {
      for (const [name, lat, n] of column) {
        const slug = name.toLowerCase().replace(/ /g, '-');
        const res = await api('/api/tags', { name, slug, kind: 'place', latitude: lat, longitude: 30 });
        if (!res.ok) throw new Error('Tag creation failed: ' + (await res.text()));
        for (let i = 0; i < n; i++) {
          const post = await api('/api/posts', {
            title: `${name} post ${i}`, slug: `${slug}-post-${i}`, content: 'Body.', excerpt: 'Card.', status: 'published', tags: [slug],
          });
          if (!post.ok) throw new Error('Post creation failed: ' + (await post.text()));
        }
      }
    });

    const read = () => page.evaluate(() => {
      const labelled: Record<string, boolean> = {};
      for (const m of document.querySelectorAll<HTMLElement>('.atlas-layer-map .atlas-marker')) {
        labelled[m.getAttribute('aria-label') ?? ''] = m.classList.contains('atlas-marker--labelled');
      }
      const boxes = [...document.querySelectorAll<HTMLElement>(
        '.atlas-layer-map .atlas-marker--labelled .atlas-marker__label, .atlas-layer-map .atlas-marker--labelled .atlas-shape-label__text',
      )].map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      const label = document.querySelector('.atlas-layer-map .atlas-marker__label');
      return { labelled, boxes, pointer: label ? getComputedStyle(label).pointerEvents : '' };
    });

    const noOverlap = (boxes: Awaited<ReturnType<typeof read>>['boxes']) => {
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!, b = boxes[j]!;
          const hit = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          assert.ok(!hit, `labels overlap: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
        }
      }
    };

    // A cluster dot: its count, its label, its mode.
    const cluster = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.atlas-layer-map .atlas-cluster')].map((m) => ({
      size: Number(m.dataset.clusterSize),
      count: m.querySelector('.atlas-cluster__dot')?.textContent ?? '',
      label: m.querySelector('.atlas-marker__label')?.textContent ?? '',
      labelled: m.classList.contains('atlas-marker--labelled'),
      name: m.getAttribute('aria-label') ?? '',
    })));
    const zoomOf = () => page.evaluate(() => Number(new URL(location.href).searchParams.get('at')?.split(',')[2]));

    it('merges the overlapping dots into one cluster at zoom 2, and a zoom in splits it and adds labels', async () => {
      // 800 px is less than the world at zoom 2 (1024 px): maxBounds keeps lng 30 at the centre.
      await page.setViewportSize({ width: 800, height: 600 });
      await page.goto(BASE + '/?view=map&at=10.75,30,2');
      await page.locator('.atlas-layer-map .atlas-cluster[data-cluster-size="4"]').waitFor();
      await page.waitForTimeout(400);
      const far = await read();
      for (const [name] of column) {
        assert.equal(far.labelled[name], undefined, `${name} is inside the cluster: ` + JSON.stringify(far.labelled));
      }
      const [c, ...rest] = await cluster();
      assert.equal(rest.length, 0, 'one cluster');
      assert.equal(c!.count, '4', 'the cluster shows the place count');
      assert.equal(c!.label, 'Lbl Alpha +3', 'the label names the largest place');
      assert.equal(c!.labelled, true, 'the cluster label has space: ' + JSON.stringify(c));
      assert.equal(far.pointer, 'none', 'a label takes no taps');
      assert.ok(far.boxes.some((b) => b.text === 'France'), 'a tagged country shape has a label');
      noOverlap(far.boxes);

      for (let i = 0; i < 5; i++) {
        await page.locator('.atlas-layer-map .leaflet-control-zoom-in').click();
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(300);
      const near = await read();
      for (const [name] of column) {
        assert.equal(near.labelled[name], true, `${name} has a label at zoom 7: ` + JSON.stringify(near.labelled));
      }
      noOverlap(near.boxes);
      assert.deepEqual(await cluster(), [], 'no cluster at zoom 7');
    });

    it('a tap on a cluster fits its places', async () => {
      await page.goto(BASE + '/?view=map&at=10.75,30,2');
      const dot = page.locator('.atlas-layer-map .atlas-cluster .atlas-cluster__dot');
      await dot.waitFor();
      await page.waitForTimeout(400);
      if (onIpad) await dot.tap();
      else await dot.click();
      await page.locator('.atlas-layer-map .atlas-marker[aria-label="Lbl Delta"]').waitFor({ timeout: 5000 });
      await page.waitForTimeout(600);
      assert.deepEqual(await cluster(), [], 'the fit splits the cluster');
      assert.ok((await zoomOf()) >= 7, 'the map zooms in to the places: ' + page.url());
      assert.equal(new URL(page.url()).pathname, '/', 'a cluster tap selects no place');
      const near = await read();
      for (const [name] of column) assert.equal(near.labelled[name], true, `${name} has a label after the fit: ` + JSON.stringify(near.labelled));
    });

    it('the open place is never inside a cluster', async () => {
      await page.goto(BASE + '/tags/lbl-beta?view=map&at=10.75,30,2');
      await page.locator('.atlas-layer-map .atlas-node--center', { hasText: 'Lbl Beta' }).waitFor();
      await page.waitForTimeout(400);
      const beta = page.locator('.atlas-layer-map .atlas-marker[aria-label="Lbl Beta"]');
      assert.equal(await beta.count(), 1, 'the open place keeps its own dot');
      assert.ok(await beta.evaluate((el) => el.classList.contains('atlas-marker--active')), 'its dot is active');
      const groups = await cluster();
      assert.deepEqual(groups.map((g) => g.size), [3], 'the other three places are one cluster: ' + JSON.stringify(groups));
    });

    it('a tap on a labelled dot still selects the place', async () => {
      await page.goto(BASE + '/?view=map&at=10.75,30,7');
      await page.locator('.atlas-layer-map .atlas-marker[aria-label="Lbl Beta"]').waitFor();
      await page.waitForTimeout(400);
      await page.locator('.atlas-layer-map .atlas-marker[aria-label="Lbl Beta"] .atlas-marker__dot').click();
      await page.locator('.atlas-node--center', { hasText: 'Lbl Beta' }).waitFor();
      // The open cloud is taken space: no label is shown below a chip.
      const after = await read();
      const chips = await page.evaluate(() => [...document.querySelectorAll('.atlas-layer-map .atlas-node')].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }));
      for (const b of after.boxes) {
        for (const c of chips) {
          const hit = b.left < c.right && c.left < b.right && b.top < c.bottom && c.top < b.bottom;
          assert.ok(!hit, `a label under a chip: ${JSON.stringify(b)} ${JSON.stringify(c)}`);
        }
      }
    });

    // A fine pointer: a hover shows `<name> · <n> posts` at the label position (child .21).
    it('shows the name and the post count on hover; the peek goes on leave', { skip: onIpad && 'hover needs a fine pointer' }, async () => {
      // At zoom 5 the dots are about 11 px apart: no cluster, but the labels collide.
      await page.goto(BASE + '/?view=map&at=10.75,30,5');
      await page.locator('.atlas-layer-map .atlas-marker[aria-label="Lbl Delta"]').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.atlas-layer-map .atlas-marker[title]').count(), 0, 'no native title');
      const counts: Record<string, number> = { 'Lbl Alpha': 3, 'Lbl Beta': 1, 'Lbl Gamma': 1, 'Lbl Delta': 1 };
      // The marker under the pointer, its mode, and what it shows.
      const under = (x: number, y: number) => page.evaluate(([px, py]) => {
        const m = document.elementFromPoint(px!, py!)?.closest<HTMLElement>('.atlas-marker');
        if (!m) return null;
        const peek = m.querySelector<HTMLElement>('.atlas-marker__peek')!;
        const label = m.querySelector<HTMLElement>('.atlas-marker__label')!;
        const pr = peek.getBoundingClientRect();
        const dr = m.querySelector('.atlas-marker__dot')!.getBoundingClientRect();
        return {
          name: m.getAttribute('aria-label') ?? '',
          labelled: m.classList.contains('atlas-marker--labelled'),
          peek: getComputedStyle(peek).visibility,
          label: getComputedStyle(label).visibility,
          text: peek.textContent,
          right: pr.left >= dr.right && Math.abs((pr.top + pr.bottom) / 2 - (dr.top + dr.bottom) / 2) < 2,
        };
      }, [x, y]);
      const dot = await page.locator('.atlas-layer-map .atlas-marker[aria-label="Lbl Delta"] .atlas-marker__dot').boundingBox();
      assert.ok(dot);
      // Above the top of the stack: a dot-mode place (Delta at zoom 5).
      const x = dot.x + dot.width / 2, y = dot.y + 2;
      await page.mouse.move(x, y);
      const hover = await under(x, y);
      assert.ok(hover, 'a marker under the pointer');
      assert.equal(hover.labelled, false, 'a dot-mode place: ' + JSON.stringify(hover));
      assert.equal(hover.peek, 'visible', 'the peek shows on hover');
      assert.equal(hover.text, `${hover.name} · ${counts[hover.name]} post`);
      assert.ok(hover.right, 'the peek sits right of the dot');

      await page.mouse.move(5, 300);
      const left = await under(x, y);
      assert.equal(left?.peek, 'hidden', 'the peek goes on leave');

      // A labelled place (Alpha, the largest) shows the count on hover.
      const alpha = await page.locator('.atlas-layer-map .atlas-marker[aria-label="Lbl Alpha"] .atlas-marker__dot').boundingBox();
      assert.ok(alpha);
      const ax = alpha.x + alpha.width / 2, ay = alpha.y + alpha.height - 2;
      await page.mouse.move(ax, ay);
      const lab = await under(ax, ay);
      assert.equal(lab?.name, 'Lbl Alpha');
      assert.equal(lab.labelled, true);
      assert.equal(lab.peek, 'visible');
      assert.equal(lab.label, 'hidden', 'the peek replaces the label');
      assert.equal(lab.text, 'Lbl Alpha · 3 posts');
      await page.mouse.move(5, 300);
    });
  });
});
