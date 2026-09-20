/**
 * The pointer mechanics `createDeckGestures` and `createAnchorGesture` both
 * need, factored out so each of them reads as a policy over one small
 * machine rather than its own copy of the machine.
 *
 * Every export here is stateless or holds only pointer bookkeeping — no
 * document, no drag state, no field is decided until a controller's own
 * `onPointerDown` reads it. What is shared is mechanical: how a press takes
 * the pointer, how an undecided touch resolves to a claim or a hand-back to
 * the browser's own panning, how a finished drag decides whether it actually
 * changed anything worth committing, and how many fingers a tap had.
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

/** How long a group of fingers may stay down and still count as a tap. Long
 *  enough for a deliberate two-finger tap, short enough that a rest of the
 *  hand on the glass is a hold rather than an undo. */
export const TAP_MS = 300;

/**
 * Watch the pointer stream for a multi-finger tap — `k` pointers down at
 * once, every one released inside `tapMs`, none moved past `DRAG_SLOP_PX`.
 * On the release of the last one it calls `onTap(k)`.
 *
 * It only reports the count; what 2 fingers or 3 fingers *mean* is the
 * controller's policy, the same division every other export here keeps.
 *
 * A pinch can never be read as a tap, because a pinch moves: the first
 * pointer past the slop disarms the group, and the group stays disarmed
 * until every pointer is up again. A hold cannot either: the elapsed time is
 * measured from the first press, so a group released late fires nothing.
 *
 * The watcher never claims a pointer and never calls `preventDefault` — it
 * reads the same events the controller is already handling, so a tap that
 * the controller also read as some other gesture still resolves that gesture
 * its own way.
 *
 * @param {{onTap: (count: number) => void, tapMs?: number, now?: () => number}} options
 */
export function createMultiTapWatcher({ onTap, tapMs = TAP_MS, now = () => Date.now() }) {
  /** Pointers currently down, each at the position it landed on — the
   *  baseline the slop test measures travel from. @type {Map<number, {x: number, y: number}>} */
  const down = new Map();
  /** The most pointers held at once since the group began. That, not the
   *  count at release, is the `k` of "k fingers tapped": the fingers of a
   *  real tap never lift in one event. */
  let peak = 0;
  /** When the first pointer of this group landed. */
  let startedAt = 0;
  /** False once this group can no longer be a tap. */
  let armed = true;

  const reset = () => {
    down.clear();
    peak = 0;
    startedAt = 0;
    armed = true;
  };

  /** Drop a pointer and, when it was the last one, decide what the group
   *  was. `clean` is false for a cancel, which is never a tap. */
  const lift = (e, clean) => {
    if (!down.has(e.pointerId)) return;
    down.delete(e.pointerId);
    if (!clean) armed = false;
    if (down.size) return;
    const count = peak;
    const tapped = armed && now() - startedAt <= tapMs;
    reset();
    if (tapped) onTap(count);
  };

  return {
    down(e) {
      if (!down.size) {
        peak = 0;
        startedAt = now();
        armed = true;
      }
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      peak = Math.max(peak, down.size);
    },
    move(e) {
      const from = down.get(e.pointerId);
      if (!from) return;
      if (pastSlop(e.clientX - from.x, e.clientY - from.y)) armed = false;
    },
    up: (e) => lift(e, true),
    cancel: (e) => lift(e, false),
    /** Forget the group in flight — what a controller's `destroy` calls, so
     *  a tap cannot fire across an unmount. */
    reset,
  };
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
