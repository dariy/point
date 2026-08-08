import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

/**
 * tagGraph.js draws the public /tags graph on a <canvas>: it turns the tags +
 * posts payload into a node/link graph, runs a force layout over it, frames it
 * to the viewport, and picks nodes back out of pointer coordinates.
 *
 * None of that is observable from the DOM — the whole surface is pixels — so
 * this covers the parts that are arithmetic rather than paint: graph
 * construction, the visible-set/hidden-type rules, bounds and fit-to-view, the
 * screen↔world transform and hit-testing, and the hover/selection focus walk.
 *
 * The canvas is stubbed rather than emulated. Drawing is all no-ops; what the
 * tests read is the state the drawing would have used.
 */

let TagGraph;

before(async () => {
  installDomStubs();
  ({ TagGraph } = await import('../src/plugins/tags-graph/tagGraph.js'));
});

// ── Harness ──────────────────────────────────────────────────────────────────

/** A 2D context whose every method is a no-op; _draw only ever writes to it. */
function stubCtx() {
  const noop = () => {};
  return {
    clearRect: noop, save: noop, restore: noop, beginPath: noop, arc: noop,
    moveTo: noop, lineTo: noop, fill: noop, stroke: noop, fillText: noop,
    strokeText: noop, setLineDash: noop, setTransform: noop,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    font: '', textAlign: '', textBaseline: '',
  };
}

function stubCanvas({ width = 800, height = 520 } = {}) {
  return {
    clientWidth: width,
    clientHeight: height,
    parentElement: null,
    width: 0,
    height: 0,
    style: {},
    getContext: () => stubCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener: () => {},
    removeEventListener: () => {},
    releasePointerCapture: () => {},
    setPointerCapture: () => {},
  };
}

function installDomStubs() {
  globalThis.window = {
    devicePixelRatio: 1,
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: () => {},
    removeEventListener: () => {},
    // No custom properties: every colour falls back to its literal default.
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: globalThis.__reduceMotion === true }),
  };
  globalThis.__reduceMotion = false;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
}

/**
 * A small fixture with one of each node kind and both edge kinds:
 *
 *   location ──hierarchy── canada ──hierarchy── montreal (geo)
 *   2026 (year)
 *   post 1 ──membership── montreal, 2026
 *   post 2 ──membership── montreal
 */
const FIXTURE = {
  tags: [
    { id: 1, name: 'Location', slug: 'location', post_count: 3 },
    { id: 2, name: 'Canada', slug: 'canada', post_count: 3 },
    { id: 3, name: 'Montréal', slug: 'montreal', post_count: 2, latitude: 45.5, longitude: -73.5 },
    { id: 4, name: '2026', slug: '2026', post_count: 1, kind: 'year' },
  ],
  posts: [
    { id: 10, title: 'A walk', slug: 'a-walk' },
    { id: 11, title: 'Another', slug: 'another' },
  ],
  hierarchyEdges: [
    { parent: 1, child: 2 },
    { parent: 2, child: 3 },
  ],
  membershipEdges: [
    { post: 10, tag: 3 },
    { post: 10, tag: 4 },
    { post: 11, tag: 3 },
  ],
};

const makeGraph = (data = FIXTURE, opts = {}) => new TagGraph(stubCanvas(), data, opts);

// ── Graph construction ───────────────────────────────────────────────────────

/**
 * Tag and post ids share one namespace on the canvas, so they are prefixed
 * ('t1', 'p1') — without that a tag and a post with the same database id would
 * collide in nodeById and one would silently vanish from the graph.
 */
describe('graph construction', () => {
  test('builds a node per tag and per post', () => {
    const g = makeGraph();
    assert.strictEqual(g.nodes.length, 6);
    assert.strictEqual(g.nodes.filter((n) => n.type === 'post').length, 2);
  });

  test('tag and post ids are namespaced apart', () => {
    const g = makeGraph({
      tags: [{ id: 1, name: 'T', slug: 't', post_count: 0 }],
      posts: [{ id: 1, title: 'P', slug: 'p' }],
    });
    assert.strictEqual(g.nodes.length, 2, 'same numeric id must not collide');
    assert.strictEqual(g.nodeById.get('t1').type, 'tag');
    assert.strictEqual(g.nodeById.get('p1').type, 'post');
  });

  test('tags are classified into the shared colour buckets', () => {
    const g = makeGraph();
    assert.strictEqual(g.nodeById.get('t1').type, 'tag');
    assert.strictEqual(g.nodeById.get('t3').type, 'geo', 'has coordinates');
    assert.strictEqual(g.nodeById.get('t4').type, 'year');
  });

  test('a post falls back to its slug when it has no title', () => {
    const g = makeGraph({ tags: [], posts: [{ id: 1, slug: 'untitled-thing' }] });
    assert.strictEqual(g.nodeById.get('p1').name, 'untitled-thing');
  });

  test('both edge kinds are linked and labelled', () => {
    const g = makeGraph();
    assert.strictEqual(g.links.filter((l) => l.kind === 'hierarchy').length, 2);
    assert.strictEqual(g.links.filter((l) => l.kind === 'membership').length, 3);
  });

  test('degree counts every incident edge', () => {
    const g = makeGraph();
    assert.strictEqual(g.nodeById.get('t3').degree, 3, 'parent Canada + posts 10 and 11');
    assert.strictEqual(g.nodeById.get('t1').degree, 1, 'one child, no posts of its own');
    assert.strictEqual(g.nodeById.get('p10').degree, 2, 'tagged montreal and 2026');
    assert.strictEqual(g.nodeById.get('p11').degree, 1);
  });

  test('neighbours are symmetric', () => {
    const g = makeGraph();
    assert.ok(g.neighbors.get('t2').has('t3'));
    assert.ok(g.neighbors.get('t3').has('t2'), 'edges must be walkable both ways');
  });

  test('an edge naming a tag that does not exist is dropped, not fatal', () => {
    const g = makeGraph({
      tags: [{ id: 1, name: 'T', slug: 't', post_count: 0 }],
      posts: [],
      hierarchyEdges: [{ parent: 1, child: 999 }],
      membershipEdges: [{ post: 999, tag: 1 }],
    });
    assert.strictEqual(g.links.length, 0);
    assert.strictEqual(g.nodeById.get('t1').degree, 0);
  });

  test('an empty payload builds an empty graph rather than throwing', () => {
    const g = makeGraph({});
    assert.strictEqual(g.nodes.length, 0);
    assert.strictEqual(g.links.length, 0);
    assert.strictEqual(g._bounds(), null);
  });

  test('the initial scatter is deterministic across builds', () => {
    // A seeded PRNG, so a reload lands the layout in the same place instead of
    // reshuffling the graph under the reader.
    const a = makeGraph().nodes.map((n) => [n.x, n.y]);
    const b = makeGraph().nodes.map((n) => [n.x, n.y]);
    assert.deepStrictEqual(a, b);
  });

  test('every node starts inside the viewport, at rest', () => {
    for (const n of makeGraph().nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), 'placed at a real point');
      assert.strictEqual(n.vx, 0);
      assert.strictEqual(n.vy, 0);
    }
  });
});

