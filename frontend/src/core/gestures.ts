/**
 * GestureController — unified touch gesture state machine.
 *
 * Recognises: horizontal swipe, vertical swipe, pinch, pan (while zoomed), tap, double-tap.
 * Call setZoomed(true) when the consumer has zoomed in so that horizontal drags
 * route to onPanMove instead of onSwipeMove.
 */

/**
 * iOS-style rubber-band damping for edge-resistance drag.
 * Returns a damped displacement that fights back as dx grows.
 *
 * @param dx - Raw displacement in px (positive or negative)
 * @param width - Viewport/container width in px (default: window.innerWidth)
 * @returns damped displacement
 */
export function rubberBand(dx: number, width: number = window.innerWidth): number {
  const absDx = Math.abs(dx);
  const damped = (1 - 1 / ((absDx * 0.55) / width + 1)) * width; // 0.55 = iOS-standard damping coefficient
  return dx < 0 ? -damped : damped;
}

/** Desktop Safari's trackpad pinch event (gesturestart/change/end), not in lib.dom. */
export interface SafariGestureEvent extends Event {
  readonly scale: number;
}

const STATE = {
  IDLE: "IDLE",
  SINGLE_TOUCH: "SINGLE_TOUCH",
  MULTI_TOUCH: "MULTI_TOUCH",
  SWIPING_H: "SWIPING_H",
  SWIPING_V: "SWIPING_V",
  PINCHING: "PINCHING",
  PANNING: "PANNING",
};

export type SwipeDir = 'left' | 'right' | 'up' | 'down';

/** GestureController options. Every callback is optional. */
export interface GestureOptions {
  /** (dx, dy) — real-time drag feedback */
  onSwipeMove?: (dx: number, dy: number) => void;
  /** (dir: 'left'|'right'|'up'|'down') */
  onSwipeCommit?: (dir: SwipeDir) => void;
  /** () — drag ended without commit */
  onSwipeCancel?: () => void;
  /** (dx, dy) — pan while zoomed */
  onPanMove?: (dx: number, dy: number) => void;
  /** (scaleDelta, cx, cy) — multiplicative */
  onPinchMove?: (delta: number, cx: number, cy: number) => void;
  /** () */
  onPinchEnd?: () => void;
  /** (x, y) */
  onTap?: (x: number, y: number) => void;
  /** (x, y) */
  onDoubleTap?: (x: number, y: number) => void;
  /** (x, y) */
  onTwoFingerTap?: (x: number, y: number) => void;
  /**
   * CSS selector; touches starting on a matching element (or its ancestor) are
   * ignored so the consumer can cede that region to a nested gesture handler.
   */
  ignoreSelector?: string;
  /** Default 50. */
  swipeThresholdPx?: number;
  /** Movement before state commits. Default 12. */
  commitThresholdPx?: number;
  /** Default 30. */
  edgeIgnorePx?: number;
  /** Default 300. */
  doubleTapMs?: number;
  /** Default 8. */
  tapMovePx?: number;
  /**
   * Dominance factor that splits a drag into one of three classes: "mostly
   * horizontal" (absDx ≥ absDy×ratio), "mostly vertical" (absDy ≥ absDx×ratio),
   * or "mostly diagonal" (neither axis dominates). A horizontal class commits to
   * a swipe/pan; a vertical class commits to a vertical swipe; a diagonal class
   * is ignored so an ambiguous, slanted drag never flips the page or fires a
   * vertical action. Default 1.3.
   */
  directionRatio?: number;
}

type GestureCallback =
  | "onSwipeMove" | "onSwipeCommit" | "onSwipeCancel" | "onPanMove" | "onPinchMove"
  | "onPinchEnd" | "onTap" | "onDoubleTap" | "onTwoFingerTap";

type GestureDefaults =
  | "swipeThresholdPx" | "commitThresholdPx" | "edgeIgnorePx" | "doubleTapMs"
  | "tapMovePx" | "directionRatio";

