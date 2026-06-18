import { test, describe, before } from 'node:test';
import assert from 'node:assert';

// A tiny graph: two places (berlin geo-tag, paris geo-tag), year-tags 2020 and
// the 2010s decade, plus posts wired to them. Mirrors the /api/pages/graph shape.
const GRAPH = {
  tags: [
    { id: 1, name: 'Berlin', slug: 'berlin', kind: 'place', latitude: 52.5, longitude: 13.4 },
    { id: 2, name: 'Paris', slug: 'paris', kind: 'place', latitude: 48.8, longitude: 2.3 },
    { id: 3, name: '2020', slug: '2020', kind: 'year' },
    { id: 4, name: '2010s', slug: '2010s', kind: 'year' },
    { id: 5, name: 'food', slug: 'food', kind: 'topic' },
  ],
  posts: [
    { id: 10, slug: 'p10', title: 'Berlin 2020' },
    { id: 11, slug: 'p11', title: 'Berlin 2015' },
    { id: 12, slug: 'p12', title: 'Paris undated' },
  ],
  hierarchyEdges: [],
  membershipEdges: [
    { post: 10, tag: 1 }, { post: 10, tag: 3 }, { post: 10, tag: 5 }, // Berlin, 2020, food
    { post: 11, tag: 1 }, { post: 11, tag: 4 },                       // Berlin, 2010s
    { post: 12, tag: 2 },                                             // Paris, no year
  ],
};

describe('AtlasPage year filtering', () => {
  let AtlasPage;

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
  });

  function loaded() {
    const page = new AtlasPage({});
    page._buildIndexes(GRAPH);
    return page;
  }

  test('parses year and decade spans from year-tags', () => {
    const page = loaded();
    assert.deepEqual(page._yearSpansByPost.get(10), [[2020, 2020]]);
    assert.deepEqual(page._yearSpansByPost.get(11), [[2010, 2019]]);
    assert.equal(page._yearSpansByPost.has(12), false, 'undated post has no span');
  });

  test('_postsInRange matches intersecting spans only', () => {
    const page = loaded();
    assert.deepEqual([...page._postsInRange(2020, 2020)].sort(), [10]);
    assert.deepEqual([...page._postsInRange(2010, 2019)].sort(), [11]);
    assert.deepEqual([...page._postsInRange(2010, 2025)].sort(), [10, 11]);
    assert.deepEqual([...page._postsInRange(1999, 1999)].sort(), [], 'no overlap');
  });

  test('_buildSubgraph narrows posts and co-tags to the active set', () => {
    const page = loaded();
    const berlin = page._tagsById.get(1);

    // No filter: both Berlin posts and their co-tags (food) are in play.
    let sub = page._buildSubgraph(berlin);
    assert.deepEqual([...sub.postIds].sort(), [10, 11]);
    assert.ok(sub.tagIds.has(5), 'food co-tag present without filter');

    // Filter to 2020: only post 10 survives, dragging food but not the 2010s decade tag.
    page._activePostIds = page._postsInRange(2020, 2020);
    sub = page._buildSubgraph(berlin);
    assert.deepEqual([...sub.postIds], [10]);
    assert.ok(sub.tagIds.has(5), 'food still reachable via post 10');
    assert.ok(!sub.tagIds.has(4), '2010s decade tag dropped under the 2020 filter');
  });

  test('_buildYearDimmed flags places with no in-range posts', () => {
    const page = loaded();
    // Register the two places as base-map dimmables (as _drawLayers would).
    page._baseDimmables = [
      { tagId: 1, setDim() {} },
      { tagId: 2, setDim() {} },
    ];
    page._activePostIds = page._postsInRange(2020, 2020);
    const dimmed = page._buildYearDimmed();
    assert.ok(!dimmed.has(1), 'Berlin has a 2020 post — not dimmed');
    assert.ok(dimmed.has(2), 'Paris has no dated post — dimmed under the filter');
  });
});
