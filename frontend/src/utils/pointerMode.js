/**
 * Pointer-capability detection.
 *
 * CSS `(pointer: coarse)` and `(any-hover: none)` report the input capabilities
 * a browser *declares*, and browsers get this wrong: a laptop with a touchscreen
 * can report "touch only, nothing here can hover" while a trackpad is attached,
 * dropping a desktop machine into phone styling. Capability queries alone can't
 * answer "is there a mouse on this device?".
 *
 * So the media queries are only a first guess and real input events decide: a
 * mouse event marks the document `pointer-fine`, a touch takes the mark away
 * again. Touch styling is opt-out: every coarse-pointer block is scoped to
 * `html:not(.pointer-fine)`, so a device that never produces a mouse event keeps
 * its 44px tap targets and always-visible affordances.
 *
 * The verdict follows the input in use, in both directions, because it did not
 * used to: it latched on the first mouse event and was cached, so a laptop that
 * had ever been used with a mouse stayed in mouse styling when the same browser
 * was later driven by touch — a tablet in a keyboard dock, a touchscreen laptop
 * folded over, or DevTools switched into device mode. The cache still applies
 * the last verdict before first paint, so the common case never flashes.
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

  // Mirrored in a local so the pointermove path costs a comparison rather than
  // a DOM read on every move.
  let fine = root.classList.contains(CLASS);
  let lastTouch = 0;

  const remember = (value) => {
    try {
      if (value) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      /* ignore — the class still tracks the input for this session */
    }
  };

  const promote = (e) => {
    // Only a mouse or trackpad counts. A stylus reports "pen" and wants the
    // larger targets; touch reports "touch" and obviously doesn't qualify.
    if (e.pointerType !== "mouse") return;
    if (Date.now() - lastTouch < TOUCH_ECHO_MS) return;
    if (fine) return;
    fine = true;
    root.classList.add(CLASS);
    remember(true);
  };

  const demote = () => {
    lastTouch = Date.now();
    if (!fine) return;
    fine = false;
    root.classList.remove(CLASS);
    remember(false);
  };

  // touchstart rather than pointerdown for the demotion: a pen also wants the
  // coarse affordances, and it is the one coarse device that never emits it —
  // so pointerdown carries the pen case and touchstart the finger, and the echo
  // guard above keeps a tap's compatibility mouse events from promoting back.
  window.addEventListener("touchstart", demote, { capture: true, passive: true });
  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") promote(e);
    else demote();
  }, true);
  window.addEventListener("pointermove", promote, { capture: true, passive: true });
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
