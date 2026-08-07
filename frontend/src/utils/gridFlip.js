/**
 * FLIP the post grid across a zoom step.
 *
 * A step changes the grid's whole geometry at once — the column count, the row
 * count, and which cards are still in flow — so every card lands somewhere
 * else, at another size. Applied bare that is a hard cut between two layouts,
 * which is what a step used to look like however correct the destination was.
 *
 * FLIP (First, Last, Invert, Play) turns it into a move: measure where the
 * cards are, apply the change, measure where they ended up, then animate each
 * card from a transform that puts it back where it started to none. The layout
 * is only ever done once — the motion is composited transforms on top of a grid
 * that is already in its final state, so nothing re-flows per frame and no
 * measurement is taken from a moving target.
 *
 * The cards a narrower step has no room for are the one thing FLIP alone cannot
 * express: they leave the flow, so there is no "last" rect to animate towards.
 * They are pinned to the rect they just had and faded out instead, over half
 * the time the survivors take, so the grid is not still dissolving one card
 * while another has finished growing over it.
 */

// The animation this module last gave a card, so a step landing mid-glide can
// stop it before measuring the layout it is moving into. getBoundingClientRect
// reports the transformed box, which is what we want for "where the card is
// now" and ruinous for "where it is going" — a running glide would fold its own
// offset into the destination.
const FLIP = Symbol('flip');

const DURATION = 260;
const EASING = 'cubic-bezier(0.2, 0, 0, 1)';
// Under this, a card has not really moved — animating it only costs a layer.
const EPSILON_PX = 1;
const EPSILON_SCALE = 0.01;

const prefersReducedMotion = () =>
  !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Apply a grid layout change and animate the cards from the old layout into it.
 *
 * @param {HTMLElement|null} grid  the `.posts-grid` whose children are the cards.
 * @param {() => void} mutate  applies the new geometry. Called exactly once,
 *   between the two measurements — everything it changes is animated.
 * @param {object} [opts]
 * @param {number} [opts.duration]  glide length in ms.
 */
export function flipGrid(grid, mutate, { duration = DURATION } = {}) {
  const slots = grid ? [...grid.children] : [];
  // Nothing to animate from, no animation to play with, or the visitor has
  // asked for none: the change still has to happen, just without the motion.
  if (!slots.length || typeof slots[0].animate !== 'function' || prefersReducedMotion()) {
    mutate();
    return;
  }

  // Where the cards are *now*, mid-glide included: a step that interrupts
  // another one carries on from what is on screen rather than snapping first.
  const first = slots.map((el) => el.getBoundingClientRect());
  slots.forEach((el) => el[FLIP]?.cancel());
  mutate();
  const last = slots.map((el) => el.getBoundingClientRect());

  const origin = containingBlockOrigin(grid);

  slots.forEach((el, i) => {
    const a = first[i];
    const b = last[i];
    if (!a.width || !a.height) return;          // was not on screen to begin with
    if (!b.width || !b.height) {                // no room for it any more
      fadeOutInPlace(el, a, origin, duration / 2);
      return;
    }
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    const sx = a.width / b.width;
    const sy = a.height / b.height;
    if (
      Math.abs(dx) < EPSILON_PX && Math.abs(dy) < EPSILON_PX &&
      Math.abs(sx - 1) < EPSILON_SCALE && Math.abs(sy - 1) < EPSILON_SCALE
    ) return;
    el[FLIP] = el.animate(
      [
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: '0 0', transform: 'none' },
      ],
      { duration, easing: EASING },
    );
  });
}

/**
 * Where a position:fixed child of the grid measures its offsets from.
 *
 * Normally that is the viewport, but a transformed ancestor becomes the
 * containing block instead — and the grid mount always has one: `translateZ(0)`
 * to pre-raster its compositor layer for swipes, plus the drag's own
 * `translateX` on top of it. Both are translations, so subtracting the
 * ancestor's rect converts a viewport rect into its coordinate space, and a
 * card pinned mid-swipe travels with the grid it was part of.
 *
 * @returns {{left: number, top: number}} the origin to measure from.
 */
function containingBlockOrigin(grid) {
  for (let node = grid.parentElement; node; node = node.parentElement) {
    const cs = window.getComputedStyle(node);
    if (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none') {
      return node.getBoundingClientRect();
    }
  }
  return { left: 0, top: 0 }; // the viewport
}

/**
 * Hold a card that has left the flow at the rect it last had and fade it out.
 *
 * The inline styles override the class that took it out (display:none) for as
 * long as the fade runs, and are dropped afterwards so the class is all that is
 * left holding it — nothing to unwind if the grid is rebuilt mid-fade.
 */
function fadeOutInPlace(el, rect, origin, duration) {
  const restore = el.style.cssText;
  Object.assign(el.style, {
    display: 'block',
    position: 'fixed',
    left: `${rect.left - origin.left}px`,
    top: `${rect.top - origin.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    pointerEvents: 'none',
  });
  const anim = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'ease-out' });
  const done = () => { el.style.cssText = restore; };
  anim.addEventListener('finish', done);
  anim.addEventListener('cancel', done);
  el[FLIP] = anim;
}
