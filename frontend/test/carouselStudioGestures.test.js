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
 *
 * `createAnchorGesture` is the panorama controller, checked the same two ways:
 * the arithmetic that turns CSS pixels into `anchorY` is pinned to an exact
 * number, and the drag cycle is checked for painting on every move and
 * committing once — and never for a drag that ended where it started.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  anchorSlackPx,
  createAnchorGesture,
  createDeckGestures,
  deckRect,
  deckSeams,
  dragAnchor,
  dragBox,
  hitLayer,
  layerContains,
  panScale,
  pointerCentroid,
  sameAnchor,
  sameCrop,
  snapBox,
  snapLines,
  zoomCrop,
} from '../src/plugins/carousel/studio/gestures.js';

const FULL = { x: 0, y: 0, w: 1, h: 1 };

/** A frame stand-in — gestures.js touches only these members, so a plain
 *  object keeps the listener bookkeeping visible without a DOM. `box` may carry
 *  a `left`, which is what puts a deck's columns side by side. */
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
 *  given, is `{ i, j, box }` (plus a `scope` for a span layer) and becomes the
 *  value `activeLayer()` returns. */
function fakeHost(slides, layer = null, spanLayers = []) {
  const calls = {
    paint: [],
    commit: [],
    select: [],
    refocus: [],
    paintLayer: [],
    commitLayer: [],
    scrollPaneBy: [],
    selectLayer: [],
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
    scrollPaneBy: (px) => calls.scrollPaneBy.push(px),
    activeLayer() {
      return this.active;
    },
    /** A 4:5 slide's safe area, and — for a deck of three — the same band
     *  resolved in deck fractions, exactly as the page resolves it. */
    safeArea: (scope) =>
      scope === 'span'
        ? { x: 0.05 / 3, y: 0.13, w: (2 + 0.9) / 3, h: 0.74 }
        : { x: 0.05, y: 0.13, w: 0.9, h: 0.74 },
    paintLayer: (i, j, box, guides) => calls.paintLayer.push({ i, j, box, guides }),
    commitLayer: (i, j, box) => calls.commitLayer.push({ i, j, box }),
    /** Topmost first, the same order `_layersOnColumn` (`carousel/index.js`)
     *  resolves: the column's own slide layers, reversed, then every span
     *  layer (the test supplies these already filtered to the columns they
     *  reach, since `spanLayerCoverage` is the page's concern, not this
     *  stand-in's). */
    layersOnColumn: (i) => {
      const slideLayers = slides[i]?.layers || [];
      const out = [];
      for (let j = slideLayers.length - 1; j >= 0; j--) {
        out.push({ scope: 'slide', j, box: slideLayers[j].box });
      }
      for (let j = spanLayers.length - 1; j >= 0; j--) {
        out.push({ scope: 'span', j, box: spanLayers[j].box });
      }
      return out;
    },
    selectLayer: (i, j, scope) => calls.selectLayer.push({ i, j, scope }),
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
      // skipped by design (covered below). Ctrl is what asks for the crop
      // gesture rather than a plain pane-scroll drag.
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0, ctrlKey: true });
      frame.emit('pointermove', { pointerId: 1, clientX: 100, clientY: 0, ctrlKey: true });
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

    test('a plain mouse drag scrolls the strip instead of panning the crop', () => {
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 200, clientY: 0 });
      frame.emit('pointermove', { pointerId: 1, clientX: 150, clientY: 0 });
      frame.emit('pointermove', { pointerId: 1, clientX: 120, clientY: 0 });
      frame.emit('pointerup', { pointerId: 1, clientX: 120, clientY: 0 });

      assert.strictEqual(host.calls.paint.length, 0, 'no crop gesture ran');
      assert.strictEqual(host.calls.commit.length, 0);
      assert.deepStrictEqual(host.calls.select, [], 'a drag that moved is not a click');
      // The content follows the pointer: two leftward moves, -50px then -30px.
      assert.deepStrictEqual(host.calls.scrollPaneBy, [50, 30]);
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

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0, ctrlKey: true });
      frame.emit('pointermove', { pointerId: 1, clientX: 100, clientY: 100, ctrlKey: true });
      frame.emit('pointerup', { pointerId: 1, ctrlKey: true });

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

    test('a vertical touch drag is handed back to the page', () => {
      // The frame is `touch-action: pan-y`: a thumb going down the page has to
      // scroll it, or the studio is a wall on a phone.
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, pointerType: 'touch', clientX: 0, clientY: 0 });
      frame.emit('pointermove', { pointerId: 1, clientX: 2, clientY: 40 });
      frame.emit('pointermove', { pointerId: 1, clientX: 4, clientY: 90 });
      frame.emit('pointerup', { pointerId: 1 });

      assert.strictEqual(host.calls.paint.length, 0, 'nothing was painted — the page scrolled');
      assert.strictEqual(host.calls.commit.length, 0);
      assert.deepStrictEqual(host.calls.select, []);
      gestures.destroy();
    });

    test('a single-finger touch drag past the threshold is left to touch-action, not claimed', () => {
      // The tile is `touch-action: pan-x pan-y`: the finger is left to the
      // browser's own panning of the strip and the page either way now, so
      // neither axis claims the pointer without the Ctrl/Shift modifier.
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, pointerType: 'touch', clientX: 0, clientY: 0 });
      frame.emit('pointermove', { pointerId: 1, clientX: 100, clientY: 3 });
      frame.emit('pointerup', { pointerId: 1, clientX: 100, clientY: 3 });

      assert.strictEqual(host.calls.paint.length, 0, 'nothing was painted — touch-action panned it');
      assert.strictEqual(host.calls.commit.length, 0);
      assert.strictEqual(host.calls.scrollPaneBy.length, 0, 'native, not driven by hand');
      assert.deepStrictEqual(host.calls.select, [], 'a scroll that ended over the tile does not select it');
      gestures.destroy();
    });

    test('a touch below the movement threshold has not chosen yet — a second finger can still claim it', () => {
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, pointerType: 'touch', clientX: 0, clientY: 0 });
      frame.emit('pointermove', { pointerId: 1, clientX: 2, clientY: 2 });
      assert.strictEqual(host.calls.paint.length, 0, 'noise moves nothing, and claims nothing');

      // A second finger arriving before the first passed the slop still starts
      // a pinch — undecided is not the same as abandoned.
      frame.emit('pointerdown', { pointerId: 2, button: 0, pointerType: 'touch', clientX: 200, clientY: 0 });
      frame.emit('pointermove', { pointerId: 1, clientX: 2, clientY: 6 });
      assert.strictEqual(host.calls.paint.length, 1);
      gestures.destroy();
    });

    test('a tap selects the slide, direction never having come up', () => {
      const host = fakeHost([{ crop: FULL, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, pointerType: 'touch', clientX: 5, clientY: 5 });
      frame.emit('pointerup', { pointerId: 1 });

      assert.deepStrictEqual(host.calls.select, [0]);
      gestures.destroy();
    });

    test('a second finger claims the gesture the first was still deciding', () => {
      // A pinch is never a scroll, so it does not wait for a direction.
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, pointerType: 'touch', clientX: 100, clientY: 100 });
      frame.emit('pointerdown', { pointerId: 2, button: 0, pointerType: 'touch', clientX: 200, clientY: 100 });
      frame.emit('pointermove', { pointerId: 1, clientX: 100, clientY: 104 });

      assert.strictEqual(host.calls.paint.length, 1);
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

    test('a plain wheel scrolls the strip, not the crop', () => {
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('wheel', { deltaY: 100, deltaMode: 0 });

      assert.deepStrictEqual(host.calls.scrollPaneBy, [100]);
      assert.strictEqual(host.calls.paint.length, 0);
      assert.strictEqual(host.calls.commit.length, 0);
      gestures.destroy();
    });

    test('Ctrl+wheel zooms instead — the modifier a trackpad pinch already sends', () => {
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: true });

      assert.strictEqual(host.calls.scrollPaneBy.length, 0);
      assert.strictEqual(host.calls.paint.length, 1);
      gestures.destroy();
    });

    test('a wheel burst paints per notch but commits once, after the debounce', async () => {
      const host = fakeHost([{ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0);
      gestures.attach([frame]);

      frame.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: true });
      frame.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: true });
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

      frame.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: true });
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
      first.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: true });
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

  describe('layerContains', () => {
    const box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const rect = { left: 0, top: 0, width: 200, height: 200 };

    test('a press inside the box hits, with no handle tolerance', () => {
      assert.strictEqual(layerContains(rect, box, 100, 100), true);
    });

    test('a press right on the edge hits — the box is inclusive', () => {
      assert.strictEqual(layerContains(rect, box, 50, 100), true);
    });

    test('a press just outside the edge misses, unlike hitLayer\'s handle tolerance', () => {
      assert.strictEqual(layerContains(rect, box, 45, 100), false);
      assert.notStrictEqual(hitLayer(rect, box, 45, 100), null, 'hitLayer still grabs the handle there');
    });

    test('an unmeasured frame misses rather than dividing by zero', () => {
      assert.strictEqual(layerContains({ left: 0, top: 0, width: 0, height: 0 }, box, 0, 0), false);
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

  describe('snapLines', () => {
    const safe = { x: 0.05, y: 0.13, w: 0.9, h: 0.74 };

    test('the edges, the centre and the safe-area rect, per axis', () => {
      const lines = snapLines(safe);
      assert.deepStrictEqual(lines.v.slice(0, 4), [0, 0.5, 1, 0.05]);
      assert.ok(Math.abs(lines.v[4] - 0.95) < 1e-9, `${lines.v[4]}`);
      assert.deepStrictEqual(lines.h.slice(0, 4), [0, 0.5, 1, 0.13]);
      assert.ok(Math.abs(lines.h[4] - 0.87) < 1e-9, `${lines.h[4]}`);
    });

    test('no safe area leaves the edges and the centre', () => {
      assert.deepStrictEqual(snapLines(null).v, [0, 0.5, 1]);
    });

    test('seams join the verticals only — they are a deck-space guide', () => {
      const lines = snapLines(safe, deckSeams(3));
      assert.ok(Math.abs(lines.v.at(-2) - 1 / 3) < 1e-9, `${lines.v}`);
      assert.ok(Math.abs(lines.v.at(-1) - 2 / 3) < 1e-9, `${lines.v}`);
      assert.deepStrictEqual(lines.h.slice(0, 4), [0, 0.5, 1, 0.13]);
    });
  });

  describe('deckSeams', () => {
    test('the internal boundaries only — 0 and 1 are already guides', () => {
      assert.deepStrictEqual(deckSeams(1), []);
      assert.deepStrictEqual(deckSeams(2), [0.5]);
      assert.deepStrictEqual(deckSeams(4), [0.25, 0.5, 0.75]);
    });
  });

  describe('deckRect', () => {
    const col = { left: 400, top: 30, width: 200, height: 250 };

    test('column i of n resolves the whole deck box around it', () => {
      assert.deepStrictEqual(deckRect(col, 2, 3), {
        left: 0,
        top: 30,
        width: 600,
        height: 250,
      });
    });

    test('a one-slide deck is its own deck box', () => {
      assert.deepStrictEqual(deckRect({ ...col, left: 0 }, 0, 1), {
        left: 0,
        top: 30,
        width: 200,
        height: 250,
      });
    });
  });

  describe('snapBox', () => {
    const tol = { x: 0.02, y: 0.02 };
    const lines = snapLines({ x: 0.05, y: 0.13, w: 0.9, h: 0.74 });

    test('a move snaps the near edge to the canvas centre and reports the guide', () => {
      const box = { x: 0.49, y: 0.3, w: 0.2, h: 0.2 };
      const { box: snapped, guides } = snapBox(box, 'move', { h: 0, v: 0 }, lines, tol, false);
      assert.ok(Math.abs(snapped.x - 0.5) < 1e-9, 'left edge on 0.5');
      assert.deepStrictEqual(guides.v, [0.5]);
    });

    test('the modifier suppresses the snap and clears the guides', () => {
      const box = { x: 0.49, y: 0.3, w: 0.2, h: 0.2 };
      const { box: snapped, guides } = snapBox(box, 'move', { h: 0, v: 0 }, lines, tol, true);
      assert.strictEqual(snapped.x, 0.49);
      assert.deepStrictEqual(guides, { v: [], h: [] });
    });

    test('a resize snaps only the anchored edge', () => {
      const box = { x: 0.2, y: 0.2, w: 0.31, h: 0.4 }; // right edge at 0.51, near safe.x+safe.w? no — near 0.5
      const { box: snapped, guides } = snapBox(box, 'resize', { h: 1, v: 0 }, lines, tol, false);
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
      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10, ctrlKey: true });
      frame.emit('pointermove', { pointerId: 1, clientX: 60, clientY: 10, ctrlKey: true });
      assert.ok(host.calls.paint.length >= 1, 'the crop repainted');
      assert.strictEqual(host.calls.paintLayer.length, 0);
      gestures.destroy();
    });

    test('with no layer selected a press inside a layer\'s box selects it, not the crop — see "click-to-select"', () => {
      const host = fakeHost([{ crop: FULL, fit: 'cover', layers: [{ box: LAYER_BOX }] }], null);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0, { width: 200, height: 200 });
      gestures.attach([frame]);
      // Even with the crop-pan modifier held: layer hit beats slide/crop hit.
      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100, ctrlKey: true });
      frame.emit('pointermove', { pointerId: 1, clientX: 150, clientY: 100, ctrlKey: true });
      assert.deepStrictEqual(host.calls.selectLayer, [{ i: 0, j: 0, scope: 'slide' }]);
      assert.strictEqual(host.calls.paint.length, 0, 'the crop did not pan');
      assert.strictEqual(host.calls.paintLayer.length, 0, 'no drag was started for it');
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

  /**
   * Span layers (S6.3). A `doc.spanLayers` box is fractions of the whole deck,
   * so the gesture has to run in deck coordinates: grabbable from any column it
   * reaches, pointer maths against the deck box rather than one column's, seams
   * among the guides, and the commit addressed to the span pseudo-slide.
   */
  describe('span layer manipulation', () => {
    /** The default deck headline shape: 0.32..0.42 of a three-slide deck, so it
     *  sits inside column 1 with room to run at a seam. */
    const SPAN_BOX = { x: 0.32, y: 0.4, w: 0.1, h: 0.2 };
    /** `SPAN_SLIDE` in `document.js` — the index a deck-wide layer commits to. */
    const SPAN_SLIDE = -1;

    /** Three 200×250 columns side by side, so the deck box is 600×250, and a
     *  span layer selected on the pseudo-slide. */
    function setup(box = SPAN_BOX) {
      const slide = { crop: FULL, fit: 'cover', layers: [] };
      const host = fakeHost([slide, slide, slide], {
        i: SPAN_SLIDE,
        j: 0,
        box,
        scope: 'span',
      });
      const gestures = createDeckGestures(host);
      const frames = [0, 1, 2].map((i) =>
        fakeFrame(i, { width: 200, height: 250, left: i * 200 }),
      );
      gestures.attach(frames);
      return { host, gestures, frames };
    }

    test('a press on the column the layer sits in drags it in deck fractions', () => {
      const { host, gestures, frames } = setup();
      // Deck x 0.37 → 222px, inside column 1. +60px is 0.1 of the 600px deck.
      frames[1].emit('pointerdown', { pointerId: 1, button: 0, clientX: 222, clientY: 125 });
      frames[1].emit('pointermove', { pointerId: 1, clientX: 282, clientY: 125, altKey: true });
      frames[1].emit('pointerup', { pointerId: 1, clientX: 282, clientY: 125, altKey: true });

      assert.strictEqual(host.calls.commit.length, 0, 'the crop was left alone');
      assert.strictEqual(host.calls.commitLayer.length, 1);
      const { i, j, box } = host.calls.commitLayer[0];
      assert.strictEqual(i, SPAN_SLIDE, 'committed against the span pseudo-slide');
      assert.strictEqual(j, 0);
      assert.ok(Math.abs(box.x - 0.42) < 1e-9, `x = 0.32 + 60/600: ${box.x}`);
      gestures.destroy();
    });

    test('a press on any other column it crosses grabs it too', () => {
      // 0.06..0.94 of the deck — every column reaches it.
      const { host, gestures, frames } = setup({ x: 0.06, y: 0.4, w: 0.88, h: 0.2 });
      // Column 2 spans 400..600px; 0.85 of the deck is 510px.
      frames[2].emit('pointerdown', { pointerId: 1, button: 0, clientX: 510, clientY: 125 });
      frames[2].emit('pointermove', { pointerId: 1, clientX: 540, clientY: 125, altKey: true });
      frames[2].emit('pointerup', { pointerId: 1, clientX: 540, clientY: 125, altKey: true });

      assert.strictEqual(host.calls.commitLayer.length, 1);
      assert.strictEqual(host.calls.commitLayer[0].i, SPAN_SLIDE);
      assert.ok(host.calls.commitLayer[0].box.x > 0.06, 'it moved right');
      gestures.destroy();
    });

    test('a press that misses it still pans that column\'s crop', () => {
      const { host, gestures, frames } = setup();
      // Column 0 is 0..1/3 of the deck; the layer starts at 0.32·600 = 192px,
      // and y=20 is well above its band either way.
      frames[0].emit('pointerdown', { pointerId: 1, button: 0, clientX: 40, clientY: 20, ctrlKey: true });
      frames[0].emit('pointermove', { pointerId: 1, clientX: 100, clientY: 20, ctrlKey: true });
      assert.ok(host.calls.paint.length >= 1, 'the crop repainted');
      assert.strictEqual(host.calls.paintLayer.length, 0);
      gestures.destroy();
    });

    test('a seam is a guide: the dragged edge clicks onto it', () => {
      const { host, gestures, frames } = setup();
      // 6px of the 600px deck is 0.01, landing the left edge on 0.33 — inside
      // the 7px tolerance of the seam at 1/3.
      frames[1].emit('pointerdown', { pointerId: 1, button: 0, clientX: 222, clientY: 125 });
      frames[1].emit('pointermove', { pointerId: 1, clientX: 228, clientY: 125 });
      const last = host.calls.paintLayer.at(-1);
      assert.strictEqual(last.i, SPAN_SLIDE, 'painted as a span layer');
      assert.ok(
        last.guides.v.some((v) => Math.abs(v - 1 / 3) < 1e-9),
        `the seam engaged: ${last.guides.v}`,
      );
      frames[1].emit('pointerup', { pointerId: 1, clientX: 228, clientY: 125 });
      assert.ok(
        Math.abs(host.calls.commitLayer[0].box.x - 1 / 3) < 1e-9,
        `left edge on the seam: ${host.calls.commitLayer[0].box.x}`,
      );
      gestures.destroy();
    });

    test('arrow keys nudge it from whichever column has focus', () => {
      const { host, gestures, frames } = setup();
      frames[2].emit('keydown', { key: 'ArrowRight', shiftKey: false });
      assert.deepStrictEqual(host.calls.refocus, [2], 'focus goes back to that column');
      assert.strictEqual(host.calls.commitLayer.length, 1);
      assert.strictEqual(host.calls.commitLayer[0].i, SPAN_SLIDE);
      assert.ok(host.calls.commitLayer[0].box.x > SPAN_BOX.x, 'moved right');
      assert.strictEqual(host.calls.commit.length, 0, 'the crop nudge did not fire');
      gestures.destroy();
    });
  });

  /**
   * Click-to-select (S7.3). A press with no active layer, or one that misses
   * the active layer and its handles, falls through to `layersOnColumn` —
   * every other layer painted on the pressed column — before giving up to the
   * crop/slide-select path.
   */
  describe('click-to-select on the stage', () => {
    const LAYER_BOX = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };

    test('a press on an unselected layer selects it, and starts no drag', () => {
      const host = fakeHost([{ crop: FULL, fit: 'cover', layers: [{ box: LAYER_BOX }] }], null);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0, { width: 200, height: 200 });
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
      assert.deepStrictEqual(host.calls.selectLayer, [{ i: 0, j: 0, scope: 'slide' }]);
      assert.strictEqual(host.calls.select.length, 0, 'did not fall through to slide-select');
      assert.strictEqual(host.calls.paint.length, 0, 'did not fall through to a crop pan');

      // No drag was started: a move goes nowhere, and a release commits nothing.
      frame.emit('pointermove', { pointerId: 1, clientX: 140, clientY: 100 });
      frame.emit('pointerup', { pointerId: 1, clientX: 140, clientY: 100 });
      assert.strictEqual(host.calls.commitLayer.length, 0);
      assert.strictEqual(host.calls.paintLayer.length, 0);
      gestures.destroy();
    });

    test('a press on a different slide\'s layer selects that column\'s own list, not the active one\'s', () => {
      const layerA = { box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } };
      const layerB = { box: LAYER_BOX };
      const host = fakeHost(
        [
          { crop: FULL, fit: 'cover', layers: [layerA] },
          { crop: FULL, fit: 'cover', layers: [layerB] },
        ],
        { i: 0, j: 0, box: layerA.box },
      );
      const gestures = createDeckGestures(host);
      const frames = [0, 1].map((i) => fakeFrame(i, { width: 200, height: 200, left: i * 200 }));
      gestures.attach(frames);

      // Column 1's own layer, at a press the active (column 0) layer cannot reach.
      frames[1].emit('pointerdown', { pointerId: 1, button: 0, clientX: 300, clientY: 100 });
      assert.deepStrictEqual(host.calls.selectLayer, [{ i: 1, j: 0, scope: 'slide' }]);
      gestures.destroy();
    });

    test('a press on a span layer selects it with scope "span"', () => {
      const spanLayer = { box: { x: 0.4, y: 0.3, w: 0.2, h: 0.4 } };
      const host = fakeHost([{ crop: FULL, fit: 'cover', layers: [] }], null, [spanLayer]);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0, { width: 200, height: 200 });
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
      assert.deepStrictEqual(host.calls.selectLayer, [{ i: 0, j: 0, scope: 'span' }]);
      gestures.destroy();
    });

    test('a slide layer wins over an overlapping span layer — topmost first', () => {
      const spanLayer = { box: { x: 0, y: 0, w: 1, h: 1 } };
      const host = fakeHost(
        [{ crop: FULL, fit: 'cover', layers: [{ box: LAYER_BOX }] }],
        null,
        [spanLayer],
      );
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0, { width: 200, height: 200 });
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
      assert.deepStrictEqual(host.calls.selectLayer, [{ i: 0, j: 0, scope: 'slide' }]);
      gestures.destroy();
    });

    test('a press that lands on no layer keeps today\'s behavior: pan the crop', () => {
      const host = fakeHost([{ crop: FULL, fit: 'cover', layers: [{ box: LAYER_BOX }] }], null);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0, { width: 200, height: 200 });
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10, ctrlKey: true });
      frame.emit('pointermove', { pointerId: 1, clientX: 60, clientY: 10, ctrlKey: true });
      assert.strictEqual(host.calls.selectLayer.length, 0);
      assert.ok(host.calls.paint.length >= 1, 'the crop repainted');
      gestures.destroy();
    });

    test('a press that lands on no layer, and does not move, selects the slide', () => {
      const host = fakeHost([{ crop: FULL, fit: 'cover', layers: [{ box: LAYER_BOX }] }], null);
      const gestures = createDeckGestures(host);
      const frame = fakeFrame(0, { width: 200, height: 200 });
      gestures.attach([frame]);

      frame.emit('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10, ctrlKey: true });
      frame.emit('pointerup', { pointerId: 1, clientX: 10, clientY: 10, ctrlKey: true });
      assert.strictEqual(host.calls.selectLayer.length, 0);
      assert.deepStrictEqual(host.calls.select, [0]);
      gestures.destroy();
    });
  });

  // ── Panorama: the vertical anchor ────────────────────────────────────────

  describe('anchorSlackPx', () => {
    test('the band travels the trimmed source height, scaled into the stage', () => {
      // 500 source px trimmed at scale 1 is 500 of the canvas's 1350, and the
      // stage shows those 1350 in 270 CSS px — so the band has 100 px to move.
      assert.strictEqual(anchorSlackPx(270, 1350, 500, 1), 100);
    });

    test('the strategy\'s resample carries through', () => {
      assert.strictEqual(anchorSlackPx(270, 1350, 1000, 0.5), 100);
    });

    test('no slack, no stage or no scale is no travel — there is nothing to drag', () => {
      assert.strictEqual(anchorSlackPx(270, 1350, 0, 1), 0);
      assert.strictEqual(anchorSlackPx(0, 1350, 500, 1), 0);
      assert.strictEqual(anchorSlackPx(270, 1350, 500, 0), 0);
    });
  });

  describe('dragAnchor', () => {
    test('the band follows the pointer, so the anchor runs against it', () => {
      assert.strictEqual(dragAnchor(0.5, 50, 100), 0);
      assert.strictEqual(dragAnchor(0.5, -50, 100), 1);
    });

    test('a drag past either end pins there rather than wrapping', () => {
      assert.strictEqual(dragAnchor(0.5, 500, 100), 0);
      assert.strictEqual(dragAnchor(0.5, -500, 100), 1);
    });

    test('no slack leaves the anchor alone', () => {
      assert.strictEqual(dragAnchor(0.4, 50, 0), 0.4);
    });
  });

  describe('sameAnchor', () => {
    test('a sub-pixel difference is the same anchor — the render rounds there too', () => {
      assert.ok(sameAnchor(0.5, 0.5004, 1000));
    });

    test('a whole-pixel difference is not', () => {
      assert.ok(!sameAnchor(0.5, 0.502, 1000));
    });
  });

  describe('createAnchorGesture', () => {
    /** A panorama stage stand-in — the controller touches only these members. */
    function fakeStage(height = 270) {
      const listeners = [];
      const classes = new Set();
      return {
        listeners,
        classes,
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
        },
        setPointerCapture() {},
        releasePointerCapture() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height }),
        addEventListener(type, fn) {
          listeners.push({ type, fn });
        },
        removeEventListener(type, fn) {
          const at = listeners.findIndex((l) => l.type === type && l.fn === fn);
          if (at >= 0) listeners.splice(at, 1);
        },
        emit(type, event = {}) {
          for (const l of [...listeners]) if (l.type === type) l.fn(event);
        },
      };
    }

    /** A stage with 100 CSS px of slack (500 source px trimmed, scale 1, a
     *  270px stage over the 1350px canvas). `metrics: null` is a stage with
     *  nothing to drag. */
    function setup({ metrics = { anchorY: 0.5, trimmedH: 500, scale: 1, dstH: 1350 } } = {}) {
      const calls = { paint: [], commit: [], dress: [] };
      const gesture = createAnchorGesture({
        metrics: () => metrics,
        paint: (a) => calls.paint.push(a),
        commit: (a) => calls.commit.push(a),
        dress: (on) => calls.dress.push(on),
      });
      const stage = fakeStage();
      gesture.attach(stage);
      return { calls, gesture, stage };
    }

    test('a mouse drag paints every move and commits once, on release', () => {
      const { calls, gesture, stage } = setup();
      stage.emit('pointerdown', { pointerId: 1, button: 0, clientX: 40, clientY: 100 });
      stage.emit('pointermove', { pointerId: 1, clientX: 40, clientY: 120 });
      stage.emit('pointermove', { pointerId: 1, clientX: 40, clientY: 150 });
      assert.deepStrictEqual(calls.paint, [0.3, 0.0]);
      assert.strictEqual(calls.commit.length, 0, 'nothing committed mid-drag');
      stage.emit('pointerup', { pointerId: 1, clientX: 40, clientY: 150 });
      assert.deepStrictEqual(calls.commit, [0]);
      assert.deepStrictEqual(calls.dress, [true, false]);
      assert.ok(!stage.classes.has('is-anchoring'), 'the rail is put away');
      gesture.destroy();
    });

    test('a press on a stage with no slack never takes the pointer', () => {
      const { calls, gesture, stage } = setup({ metrics: null });
      stage.emit('pointerdown', { pointerId: 1, button: 0, clientX: 40, clientY: 100 });
      stage.emit('pointermove', { pointerId: 1, clientX: 40, clientY: 150 });
      stage.emit('pointerup', { pointerId: 1, clientX: 40, clientY: 150 });
      assert.deepStrictEqual(calls.paint, []);
      assert.deepStrictEqual(calls.commit, []);
      gesture.destroy();
    });

    test('a drag that ran into the end and back repaints the document, and does not commit', () => {
      const { calls, gesture, stage } = setup();
      stage.emit('pointerdown', { pointerId: 1, button: 0, clientX: 40, clientY: 100 });
      stage.emit('pointermove', { pointerId: 1, clientX: 40, clientY: 140 });
      stage.emit('pointermove', { pointerId: 1, clientX: 40, clientY: 100 });
      stage.emit('pointerup', { pointerId: 1, clientX: 40, clientY: 100 });
      assert.deepStrictEqual(calls.commit, [], 'the strip is not re-cut for nothing');
      assert.strictEqual(calls.paint.at(-1), 0.5, 'repainted from the document');
      gesture.destroy();
    });

    test('a press that never travelled leaves the band alone', () => {
      const { calls, gesture, stage } = setup();
      stage.emit('pointerdown', { pointerId: 1, button: 0, clientX: 40, clientY: 100 });
      stage.emit('pointerup', { pointerId: 1, clientX: 40, clientY: 101 });
      assert.deepStrictEqual(calls.commit, []);
      gesture.destroy();
    });

    test('a sideways finger belongs to the scroller, a vertical one to the band', () => {
      const across = setup();
      across.stage.emit('pointerdown', {
        pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 100,
      });
      across.stage.emit('pointermove', { pointerId: 1, clientX: 80, clientY: 102 });
      across.stage.emit('pointermove', { pointerId: 1, clientX: 120, clientY: 104 });
      assert.deepStrictEqual(across.calls.paint, [], 'the strip scrolled instead');
      across.gesture.destroy();

      const down = setup();
      down.stage.emit('pointerdown', {
        pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 100,
      });
      down.stage.emit('pointermove', { pointerId: 1, clientX: 42, clientY: 120 });
      assert.deepStrictEqual(down.calls.paint, [0.3]);
      down.gesture.destroy();
    });

    test('attach releases the previous stage, and destroy releases the last', () => {
      const { gesture, stage } = setup();
      assert.strictEqual(stage.listeners.length, 4);
      const next = fakeStage();
      gesture.attach(next);
      assert.strictEqual(stage.listeners.length, 0, 'the old stage is let go');
      assert.strictEqual(next.listeners.length, 4);
      gesture.destroy();
      assert.strictEqual(next.listeners.length, 0);
    });

    test('attaching nothing — a deck render — just releases', () => {
      const { gesture, stage } = setup();
      gesture.attach(null);
      assert.strictEqual(stage.listeners.length, 0);
      gesture.destroy();
    });
  });
});
