/* global globalThis */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// ── Minimal globals ──────────────────────────────────────────────────────────
// pointerMode touches three things: the <html> class list, localStorage, and
// window event listeners. Fake all three so the verdict can be driven by hand.
const stored = new Map();
globalThis.localStorage = {
  getItem: (k) => (stored.has(k) ? stored.get(k) : null),
  setItem: (k, v) => stored.set(k, String(v)),
  removeItem: (k) => stored.delete(k),
};

const classes = new Set();
globalThis.document = {
  documentElement: {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  },
};

let listeners = {};
globalThis.window = {
  addEventListener: (type, fn) => {
    (listeners[type] ||= []).push(fn);
  },
  matchMedia: () => ({ matches: false }),
};

const { initPointerMode, hasFinePointer } = await import('../src/utils/pointerMode.js');

const fire = (type, event = {}) => (listeners[type] || []).forEach((fn) => fn(event));
const mouse = () => fire('pointerdown', { pointerType: 'mouse' });
const finger = () => {
  fire('touchstart', {});
  fire('pointerdown', { pointerType: 'touch' });
};

describe('pointer mode', () => {
  beforeEach(() => {
    stored.clear();
    classes.clear();
    listeners = {};
  });

  test('a mouse event marks the session fine and caches the verdict', () => {
    initPointerMode();
    assert.equal(hasFinePointer(), false);
    mouse();
    assert.equal(hasFinePointer(), true);
    assert.equal(stored.get('pointerFine'), '1');
  });

  test('the cached verdict applies before any input', () => {
    stored.set('pointerFine', '1');
    initPointerMode();
    assert.equal(hasFinePointer(), true);
  });

  test('a touch takes the mark back off — including a cached one', () => {
    // The regression this guards: the verdict used to latch on the first mouse
    // event and stay cached, so a browser later driven by touch (a docked
    // tablet, DevTools device mode) kept mouse affordances and lost the tap
    // paths that check it — header dropdowns opened on hover only.
    stored.set('pointerFine', '1');
    initPointerMode();
    finger();
    assert.equal(hasFinePointer(), false);
    assert.equal(stored.has('pointerFine'), false);
  });

  test('the mouse events a tap emits do not promote it straight back', () => {
    initPointerMode();
    mouse();
    finger();
    mouse(); // the tap's compatibility mouse event, same millisecond
    assert.equal(hasFinePointer(), false);
  });

  test('a real mouse after the echo window promotes again', () => {
    initPointerMode();
    finger();
    const now = Date.now;
    Date.now = () => now() + 5000;
    try {
      mouse();
    } finally {
      Date.now = now;
    }
    assert.equal(hasFinePointer(), true);
    assert.equal(stored.get('pointerFine'), '1');
  });

  test('pen input counts as coarse', () => {
    stored.set('pointerFine', '1');
    initPointerMode();
    fire('pointerdown', { pointerType: 'pen' });
    assert.equal(hasFinePointer(), false);
  });
});
