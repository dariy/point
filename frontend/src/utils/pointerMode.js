/**
 * Pointer-capability detection.
 *
 * CSS `(pointer: coarse)` and `(any-hover: none)` report the input capabilities
 * a browser *declares*, and browsers get this wrong: a laptop with a touchscreen
 * can report "touch only, nothing here can hover" while a trackpad is attached,
 * dropping a desktop machine into phone styling. Capability queries alone can't
 * answer "is there a mouse on this device?".
 *
 * So the media queries are treated as a first guess, and the moment a real mouse
 * event arrives we mark the document `pointer-fine` and never look back. Touch
 * styling is opt-out: every coarse-pointer block is scoped to
 * `html:not(.pointer-fine)`, so a device that never produces a mouse event keeps
 * its 44px tap targets and always-visible affordances.
 *
 * The verdict is cached, so after the first visit the class is applied before
 * first paint and the machine never flashes touch styling.
 */

const CLASS = "pointer-fine";
const KEY = "pointerFine";

// A tap also emits compatibility mouse events. Anything claiming to be a mouse
// this soon after a touch is that echo, not a second input device.
const TOUCH_ECHO_MS = 700;

export function initPointerMode() {
  const root = document.documentElement;

  try {
    if (localStorage.getItem(KEY) === "1") root.classList.add(CLASS);
  } catch {
    /* localStorage can throw in private mode — fall through to detection */
  }
  if (root.classList.contains(CLASS)) return;

  let lastTouch = 0;
  const noteTouch = () => { lastTouch = Date.now(); };

  const promote = (e) => {
    // Only a mouse or trackpad counts. A stylus reports "pen" and wants the
    // larger targets; touch reports "touch" and obviously doesn't qualify.
    if (e.pointerType !== "mouse") return;
    if (Date.now() - lastTouch < TOUCH_ECHO_MS) return;
    root.classList.add(CLASS);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore — the class still applies for this session */
    }
    stop();
  };

  const stop = () => {
    window.removeEventListener("touchstart", noteTouch, true);
    window.removeEventListener("pointermove", promote, true);
    window.removeEventListener("pointerdown", promote, true);
  };

  window.addEventListener("touchstart", noteTouch, true);
  window.addEventListener("pointermove", promote, true);
  window.addEventListener("pointerdown", promote, true);
}

/**
 * Is a mouse or trackpad driving this session?
 *
 * Call this *inside* the handler, never once while wiring it: the class lands
 * the moment a real mouse event arrives, so a verdict taken at wiring time can
 * be stale by the time the user actually interacts. Falls back to the media
 * query before any pointer event has been seen.
 */
export function hasFinePointer() {
  if (document.documentElement.classList.contains(CLASS)) return true;
  return !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;
}
