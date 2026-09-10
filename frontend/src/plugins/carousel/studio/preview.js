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
 *
 * Type is the one thing CSS cannot be trusted to reproduce on its own, because
 * CSS has no `measureText`: left to the browser, the preview would break lines
 * where the browser likes and the JPEG would break them where `wrapText` does.
 * So the preview measures — on one memoized offscreen 2D context, in the same
 * face `render.js` resolves — and calls the very functions the renderer calls,
 * {@link autoFitText} and {@link wrapText}, with `measure` bound to it. There
 * is exactly one typesetter; this module is a second caller of it, not a second
 * copy. What remains different between the stage and the JPEG is glyph
 * rasterization, and nothing else.
 *
 * That measuring context, and the resolved font stack behind it, are the only
 * state here. Everything else still takes the elements to paint and the numbers
 * to paint them with; the caller (`index.js`) owns both, and calls
 * {@link ensurePreviewFont} once so the first paint after the web font lands
 * can be re-measured against the real face.
 */

import {
  autoFitText,
  backgroundFit,
  canvasSize,
  deckSlideFitCSS,
  layerCSS,
  layerRect,
  spanLayerRect,
  wrapText,
} from "../geometry.js";
import {
  ALIGN_ANCHOR,
  ARROW_STROKE,
  DEFAULT_FONT_STACK,
  DEFAULT_MARK_COLOR,
  MIN_AUTO_PX,
  TEXT_SHADOW,
  VALIGN_SLACK,
  counterText,
  fontSpec,
} from "../render.js";

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

const SVG_NS = "http://www.w3.org/2000/svg";

/** The resolved font stack, or `null` until {@link ensurePreviewFont} has
 *  settled. Measuring before then is measuring a system fallback, which is why
 *  the caller repaints once this lands. */
let fontStack = null;
/** The in-flight resolve, so N callers cost one `document.fonts.ready` await. */
let fontPending = null;
/** The offscreen 2D context every measurement goes through, memoized; `null`
 *  once we know this environment cannot give us one. `undefined` = not tried. */
let measureCtx;

/**
 * Bind the preview's typesetter to the page's real font, once per session:
 * await the face, then read the same `--font-family` token `browserDeps`
 * resolves for the render. Until it settles the preview measures in
 * {@link DEFAULT_FONT_STACK} — the renderer's own fallback — so a cold load
 * shows type of roughly the right size rather than nothing.
 *
 * Resolves `true` when the caller should repaint (the stack was not known when
 * it asked) and `false` when it already was, so a re-render that happens after
 * the font landed does not schedule a redundant second paint.
 *
 * @returns {Promise<boolean>} whether the caller should repaint
 */
export function ensurePreviewFont() {
  if (fontStack || typeof document === "undefined") return Promise.resolve(false);
  if (!fontPending) {
    fontPending = (async () => {
      // The face, not just the stack: `measureText` against a font that has not
      // loaded silently measures a system fallback — the same trap
      // `browserDeps.resolveFont` documents, and the same fix.
      await document.fonts?.ready;
      const stack = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-family")
        .trim();
      fontStack = stack || DEFAULT_FONT_STACK;
    })();
  }
  return fontPending.then(() => true);
}

/**
 * A `measure` callback for {@link wrapText} / {@link autoFitText}, bound to one
 * layer's weight on the shared offscreen context — the exact shape
 * `paintTextLayer` builds against the slide canvas. `null` where no 2D context
 * can be had, which is an environment that could not render the JPEG either.
 *
 * @param {number} weight
 * @returns {import('../geometry.js').MeasureText|null}
 */
function measurer(weight) {
  const ctx = measureContext();
  if (!ctx) return null;
  return (candidate, size) => {
    ctx.font = fontSpec(weight, size, fontStack || DEFAULT_FONT_STACK);
    return ctx.measureText(candidate);
  };
}

/** The shared offscreen context, or `null` where none can be had. */
function measureContext() {
  if (measureCtx === undefined) {
    const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
    // `getContext` itself can answer null — a headless DOM with no canvas.
    measureCtx = (canvas?.getContext && canvas.getContext("2d")) || null;
  }
  return measureCtx;
}