export class GestureController {
  _el: HTMLElement;
  _opts: GestureOptions & Required<Pick<GestureOptions, GestureDefaults>>;
  _state: string;
  _zoomed: boolean;
  _startX: number;
  _startY: number;
  _pinchStartDist: number;
  _pinchCx: number;
  _pinchCy: number;
  _twoFingerStartX: number;
  _twoFingerStartY: number;
  _twoFingerStartTime: number;
  _lastTapTime: number;
  _swallowClick: boolean;

  constructor(element: HTMLElement, opts: GestureOptions = {}) {
    this._el = element;
    this._opts = {
      swipeThresholdPx: 50,
      commitThresholdPx: 12,
      edgeIgnorePx: 30,
      doubleTapMs: 300,
      tapMovePx: 8,
      directionRatio: 1.3,
      ...opts,
    };
    this._state = STATE.IDLE;
    this._zoomed = false;

    // Single-touch tracking
    this._startX = 0;
    this._startY = 0;

    // Pinch tracking
    this._pinchStartDist = 0;
    this._pinchCx = 0;
    this._pinchCy = 0;

    // Two-finger tap tracking
    this._twoFingerStartX = 0;
    this._twoFingerStartY = 0;
    this._twoFingerStartTime = 0;

    // Double-tap tracking
    this._lastTapTime = 0;
    this._swallowClick = false;

    this._onStart = this._onStart.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onEnd = this._onEnd.bind(this);
    this._onCancel = this._onCancel.bind(this);
    this._onClick = this._onClick.bind(this);

    element.addEventListener("touchstart", this._onStart, { passive: true });
    element.addEventListener("touchmove", this._onMove, { passive: false });
    element.addEventListener("touchend", this._onEnd, { passive: true });
    element.addEventListener("touchcancel", this._onCancel, { passive: true });
    element.addEventListener("click", this._onClick, true);
  }