// ── Node radius ──────────────────────────────────────────────────────────────

/**
 * Radius scales with degree so the busy tags read as hubs, but it is clamped at
 * both ends: an isolated node still has to be clickable, and a tag on every
 * post must not swallow the canvas.
 */
describe('node radius', () => {
  test('grows with degree', () => {
    const g = makeGraph();
    assert.ok(g.nodeById.get('t3').r > g.nodeById.get('t1').r, 'the hub is bigger');
  });

  test('posts are drawn smaller than tags at the same degree', () => {
    const g = makeGraph({
      tags: [{ id: 1, name: 'T', slug: 't', post_count: 0 }],
      posts: [{ id: 1, title: 'P', slug: 'p' }],
      membershipEdges: [{ post: 1, tag: 1 }],
    });
    assert.ok(g.nodeById.get('p1').r < g.nodeById.get('t1').r);
  });

  test('a lone node is still big enough to hit', () => {
    const g = makeGraph({ tags: [{ id: 1, name: 'T', slug: 't', post_count: 0 }] });
    assert.ok(g.nodeById.get('t1').r >= 6);
  });

  test('a hub is capped', () => {
    const tags = [{ id: 1, name: 'Hub', slug: 'hub', post_count: 0 }];
    const posts = [];
    const membershipEdges = [];
    for (let i = 2; i < 500; i++) {
      posts.push({ id: i, title: `p${i}`, slug: `p${i}` });
      membershipEdges.push({ post: i, tag: 1 });
    }
    const g = makeGraph({ tags, posts, membershipEdges });
    assert.ok(g.nodeById.get('t1').r <= 36, 'tag radius is clamped');
    assert.ok(g.nodes.every((n) => n.type !== 'post' || n.r <= 11), 'post radius is clamped');
  });
});

// ── Visible set / legend toggles ─────────────────────────────────────────────

/**
 * The legend hides a whole node kind. Everything downstream — physics, drawing,
 * hit-testing, fit-to-view — runs off the active set, so hiding a kind has to
 * drop its links too: a link with one hidden endpoint would otherwise be drawn
 * running to nothing.
 */
describe('hidden types', () => {
  test('nothing is hidden to begin with', () => {
    const g = makeGraph();
    assert.strictEqual(g._aNodes.length, 6);
    assert.strictEqual(g._aLinks.length, 5);
  });

  test('hiding posts drops their nodes and their edges', () => {
    const g = makeGraph();
    g.setTypeHidden('post', true);
    assert.strictEqual(g._aNodes.length, 4);
    assert.ok(g._aNodes.every((n) => n.type !== 'post'));
    assert.strictEqual(g._aLinks.length, 2, 'only the two hierarchy edges survive');
  });

  test('unhiding restores them', () => {
    const g = makeGraph();
    g.setTypeHidden('post', true);
    g.setTypeHidden('post', false);
    assert.strictEqual(g._aNodes.length, 6);
    assert.strictEqual(g._aLinks.length, 5);
  });

  test('hiding the kind of the selected node clears the selection', () => {
    const g = makeGraph();
    let announced = 'untouched';
    g.onSelect = (n) => { announced = n; };
    g.selectNodeBySlug('2026');
    assert.ok(g.selected, 'precondition: something is selected');

    g.setTypeHidden('year', true);
    assert.strictEqual(g.selected, null, 'a hidden node must not stay selected');
    assert.strictEqual(announced, null, 'and the page must be told');
  });

  test('hiding an unrelated kind leaves the selection alone', () => {
    const g = makeGraph();
    g.selectNodeBySlug('2026');
    g.setTypeHidden('post', true);
    assert.strictEqual(g.selected.slug, '2026');
  });

  test('hiding the hovered kind clears the hover', () => {
    const g = makeGraph();
    g.hovered = g.nodeById.get('t4');
    g.setTypeHidden('year', true);
    assert.strictEqual(g.hovered, null);
  });

  test('hiding reheats the layout so the rest can close the gap', () => {
    const g = makeGraph();
    g.alpha = 0;
    g.setTypeHidden('post', true);
    assert.ok(g.alpha >= 0.25);
  });
});

