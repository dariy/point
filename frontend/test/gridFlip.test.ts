import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { must } from './helpers/dom.ts';
import { mock } from './helpers/mock.ts';

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

let flipGrid: typeof import('../src/utils/gridFlip.ts').flipGrid;
let reducedMotion: boolean;

type Rect = { left: number; top: number; width: number; height: number };

/** What a fake animate() returned: its arguments, and whether it was cancelled. */
interface FakeAnimation {
  keyframes: Keyframe[];
  opts: KeyframeAnimationOptions;
  cancelled: boolean;
  finish(): void;
}

/** A card element, and the record of what was done to it. */
interface Slot {
  el: HTMLElement;
  style: CSSStyleDeclaration;
  animations: FakeAnimation[];
}

/** A card whose rect is whatever `rects` says at the time it is asked. */
function makeSlot(rects: Rect[]): Slot {
  let call = 0;
  const style = mock<CSSStyleDeclaration>({ cssText: '' });
  const animations: FakeAnimation[] = [];
  const el = mock<HTMLElement>({
    style,
    getBoundingClientRect: () => mock<DOMRect>(rects[Math.min(call++, rects.length - 1)]),
    animate(keyframes: Keyframe[] | PropertyIndexedKeyframes | null, opts?: number | KeyframeAnimationOptions) {
      const listeners: Record<string, (() => void)[]> = {};
      const anim = {
        keyframes: keyframes as Keyframe[], opts: opts as KeyframeAnimationOptions, cancelled: false,
        cancel() { this.cancelled = true; (listeners.cancel || []).forEach((f) => f()); },
        finish() { (listeners.finish || []).forEach((f) => f()); },
        addEventListener(type: string, fn: EventListenerOrEventListenerObject | null) {
          if (typeof fn === 'function') (listeners[type] ||= []).push(() => fn(new Event(type)));
        },
      };
      animations.push(anim);
      return mock<Animation>(anim);
    },
  });
  return { el, style, animations };
}

const R = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });
const GONE = R(0, 0, 0, 0);

/** A grid of slots, each given the rects it reports in measurement order. */
const makeGrid = (pairs: Rect[][]) => {
  const slots = pairs.map(makeSlot);
  return {
    el: mock<HTMLElement>({
      children: mock<HTMLCollection>(slots.map((s) => s.el)),
      parentElement: null,   // no transformed ancestor ⇒ origin is the viewport
    }),
    slot: (i: number) => must(slots[i], `slot ${i}`),
  };
};

/** The transform the FLIP starts a card from. */
const fromTransform = (anim: FakeAnimation) => anim.keyframes[0].transform;

describe('flipGrid', () => {
  before(async () => {
    globalThis.window = mock<typeof window>({
      matchMedia: (q: string) => mock<MediaQueryList>({ matches: q.includes('reduced-motion') && reducedMotion }),
      getComputedStyle: () => mock<CSSStyleDeclaration>({ transform: 'none', filter: 'none', perspective: 'none' }),
    });
    ({ flipGrid } = await import('../src/utils/gridFlip.ts'));
  });

  beforeEach(() => { reducedMotion = false; });

  test('animates a card that moved, from where it was to where it landed', () => {
    const grid = makeGrid([[R(0, 0, 100, 100), R(200, 50, 50, 50)]]);
    flipGrid(grid.el, () => {});
    const [anim] = grid.slot(0).animations;
    // Back by the offset, and at the size it used to be: 100/50 in both axes.
    assert.equal(fromTransform(anim), 'translate(-200px, -50px) scale(2, 2)');
    assert.equal(anim.keyframes[1].transform, 'none');
    assert.equal(anim.keyframes[0].transformOrigin, '0 0', 'scale must grow from the corner');
  });

  test('leaves a card that did not move alone', () => {
    const grid = makeGrid([[R(10, 10, 100, 100), R(10, 10, 100, 100)]]);
    flipGrid(grid.el, () => {});
    assert.equal(grid.slot(0).animations.length, 0);
  });

  test('a card that left the flow is pinned where it was and faded out', () => {
    const grid = makeGrid([[R(30, 40, 100, 100), GONE]]);
    flipGrid(grid.el, () => {});
    const slot = grid.slot(0);
    const [anim] = slot.animations;
    assert.deepEqual(anim.keyframes, [{ opacity: 1 }, { opacity: 0 }]);
    assert.equal(slot.style.position, 'fixed');
    assert.equal(slot.style.left, '30px');
    assert.equal(slot.style.top, '40px');
    assert.equal(slot.style.display, 'block', 'overrides the class that removed it');
    assert.ok(Number(anim.opts.duration) < 260, 'goes before the survivors have finished arriving');

    anim.finish();
    assert.equal(slot.style.cssText, '', 'the pin is dropped once the fade is done');
  });

  test('a card that was already gone is not animated back in', () => {
    const grid = makeGrid([[GONE, R(0, 0, 100, 100)]]);
    flipGrid(grid.el, () => {});
    assert.equal(grid.slot(0).animations.length, 0);
  });

  test('a step landing mid-glide cancels it before measuring the destination', () => {
    // Four rects: what each of the two flips measures, before and after.
    const grid = makeGrid([[
      R(0, 0, 100, 100), R(100, 0, 100, 100),
      R(100, 0, 100, 100), R(200, 0, 100, 100),
    ]]);
    flipGrid(grid.el, () => {});
    const first = grid.slot(0).animations[0];

    flipGrid(grid.el, () => {});
    assert.equal(first.cancelled, true, 'a running transform would corrupt the new rect');
    assert.equal(grid.slot(0).animations.length, 2);
  });

  test('the layout change happens exactly once, animation or not', () => {
    for (const setup of [
      () => { reducedMotion = true; return makeGrid([[R(0, 0, 10, 10), R(50, 0, 10, 10)]]).el; },
      () => makeGrid([]).el,                                     // nothing to animate
      () => mock<HTMLElement>({ children: mock<HTMLCollection>([ // no WAAPI
        mock<HTMLElement>({ getBoundingClientRect: () => mock<DOMRect>(R(0, 0, 1, 1)) }),
      ]) }),
      () => makeGrid([[R(0, 0, 10, 10), R(50, 0, 10, 10)]]).el,  // the normal path
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
    flipGrid(grid.el, () => {});
    assert.equal(grid.slot(0).animations.length, 0);
  });
});
