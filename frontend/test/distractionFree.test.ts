import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { must } from './helpers/dom.ts';
import { mock } from './helpers/mock.ts';
import type * as DistractionFree from '../src/plugins/distraction-free/index.ts';

type Listener = () => void;

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

let mount: typeof DistractionFree.mount;
let body: FakeEl;
let holder: FakeEl;
let swipeHandlers: Record<string, EventListenerOrEventListenerObject[]>;
let prefs: Map<string, string>;

/** The body classes the plugin has set, as a plain array. */
const classes = () => [...body.classList._set];

/** Fire a vertical-swipe event the way GridPager does. */
const flick = (dir: string) => {
  for (const fn of swipeHandlers['point:grid-swipe-vertical'] || []) {
    const e = new CustomEvent('point:grid-swipe-vertical', { detail: { dir } });
    if (typeof fn === 'function') fn(e); else fn.handleEvent(e);
  }
};

/** The few element members the plugin touches. */
interface FakeEl {
  type: string;
  className: string;
  innerHTML: string;
  children: FakeEl[];
  parentElement?: FakeEl;
  classList: {
    _set: Set<string>;
    add(c: string): void;
    remove(...cs: string[]): void;
    contains(c: string): boolean;
    toggle(c: string, on?: boolean): void;
  };
  listeners: Record<string, Listener[]>;
  appendChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string, fn: Listener): void;
  setAttribute(): void;
  querySelectorAll(): FakeEl[];
}

function makeEl(): FakeEl {
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

/** The one boundary cast: a FakeEl stands in for the HTMLElement the plugin expects. */
const asElement = (el: FakeEl) => el as unknown as HTMLElement;

before(async () => {
  prefs = new Map();
  globalThis.localStorage = mock<Storage>({
    getItem: (k) => prefs.get(k) ?? null,
    setItem: (k, v) => { prefs.set(k, String(v)); },
    removeItem: (k) => { prefs.delete(k); },
  });
  globalThis.window = mock<typeof window>({
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) { (swipeHandlers[type] ||= []).push(fn); },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) { swipeHandlers[type] = (swipeHandlers[type] || []).filter((f) => f !== fn); },
  });
  globalThis.document = mock<Document>({
    createElement: () => asElement(makeEl()),
    // the orphaned-toggle sweep finds nothing here
    querySelectorAll: () => mock<NodeListOf<Element>>({ length: 0, forEach() {}, [Symbol.iterator]: [][Symbol.iterator] }),
  });
  ({ mount } = await import('../src/plugins/distraction-free/index.ts'));
});

/** Mount the plugin into a fresh document, optionally already in the mode. */
function setup({ on = false } = {}) {
  swipeHandlers = {};
  prefs.clear();
  if (on) prefs.set('distraction-free', '1');
  body = makeEl();
  document.body = asElement(body);
  holder = makeEl();
  return mount(asElement(holder));
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
    must(inst, 'plugin instance').unmount();
    assert.deepEqual(classes(), []);
    flick('down');
    assert.deepEqual(classes(), [], 'the torn-down plugin no longer reacts');
  });
});