// ── Selection by slug ────────────────────────────────────────────────────────

/**
 * The page selects a node when the URL names a tag. Posts are excluded on
 * purpose: a post and a tag can share a slug, and /tags/<slug> means the tag.
 */
describe('selectNodeBySlug', () => {
  test('selects the tag with that slug', () => {
    const g = makeGraph();
    const n = g.selectNodeBySlug('canada');
    assert.strictEqual(n.id, 't2');
    assert.strictEqual(g.selected, n);
  });

  test('never selects a post, even on an exact slug match', () => {
    const g = makeGraph({
      tags: [{ id: 1, name: 'Walk', slug: 'a-walk', post_count: 1 }],
      posts: [{ id: 10, title: 'A walk', slug: 'a-walk' }],
    });
    assert.strictEqual(g.selectNodeBySlug('a-walk').type, 'tag');
  });

  test('an unknown slug selects nothing and reports it', () => {
    const g = makeGraph();
    assert.strictEqual(g.selectNodeBySlug('nope'), undefined);
    assert.strictEqual(g.selected, null);
  });

  test('an empty slug clears the selection', () => {
    const g = makeGraph();
    g.selectNodeBySlug('canada');
    assert.strictEqual(g.selectNodeBySlug(''), null);
    assert.strictEqual(g.selected, null);
  });
});

// ── Search filter ────────────────────────────────────────────────────────────

describe('setFilter', () => {
  test('matches tag names case-insensitively, on a substring', () => {
    const g = makeGraph();
    g.setFilter('CANA');
    assert.deepStrictEqual([...g.filterSet], ['t2']);
  });

  test('never matches posts — the search is for tags', () => {
    const g = makeGraph();
    g.setFilter('walk');
    assert.strictEqual(g.filterSet.size, 0, 'the post titled "A walk" must not match');
  });

  test('an empty or blank query clears the filter entirely', () => {
    const g = makeGraph();
    g.setFilter('canada');
    g.setFilter('   ');
    assert.strictEqual(g.filterSet, null, 'blank must mean "no filter", not "matches nothing"');
    g.setFilter('canada');
    g.setFilter('');
    assert.strictEqual(g.filterSet, null);
  });

  test('matches across accents as typed', () => {
    const g = makeGraph();
    g.setFilter('montré');
    assert.deepStrictEqual([...g.filterSet], ['t3']);
  });
});

// ── Focus expansion ──────────────────────────────────────────────────────────

/**
 * Hovering a tag lights its direct neighbours and then takes a second hop:
 * through each adjacent post out to the *other* tags carrying that post. That
 * second wave is what makes "these two tags co-occur" visible, and those tags
 * are returned separately so they can be ringed differently from direct
 * neighbours.
 */
describe('focus expansion', () => {
  test('a tag lights its neighbours and the tags its posts also carry', () => {
    const g = makeGraph();
    const { focus, related } = g._expandFocus(['t3']); // Montréal

    assert.ok(focus.has('t2'), 'parent Canada is a direct neighbour');
    assert.ok(focus.has('p10') && focus.has('p11'), 'its posts');
    assert.ok(focus.has('t4'), '2026 shares post 10 — reached on the second hop');
    assert.deepStrictEqual([...related], ['t4'], 'only the second-wave tag is "related"');
  });

  test('the seed is in focus but is not related to itself', () => {
    const g = makeGraph();
    const { focus, related } = g._expandFocus(['t3']);
    assert.ok(focus.has('t3'));
    assert.ok(!related.has('t3'));
  });

  test('a post seed lights only its own tags — no second hop', () => {
    const g = makeGraph();
    const { focus, related } = g._expandFocus(['p10']);
    assert.ok(focus.has('t3') && focus.has('t4'));
    assert.ok(!focus.has('p11'), 'must not walk back out to sibling posts');
    assert.strictEqual(related.size, 0);
  });

  test('an isolated node lights only itself', () => {
    const g = makeGraph({ tags: [{ id: 1, name: 'Lonely', slug: 'lonely', post_count: 0 }] });
    const { focus, related } = g._expandFocus(['t1']);
    assert.deepStrictEqual([...focus], ['t1']);
    assert.strictEqual(related.size, 0);
  });

  test('a selection wins over a live hover, so the highlight stays put', () => {
    const g = makeGraph();
    g.hovered = g.nodeById.get('t1');
    g.selected = g.nodeById.get('t3');
    assert.ok(g._focusSets().focus.has('p10'), 'focus follows the selection, not the hover');
  });

  test('with neither hover nor selection, the filter drives the highlight', () => {
    const g = makeGraph();
    g.setFilter('canada');
    assert.ok(g._focusSets().focus.has('t2'));
  });

  test('nothing hovered, selected or filtered means nothing is dimmed', () => {
    assert.strictEqual(makeGraph()._focusSets(), null);
  });
});

// ── Selection stats ──────────────────────────────────────────────────────────

describe('getSelectionStats', () => {
  test('counts the posts and the other tags in reach', () => {
    const g = makeGraph();
    g.selectNodeBySlug('montreal');
    assert.deepStrictEqual(g.getSelectionStats(), { tagCount: 2, postCount: 2 });
  });

  test('the selected tag is not counted among its own tags', () => {
    const g = makeGraph();
    g.selectNodeBySlug('location');
    const { tagCount } = g.getSelectionStats();
    assert.strictEqual(tagCount, 1, 'only Canada — Location itself is excluded');
  });

  test('no selection, no stats', () => {
    assert.strictEqual(makeGraph().getSelectionStats(), null);
  });
});

// ── Bounds, fit and the screen↔world transform ───────────────────────────────

