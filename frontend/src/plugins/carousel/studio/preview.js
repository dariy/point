/**
 * Carousel Studio — the live preview, written as CSS.
 *
 * The studio never draws a canvas to show what it is about to render: it
 * reproduces the crop with `background-size`/`background-position` on elements
 * the markup already put there, so a pan or a zoom costs two style writes and
 * no decode. These functions are that write, and nothing else — they take the
 * elements to paint and the numbers to paint them with, hold no state, and
 * read no document. The caller (`index.js`) owns both.
 *
 * Source paths are set from JS rather than interpolated into a style
 * attribute: the `html` tag can HTML-escape a value, but not CSS-escape it, and
 * a media path with a quote in it would otherwise break out of the `url()`.
 */

import { backgroundFit, canvasSize, deckSlideFitCSS } from "../geometry.js";

/** Behind the source image on the split stage and every split filmstrip frame —
 *  visible only where the image doesn't reach (the `pad` strategy's trailing gap
 *  on its last slide), so padding reads as a deliberate block rather than a
 *  stretched or missing image. Deck frames carry the same hatch from
 *  `carousel.css`, where it shows only until there is a real fill to paint. */
const PAD_HATCH =
  "repeating-linear-gradient(45deg, var(--surface-hover) 0 6px, transparent 6px 12px)";

/**
 * Split-mode preview. The source image drives both the stage and every
 * filmstrip frame as a CSS background. Size and position reproduce the real
 * per-slide crop (`backgroundFit`, mirroring `sliceRects`) so the preview never
 * lies about what the render will produce; a hatch layer sits behind the image
 * so `pad`'s trailing gap reads as a deliberate block instead of stretched or
 * missing image.
 *
 * @param {{stage: HTMLElement|null, frames: ArrayLike<HTMLElement>}} els
 * @param {{source: string, srcW: number|null, srcH: number|null, aspect: string,
 *   anchorY: number, n: number, strategy: 'cover'|'exact'|'pad'}} o
 */
export function paintSplit({ stage, frames }, { source, srcW, srcH, aspect, anchorY, n, strategy }) {
  const bg = `url("${encodeURI(source)}"), ${PAD_HATCH}`;
  const applyBg = (el, size, position) => {
    el.style.backgroundImage = bg;
    el.style.backgroundRepeat = "no-repeat, no-repeat";
    el.style.backgroundSize = `${size[0]}% ${size[1]}%, 100% 100%`;
    el.style.backgroundPosition = `${position[0]}% ${position[1]}%, 0% 0%`;
  };

  if (srcW && srcH) {
    if (stage) {
      const fit = backgroundFit(srcW, srcH, aspect, n, strategy, anchorY, n, 0);
      applyBg(stage, fit.size, fit.position);
    }
    Array.from(frames).forEach((el, i) => {
      const fit = backgroundFit(srcW, srcH, aspect, n, strategy, anchorY, 1, i);
      applyBg(el, fit.size, fit.position);
    });
  } else {
    // Dimensions not known yet (probe in flight or failed) — no aspect
    // ratio to compute a real crop from, so fall back to CSS `cover` on
    // the stage (its declared default) and a plain stretch per frame, as
    // before. Self-corrects once the probe resolves and re-renders.
    if (stage) {
      stage.style.backgroundImage = `url("${encodeURI(source)}")`;
      stage.style.backgroundRepeat = "no-repeat";
    }
    Array.from(frames).forEach((el, i) => {
      const posX = n > 1 ? (i / (n - 1)) * 100 : 0;
      applyBg(el, [n * 100, 100], [posX, 50]);
    });
  }
}

