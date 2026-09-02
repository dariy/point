import { test, describe } from 'node:test';
import assert from 'node:assert';

import { buildGraph, expandFocus, nodeRadius, visibleSets } from '../src/plugins/tags-graph/graphModel.js';

/**
 * graphModel.js turns the /tags payload into the node/link graph everything
 * else in the plugin runs on: the force layout, the renderer and hit-testing
 * all read what is built here. It is plain arithmetic over objects — no canvas
 * — so it is tested directly, without a DOM.
 */

const SIZE = { width: 800, height: 520 };

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

const build = (data = FIXTURE) => buildGraph(data, SIZE);

// ── Graph construction ───────────────────────────────────────────────────────

/**
 * Tag and post ids share one namespace on the canvas, so they are prefixed
 * ('t1', 'p1') — without that a tag and a post with the same database id would
 * collide in nodeById and one would silently vanish from the graph.
 */
describe('graph construction', () => {
  test('builds a node per tag and per post', () => {
    const g = build();
    assert.strictEqual(g.nodes.length, 6);
    assert.strictEqual(g.nodes.filter((n) => n.type === 'post').length, 2);
  });

  test('tag and post ids are namespaced apart', () => {
    const g = build({
      tags: [{ id: 1, name: 'T', slug: 't', post_count: 0 }],
      posts: [{ id: 1, title: 'P', slug: 'p' }],
    });
    assert.strictEqual(g.nodes.length, 2, 'same numeric id must not collide');
    assert.strictEqual(g.nodeById.get('t1').type, 'tag');
    assert.strictEqual(g.nodeById.get('p1').type, 'post');
  });

  test('tags are classified into the shared colour buckets', () => {
    const g = build();
    assert.strictEqual(g.nodeById.get('t1').type, 'tag');
    assert.strictEqual(g.nodeById.get('t3').type, 'geo', 'has coordinates');
    assert.strictEqual(g.nodeById.get('t4').type, 'year');
  });

  test('a post falls back to its slug when it has no title', () => {
    const g = build({ tags: [], posts: [{ id: 1, slug: 'untitled-thing' }] });
    assert.strictEqual(g.nodeById.get('p1').name, 'untitled-thing');
  });

  test('both edge kinds are linked and labelled', () => {
    const g = build();
    assert.strictEqual(g.links.filter((l) => l.kind === 'hierarchy').length, 2);
    assert.strictEqual(g.links.filter((l) => l.kind === 'membership').length, 3);
  });

  test('degree counts every incident edge', () => {
    const g = build();
    assert.strictEqual(g.nodeById.get('t3').degree, 3, 'parent Canada + posts 10 and 11');
    assert.strictEqual(g.nodeById.get('t1').degree, 1, 'one child, no posts of its own');
    assert.strictEqual(g.nodeById.get('p10').degree, 2, 'tagged montreal and 2026');
    assert.strictEqual(g.nodeById.get('p11').degree, 1);
  });

  test('neighbours are symmetric', () => {
    const g = build();
    assert.ok(g.neighbors.get('t2').has('t3'));
    assert.ok(g.neighbors.get('t3').has('t2'), 'edges must be walkable both ways');
  });

  test('an edge naming a tag that does not exist is dropped, not fatal', () => {
    const g = build({
      tags: [{ id: 1, name: 'T', slug: 't', post_count: 0 }],
      posts: [],
      hierarchyEdges: [{ parent: 1, child: 999 }],
      membershipEdges: [{ post: 999, tag: 1 }],
    });
    assert.strictEqual(g.links.length, 0);
    assert.strictEqual(g.nodeById.get('t1').degree, 0);
  });

  test('an empty payload builds an empty graph rather than throwing', () => {
    const g = build({});
    assert.strictEqual(g.nodes.length, 0);
    assert.strictEqual(g.links.length, 0);
    assert.strictEqual(g.neighbors.size, 0);
  });

  test('the initial scatter is deterministic across builds', () => {
    // A seeded PRNG, so a reload lands the layout in the same place instead of
    // reshuffling the graph under the reader.
    const a = build().nodes.map((n) => [n.x, n.y]);
    const b = build().nodes.map((n) => [n.x, n.y]);
    assert.deepStrictEqual(a, b);
  });

  test('every node starts inside the viewport, at rest', () => {
    for (const n of build().nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), 'placed at a real point');
      assert.strictEqual(n.vx, 0);
      assert.strictEqual(n.vy, 0);
    }
  });

  test('a canvas with no size yet still scatters the nodes apart', () => {
    // The page can build the graph before the canvas has been laid out; a zero
    // spread would stack every node on one point and the layout would never
    // find its way out of the pile.
    const g = buildGraph(FIXTURE, { width: 0, height: 0 });
    const spots = new Set(g.nodes.map((n) => `${n.x},${n.y}`));
    assert.strictEqual(spots.size, g.nodes.length);
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
    const g = build();
    assert.ok(g.nodeById.get('t3').r > g.nodeById.get('t1').r, 'the hub is bigger');
  });

  test('posts are drawn smaller than tags at the same degree', () => {
    assert.ok(nodeRadius('post', 3) < nodeRadius('tag', 3));
  });

  test('a lone node is still big enough to hit', () => {
    assert.ok(nodeRadius('tag', 0) >= 6);
    assert.ok(nodeRadius('post', 0) >= 3);
  });

  test('a hub is capped', () => {
    assert.ok(nodeRadius('tag', 10000) <= 36, 'tag radius is clamped');
    assert.ok(nodeRadius('post', 10000) <= 11, 'post radius is clamped');
  });
});

