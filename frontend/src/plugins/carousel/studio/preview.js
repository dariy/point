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

import {
  backgroundFit,
  canvasSize,
  deckSlideFitCSS,
  layerCSS,
  spanLayerRect,
} from "../geometry.js";

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
 * The panorama stage's vertical-anchor rail: move the thumb to where the band
 * now sits in its slack, and say so in words. One custom property plus one
 * string, so the drag repaints it at the same cost as the band itself.
 *
 * The rail is markup (`anchorRail` in `panels.js`) and the stylesheet decides
 * whether it is visible; this only ever positions it.
 *
 * @param {HTMLElement|null} rail
 * @param {number} anchorY 0..1
 */
export function paintAnchorRail(rail, anchorY) {
  if (!rail) return;
  const pct = Math.min(100, Math.max(0, anchorY * 100));
  rail.style.setProperty("--carousel-anchor-pos", `${pct}%`);
  const out = rail.querySelector(".carousel-studio__anchor-readout");
  if (out) out.textContent = `${Math.round(pct)}%`;
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

/** Flex mapping for a text layer's horizontal / vertical alignment. */
const FLEX_ALIGN = { left: "flex-start", center: "center", right: "flex-end" };
const FLEX_VALIGN = { top: "flex-start", middle: "center", bottom: "flex-end" };

/** `{i}` → 1-based slide number, `{n}` → deck length; the twin of `counterText`
 *  in `render.js`, kept here so this module never imports the canvas layer. */
function counterFormat(format, index, count) {
  const f = typeof format === "string" ? format : "";
  return f.replace(/\{i\}/g, String(index + 1)).replace(/\{n\}/g, String(count));
}

/**
 * Paint a slide's own layers as positioned DOM elements over its image — the
 * CSS twin of `render.js`'s `paintLayers`. Every `.carousel-studio__layer` the
 * markup placed inside a `[data-slice]` host is resolved through `layerCSS`, so
 * the preview cannot round a box differently from the canvas, then given the
 * type's own paint. A `data-layer` index past the end of the list (the layer
 * was deleted since the last render) hides its element rather than leaving a
 * stale mark.
 *
 * The preview is honest about position, size and wrap; it does not promise
 * pixel-parity with the canvas' text metrics and does not need to — see
 * docs/features/carousel-studio.md, S3.
 *
 * @param {{hosts: ArrayLike<HTMLElement>}} els  the slide's `[data-slice]`
 *   elements: the stage slice and the filmstrip frame
 * @param {{layers: import('../document.js').CarouselLayer[]|undefined,
 *   aspect: string, index: number, count: number}} o
 */
export function paintDeckLayers({ hosts }, { layers, aspect, index, count }) {
  const list = Array.isArray(layers) ? layers : [];
  const [w, h] = canvasSize(aspect);
  // A layer `size` is a fraction of canvas height; the frame is a `cqw` query
  // container (carousel.css), and the frame's own aspect is the canvas', so one
  // unit of canvas height is `(h / w) · 100` cqw of the frame.
  const heightCqw = w > 0 ? (h / w) * 100 : 100;

  Array.from(hosts).forEach((host) => {
    const nodes = /** @type {NodeListOf<HTMLElement>} */ (
      host.querySelectorAll(".carousel-studio__layer")
    );
    Array.from(nodes).forEach((el) => {
      const layer = list[Number(el.dataset.layer)];
      if (!layer) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      const box = layerCSS(layer, aspect);
      el.style.left = `${box.x}%`;
      el.style.top = `${box.y}%`;
      el.style.width = `${box.w}%`;
      el.style.height = `${box.h}%`;
      paintLayerContent(el, layer, index, count, heightCqw);
    });
  });
}

/**
 * Paint the deck's spanning layers over one slide's `[data-slice]` hosts — the
 * CSS twin of `render.js`'s `paintSpanLayers`. Each `.carousel-studio__span-layer`
 * node is resolved through `spanLayerRect`: a slide-local rect that starts
 * off-frame and overflows the width where the layer crosses a seam, so the
 * host's `overflow: hidden` clips it exactly where the JPEG's frame edge will.
 * A node that resolves to `null` (the layer misses this slide) or has no layer
 * behind it (deleted since the last render) is hidden.
 *
 * @param {{hosts: ArrayLike<HTMLElement>}} els  one slide's `[data-slice]` elements
 * @param {{spanLayers: import('../document.js').CarouselLayer[]|undefined,
 *   aspect: string, index: number, count: number, selected: number|null}} o
 *   `selected` is the span-layer index the panel is editing, or `null`
 */
export function paintSpanLayers({ hosts }, { spanLayers, aspect, index, count, selected }) {
  const list = Array.isArray(spanLayers) ? spanLayers : [];
  const [w, h] = canvasSize(aspect);
  const heightCqw = w > 0 ? (h / w) * 100 : 100;

  Array.from(hosts).forEach((host) => {
    const nodes = /** @type {NodeListOf<HTMLElement>} */ (
      host.querySelectorAll(".carousel-studio__span-layer")
    );
    Array.from(nodes).forEach((el) => {
      const j = Number(el.dataset.spanLayer);
      const layer = list[j];
      const rect = layer ? spanLayerRect(layer, index, count, aspect) : null;
      if (!rect) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      el.classList.toggle("is-selected", selected === j);
      el.style.left = `${(rect.x / w) * 100}%`;
      el.style.top = `${(rect.y / h) * 100}%`;
      el.style.width = `${(rect.w / w) * 100}%`;
      el.style.height = `${(rect.h / h) * 100}%`;
      paintLayerContent(el, layer, index, count, heightCqw);
    });
  });
}

/**
 * The per-type paint for one layer element. Every property any branch below can
 * set is reset first, so a layer that changed type (delete + re-add) does not
 * inherit the previous mark's styling.
 *
 * @param {HTMLElement} el
 * @param {import('../document.js').CarouselLayer} layer
 * @param {number} index 0-based slide index (a `counter`'s `{i}`)
 * @param {number} count slides in the deck (a `counter`'s `{n}`)
 * @param {number} heightCqw one unit of canvas height in `cqw` of the frame
 */
function paintLayerContent(el, layer, index, count, heightCqw) {
  el.textContent = "";
  el.style.backgroundImage = "none";
  el.style.backgroundColor = "transparent";
  el.style.color = "";
  el.style.opacity = "";
  el.style.borderRadius = "";
  el.style.textShadow = "";
  el.style.fontWeight = "";
  el.style.fontSize = "";
  el.style.lineHeight = "";
  el.style.textAlign = "";
  el.style.justifyContent = "";
  el.style.alignItems = "";

  const cqw = (frac) => `${(frac * heightCqw).toFixed(2)}cqw`;

  if (layer.type === "text" || layer.type === "counter") {
    el.textContent =
      layer.type === "counter"
        ? counterFormat(layer.format, index, count)
        : layer.text || "";
    el.style.color = layer.color;
    el.style.fontWeight = String(layer.weight);
    el.style.lineHeight = String("lineHeight" in layer ? layer.lineHeight : 1.2);
    el.style.fontSize = cqw(layer.size == null ? 0.09 : layer.size);
    el.style.textAlign = layer.align;
    el.style.justifyContent = FLEX_ALIGN[layer.align] || "flex-start";
    el.style.alignItems = FLEX_VALIGN[layer.valign] || "flex-start";
    if (layer.shadow) el.style.textShadow = "0 0.04em 0.12em rgba(0, 0, 0, 0.55)";
  } else if (layer.type === "rect") {
    el.style.backgroundColor = layer.fill;
    el.style.opacity = String(layer.opacity);
    el.style.borderRadius = `${(layer.radius * 100).toFixed(1)}%`;
  } else if (layer.type === "image") {
    el.style.backgroundImage = layer.source ? `url("${encodeURI(layer.source)}")` : "none";
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundPosition = "center";
    el.style.backgroundSize = layer.fit === "cover" ? "cover" : "contain";
    el.style.opacity = String(layer.opacity);
  } else if (layer.type === "arrow") {
    el.textContent = layer.direction === "left" ? "❮" : "❯";
    el.style.color = layer.color;
    el.style.opacity = String(layer.opacity);
    el.style.fontSize = cqw(0.5);
    el.style.justifyContent = "center";
    el.style.alignItems = "center";
  }
}

/**
 * Write one chrome node per host: the outline box (which carries the eight
 * resize handles) at `rect`, in percent of the host, and one element per snap
 * guide, in host fractions. A `null` rect hides the chrome — that is how a
 * spanning layer's chrome disappears from a column it does not reach, without
 * the markup having to be re-emitted mid-drag.
 *
 * @param {ArrayLike<HTMLElement>} hosts
 * @param {{x:number,y:number,w:number,h:number}|null} rect
 * @param {{v:number[], h:number[]}} guides
 */
function paintChrome(hosts, rect, guides) {
  Array.from(hosts).forEach((host) => {
    const chrome = /** @type {HTMLElement|null} */ (
      host.querySelector(".carousel-studio__chrome")
    );
    if (!chrome) return;
    chrome.style.display = rect ? "" : "none";
    if (!rect) return;
    const outline = /** @type {HTMLElement|null} */ (
      chrome.querySelector(".carousel-studio__chrome-box")
    );
    if (outline) {
      outline.style.left = `${rect.x}%`;
      outline.style.top = `${rect.y}%`;
      outline.style.width = `${rect.w}%`;
      outline.style.height = `${rect.h}%`;
    }
    const snap = chrome.querySelector(".carousel-studio__snap");
    if (!snap) return;
    snap.textContent = "";
    const doc = host.ownerDocument;
    for (const x of guides.v || []) {
      const line = doc.createElement("span");
      line.className = "carousel-studio__snap-line carousel-studio__snap-line--v";
      line.style.left = `${x * 100}%`;
      snap.appendChild(line);
    }
    for (const y of guides.h || []) {
      const line = doc.createElement("span");
      line.className = "carousel-studio__snap-line carousel-studio__snap-line--h";
      line.style.top = `${y * 100}%`;
      snap.appendChild(line);
    }
  });
}

/**
 * Move the selection chrome — an outline box with eight resize handles — over
 * the selected slide layer, and draw the snap guides that engaged this frame.
 * `paintDeckLayers`'s twin for the one element that is UI, not preview: the
 * chrome node is present only while a layer is selected (panels.js), so a host
 * without one is simply skipped.
 *
 * @param {{hosts: ArrayLike<HTMLElement>}} els  the selected slide's `[data-slice]`
 *   elements
 * @param {{box: {x:number,y:number,w:number,h:number}, aspect: string,
 *   guides: {v: number[], h: number[]}}} o  `guides` in canvas fractions, empty
 *   except mid-drag
 */
export function paintLayerChrome({ hosts }, { box, aspect, guides }) {
  paintChrome(hosts, box ? layerCSS({ box }, aspect) : null, guides || { v: [], h: [] });
}

/**
 * The same chrome for a **spanning** layer, on one slide's hosts —
 * `paintLayerChrome`'s deck-space twin, and `paintSpanLayers`'s chrome twin.
 *
 * The outline is the very `spanLayerRect` slice the preview element gets, so on
 * a layer that crosses a seam the box and whichever of the eight handles falls
 * inside this slide run continuously across it and the host's `overflow:
 * hidden` does the clipping — the chrome is sliced exactly the way the thing it
 * outlines is. Guides arrive in **deck** fractions, the space the drag snapped
 * in, and are re-based into this slide's; one that lands outside the slide is
 * clipped rather than filtered, for the same reason.
 *
 * @param {{hosts: ArrayLike<HTMLElement>}} els  one slide's `[data-slice]` elements
 * @param {{layer: import('../document.js').CarouselLayer|null, aspect: string,
 *   index: number, count: number, guides: {v: number[], h: number[]}}} o
 */
export function paintSpanChrome({ hosts }, { layer, aspect, index, count, guides }) {
  const [w, h] = canvasSize(aspect);
  const n = Math.max(1, count);
  const rect = layer ? spanLayerRect(layer, index, n, aspect) : null;
  const g = guides || { v: [], h: [] };
  paintChrome(
    hosts,
    rect && {
      x: (rect.x / w) * 100,
      y: (rect.y / h) * 100,
      w: (rect.w / w) * 100,
      h: (rect.h / h) * 100,
    },
    { v: (g.v || []).map((v) => v * n - index), h: g.h || [] },
  );
}
