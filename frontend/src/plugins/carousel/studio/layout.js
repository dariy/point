/**
 * Carousel Studio — the two layout facts JS also has to know.
 *
 * The studio's shape is decided in `carousel.css`: the stage runs off a height
 * budget, and the properties card sits beside it as a sticky rail at 64em+ or
 * stacks below it otherwise — a plain collapsible `.card` either way (see
 * `carousel.css`'s "Properties panel" section). Two of those numbers cannot
 * stay in the stylesheet alone — the page has to ask "rail or stacked card?"
 * before it renders (a stacked card starts collapsed, to keep a narrow first
 * screen from opening under the fold), and the zoom control has to clamp what
 * it writes into `--carousel-stage-zoom`.
 *
 * They live here rather than inline at the call site for the reason
 * `tagGestures.js` gives for `SWIPE_BREAKPOINT`: a breakpoint written twice is
 * a breakpoint that will disagree with itself.
 */

/** The admin's panel breakpoint, stated wide-side because that is the question
 *  the page asks. Mirrors `@media (min-width: 64em)` in `carousel.css`, which
 *  is the same 64em `frontend/css/light/responsive.css:4` and
 *  `frontend/css/light/editor.css:1141` already use. */
export const SHEET_BREAKPOINT = "(min-width: 64em)";

/** Where the card's expanded/collapsed choice is remembered. Read only on a
 *  wide viewport — stacked below the stage on a narrow one, it always starts
 *  collapsed, the way `PostEditPage._readDetailsPref` treats the editor's
 *  Details rail. */
export const PROPS_PREF_KEY = "point:carousel:props-open";

/** Stage zoom multiplies the CSS height budget, so 1 is "the budget" and not
 *  "1:1 with the 1350px canvas" — the readout says so in percent. */
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 4;
/** One `+`/`−` press. */
export const ZOOM_STEP = 1.25;

/** Clamp a zoom multiplier into the range the control offers; anything that is
 *  not a finite number reads as "no zoom". */
export function clampZoom(z) {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * Is this viewport wide enough for the panel to be a sticky rail rather than
 * a stacked card? True where there is no `matchMedia` to ask (a test, or
 * SSR): the rail is the layout that works without JS.
 *
 * @param {{matchMedia?: (q: string) => {matches: boolean}}} [win]
 */
export function isWideViewport(win = globalThis.window) {
  if (!win || typeof win.matchMedia !== "function") return true;
  return win.matchMedia(SHEET_BREAKPOINT).matches;
}

/**
 * The properties card's initial expanded state: the remembered choice on a
 * wide viewport, always collapsed on a narrow one. Defaults to expanded — the
 * card holds the controls the studio is for, so a first visit should see them.
 *
 * @param {{matchMedia?: (q: string) => {matches: boolean}}} [win]
 * @param {{getItem: (k: string) => string|null}} [store]
 */
export function readPropsPref(win = globalThis.window, store = globalThis.localStorage) {
  if (!isWideViewport(win)) return false;
  let pref = null;
  try {
    pref = store?.getItem(PROPS_PREF_KEY) ?? null;
  } catch {
    /* private mode / storage disabled — take the default */
  }
  return pref !== "0";
}
