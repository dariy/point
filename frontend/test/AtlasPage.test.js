import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert';

// The graph payload now ships only markers + hierarchy — posts and co-tags are
// fetched per place on tap (see getTagCloud / _loadAndSpawnCloud).
const GRAPH = {
  tags: [
    { id: 1, name: 'Berlin', slug: 'berlin', kind: 'place', latitude: 52.5, longitude: 13.4 },
    { id: 2, name: 'Paris', slug: 'paris', kind: 'place', latitude: 48.8, longitude: 2.3 },
  ],
  hierarchyEdges: [],
};

// A per-place cloud payload as GetTagCloud returns it: ≤10 recent posts, ≤10
// popular co-tags, and the edges wiring that subset together.
const CLOUD = {
  tags: [{ id: 5, name: 'food', slug: 'food', kind: 'topic' }],
  posts: [
    { id: 10, slug: 'p10', title: 'Berlin 2020', media_url: '/a.jpg?thumb=128' },
    { id: 11, slug: 'p11', title: 'Berlin 2015' },
  ],
  membershipEdges: [
    { post: 10, tag: 5 },
  ],
  hierarchyEdges: [],
};

/** Stub global.fetch to return `payload` for every request; returns the URL log. */
function fakeFetch(payload) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => payload,
    };
  };
  return calls;
}

describe('AtlasPage lazy cloud loading', () => {
  let AtlasPage;
  let store;

  before(async () => {
    global.document = {
      createElement: () => ({ classList: { add() {}, remove() {} }, appendChild() {} }),
      head: { appendChild() {} },
      body: { classList: { remove() {} } },
      documentElement: { dataset: { theme: 'light' } },
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    global.window = {
      location: { pathname: '/atlas', search: '' },
      history: { replaceState() {}, pushState() {} },
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false }),
    };
    const mod = await import('../src/pages/public/AtlasPage.js');
    AtlasPage = mod.default;
    ({ store } = await import('../src/store.js'));
  });

  afterEach(() => {
    store.set('route', { pathname: '/atlas', query: {} });
    delete global.fetch;
  });

  function loaded() {
    const page = new AtlasPage({});
    page._buildIndexes(GRAPH);
    return page;
  }

  /** Put a place into the "actively selected" state so spawnFrom's guard passes. */
  function activate(page, tagId) {
    const tag = page._tagsById.get(tagId);
    page._activeTag = tag;
    page._activeKey = 'm' + tagId;
    return tag;
  }

  test('_buildIndexes indexes only tag (marker) nodes', () => {
    const page = loaded();
    assert.equal(page._tagsById.size, 2);
    assert.equal(page._tagsById.get(1).slug, 'berlin');
    // The old global post indexes are gone.
    assert.equal(page._postsById, undefined);
    assert.equal(page._tagsByPost, undefined);
  });

  test('_loadAndSpawnCloud fetches the place cloud, spawns from it, and caches', async () => {
    const page = loaded();
    const berlin = activate(page, 1);
    let captured = null;
    page._spawnCloud = (_t, _a, data) => { captured = data; };
    const calls = fakeFetch(CLOUD);

    await page._loadAndSpawnCloud(berlin, { lat: 52.5, lng: 13.4 });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('/api/pages/graph/tag/1'), 'requests the place endpoint');
    assert.deepEqual(captured, CLOUD, 'cloud built from the fetched payload');
    assert.deepEqual(page._cloudData, CLOUD);
    assert.ok(page._cloudCache.has('1|'), 'cached under place|<no-year>');

    // Re-selecting the same place + scope serves from cache — no second request.
    await page._loadAndSpawnCloud(berlin, { lat: 52.5, lng: 13.4 });
    assert.equal(calls.length, 1, 'second select is served from cache');
  });

  test('forwards the active timeline range and caches per year scope', async () => {
    store.set('route', { pathname: '/atlas', query: { timeline: '2020-2021' } });
    const page = loaded();
    const berlin = activate(page, 1);
    page._spawnCloud = () => {};
    const calls = fakeFetch(CLOUD);

    await page._loadAndSpawnCloud(berlin, { lat: 52.5, lng: 13.4 });

    assert.ok(calls[0].includes('year_from=2020'), 'year_from forwarded');
    assert.ok(calls[0].includes('year_to=2021'), 'year_to forwarded');
    assert.ok(page._cloudCache.has('1|2020-2021'), 'cache key embeds the year scope');
  });

  test('drops a stale cloud response when the selection changes mid-flight', async () => {
    const page = loaded();
    const berlin = activate(page, 1);
    let spawned = false;
    page._spawnCloud = () => { spawned = true; };

    let release;
    global.fetch = async () => {
      await new Promise((r) => { release = r; });
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => CLOUD };
    };

    const pending = page._loadAndSpawnCloud(berlin, { lat: 52.5, lng: 13.4 });
    page._cloudReq++; // a newer selection supersedes this in-flight fetch
    release();
    await pending;

    assert.equal(spawned, false, 'superseded response is ignored');
  });
});