// ── Visible set ──────────────────────────────────────────────────────────────

/**
 * The legend hides a whole node kind. Everything downstream — physics, drawing,
 * hit-testing, fit-to-view — runs off the visible set, so hiding a kind has to
 * drop its links too: a link with one hidden endpoint would otherwise be drawn
 * running to nothing.
 */
describe('visible sets', () => {
  test('with nothing hidden, the whole graph is visible', () => {
    const g = build();
    const v = visibleSets(g, new Set());
    assert.strictEqual(v.nodes, g.nodes, 'and it is not copied for nothing');
    assert.strictEqual(v.links, g.links);
  });

  test('hiding a kind drops its nodes and their edges', () => {
    const g = build();
    const v = visibleSets(g, new Set(['post']));
    assert.strictEqual(v.nodes.length, 4);
    assert.ok(v.nodes.every((n) => n.type !== 'post'));
    assert.strictEqual(v.links.length, 2, 'only the two hierarchy edges survive');
  });

  test('hiding several kinds compounds', () => {
    const g = build();
    const v = visibleSets(g, new Set(['post', 'year']));
    assert.deepStrictEqual(v.nodes.map((n) => n.id), ['t1', 't2', 't3']);
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
    const { focus, related } = expandFocus(build(), ['t3']); // Montréal

    assert.ok(focus.has('t2'), 'parent Canada is a direct neighbour');
    assert.ok(focus.has('p10') && focus.has('p11'), 'its posts');
    assert.ok(focus.has('t4'), '2026 shares post 10 — reached on the second hop');
    assert.deepStrictEqual([...related], ['t4'], 'only the second-wave tag is "related"');
  });

  test('the seed is in focus but is not related to itself', () => {
    const { focus, related } = expandFocus(build(), ['t3']);
    assert.ok(focus.has('t3'));
    assert.ok(!related.has('t3'));
  });

  test('a post seed lights only its own tags — no second hop', () => {
    const { focus, related } = expandFocus(build(), ['p10']);
    assert.ok(focus.has('t3') && focus.has('t4'));
    assert.ok(!focus.has('p11'), 'must not walk back out to sibling posts');
    assert.strictEqual(related.size, 0);
  });

  test('an isolated node lights only itself', () => {
    const g = build({ tags: [{ id: 1, name: 'Lonely', slug: 'lonely', post_count: 0 }] });
    const { focus, related } = expandFocus(g, ['t1']);
    assert.deepStrictEqual([...focus], ['t1']);
    assert.strictEqual(related.size, 0);
  });

  test('several seeds light the union of their reach', () => {
    const { focus } = expandFocus(build(), ['t1', 't4']);
    assert.ok(focus.has('t2'), "Location's child");
    assert.ok(focus.has('p10'), "2026's post");
  });
});
