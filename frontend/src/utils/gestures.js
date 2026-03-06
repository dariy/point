/**
 * Detects swipe gestures on a given element.
 */
export class SwipeDetector {
  /**
   * @param {HTMLElement} element
   * @param {Object} options
   * @param {Function} options.onHorizontal - Called with 'left' | 'right'
   * @param {Function} options.onVertical - Called with 'up' | 'down'
   * @param {number} [options.thresholdPx=50] - Minimum travel distance
   * @param {number} [options.edgeIgnorePx=30] - Width of ignore zones at screen edges
   */
  constructor(element, { onHorizontal, onVertical, onMove, onEnd, thresholdPx = 50, edgeIgnorePx = 30 } = {}) {
    this.element = element;
    this.onHorizontal = onHorizontal;
    this.onVertical = onVertical;
    this.onMove = onMove;
    this.onEnd = onEnd;
    this.thresholdPx = thresholdPx;
    this.edgeIgnorePx = edgeIgnorePx;

    this.startX = 0;
    this.startY = 0;
    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);

    this.element.addEventListener('touchstart', this.handleTouchStart, { passive: true });
    this.element.addEventListener('touchmove', this.handleTouchMove, { passive: true });
    this.element.addEventListener('touchend', this.handleTouchEnd, { passive: true });
  }

  handleTouchStart(e) {
    const touch = e.changedTouches[0];
    this.startX = touch.clientX;
    this.startY = touch.clientY;
  }

  handleTouchMove(e) {
    if (!this.onMove) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - this.startX;
    const dy = touch.clientY - this.startY;
    
    // Check edge protection before emitting move events
    if (this.startX < this.edgeIgnorePx || this.startX > window.innerWidth - this.edgeIgnorePx) return;
    
    this.onMove(dx, dy);
  }

  handleTouchEnd(e) {
    const touch = e.changedTouches[0];
    const dx = touch.clientX - this.startX;
    const dy = touch.clientY - this.startY;

    // Edge protection: ignore swipes starting in the system back zones
    if (this.startX < this.edgeIgnorePx || this.startX > window.innerWidth - this.edgeIgnorePx) {
      return;
    }

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx > absDy && absDx > this.thresholdPx) {
      if (this.onHorizontal) {
        this.onHorizontal(dx < 0 ? 'left' : 'right');
      }
    } else if (absDy > absDx && absDy > this.thresholdPx) {
      if (this.onVertical) {
        this.onVertical(dy < 0 ? 'up' : 'down');
      }
    }
    
    if (this.onEnd) {
      this.onEnd();
    }
  }

  destroy() {
    this.element.removeEventListener('touchstart', this.handleTouchStart);
    this.element.removeEventListener('touchend', this.handleTouchEnd);
  }
}

/**
 * Detects horizontal trackpad swipes on a given element.
 */
export class TrackpadDetector {
  /**
   * @param {HTMLElement} element
   * @param {Object} options
   * @param {Function} options.onHorizontal - Called with 'left' | 'right'
   * @param {number} [options.thresholdDeltaX=60] - Minimum abs(deltaX)
   * @param {number} [options.maxDeltaY=30] - Maximum abs(deltaY) to filter out mouse scroll
   * @param {number} [options.cooldownMs=600] - Minimum time between fired events
   */
  constructor(element, { onHorizontal, thresholdDeltaX = 60, maxDeltaY = 30, cooldownMs = 600 }) {
    this.element = element;
    this.onHorizontal = onHorizontal;
    this.thresholdDeltaX = thresholdDeltaX;
    this.maxDeltaY = maxDeltaY;
    this.cooldownMs = cooldownMs;

    this.lastFired = 0;

    this.handleWheel = this.handleWheel.bind(this);
    this.element.addEventListener('wheel', this.handleWheel, { passive: true });
  }

  handleWheel(e) {
    const now = Date.now();
    if (now - this.lastFired < this.cooldownMs) {
      return;
    }

    const absDx = Math.abs(e.deltaX);
    const absDy = Math.abs(e.deltaY);

    if (absDx > this.thresholdDeltaX && absDy < this.maxDeltaY) {
      this.lastFired = now;
      if (this.onHorizontal) {
        this.onHorizontal(e.deltaX > 0 ? 'left' : 'right');
      }
    }
  }

  destroy() {
    this.element.removeEventListener('wheel', this.handleWheel);
  }
}
