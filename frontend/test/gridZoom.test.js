// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

// ── Minimal globals so gridFit.js's zoom helpers run under node ────────────────
// tokenPx() appends a probe and reads offsetWidth; a stub that returns 0 makes
// maxZoomCols fall back to window.innerWidth (maxW || innerWidth), which is
// exactly the path we want to exercise deterministically.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = {
  innerWidth: 1200, innerHeight: 800, getComputedStyle: () => ({}),
  dispatchEvent() {}, // applyZoomVar announces every change to the footer slider
};
globalThis.CustomEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
const bodyVars = new Map();
globalThis.document = {
  body: {
    classList: { add() {}, remove() {} },
    style: {
      setProperty(k, v) { bodyVars.set(k, v); },
      removeProperty(k) { bodyVars.delete(k); },
    },
    appendChild() {}, // tokenPx() appends a measurement probe here
  },
  createElement: () => ({ style: {}, remove() {}, offsetWidth: 0 }),
  appendChild() {},
  querySelector: () => null,
};

const {
  getZoom, setZoom, clampZoom, maxZoomCols, createFitLatch,
  createResizeGate, TOOLBAR_BAND_PX,
  applyZoomVar, applyRowsVar, zoomCapacity,
  cardImageSizes, applyCardImageSizes,
} = await import('../src/utils/gridFit.js');

describe('grid zoom', () => {
  beforeEach(() => { store.clear(); });

  test('setZoom/getZoom roundtrip; 0 clears', () => {
    assert.equal(getZoom(), 0);          // unset ⇒ auto
    setZoom(3);
    assert.equal(getZoom(), 3);
    setZoom(0);
    assert.equal(getZoom(), 0);          // cleared back to auto
  });

  test('maxZoomCols scales with viewport width and caps at 6', () => {
    window.innerWidth = 375;             // phone
    assert.equal(maxZoomCols(), 2);      // floor(375/160)
    window.innerWidth = 1000;
    assert.equal(maxZoomCols(), 6);      // floor(1000/160)=6, capped
    window.innerWidth = 4000;            // ultrawide
    assert.equal(maxZoomCols(), 6);      // still capped at 6
    window.innerWidth = 1200;            // restore
  });

  test('clampZoom keeps cols within [1, maxZoomCols]', () => {
    window.innerWidth = 375;
    assert.equal(clampZoom(1), 1);
    assert.equal(clampZoom(5), 2);       // clamped down to phone max
    assert.equal(clampZoom(0), 1);       // never below 1
    window.innerWidth = 1200;
    assert.equal(clampZoom(4), 4);       // within range, untouched
  });
});

// The row count is pinned so the grid holds its final shape between a zoom step
// and the refit that fills it — without it the cards still on screen share the
// whole viewport height as one stretched row until the refetch lands.
describe('zoom row pinning', () => {
  beforeEach(() => { store.clear(); bodyVars.clear(); applyRowsVar(0); });

  test('applyRowsVar publishes the row count and 0 withdraws it', () => {
    applyRowsVar(2);
    assert.equal(bodyVars.get('--posts-grid-rows'), '2');
    applyRowsVar(0);
    assert.equal(bodyVars.has('--posts-grid-rows'), false);
  });

  test('zoomCapacity is columns × rows, and 0 until both are known', () => {
    applyRowsVar(2);
    assert.equal(zoomCapacity(), 0);     // no zoom ⇒ no pinned geometry
    setZoom(4);
    assert.equal(zoomCapacity(), 8);
    applyRowsVar(0);
    assert.equal(zoomCapacity(), 0);     // rows unknown ⇒ nothing to hold to
  });

  test('capacity follows the clamped column count, not the stored one', () => {
    window.innerWidth = 375;             // phone: maxZoomCols is 2
    setZoom(5);
    applyRowsVar(3);
    assert.equal(zoomCapacity(), 6);     // 2 × 3, not 5 × 3
    window.innerWidth = 1200;
  });

  test('leaving zoom releases the row tracks too', () => {
    setZoom(3);
    applyRowsVar(2);
    setZoom(0);
    applyZoomVar();
    assert.equal(bodyVars.has('--posts-grid-rows'), false);
    assert.equal(zoomCapacity(), 0);
  });
});

describe('fit latch', () => {
  test('passes a fit through and lets it keep settling', () => {
    const latch = createFitLatch();
    assert.equal(latch.accept(10, 6), 6);  // first measurement
    assert.equal(latch.accept(6, 6), null); // nothing to change
    assert.equal(latch.accept(6, 5), 5);   // chrome laid out; still refining
  });

  test('breaks the 2↔4 cycle a page-count-dependent paginator causes', () => {
    // 375x667, two zoom columns: compact paginator ⇒ 2 rows fit (4 posts),
    // whose 7-page paginator wraps to two lines ⇒ only 1 row fits (2 posts),
    // whose 13 pages go compact again…
    const latch = createFitLatch();
    assert.equal(latch.accept(2, 4), 4);
    assert.equal(latch.accept(4, 2), 2);
    assert.equal(latch.accept(2, 4), null); // seen 4 before — stay at the smaller
    assert.equal(latch.accept(2, 4), null); // and stay latched
    assert.equal(latch.accept(2, 8), null);
  });

  test('a cycle detected while showing the larger value settles downward', () => {
    const latch = createFitLatch();
    assert.equal(latch.accept(4, 2), 2);
    assert.equal(latch.accept(2, 4), 4);
    assert.equal(latch.accept(4, 2), 2);    // shrinking is always safe to apply
    assert.equal(latch.accept(2, 4), null); // latched from here on
  });

  test('reset re-opens the question after a resize or zoom step', () => {
    const latch = createFitLatch();
    latch.accept(2, 4);
    latch.accept(4, 2);
    assert.equal(latch.accept(2, 4), null);
    latch.reset();
    assert.equal(latch.accept(2, 4), 4);    // new viewport, new decision
  });
});