  _onClick(e: MouseEvent) {
    if (this._swallowClick) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /** Call this whenever the consumer's zoom state changes. */
  setZoomed(zoomed: boolean) {
    this._zoomed = zoomed;
  }

  _emit<K extends GestureCallback>(name: K, ...args: Parameters<NonNullable<GestureOptions[K]>>) {
    const fn = this._opts[name] as ((...a: typeof args) => void) | undefined;
    if (typeof fn === "function") fn(...args);
  }

  _dist(touches: TouchList) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _center(touches: TouchList) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  _onStart(e: TouchEvent) {
    if (e.touches.length === 1) {
      const target = e.target as Element;
      // Ignore touches starting in a scrollable tags bar, or in any region the
      // consumer opts out of via `ignoreSelector` (e.g. a swipe-to-reveal row
      // that owns its own horizontal gesture and must not also close a drawer).
      if (
        target.closest(".tag-strip-scroll") ||
        target.closest(".post-card-tags") ||
        (this._opts.ignoreSelector && target.closest(this._opts.ignoreSelector))
      ) {
        this._state = STATE.IDLE;
        return;
      }
      const t = e.touches[0];
      this._startX = t.clientX;
      this._startY = t.clientY;
      this._state = STATE.SINGLE_TOUCH;
    } else if (e.touches.length === 2) {
      // Cancel any in-progress swipe
      if (
        this._state === STATE.SWIPING_H ||
        this._state === STATE.SWIPING_V ||
        this._state === STATE.PANNING
      ) {
        this._emit("onSwipeCancel");
      }
      this._pinchStartDist = this._dist(e.touches);
      const c = this._center(e.touches);
      this._pinchCx = c.x;
      this._pinchCy = c.y;
      this._twoFingerStartX = c.x;
      this._twoFingerStartY = c.y;
      this._twoFingerStartTime = Date.now();
      this._state = STATE.MULTI_TOUCH;
    }
  }

  _onMove(e: TouchEvent) {
    // Two-finger pinch
    if (
      e.touches.length === 2 &&
      (this._state === STATE.MULTI_TOUCH || this._state === STATE.PINCHING)
    ) {
      e.preventDefault(); // prevent browser zoom
      this._state = STATE.PINCHING;
      const scaleDelta = this._dist(e.touches) / this._pinchStartDist;
      // Update base for next move event so delta is incremental
      this._pinchStartDist = this._dist(e.touches);
      this._emit("onPinchMove", scaleDelta, this._pinchCx, this._pinchCy);
      return;
    }

    if (e.touches.length !== 1) return;
    if (
      this._state !== STATE.SINGLE_TOUCH &&
      this._state !== STATE.SWIPING_H &&
      this._state !== STATE.SWIPING_V &&
      this._state !== STATE.PANNING
    )
      return;

    const t = e.touches[0];
    const dx = t.clientX - this._startX;
    const dy = t.clientY - this._startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // State commitment
    if (this._state === STATE.SINGLE_TOUCH) {
      const moved = Math.max(absDx, absDy);
      if (moved < this._opts.commitThresholdPx) return;

      const ratio = this._opts.directionRatio;
      if (absDx >= absDy * ratio) {
        // Mostly horizontal
        // Edge protection: ignore swipes starting in system back-gesture zones
        if (
          this._startX < this._opts.edgeIgnorePx ||
          this._startX > window.innerWidth - this._opts.edgeIgnorePx
        ) {
          this._state = STATE.IDLE;
          return;
        }
        this._state = this._zoomed ? STATE.PANNING : STATE.SWIPING_H;
      } else if (absDy >= absDx * ratio) {
        // Mostly vertical — pans the zoomed image; only steps (close/reset) at fit.
        this._state = this._zoomed ? STATE.PANNING : STATE.SWIPING_V;
      } else {
        // Mostly diagonal — too ambiguous to act on. Bail out and let the
        // browser handle native scrolling without firing any swipe action.
        this._state = STATE.IDLE;
        return;
      }
    }
    if (this._state === STATE.SWIPING_H || this._state === STATE.SWIPING_V) {
      if (this._state === STATE.SWIPING_H && e.cancelable) {
        e.preventDefault(); // Stop browser back/forward and touchcancel
      }
      this._emit("onSwipeMove", dx, dy);
    } else if (this._state === STATE.PANNING) {
      if (e.cancelable) e.preventDefault(); // Stop any browser scrolling
      this._emit("onPanMove", dx, dy);
      // Update start for next move to provide incremental deltas
      this._startX = t.clientX;
      this._startY = t.clientY;
    }
  }

  _onEnd(e: TouchEvent) {
    const state = this._state;
    this._state = STATE.IDLE;

    if (state === STATE.PINCHING || state === STATE.MULTI_TOUCH) {
      if (state === STATE.MULTI_TOUCH) {
        const now = Date.now();
        if (now - this._twoFingerStartTime < this._opts.doubleTapMs) {
          this._emit(
            "onTwoFingerTap",
            this._twoFingerStartX,
            this._twoFingerStartY,
          );
        }
      }
      this._emit("onPinchEnd");
      return;
    }

    if (state === STATE.PANNING) {
      this._swallowClick = true;
      setTimeout(() => { this._swallowClick = false; }, 400);
      this._emit("onSwipeCancel");
      return;
    }

    if (state === STATE.SWIPING_H || state === STATE.SWIPING_V) {
      this._swallowClick = true;
      setTimeout(() => { this._swallowClick = false; }, 400);
      const t = e.changedTouches[0];
      const dx = t.clientX - this._startX;
      const dy = t.clientY - this._startY;
      if (
        state === STATE.SWIPING_H &&
        Math.abs(dx) >= this._opts.swipeThresholdPx
      ) {
        this._emit("onSwipeCommit", dx < 0 ? "left" : "right");
      } else if (
        state === STATE.SWIPING_V &&
        Math.abs(dy) >= this._opts.swipeThresholdPx
      ) {
        this._emit("onSwipeCommit", dy < 0 ? "up" : "down");
      } else {
        this._emit("onSwipeCancel");
      }
      return;
    }

    if (state === STATE.SINGLE_TOUCH && e.changedTouches.length === 1) {
      const t = e.changedTouches[0];
      const dx = t.clientX - this._startX;
      const dy = t.clientY - this._startY;
      if (Math.sqrt(dx * dx + dy * dy) < this._opts.tapMovePx) {
        const now = Date.now();
        if (now - this._lastTapTime < this._opts.doubleTapMs) {
          this._lastTapTime = 0;
          this._emit("onDoubleTap", t.clientX, t.clientY);
        } else {
          this._lastTapTime = now;
          this._emit("onTap", t.clientX, t.clientY);
        }
      }
    }
  }

  _onCancel() {
    const state = this._state;
    this._state = STATE.IDLE;
    if (
      state === STATE.SWIPING_H ||
      state === STATE.SWIPING_V ||
      state === STATE.PANNING
    ) {
      this._emit("onSwipeCancel");
    } else if (state === STATE.PINCHING || state === STATE.MULTI_TOUCH) {
      this._emit("onPinchEnd");
    }
  }

  destroy() {
    this._el.removeEventListener("touchstart", this._onStart);
    this._el.removeEventListener("touchmove", this._onMove);
    this._el.removeEventListener("touchend", this._onEnd);
    this._el.removeEventListener("touchcancel", this._onCancel);
    this._el.removeEventListener("click", this._onClick, true);
  }
}

/**
 * TrackpadDetector — detects horizontal trackpad swipes via wheel events.
 * Direction: deltaX > 0 → 'left' (finger moved right = content scrolls left).
 */
export class TrackpadDetector {
  _el: HTMLElement;
  onHorizontal: (dir: 'left' | 'right') => void;
  thresholdDeltaX: number;
  maxDeltaY: number;
  dominanceRatio: number;
  cooldownMs: number;
  _lastFired: number;

