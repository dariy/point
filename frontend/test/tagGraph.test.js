import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

/**
 * TagGraph is the controller behind the public /tags page: it owns the graph,
 * the view transform and the interaction state, and wires the model, the force
 * layout, the viewport maths, the renderer and the pointer gestures together.
 *
 * Those collaborators are covered on their own (tagGraphModel / tagGraphLayout
 * / tagGraphViewport). What is left here is what only the assembled thing does:
 * legend toggles clearing a selection, the search filter, the highlight in
 * force, framing, the tap-to-select-then-open gesture, and the lifecycle.
 *
 * None of it is observable from the DOM — the whole surface is pixels — so the
 * canvas is stubbed rather than emulated. Drawing is all no-ops; what the tests
 * read is the state the drawing would have used.
 */

let TagGraph;

before(async () => {
  installDomStubs();
  ({ TagGraph } = await import('../src/plugins/tags-graph/tagGraph.js'));
});

// ── Harness ──────────────────────────────────────────────────────────────────

/** A 2D context whose every method is a no-op; the renderer only writes to it. */
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

// ── Visible set / legend toggles ─────────────────────────────────────────────

/**
 * The legend hides a whole node kind. Beyond dropping the nodes and their
 * edges, the controller has to let go of any interaction state pointing at
 * something that just disappeared.
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

  test('a hidden node cannot be clicked', () => {
    const g = makeGraph();
    g.scale = 1;
    g.tx = 0;
    g.ty = 0;
    const post = g.nodes.find((n) => n.type === 'post');
    post.x = 500;
    post.y = 300;
    post.r = 10;
    assert.ok(g._pickNode(500, 300), 'precondition: hittable while visible');

    g.setTypeHidden('post', true);
    assert.strictEqual(g._pickNode(500, 300), null, 'hidden nodes are out of the active set');
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

// ── What drives the highlight ────────────────────────────────────────────────

/**
 * Three things can light the graph up, and they have an order: a click/tap
 * selection locks the highlight (so you can move to a related node and click
 * it), otherwise the live mouse hover drives it, and the search filter is the
 * fallback. The walk itself is graphModel's; this is the precedence.
 */