/**
 * The view maths. world→screen is `s * scale + t`, and every reverse lookup
 * (hit-testing, zoom-at-cursor, drag) depends on _screenToWorld being its exact
 * inverse — if it drifts, clicks land next to the node the user aimed at.
 */
describe('view transform', () => {
  let g;
  beforeEach(() => { g = makeGraph(); });

  test('bounds cover every visible node including its radius', () => {
    const b = g._bounds();
    for (const n of g._aNodes) {
      assert.ok(n.x - n.r >= b.minX - 1e-9 && n.x + n.r <= b.maxX + 1e-9);
      assert.ok(n.y - n.r >= b.minY - 1e-9 && n.y + n.r <= b.maxY + 1e-9);
    }
  });

  test('bounds ignore hidden nodes', () => {
    const before = g._bounds();
    g.setTypeHidden('post', true);
    const after = g._bounds();
    assert.ok(
      after.minX >= before.minX && after.maxX <= before.maxX,
      'hiding nodes can only shrink the box',
    );
  });

  test('screenToWorld inverts the transform exactly', () => {
    g.scale = 1.7;
    g.tx = 42;
    g.ty = -13;
    const w = g._screenToWorld(300, 200);
    assert.ok(Math.abs(w.x * g.scale + g.tx - 300) < 1e-9);
    assert.ok(Math.abs(w.y * g.scale + g.ty - 200) < 1e-9);
  });

  test('fit-to-view centres the graph in the viewport', () => {
    g._fitToView();
    const b = g._bounds();
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    assert.ok(Math.abs(cx * g.scale + g.tx - 800 / 2) < 1e-6);
    assert.ok(Math.abs(cy * g.scale + g.ty - 520 / 2) < 1e-6);
  });

  test('after fitting, every node is on screen', () => {
    g._fitToView();
    for (const n of g._aNodes) {
      const sx = n.x * g.scale + g.tx;
      const sy = n.y * g.scale + g.ty;
      assert.ok(sx >= 0 && sx <= 800, `node off screen horizontally: ${sx}`);
      assert.ok(sy >= 0 && sy <= 520, `node off screen vertically: ${sy}`);
    }
  });

  test('an empty graph has a usable fallback scale', () => {
    const empty = makeGraph({});
    assert.strictEqual(empty._fitScale(), 0.2);
  });

  test('fit scale is clamped for a graph that is a single point', () => {
    const one = makeGraph({ tags: [{ id: 1, name: 'T', slug: 't', post_count: 0 }] });
    assert.ok(one._fitScale() <= 4, 'must not zoom to absurdity on one node');
  });
});

// ── Zoom ─────────────────────────────────────────────────────────────────────

describe('zoom', () => {
  test('keeps the point under the cursor fixed', () => {
    const g = makeGraph();
    g._fitToView();
    const before = g._screenToWorld(300, 200);
    g._zoomAt(300, 200, 1.5);
    const after = g._screenToWorld(300, 200);
    assert.ok(Math.abs(before.x - after.x) < 1e-9, 'zoom anchored at the cursor');
    assert.ok(Math.abs(before.y - after.y) < 1e-9);
  });

  test('will not zoom out past "everything visible"', () => {
    const g = makeGraph();
    g._fitToView();
    for (let i = 0; i < 40; i++) g._zoomAt(400, 260, 0.5);
    assert.ok(g.scale >= g._fitScale() - 1e-9, 'clamped at the fit scale');
  });

  test('zooming in is capped', () => {
    const g = makeGraph();
    for (let i = 0; i < 60; i++) g._zoomAt(400, 260, 2);
    assert.ok(g.scale <= 6);
  });

  test('zooming hands the view over to the user', () => {
    const g = makeGraph();
    assert.strictEqual(g._userView, false);
    g.zoomBy(1.2);
    assert.strictEqual(g._userView, true, 'auto-framing must stop fighting the user');
    assert.strictEqual(g._needFit, false);
  });

  test('resetView resumes auto-framing', () => {
    const g = makeGraph();
    g.zoomBy(1.2);
    g.resetView();
    assert.strictEqual(g._userView, false);
    assert.strictEqual(g._needFit, true);
  });
});

// ── Hit testing ──────────────────────────────────────────────────────────────

/**
 * Picking is done in world space against each node's radius plus a 3px forgiving
 * margin. When two nodes overlap the nearer centre wins, so the node whose
 * middle you aimed at is the one you get.
 */
