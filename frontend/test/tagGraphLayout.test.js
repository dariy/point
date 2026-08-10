import { test, describe } from 'node:test';
import assert from 'node:assert';

import { tick } from '../src/plugins/tags-graph/forceLayout.js';

/**
 * One step of the /tags graph's force simulation. Four forces act per tick:
 * pairwise repulsion (cut off by distance, bucketed through a spatial grid),
 * springs along the links, gravity toward the viewport centre, and a collision
 * pass that pushes overlapping rims apart.
 *
 * These assert direction and invariants, not exact positions — the constants
 * are tuned by eye and pinning coordinates would make every future tweak a test
 * failure.
 */

const CENTRE = { cx: 400, cy: 260 };

const node = (id, x, y, r = 10) => ({ id, x, y, vx: 0, vy: 0, r });
const link = (source, target, kind) => ({ source, target, kind });

const step = (nodes, links = [], { alpha = 1, pinned = null } = {}) =>
  tick(nodes, links, { alpha, ...CENTRE, pinned });

const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

describe('force layout', () => {
  test('unlinked neighbours repel', () => {
    const a = node('t1', 400, 260);
    const b = node('t2', 430, 260);
    const before = gap(a, b);
    step([a, b]);
    assert.ok(gap(a, b) > before, 'nodes with nothing in common should spread out');
  });

  test('repulsion is cut off, so distant nodes do not feel each other', () => {
    // Beyond the cutoff the pair is skipped entirely; what movement is left
    // comes from gravity, which pulls both toward the same centre.
    const a = node('t1', -5000, 260);
    const b = node('t2', 5000, 260);
    const before = gap(a, b);
    step([a, b]);
    assert.ok(gap(a, b) < before, 'far apart, only gravity acts — they close in');
  });

  test('a stretched link pulls its ends together', () => {
    const a = node('t1', 100, 260);
    const b = node('t2', 700, 260);
    const before = gap(a, b);
    step([a, b], [link(a, b, 'hierarchy')]);
    assert.ok(gap(a, b) < before, 'the spring should contract');
  });

  test('a membership link is slacker than a hierarchy link', () => {
    // Posts settle closer to their tags than child tags settle to their
    // parents, so the hierarchy reads as the graph's skeleton. Same radii on
    // both pairs, so only the rest length differs.
    const parent = node('t1', 400, 260);
    const child = node('t2', 400, 460);
    const tag = node('t1', 400, 260);
    const post = node('p2', 400, 460);
    for (let i = 0; i < 200; i++) {
      step([parent, child], [link(parent, child, 'hierarchy')]);
      step([tag, post], [link(tag, post, 'membership')]);
    }
    const hierGap = gap(parent, child);
    const membGap = gap(tag, post);
    assert.ok(hierGap > membGap, `hierarchy ${hierGap} should rest wider than membership ${membGap}`);
  });

  test('gravity pulls a stray node back toward the centre', () => {
    const n = node('t1', 4000, 3000);
    step([n]);
    assert.ok(n.x < 4000 && n.y < 3000, 'nothing should drift off forever');
  });

  test('collision separates overlapping nodes', () => {
    // alpha=0 silences repulsion, springs and gravity — all are scaled by it —
    // leaving the collision pass as the only thing that can move a node. Run
    // with alpha up and repulsion alone would hide a broken collision pass.
    const a = node('t1', 400, 260);
    const b = node('t2', 402, 260);
    for (let i = 0; i < 50; i++) step([a, b], [], { alpha: 0 });
    assert.ok(
      gap(a, b) >= a.r + b.r + 8 - 1e-6,
      `rims must end up a pad apart, got ${gap(a, b)} for radii ${a.r}/${b.r}`,
    );
  });

  test('collision leaves nodes that already clear each other alone', () => {
    const a = node('t1', 400, 260);
    const b = node('t2', 700, 260);
    step([a, b], [], { alpha: 0 });
    assert.strictEqual(a.x, 400, 'no phantom shove');
    assert.strictEqual(b.x, 700);
  });

  /** A ring of linked nodes — enough structure for the forces to fight over. */
  function ring(count = 8) {
    const nodes = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      nodes.push(node('t' + i, 400 + Math.cos(a) * 200, 260 + Math.sin(a) * 200));
    }
    const links = nodes.map((n, i) => link(n, nodes[(i + 1) % count], i % 2 ? 'membership' : 'hierarchy'));
    return { nodes, links };
  }

  test('a settled layout stops moving once alpha reaches zero', () => {
    const { nodes, links } = ring();
    let alpha = 1;
    for (let i = 0; i < 300; i++) {
      alpha *= 0.95;
      step(nodes, links, { alpha });
    }
    const before = nodes.map((n) => [n.x, n.y]);
    step(nodes, links, { alpha: 0 });
    nodes.forEach((n, i) => {
      assert.ok(Math.abs(before[i][0] - n.x) < 0.5, 'a cold layout should be still');
      assert.ok(Math.abs(before[i][1] - n.y) < 0.5);
    });
  });

  test('the layout stays finite over a long run', () => {
    const { nodes, links } = ring();
    for (let i = 0; i < 500; i++) step(nodes, links);
    for (const n of nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} left the plane`);
    }
  });

  test('coincident nodes are pushed apart rather than dividing by zero', () => {
    const a = node('t1', 400, 260);
    const b = node('t2', 400, 260);
    step([a, b]);
    assert.ok(Number.isFinite(a.x) && Number.isFinite(b.x));
    assert.ok(gap(a, b) > 0, 'a stack of two must not stay stacked');
  });

  test('a node held by the pointer is not moved by the forces', () => {
    const held = node('t1', 123, 456);
    const other = node('t2', 130, 456);
    step([held, other], [], { pinned: held });
    assert.strictEqual(held.x, 123, 'the dragged node follows the finger, not the physics');
    assert.strictEqual(held.y, 456);
  });
});
