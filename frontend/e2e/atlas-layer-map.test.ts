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
    await page.route(/arcgisonline\.com/, (route) => {
      tiles.push(route.request().url());
      return route.abort();
    });

    const setup = await api('/api/setup', { name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' });
    if (!setup.ok && setup.status !== 409) throw new Error('Setup failed: ' + setup.status);
    const login = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!login.ok) throw new Error('Login failed: ' + login.status);
    cookie = ((login.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';

    // Two places, and three posts on the tag under test: two geotagged, one not.
    for (const [name, lat, lng] of [['Mapville', 48.85, 2.35], ['Mapton', 40.7, -74]] as const) {
      const res = await api('/api/tags', { name, slug: name.toLowerCase(), kind: 'place', latitude: lat, longitude: lng });
      if (!res.ok && res.status !== 409) throw new Error('Tag creation failed: ' + (await res.text()));
    }
    const posts: Array<[string, string[]]> = [
      ['Map probe one', ['atlas-map-set', 'mapville']],
      ['Map probe two', ['atlas-map-set', 'mapton']],
      ['Map probe three', ['atlas-map-set']],
      ['Map probe other', ['mapville']],
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

  it('shows one marker per geotagged post of the tag, and loads tiles on the first change', async () => {
    await page.goto(BASE + '/tags/atlas-map-set');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'mapList'));
    await page.locator('.atlas-layer-marker').first().waitFor();
    assert.equal(await page.locator('.atlas-layer-marker').count(), 2);
    await page.waitForFunction(() => document.querySelectorAll('.leaflet-tile').length > 0);
    assert.ok(tiles.length > 0, 'tiles load once the map opens');
  });

  it('the home map shows the posts of the whole list', async () => {
    await page.goto(BASE + '/');
    await page.locator('.atlas-layer-handle').waitFor();
    await page.evaluate(() => document.body.setAttribute('data-atlas-layer', 'map'));
    await page.locator('.atlas-layer-marker').first().waitFor();
    const n = await page.locator('.atlas-layer-marker').count();
    assert.ok(n >= 3, `home markers ${n}`);
  });
});
