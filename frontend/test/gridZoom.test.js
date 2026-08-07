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
globalThis.window = { innerWidth: 1200, innerHeight: 800, getComputedStyle: () => ({}) };
globalThis.document = {
  body: {
    classList: { add() {}, remove() {} },
    style: { setProperty() {}, removeProperty() {} },
    appendChild() {}, // tokenPx() appends a measurement probe here
  },
  createElement: () => ({ style: {}, remove() {}, offsetWidth: 0 }),
  appendChild() {},
  querySelector: () => null,
};

const { getZoom, setZoom, clampZoom, maxZoomCols, createFitLatch } = await import('../src/utils/gridFit.js');

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
