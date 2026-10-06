import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { must } from './helpers/dom.ts';
import { jsonResponse } from './helpers/fetch.ts';
import { mock, memoryStorage, nodeList } from './helpers/mock.ts';
import type { AtlasTag, ConcealMarks } from '../src/plugins/tags-atlas/index.ts';
import type { AtlasSheet } from '../src/plugins/tags-atlas/AtlasSheet.ts';

type AtlasModule = typeof import('../src/plugins/tags-atlas/index.ts');
type Page = InstanceType<AtlasModule['default']>;
type User = NonNullable<Parameters<typeof import('../src/store.ts').setUser>[0]>;

const tag = (fields: Partial<AtlasTag>) => mock<AtlasTag>(fields);

/** A node as isConcealed and _filteredOut see it, with the fields that name it. */
const node = (fields: ConcealMarks & { id?: number; name?: string; slug?: string }): ConcealMarks => fields;

/** A page container that holds no elements. */
const emptyContainer = () => mock<HTMLElement>({ querySelector: () => null, querySelectorAll: () => nodeList<Element>([]) });

// The graph payload now ships only markers + hierarchy — posts and co-tags are
// fetched per place on tap (see getTagCloud / _loadAndSpawnCloud).
const GRAPH = {
  tags: [
    tag({ id: 1, name: 'Berlin', slug: 'berlin', kind: 'place', latitude: 52.5, longitude: 13.4 }),
    tag({ id: 2, name: 'Paris', slug: 'paris', kind: 'place', latitude: 48.8, longitude: 2.3 }),
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
function fakeFetch(payload: unknown) {
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse({ ok: true, status: 200, body: payload });
  };
  return calls;
}

describe('AtlasPage lazy cloud loading', () => {
  let AtlasPage: AtlasModule['default'];
  let setRoute: typeof import('../src/store.ts').setRoute;

  before(async () => {
    globalThis.document = mock<Document>({
      createElement: () => mock<HTMLElement>({ classList: mock<DOMTokenList>({ add() {}, remove() {} }), appendChild: <T extends Node>(n: T) => n }),
      head: mock<HTMLHeadElement>({ appendChild: <T extends Node>(n: T) => n }),
      body: mock<HTMLElement>({ classList: mock<DOMTokenList>({ remove() {} }) }),
      documentElement: mock<HTMLElement>({ dataset: { theme: 'light' } }),
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => nodeList<Element>([]),
    });
    globalThis.window = mock<typeof window>({
      location: mock<Location>({ pathname: '/atlas', search: '' }),
      history: mock<History>({ replaceState() {}, pushState() {} }),
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => mock<MediaQueryList>({ matches: false }),
    });
    const mod = await import('../src/plugins/tags-atlas/index.ts');
    AtlasPage = mod.default;
    ({ setRoute } = await import('../src/store.ts'));
  });

  afterEach(() => {
    setRoute({ pathname: '/atlas', query: {} });
    Reflect.deleteProperty(globalThis, 'fetch');
  });

  function loaded() {
    const page = new AtlasPage(mock<HTMLElement>({}));
    page._buildIndexes(GRAPH);
    return page;
  }

  /** Put a place into the "actively selected" state so spawnFrom's guard passes. */
  function activate(page: Page, tagId: number) {
    const tag = must(page._tagsById.get(tagId));
    page._activeTag = tag;
    page._activeKey = 'm' + tagId;
    return tag;
  }

  test('_repositionCloud moves satellites and edges to the anchor offsets', () => {
    const page = loaded();
    type Point = { x: number; y: number; add(d: [number, number]): Point };
    const at = (x: number, y: number): Point => ({ x, y, add: ([dx, dy]) => at(x + dx, y + dy) });
    page._map = {
      latLngToContainerPoint: () => at(100, 100),
      containerPointToLatLng: (p: Point) => [p.x, p.y],
    };
    const moved: Record<string, unknown> = {};
    const marker = (key: string) => ({ setLatLng: (ll: unknown) => { moved[key] = ll; } });
    let edgeEnds: unknown = null;
    page._cloud = mock<NonNullable<Page['_cloud']>>({
      anchorLatLng: [0, 0],
      nodePos: new Map([['t5', { dx: 10, dy: -5 }], ['p10', { dx: -20, dy: 0 }]]),
      sats: [{ key: 't5', marker: marker('t5') }, { key: 'gone', marker: marker('gone') }],
      edges: [
        { a: 'p10', b: 't5', baseOpacity: 1, line: { setLatLngs: (ends: unknown) => { edgeEnds = ends; } } },
        { a: 'p10', b: 'gone', baseOpacity: 1, line: { setLatLngs: () => assert.fail('an edge to a missing node must not move') } },
      ],
    });
    page._repositionCloud();
    assert.deepEqual(moved, { t5: [110, 95] });
    assert.deepEqual(edgeEnds, [[80, 100], [110, 95]]);
  });

  test('_buildIndexes indexes only tag (marker) nodes', () => {
    const page = loaded();
    assert.equal(page._tagsById.size, 2);
    assert.equal(page._tagsById.get(1)?.slug, 'berlin');
    // The old global post indexes are gone.
    assert.equal(Reflect.get(page, '_postsById'), undefined);
    assert.equal(Reflect.get(page, '_tagsByPost'), undefined);
  });

  test('_loadAndSpawnCloud fetches the place cloud, spawns from it, and caches', async () => {
    const page = loaded();
    const berlin = activate(page, 1);
    let captured: unknown = null;
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

    let release: () => void = () => {};
    globalThis.fetch = async () => {
      await new Promise<void>((r) => { release = r; });
      return jsonResponse({ ok: true, status: 200, body: CLOUD });
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
  let AtlasPage: AtlasModule['default'];
  let setRoute: typeof import('../src/store.ts').setRoute;

  // Only Berlin survives a narrow range, and with a smaller (in-range) count.
  const SCOPED_GRAPH = {
    tags: [
      tag({ id: 1, name: 'Berlin', slug: 'berlin', kind: 'place', latitude: 52.5, longitude: 13.4, post_count: 2 }),
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
    Reflect.deleteProperty(globalThis, 'fetch');
  });

  /** A page past its initial load, with a map and a container the DOM helpers can query. */
  function mounted() {
    const page = new AtlasPage(emptyContainer());
    page._buildIndexes(GRAPH);
    page.state = { loading: false, data: GRAPH, error: null };
    page._map = {};
    return page;
  }

  test('a timeline change refetches the graph for the range and redraws', async () => {
    setRoute({ pathname: '/atlas', query: { timeline: '2018-2019' } });
    const page = mounted();
    let redrew = false;
    page._redrawPlaces = async () => { redrew = true; };
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
    const page = new AtlasPage(emptyContainer());
    page.setState = (s) => Object.assign(page.state, s);
    const calls = fakeFetch(SCOPED_GRAPH);

    await page._load();

    assert.ok(calls[0].includes('year_from=2020'), 'a shared link opens on its own range');
    assert.ok(calls[0].includes('year_to=2021'));
  });

  test('a failed refetch leaves the drawn places alone', async () => {
    const page = mounted();
    let redrew = false;
    page._redrawPlaces = async () => { redrew = true; };
    globalThis.fetch = async () => { throw new Error('offline'); };

    await page._applyYearScope();

    assert.equal(redrew, false, 'no redraw');
    assert.deepEqual(page.state.data, GRAPH, 'the previous places stay on the map');
  });

  test('drops a stale graph response when a newer range overtakes it', async () => {
    const page = mounted();
    let redrew = false;
    page._redrawPlaces = async () => { redrew = true; };

    let release: () => void = () => {};
    globalThis.fetch = async () => {
      await new Promise<void>((r) => { release = r; });
      return jsonResponse({ ok: true, status: 200, body: SCOPED_GRAPH });
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
    page._activeTag = must(page._tagsById.get(1));
    page._activeKey = 'm1';
    page._drawLayers = async () => {
      page._placeActivators.set(1, { latLng: {}, setActive() {}, key: 'm1' });
    };
    const selected: unknown[] = [];
    page._selectPlaceById = (id, opts) => { selected.push([id, opts]); return true; };

    await page._redrawPlaces();

    assert.deepEqual(selected, [[1, { pan: false, sheetPage: 1, sheetPerPage: undefined }]], 'reselected without moving the map');
  });

  test('a redraw drops a selection the range filtered out', async () => {
    const page = mounted();
    page._activeTag = must(page._tagsById.get(1));
    page._activeKey = 'm1';
    page._drawLayers = async () => {}; // the place is gone from the new payload
    const selected: unknown[] = [];
    page._selectPlaceById = (id, opts) => { selected.push([id, opts]); return true; };

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
  let isConcealed: AtlasModule['isConcealed'];
  let concealedTitle: AtlasModule['concealedTitle'];
  let AtlasPage: AtlasModule['default'];
  let setRevelio: typeof import('../src/utils/revelio.ts').setRevelio;

  before(async () => {
    // revelio keeps its state in localStorage, which node has no notion of —
    // without this the switch silently stays on (its reads fall back to the
    // default) and the concealed-404 case below could never be reached.
    globalThis.localStorage = memoryStorage();
    globalThis.window.localStorage = globalThis.localStorage;
    const mod = await import('../src/plugins/tags-atlas/index.ts');
    ({ isConcealed, concealedTitle } = mod);
    AtlasPage = mod.default;
    ({ setRevelio } = await import('../src/utils/revelio.ts'));
  });

  afterEach(() => {
    setRevelio(true);
    Reflect.deleteProperty(globalThis, 'fetch');
  });

  test('marks hidden tags and non-public posts, nothing else', () => {
    assert.equal(isConcealed(node({ id: 1, name: 'fog', is_hidden: true })), true);
    assert.equal(isConcealed(node({ id: 2, slug: 'p', status: 'draft' })), true);
    assert.equal(isConcealed(node({ id: 3, slug: 'p', status: 'scheduled' })), true);
    // A guest's payload carries neither field, so nothing is ever marked there.
    assert.equal(isConcealed(node({ id: 4, name: 'Berlin' })), false);
    assert.equal(isConcealed(node({ id: 5, slug: 'p', status: 'published' })), false);
  });

  test('the tooltip names why a node is owner-only', () => {
    assert.equal(concealedTitle({ is_hidden: true }, 'Taganay'), 'Taganay (hidden)');
    assert.equal(concealedTitle({ status: 'draft' }, 'Rocks'), 'Rocks (draft)');
    assert.equal(concealedTitle({}, 'Berlin'), 'Berlin', 'a public node keeps its plain name');
  });

  test('a 404 while concealing explains itself instead of reading as a broken page', async () => {
    const page = new AtlasPage(emptyContainer());
    page.setState = (s) => Object.assign(page.state, s);
    setRevelio(false); // owner viewing as a guest
    globalThis.fetch = async () => jsonResponse({ ok: false, status: 404, body: { detail: 'tags not found' } });

    await page._load();

    assert.match(page.state.error, /not public/, 'names the tags_visibility gate');
    assert.doesNotMatch(page.state.error, /not found/);
  });

  test('an ordinary failure still surfaces the real error', async () => {
    const page = new AtlasPage(emptyContainer());
    page.setState = (s) => Object.assign(page.state, s);
    globalThis.fetch = async () => { throw new Error('offline'); };

    await page._load();

    assert.match(page.state.error, /Network error/);
  });
});

// The "Hidden" legend filter: the owner's way to see the guest's map *shape*
// without leaving revelio on. It differs from the other legend toggles in that
// it redraws the place layer — a hidden country must lose its fill, not just
// its marker.
describe('AtlasPage hidden-node filter', () => {
  let AtlasPage: AtlasModule['default'];
  let isConcealed: AtlasModule['isConcealed'];
  let setUser: typeof import('../src/store.ts').setUser;
  let setRevelio: typeof import('../src/utils/revelio.ts').setRevelio;

  const MIXED = {
    tags: [
      tag({ id: 1, name: 'Berlin', slug: 'berlin', kind: 'place', latitude: 52.5, longitude: 13.4 }),
      tag({ id: 2, name: 'Italy', slug: 'italy', kind: 'place', latitude: 42.8, longitude: 12.5, is_hidden: true }),
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
    const p = new AtlasPage(emptyContainer());
    p.state = { loading: false, data: MIXED, error: null };
    p._buildIndexes(MIXED);
    return p;
  }

  test('the filter is offered only to a viewer who can be sent hidden nodes', () => {
    const p = page();
    setUser(null);
    assert.equal(p._canFilterHidden(), false, 'a guest gets a payload with nothing hidden in it');
    setUser(mock<User>({ id: 1 }));
    assert.equal(p._canFilterHidden(), true);
    setRevelio(false);
    assert.equal(p._canFilterHidden(), false, 'concealing already removed the hidden nodes');
  });

  test('filtering drops hidden places and keeps the rest', () => {
    const p = page();
    const geo = () => (p.state.data.tags || []).filter((t: AtlasTag) => !p._filteredOut(t)).map((t: AtlasTag) => t.slug);

    assert.deepEqual(geo(), ['berlin', 'italy'], 'unfiltered, the owner sees both');
    p._hiddenTypes.add('concealed');
    assert.deepEqual(geo(), ['berlin'], 'the hidden country leaves the drawn set entirely');
    // Leaving the set is what reverts its boundary shape to an untagged outline:
    // the GeoJSON features match against exactly these tags.
    assert.equal(isConcealed(must(MIXED.tags[1])), true);
  });

  // Regression: the toggle was built with a plain `` template literal
  // interpolated into html``, so the tag escaped it and the owner got the
  // markup as visible text instead of a button.
  test('the toggle renders as an element, not as escaped text', () => {
    const p = page();
    setUser(mock<User>({ id: 1 }));
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
    assert.equal(p._filteredOut(node({ id: 9, slug: 'p', status: 'draft' })), true);
    assert.equal(p._filteredOut(node({ id: 10, slug: 'q', status: 'published' })), false);
  });
});

describe('AtlasPage bottom sheet', () => {
  let AtlasPage: AtlasModule['default'];
  let setRoute: typeof import('../src/store.ts').setRoute;

  before(async () => {
    const mod = await import('../src/plugins/tags-atlas/index.ts');
    AtlasPage = mod.default;
    ({ setRoute } = await import('../src/store.ts'));
  });

  afterEach(() => {
    setRoute({ pathname: '/atlas', query: {} });
    Reflect.deleteProperty(globalThis, 'fetch');
  });

  /** A fake sheet that records every call. */
  function fakeSheet(page = 1, perPage = 4) {
    const calls: unknown[][] = [];
    const sheet = {
      page,
      _perPage: perPage,
      isOpen: false,
      show(place: unknown, opts: unknown) { sheet.isOpen = true; calls.push(['show', place, opts]); return Promise.resolve(); },
      expand() { sheet.isOpen = true; calls.push(['expand']); },
      hide() { sheet.isOpen = false; calls.push(['hide']); },
    };
    return { sheet, calls };
  }

  /** A page with a map, the graph indexed, both places selectable, and a fake sheet. */
  function withSheet(page = 1, perPage = 4) {
    const p = new AtlasPage(emptyContainer());
    p._buildIndexes(GRAPH);
    p.state = { loading: false, data: GRAPH, error: null };
    p._map = {};
    p._loadAndSpawnCloud = async () => {};
    const activate = () => {
      p._placeActivators.set(1, { latLng: {}, setActive() {}, key: 'm1' });
      p._placeActivators.set(2, { latLng: {}, setActive() {}, key: 'm2' });
    };
    activate();
    p._drawLayers = async () => activate();
    const { sheet, calls } = fakeSheet(page, perPage);
    p._sheet = mock<AtlasSheet>(sheet);
    return { p, sheet, calls };
  }

  test('a select shows the place; a second place shows with no hide between', () => {
    const { p, calls } = withSheet();
    p._selectPlaceById(1);
    p._selectPlaceById(2);
    assert.deepEqual(calls, [
      ['show', { id: 1, slug: 'berlin', name: 'Berlin' }, { page: undefined, perPage: undefined }],
      ['show', { id: 2, slug: 'paris', name: 'Paris' }, { page: undefined, perPage: undefined }],
    ]);
  });

  test('a click on the selected place expands the sheet', () => {
    const { p, calls } = withSheet();
    p._selectPlaceById(1);
    p._selectPlaceById(1);
    assert.deepEqual(calls.map((c) => c[0]), ['show', 'expand']);
  });

  test('panInside adds the open sheet height to the bottom padding', () => {
    const { p } = withSheet();
    const pans: unknown[] = [];
    p._map = { panInside: (_ll: unknown, opts: unknown) => pans.push(opts) };
    p.$ = (sel: string) => (sel === '.atlas-sheet' ? mock<HTMLElement>({ offsetHeight: 150 }) : null);
    p._selectPlaceById(1);
    assert.deepEqual(pans, [{ paddingTopLeft: [220, 220], paddingBottomRight: [220, 370] }]);
  });

  test('a clear hides the sheet', () => {
    const { p, calls } = withSheet();
    p._selectPlaceById(1);
    p._clearSelection();
    assert.deepEqual(calls.map((c) => c[0]), ['show', 'hide']);
  });

  test('the "Hidden" toggle redraw keeps the sheet on the same page', async () => {
    const { p, calls } = withSheet(3, 5);
    p._selectPlaceById(1);
    calls.length = 0;
    await p._redrawPlaces();
    assert.deepEqual(calls, [['show', { id: 1, slug: 'berlin', name: 'Berlin' }, { page: 3, perPage: 5 }]]);
  });

  test('a timeline redraw shows page 1', async () => {
    const { p, calls } = withSheet(3, 5);
    p._selectPlaceById(1);
    calls.length = 0;
    await p._redrawPlaces({ samePage: false });
    assert.deepEqual(calls, [['show', { id: 1, slug: 'berlin', name: 'Berlin' }, { page: 1, perPage: 5 }]]);
  });

  test('a redraw hides the sheet when the place is gone', async () => {
    const { p, calls } = withSheet();
    p._selectPlaceById(1);
    p._drawLayers = async () => {};
    calls.length = 0;
    await p._redrawPlaces();
    assert.deepEqual(calls.map((c) => c[0]), ['hide']);
  });

  /** Run `fn` with a session store, a location and a navigate log. */
  function withNav(fn: (store: Map<string, string>, navs: string[]) => void) {
    const store = new Map<string, string>();
    globalThis.sessionStorage = memoryStorage(store);
    const navs: string[] = [];
    const prevDispatch = globalThis.window.dispatchEvent;
    globalThis.window.dispatchEvent = (ev) => {
      if (ev instanceof CustomEvent) navs.push(ev.detail.path);
      return true;
    };
    globalThis.location = mock<Location>({ pathname: '/map', search: '?timeline=2019-2020' });
    try {
      fn(store, navs);
    } finally {
      globalThis.window.dispatchEvent = prevDispatch;
      Reflect.deleteProperty(globalThis, 'sessionStorage');
      Reflect.deleteProperty(globalThis, 'location');
    }
  }

  test('a card opens the post inside the place and leaves the sheet page', () => {
    setRoute({ pathname: '/map', query: { timeline: '2019-2020' } });
    withNav((store, navs) => {
      const { p } = withSheet();
      p._selectPlaceById(1);
      p._openPost('p10', 2, 4);
      assert.deepEqual(JSON.parse(store.get('atlasOpenContext') ?? 'null'), {
        placeTagId: 1, sheetPage: 2, sheetPerPage: 4, returnUrl: '/map?timeline=2019-2020',
      });
      assert.deepEqual(navs, ['/tags/berlin?slug=p10&timeline=2019-2020']);
    });
  });

  test('a cloud post chip opens inside the place with the sheet page', () => {
    withNav((store, navs) => {
      const { p } = withSheet(2, 6);
      p._selectPlaceById(1);
      p._cloud = mock<NonNullable<Page['_cloud']>>({ focusKey: 'p10' });
      p._focusCloudNode('p10', p._postHref('p10'));
      assert.deepEqual(JSON.parse(store.get('atlasOpenContext') ?? 'null'), {
        placeTagId: 1, sheetPage: 2, sheetPerPage: 6, returnUrl: '/map?timeline=2019-2020',
      });
      assert.deepEqual(navs, ['/tags/berlin?slug=p10']);
    });
  });

  test('the restore passes the sheet page back to the select', () => {
    const store = new Map<string, string>([['atlasReturn', JSON.stringify({ placeTagId: 1, postSlug: 'p10', sheetPage: 3, sheetPerPage: 5 })]]);
    globalThis.sessionStorage = memoryStorage(store);
    try {
      const { p, calls } = withSheet();
      p._restoreFromPost();
      assert.deepEqual(calls, [['show', { id: 1, slug: 'berlin', name: 'Berlin' }, { page: 3, perPage: 5 }]]);
    } finally {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });
});
