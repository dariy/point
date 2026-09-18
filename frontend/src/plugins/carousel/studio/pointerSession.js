/**
 * The pointer mechanics `createDeckGestures` and `createAnchorGesture` both
 * need, factored out so each of them reads as a policy over one small
 * machine rather than its own copy of the machine.
 *
 * Every export here is stateless or holds only listener bookkeeping — no
 * document, no drag state, no field is decided until a controller's own
 * `onPointerDown` reads it. What is shared is mechanical: how a press takes
 * the pointer, how an undecided touch resolves to a claim or a hand-back to
 * the browser's own panning, and how a finished drag decides whether it
 * actually changed anything worth committing.
 */

import { gestureDirection } from "../../../components/light/tags/tagGestures.js";

/** Pointer travel below this is a click, not a drag. */
export const DRAG_SLOP_PX = 3;

/** True once travel from a press's start exceeds the slop threshold on
 *  either axis — the two-axis "has this become a drag yet" test a mouse or
 *  pen gesture watches once it already owns the pointer. */
export function pastSlop(dx, dy, slop = DRAG_SLOP_PX) {
  return Math.abs(dx) > slop || Math.abs(dy) > slop;
}

/**
 * Take a pointer for a live gesture: capture it, dress the element, and —
 * unless the caller says otherwise — stop the browser doing anything else
 * with the event. `preventDefault: false` is for a kind (the deck's pane
 * scroll) that wants the capture and the dressing but leaves the event
 * alone.
 */
export function claimPointer(e, el, dressClass, { preventDefault = true } = {}) {
  el.setPointerCapture?.(e.pointerId);
  el.classList?.add(dressClass);
  if (preventDefault) e.preventDefault?.();
}

/** Release a pointer a claim took: capture and dressing both, the two
 *  always ending together. */
export function releasePointer(e, el, dressClass) {
  el.releasePointerCapture?.(e.pointerId);
  el.classList?.remove(dressClass);
}

/**
 * The touch-claim policy shared by every gesture that starts undecided on a
 * bare finger: nothing is claimed until `gestureDirection` can call an axis,
 * and the caller — who alone knows which axis its surface already hands to
 * the browser's own pan — says whether that axis is its own.
 *
 * Returns `"claim"` (the caller owns this drag now), `"abandon"` (hand it
 * back and stop watching), or `null` (still too little travel to call).
 *
 * @param {number} dx
 * @param {number} dy
 * @param {(dir: "horizontal"|"vertical") => boolean} ownsDirection
 */
export function resolveTouchClaim(dx, dy, ownsDirection) {
  const dir = gestureDirection(dx, dy);
  if (!dir) return null;
  return ownsDirection(dir) ? "claim" : "abandon";
}

/**
 * The one commit point every drag-to-a-field gesture ends on: a drag that
 * ran back to where it started (edge clamp, slack limit) should not mark
 * the document dirty over a float ulp. `same(next, start)` decides that;
 * `onSame` repaints from the document instead of committing.
 */
export function commitIfChanged(same, next, start, onSame, onCommit) {
  if (same(next, start)) {
    onSame();
    return;
  }
  onCommit(next);
}

/**
 * The `bound[]` / `detach` pair `attach` re-runs on every render, shared by
 * both controllers so neither re-implements the remover bookkeeping.
 */
export function createListenerGroup() {
  let bound = [];
  return {
    /** @param {Array<[string, (e: any) => void, AddEventListenerOptions?]>} handlers */
    bind(el, handlers) {
      for (const [type, fn, opts] of handlers) {
        el.addEventListener(type, fn, opts);
        bound.push(() => el.removeEventListener(type, fn, opts));
      }
    },
    /** Release every listener bound since the last `release()`. */
    release() {
      for (const off of bound) off();
      bound = [];
    },
  };
}