describe('focus precedence', () => {
  test('a selection wins over a live hover, so the highlight stays put', () => {
    const g = makeGraph();
    g.hovered = g.nodeById.get('t1');
    g.selected = g.nodeById.get('t3');
    assert.ok(g._focusSets().focus.has('p10'), 'focus follows the selection, not the hover');
  });

  test('with nothing selected, the hover drives it', () => {
    const g = makeGraph();
    g.hovered = g.nodeById.get('t3');
    assert.ok(g._focusSets().focus.has('p10'));
  });

  test('with neither hover nor selection, the filter drives the highlight', () => {
    const g = makeGraph();
    g.setFilter('canada');
    assert.ok(g._focusSets().focus.has('t2'));
  });

  test('a filter that matches nothing dims nothing', () => {
    const g = makeGraph();
    g.setFilter('no-such-tag');
    assert.strictEqual(g._focusSets(), null, 'an empty match must not black out the graph');
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

// ── Framing ──────────────────────────────────────────────────────────────────

/**
 * The graph frames itself — on load, once the layout settles, and across
 * viewport changes — but only until the user takes the view over. After that,
 * auto-framing would be the app fighting the reader.
 */
describe('framing', () => {
  let g;
  beforeEach(() => { g = makeGraph(); });

  test('fitting puts every visible node on screen', () => {
    g._fitToView();
    for (const n of g._aNodes) {
      const sx = n.x * g.scale + g.tx;
      const sy = n.y * g.scale + g.ty;
      assert.ok(sx >= 0 && sx <= 800, `node off screen horizontally: ${sx}`);
      assert.ok(sy >= 0 && sy <= 520, `node off screen vertically: ${sy}`);
    }
  });

  test('fitting frames the visible set, ignoring hidden nodes', () => {
    const post = g.nodes.find((n) => n.type === 'post');
    post.x = 100000; // far off to one side
    post.y = 100000;
    g.setTypeHidden('post', true);
    g._fitToView();
    for (const n of g._aNodes) {
      assert.ok(n.x * g.scale + g.tx <= 800, 'a hidden outlier must not shrink the rest away');
    }
  });

  test('an empty graph is framed without throwing', () => {
    const empty = makeGraph({});
    empty._fitToView();
    assert.ok(Number.isFinite(empty.scale));
  });

  test('a resize re-frames the graph', () => {
    g.scale = 0.01;
    g.resize();
    assert.notStrictEqual(g.scale, 0.01, 'the view follows the container');
  });

  test('once the user has zoomed, a resize leaves the view alone', () => {
    g.zoomBy(1.2);
    const scale = g.scale;
    g.resize();
    assert.strictEqual(g.scale, scale, 'the view must not jump under the user');
  });

  test('zooming hands the view over to the user', () => {
    assert.strictEqual(g._userView, false);
    g.zoomBy(1.2);
    assert.strictEqual(g._userView, true, 'auto-framing must stop fighting the user');
    assert.strictEqual(g._needFit, false);
  });

  test('zoomBy is anchored on the middle of the viewport', () => {
    g._fitToView();
    const before = g._screenToWorld(400, 260);
    g.zoomBy(1.4);
    const after = g._screenToWorld(400, 260);
    assert.ok(Math.abs(before.x - after.x) < 1e-9);
    assert.ok(Math.abs(before.y - after.y) < 1e-9);
  });

  test('resetView resumes auto-framing', () => {
    g.zoomBy(1.2);
    g.resetView();
    assert.strictEqual(g._userView, false);
    assert.strictEqual(g._needFit, true);
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

// ── Pointer gestures ─────────────────────────────────────────────────────────

/**
 * One pointer on a node drags it; one on empty space pans the view; two pinch.
 * A press that neither moves far nor lasts long is a tap, and taps are the
 * two-stage select-then-open interaction: the first lights the node up (so its
 * highlighted connections can be followed and clicked), the second opens it.
 *
 * PointerControls recognises the gesture, TagGraph decides what it means, so
 * these run through the assembled pair.
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
    g._controls.pointerDown(down(1, 50, 100));
    assert.strictEqual(g.dragNode, g.nodes[0]);
    assert.strictEqual(g.panning, false);
  });

  test('pressing empty space starts a pan', () => {
    const g = positioned();
    g._controls.pointerDown(down(1, 400, 400));
    assert.strictEqual(g.dragNode, null);
    assert.strictEqual(g.panning, true);
  });

  test('dragging moves the node to the cursor and kills its momentum', () => {
    const g = positioned();
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerMove(down(1, 300, 320));
    assert.strictEqual(g.nodes[0].x, 300);
    assert.strictEqual(g.nodes[0].y, 320);
    assert.strictEqual(g.nodes[0].vx, 0, 'no leftover velocity to fling it away');
  });

  test('panning translates the view by the cursor delta', () => {
    const g = positioned();
    g._controls.pointerDown(down(1, 400, 400));
    g._controls.pointerMove(down(1, 450, 380));
    assert.strictEqual(g.tx, 50);
    assert.strictEqual(g.ty, -20);
  });

  test('a first tap selects the node and announces it', () => {
    let selected = 'untouched';
    const g = positioned({ onSelect: (n) => { selected = n; } });
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerUp(down(1, 50, 100));
    assert.strictEqual(g.selected, g.nodes[0]);
    assert.strictEqual(selected, g.nodes[0]);
  });

  test('a second tap on the same node opens it', () => {
    let href = null;
    const g = positioned({ onNavigate: (h) => { href = h; } });
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerUp(down(1, 50, 100));
    assert.strictEqual(href, null, 'the first tap must not navigate');

    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerUp(down(1, 50, 100));
    assert.strictEqual(href, '/tags/location');
  });

  test('tapping a different node moves the selection instead of opening', () => {
    let href = null;
    const g = positioned({ onNavigate: (h) => { href = h; } });
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerUp(down(1, 50, 100));
    g._controls.pointerDown(down(1, 150, 100));
    g._controls.pointerUp(down(1, 150, 100));
    assert.strictEqual(href, null);
    assert.strictEqual(g.selected, g.nodes[1]);
  });

  test('tapping empty space clears the selection', () => {
    const cleared = [];
    const g = positioned({ onSelect: (n) => cleared.push(n) });
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerUp(down(1, 50, 100));
    g._controls.pointerDown(down(1, 600, 400));
    g._controls.pointerUp(down(1, 600, 400));
    assert.strictEqual(g.selected, null);
    assert.strictEqual(cleared.at(-1), null);
  });

  test('a drag past the slop is not a tap', () => {
    let href = null;
    const g = positioned({ onNavigate: (h) => { href = h; } });
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerUp(down(1, 50, 100)); // select it
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerMove(down(1, 300, 300)); // now drag it away
    assert.strictEqual(g._controls._moved, true, 'travel past the slop must mark the gesture a drag');
    g._controls.pointerUp(down(1, 300, 300));
    assert.strictEqual(href, null, 'dragging a selected node must not open it');
  });

  test('jitter under the slop still counts as a tap', () => {
    const g = positioned();
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerMove(down(1, 53, 102)); // ~4px — a shaky finger, not a drag
    assert.strictEqual(g._controls._moved, false, 'sub-slop jitter is not a drag');
    g._controls.pointerUp(down(1, 53, 102));
    assert.strictEqual(g.selected, g.nodes[0], 'a stationary press must survive jitter');
  });

  test('the slop is small enough that a deliberate drag clears it', () => {
    const g = positioned();
    g._controls.pointerDown(down(1, 400, 400)); // empty space — a pan
    g._controls.pointerMove(down(1, 418, 400)); // 18px: past the 10px slop
    assert.strictEqual(g._controls._moved, true);
    assert.strictEqual(g._userView, true, 'a deliberate pan takes the view over');
  });

  test('a long press is not a tap', () => {
    const g = positioned();
    g._controls.pointerDown(down(1, 50, 100));
    g._controls._downTime = Date.now() - 800;
    g._controls.pointerUp(down(1, 50, 100));
    assert.strictEqual(g.selected, null);
  });

  test('hovering a node reports it and changes the cursor', () => {
    const seen = [];
    const g = positioned({ onHover: (n) => seen.push(n) });
    g._controls.pointerMove(down(9, 50, 100));
    assert.strictEqual(g.hovered, g.nodes[0]);
    assert.strictEqual(g.canvas.style.cursor, 'pointer');

    g._controls.pointerMove(down(9, 600, 400));
    assert.strictEqual(g.hovered, null);
    assert.strictEqual(g.canvas.style.cursor, 'grab');
    assert.deepStrictEqual(seen, [g.nodes[0], null]);
  });

  test('hover is only announced when it actually changes', () => {
    const seen = [];
    const g = positioned({ onHover: (n) => seen.push(n) });
    g._controls.pointerMove(down(9, 50, 100));
    g._controls.pointerMove(down(9, 52, 100)); // same node
    assert.strictEqual(seen.length, 1, 'no redundant redraws while sitting on one node');
  });

  test('a second finger cancels the drag and begins a pinch', () => {
    const g = positioned();
    g._controls.pointerDown(down(1, 50, 100));
    assert.ok(g.dragNode, 'precondition: one finger is dragging');

    g._controls.pointerDown(down(2, 250, 100));
    assert.strictEqual(g.dragNode, null, 'a pinch must not also drag the node');
    assert.strictEqual(g.panning, false);
    assert.ok(g._controls._pinch);
  });

  test('spreading the fingers zooms in', () => {
    const g = positioned();
    g._fitToView();
    g._controls.pointerDown(down(1, 300, 200));
    g._controls.pointerDown(down(2, 400, 200));
    const before = g.scale;
    g._controls.pointerMove(down(1, 250, 200));
    g._controls.pointerMove(down(2, 450, 200)); // distance 100 -> 200
    assert.ok(g.scale > before, 'a spread should magnify');
    assert.ok(Math.abs(g.scale - before * 2) < 1e-6, 'scale follows the finger-distance ratio');
  });

  test('a pinch cannot zoom out past "everything visible"', () => {
    const g = positioned();
    g._fitToView();
    g._controls.pointerDown(down(1, 200, 200));
    g._controls.pointerDown(down(2, 600, 200));
    g._controls.pointerMove(down(1, 399, 200));
    g._controls.pointerMove(down(2, 401, 200)); // pinch almost shut
    assert.ok(g.scale >= g._fitScale() - 1e-9);
  });

  test('lifting one finger hands the gesture back to panning, without a jump', () => {
    const g = positioned();
    g._controls.pointerDown(down(1, 300, 200));
    g._controls.pointerDown(down(2, 400, 200));
    g._controls.pointerUp(down(2, 400, 200));

    assert.strictEqual(g._controls._pinch, null);
    assert.strictEqual(g.panning, true, 'the remaining finger keeps panning');
    const tx = g.tx;
    g._controls.pointerMove(down(1, 300, 200)); // same place: the view must not lurch
    assert.strictEqual(g.tx, tx);
  });

  test('a pinch never ends in a tap', () => {
    let href = null;
    const g = positioned({ onNavigate: (h) => { href = h; } });
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerUp(down(1, 50, 100)); // select the node
    g._controls.pointerDown(down(1, 50, 100));
    g._controls.pointerDown(down(2, 250, 100)); // second finger
    g._controls.pointerUp(down(2, 250, 100));
    g._controls.pointerUp(down(1, 50, 100));
    assert.strictEqual(href, null, 'ending a pinch on a node must not open it');
  });

  test('touching the canvas stops the auto-framing', () => {
    const g = positioned();
    g._needFit = true;
    g._controls.pointerDown(down(1, 400, 400));
    assert.strictEqual(g._needFit, false, 'the view must not jump under the user');
  });

  test('the mouse leaving the canvas clears the hover', () => {
    const seen = [];
    const g = positioned({ onHover: (n) => seen.push(n) });
    g._controls.pointerMove(down(9, 50, 100));
    g._controls._onLeave({ pointerType: 'mouse' });
    assert.strictEqual(g.hovered, null);
    assert.deepStrictEqual(seen, [g.nodes[0], null]);
  });

  test('a finger leaving the canvas does not clear the highlight', () => {
    // On touch, lifting a finger fires pointerleave — treating that as "the
    // pointer left" would wipe the highlight the tap just put up.
    const g = positioned();
    g._controls.pointerMove(down(9, 50, 100));
    g._controls._onLeave({ pointerType: 'touch' });
    assert.strictEqual(g.hovered, g.nodes[0], 'the highlight must survive the finger lifting');
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
    g._controls.wheel(wheel(-100).event);
    const zoomedIn = g.scale;
    assert.ok(zoomedIn > start);

    g._controls.wheel(wheel(100).event);
    assert.ok(g.scale < zoomedIn);
  });

  test('the page does not scroll behind the graph', () => {
    const g = makeGraph();
    const w = wheel(-100);
    g._controls.wheel(w.event);
    assert.ok(w.wasPrevented(), 'the canvas must claim the wheel event');
  });

  test('wheel zoom is anchored under the cursor', () => {
    const g = makeGraph();
    g._fitToView();
    const before = g._screenToWorld(400, 260);
    g._controls.wheel(wheel(-100).event);
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

  test('destroy unbinds the pointer listeners', () => {
    const removed = [];
    const canvas = stubCanvas();
    canvas.removeEventListener = (type) => removed.push(type);
    new TagGraph(canvas, FIXTURE).destroy();
    assert.deepStrictEqual(
      removed.sort(),
      ['pointerdown', 'pointerleave', 'pointermove', 'wheel'],
      'a torn-down graph must not keep painting on stray events',
    );
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
