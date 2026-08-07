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
  applyZoomVar, applyRowsVar, zoomCapacity,
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
