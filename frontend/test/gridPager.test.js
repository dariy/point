// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Pagination } from '../src/components/shared/Pagination.js';

// ── Minimal DOM so gridPager.js runs under node ───────────────────────────────
// The pager only ever touches inline styles, classList, listeners and a couple
// of layout reads, so hand-rolled element stubs are enough (the repo has no
// jsdom — see TagsManagerPage.test.js for the same approach).

function makeEl(extra = {}) {
  const el = {
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, has(c) { return this._set.has(c); } },
    children: [],
    listeners: {},
    offsetWidth: 800,
    offsetHeight: 600,
    offsetTop: 0,
    innerHTML: '',
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

/**
 * Put a phone-width paginator on the page: six controls to a line, each line
 * 30px tall, laid out from the real Pagination markup. `← 1 2 … 40 →` fits on
 * one line; page 2's extra number wraps it onto two — the 30px the incoming
 * grid does not get, and the whole reason the pager measures ahead.
 *
 * The mount reports the height of whichever paginator is currently visible in
 * it, so the pager's swap-measure-restore reads the destination markup the way
 * a real layout would.
 *
 * @returns {() => void} restores the document stubs.
 */
function stubWrappingPaginator(page, pages, total = pages * 10) {
  const restore = { qs: document.querySelector, qsa: document.querySelectorAll, ce: document.createElement };
  const rows = (markup) =>
    Math.ceil((markup.match(/class="page-btn|page-ellipsis/g) || []).length / 6) || 1;
  const heightOf = (markup) => 30 * rows(markup);

  const paginator = (markup) => makeEl({
    _markup: markup,
    getBoundingClientRect() {
      return { width: 300, height: this.style.display === 'none' ? 0 : heightOf(this._markup) };
    },
    querySelector: (sel) => (sel === '.page-info' ? makeEl() : null),
  });
  const live = paginator(new Pagination(null, { page, pages, total }).render());
  // The band the grid is fitted around: whatever paginator is laid out in it.
  const mount = makeEl({
    getBoundingClientRect() {
      return { width: 300, height: this.children.reduce((h, c) => h + c.getBoundingClientRect().height, 0) };
    },
  });
  mount.appendChild(live);

  document.querySelector = (sel) => (sel === '#pagination-mount' ? mount : null);
  document.querySelectorAll = (sel) => (sel.includes('.pagination') ? [live] : []);
  document.createElement = () => {
    const el = makeEl();
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._html || ''; },
      set(v) {
        this._html = v;
        this.firstElementChild = v.includes('class="pagination"') ? paginator(v) : null;
      },
    });
    return el;
  };
  return () => {
    document.querySelector = restore.qs;
    document.querySelectorAll = restore.qsa;
    document.createElement = restore.ce;
  };
}

let GridPager;
let body, gridMount, container, siteMain, keyHandlers;
let dispatched = [];

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
    scrollY: 0,
    getComputedStyle: () => ({ columnGap: '16px' }),
    addEventListener(type, fn) { (keyHandlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) { keyHandlers[type] = (keyHandlers[type] || []).filter((f) => f !== fn); },
    dispatchEvent(e) { dispatched.push(e); },
  };
  // Records what the media warm-up asks the browser for. The pager hands an
  // <img> a srcset and lets it pick, exactly as a card does, so the assertions
  // are about the candidate set rather than about one URL.
  globalThis.warmed = [];
  globalThis.Image = class {
    set src(v) { this._src = v; warmed.push(this); }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
  };
  globalThis.document = {
    body: null, // set per test
    documentElement: { scrollHeight: 600 }, // fits the viewport, like a DF grid
    createElement: () => makeEl(),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  ({ GridPager } = await import('../src/core/gridPager.js'));
});