describe('hit testing', () => {
  /** Place nodes by hand — the force layout's positions are not the subject. */
  function positioned() {
    const g = makeGraph();
    g.scale = 1;
    g.tx = 0;
    g.ty = 0;
    g.nodes.forEach((n, i) => { n.x = i * 100; n.y = 100; n.r = 10; });
    return g;
  }

  test('a click on a node centre picks it', () => {
    const g = positioned();
    assert.strictEqual(g._pickNode(100, 100).id, g.nodes[1].id);
  });

  test('a click just inside the rim picks it', () => {
    const g = positioned();
    assert.ok(g._pickNode(109, 100), 'r=10, so 9px out is a hit');
  });

  test('a click just outside the rim misses', () => {
    const g = positioned();
    // r=10 plus the 3px forgiving margin, so 14px out must not register —
    // otherwise the gaps between nodes stop being clickable empty space and a
    // tap meant to clear the selection opens something instead.
    assert.strictEqual(g._pickNode(114, 100), null);
  });

  test('the forgiving margin does not swallow the neighbouring node', () => {
    const g = positioned();
    // Midway between two nodes 100px apart is nobody's.
    assert.strictEqual(g._pickNode(150, 100), null);
  });

  test('a click well outside every node picks nothing', () => {
    const g = positioned();
    assert.strictEqual(g._pickNode(50, 400), null);
  });

  test('picking honours the pan and zoom in force', () => {
    const g = positioned();
    g.scale = 2;
    g.tx = 30;
    g.ty = -10;
    // World (100,100) is now at screen (230,190).
    assert.strictEqual(g._pickNode(230, 190).id, g.nodes[1].id);
    assert.strictEqual(g._pickNode(100, 100), null, 'the old screen point is empty now');
  });

  test('overlapping nodes resolve to the nearer centre', () => {
    const g = positioned();
    g.nodes[0].x = 100;
    g.nodes[0].y = 100; // exactly on top of nodes[1]
    g.nodes[0].r = 10;
    assert.strictEqual(g._pickNode(103, 100).id, g.nodes[0].id, 'ties broken by distance');
  });

  test('a hidden node cannot be clicked', () => {
    const g = positioned();
    const post = g.nodes.find((n) => n.type === 'post');
    post.x = 500;
    post.y = 300;
    post.r = 10;
    assert.ok(g._pickNode(500, 300), 'precondition: hittable while visible');

    g.setTypeHidden('post', true);
    g.nodes.forEach((n, i) => { n.x = i * 100; n.y = 100; n.r = 10; });
    post.x = 500;
    post.y = 300;
    assert.strictEqual(g._pickNode(500, 300), null, 'hidden nodes are out of the active set');
  });
});

// ── Navigation ───────────────────────────────────────────────────────────────

describe('navigation targets', () => {
  test('a tag node opens its tag page', () => {
    let href = null;
    const g = makeGraph(FIXTURE, { onNavigate: (h) => { href = h; } });
    g._navigateTo(g.nodeById.get('t2'));
    assert.strictEqual(href, '/tags/canada');
  });

  test('a geo or year node is still a tag page', () => {
    const seen = [];
    const g = makeGraph(FIXTURE, { onNavigate: (h) => seen.push(h) });
    g._navigateTo(g.nodeById.get('t3'));
    g._navigateTo(g.nodeById.get('t4'));
    assert.deepStrictEqual(seen, ['/tags/montreal', '/tags/2026']);
  });

  test('a post node opens the post', () => {
    let href = null;
    const g = makeGraph(FIXTURE, { onNavigate: (h) => { href = h; } });
    g._navigateTo(g.nodeById.get('p10'));
    assert.strictEqual(href, '/posts/a-walk');
  });
});

// ── Force layout ─────────────────────────────────────────────────────────────

/**
 * One step of the simulation. Four forces act per tick: pairwise repulsion
 * (cut off by distance, bucketed through a spatial grid), springs along the
 * links, gravity toward the viewport centre, and a collision pass that pushes
 * overlapping rims apart.
 *
 * These assert direction and invariants, not exact positions — the constants
 * are tuned by eye and pinning coordinates would make every future tweak a
 * test failure.
 */
