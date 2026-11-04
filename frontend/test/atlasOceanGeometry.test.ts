import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  clipInsets, createTapGate, easeInOut, insetCss, insetsEmpty, intersectRect, TAP_SLOP_PX, tweenPoint, tweenRect, windowOffset,
} from '../src/plugins/tags-atlas/atlasOceanGeometry.ts';

// The map box: the whole 400×800 viewport.
const box = { left: 0, top: 0, width: 400, height: 800 };

describe('atlasOceanGeometry', () => {
  test('clipInsets: a rect inside the box', () => {
    const r = { left: 20, top: 500, width: 360, height: 200 };
    assert.deepEqual(clipInsets(r, box), { top: 500, left: 20, bottom: 100, right: 20 });
    assert.equal(insetsEmpty(clipInsets(r, box), box), false);
    assert.equal(insetCss(clipInsets(r, box)), 'inset(500px 20px 100px 20px)');
  });

  test('clipInsets: a rect in a box that does not start at 0,0', () => {
    const b = { left: 0, top: 56, width: 400, height: 744 };
    const r = { left: 20, top: 500, width: 360, height: 200 };
    assert.deepEqual(clipInsets(r, b), { top: 444, left: 20, bottom: 100, right: 20 });
  });

  test('clipInsets: a rect partly outside the box shows only its part inside', () => {
    // The sheet scrolled: the slot runs off the bottom and the right edge.
    const r = { left: 300, top: 700, width: 200, height: 200 };
    const i = clipInsets(r, box);
    assert.deepEqual(i, { top: 700, left: 300, bottom: 0, right: 0 });
    assert.equal(insetsEmpty(i, box), false);
    // And off the top.
    assert.deepEqual(clipInsets({ left: 0, top: -50, width: 400, height: 100 }, box), { top: 0, left: 0, bottom: 750, right: 0 });
  });

  test('clipInsets: a rect fully outside the box shows nothing', () => {
    const below = clipInsets({ left: 20, top: 900, width: 100, height: 100 }, box);
    assert.deepEqual(below, { top: 800, left: 20, bottom: 0, right: 280 });
    assert.equal(insetsEmpty(below, box), true);
    const above = clipInsets({ left: 20, top: -300, width: 100, height: 100 }, box);
    assert.equal(insetsEmpty(above, box), true);
    const right = clipInsets({ left: 500, top: 10, width: 100, height: 100 }, box);
    assert.equal(insetsEmpty(right, box), true);
  });

  test('windowOffset: the window centre from the box centre', () => {
    // A window at the box centre: no offset.
    assert.deepEqual(windowOffset({ left: 100, top: 300, width: 200, height: 200 }, box), { x: 0, y: 0 });
    // A slot low in the sheet: the point must sit 200 px below the box centre.
    assert.deepEqual(windowOffset({ left: 20, top: 500, width: 360, height: 200 }, box), { x: 0, y: 200 });
  });

  test('windowOffset: the map centre for that offset puts the point at the window centre', () => {
    // Web Mercator at zoom 3 (256 px tiles), as Leaflet's EPSG3857.
    const scale = 256 * 2 ** 3;
    const project = (lat: number, lng: number) => ({
      x: (scale * (lng + 180)) / 360,
      y: (scale * (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI)) / 2,
    });
    const rect = { left: 40, top: 520, width: 120, height: 160 };
    const off = windowOffset(rect, box);
    const p = project(48.85, 2.35);
    // The map centre the controller sets (atlasLayerMap.ts::frame).
    const centre = { x: p.x - off.x, y: p.y - off.y };
    // The point's place in the box: box centre + (p - centre).
    const at = { x: box.width / 2 + (p.x - centre.x), y: box.height / 2 + (p.y - centre.y) };
    assert.deepEqual(at, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  });

  test('intersectRect: the part of a slot inside its scroller; no overlap is empty', () => {
    const scroller = { left: 0, top: 300, width: 400, height: 500 };
    assert.deepEqual(intersectRect({ left: 20, top: 250, width: 360, height: 200 }, scroller),
      { left: 20, top: 300, width: 360, height: 150 });
    const none = intersectRect({ left: 20, top: 100, width: 360, height: 100 }, scroller);
    assert.equal(none.height, 0);
    assert.equal(insetsEmpty(clipInsets(none, box), box), true);
  });

  test('tweenRect at t = 0, 0.5 and 1', () => {
    const a = { left: 20, top: 500, width: 360, height: 200 };
    const b = { left: 0, top: 0, width: 400, height: 800 };
    assert.deepEqual(tweenRect(a, b, 0), a);
    assert.deepEqual(tweenRect(a, b, 0.5), { left: 10, top: 250, width: 380, height: 500 });
    assert.deepEqual(tweenRect(a, b, 1), b);
    assert.deepEqual(tweenPoint({ x: 0, y: 200 }, { x: 0, y: 0 }, 0.5), { x: 0, y: 100 });
  });

  test('easeInOut: 0 → 0, 0.5 → 0.5, 1 → 1, and it never goes back', () => {
    assert.equal(easeInOut(0), 0);
    assert.equal(easeInOut(0.5), 0.5);
    assert.equal(easeInOut(1), 1);
    let last = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      assert.ok(easeInOut(t) >= last);
      last = easeInOut(t);
    }
  });

  test('tap gate: a press with a small move is a tap', () => {
    const g = createTapGate();
    g.down(1, 100, 100);
    g.move(1, 100 + TAP_SLOP_PX - 1, 100);
    g.up(1);
    assert.equal(g.isTap(), true);
  });

  test('tap gate: a move past the slop is a drag, and the next press is a tap again', () => {
    const g = createTapGate();
    g.down(1, 100, 100);
    g.move(1, 100, 100 + TAP_SLOP_PX);
    g.up(1);
    assert.equal(g.isTap(), false);
    g.down(2, 50, 50);
    g.up(2);
    assert.equal(g.isTap(), true);
  });

  test('tap gate: a second finger (a pinch) is not a tap', () => {
    const g = createTapGate();
    g.down(1, 100, 100);
    g.down(2, 200, 200);
    g.up(2);
    g.up(1);
    assert.equal(g.isTap(), false);
  });
});