describe('resize gate', () => {
  // iPad portrait; the toolbar transition that fires resize while scrolling is
  // ~90px of height and no width at all.
  const PAD = { w: 834, h: 1194 };

  test('ignores a chrome-sized height change at the same width', () => {
    const gate = createResizeGate(PAD.w, PAD.h);
    assert.equal(gate.accept(PAD.w, PAD.h - 90), false); // toolbar collapsed
    assert.equal(gate.accept(PAD.w, PAD.h), false);      // and back again
  });

  test('accepts a height change larger than the band', () => {
    const gate = createResizeGate(PAD.w, PAD.h);
    assert.equal(gate.accept(PAD.w, PAD.h - 400), true); // a real resize
  });

  test('accepts any width change, however small the height moved', () => {
    const gate = createResizeGate(PAD.w, PAD.h);
    // Split View divider: width moves, height barely.
    assert.equal(gate.accept(PAD.w - 320, PAD.h - 10), true);
  });

  test('rotation is accepted', () => {
    const gate = createResizeGate(PAD.w, PAD.h);
    assert.equal(gate.accept(PAD.h, PAD.w), true);       // 834x1194 → 1194x834
  });

  test('the band is inclusive at its edge', () => {
    const gate = createResizeGate(PAD.w, PAD.h);
    assert.equal(gate.accept(PAD.w, PAD.h - TOOLBAR_BAND_PX), false);
    assert.equal(gate.accept(PAD.w, PAD.h - TOOLBAR_BAND_PX - 1), true);
  });

  test('a rejected resize does not creep the baseline', () => {
    const gate = createResizeGate(PAD.w, PAD.h);
    // Three toolbar-sized steps in the same direction still measure against the
    // height the last accepted fit ran at, so the third one is a real change.
    assert.equal(gate.accept(PAD.w, PAD.h - 90), false);
    assert.equal(gate.accept(PAD.w, PAD.h - 140), false);
    assert.equal(gate.accept(PAD.w, PAD.h - 200), true);
  });

  test('an accepted resize becomes the new baseline', () => {
    const gate = createResizeGate(PAD.w, PAD.h);
    assert.equal(gate.accept(PAD.h, PAD.w), true);       // rotated
    assert.equal(gate.accept(PAD.h, PAD.w - 90), false); // toolbar, landscape
  });

  test('defaults to the live window when called with no arguments', () => {
    const gate = createResizeGate();                     // seeded at 1200x800
    window.innerHeight = 800 - 90;
    assert.equal(gate.accept(), false);
    window.innerHeight = 800 - 300;
    assert.equal(gate.accept(), true);
    window.innerHeight = 800;                            // restore
  });
});

/**
 * The `sizes` a card's <img srcset> carries.
 *
 * There is no static answer to write into the markup: the column count comes
 * from `auto-fill` against the viewport, or — once the reader has pinched — from
 * a number in localStorage, and a media query can see neither. So the measured
 * geometry is published here and the cards read it back.
 */
describe('card image sizes', () => {
  /** A card image, with just enough element for applyCardImageSizes. */
  const img = (hero = false) => ({
    sizes: '',
    closest: (sel) => (hero && sel === '.featured-post' ? {} : null),
  });

  test('a measured grid names the track width, in px', () => {
    applyCardImageSizes(320, 1000);
    assert.equal(cardImageSizes(), '320px');
    // The featured card spans the whole row, so it is a different image.
    assert.equal(cardImageSizes(true), '1000px');
  });

  test('an unmeasurable grid falls back to a responsive guess', () => {
    applyCardImageSizes(0, 0);
    assert.match(cardImageSizes(), /100vw/);
    assert.equal(cardImageSizes(true), cardImageSizes());
  });

  test('images already on screen are re-pointed when the grid changes shape', () => {
    applyCardImageSizes(320, 1000);
    const regular = img();
    const featured = img(true);
    const root = { querySelectorAll: () => [regular, featured] };

    applyCardImageSizes(700, 700, root);   // the same grid, one column wide now
    assert.equal(regular.sizes, '700px');
    assert.equal(featured.sizes, '700px');
  });

  test('an unchanged shape does not touch the DOM', () => {
    applyCardImageSizes(320, 1000);
    let queried = 0;
    applyCardImageSizes(320, 1000, { querySelectorAll: () => { queried++; return []; } });
    assert.equal(queried, 0, 'every resize would otherwise walk every card');
  });
});
