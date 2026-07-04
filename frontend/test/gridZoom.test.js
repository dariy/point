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

const { getZoom, setZoom, clampZoom, maxZoomCols } = await import('../src/utils/gridFit.js');

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
