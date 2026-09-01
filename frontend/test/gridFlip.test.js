// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

/**
 * flipGrid — the glide a zoom step animates the grid across.
 *
 * The layout change itself is not optional, so every path here has to end with
 * `mutate` having run exactly once: no animation support, reduced motion, an
 * empty grid. What varies is only whether the cards are animated into the
 * result or simply found there.
 *
 * No jsdom in the repo — element stubs, as in gridPager.test.js.
 */

let flipGrid;
let reducedMotion;

/** A card whose rect is whatever `rects` says at the time it is asked. */
function makeSlot(rects) {
  let call = 0;
  return {
    style: { cssText: '' },
    animations: [],
    getBoundingClientRect: () => rects[Math.min(call++, rects.length - 1)],
    animate(keyframes, opts) {
      const anim = {
        keyframes, opts, cancelled: false, listeners: {},
        cancel() { this.cancelled = true; (this.listeners.cancel || []).forEach((f) => f()); },
        finish() { (this.listeners.finish || []).forEach((f) => f()); },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      };
      this.animations.push(anim);
      return anim;
    },
  };
}

const R = (left, top, width, height) => ({ left, top, width, height });
const GONE = R(0, 0, 0, 0);

/** A grid of slots, each given the rects it reports in measurement order. */
const makeGrid = (pairs) => ({
  children: pairs.map(makeSlot),
  parentElement: null,   // no transformed ancestor ⇒ origin is the viewport
});

/** The transform the FLIP starts a card from. */
const fromTransform = (anim) => anim.keyframes[0].transform;

describe('flipGrid', () => {
  before(async () => {
    global.window = {
      matchMedia: (q) => ({ matches: q.includes('reduced-motion') && reducedMotion }),
      getComputedStyle: () => ({ transform: 'none', filter: 'none', perspective: 'none' }),
    };
    ({ flipGrid } = await import('../src/utils/gridFlip.js'));
  });

  beforeEach(() => { reducedMotion = false; });

  test('animates a card that moved, from where it was to where it landed', () => {
    const grid = makeGrid([[R(0, 0, 100, 100), R(200, 50, 50, 50)]]);
    flipGrid(grid, () => {});
    const [anim] = grid.children[0].animations;
    // Back by the offset, and at the size it used to be: 100/50 in both axes.
    assert.equal(fromTransform(anim), 'translate(-200px, -50px) scale(2, 2)');
    assert.equal(anim.keyframes[1].transform, 'none');
    assert.equal(anim.keyframes[0].transformOrigin, '0 0', 'scale must grow from the corner');
  });

  test('leaves a card that did not move alone', () => {
    const grid = makeGrid([[R(10, 10, 100, 100), R(10, 10, 100, 100)]]);
    flipGrid(grid, () => {});
    assert.equal(grid.children[0].animations.length, 0);
  });

  test('a card that left the flow is pinned where it was and faded out', () => {
    const grid = makeGrid([[R(30, 40, 100, 100), GONE]]);
    flipGrid(grid, () => {});
    const slot = grid.children[0];
    const [anim] = slot.animations;
    assert.deepEqual(anim.keyframes, [{ opacity: 1 }, { opacity: 0 }]);
    assert.equal(slot.style.position, 'fixed');
    assert.equal(slot.style.left, '30px');
    assert.equal(slot.style.top, '40px');
    assert.equal(slot.style.display, 'block', 'overrides the class that removed it');
    assert.ok(anim.opts.duration < 260, 'goes before the survivors have finished arriving');

    anim.finish();
    assert.equal(slot.style.cssText, '', 'the pin is dropped once the fade is done');
  });

  test('a card that was already gone is not animated back in', () => {
    const grid = makeGrid([[GONE, R(0, 0, 100, 100)]]);
    flipGrid(grid, () => {});
    assert.equal(grid.children[0].animations.length, 0);
  });

  test('a step landing mid-glide cancels it before measuring the destination', () => {
    // Four rects: what each of the two flips measures, before and after.
    const grid = makeGrid([[
      R(0, 0, 100, 100), R(100, 0, 100, 100),
      R(100, 0, 100, 100), R(200, 0, 100, 100),
    ]]);
    flipGrid(grid, () => {});
    const first = grid.children[0].animations[0];

    flipGrid(grid, () => {});
    assert.equal(first.cancelled, true, 'a running transform would corrupt the new rect');
    assert.equal(grid.children[0].animations.length, 2);
  });

  test('the layout change happens exactly once, animation or not', () => {
    for (const setup of [
      () => { reducedMotion = true; return makeGrid([[R(0, 0, 10, 10), R(50, 0, 10, 10)]]); },
      () => makeGrid([]),                                        // nothing to animate
      () => ({ children: [{ getBoundingClientRect: () => R(0, 0, 1, 1) }] }), // no WAAPI
      () => makeGrid([[R(0, 0, 10, 10), R(50, 0, 10, 10)]]),     // the normal path
    ]) {
      let calls = 0;
      flipGrid(setup(), () => { calls++; });
      assert.equal(calls, 1);
    }
    flipGrid(null, () => {}); // no grid at all — must not throw
  });

  test('reduced motion applies the change without animating it', () => {
    reducedMotion = true;
    const grid = makeGrid([[R(0, 0, 100, 100), R(200, 0, 50, 50)]]);
    flipGrid(grid, () => {});
    assert.equal(grid.children[0].animations.length, 0);
  });
});
