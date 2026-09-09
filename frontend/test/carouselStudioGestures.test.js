/**
 * carousel/studio/gestures.js — deck-mode direct manipulation.
 *
 * Two halves. The pure helpers (`pointerCentroid`, `zoomCrop`, `sameCrop`,
 * `panScale`) are the gesture arithmetic, and `panScale` is the one that makes
 * a 100px drag move the image 100px — so it is pinned to an exact number, not
 * to a sign.
 *
 * The other half is the contract the studio page depends on: `attach` binds
 * this render's frames and releases the previous render's, `commit` fires once
 * when a gesture ends and never for a crop the document already holds, and
 * `destroy` drops both the listeners and the debounced wheel commit.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  createDeckGestures,
  dragBox,
  hitLayer,
  panScale,
  pointerCentroid,
  sameCrop,
  snapBox,
  zoomCrop,
} from '../src/plugins/carousel/studio/gestures.js';

const FULL = { x: 0, y: 0, w: 1, h: 1 };

/** A frame stand-in — gestures.js touches only these members, so a plain
 *  object keeps the listener bookkeeping visible without a DOM. */
function fakeFrame(i, box = { width: 500, height: 500 }) {
  const listeners = [];
  return {
    dataset: { slice: String(i) },
    classList: { add() {}, remove() {} },
    listeners,
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, ...box }),
    querySelector: () => ({ getBoundingClientRect: () => box }),
    addEventListener(type, fn, opts) {
      listeners.push({ type, fn, opts });
    },
    removeEventListener(type, fn) {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (at >= 0) listeners.splice(at, 1);
    },
    /** Dispatch to whatever `attach` bound for `type`. */
    emit(type, event = {}) {
      for (const l of [...listeners]) if (l.type === type) l.fn(event);
    },
  };
}

/** A host stand-in that records every callback the module makes. `layer`, when
 *  given, is `{ i, j, box }` and becomes the value `activeLayer()` returns. */
function fakeHost(slides, layer = null) {
  const calls = {
    paint: [],
    commit: [],
    select: [],
    refocus: [],
    paintLayer: [],
    commitLayer: [],
  };
  return {
    calls,
    active: layer,
    dims: () => ({ srcW: 1000, srcH: 1000, aspect: '1:1' }),
    slideAt: (i) => slides[i] ?? null,
    paint: (i, slide) => calls.paint.push({ i, slide }),
    commit: (i, crop) => calls.commit.push({ i, crop }),
    select: (i) => calls.select.push(i),
    refocus: (i) => calls.refocus.push(i),
    activeLayer() {
      return this.active;
    },
    safeArea: () => ({ x: 0.05, y: 0.13, w: 0.9, h: 0.74 }),
    paintLayer: (i, j, box, guides) => calls.paintLayer.push({ i, j, box, guides }),
    commitLayer: (i, j, box) => calls.commitLayer.push({ i, j, box }),
  };
}