/**
 * Write one slide's framing onto every element that shows it — the stage slice
 * and the filmstrip frame carry the same pair of layers, so both are handed in
 * together. The only place deck framing reaches the DOM: a gesture calls this
 * with a provisional slide, so the drag and the committed document are painted
 * by identical code.
 *
 * @param {{imgs: ArrayLike<HTMLElement>, bgs: ArrayLike<HTMLElement>}} els
 * @param {{slide: import('../document.js').CarouselSlide, srcW: number|null,
 *   srcH: number|null, aspect: string, hasPad: boolean}} o  `hasPad` is the
 *   caller's answer to whether this slide leaves a letterbox to fill.
 */
export function paintDeckSlide({ imgs, bgs }, { slide, srcW, srcH, aspect, hasPad }) {
  const fit = deckSlideFitCSS(srcW || 0, srcH || 0, aspect, slide.crop, slide.fit);
  const url = slide.source ? `url("${encodeURI(slide.source)}")` : "none";
  Array.from(imgs).forEach((el) => {
    el.style.backgroundImage = url;
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundSize = `${fit.size[0]}% ${fit.size[1]}%`;
    el.style.backgroundPosition = `${fit.position[0]}% ${fit.position[1]}%`;
    el.style.left = `${fit.box.x}%`;
    el.style.top = `${fit.box.y}%`;
    el.style.width = `${fit.box.w}%`;
    el.style.height = `${fit.box.h}%`;
  });
  paintDeckBg(bgs, { slide, fit, url, aspect, hasPad });
}

/**
 * The fill layer behind one slide — the CSS twin of `paintSlide`'s pad fill,
 * so the filmstrip shows the background the JPEG will really carry instead of
 * the hatch placeholder.
 *
 * - `solid` / `gradient` are literal CSS: `gradientLine` follows the
 *   `linear-gradient(<angle>)` convention precisely so the canvas and this
 *   agree on where the axis runs.
 * - `blur` (the default) is the slide's own image stretched from its content
 *   box to the whole frame, which is exactly what the canvas does — and in
 *   percentages that is the *same* `background-size`/`position` pair on a
 *   bigger element, so the numbers are simply reused. The radius is in `cqw`
 *   against the frame's inline size (`carousel.css` makes each frame a query
 *   container), which keeps it proportional to the canvas radius at any
 *   preview size without measuring anything.
 *
 * A slide with nothing to fill — no letterbox, or no usable source yet —
 * keeps the layer empty, leaving the frame's hatch to show through as the
 * "nothing to preview yet" affordance it was added for.
 *
 * @param {ArrayLike<HTMLElement>} bgs
 * @param {{slide: import('../document.js').CarouselSlide,
 *   fit: ReturnType<import('../geometry.js').deckSlideFitCSS>, url: string,
 *   aspect: string, hasPad: boolean}} o
 */
function paintDeckBg(bgs, { slide, fit, url, aspect, hasPad }) {
  const [dstW] = canvasSize(aspect);
  const bg = slide.bg;

  let image = "none";
  let color = "transparent";
  let filter = "none";
  let size = "";
  let position = "";
  if (!hasPad) {
    // Nothing to fill: either the frame is covered, or there is no source to
    // fill it from yet and the frame's hatch should show through.
  } else if (bg?.type === "solid") {
    color = bg.color;
  } else if (bg?.type === "gradient") {
    const stops = bg.stops.map((s) => `${s.color} ${s.at * 100}%`).join(", ");
    image = `linear-gradient(${bg.angle}deg, ${stops})`;
  } else {
    const radius = Math.max(1, Math.round((bg && "radius" in bg && bg.radius) || dstW * 0.05));
    image = url;
    filter = `blur(${((radius / dstW) * 100).toFixed(2)}cqw)`;
    size = `${fit.size[0]}% ${fit.size[1]}%`;
    position = `${fit.position[0]}% ${fit.position[1]}%`;
  }

  Array.from(bgs).forEach((el) => {
    el.style.backgroundImage = image;
    el.style.backgroundColor = color;
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundSize = size || "100% 100%";
    el.style.backgroundPosition = position || "0% 0%";
    el.style.filter = filter;
  });
}
