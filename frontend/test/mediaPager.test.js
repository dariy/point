import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

// ── Minimal DOM so mediaPager.js runs under node ──────────────────────────────
// Same approach as gridPager.test.js: the pager only touches inline styles,
// classList, listeners and a couple of layout reads, so hand-rolled element
// stubs are enough (the repo has no jsdom).

function makeEl(extra = {}) {
  const el = {
    style: {
      _p: new Map(),
      setProperty(k, v) { this._p.set(k, v); },
      removeProperty(k) { this._p.delete(k); },
      getPropertyValue(k) { return this._p.get(k) ?? ''; },
    },
    dataset: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      has(c) { return this._set.has(c); },
    },
    children: [],
    listeners: {},
    clientWidth: 800,
    clientHeight: 600,
    offsetWidth: 800,
    offsetHeight: 600,
    innerHTML: '',
    disabled: false,
    getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 200, width: 800, height: 600 }),
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    remove() { const p = this.parentElement; if (p) p.children = p.children.filter((c) => c !== this); this.removed = true; },
    querySelector: () => null,
    setAttribute() {},
    ...extra,
  };
  return el;
}

/** Dispatch to the handlers registered on a stub element. */
function fire(el, type, event) {
  for (const fn of el.listeners[type] || []) fn(event);
}

let MediaPager, getMediaZoom, setMediaZoom;
let body, root, area, grid, keyHandlers;