/** A pager wired to stub elements, recording every navigation it requests. */
function setup({ page = 2, pages = 4, posts = [] } = {}) {
  keyHandlers = {};
  dispatched = [];
  window.scrollY = 0;
  document.documentElement.scrollHeight = 600;
  body = makeEl();
  document.body = body;
  gridMount = makeEl({ offsetTop: 40 });
  gridMount.querySelector = () => makeEl(); // stands in for .posts-grid
  container = makeEl();
  container.appendChild(gridMount);
  siteMain = makeEl();

  const nav = [];
  const fetched = [];
  const pager = new GridPager({
    gridMount: () => gridMount,
    gestureRoot: () => siteMain,
    fetchPosts: async (p) => { fetched.push(p); return posts; },
    gotoPage: (p) => nav.push(p),
    onZoomCommit: () => {},
    isAlive: () => true,
    emptyHtml: '<p class="empty-state">nothing</p>',
  });
  return { pager, nav, fetched, pagination: { page, pages, total: pages * 10 } };
}

/** Let the preload's awaits settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** …and the idle-scheduled media warm-up behind it. */
const flushWarm = async () => { await flush(); await flush(); };

describe('GridPager', () => {
  beforeEach(() => { keyHandlers = {}; });

  test('preloads both neighbours and parks them off-screen', async () => {
    const { pager, fetched } = setup({ page: 2, pages: 4 });
    pager.arm({ page: 2, pages: 4 });
    await flush();

    assert.deepEqual(fetched.sort(), [1, 3]);
    assert.equal(container.children.length, 3); // grid + two ghosts
    const ghosts = container.children.slice(1);
    // One stride = grid width + column gap, mirrored per edge.
    assert.deepEqual(ghosts.map((g) => g.style.transform).sort(),
      ['translateX(-816px)', 'translateX(816px)']);
    for (const g of ghosts) assert.equal(g.style.opacity, '0');
  });

  // A ghost is built from the neighbouring page's real cards, so it wants the
  // same bytes they do. Warming the bare `media_url` — which is what this did —
  // downloaded the full original of every neighbouring post, several megabytes
  // each, and none of it was the file the card then went on to request.
  test('warms the rung the cards paint, never the original', async () => {
    warmed.length = 0;
    const posts = [
      { id: 1, slug: 'a', title: 'A', tags: [], media_url: '/2026/03/photo.jpg' },
      { id: 2, slug: 'b', title: 'B', tags: [], media_url: '/2026/03/clip.mp4' },
    ];
    const { pager } = setup({ page: 2, pages: 4, posts });
    pager.arm({ page: 2, pages: 4 });
    await flushWarm();

    assert.ok(warmed.length, 'the neighbour pages should have been warmed');
    for (const im of warmed) {
      assert.match(im.src, /\?s=\d+/, 'a warm-up must name a rung');
      assert.ok(im.srcset.includes(' 128w'), 'the browser picks from the ladder');
      assert.ok(im.sizes, 'and it cannot pick without knowing how wide the card is');
    }
    // Video cards paint their poster frame through the same ladder, so they are
    // warmed like any other image — skipping them left a hitch on exactly the
    // cards that cost the most to paint.
    assert.ok(warmed.some((im) => im.src.startsWith('/2026/03/clip.mp4?')));
  });

  test('a ghost drops a poster that never loads, rather than showing it broken', async () => {
    const posts = [{ id: 1, slug: 'a', title: 'A', tags: [], media_url: '/2026/03/clip.mp4' }];
    const { pager } = setup({ page: 2, pages: 4, posts });
    pager.arm({ page: 2, pages: 4 });
    await flush();

    // Ghost cards are static markup with no component behind them, so the
    // listener has to be a delegated one on the ghost itself — and in the
    // capture phase, since `error` does not bubble.
    for (const ghost of container.children.slice(1)) {
      assert.ok(ghost.listeners.error?.length, 'no ghost should paint a broken-image glyph');
    }
  });

  test('pins each ghost to the live grid box, not the container', async () => {
    const { pager } = setup({ page: 2, pages: 4 });
    pager.arm({ page: 2, pages: 4 });
    await flush();

    // Search renders tag chips above the grid, so a ghost anchored at the
    // container's top would overlay them.
    for (const g of container.children.slice(1)) {
      assert.equal(g.style.top, '40px');
      assert.equal(g.style.height, '600px');
    }
  });

  // The paginator is chrome the grid is fitted around, and its height depends on
  // which page is current: the run of numbers widens as you move into the deck,
  // and on a phone the extra button wraps the strip onto a second line. A ghost
  // pinned to the live grid's height therefore laid the incoming cards out one
  // wrap too tall, and the hand-off to the real grid resized them — the jump.
  test('sizes a ghost to the paginator the destination page will have', async () => {
    const { pager } = setup({ page: 1, pages: 40 });
    const done = stubWrappingPaginator(1, 40);
    try {
      pager.arm({ page: 1, pages: 40, total: 400 });
      await flush();

      const ghost = container.children[1];
      assert.equal(ghost.dataset.edge, 'next');
      assert.equal(ghost.style.height, '570px',
        'the ghost must give up the line the destination paginator takes');
    } finally {
      done();
    }
  });

  // A step the other way is the same measurement with the sign flipped: page 1's
  // paginator is the shorter one, so the ghost coming back gets a taller box.
  test('gives a ghost the room back when the destination paginator is shorter', async () => {
    const { pager } = setup({ page: 2, pages: 40 });
    const done = stubWrappingPaginator(2, 40);
    try {
      pager.arm({ page: 2, pages: 40, total: 400 });
      await flush();

      const prev = container.children.slice(1).find((g) => g.dataset.edge === 'prev');
      assert.equal(prev.style.height, '630px');
    } finally {
      done();
    }
  });

  // A ghost is cut moments after the grid mounts, while the footer — an async
  // plugin slot — is still on its way, so the grid it was measured against is
  // taller than the one it will slide into. A refit re-arms the pager and
  // rebuilds them, but a settling pass that keeps the same per_page does not, so
  // the stale box has to be corrected on the way into the drag.
  test('re-measures the grid box at touch-down, not just at preload', async () => {
    const { pager } = setup({ page: 2, pages: 4 });
    pager.arm({ page: 2, pages: 4 });
    await flush();
    for (const g of container.children.slice(1)) assert.equal(g.style.height, '600px');

    gridMount.offsetHeight = 544; // the footer landed; the grid gave up its band
    // A real touch, since the gesture recogniser listens on the same element.
    fire(siteMain, 'touchstart', {
      touches: [{ clientX: 200, clientY: 300 }],
      target: { closest: () => null },
    });

    for (const g of container.children.slice(1)) {
      assert.equal(g.style.height, '544px',
        'the incoming page must be cut to the box it is actually sliding into');
    }
  });

  test('does not preload past either end', async () => {
    const first = setup({ page: 1, pages: 3 });
    first.pager.arm({ page: 1, pages: 3 });
    await flush();
    assert.deepEqual(first.fetched, [2]);

    const last = setup({ page: 3, pages: 3 });
    last.pager.arm({ page: 3, pages: 3 });
    await flush();
    assert.deepEqual(last.fetched, [2]);
  });

  // The owner's home feed extends left of page 1 into the scheduled queue, so
  // "the first page" is whatever min_page says — 0, -1, … — not a hard 1.
  test('min_page opens the feed to the left of page 1', async () => {
    const { pager, fetched, nav } = setup({ page: 1, pages: 3 });
    pager.arm({ page: 1, pages: 3, min_page: -1 });
    await flush();
    assert.deepEqual(fetched.sort((a, b) => a - b), [0, 2],
      'page 1 must preload the queue page beside it, not just page 2');

    keyHandlers.keydown.forEach((fn) => fn({ key: 'ArrowLeft', preventDefault() {} }));
    assert.deepEqual(nav, [0], 'left from page 1 should land on the queue');
  });

  test('min_page still stops the feed at its real left edge', async () => {
    const { pager, fetched, nav } = setup({ page: -1, pages: 3 });
    pager.arm({ page: -1, pages: 3, min_page: -1 });
    await flush();
    assert.deepEqual(fetched, [0], 'nothing exists past the end of the queue');

    keyHandlers.keydown.forEach((fn) => fn({ key: 'ArrowLeft', preventDefault() {} }));
    assert.deepEqual(nav, [], 'left from the last queue page goes nowhere');
  });

  test('a single-page list arms gestures but preloads nothing', async () => {
    const { pager, fetched } = setup({ page: 1, pages: 1 });
    pager.arm({ page: 1, pages: 1 });
    await flush();
    assert.deepEqual(fetched, []);
    assert.ok(siteMain.listeners.touchstart?.length, 'still bound, so edge drags rubber-band');
  });

  test('arrow keys page in both directions, and stop at the edges', async () => {
    const { pager, nav } = setup({ page: 2, pages: 3 });
    pager.arm({ page: 2, pages: 3 });
    const key = (k) => keyHandlers.keydown.forEach((fn) => fn({ key: k, preventDefault() {} }));

    key('ArrowRight');
    key('ArrowLeft');
    key('l');
    assert.deepEqual(nav, [3, 1, 3]);

    const last = setup({ page: 3, pages: 3 });
    last.pager.arm({ page: 3, pages: 3 });
    keyHandlers.keydown.forEach((fn) => fn({ key: 'ArrowRight', preventDefault() {} }));
    assert.deepEqual(last.nav, []);
  });

  test('keys are ignored while the visitor is typing', () => {
    const { pager, nav } = setup({ page: 2, pages: 3 });
    pager.arm({ page: 2, pages: 3 });
    keyHandlers.keydown.forEach((fn) => fn({
      key: 'ArrowRight', target: { tagName: 'INPUT' }, preventDefault() {},
    }));
    assert.deepEqual(nav, [], 'the header search box owns its own arrow keys');
  });

  test('hover chevrons are disabled at the edge they cannot reach', () => {
    const { pager } = setup({ page: 1, pages: 2 });
    pager.arm({ page: 1, pages: 2 });
    const arrows = body.children.filter((c) => c.className?.startsWith('page-nav-arrow'));
    assert.equal(arrows.length, 2);
    assert.equal(arrows[0].disabled, true);   // prev, on page 1
    assert.equal(arrows[1].disabled, false);  // next
  });

  test('disarm() removes the arrows and the listeners it added', () => {
    const { pager } = setup({ page: 2, pages: 3 });
    pager.arm({ page: 2, pages: 3 });
    assert.equal(body.children.length, 2);
    assert.ok(keyHandlers.keydown.length);

    pager.disarm();
    assert.equal(body.children.length, 0);
    assert.equal(keyHandlers.keydown.length, 0);
    assert.equal(siteMain.listeners.touchstart.length, 0);
    assert.equal(body.classList.has('grid-zoomable'), false);
  });

  test('arming twice does not double up arrows or handlers', () => {
    const { pager } = setup({ page: 2, pages: 3 });
    pager.arm({ page: 2, pages: 3 });
    const once = siteMain.listeners.touchstart.length;
    pager.arm({ page: 2, pages: 3 });
    assert.equal(body.children.length, 2);
    assert.equal(siteMain.listeners.touchstart.length, once);
  });

  test('zoom marks the page zoom-capable until the pager is destroyed', () => {
    const { pager } = setup();
    pager.arm({ page: 1, pages: 2 });
    assert.equal(body.classList.has('grid-zoomable'), true);
    pager.destroy();
    assert.equal(body.classList.has('grid-zoomable'), false);
  });

  test('resetGridStyles clears what a swipe left behind', () => {
    const { pager } = setup();
    gridMount.style.transform = 'translateX(-100px)';
    gridMount.style.opacity = '0.3';
    assert.equal(pager.isMidSwipe(), true);
    pager.resetGridStyles();
    assert.equal(pager.isMidSwipe(), false);
    assert.equal(gridMount.style.opacity, '');
  });

  test('takeSeamless is one-shot', () => {
    const { pager } = setup();
    assert.equal(pager.takeSeamless(), undefined);
    pager._seamlessSwipe = true;
    assert.equal(pager.takeSeamless(), true);
    assert.equal(pager.takeSeamless(), false);
  });

  test('a committed swipe navigates once and holds its ghost across the swap', async () => {
    const { pager, nav } = setup({ page: 2, pages: 4 });
    pager.arm({ page: 2, pages: 4 });
    await flush();
    const ghostCount = container.children.length;
    const swipe = pager._gesture._opts;

    swipe.onSwipeCommit('left');
    // The ghost stays on screen (centred) until the real grid mounts under it.
    assert.equal(container.children.length, ghostCount);
    assert.equal(pager._committedGhost.style.transform, 'translateX(0)');

    // A second commit during the ~280ms hand-off is refused rather than
    // orphaning the first ghost as a permanent overlay.
    const held = pager._committedGhost;
    swipe.onSwipeCommit('left');
    assert.equal(pager._committedGhost, held);

    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.deepEqual(nav, [3]);
    assert.equal(pager.takeSeamless(), true);

    pager.finishHandoff();
    assert.equal(held.removed, true);
  });

  test('a swipe past the last page rubber-bands home instead of navigating', async () => {
    const { pager, nav } = setup({ page: 3, pages: 3 });
    pager.arm({ page: 3, pages: 3 });
    await flush();

    const swipe = pager._gesture._opts;
    swipe.onSwipeMove(-120, 5);
    // Damped, so the grid trails the finger, and never fades to nothing.
    const tx = Number(gridMount.style.transform.match(/-?[\d.]+/)[0]);
    assert.ok(tx > -120 && tx < 0, `expected damped travel, got ${tx}`);
    assert.ok(Number(gridMount.style.opacity) >= 0.85);

    swipe.onSwipeCommit('left');
    assert.deepEqual(nav, []);
    assert.equal(gridMount.style.transform, '');
  });

  test('a vertical drag scrolls the page rather than paging it', async () => {
    const { pager, nav } = setup({ page: 2, pages: 4 });
    pager.arm({ page: 2, pages: 4 });
    await flush();

    const swipe = pager._gesture._opts;
    swipe.onSwipeMove(10, 90);
    assert.equal(gridMount.style.transform, undefined);
    swipe.onSwipeCommit('up');
    assert.deepEqual(nav, []);
  });

  test('a vertical flick is forwarded to whatever mode is layered on the page', async () => {
    const { pager } = setup({ page: 2, pages: 4 });
    pager.arm({ page: 2, pages: 4 });
    await flush();

    const swipe = pager._gesture._opts;
    swipe.onSwipeCommit('up');
    swipe.onSwipeCommit('down');
    assert.deepEqual(dispatched.map((e) => e.detail.dir), ['up', 'down']);
    assert.equal(dispatched[0].type, 'point:grid-swipe-vertical');
  });

  test('mid-document the same flick is only a scroll', async () => {
    const { pager } = setup({ page: 2, pages: 4 });
    pager.arm({ page: 2, pages: 4 });
    await flush();

    // A page twice the viewport, scrolled to the middle: neither edge is met.
    document.documentElement.scrollHeight = 1200;
    window.scrollY = 300;
    const swipe = pager._gesture._opts;
    swipe.onSwipeCommit('up');
    swipe.onSwipeCommit('down');
    assert.deepEqual(dispatched, []);

    window.scrollY = 0;          // at the top: only a flick down carries
    swipe.onSwipeCommit('up');
    swipe.onSwipeCommit('down');
    assert.deepEqual(dispatched.map((e) => e.detail.dir), ['down']);

    window.scrollY = 600;        // at the bottom: only a flick up
    swipe.onSwipeCommit('up');
    swipe.onSwipeCommit('down');
    assert.deepEqual(dispatched.map((e) => e.detail.dir), ['down', 'up']);
  });

  test('trackpad flicks page within range only', async () => {
    const { pager, nav } = setup({ page: 1, pages: 2 });
    pager.arm({ page: 1, pages: 2 });
    const wheel = (deltaX) => fire(siteMain, 'wheel', {
      deltaX, deltaY: 0, target: { closest: () => null },
    });

    wheel(120);   // two fingers left ⇒ next page
    assert.deepEqual(nav, [2]);
    pager._trackpad._lastFired = 0; // skip the cooldown
    wheel(-120);  // already on page 1 ⇒ nothing
    assert.deepEqual(nav, [2]);
  });
});