/**
 * How far to move a CSS line box so its baseline lands on the canvas baseline —
 * the one place the DOM twin cannot just restate the painter's arithmetic.
 *
 * Both media put the baseline at `lineBox/2 + k` from the top of the line, and
 * differ only in `k`. Canvas `textBaseline: 'middle'` uses the font's *central*
 * baseline, which `TextMetrics.alphabeticBaseline` reports directly; a CSS line
 * box uses half-leading, which puts it at `(ascent - descent)/2`. The two are
 * not the same number — measured in Chromium it is a ~0.06em discrepancy, which
 * at 60px type is four canvas pixels of drift between the stage and the JPEG.
 * So the difference is measured, not assumed, and applied as an offset.
 *
 * Zero where the browser reports no baseline metrics (the property is newer
 * than the rest of `TextMetrics`), which is exactly the old behaviour.
 *
 * @param {number} weight
 * @param {number} fontSize the size the block is actually set at
 * @returns {number} canvas pixels to add to the block's top
 */
function baselineShift(weight, fontSize) {
  const ctx = measureContext();
  if (!ctx) return 0;
  // The scan left whatever size it stopped on behind; the shift belongs to the
  // size the type is finally set at.
  ctx.font = fontSpec(weight, fontSize, fontStack || DEFAULT_FONT_STACK);
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText("M");
  ctx.textBaseline = "middle";
  const central = ctx.measureText("M").alphabeticBaseline;
  // Leave it as the rest of the module expects to find it.
  ctx.textBaseline = "alphabetic";
  const half = (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
  // `alphabeticBaseline` counts upwards from the anchor, so the baseline below
  // it is its negation.
  const shift = -central - half;
  return Number.isFinite(shift) ? shift : 0;
}

/**
 * Where `paintTextLayer` (`render.js`) will put this layer's type, in the box's
 * own canvas pixels — the same wrap, the same fitted size, the same vertical
 * origin. Nothing here decides line breaks: `size: null` asks
 * {@link autoFitText} and a numeric size asks {@link wrapText}, which is what
 * the renderer asks, with the same arguments.
 *
 * `top` is relative to the **box's top edge** rather than the canvas, because
 * the DOM twin positions inside the layer element; it can be negative, exactly
 * as the painter's `slack` can, when a fixed size overflows its box.
 *
 * @param {{text: string,
 *   layer: {size?: number|null, lineHeight?: number, valign?: string, align?: string},
 *   box: {x:number,y:number,w:number,h:number}, frameH: number,
 *   measure: import('../geometry.js').MeasureText}} o  `layer` is read for its
 *   four typographic fields only, so a `counter` (which carries no
 *   `lineHeight`) is the same argument as a `text`
 * @returns {{fontSize:number, lines:string[], lineBox:number, top:number,
 *   align:'left'|'center'|'right'}|null} `null` for nothing to set
 */
export function textPlan({ text, layer, box, frameH, measure }) {
  const body = typeof text === "string" ? text : "";
  if (!body.trim()) return null;
  const lineHeight = layer.lineHeight > 0 ? layer.lineHeight : 1.2;

  let fontSize;
  /** @type {string[]} */
  let lines;
  if (layer.size == null) {
    const max = Math.max(MIN_AUTO_PX, Math.floor(Math.min(box.h / lineHeight, box.w)));
    ({ fontSize, lines } = autoFitText({
      text: body,
      maxWidth: box.w,
      maxHeight: box.h,
      measure,
      lineHeight,
      min: MIN_AUTO_PX,
      max,
    }));
  } else {
    fontSize = Math.max(1, Math.round(layer.size * frameH));
    lines = wrapText(body, box.w, fontSize, measure);
  }
  if (!lines.length) return null;

  const lineBox = fontSize * lineHeight;
  const slack = box.h - lines.length * lineBox;
  return {
    fontSize,
    lines,
    lineBox,
    top: (VALIGN_SLACK[layer.valign] || VALIGN_SLACK.top)(slack),
    align: /** @type {'left'|'center'|'right'} */ (
      ALIGN_ANCHOR[layer.align] ? layer.align : "left"
    ),
  };
}

/**
 * The chevron `paintArrowLayer` (`render.js`) will stroke, in the box's own
 * canvas pixels: three points and a width, inset by half the stroke so the
 * round cap stays inside the box. `null` for a box too small to hold its own
 * stroke — which the painter skips, so the preview skips it too.
 *
 * @param {{w:number, h:number}} box
 * @param {'left'|'right'} direction
 * @returns {{stroke:number, points:Array<[number,number]>}|null}
 */
export function arrowPlan(box, direction) {
  const stroke = Math.max(1, Math.round(Math.min(box.w, box.h) * ARROW_STROKE));
  const inset = stroke / 2;
  const x0 = inset;
  const x1 = box.w - inset;
  const y0 = inset;
  const y1 = box.h - inset;
  if (!(x1 > x0) || !(y1 > y0)) return null;
  const [tipX, tailX] = direction === "left" ? [x0, x1] : [x1, x0];
  return {
    stroke,
    points: [
      [tailX, y0],
      [tipX, (y0 + y1) / 2],
      [tailX, y1],
    ],
  };
}

/**
 * Paint a slide's own layers as positioned DOM elements over its image — the
 * CSS twin of `render.js`'s `paintLayers`. Every `.carousel-studio__layer` the
 * markup placed inside a `[data-slice]` host is resolved through `layerRect` —
 * the very rect `paintLayers` hands its painters — and written out as percent
 * of it, so the preview cannot round a box differently from the canvas. The
 * pixel rect goes on to the type paint, which needs canvas pixels to typeset
 * in. A `data-layer` index past the end of the list (the layer was deleted
 * since the last render) hides its element rather than leaving a stale mark.
 *
 * @param {{hosts: ArrayLike<HTMLElement>}} els  the slide's `[data-slice]`
 *   elements: the stage slice and the filmstrip frame
 * @param {{layers: import('../document.js').CarouselLayer[]|undefined,
 *   aspect: string, index: number, count: number}} o
 */
export function paintDeckLayers({ hosts }, { layers, aspect, index, count }) {
  const list = Array.isArray(layers) ? layers : [];
  const [w, h] = canvasSize(aspect);
  // A canvas length is a fraction of canvas height; the frame is a `cqw` query
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
      const rect = layerRect(layer, aspect);
      el.style.left = `${(rect.x / w) * 100}%`;
      el.style.top = `${(rect.y / h) * 100}%`;
      el.style.width = `${(rect.w / w) * 100}%`;
      el.style.height = `${(rect.h / h) * 100}%`;
      paintLayerContent(el, layer, { index, count, rect, frameH: h, heightCqw });
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
      paintLayerContent(el, layer, { index, count, rect, frameH: h, heightCqw });
    });
  });
}

