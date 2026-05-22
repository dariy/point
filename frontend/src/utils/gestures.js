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
 * @param {number} dx      - Raw displacement in px (positive or negative)
 * @param {number} width   - Viewport/container width in px (default: window.innerWidth)
 * @returns {number} damped displacement
 */
export function rubberBand(dx, width = window.innerWidth) {
  const absDx = Math.abs(dx);
  const damped = (1 - 1 / ((absDx * 0.55) / width + 1)) * width; // 0.55 = iOS-standard damping coefficient
  return dx < 0 ? -damped : damped;
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

export class GestureController {
  /**
   * @param {HTMLElement} element
   * @param {Object} opts
   * @param {Function} [opts.onSwipeMove]    (dx, dy) — real-time drag feedback
   * @param {Function} [opts.onSwipeCommit]  (dir: 'left'|'right'|'up'|'down')
   * @param {Function} [opts.onSwipeCancel]  () — drag ended without commit
   * @param {Function} [opts.onPanMove]      (dx, dy) — pan while zoomed
   * @param {Function} [opts.onPinchMove]    (scaleDelta, cx, cy) — multiplicative
   * @param {Function} [opts.onPinchEnd]     ()
   * @param {Function} [opts.onTap]          (x, y)
   * @param {Function} [opts.onDoubleTap]    (x, y)
   * @param {number}   [opts.swipeThresholdPx=50]
   * @param {number}   [opts.commitThresholdPx=12]  movement before state commits
   * @param {number}   [opts.edgeIgnorePx=30]
   * @param {number}   [opts.doubleTapMs=300]
   * @param {number}   [opts.tapMovePx=8]
   */
  constructor(element, opts = {}) {
    this._el = element;
    this._opts = {
      swipeThresholdPx: 50,
      commitThresholdPx: 12,
      edgeIgnorePx: 30,
      doubleTapMs: 300,
      tapMovePx: 8,
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

    // Double-tap tracking
    this._lastTapTime = 0;

    this._onStart = this._onStart.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onEnd = this._onEnd.bind(this);
    this._onCancel = this._onCancel.bind(this);

    element.addEventListener("touchstart", this._onStart, { passive: true });
    element.addEventListener("touchmove", this._onMove, { passive: false });
    element.addEventListener("touchend", this._onEnd, { passive: true });
    element.addEventListener("touchcancel", this._onCancel, { passive: true });
  }

  /** Call this whenever the consumer's zoom state changes. */
  setZoomed(zoomed) {
    this._zoomed = zoomed;
  }

  _emit(name, ...args) {
    if (typeof this._opts[name] === "function") this._opts[name](...args);
  }

  _dist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _center(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  _onStart(e) {
    if (e.touches.length === 1) {
      // Ignore touches starting in a scrollable tags bar
      if (
        e.target.closest(".tag-strip-scroll") ||
        e.target.closest(".post-card-tags")
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
      this._state = STATE.MULTI_TOUCH;
    }
  }

  _onMove(e) {
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

      if (absDx >= absDy) {
        // Edge protection: ignore swipes starting in system back-gesture zones
        if (
          this._startX < this._opts.edgeIgnorePx ||
          this._startX > window.innerWidth - this._opts.edgeIgnorePx
        ) {
          this._state = STATE.IDLE;
          return;
        }
        this._state = this._zoomed ? STATE.PANNING : STATE.SWIPING_H;
      } else {
        this._state = this._zoomed ? STATE.PANNING : STATE.SWIPING_V;
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

  _onEnd(e) {
    const state = this._state;
    this._state = STATE.IDLE;

    if (state === STATE.PINCHING || state === STATE.MULTI_TOUCH) {
      this._emit("onPinchEnd");
      return;
    }

    if (state === STATE.PANNING) {
      this._emit("onSwipeCancel");
      return;
    }

    if (state === STATE.SWIPING_H || state === STATE.SWIPING_V) {
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
  }
}

/**
 * TrackpadDetector — detects horizontal trackpad swipes via wheel events.
 * Direction: deltaX > 0 → 'left' (finger moved right = content scrolls left).
 */
export class TrackpadDetector {
  /**
   * @param {HTMLElement} element
   * @param {Object} opts
   * @param {Function} opts.onHorizontal     Called with 'left' | 'right'
   * @param {number}   [opts.thresholdDeltaX=60]
   * @param {number}   [opts.maxDeltaY=30]
   * @param {number}   [opts.cooldownMs=600]
   */
  constructor(
    element,
    { onHorizontal, thresholdDeltaX = 60, maxDeltaY = 30, cooldownMs = 600 },
  ) {
    this._el = element;
    this.onHorizontal = onHorizontal;
    this.thresholdDeltaX = thresholdDeltaX;
    this.maxDeltaY = maxDeltaY;
    this.cooldownMs = cooldownMs;
    this._lastFired = 0;

    this._onWheel = this._onWheel.bind(this);
    element.addEventListener("wheel", this._onWheel, { passive: true });
  }

  _onWheel(e) {
    const now = Date.now();
    if (now - this._lastFired < this.cooldownMs) return;
    // Ignore events in the scrollable tags bar
    if (
      e.target.closest(".tag-strip-scroll") ||
      e.target.closest(".post-card-tags")
    )
      return;
    const absDx = Math.abs(e.deltaX);
    const absDy = Math.abs(e.deltaY);
    if (absDx > this.thresholdDeltaX && absDy < this.maxDeltaY) {
      this._lastFired = now;
      if (this.onHorizontal) this.onHorizontal(e.deltaX > 0 ? "left" : "right");
    }
  }

  destroy() {
    this._el.removeEventListener("wheel", this._onWheel);
  }
}
