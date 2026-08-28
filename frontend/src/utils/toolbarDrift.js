/**
 * Holds the admin's fixed bottom chrome still while a tablet toolbar collapses.
 *
 * The sidebar column is `height: 100dvh` and the mobile bottom bar is
 * `position: fixed; bottom: 0` (frontend/css/light/layout.css), so both are
 * measured against the *dynamic* viewport. On an iPad that viewport grows by
 * the full toolbar height the moment the toolbar collapses under a scroll, and
 * the visible footer — version, user, log out, theme toggle — travels the same
 * ~90px with it. Scrolling back expands the toolbar and it travels back. The
 * chrome walks up and down the screen while the reader is only trying to reach
 * the bottom of a list.
 *
 * The fix is not to stop the *box* tracking the dynamic viewport — it must, or
 * a toolbar-tall strip of page background opens below the dark sidebar column
 * and below the bar (that gap is why `dvh` is there in the first place, see the
 * comment at `.light-layout`). What must stay put is the chrome's *content*.
 * So the box keeps filling the visible height and this module publishes how
 * much of that height is toolbar-shaped space the browser just handed back;
 * the two rules spend it as bottom padding, which pushes their content back up
 * to where it was and lets the box's own background fill what is left.
 *
 * Distinguishing "the toolbar collapsed" from "the viewport genuinely changed"
 * is the same problem the public grids solve in gridFit.js, and it gets the
 * same answer: a toolbar transition never changes the width, and never moves
 * the height by more than TOOLBAR_BAND_PX. createResizeGate is reused verbatim
 * rather than reimplemented, so the two places cannot drift apart on what
 * counts as browser furniture.
 *
 * Nothing is installed on a device whose browser has no collapsing toolbar (see
 * hasCollapsibleToolbar): the custom property stays unset and both rules fall
 * through to their `0px` default, which is exactly today's CSS. That guard is
 * what keeps a deliberate 40px window drag on a desktop — height-only and well
 * inside the band, so indistinguishable from a toolbar by measurement alone —
 * from padding the footer off the bottom of the window.
 */

import { createResizeGate, layoutViewportHeight } from './gridFit.js';

/** The custom property the CSS consumes; unset means "no drift". */
export const DRIFT_VAR = '--toolbar-drift';

/**
 * Does this browser hide chrome on scroll?
 *
 * A collapsing toolbar is a touch-browser behaviour, and `(hover: none) and
 * (pointer: coarse)` is what separates those from a desktop — including an
 * iPad with a keyboard attached, whose primary pointer is still the finger.
 * Wrong only in the safe direction: a false negative leaves the chrome behaving
 * as it does today, a false positive on a device that cannot collapse anything
 * never produces a nonzero drift because the viewport never grows.
 * @returns {boolean}
 */
export function hasCollapsibleToolbar() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/**
 * Tracks how much taller the viewport is right now than its resting height.
 *
 * The resting height is the *shortest* viewport seen since the last genuine
 * resize — i.e. the toolbar-shown height — rather than the height at startup,
 * because a page can perfectly well be entered with the toolbar already
 * collapsed (a reload mid-scroll, an in-app navigation). Taking the minimum
 * makes the reference self-correcting the first time the toolbar comes back,
 * and makes the drift non-negative by construction, so the chrome is never
 * padded *below* the visible area.
 *
 * A genuine resize — rotation, Split View, a window drag — resets the reference
 * outright: the new viewport is the new resting state, not a toolbar away from
 * the old one.
 *
 * @param {number} [width]  viewport width at construction.
 * @param {number} [height]  viewport height at construction.
 * @returns {{update: (w?: number, h?: number) => number}} update returns px.
 */
export function createDriftTracker(width = window.innerWidth, height = layoutViewportHeight()) {
  const gate = createResizeGate(width, height);
  let resting = height;
  return {
    /**
     * @param {number} [w]  viewport width now.
     * @param {number} [h]  viewport height now — the height the CSS box gets,
     *   which is `100dvh` and not `window.innerHeight`; see
     *   layoutViewportHeight.
     * @returns {number} px of extra viewport a collapsed toolbar has opened up.
     */
    update(w = window.innerWidth, h = layoutViewportHeight()) {
      if (gate.accept(w, h)) resting = h;
      else if (h < resting) resting = h;
      return Math.max(0, h - resting);
    },
  };
}

/**
 * Publish the drift on an element's style as DRIFT_VAR, for as long as the
 * admin layout is mounted.
 *
 * @param {HTMLElement} [root]  where the property lives — `:root` by default,
 *   so the sidebar and the bottom bar (different subtrees, both fixed) read one
 *   value.
 * @returns {() => void} cleanup — removes the listeners and the property.
 */
export function setupToolbarDrift(root = document.documentElement) {
  if (!root || !hasCollapsibleToolbar()) return () => {};

  const tracker = createDriftTracker();
  let frame = 0;
  let last = null;

  const publish = () => {
    frame = 0;
    const px = Math.round(tracker.update());
    // Writing an unchanged value would still invalidate style on every scroll
    // step the toolbar animates through.
    if (px === last) return;
    last = px;
    root.style.setProperty(DRIFT_VAR, `${px}px`);
  };

  // Coalesced: a toolbar transition fires a burst of resize events, and each
  // measurement appends a probe element to read `100dvh` back out of the
  // browser, which forces layout.
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(publish);
  };

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  // Safari moves the visual viewport during a toolbar transition without
  // always having fired `resize` yet; subscribing to both is what makes the
  // padding land in the same frame as the chrome it is correcting.
  const vv = window.visualViewport;
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);

  publish();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    vv?.removeEventListener('resize', schedule);
    vv?.removeEventListener('scroll', schedule);
    root.style.removeProperty(DRIFT_VAR);
  };
}