describe('force layout', () => {
  /** A graph with hand-placed nodes, so the assertion is about one force. */
  function laidOut(data, place) {
    const g = makeGraph(data);
    g.alpha = 1;
    place(g);
    return g;
  }

  const twoTags = {
    tags: [
      { id: 1, name: 'A', slug: 'a', post_count: 0 },
      { id: 2, name: 'B', slug: 'b', post_count: 0 },
    ],
  };
  const twoLinkedTags = { ...twoTags, hierarchyEdges: [{ parent: 1, child: 2 }] };

  const gap = (g) => Math.hypot(
    g.nodeById.get('t1').x - g.nodeById.get('t2').x,
    g.nodeById.get('t1').y - g.nodeById.get('t2').y,
  );

  test('unlinked neighbours repel', () => {
    const g = laidOut(twoTags, (g) => {
      Object.assign(g.nodeById.get('t1'), { x: 400, y: 260, vx: 0, vy: 0 });
      Object.assign(g.nodeById.get('t2'), { x: 430, y: 260, vx: 0, vy: 0 });
    });
    const before = gap(g);
    g._tick();
    assert.ok(gap(g) > before, 'nodes with nothing in common should spread out');
  });

  test('repulsion is cut off, so distant nodes do not feel each other', () => {
    // Beyond REPULSION_CUTOFF the pair is skipped entirely; what movement is
    // left comes from gravity, which pulls both toward the same centre.
    const g = laidOut(twoTags, (g) => {
      Object.assign(g.nodeById.get('t1'), { x: -5000, y: 260, vx: 0, vy: 0 });
      Object.assign(g.nodeById.get('t2'), { x: 5000, y: 260, vx: 0, vy: 0 });
    });
    const before = gap(g);
    g._tick();
    assert.ok(gap(g) < before, 'far apart, only gravity acts — they close in');
  });

  test('a stretched link pulls its ends together', () => {
    const g = laidOut(twoLinkedTags, (g) => {
      Object.assign(g.nodeById.get('t1'), { x: 100, y: 260, vx: 0, vy: 0 });
      Object.assign(g.nodeById.get('t2'), { x: 700, y: 260, vx: 0, vy: 0 });
    });
    const before = gap(g);
    g._tick();
    assert.ok(gap(g) < before, 'the spring should contract');
  });

  test('a membership link is slacker than a hierarchy link', () => {
    // Posts sit closer to their tags than child tags sit to their parents, so
    // the hierarchy reads as the graph's skeleton.
    const hier = laidOut(twoLinkedTags, (g) => {
      Object.assign(g.nodeById.get('t1'), { x: 400, y: 260, vx: 0, vy: 0 });
      Object.assign(g.nodeById.get('t2'), { x: 400, y: 460, vx: 0, vy: 0 });
    });
    const memb = laidOut(
      {
        tags: [{ id: 1, name: 'A', slug: 'a', post_count: 0 }],
        posts: [{ id: 2, title: 'P', slug: 'p' }],
        membershipEdges: [{ post: 2, tag: 1 }],
      },
      (g) => {
        Object.assign(g.nodeById.get('t1'), { x: 400, y: 260, vx: 0, vy: 0 });
        Object.assign(g.nodeById.get('p2'), { x: 400, y: 460, vx: 0, vy: 0 });
      },
    );
    for (let i = 0; i < 200; i++) { hier._tick(); memb._tick(); }
    const hierGap = gap(hier);
    const membGap = Math.hypot(
      memb.nodeById.get('t1').x - memb.nodeById.get('p2').x,
      memb.nodeById.get('t1').y - memb.nodeById.get('p2').y,
    );
    assert.ok(hierGap > membGap, `hierarchy ${hierGap} should rest wider than membership ${membGap}`);
  });

  test('gravity pulls a stray node back toward the centre', () => {
    const g = laidOut({ tags: [{ id: 1, name: 'A', slug: 'a', post_count: 0 }] }, (g) => {
      Object.assign(g.nodeById.get('t1'), { x: 4000, y: 3000, vx: 0, vy: 0 });
    });
    const n = g.nodeById.get('t1');
    g._tick();
    assert.ok(n.x < 4000 && n.y < 3000, 'nothing should drift off forever');
  });

  test('collision separates overlapping nodes', () => {
    // alpha=0 silences repulsion, springs and gravity — all are scaled by it —
    // leaving the collision pass as the only thing that can move a node. Run
    // with alpha up and repulsion alone would hide a broken collision pass.
    const g = laidOut(twoTags, (g) => {
      Object.assign(g.nodeById.get('t1'), { x: 400, y: 260, vx: 0, vy: 0 });
      Object.assign(g.nodeById.get('t2'), { x: 402, y: 260, vx: 0, vy: 0 });
    });
    g.alpha = 0;
    for (let i = 0; i < 50; i++) g._tick();
    const a = g.nodeById.get('t1');
    const b = g.nodeById.get('t2');
    assert.ok(
      gap(g) >= a.r + b.r + 8 - 1e-6,
      `rims must end up a pad apart, got ${gap(g)} for radii ${a.r}/${b.r}`,
    );
  });

  test('collision leaves nodes that already clear each other alone', () => {
    const g = laidOut(twoTags, (g) => {
      Object.assign(g.nodeById.get('t1'), { x: 400, y: 260, vx: 0, vy: 0 });
      Object.assign(g.nodeById.get('t2'), { x: 700, y: 260, vx: 0, vy: 0 });
    });
    g.alpha = 0;
    g._tick();
    assert.strictEqual(g.nodeById.get('t1').x, 400, 'no phantom shove');
    assert.strictEqual(g.nodeById.get('t2').x, 700);
  });

  test('a settled layout stops moving once alpha reaches zero', () => {
    const g = makeGraph();
    for (let i = 0; i < 300; i++) { g.alpha *= 0.95; g._tick(); }
    g.alpha = 0;
    const before = g.nodes.map((n) => [n.x, n.y]);
    g._tick();
    const after = g.nodes.map((n) => [n.x, n.y]);
    for (let i = 0; i < before.length; i++) {
      assert.ok(Math.abs(before[i][0] - after[i][0]) < 0.5, 'a cold layout should be still');
      assert.ok(Math.abs(before[i][1] - after[i][1]) < 0.5);
    }
  });

  test('the layout stays finite over a long run', () => {
    const g = makeGraph();
    for (let i = 0; i < 500; i++) g._tick();
    for (const n of g.nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} left the plane`);
    }
  });

  test('a node held by the pointer is not moved by the forces', () => {
    const g = makeGraph();
    const held = g.nodeById.get('t1');
    held.x = 123;
    held.y = 456;
    g.dragNode = held;
    g.alpha = 1;
    g._tick();
    assert.strictEqual(held.x, 123, 'the dragged node follows the finger, not the physics');
    assert.strictEqual(held.y, 456);
  });
});

// ── Pointer gestures ─────────────────────────────────────────────────────────

/**
 * One pointer on a node drags it; one on empty space pans the view; two pinch.
 * A press that neither moves far nor lasts long is a tap, and taps are the
 * two-stage select-then-open interaction: the first lights the node up (so its
 * highlighted connections can be followed and clicked), the second opens it.
 */
describe('pointer gestures', () => {
  const down = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, pointerType: 'mouse' });

  /** Nodes on a known grid so a coordinate means a specific node. */
  function positioned(opts = {}) {
    const g = makeGraph(FIXTURE, opts);
    g.scale = 1;
    g.tx = 0;
    g.ty = 0;
    g.nodes.forEach((n, i) => { n.x = i * 100 + 50; n.y = 100; n.r = 10; });
    return g;
  }

  test('pressing a node starts a drag, not a pan', () => {
    const g = positioned();
    g._pointerDown(down(1, 50, 100));
    assert.strictEqual(g.dragNode, g.nodes[0]);
    assert.strictEqual(g.panning, false);
  });

  test('pressing empty space starts a pan', () => {
    const g = positioned();
    g._pointerDown(down(1, 400, 400));
    assert.strictEqual(g.dragNode, null);
    assert.strictEqual(g.panning, true);
  });

  test('dragging moves the node to the cursor and kills its momentum', () => {
    const g = positioned();
    g._pointerDown(down(1, 50, 100));
    g._pointerMove(down(1, 300, 320));
    assert.strictEqual(g.nodes[0].x, 300);
    assert.strictEqual(g.nodes[0].y, 320);
    assert.strictEqual(g.nodes[0].vx, 0, 'no leftover velocity to fling it away');
  });

  test('panning translates the view by the cursor delta', () => {
    const g = positioned();
    g._pointerDown(down(1, 400, 400));
    g._pointerMove(down(1, 450, 380));
    assert.strictEqual(g.tx, 50);
    assert.strictEqual(g.ty, -20);
  });

  test('a first tap selects the node and announces it', () => {
    let selected = 'untouched';
    const g = positioned({ onSelect: (n) => { selected = n; } });
    g._pointerDown(down(1, 50, 100));
    g._pointerUp(down(1, 50, 100));
    assert.strictEqual(g.selected, g.nodes[0]);
    assert.strictEqual(selected, g.nodes[0]);
  });

  test('a second tap on the same node opens it', () => {
    let href = null;
    const g = positioned({ onNavigate: (h) => { href = h; } });
    g._pointerDown(down(1, 50, 100));
    g._pointerUp(down(1, 50, 100));
    assert.strictEqual(href, null, 'the first tap must not navigate');

    g._pointerDown(down(1, 50, 100));
    g._pointerUp(down(1, 50, 100));
    assert.strictEqual(href, '/tags/location');
  });

  test('tapping a different node moves the selection instead of opening', () => {
    let href = null;
    const g = positioned({ onNavigate: (h) => { href = h; } });
    g._pointerDown(down(1, 50, 100));
    g._pointerUp(down(1, 50, 100));
    g._pointerDown(down(1, 150, 100));
    g._pointerUp(down(1, 150, 100));
    assert.strictEqual(href, null);
    assert.strictEqual(g.selected, g.nodes[1]);
  });

  test('tapping empty space clears the selection', () => {
    const cleared = [];
    const g = positioned({ onSelect: (n) => cleared.push(n) });
    g._pointerDown(down(1, 50, 100));
    g._pointerUp(down(1, 50, 100));
    g._pointerDown(down(1, 600, 400));
    g._pointerUp(down(1, 600, 400));
    assert.strictEqual(g.selected, null);
    assert.strictEqual(cleared.at(-1), null);
  });

  test('a drag past the slop is not a tap', () => {
    let href = null;
    const g = positioned({ onNavigate: (h) => { href = h; } });
    g._pointerDown(down(1, 50, 100));
    g._pointerUp(down(1, 50, 100)); // select it
    g._pointerDown(down(1, 50, 100));
    g._pointerMove(down(1, 300, 300)); // now drag it away
    assert.strictEqual(g._moved, true, 'travel past the slop must mark the gesture a drag');
    g._pointerUp(down(1, 300, 300));
    assert.strictEqual(href, null, 'dragging a selected node must not open it');
  });

  test('jitter under the slop still counts as a tap', () => {
    const g = positioned();
    g._pointerDown(down(1, 50, 100));
    g._pointerMove(down(1, 53, 102)); // ~4px — a shaky finger, not a drag
    assert.strictEqual(g._moved, false, 'sub-slop jitter is not a drag');
    g._pointerUp(down(1, 53, 102));
    assert.strictEqual(g.selected, g.nodes[0], 'a stationary press must survive jitter');
  });

  test('the slop is small enough that a deliberate drag clears it', () => {
    const g = positioned();
    g._pointerDown(down(1, 400, 400)); // empty space — a pan
    g._pointerMove(down(1, 418, 400)); // 18px: past the 10px slop
    assert.strictEqual(g._moved, true);
    assert.strictEqual(g._userView, true, 'a deliberate pan takes the view over');
  });

  test('a long press is not a tap', () => {
    const g = positioned();
    g._pointerDown(down(1, 50, 100));
    g._downTime = Date.now() - 800;
    g._pointerUp(down(1, 50, 100));
    assert.strictEqual(g.selected, null);
  });

  test('hovering a node reports it and changes the cursor', () => {
    const seen = [];
    const g = positioned({ onHover: (n) => seen.push(n) });
    g._pointerMove(down(9, 50, 100));
    assert.strictEqual(g.hovered, g.nodes[0]);
    assert.strictEqual(g.canvas.style.cursor, 'pointer');

    g._pointerMove(down(9, 600, 400));
    assert.strictEqual(g.hovered, null);
    assert.strictEqual(g.canvas.style.cursor, 'grab');
    assert.deepStrictEqual(seen, [g.nodes[0], null]);
  });

  test('hover is only announced when it actually changes', () => {
    const seen = [];
    const g = positioned({ onHover: (n) => seen.push(n) });
    g._pointerMove(down(9, 50, 100));
    g._pointerMove(down(9, 52, 100)); // same node
    assert.strictEqual(seen.length, 1, 'no redundant redraws while sitting on one node');
  });

  test('a second finger cancels the drag and begins a pinch', () => {
    const g = positioned();
    g._pointerDown(down(1, 50, 100));
    assert.ok(g.dragNode, 'precondition: one finger is dragging');

    g._pointerDown(down(2, 250, 100));
    assert.strictEqual(g.dragNode, null, 'a pinch must not also drag the node');
    assert.strictEqual(g.panning, false);
    assert.ok(g._pinch);
  });

  test('spreading the fingers zooms in', () => {
    const g = positioned();
    g._fitToView();
    g._pointerDown(down(1, 300, 200));
    g._pointerDown(down(2, 400, 200));
    const before = g.scale;
    g._pointerMove(down(1, 250, 200));
    g._pointerMove(down(2, 450, 200)); // distance 100 -> 200
    assert.ok(g.scale > before, 'a spread should magnify');
    assert.ok(Math.abs(g.scale - before * 2) < 1e-6, 'scale follows the finger-distance ratio');
  });

  test('a pinch cannot zoom out past "everything visible"', () => {
    const g = positioned();
    g._fitToView();
    g._pointerDown(down(1, 200, 200));
    g._pointerDown(down(2, 600, 200));
    g._pointerMove(down(1, 399, 200));
    g._pointerMove(down(2, 401, 200)); // pinch almost shut
    assert.ok(g.scale >= g._fitScale() - 1e-9);
  });

  test('lifting one finger hands the gesture back to panning, without a jump', () => {
    const g = positioned();
    g._pointerDown(down(1, 300, 200));
    g._pointerDown(down(2, 400, 200));
    g._pointerUp(down(2, 400, 200));

    assert.strictEqual(g._pinch, null);
    assert.strictEqual(g.panning, true, 'the remaining finger keeps panning');
    const tx = g.tx;
    g._pointerMove(down(1, 300, 200)); // same place: the view must not lurch
    assert.strictEqual(g.tx, tx);
  });

  test('a pinch never ends in a tap', () => {
    let href = null;
    const g = positioned({ onNavigate: (h) => { href = h; } });
    g._pointerDown(down(1, 50, 100));
    g._pointerUp(down(1, 50, 100)); // select the node
    g._pointerDown(down(1, 50, 100));
    g._pointerDown(down(2, 250, 100)); // second finger
    g._pointerUp(down(2, 250, 100));
    g._pointerUp(down(1, 50, 100));
    assert.strictEqual(href, null, 'ending a pinch on a node must not open it');
  });

  test('touching the canvas stops the auto-framing', () => {
    const g = positioned();
    g._needFit = true;
    g._pointerDown(down(1, 400, 400));
    assert.strictEqual(g._needFit, false, 'the view must not jump under the user');
  });
});

// ── Wheel zoom ───────────────────────────────────────────────────────────────

describe('wheel zoom', () => {
  const wheel = (deltaY) => {
    let prevented = false;
    return {
      event: { clientX: 400, clientY: 260, deltaY, preventDefault: () => { prevented = true; } },
      wasPrevented: () => prevented,
    };
  };

  test('scrolling up zooms in, down zooms out', () => {
    const g = makeGraph();
    g._fitToView();
    const start = g.scale;
    g._wheel(wheel(-100).event);
    const zoomedIn = g.scale;
    assert.ok(zoomedIn > start);

    g._wheel(wheel(100).event);
    assert.ok(g.scale < zoomedIn);
  });

  test('the page does not scroll behind the graph', () => {
    const g = makeGraph();
    const w = wheel(-100);
    g._wheel(w.event);
    assert.ok(w.wasPrevented(), 'the canvas must claim the wheel event');
  });

  test('wheel zoom is anchored under the cursor', () => {
    const g = makeGraph();
    g._fitToView();
    const before = g._screenToWorld(400, 260);
    g._wheel(wheel(-100).event);
    const after = g._screenToWorld(400, 260);
    assert.ok(Math.abs(before.x - after.x) < 1e-9);
    assert.ok(Math.abs(before.y - after.y) < 1e-9);
  });
});

// ── Reduced motion ───────────────────────────────────────────────────────────

/**
 * prefers-reduced-motion means no visible animation, but the graph is
 * unreadable in its scattered initial state — so the layout is run to
 * completion synchronously and painted once, already settled, instead of
 * animating into place or being skipped entirely.
 */
describe('reduced motion', () => {
  test('settles the layout without animating, then paints once', () => {
    globalThis.__reduceMotion = true;
    try {
      const g = makeGraph();
      const scattered = g.nodes.map((n) => [n.x, n.y]);
      g.start();

      assert.strictEqual(g.alpha, 0, 'the simulation is finished, not paused');
      assert.strictEqual(g._running, false, 'no animation loop was started');
      assert.strictEqual(g._needFit, false, 'already framed');
      assert.notDeepStrictEqual(
        g.nodes.map((n) => [n.x, n.y]),
        scattered,
        'the layout must actually run — a still frame of the initial scatter is not a graph',
      );
      for (const n of g._aNodes) {
        const sx = n.x * g.scale + g.tx;
        assert.ok(sx >= 0 && sx <= 800, 'and it must be framed on screen');
      }
    } finally {
      globalThis.__reduceMotion = false;
    }
  });

  test('with motion allowed, start animates instead', () => {
    const g = makeGraph();
    g.start();
    assert.strictEqual(g._running, true, 'the rAF loop drives it');
    assert.strictEqual(g.alpha, 1, 'starting hot, to settle over time');
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  test('destroy stops the loop and is safe to call twice', () => {
    const g = makeGraph();
    g.destroy();
    assert.strictEqual(g._destroyed, true);
    assert.strictEqual(g._running, false);
    g.destroy();
  });

  test('a destroyed graph will not restart its loop', () => {
    const g = makeGraph();
    g.destroy();
    g._kick();
    assert.strictEqual(g._running, false);
  });

  test('resize sizes the backing store by the device pixel ratio', () => {
    const canvas = stubCanvas({ width: 400, height: 300 });
    const g = new TagGraph(canvas, FIXTURE);
    g.dpr = 2;
    g.resize();
    assert.strictEqual(canvas.width, 800);
    assert.strictEqual(canvas.height, 600);
  });

  test('a canvas with no layout size yet falls back to sane defaults', () => {
    const canvas = stubCanvas({ width: 0, height: 0 });
    const g = new TagGraph(canvas, FIXTURE);
    assert.deepStrictEqual(g._cssSize(), { width: 800, height: 520 });
  });
});
