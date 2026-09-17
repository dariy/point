/**
 * pointerReorder.js — the gesture util, checked across two containers.
 *
 * `attachPointerReorder` has always been able to cross containers — `onDrop`
 * reports `from` and `to` separately for exactly that — but both of its call
 * sites pass disjoint, same-axis containers, so the per-attachment assumptions
 * (one axis, one indicator class, a descendant query for candidates) were never
 * exercised. This file is the cross-container case: a vertical list of cards
 * with a horizontal rail nested inside one of them, which is what dragging a
 * photo into a carousel looks like in the visual editor.
 *
 * linkedom has no layout engine, so every rect here is a stub. Two consequences
 * shape the geometry below:
 *   - `requestAnimationFrame` runs its callback synchronously (helpers/dom.js),
 *     so an auto-scroll tick that finds a nonzero velocity recurses until the
 *     stack gives out. Every pointer position is kept well inside the 64px edge
 *     band, and no rail is given a `scrollWidth`, so the velocity stays 0.
 *   - `window.scrollBy` does not exist, so the page-scroll branch reaching a
 *     nonzero velocity would be a TypeError rather than a scroll.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM, fire } from './helpers/dom.js';
import { attachPointerReorder } from '../src/utils/pointerReorder.js';

/**
 * The editor's shape: two cards in a vertical list, the second one holding a
 * horizontal rail of two slides. The rail sits in the card's lower half, so a
 * pointer can be past the card's midpoint and still short of the slides' —
 * the one position where a descendant query for candidates and a direct-child
 * one disagree.
 *
 *   list   0,100 400x320     card-a 0,100 400x100   (mid y 150)
 *   strip 20,310 360x80      card-b 0,200 400x200   (mid y 300)
 *   slide-1 20,310 180x80 (mid x 110)   slide-2 200,310 180x80 (mid x 290)
 */
const LAYOUT = {
  list: { left: 0, top: 100, width: 400, height: 320 },
  'card-a': { left: 0, top: 100, width: 400, height: 100 },
  'card-b': { left: 0, top: 200, width: 400, height: 200 },
  strip: { left: 20, top: 310, width: 360, height: 80 },
  'slide-1': { left: 20, top: 310, width: 180, height: 80 },
  'slide-2': { left: 200, top: 310, width: 180, height: 80 },
};

const MARKUP = `<!doctype html><html><body>
  <div id="list">
    <div class="item" id="card-a"><button class="handle"></button></div>
    <div class="item" id="card-b">
      <button class="handle"></button>
      <div id="strip">
        <div class="item" id="slide-1"><button class="handle"></button></div>
        <div class="item" id="slide-2"><button class="handle"></button></div>
      </div>
    </div>
  </div>
</body></html>`;

