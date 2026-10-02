/**
 * deckTransition — panoramic geometry for same-deck carousel steps.
 *
 * The default (and only, today) strategy the carousel feature curates for
 * MediaViewer's `_seamlessPair()` steps (frontend/src/components/shared/MediaViewer.js).
 * Translates each slide's own <img> by up to ±its own rendered width, rather than
 * translating the whole viewport-sized `.carousel-slide` box by ±window width — so
 * two same-width deck slices sit edge-to-edge with zero gap. A clip-path on both
 * slide boxes hides the arithmetic overshoot past each image's own letterbox margin.
 *
 * Not a general strategy-pattern registry: there is exactly one deck strategy
 * today. See MediaViewer._transitionStrategy() for the admin-configurable seam
 * (general, non-deck transitions).
 */

const TOLERANCE_PX = 1;

/** The rendered image of a slide box, or null (text/audio slides never reach the
 *  deck path — carousel-block items are always type:'image', see postMedia.js). */
export function imgEl(slideEl) {
  return slideEl ? slideEl.querySelector(".immersive-bg-image") : null;
}

/**
 * Guard + geometry for a same-deck step between two slide boxes. Returns null
 * (caller falls back to the legacy full-viewport pan) when either slide has no
 * rendered image, or the two images' rendered widths differ by more than 1px.
 *
 * @param {HTMLElement} oldSlide
 * @param {HTMLElement} newSlide
 * @returns {{imgW: number, marginW: number, viewportW: number}|null}
 */
export function computeDeckGeometry(oldSlide, newSlide) {
  const imgA = imgEl(oldSlide);
  const imgB = imgEl(newSlide);
  if (!imgA || !imgB) return null;
  const wA = imgA.getBoundingClientRect().width;
  const wB = imgB.getBoundingClientRect().width;
  if (!wA || !wB || Math.abs(wA - wB) > TOLERANCE_PX) return null;
  const viewportW = window.innerWidth;
  const imgW = (wA + wB) / 2;
  const marginW = Math.max(0, (viewportW - imgW) / 2);
  return { imgW, marginW, viewportW };
}

/** Clip both slide boxes to the letterbox margin for the duration of a panoramic
 *  step — the mechanism behind "the image slides under the margin field." */
export function applyDeckClip(slideEls, marginW) {
  for (const s of slideEls) if (s) s.style.clipPath = `inset(0 ${marginW}px)`;
}

export function clearDeckClip(slideEls) {
  for (const s of slideEls) if (s) s.style.clipPath = "";
}

/** Translate a slide's inner image by `px`, independent of the slide box. */
export function setImgTranslateX(slideEl, px, { transition = "none" } = {}) {
  const img = imgEl(slideEl);
  if (!img) return;
  img.style.transition = transition;
  img.style.transform = px ? `translateX(${px}px)` : "";
}

export function clearImgTransform(slideEl) {
  const img = imgEl(slideEl);
  if (!img) return;
  img.style.transition = "";
  img.style.transform = "";
}