  /**
   * @param opts.onHorizontal - Called with 'left' | 'right'
   * @param opts.thresholdDeltaX
   * @param opts.maxDeltaY
   * @param opts.dominanceRatio - deltaX must exceed deltaY by
   *   this factor, so a vertical scroll with sideways jitter never fires.
   * @param opts.cooldownMs
   */
  constructor(
    element: HTMLElement,
    {
      onHorizontal,
      thresholdDeltaX = 60,
      maxDeltaY = 30,
      dominanceRatio = 1.5,
      cooldownMs = 600,
    }: {
      onHorizontal: (dir: 'left' | 'right') => void;
      thresholdDeltaX?: number;
      maxDeltaY?: number;
      dominanceRatio?: number;
      cooldownMs?: number;
    },
  ) {
    this._el = element;
    this.onHorizontal = onHorizontal;
    this.thresholdDeltaX = thresholdDeltaX;
    this.maxDeltaY = maxDeltaY;
    this.dominanceRatio = dominanceRatio;
    this.cooldownMs = cooldownMs;
    this._lastFired = 0;

    this._onWheel = this._onWheel.bind(this);
    element.addEventListener("wheel", this._onWheel, { passive: true });
  }

  _onWheel(e: WheelEvent) {
    const target = e.target as Element;
    const now = Date.now();
    if (now - this._lastFired < this.cooldownMs) return;
    // Ignore events in the scrollable tags bar
    if (
      target.closest(".tag-strip-scroll") ||
      target.closest(".post-card-tags")
    )
      return;
    const absDx = Math.abs(e.deltaX);
    const absDy = Math.abs(e.deltaY);
    if (
      absDx > this.thresholdDeltaX &&
      absDy < this.maxDeltaY &&
      absDx > absDy * this.dominanceRatio
    ) {
      this._lastFired = now;
      if (this.onHorizontal) this.onHorizontal(e.deltaX > 0 ? "left" : "right");
    }
  }

  destroy() {
    this._el.removeEventListener("wheel", this._onWheel);
  }
}
