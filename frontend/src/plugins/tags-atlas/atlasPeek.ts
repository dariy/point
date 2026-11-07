/**
 * The place peek: a collapsed place pill expands to `[● Berlin]` on demand.
 *
 * A fine pointer gets it on hover (CSS only, atlas.css `.atlas-marker:hover`).
 * A touch gets it on a long press: this file holds the timer and the slop.
 * A press that stays within `slop` px for `delay` ms expands the pill. The
 * release collapses it after `hold` ms. A peek press is no tap: the click after
 * it must not open the cloud (`consumeClick`).
 *
 * While the finger is down, the expanded pill shows above the finger, so that
 * the finger does not cover it (`liftPill`). The release moves it back to its
 * dot (`onDrop`), then the hold collapses it.
 */

/** The press time that shows the peek, ms. */
export const PEEK_DELAY = 450;
/** The movement that cancels a press, px. */
export const PEEK_SLOP = 6;
/** The time the peek stays after the release, ms. */
export const PEEK_HOLD = 1500;
/** The gap between the touch point and the lifted pill, px: clear of a fingertip. */
export const PEEK_LIFT = 44;
/** The move of the pill back to its dot on the release, ms (atlas.css `--drop`). */
export const PEEK_DROP_MS = 180;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The move (`dx`, `dy`, client px) that lifts a pill above the finger.
 * The pill is centred on its dot (`dotX`). Its bottom is `gap` px above the
 * touch point `y`. If the map box has no room above, its top is `gap` px below
 * the touch point. The pill stays inside `box`.
 */
export function liftPill(pill: Rect, dotX: number, y: number, box: Bounds, gap: number = PEEK_LIFT): { dx: number; dy: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const left = clamp(dotX - pill.width / 2, box.left, box.right - pill.width);
  let top = y - gap - pill.height;
  if (top < box.top) top = Math.min(y + gap, box.bottom - pill.height);
  return { dx: left - pill.left, dy: top - pill.top };
}

export interface LongPressOptions {
  /** Show the peek of place `id`; the finger is down at client px `x`, `y`. */
  onPeek(id: number, x: number, y: number): void;
  /** The finger that shows the peek of place `id` lifts: the pill goes back to its dot. */
  onDrop?(id: number): void;
  /** Hide the peek of place `id`. */
  onHide(id: number): void;
  delay?: number;
  slop?: number;
  hold?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface LongPress {
  /** A touch starts on place `id` at client px `x`, `y`. */
  down(id: number, pointerId: number, x: number, y: number): void;
  move(pointerId: number, x: number, y: number): void;
  /** The touch ends (up or cancel). */
  up(pointerId: number): void;
  /** True one time after a press that showed the peek: stop that click. */
  consumeClick(): boolean;
  /** A peek shows, or a press waits to show one. */
  active(): boolean;
  /** Stop the timers and hide a peek that shows. */
  cancel(): void;
}

export function createLongPress(opts: LongPressOptions): LongPress {
  const delay = opts.delay ?? PEEK_DELAY;
  const slop = opts.slop ?? PEEK_SLOP;
  const hold = opts.hold ?? PEEK_HOLD;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));

  // The press in progress.
  let press: { id: number; pointerId: number; x: number; y: number } | null = null;
  let pressTimer: unknown = null;
  // The place whose peek shows, and its hide timer.
  let shown: number | null = null;
  let hideTimer: unknown = null;
  // The press showed the peek: its click is no tap.
  let swallow = false;

  const stopPress = () => {
    if (pressTimer !== null) clearTimer(pressTimer);
    pressTimer = null;
    press = null;
  };
  const hide = () => {
    if (hideTimer !== null) clearTimer(hideTimer);
    hideTimer = null;
    if (shown !== null) opts.onHide(shown);
    shown = null;
  };

  return {
    down(id, pointerId, x, y) {
      stopPress();
      hide();
      swallow = false;
      press = { id, pointerId, x, y };
      pressTimer = setTimer(() => {
        pressTimer = null;
        if (!press) return;
        shown = press.id;
        swallow = true;
        opts.onPeek(shown, press.x, press.y);
      }, delay);
    },
    move(pointerId, x, y) {
      if (!press || press.pointerId !== pointerId || pressTimer === null) return;
      if (Math.hypot(x - press.x, y - press.y) >= slop) stopPress();
    },
    up(pointerId) {
      if (press && press.pointerId !== pointerId) return;
      stopPress();
      if (shown === null || hideTimer !== null) return;
      opts.onDrop?.(shown);
      hideTimer = setTimer(() => {
        hideTimer = null;
        hide();
      }, hold);
    },
    consumeClick() {
      const s = swallow;
      swallow = false;
      return s;
    },
    active() {
      return press !== null || shown !== null;
    },
    cancel() {
      stopPress();
      hide();
      swallow = false;
    },
  };
}