describe('attachPointerReorder across containers', () => {
  let dom;
  let detach;
  let drops;
  let list;
  let strip;

  /** `el`, with the rect a browser would have measured. */
  const stubRect = (el, { left, top, width, height }) => {
    el.getBoundingClientRect = () => ({
      left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    });
    return el;
  };

  const $ = (id) => dom.document.getElementById(id);
  const handleOf = (id) => $(id).querySelector('.handle');
  const indicator = () => dom.document.querySelector('.reorder-indicator');

  const down = (id, x, y) =>
    fire(handleOf(id), 'pointerdown', { clientX: x, clientY: y, pointerId: 1, button: 0 });
  const move = (x, y) =>
    fire(dom.document.body, 'pointermove', { clientX: x, clientY: y, pointerId: 1 });
  const up = () => fire(dom.document.body, 'pointerup', { pointerId: 1 });

  /**
   * Attach over both containers, rail first — `containerAt` is first-match-wins
   * and the card's rect contains the rail's, so the reverse order would let the
   * list swallow every drop over the rail.
   */
  const attach = (axis) => {
    detach = attachPointerReorder({
      handleSelector: '.handle',
      itemSelector: '.item',
      containers: () => [strip, list],
      axis,
      onDrop: (drop) => drops.push(drop),
    });
  };

  beforeEach(() => {
    dom = setupDOM(MARKUP);
    // A viewport, so the page-scroll branch measures against a real number
    // rather than NaN. Every y below lands between the two 64px edge bands.
    dom.window.innerHeight = 800;
    for (const [id, rect] of Object.entries(LAYOUT)) stubRect($(id), rect);
    list = $('list');
    strip = $('strip');
    drops = [];
  });

  afterEach(() => {
    detach?.();
    dom.cleanup();
  });

  test('a placement inside the vertical list gets the plain line', () => {
    attach((c) => (c === strip ? 'x' : 'y'));
    down('card-a', 200, 120);
    move(200, 140);

    assert.strictEqual(indicator().parentElement, list);
    assert.strictEqual(indicator().className, 'reorder-indicator');
    assert.strictEqual(indicator().nextElementSibling, $('card-b'));
  });

  test('crossing into the nested rail re-aims the line and re-classes it', () => {
    attach((c) => (c === strip ? 'x' : 'y'));
    down('card-a', 200, 120);
    move(200, 140);
    move(100, 340);

    assert.strictEqual(indicator().parentElement, strip);
    assert.ok(indicator().className.includes('reorder-indicator--x'));
    assert.strictEqual(indicator().nextElementSibling, $('slide-1'));

    up();
    assert.strictEqual(drops.length, 1);
    assert.strictEqual(drops[0].item, $('card-a'));
    assert.strictEqual(drops[0].from, list);
    assert.strictEqual(drops[0].to, strip);
    assert.strictEqual(drops[0].afterEl, null);
  });

  test('coming back out of the rail drops the rail class again', () => {
    attach((c) => (c === strip ? 'x' : 'y'));
    down('card-a', 200, 120);
    move(100, 340);
    assert.ok(indicator().className.includes('reorder-indicator--x'));

    move(200, 140);
    assert.strictEqual(indicator().parentElement, list);
    assert.strictEqual(indicator().className, 'reorder-indicator');
  });

  test('an item nested inside a card is not a candidate for the outer list', () => {
    attach((c) => (c === strip ? 'x' : 'y'));
    down('card-a', 200, 120);
    // Past card-b's midpoint (y 300) but short of the slides' (y 350), and to
    // the right of the rail (x 380) so the list is the container. A descendant
    // query would offer slide-1 here — and `list.insertBefore(line, slide-1)`
    // is a NotFoundError, since slide-1 is not the list's child.
    move(390, 320);

    assert.strictEqual(indicator().parentElement, list);
    assert.strictEqual(indicator().nextElementSibling, null);

    up();
    assert.strictEqual(drops[0].to, list);
    assert.strictEqual(drops[0].afterEl, $('card-b'));
  });

  test('a gesture that starts in the rail belongs to the rail, not the card', () => {
    attach((c) => (c === strip ? 'x' : 'y'));
    down('slide-2', 290, 340);
    move(100, 340);

    assert.strictEqual(indicator().parentElement, strip);
    assert.strictEqual(indicator().nextElementSibling, $('slide-1'));

    up();
    assert.strictEqual(drops[0].item, $('slide-2'));
    assert.strictEqual(drops[0].from, strip);
    assert.strictEqual(drops[0].to, strip);
    assert.strictEqual(drops[0].afterEl, null);
  });
});

describe('attachPointerReorder with a string axis', () => {
  let dom;
  let detach;
  let drops;

  const $ = (id) => dom.document.getElementById(id);
  const indicator = () => dom.document.querySelector('.reorder-indicator');

  beforeEach(() => {
    dom = setupDOM(MARKUP);
    dom.window.innerHeight = 800;
    for (const [id, rect] of Object.entries(LAYOUT)) {
      const { left, top, width, height } = rect;
      $(id).getBoundingClientRect = () => ({
        left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
      });
    }
    drops = [];
  });

  afterEach(() => {
    detach?.();
    dom.cleanup();
  });

  /** What `PostEditPage._setupArrange` passes: one axis for every container. */
  test('"y" is the default and lays the line out down the list', () => {
    detach = attachPointerReorder({
      handleSelector: '.handle',
      itemSelector: '.item',
      containers: () => [$('list')],
      onDrop: (drop) => drops.push(drop),
    });
    fire($('card-a').querySelector('.handle'), 'pointerdown',
      { clientX: 200, clientY: 120, pointerId: 1, button: 0 });
    fire(dom.document.body, 'pointermove', { clientX: 200, clientY: 140, pointerId: 1 });

    assert.strictEqual(indicator().className, 'reorder-indicator');
    assert.strictEqual(indicator().nextElementSibling, $('card-b'));
  });

  /** What the carousel studio's rail passes. */
  test('"x" applies to every container the attachment owns', () => {
    detach = attachPointerReorder({
      handleSelector: '.handle',
      itemSelector: '.item',
      containers: () => [$('strip')],
      axis: 'x',
      onDrop: (drop) => drops.push(drop),
    });
    fire($('slide-2').querySelector('.handle'), 'pointerdown',
      { clientX: 290, clientY: 340, pointerId: 1, button: 0 });
    fire(dom.document.body, 'pointermove', { clientX: 100, clientY: 340, pointerId: 1 });

    assert.strictEqual(indicator().className, 'reorder-indicator reorder-indicator--x');
    assert.strictEqual(indicator().nextElementSibling, $('slide-1'));
  });
});
