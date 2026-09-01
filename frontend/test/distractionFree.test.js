// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

/**
 * Distraction-free mode's gesture state machine.
 *
 * On touch the exit button is hidden (CSS), so these three transitions are the
 * only way back out of the mode — if `up` stopped raising the overlay or `down`
 * stopped falling through to the exit, a phone would be stuck in full-screen
 * with no visible control. The plugin only touches classList, localStorage and
 * a window listener, so stubs are enough (no jsdom in the repo — same approach
 * as gridPager.test.js).
 */

let mount, body, holder, swipeHandlers, prefs;

/** The body classes the plugin has set, as a plain array. */
const classes = () => [...body.classList._set];

/** Fire a vertical-swipe event the way GridPager does. */
const flick = (dir) => {
  for (const fn of swipeHandlers['point:grid-swipe-vertical'] || []) fn({ detail: { dir } });
};

function makeEl() {
  return {
    type: '', className: '', innerHTML: '', children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(...cs) { for (const c of cs) this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) { if (on) this.add(c); else this.remove(c); },
    },
    listeners: {},
    appendChild(c) { this.children = this.children.filter((x) => x !== c); this.children.push(c); c.parentElement = this; return c; },
    remove() { const p = this.parentElement; if (p) p.children = p.children.filter((c) => c !== this); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
    setAttribute() {},
    querySelectorAll: () => [],
  };
}

before(async () => {
  prefs = new Map();
  globalThis.localStorage = {
    getItem: (k) => (prefs.has(k) ? prefs.get(k) : null),
    setItem: (k, v) => prefs.set(k, String(v)),
    removeItem: (k) => prefs.delete(k),
  };
  globalThis.window = {
    addEventListener(type, fn) { (swipeHandlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) { swipeHandlers[type] = (swipeHandlers[type] || []).filter((f) => f !== fn); },
  };
  globalThis.document = {
    body: null,
    createElement: () => makeEl(),
    querySelectorAll: () => [], // the orphaned-toggle sweep finds nothing here
  };
  ({ mount } = await import('../src/plugins/distraction-free/index.js'));
});

/** Mount the plugin into a fresh document, optionally already in the mode. */
function setup({ on = false } = {}) {
  swipeHandlers = {};
  prefs.clear();
  if (on) prefs.set('distraction-free', '1');
  body = makeEl();
  document.body = body;
  holder = makeEl();
  return mount(holder);
}

describe('distraction-free gestures', () => {
  beforeEach(() => { swipeHandlers = {}; });

  test('outside the mode a flick does nothing at all', () => {
    setup({ on: false });
    flick('up');
    flick('down');
    assert.deepEqual(classes(), []);
  });

  test('flick up raises the overlay, flick down lowers it', () => {
    setup({ on: true });
    assert.deepEqual(classes(), ['distraction-free']);

    flick('up');
    assert.deepEqual(classes(), ['distraction-free', 'distraction-overlay']);

    flick('up'); // already raised — no change, and no second state to unwind
    assert.deepEqual(classes(), ['distraction-free', 'distraction-overlay']);

    flick('down');
    assert.deepEqual(classes(), ['distraction-free']);
  });

  test('a flick down with the overlay lowered leaves the mode', () => {
    setup({ on: true });
    flick('down');
    assert.deepEqual(classes(), []);
    assert.equal(localStorage.getItem('distraction-free'), '0');
  });

  test('the overlay costs one extra flick, so it is never skipped', () => {
    setup({ on: true });
    flick('up');
    flick('down');
    assert.deepEqual(classes(), ['distraction-free'], 'still in the mode');
    flick('down');
    assert.deepEqual(classes(), [], 'and out on the next one');
  });

  test('leaving via the button takes the overlay with it', () => {
    setup({ on: true });
    flick('up');
    const btn = body.children.find((c) => c.className.includes('distraction-toggle'));
    assert.ok(btn, 'the toggle is portalled to body while the mode is on');

    btn.listeners.click.forEach((fn) => fn());
    assert.deepEqual(classes(), [], 'both classes go, not just the mode');

    // And the overlay does not come back with the mode — a raised overlay is
    // never persisted, so re-entering starts on a bare grid.
    btn.listeners.click.forEach((fn) => fn());
    assert.deepEqual(classes(), ['distraction-free']);
  });

  test('unmount drops the listener, so a stale instance cannot fight the live one', () => {
    const inst = setup({ on: true });
    inst.unmount();
    assert.deepEqual(classes(), []);
    flick('down');
    assert.deepEqual(classes(), [], 'the torn-down plugin no longer reacts');
  });
});
