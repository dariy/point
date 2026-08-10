import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  bounds,
  fitScale,
  fitTransform,
  pickNode,
  screenToWorld,
  zoomAt,
} from '../src/plugins/tags-graph/viewport.js';

/**
 * The /tags graph's view maths. world→screen is `s * scale + t`, and every
 * reverse lookup (hit-testing, zoom-at-cursor, drag) depends on screenToWorld
 * being its exact inverse — if it drifts, clicks land next to the node the user
 * aimed at.
 */

const SIZE = { width: 800, height: 520 };
const IDENTITY = { scale: 1, tx: 0, ty: 0 };

const node = (id, x, y, r = 10) => ({ id, x, y, r });

/** A handful of nodes spread well beyond the viewport, so fitting has work to do. */
const scattered = () => [
  node('a', -300, -200, 12),
  node('b', 900, 40, 6),
  node('c', 250, 700, 30),
  node('d', 400, 260, 8),
];

// ── Bounds ───────────────────────────────────────────────────────────────────

describe('bounds', () => {
  test('cover every node including its radius', () => {
    const nodes = scattered();
    const b = bounds(nodes);
    for (const n of nodes) {
      assert.ok(n.x - n.r >= b.minX - 1e-9 && n.x + n.r <= b.maxX + 1e-9);
      assert.ok(n.y - n.r >= b.minY - 1e-9 && n.y + n.r <= b.maxY + 1e-9);
    }
  });

  test('a subset can only shrink the box', () => {
    const nodes = scattered();
    const all = bounds(nodes);
    const some = bounds(nodes.slice(1));
    assert.ok(some.minX >= all.minX && some.maxX <= all.maxX);
  });

  test('no nodes, no box', () => {
    assert.strictEqual(bounds([]), null);
  });
});

// ── Fit ──────────────────────────────────────────────────────────────────────

describe('fit to view', () => {
  test('centres the graph in the viewport', () => {
    const nodes = scattered();
    const v = fitTransform(nodes, SIZE);
    const b = bounds(nodes);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    assert.ok(Math.abs(cx * v.scale + v.tx - SIZE.width / 2) < 1e-6);
    assert.ok(Math.abs(cy * v.scale + v.ty - SIZE.height / 2) < 1e-6);
  });

  test('after fitting, every node is on screen', () => {
    const nodes = scattered();
    const v = fitTransform(nodes, SIZE);
    for (const n of nodes) {
      const sx = n.x * v.scale + v.tx;
      const sy = n.y * v.scale + v.ty;
      assert.ok(sx >= 0 && sx <= SIZE.width, `node off screen horizontally: ${sx}`);
      assert.ok(sy >= 0 && sy <= SIZE.height, `node off screen vertically: ${sy}`);
    }
  });

  test('an empty graph has no transform but still a usable fallback scale', () => {
    assert.strictEqual(fitTransform([], SIZE), null);
    assert.strictEqual(fitScale([], SIZE), 0.2);
  });

  test('fit scale is clamped for a graph that is a single point', () => {
    assert.ok(fitScale([node('a', 400, 260)], SIZE) <= 4, 'must not zoom to absurdity on one node');
  });

  test('the fit scale is exactly what fitting applies', () => {
    const nodes = scattered();
    assert.strictEqual(fitTransform(nodes, SIZE).scale, fitScale(nodes, SIZE));
  });
});

// ── The transform ────────────────────────────────────────────────────────────

describe('screen ↔ world', () => {
  test('screenToWorld inverts the transform exactly', () => {
    const view = { scale: 1.7, tx: 42, ty: -13 };
    const w = screenToWorld(view, 300, 200);
    assert.ok(Math.abs(w.x * view.scale + view.tx - 300) < 1e-9);
    assert.ok(Math.abs(w.y * view.scale + view.ty - 200) < 1e-9);
  });
});

// ── Zoom ─────────────────────────────────────────────────────────────────────

describe('zoom', () => {
  test('keeps the point under the cursor fixed', () => {
    const view = fitTransform(scattered(), SIZE);
    const before = screenToWorld(view, 300, 200);
    const after = screenToWorld(zoomAt(view, 300, 200, 1.5, 0.05), 300, 200);
    assert.ok(Math.abs(before.x - after.x) < 1e-9, 'zoom anchored at the cursor');
    assert.ok(Math.abs(before.y - after.y) < 1e-9);
  });

  test('will not zoom out past the caller floor', () => {
    const nodes = scattered();
    const floor = fitScale(nodes, SIZE);
    let view = fitTransform(nodes, SIZE);
    for (let i = 0; i < 40; i++) view = zoomAt(view, 400, 260, 0.5, floor);
    assert.ok(view.scale >= floor - 1e-9, 'clamped at the fit scale');
  });

  test('zooming in is capped', () => {
    let view = { ...IDENTITY };
    for (let i = 0; i < 60; i++) view = zoomAt(view, 400, 260, 2, 0.05);
    assert.ok(view.scale <= 6);
  });

  test('the view passed in is not mutated', () => {
    const view = { ...IDENTITY };
    zoomAt(view, 400, 260, 2, 0.05);
    assert.deepStrictEqual(view, IDENTITY);
  });
});

// ── Hit testing ──────────────────────────────────────────────────────────────

/**
 * Picking is done in world space against each node's radius plus a 3px
 * forgiving margin. When two nodes overlap the nearer centre wins, so the node
 * whose middle you aimed at is the one you get.
 */
describe('hit testing', () => {
  /** Nodes on a known grid, so a coordinate means a specific node. */
  const row = () => [0, 1, 2, 3].map((i) => node('n' + i, i * 100, 100));

  test('a click on a node centre picks it', () => {
    assert.strictEqual(pickNode(row(), IDENTITY, 100, 100).id, 'n1');
  });

  test('a click just inside the rim picks it', () => {
    assert.ok(pickNode(row(), IDENTITY, 109, 100), 'r=10, so 9px out is a hit');
  });

  test('a click just outside the rim misses', () => {
    // r=10 plus the 3px forgiving margin, so 14px out must not register —
    // otherwise the gaps between nodes stop being clickable empty space and a
    // tap meant to clear the selection opens something instead.
    assert.strictEqual(pickNode(row(), IDENTITY, 114, 100), null);
  });

  test('the forgiving margin does not swallow the neighbouring node', () => {
    // Midway between two nodes 100px apart is nobody's.
    assert.strictEqual(pickNode(row(), IDENTITY, 150, 100), null);
  });

  test('a click well outside every node picks nothing', () => {
    assert.strictEqual(pickNode(row(), IDENTITY, 50, 400), null);
  });

  test('picking honours the pan and zoom in force', () => {
    const nodes = row();
    const view = { scale: 2, tx: 30, ty: -10 };
    // World (100,100) is now at screen (230,190).
    assert.strictEqual(pickNode(nodes, view, 230, 190).id, 'n1');
    assert.strictEqual(pickNode(nodes, view, 100, 100), null, 'the old screen point is empty now');
  });

  test('overlapping nodes resolve to the nearer centre', () => {
    const nodes = row();
    nodes[0].x = 100; // exactly on top of n1
    nodes[0].y = 100;
    assert.strictEqual(pickNode(nodes, IDENTITY, 103, 100).id, 'n0', 'ties broken by distance');
  });

  test('nothing to pick from picks nothing', () => {
    assert.strictEqual(pickNode([], IDENTITY, 0, 0), null);
  });
});