before(async () => {
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.window = {
    innerWidth: 800,
    innerHeight: 600,
    // 4 auto-fill columns and a 16px gap, i.e. an unzoomed 800px grid.
    getComputedStyle: () => ({ columnGap: '16px', gridTemplateColumns: '200px 200px 200px 200px' }),
    scrollTo() {},
    addEventListener(type, fn) { (keyHandlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) { keyHandlers[type] = (keyHandlers[type] || []).filter((f) => f !== fn); },
  };
  globalThis.document = {
    body: null, // set per test
    createElement: () => makeEl(),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  ({ MediaPager, getMediaZoom, setMediaZoom } = await import('../src/core/mediaPager.js'));
});

/** A pager wired to stub elements, recording every load and fetch it requests. */
function setup() {
  keyHandlers = {};
  localStorage._m.clear();
  body = makeEl();
  document.body = body;
  root = makeEl();
  area = makeEl();
  grid = makeEl();

  const nav = [];
  const fetched = [];
  const zoomCommits = [];
  const pager = new MediaPager({
    root: () => root,
    area: () => area,
    grid: () => grid,
    fetchPage: async (p) => { fetched.push(p); return `<div class="media-grid">page ${p}</div>`; },
    gotoPage: (p) => nav.push(p),
    onZoomCommit: () => zoomCommits.push(true),
    isAlive: () => true,
  });
  return { pager, nav, fetched, zoomCommits };
}

/** Let the preload's awaits settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ghosts = () => body.children.filter((c) => c.className === 'mb-page-ghost');
const arrows = () => body.children.filter((c) => String(c.className).startsWith('page-nav-arrow'));

// Drive drags through the real GestureController bound to the root, so the
// wiring between recogniser and pager is under test too.
const target = { closest: () => null };

/** Press and drag, without releasing — leaves the pager mid-drag. */
function drag(from, to) {
  fire(root, 'touchstart', { touches: [{ clientX: from, clientY: 300 }], target });
  fire(root, 'touchmove', {
    touches: [{ clientX: to, clientY: 300 }], target, cancelable: true, preventDefault() {},
  });
}

/** Lift the finger at `to`. */
function release(to) {
  fire(root, 'touchend', { changedTouches: [{ clientX: to, clientY: 300 }], target });
}

/** A full horizontal swipe: press, drag, release. */
function swipe(from, to) {
  drag(from, to);
  release(to);
}

const key = (k, extra = {}) =>
  (keyHandlers.keydown || []).forEach((fn) => fn({ key: k, preventDefault() {}, ...extra }));

describe('MediaPager', () => {
  beforeEach(() => { keyHandlers = {}; });

  // ── Neighbour preloading ────────────────────────────────────────────────────

  test('preloads both neighbours and parks them one stride off-screen', async () => {
    const { pager, fetched } = setup();
    pager.arm({ page: 2, pages: 4 }, 'k1');
    await flush();

    assert.deepEqual(fetched.sort(), [1, 3]);
    assert.equal(ghosts().length, 2);
    // One stride = grid area width + the grid's column gap, mirrored per edge.
    assert.deepEqual(ghosts().map((g) => g.style.transform).sort(),
      ['translateX(-816px)', 'translateX(816px)']);
    for (const g of ghosts()) assert.equal(g.style.opacity, '0');
  });

  test('pins each ghost to the grid area box, clipped to the viewport', async () => {
    const { pager } = setup();
    pager.arm({ page: 2, pages: 4 }, 'k1');
    await flush();

    // The area runs 100→700 but the window is only 600 tall: a phone's media
    // area is taller than the screen, and a ghost that tall would slide a strip
    // of off-screen markup past the thumb.
    for (const g of ghosts()) {
      assert.equal(g.style.top, '100px');
      assert.equal(g.style.left, '200px');
      assert.equal(g.style.width, '800px');
      assert.equal(g.style.height, '500px');
    }
  });

  test('does not preload past either end', async () => {
    const first = setup();
    first.pager.arm({ page: 1, pages: 3 }, 'k');
    await flush();
    assert.deepEqual(first.fetched, [2]);

    const last = setup();
    last.pager.arm({ page: 3, pages: 3 }, 'k');
    await flush();
    assert.deepEqual(last.fetched, [2]);
  });

  test('a single-page listing arms gestures but preloads nothing', async () => {
    const { pager, fetched } = setup();
    pager.arm({ page: 1, pages: 1 }, 'k');
    await flush();
    assert.deepEqual(fetched, []);
    assert.ok(root.listeners.touchstart?.length, 'still bound, so edge drags rubber-band');
  });

  test('re-arming on the same listing does not refetch the neighbours', async () => {
    const { pager, fetched } = setup();
    pager.arm({ page: 2, pages: 4 }, 'k1');
    await flush();
    // MediaBrowser re-renders once per referring-posts lookup — many arms per load.
    pager.arm({ page: 2, pages: 4 }, 'k1');
    pager.arm({ page: 2, pages: 4 }, 'k1');
    await flush();

    assert.deepEqual(fetched.sort(), [1, 3]);
    assert.equal(ghosts().length, 2, 'the parked ghosts survive a re-arm');
  });

  test('a changed listing key rebuilds the ghosts', async () => {
    const { pager, fetched } = setup();
    pager.arm({ page: 2, pages: 4 }, 'k1');
    await flush();
    pager.arm({ page: 3, pages: 4 }, 'k2');
    await flush();

    assert.deepEqual(fetched, [1, 3, 2, 4]);
    assert.equal(ghosts().length, 2, 'the stale pair was dropped, not stacked');
  });

  // ── Swipe ───────────────────────────────────────────────────────────────────

  test('a committed swipe holds the ghost across the load, then hands off', async () => {
    const { pager, nav } = setup();
    pager.arm({ page: 2, pages: 4 }, 'k1');
    await flush();
    const next = ghosts().find((g) => g.dataset.edge === 'next');

    swipe(400, 200); // 200px left — past the 50px commit threshold

    assert.equal(next.style.transform, 'translateX(0)', 'slides to centre');
    assert.equal(area.style.opacity, '0', 'the outgoing grid slides off');
    assert.deepEqual(nav, [], 'the load waits for the animation');

    await new Promise((r) => setTimeout(r, 320));
    assert.deepEqual(nav, [3]);
    assert.ok(body.children.includes(next), 'still on screen over the reloading grid');

    // The real grid renders underneath and arm() drops the ghost.
    pager.arm({ page: 3, pages: 4 }, 'k2');
    assert.equal(next.removed, true);
  });

  test('a swipe at the last page rubber-bands instead of paging', async () => {
    const { pager, nav } = setup();
    pager.arm({ page: 4, pages: 4 }, 'k1');
    await flush();

    drag(400, 200);
    // Damped, so the grid moves less than the finger did and never blanks out.
    const tx = parseFloat(area.style.transform.match(/-?[\d.]+/)[0]);
    assert.ok(tx > -200 && tx < -10, `damped drag, got ${tx}`);
    assert.ok(Number(area.style.opacity) >= 0.85, 'a blocked drag never fades the grid out');

    release(200);
    assert.deepEqual(nav, []);
    assert.equal(area.style.transform, '', 'settles back to rest');
  });

  test('a vertical drag scrolls rather than paging', async () => {
    const { pager, nav } = setup();
    pager.arm({ page: 2, pages: 4 }, 'k1');
    await flush();

    fire(root, 'touchstart', { touches: [{ clientX: 400, clientY: 400 }], target });
    fire(root, 'touchmove', {
      touches: [{ clientX: 400, clientY: 200 }], target, cancelable: true, preventDefault() {},
    });
    fire(root, 'touchend', { changedTouches: [{ clientX: 400, clientY: 200 }], target });

    assert.deepEqual(nav, []);
    assert.equal(area.style.transform, undefined);
  });

  // ── Keyboard + chevrons ─────────────────────────────────────────────────────

  test('arrow keys page in both directions, and stop at the edges', () => {
    const { pager, nav } = setup();
    pager.arm({ page: 2, pages: 3 }, 'k');
    key('ArrowRight');
    key('ArrowLeft');
    key('l');
    assert.deepEqual(nav, [3, 1, 3]);

    const last = setup();
    last.pager.arm({ page: 3, pages: 3 }, 'k');
    key('ArrowRight');
    assert.deepEqual(last.nav, []);
  });

  test('keys are ignored while the admin is typing', () => {
    const { pager, nav } = setup();
    pager.arm({ page: 2, pages: 3 }, 'k');
    // The EXIF editor and the rename prompt are full of text inputs.
    key('ArrowRight', { target: { tagName: 'INPUT' } });
    key('-', { target: { tagName: 'INPUT' } });
    assert.deepEqual(nav, []);
    assert.equal(getMediaZoom(), 0);
  });

  test('hover chevrons are disabled at the edge they cannot reach', () => {
    const { pager } = setup();
    pager.arm({ page: 1, pages: 2 }, 'k');
    assert.equal(arrows().length, 2);
    assert.equal(arrows()[0].disabled, true);   // prev, on page 1
    assert.equal(arrows()[1].disabled, false);  // next
  });

  test('arming twice does not double up arrows or handlers', () => {
    const { pager } = setup();
    pager.arm({ page: 2, pages: 3 }, 'k');
    const once = root.listeners.touchstart.length;
    pager.arm({ page: 2, pages: 3 }, 'k');
    assert.equal(arrows().length, 2);
    assert.equal(root.listeners.touchstart.length, once);
  });

  test('destroy() removes the arrows, ghosts and listeners it added', async () => {
    const { pager } = setup();
    pager.arm({ page: 2, pages: 3 }, 'k');
    await flush();
    assert.equal(body.children.length, 4); // 2 arrows + 2 ghosts
    assert.ok(keyHandlers.keydown.length);

    pager.destroy();
    assert.equal(body.children.length, 0);
    assert.equal(keyHandlers.keydown.length, 0);
    assert.equal(root.listeners.touchstart.length, 0);
    assert.equal(root.listeners.wheel.length, 0);
  });

  // ── Zoom ────────────────────────────────────────────────────────────────────

  test('the first zoom step continues from the columns on screen', () => {
    const { pager } = setup();
    pager.arm({ page: 1, pages: 1 }, 'k');
    // The live grid resolves to 4 auto-fill columns; "+" makes cards bigger.
    key('+');
    assert.equal(getMediaZoom(), 3);
    assert.equal(root.classList.has('is-zoomed'), true);
    assert.equal(root.style.getPropertyValue('--media-grid-cols'), '3');

    key('-');
    key('-');
    assert.equal(getMediaZoom(), 5);
  });

  test('zoom clamps to what the grid width can hold', () => {
    const { pager } = setup();
    pager.arm({ page: 1, pages: 1 }, 'k');
    for (let i = 0; i < 20; i++) key('-');
    // 800px of grid at a 110px floor per thumbnail.
    assert.equal(getMediaZoom(), 7);

    for (let i = 0; i < 20; i++) key('+');
    assert.equal(getMediaZoom(), 1);
  });

  test('a zoom step refits per_page once, after the gesture settles', async () => {
    const { pager, zoomCommits } = setup();
    pager.arm({ page: 1, pages: 1 }, 'k');
    key('-');
    key('-');
    assert.deepEqual(zoomCommits, [], 'a refit mid-gesture would tear down the gesture');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(zoomCommits.length, 1);
  });

  test('a stored zoom is stamped on the ghosts too, which inherit nothing', async () => {
    const { pager } = setup();
    setMediaZoom(3);
    pager.arm({ page: 2, pages: 4 }, 'k');
    await flush();

    for (const g of ghosts()) {
      assert.equal(g.classList.has('is-zoomed'), true);
      assert.equal(g.style.getPropertyValue('--media-grid-cols'), '3');
    }
  });
});
