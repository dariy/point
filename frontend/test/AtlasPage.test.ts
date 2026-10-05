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
    { id: 10, slug: 'p10', title: 'Berlin 2020', media_url: '/a.jpg?s=256&v=abc123' },
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
  let setRoute;

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
    const mod = await import('../src/plugins/tags-atlas/index.ts');
    AtlasPage = mod.default;
    ({ setRoute } = await import('../src/store.ts'));
  });

  afterEach(() => {
    setRoute({ pathname: '/atlas', query: {} });
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

  test('_repositionCloud moves satellites and edges to the anchor offsets', () => {
    const page = loaded();
    const at = (x, y) => ({ x, y, add: ([dx, dy]) => at(x + dx, y + dy) });
    page._map = {
      latLngToContainerPoint: () => at(100, 100),
      containerPointToLatLng: p => [p.x, p.y],
    };
    const moved = {};
    const marker = key => ({ setLatLng: ll => { moved[key] = ll; } });
    let edgeEnds = null;
    page._cloud = {
      anchorLatLng: [0, 0],
      nodePos: new Map([['t5', { dx: 10, dy: -5 }], ['p10', { dx: -20, dy: 0 }]]),
      sats: [{ key: 't5', marker: marker('t5') }, { key: 'gone', marker: marker('gone') }],
      edges: [
        { a: 'p10', b: 't5', line: { setLatLngs: ends => { edgeEnds = ends; } } },
        { a: 'p10', b: 'gone', line: { setLatLngs: () => assert.fail('an edge to a missing node must not move') } },
      ],
    };
    page._repositionCloud();
    assert.deepEqual(moved, { t5: [110, 95] });
    assert.deepEqual(edgeEnds, [[80, 100], [110, 95]]);
  });

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
    setRoute({ pathname: '/atlas', query: { timeline: '2020-2021' } });
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

// The timeline scopes the map itself, not only the open place's cloud: the
// graph is refetched for the range and the places redrawn from it.
describe('AtlasPage timeline filtering', () => {
  let AtlasPage;
  let setRoute;

  // Only Berlin survives a narrow range, and with a smaller (in-range) count.
  const SCOPED_GRAPH = {
    tags: [
      { id: 1, name: 'Berlin', slug: 'berlin', kind: 'place', latitude: 52.5, longitude: 13.4, post_count: 2 },
    ],
    hierarchyEdges: [],
  };

  before(async () => {
    const mod = await import('../src/plugins/tags-atlas/index.ts');
    AtlasPage = mod.default;
    ({ setRoute } = await import('../src/store.ts'));
  });

  afterEach(() => {
    setRoute({ pathname: '/atlas', query: {} });
    delete global.fetch;
  });

  /** A page past its initial load, with a map and a container the DOM helpers can query. */
  function mounted() {
    const page = new AtlasPage({ querySelector: () => null, querySelectorAll: () => [] });
    page._buildIndexes(GRAPH);
    page.state = { loading: false, data: GRAPH, error: null };
    page._map = {};
    return page;
  }

  test('a timeline change refetches the graph for the range and redraws', async () => {
    setRoute({ pathname: '/atlas', query: { timeline: '2018-2019' } });
    const page = mounted();
    let redrew = false;
    page._redrawPlaces = () => { redrew = true; };
    const calls = fakeFetch(SCOPED_GRAPH);

    await page._applyYearScope();

    assert.ok(calls[0].includes('year_from=2018'), 'year_from forwarded');
    assert.ok(calls[0].includes('year_to=2019'), 'year_to forwarded');
    assert.ok(calls[0].includes('posts=0'), 'still the lightweight marker request');
    assert.deepEqual(page.state.data, SCOPED_GRAPH, 'places replaced by the scoped set');
    assert.ok(redrew, 'the map is redrawn from the new payload');
  });

  test('the initial load carries a year range from the URL', async () => {
    setRoute({ pathname: '/atlas', query: { timeline: '2020-2021' } });
    const page = new AtlasPage({ querySelector: () => null, querySelectorAll: () => [] });
    page.setState = (s) => Object.assign(page.state, s);
    const calls = fakeFetch(SCOPED_GRAPH);

    await page._load();

    assert.ok(calls[0].includes('year_from=2020'), 'a shared link opens on its own range');
    assert.ok(calls[0].includes('year_to=2021'));
  });

  test('a failed refetch leaves the drawn places alone', async () => {
    const page = mounted();
    let redrew = false;
    page._redrawPlaces = () => { redrew = true; };
    global.fetch = async () => { throw new Error('offline'); };

    await page._applyYearScope();

    assert.equal(redrew, false, 'no redraw');
    assert.deepEqual(page.state.data, GRAPH, 'the previous places stay on the map');
  });

  test('drops a stale graph response when a newer range overtakes it', async () => {
    const page = mounted();
    let redrew = false;
    page._redrawPlaces = () => { redrew = true; };

    let release;
    global.fetch = async () => {
      await new Promise((r) => { release = r; });
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => SCOPED_GRAPH };
    };

    const pending = page._applyYearScope();
    page._graphReq++; // a newer range supersedes this in-flight fetch
    release();
    await pending;

    assert.equal(redrew, false, 'superseded payload never reaches the map');
    assert.deepEqual(page.state.data, GRAPH);
  });

  test('a redraw reopens the selected place when the range still has it', async () => {
    const page = mounted();
    page._activeTag = page._tagsById.get(1);
    page._activeKey = 'm1';
    page._drawLayers = async () => {
      page._placeActivators.set(1, { latLng: {}, setActive() {}, key: 'm1' });
    };
    const selected = [];
    page._selectPlaceById = (id, opts) => selected.push([id, opts]);

    await page._redrawPlaces();

    assert.deepEqual(selected, [[1, { pan: false }]], 'reselected without moving the map');
  });

  test('a redraw drops a selection the range filtered out', async () => {
    const page = mounted();
    page._activeTag = page._tagsById.get(1);
    page._activeKey = 'm1';
    page._drawLayers = async () => {}; // the place is gone from the new payload
    const selected = [];
    page._selectPlaceById = (id, opts) => selected.push([id, opts]);

    await page._redrawPlaces();

    assert.deepEqual(selected, [], 'nothing to reselect');
    assert.equal(page._activeTag, null, 'the stale selection is cleared');
    assert.equal(page._activeKey, null);
  });

  test('a redraw rebuilds the tag index rather than accumulating', async () => {
    const page = mounted();
    page.state.data = SCOPED_GRAPH;
    page._drawLayers = async () => {};

    await page._redrawPlaces();

    assert.equal(page._tagsById.size, 1, 'Paris is gone, not merely unselected');
    assert.ok(page._tagsById.has(1));
  });
});

// Revelio already scoped the Atlas server-side (concealing drops hidden places
// from the payload), but dropping 1 marker in 500 looks like nothing happened.
// The revealed view therefore marks what a guest would not get.
describe('AtlasPage owner-only marking', () => {
  let isConcealed, concealedTitle, AtlasPage, setRevelio;

  before(async () => {
    // revelio keeps its state in localStorage, which node has no notion of —
    // without this the switch silently stays on (its reads fall back to the
    // default) and the concealed-404 case below could never be reached.
    const mem = new Map();
    global.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
    global.window.localStorage = global.localStorage;
    const mod = await import('../src/plugins/tags-atlas/index.ts');
    ({ isConcealed, concealedTitle } = mod);
    AtlasPage = mod.default;
    ({ setRevelio } = await import('../src/utils/revelio.ts'));
  });

  afterEach(() => {
    setRevelio(true);
    delete global.fetch;
  });

  test('marks hidden tags and non-public posts, nothing else', () => {
    assert.equal(isConcealed({ id: 1, name: 'fog', is_hidden: true }), true);
    assert.equal(isConcealed({ id: 2, slug: 'p', status: 'draft' }), true);
    assert.equal(isConcealed({ id: 3, slug: 'p', status: 'scheduled' }), true);
    // A guest's payload carries neither field, so nothing is ever marked there.
    assert.equal(isConcealed({ id: 4, name: 'Berlin' }), false);
    assert.equal(isConcealed({ id: 5, slug: 'p', status: 'published' }), false);
  });

  test('the tooltip names why a node is owner-only', () => {
    assert.equal(concealedTitle({ is_hidden: true }, 'Taganay'), 'Taganay (hidden)');
    assert.equal(concealedTitle({ status: 'draft' }, 'Rocks'), 'Rocks (draft)');
    assert.equal(concealedTitle({}, 'Berlin'), 'Berlin', 'a public node keeps its plain name');
  });

  test('a 404 while concealing explains itself instead of reading as a broken page', async () => {
    const page = new AtlasPage({ querySelector: () => null, querySelectorAll: () => [] });
    page.setState = (s) => Object.assign(page.state, s);
    setRevelio(false); // owner viewing as a guest
    global.fetch = async () => ({
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' },
      json: async () => ({ detail: 'tags not found' }),
    });

    await page._load();

    assert.match(page.state.error, /not public/, 'names the tags_visibility gate');
    assert.doesNotMatch(page.state.error, /not found/);
  });

  test('an ordinary failure still surfaces the real error', async () => {
    const page = new AtlasPage({ querySelector: () => null, querySelectorAll: () => [] });
    page.setState = (s) => Object.assign(page.state, s);
    global.fetch = async () => { throw new Error('offline'); };

    await page._load();

    assert.match(page.state.error, /Network error/);
  });
});

// The "Hidden" legend filter: the owner's way to see the guest's map *shape*
// without leaving revelio on. It differs from the other legend toggles in that
// it redraws the place layer — a hidden country must lose its fill, not just
// its marker.
describe('AtlasPage hidden-node filter', () => {
  let AtlasPage, isConcealed, setUser, setRevelio;

  const MIXED = {
    tags: [
      { id: 1, name: 'Berlin', slug: 'berlin', kind: 'place', latitude: 52.5, longitude: 13.4 },
      { id: 2, name: 'Italy', slug: 'italy', kind: 'place', latitude: 42.8, longitude: 12.5, is_hidden: true },
    ],
    hierarchyEdges: [],
  };

  before(async () => {
    const mod = await import('../src/plugins/tags-atlas/index.ts');
    AtlasPage = mod.default;
    ({ isConcealed } = mod);
    ({ setUser } = await import('../src/store.ts'));
    ({ setRevelio } = await import('../src/utils/revelio.ts'));
  });

  afterEach(() => {
    setUser(null);
    setRevelio(true);
  });

  function page() {
    const p = new AtlasPage({ querySelector: () => null, querySelectorAll: () => [] });
    p.state = { loading: false, data: MIXED, error: null };
    p._buildIndexes(MIXED);
    return p;
  }

  test('the filter is offered only to a viewer who can be sent hidden nodes', () => {
    const p = page();
    setUser(null);
    assert.equal(p._canFilterHidden(), false, 'a guest gets a payload with nothing hidden in it');
    setUser({ id: 1 });
    assert.equal(p._canFilterHidden(), true);
    setRevelio(false);
    assert.equal(p._canFilterHidden(), false, 'concealing already removed the hidden nodes');
  });

  test('filtering drops hidden places and keeps the rest', () => {
    const p = page();
    const geo = () => (p.state.data.tags || []).filter((t) => !p._filteredOut(t)).map((t) => t.slug);

    assert.deepEqual(geo(), ['berlin', 'italy'], 'unfiltered, the owner sees both');
    p._hiddenTypes.add('concealed');
    assert.deepEqual(geo(), ['berlin'], 'the hidden country leaves the drawn set entirely');
    // Leaving the set is what reverts its boundary shape to an untagged outline:
    // the GeoJSON features match against exactly these tags.
    assert.equal(isConcealed(MIXED.tags[1]), true);
  });

  // Regression: the toggle was built with a plain `` template literal
  // interpolated into html``, so the tag escaped it and the owner got the
  // markup as visible text instead of a button.
  test('the toggle renders as an element, not as escaped text', () => {
    const p = page();
    setUser({ id: 1 });
    const markup = String(p.render());
    assert.ok(
      markup.includes('<button type="button" class="atlas-toggle atlas-toggle--hidden"'),
      'the Hidden toggle is not real markup:\n' + markup.slice(markup.indexOf('atlas-legend'), 1200),
    );
    assert.ok(!markup.includes('&lt;button'), 'a button was escaped into the legend');
  });

  test('a draft post chip is filtered by the same switch', () => {
    const p = page();
    p._hiddenTypes.add('concealed');
    assert.equal(p._filteredOut({ id: 9, slug: 'p', status: 'draft' }), true);
    assert.equal(p._filteredOut({ id: 10, slug: 'q', status: 'published' }), false);
  });
});

describe('AtlasPage desktop side panel', () => {
  let AtlasPage;
  let panelHtml;
  let setRoute;

  const TAG_PAGE = {
    posts: [
      { id: 10, slug: 'p10', title: 'Berlin 2020', status: 'published', published_at: '2020-05-01T00:00:00Z' },
      { id: 12, slug: 'p12', title: 'Draft', status: 'draft' },
    ],
    pagination: { page: 1, per_page: 2, total: 3, pages: 2 },
  };

  before(async () => {
    const mod = await import('../src/plugins/tags-atlas/index.ts');
    AtlasPage = mod.default;
    panelHtml = mod.panelHtml;
    ({ setRoute } = await import('../src/store.ts'));
  });

  afterEach(() => {
    setRoute({ pathname: '/atlas', query: {} });
    global.window.matchMedia = () => ({ matches: false });
    delete global.fetch;
  });

  /** A page with a fake #atlas-panel element that records what is written to it. */
  function withPanel(desktop) {
    global.window.matchMedia = () => ({ matches: desktop });
    const el = { hidden: true, innerHTML: '', addEventListener() {} };
    const page = new AtlasPage({
      querySelector: (sel) => (sel === '#atlas-panel' ? el : null),
      querySelectorAll: () => [],
    });
    page._buildIndexes(GRAPH);
    return { page, el, berlin: page._tagsById.get(1) };
  }

  test('a place at desktop width loads its posts with the year scope and renders rows', async () => {
    setRoute({ pathname: '/atlas', query: { timeline: '2019-2021' } });
    const { page, el, berlin } = withPanel(true);
    const calls = fakeFetch(TAG_PAGE);

    await page._openPanel(berlin);

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('/api/pages/tags/berlin'), 'requests the tag page');
    assert.ok(calls[0].includes('page=1'));
    assert.ok(calls[0].includes('year_from=2019') && calls[0].includes('year_to=2021'));
    assert.equal(el.hidden, false);
    const out = String(el.innerHTML);
    assert.ok(out.includes('Berlin') && out.includes('3 posts'), 'name and count');
    assert.ok(out.includes('data-slug="p10"') && out.includes('data-slug="p12"'));
    assert.ok(out.includes('data-action="more"'), 'more pages remain');

    // "More" asks for the next page and appends.
    fakeFetch({ posts: [{ id: 13, slug: 'p13', title: 'Last' }], pagination: { page: 2, total: 3, pages: 2 } });
    await page._loadPanelPage();
    assert.equal(page._panel.posts.length, 3);
    assert.ok(!String(el.innerHTML).includes('data-action="more"'), 'no more pages');
  });

  test('a range change refetches the list with the new range', async () => {
    const { page, berlin } = withPanel(true);
    setRoute({ pathname: '/atlas', query: { timeline: '2010-2012' } });
    let calls = fakeFetch(TAG_PAGE);
    await page._openPanel(berlin);
    assert.ok(calls[0].includes('year_from=2010'));

    // A range change redraws the places, which reselects the place → reopens the panel.
    setRoute({ pathname: '/atlas', query: { timeline: '2015-2016' } });
    calls = fakeFetch(TAG_PAGE);
    await page._openPanel(berlin);
    assert.ok(calls[0].includes('year_from=2015') && calls[0].includes('year_to=2016'));
    assert.equal(page._panel.posts.length, 2, 'the list is replaced, not appended');
  });

  test('_clearSelection removes the panel and drops a late page', async () => {
    const { page, el, berlin } = withPanel(true);
    fakeFetch(TAG_PAGE);
    const pending = page._openPanel(berlin);
    page._clearSelection();
    await pending;
    assert.equal(page._panel, null);
    assert.equal(el.hidden, true);
    assert.equal(String(el.innerHTML), '');
  });

  test('at a narrow width no panel opens and nothing is fetched', async () => {
    const { page, el, berlin } = withPanel(false);
    const calls = fakeFetch(TAG_PAGE);
    await page._openPanel(berlin);
    assert.equal(page._panel, null);
    assert.equal(calls.length, 0);
    assert.equal(el.hidden, true);
  });

  test('with "Hidden" off the list skips concealed posts', () => {
    const page = new AtlasPage({});
    page._hiddenTypes.add('concealed');
    const out = String(panelHtml(
      { tag: { name: 'Berlin' }, ...TAG_PAGE, page: 1, pages: 1, total: 2, loading: false, error: null },
      (p) => page._filteredOut(p),
    ));
    assert.ok(out.includes('data-slug="p10"'));
    assert.ok(!out.includes('data-slug="p12"'), 'draft skipped');
  });

  test('a post row opens the post and leaves atlasOpenContext', () => {
    const store = {};
    global.sessionStorage = { setItem: (k, v) => { store[k] = v; } };
    const navs = [];
    const prevDispatch = global.window.dispatchEvent;
    global.window.dispatchEvent = (ev) => navs.push(ev.detail.path);
    try {
      const { page, berlin } = withPanel(true);
      page._activeTag = berlin;
      page._openPanelPost('p10');
      assert.deepEqual(JSON.parse(store.atlasOpenContext), { placeTagId: 1 });
      assert.deepEqual(navs, ['/posts/p10']);
    } finally {
      global.window.dispatchEvent = prevDispatch;
      delete global.sessionStorage;
    }
  });
});