/**
 * The per-type paint for one layer element. Every property any branch below can
 * set is reset first, so a layer that changed type (delete + re-add) does not
 * inherit the previous mark's styling; `textContent = ""` drops whatever child
 * the type paint appended with it.
 *
 * @param {HTMLElement} el
 * @param {import('../document.js').CarouselLayer} layer
 * @param {{index: number, count: number, frameH: number, heightCqw: number,
 *   rect: {x:number,y:number,w:number,h:number}}} env  the slide's place in the
 *   deck (a `counter`'s `{i}` / `{n}`), the canvas height a numeric type size
 *   is a fraction of, one unit of canvas height in `cqw` of the frame, and this
 *   layer's box in canvas pixels
 */
function paintLayerContent(el, layer, env) {
  el.textContent = "";
  el.style.backgroundImage = "none";
  el.style.backgroundColor = "transparent";
  el.style.color = "";
  el.style.opacity = "";
  el.style.borderRadius = "";

  if (layer.type === "text" || layer.type === "counter") {
    paintTextContent(el, layer, env);
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
    paintArrowContent(el, layer, env.rect);
  }
}

/**
 * One `text` or `counter` layer, set the way `paintTextLayer` will set it.
 *
 * The lines are {@link textPlan}'s, emitted `white-space: pre` so the browser
 * cannot re-break them, in a block whose `line-height` is the painter's own
 * `fontSize · lineHeight`. With that, both media put line `i`'s baseline at
 * `top + (i + 0.5) · lineBox + k` and differ only in `k` — half-leading's
 * `(ascent - descent)/2` for CSS, the font's central baseline for canvas
 * `textBaseline: 'middle'` — which is what {@link baselineShift} measures and
 * takes out.
 *
 * The block is *positioned*, not aligned: the flex box the stylesheet used to
 * give the layer element would centre the browser's idea of the text, and the
 * origin has to be `VALIGN_SLACK`'s — the render's.
 *
 * Horizontal placement stays `text-align` over the full box width, which is
 * exactly what `ALIGN_ANCHOR` plus the canvas `textAlign` come to.
 *
 * @param {HTMLElement} el
 * @param {import('../document.js').CarouselTextLayer
 *   | import('../document.js').CarouselCounterLayer} layer
 * @param {{index: number, count: number, frameH: number, heightCqw: number,
 *   rect: {x:number,y:number,w:number,h:number}}} env
 */
