/**
 * The place peek: a dot-mode place shows `<name> · <n> posts` on demand.
 *
 * A fine pointer gets it on hover (CSS only, atlas.css `.atlas-marker__peek`).
 * A touch gets it on a long press: this file holds the timer and the slop.
 * A press that stays within `slop` px for `delay` ms shows the peek. The
 * release hides it after `hold` ms. A peek press is no tap: the click after it
 * must not open the cloud (`consumeClick`).
 */

/** The press time that shows the peek, ms. */
export const PEEK_DELAY = 450;
/** The movement that cancels a press, px. */
export const PEEK_SLOP = 6;
/** The time the peek stays after the release, ms. */
export const PEEK_HOLD = 1500;

export interface LongPressOptions {
  /** Show the peek of place `id`. */
  onPeek(id: number): void;
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

/** The text of a peek: `Berlin · 1 post`, `Berlin · 12 posts`. */
export function peekText(name: string, count: number): string {
  return `${name} · ${count} ${count === 1 ? 'post' : 'posts'}`;
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
        opts.onPeek(shown);
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
