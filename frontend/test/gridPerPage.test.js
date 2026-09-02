import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// ── Minimal globals so gridFit.js's viewport fit runs under node ──────────────
// The point of these tests is the *height* the fit divides. The layout box is
// `min-height: 100dvh` in CSS, so the probe reading `100dvh` must win over
// `window.innerHeight` — on iPadOS Safari those are different numbers, and the
// fit leaves no slack for the difference. Here they are deliberately all
// different, so whichever one the code picks is visible in the result.

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/** expr → px, as the browser would resolve it on tokenPx()'s probe. */
let probeTable = {};

globalThis.window = {
  innerWidth: 1200,
  innerHeight: 1000,          // the layout viewport — NOT what the box gets
  getComputedStyle: () => ({}),
  dispatchEvent() {},
};
globalThis.CustomEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };

globalThis.document = {
  body: {
    classList: { contains: () => false, add() {}, remove() {} },
    style: { setProperty() {}, removeProperty() {} },
    appendChild() {},         // tokenPx() appends its probe here
  },
  // tokenPx writes `width:<expr>;height:<expr>` through cssText; the stub
  // resolves both sides off the same table, which is what a browser does for
  // every unit except the viewport ones — see the dvh/dvw note in tokenPx.
  createElement: () => {
    const el = { remove() {}, offsetWidth: 0, offsetHeight: 0 };
    el.style = {
      set cssText(v) {
        const expr = /width:([^;]*)/.exec(v)?.[1] ?? '';
        const px = probeTable[expr] || 0;
        el.offsetWidth = px;
        el.offsetHeight = probeTable[`h:${expr}`] ?? px;
      },
    };
    return el;
  },
  querySelector: () => null,
};

const { computePerPage, layoutViewportHeight } = await import('../src/utils/gridFit.js');

/**
 * A probe table for the pre-grid estimate: no max-width and no padding/gap, a
 * 300px column and a 100px card, so cols = floor(1200/300) = 4 and the row
 * height is a round number. `heights` overrides what the viewport units resolve
 * to (empty ⇒ the unit is unsupported, exactly as an old engine reports it).
 */
function layout(heights, { colW = 300, cardH = 100 } = {}) {
  probeTable = {
    'var(--content-max-width)': 0,
    'var(--spacing-md)': 0,
    'var(--spacing-xl)': 0,
    'var(--posts-grid-grid-template-columns)': colW,
    'var(--post-cardhas-image-min-height)': cardH,
    ...heights,
  };
}

describe('viewport fit measures the box the CSS sizes', () => {
  beforeEach(() => { store.clear(); probeTable = {}; });

  test('layoutViewportHeight prefers 100dvh', () => {
    layout({ '100dvh': 900, '100vh': 800 });
    assert.equal(layoutViewportHeight(), 900);
  });

  test('layoutViewportHeight falls back to 100vh, then innerHeight', () => {
    layout({ '100vh': 800 });                     // no dvh support
    assert.equal(layoutViewportHeight(), 800);
    layout({});                                   // no viewport units at all
    assert.equal(layoutViewportHeight(), 1000);   // window.innerHeight
  });

  // The end of the chain. Every caller subtracts chrome from this height and
  // then divides by a row, so the last resort has to be a *number*: an engine
  // that resolves neither viewport unit and reports no innerHeight yields 0, and
  // the fit degrades to the single row `avail` is floored at. Returning
  // undefined instead would carry NaN through the subtraction and the divide,
  // and Math.max(1, NaN) is NaN — a per_page the whole feed would then be
  // fetched with.
  test('layoutViewportHeight bottoms out at 0, never undefined', () => {
    const real = window.innerHeight;
    try {
      window.innerHeight = 0;
      layout({}); // no dvh, no vh
      assert.equal(layoutViewportHeight(), 0);
      // avail = max(rowH, 0 - 0 - 0 - slack) = one row; cols = 1200/300 = 4.
      assert.equal(computePerPage(7), 4);
    } finally {
      window.innerHeight = real;
    }
  });

  test('computePerPage follows the probe, not window.innerHeight', () => {
    layout({ '100dvh': 900, '100vh': 800 });
    // top = min(900*0.25, 220) = 220; avail = 900 - 220 - 2 slack = 678
    // rows = floor(678/100) = 6; cols = 4.
    // Had it read window.innerHeight (1000) it would be 7 rows ⇒ 28.
    assert.equal(computePerPage(1), 24);
  });

  test('the fallback chain reaches computePerPage too', () => {
    layout({ '100vh': 800 });
    // top = 200; avail = 800 - 200 - 2 = 598; rows = floor(598/100) = 5.
    assert.equal(computePerPage(1), 20);
  });

  test('the fit keeps slack so an exact division cannot spill', () => {
    // 1000 - 220 top = 780, which 195 divides exactly 4 times. Without the
    // slack that 4th row lands the page flush at the viewport height, where a
    // sub-pixel of rounding makes it scrollable.
    layout({ '100dvh': 1000 }, { cardH: 195 });
    assert.equal(computePerPage(1), 12);          // 4 cols × 3 rows, not 16
  });
});