describe('carousel studio gestures', () => {
  describe('pointerCentroid', () => {
    test('no pointers is the origin with no spread', () => {
      assert.deepStrictEqual(pointerCentroid(new Map()), { cx: 0, cy: 0, dist: 0 });
    });

    test('one finger has a position but no spread — which is what makes the same handler serve a drag', () => {
      const one = new Map([[1, { x: 10, y: 20 }]]);
      assert.deepStrictEqual(pointerCentroid(one), { cx: 10, cy: 20, dist: 0 });
    });

    test('two fingers give the midpoint and the distance between them', () => {
      const two = new Map([
        [1, { x: 0, y: 0 }],
        [2, { x: 6, y: 8 }],
      ]);
      assert.deepStrictEqual(pointerCentroid(two), { cx: 3, cy: 4, dist: 10 });
    });
  });

  describe('zoomCrop', () => {
    test('a ratio above 1 widens the crop about its own centre', () => {
      assert.deepStrictEqual(zoomCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 2), FULL);
    });

    test('a ratio below 1 narrows it about the same centre', () => {
      assert.deepStrictEqual(zoomCrop(FULL, 0.5), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    });

    test('a ratio of 1 is identity', () => {
      assert.deepStrictEqual(zoomCrop({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 1), {
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.4,
      });
    });
  });

  describe('sameCrop', () => {
    test('a sub-pixel difference is the same crop — the render rounds there too', () => {
      assert.ok(sameCrop(FULL, { x: 0.0004, y: 0, w: 1, h: 1 }, 1000, 1000));
    });

    test('a whole-pixel difference is not', () => {
      assert.ok(!sameCrop(FULL, { x: 0.002, y: 0, w: 1, h: 1 }, 1000, 1000));
    });

    test('unknown source dimensions fall back to a 1x1 source rather than dividing by zero', () => {
      assert.ok(sameCrop(FULL, { x: 0.2, y: 0, w: 1, h: 1 }, 0, 0));
    });
  });

  describe('panScale', () => {
    test('normalized source units per CSS pixel, off the same fit CSS the preview draws', () => {
      // A half-width crop of a 1000x1000 source at 1:1 renders at 200%
      // background-size, so one of the 500 CSS pixels is 100/200/500 of the
      // source: a 100px drag moves the image exactly 100px.
      assert.deepStrictEqual(
        panScale({ x: 0, y: 0, w: 0.5, h: 1 }, 'cover', { width: 500, height: 500 }, {
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
        }),
        { x: 0.001, y: 0.001 },
      );
    });

    test('zooming out doubles the source travelled per pixel', () => {
      assert.deepStrictEqual(
        panScale(FULL, 'cover', { width: 500, height: 500 }, {
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
        }),
        { x: 0.002, y: 0.002 },
      );
    });

    test('an unmeasured element or unknown source scales by zero rather than NaN', () => {
      assert.deepStrictEqual(
        panScale(FULL, 'cover', { width: 0, height: 0 }, {
          srcW: null,
          srcH: null,
          aspect: '1:1',
        }),
        { x: 0, y: 0 },
      );
    });
  });

  describe('the attach/detach contract', () => {
    test('attach binds this render\'s frames and releases the previous render\'s', () => {
      const gestures = createDeckGestures(fakeHost([{ crop: FULL, fit: 'cover' }]));
      const first = fakeFrame(0);
      const second = fakeFrame(0);

      gestures.attach([first]);
      assert.ok(first.listeners.length > 0);

      gestures.attach([second]);
      assert.strictEqual(first.listeners.length, 0, 'the previous render is released');
      assert.ok(second.listeners.length > 0);

      gestures.destroy();
      assert.strictEqual(second.listeners.length, 0);
    });

    test('attach after destroy binds nothing', () => {
      const gestures = createDeckGestures(fakeHost([{ crop: FULL, fit: 'cover' }]));
      const frame = fakeFrame(0);
      gestures.destroy();
      gestures.attach([frame]);
      assert.strictEqual(frame.listeners.length, 0);
    });

    test('a drag paints while it moves and commits once when it ends', () => {
      // Start away from the edges, or the clamp pins the crop and the commit is
      // skipped by design (covered below).
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
      frame.emit('pointermove', { pointerId: 1, clientX: 100, clientY: 0 });
      assert.strictEqual(host.calls.paint.length, 1, 'the move paints, without committing');
      assert.strictEqual(host.calls.commit.length, 0);

      frame.emit('pointerup', { pointerId: 1 });
      assert.strictEqual(host.calls.commit.length, 1);
      assert.strictEqual(host.calls.commit[0].i, 0);
      // The image follows the pointer, so a rightward drag moves the crop left:
      // 100px at 0.001 source units per pixel.
      assert.ok(Math.abs(host.calls.commit[0].crop.x - 0.15) < 1e-9);
      gestures.destroy();
    });

    test('a press that never moves selects the slide instead of reframing it', () => {
      const host = fakeHost([{ crop: FULL, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 5, clientY: 5 });
      frame.emit('pointerup', { pointerId: 1 });

      assert.deepStrictEqual(host.calls.select, [0]);
      assert.strictEqual(host.calls.commit.length, 0);
      gestures.destroy();
    });

    test('a drag that the clamp returns to where it started repaints rather than committing', () => {
      // The crop already fills the source, so panning cannot move it: committing
      // would mark the studio dirty and re-encode identical pixels.
      const host = fakeHost([{ crop: FULL, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
      frame.emit('pointermove', { pointerId: 1, clientX: 100, clientY: 100 });
      frame.emit('pointerup', { pointerId: 1 });

      assert.strictEqual(host.calls.commit.length, 0);
      assert.deepStrictEqual(host.calls.select, [0]);
      gestures.destroy();
    });

    test('a secondary mouse button starts no gesture', () => {
      const host = fakeHost([{ crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 2, clientX: 0, clientY: 0 });
      frame.emit('pointermove', { pointerId: 1, clientX: 100, clientY: 0 });

      assert.strictEqual(host.calls.paint.length, 0);
      gestures.destroy();
    });

    test('an arrow key refocuses and commits the nudge', () => {
      const host = fakeHost([{ crop: { x: 0.25, y: 0, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('keydown', { key: 'ArrowRight', shiftKey: false });

      assert.deepStrictEqual(host.calls.refocus, [0]);
      assert.strictEqual(host.calls.commit.length, 1);
      assert.ok(host.calls.commit[0].crop.x > 0.25);
      gestures.destroy();
    });

    test('an unhandled key commits nothing', () => {
      const host = fakeHost([{ crop: FULL, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('keydown', { key: 'a', shiftKey: false });

      assert.strictEqual(host.calls.commit.length, 0);
      assert.strictEqual(host.calls.refocus.length, 0);
      gestures.destroy();
    });

    test('a wheel burst paints per notch but commits once, after the debounce', async () => {
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('wheel', { deltaY: 100, deltaMode: 0 });
      frame.emit('wheel', { deltaY: 100, deltaMode: 0 });
      assert.strictEqual(host.calls.paint.length, 2);
      assert.strictEqual(host.calls.commit.length, 0, 'the commit is debounced');

      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(host.calls.commit.length, 1, 'one mutation for the burst');
      // Two outward notches from a half-size crop zoom out.
      assert.ok(host.calls.commit[0].crop.w > 0.5);
      gestures.destroy();
    });

    test('destroy drops the pending wheel commit with the listeners', async () => {
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('wheel', { deltaY: 100, deltaMode: 0 });
      gestures.destroy();

      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(host.calls.commit.length, 0);
    });

    test('a wheel burst survives the re-attach a rebuild causes', async () => {
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      gestures.attach([fakeFrame(0)]);

      const first = fakeFrame(0);
      gestures.attach([first]);
      first.emit('wheel', { deltaY: 100, deltaMode: 0 });
      // The rebuild lands mid-burst; detach must not cancel the commit.
      gestures.attach([fakeFrame(0)]);

      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(host.calls.commit.length, 1);
      gestures.destroy();
    });
  });

  describe('hitLayer', () => {
    const box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const rect = { left: 0, top: 0, width: 200, height: 200 };

    test('a press in the middle of the box is a move', () => {
      assert.deepStrictEqual(hitLayer(rect, box, 100, 100), { mode: 'move', h: 0, v: 0 });
    });

    test('a press on the left edge is an x-only resize', () => {
      assert.deepStrictEqual(hitLayer(rect, box, 50, 100), { mode: 'resize', h: -1, v: 0 });
    });

    test('a press on a corner resizes both axes', () => {
      assert.deepStrictEqual(hitLayer(rect, box, 150, 150), { mode: 'resize', h: 1, v: 1 });
    });

    test('a press well outside the box misses — the crop gesture gets it', () => {
      assert.strictEqual(hitLayer(rect, box, 10, 10), null);
    });

    test('an unmeasured frame misses rather than dividing by zero', () => {
      assert.strictEqual(hitLayer({ left: 0, top: 0, width: 0, height: 0 }, box, 0, 0), null);
    });
  });

  describe('dragBox', () => {
    const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };

    test('a move offsets the origin and keeps the size', () => {
      assert.deepStrictEqual(dragBox(start, 'move', { h: 0, v: 0 }, 0.1, -0.05), {
        x: 0.30000000000000004,
        y: 0.15000000000000002,
        w: 0.4,
        h: 0.4,
      });
    });

    test('a right-edge resize grows the width only', () => {
      const b = dragBox(start, 'resize', { h: 1, v: 0 }, 0.1, 0.1);
      assert.ok(Math.abs(b.w - 0.5) < 1e-9);
      assert.strictEqual(b.x, 0.2);
      assert.strictEqual(b.h, 0.4);
    });

    test('a left-edge resize moves the origin and never crosses the anchor', () => {
      const b = dragBox(start, 'resize', { h: -1, v: 0 }, 1, 0);
      assert.ok(b.w >= 1 / 1080);
      // The right edge stays put: x + w === start.x + start.w.
      assert.ok(Math.abs(b.x + b.w - (start.x + start.w)) < 1e-9);
    });
  });

  describe('snapBox', () => {
    const tol = { x: 0.02, y: 0.02 };
    const safe = { x: 0.05, y: 0.13, w: 0.9, h: 0.74 };

    test('a move snaps the near edge to the canvas centre and reports the guide', () => {
      const box = { x: 0.49, y: 0.3, w: 0.2, h: 0.2 };
      const { box: snapped, guides } = snapBox(box, 'move', { h: 0, v: 0 }, safe, tol, false);
      assert.ok(Math.abs(snapped.x - 0.5) < 1e-9, 'left edge on 0.5');
      assert.deepStrictEqual(guides.v, [0.5]);
    });

    test('the modifier suppresses the snap and clears the guides', () => {
      const box = { x: 0.49, y: 0.3, w: 0.2, h: 0.2 };
      const { box: snapped, guides } = snapBox(box, 'move', { h: 0, v: 0 }, safe, tol, true);
      assert.strictEqual(snapped.x, 0.49);
      assert.deepStrictEqual(guides, { v: [], h: [] });
    });

    test('a resize snaps only the anchored edge', () => {
      const box = { x: 0.2, y: 0.2, w: 0.31, h: 0.4 }; // right edge at 0.51, near safe.x+safe.w? no — near 0.5
      const { box: snapped, guides } = snapBox(box, 'resize', { h: 1, v: 0 }, safe, tol, false);
      assert.ok(Math.abs(snapped.x + snapped.w - 0.5) < 1e-9);
      assert.strictEqual(snapped.x, 0.2, 'the left edge did not move');
      assert.deepStrictEqual(guides.v, [0.5]);
    });
  });

  describe('layer manipulation', () => {
    const LAYER_BOX = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };

    /** A host with slide 0 and its layer 0 selected, plus a 200×200 frame. */
    function setup(box = LAYER_BOX) {
      const host = fakeHost([{ crop: FULL, fit: 'cover', layers: [{ box }] }], { i: 0, j: 0, box });
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0, { width: 200, height: 200 });
      gestures.attach([frame]);
      return { host, gestures, frame };
    }

    test('a press inside the selected layer moves its box and commits once, not the crop', () => {
      const { host, gestures, frame } = setup();
      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
      frame.emit('pointermove', { pointerId: 1, clientX: 140, clientY: 100 });
      assert.ok(host.calls.paintLayer.length >= 1, 'the move painted the layer');
      assert.strictEqual(host.calls.paint.length, 0, 'the crop was left alone');

      frame.emit('pointerup', { pointerId: 1, clientX: 140, clientY: 100 });
      assert.strictEqual(host.calls.commitLayer.length, 1);
      assert.strictEqual(host.calls.commit.length, 0, 'no crop commit');
      const { i, j, box } = host.calls.commitLayer[0];
      assert.strictEqual(i, 0);
      assert.strictEqual(j, 0);
      // 40px of a 200px frame is 0.2 of the canvas.
      assert.ok(Math.abs(box.x - 0.5) < 1e-9);
    });

    test('a press that stays under the slop selects and moves nothing', () => {
      const { host, gestures, frame } = setup();
      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
      frame.emit('pointermove', { pointerId: 1, clientX: 102, clientY: 101 });
      frame.emit('pointerup', { pointerId: 1, clientX: 102, clientY: 101 });
      assert.strictEqual(host.calls.commitLayer.length, 0);
      assert.deepStrictEqual(host.calls.select, [0]);
      gestures.destroy();
    });

    test('a handle press resizes the box, and the commit comes back through the layer mutator', () => {
      const { host, gestures, frame } = setup();
      // Right edge of the box is at x=0.7 → 140px.
      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 140, clientY: 100 });
      frame.emit('pointermove', { pointerId: 1, clientX: 180, clientY: 100 });
      frame.emit('pointerup', { pointerId: 1, clientX: 180, clientY: 100 });
      assert.strictEqual(host.calls.commitLayer.length, 1);
      const { box } = host.calls.commitLayer[0];
      assert.ok(box.w > 0.4, 'the box got wider');
      assert.strictEqual(box.x, 0.3, 'the anchored edge held');
      gestures.destroy();
    });

    test('a press outside the selected layer still pans the crop', () => {
      const { host, gestures, frame } = setup();
      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      frame.emit('pointermove', { pointerId: 1, clientX: 60, clientY: 10 });
      assert.ok(host.calls.paint.length >= 1, 'the crop repainted');
      assert.strictEqual(host.calls.paintLayer.length, 0);
      gestures.destroy();
    });

    test('with no layer selected a press inside the old box pans the crop', () => {
      const host = fakeHost([{ crop: FULL, fit: 'cover', layers: [{ box: LAYER_BOX }] }], null);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0, { width: 200, height: 200 });
      gestures.attach([frame]);
      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
      frame.emit('pointermove', { pointerId: 1, clientX: 150, clientY: 100 });
      assert.ok(host.calls.paint.length >= 1);
      assert.strictEqual(host.calls.paintLayer.length, 0);
      gestures.destroy();
    });

    test('arrow keys nudge the selected layer and refocus; shift-arrows resize it', () => {
      const { host, gestures, frame } = setup();
      frame.emit('keydown', { key: 'ArrowRight', shiftKey: false });
      assert.deepStrictEqual(host.calls.refocus, [0]);
      assert.strictEqual(host.calls.commitLayer.length, 1);
      assert.ok(host.calls.commitLayer[0].box.x > 0.3, 'moved right');
      assert.strictEqual(host.calls.commit.length, 0, 'the crop nudge did not fire');

      frame.emit('keydown', { key: 'ArrowRight', shiftKey: true });
      assert.strictEqual(host.calls.commitLayer.length, 2);
      assert.ok(host.calls.commitLayer[1].box.w > 0.4, 'shift-arrow widened it');
      gestures.destroy();
    });

    test('a drag that snaps reports guides mid-move and clears them on release', () => {
      // Layer left edge at 0.48 → a 40px right drag lands it near the centre.
      const { host, gestures, frame } = setup({ x: 0.4, y: 0.3, w: 0.2, h: 0.2 });
      host.active = { i: 0, j: 0, box: { x: 0.4, y: 0.3, w: 0.2, h: 0.2 } };
      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 80 });
      frame.emit('pointermove', { pointerId: 1, clientX: 120, clientY: 80 });
      const last = host.calls.paintLayer.at(-1);
      assert.ok(last.guides.v.includes(0.5), 'a vertical guide engaged');
      // Alt held on the same move suppresses it.
      frame.emit('pointermove', { pointerId: 1, clientX: 120, clientY: 80, altKey: true });
      assert.deepStrictEqual(host.calls.paintLayer.at(-1).guides, { v: [], h: [] });
      gestures.destroy();
    });
  });
});