function paintTextContent(el, layer, { index, count, rect, frameH, heightCqw }) {
  const text =
    layer.type === "counter" ? counterText(layer.format, index, count) : layer.text || "";
  const measure = measurer(layer.weight);
  if (!measure) return;
  const plan = textPlan({ text, layer, box: rect, frameH, measure });
  if (!plan) return;

  const cqw = (px) => `${((px / frameH) * heightCqw).toFixed(3)}cqw`;
  const block = el.ownerDocument.createElement("span");
  block.className = "carousel-studio__layer-text";
  block.textContent = plan.lines.join("\n");
  const s = block.style;
  s.position = "absolute";
  s.left = "0";
  s.right = "0";
  s.top = cqw(plan.top + baselineShift(layer.weight, plan.fontSize));
  s.whiteSpace = "pre";
  s.overflowWrap = "normal";
  s.fontSize = cqw(plan.fontSize);
  s.lineHeight = cqw(plan.lineBox);
  s.textAlign = plan.align;
  s.fontWeight = String(layer.weight);
  s.color = layer.color || DEFAULT_MARK_COLOR;
  if (layer.shadow) {
    // Both numbers are multiples of the font size in the painter too, and a
    // CSS blur radius and a canvas `shadowBlur` are the same 2σ convention.
    s.textShadow = `0 ${TEXT_SHADOW.offsetY}em ${TEXT_SHADOW.blur}em ${TEXT_SHADOW.color}`;
  }
  el.appendChild(block);
}

/**
 * One `arrow` layer, as the SVG twin of `paintArrowLayer`'s path: the same
 * three points, the same stroke width, the same round cap and join, over a
 * `viewBox` that *is* the layer's canvas-pixel box — so the chevron is the
 * render's geometry scaled, not an approximation of it. The element's own
 * aspect is the box's (both are percentages of a frame that carries the canvas
 * aspect), so the uniform `viewBox` scale is exact.
 *
 * @param {HTMLElement} el
 * @param {import('../document.js').CarouselArrowLayer} layer
 * @param {{w:number, h:number}} rect the layer's box in canvas pixels
 */
function paintArrowContent(el, layer, rect) {
  el.style.opacity = String(layer.opacity);
  const plan = arrowPlan(rect, layer.direction);
  if (!plan) return;

  const doc = el.ownerDocument;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${rect.w} ${rect.h}`);
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.width = "100%";
  svg.style.height = "100%";
  const poly = doc.createElementNS(SVG_NS, "polyline");
  poly.setAttribute("points", plan.points.map(([x, y]) => `${x},${y}`).join(" "));
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", layer.color || DEFAULT_MARK_COLOR);
  poly.setAttribute("stroke-width", String(plan.stroke));
  poly.setAttribute("stroke-linecap", "round");
  poly.setAttribute("stroke-linejoin", "round");
  svg.appendChild(poly);
  el.appendChild(svg);
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
