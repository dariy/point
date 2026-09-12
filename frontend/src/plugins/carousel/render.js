/**
 * Carousel Studio — the draw layer.
 *
 * Two sequencers over `geometry.js` behind one facade. `renderSplit` fetches a
 * single source and asks `sliceRects` for the columns; `renderDeck` walks a
 * deck document where every slide names its own source and crop and asks
 * `deckSlideRects` for its rect. Both then do the same thing per slide: decode
 * that source rect cropped and resampled straight to the slide canvas, paint,
 * encode. `renderCarousel` dispatches on `doc.mode` so callers never branch.
 *
 * Every measurement comes from geometry; every side effect — decode, canvas
 * creation, encode, upload — goes through the injected `deps` object, so the
 * logic never touches `document` or the network directly and a test drives it
 * with a recording fake.
 *
 * Memory: one decode per slide, cropped + resized in the same
 * `createImageBitmap` call, so the decoder never holds more than a single
 * `slideW × slideH` RGBA (~5.8 MB at 4:5) regardless of source megapixels or
 * slide count — a harder bound than the 4096px strip cap it replaced. Each
 * bitmap is closed before the next slide. Trade-off: `n` JPEG decodes instead
 * of one; accepted, because it is what makes the 1:1 mapping real and lets the
 * render report per-slide progress. An `image` layer holds to the same rule: it
 * is decoded cropped and resized to its own box, and closed with the slide it
 * was painted on. See `docs/features/carousel-studio.md`.
 *
 * The typographic constants below (`MIN_AUTO_PX`, `TEXT_SHADOW`, `ARROW_STROKE`,
 * `VALIGN_SLACK`, `ALIGN_ANCHOR`, the mark colour and the font stack) are
 * exported rather than private, and so are `fontSpec` and `counterText`: this
 * module is the contract the studio's live preview has to match, and
 * `studio/preview.js` binds to these numbers instead of copying them. The
 * dependency runs one way — the preview reads the render, never the reverse.
 */

import {
  autoFitText,
  canvasSize,
  deckSlideRects,
  fitRect,
  gradientLine,
  layerRect,
  padRects,
  sliceRects,
  spanLayerRect,
  wrapText,
} from './geometry.js';
import { deleteMedia, uploadMedia } from '../../api/media.js';

/** Fixed so identical inputs encode to identical bytes → SHA256 dedup reuses
 *  the same media row and re-render is idempotent. */
const JPEG_QUALITY = 0.92;
const JPEG_TYPE = 'image/jpeg';

/**
 * The `--font-family` token's own value (`frontend/css/common/tokens.css`), for
 * when the dep cannot resolve one: a headless render, a document whose theme
 * CSS never loaded, a browser that refused the computed style. Type in the
 * built-in stack is worth more than a failed encode, and there is no bundled
 * WOFF2 to fall back to — see `docs/vendors.md` for why there never will be.
 */
export const DEFAULT_FONT_STACK =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif';

/** Floor for auto-fit, in canvas pixels: below this the type is unreadable at
 *  any size the slide is viewed, so clipping is the more honest failure. */
export const MIN_AUTO_PX = 8;

/** `shadow: true` is one opinionated preset — legibility over a photograph, not
 *  a typographic control surface. Both numbers are multiples of the font size,
 *  so the shadow survives a resize and an aspect change with the type. */
export const TEXT_SHADOW = { color: 'rgba(0, 0, 0, 0.55)', blur: 0.16, offsetY: 0.05 };

/** White, matching the schema's own default: a layer is a mark over a
 *  photograph, and dark photographs are the common case. */
export const DEFAULT_MARK_COLOR = '#ffffff';

/** Black, matching `document.js`'s `DEFAULT_BG_COLOR` — a `rect` layer with no
 *  usable fill is a scrim, and a scrim darkens. */
const DEFAULT_RECT_FILL = '#000000';

/** An arrow's stroke, as a fraction of its box's shorter side. Heavy enough to
 *  read at feed size, light enough that the chevron is still a chevron. */
export const ARROW_STROKE = 0.16;

/** Where the wrapped block sits in the slack its box leaves, per `valign`. */
export const VALIGN_SLACK = {
  top: () => 0,
  middle: (slack) => slack / 2,
  bottom: (slack) => slack,
};

/** Where the text anchor sits in the box, per `align`. The keys double as the
 *  canvas `textAlign` values, which is what keeps the offset and the alignment
 *  it pairs with from drifting apart. */
export const ALIGN_ANCHOR = {
  left: () => 0,
  center: (w) => w / 2,
  right: (w) => w,
};

/**
 * @typedef {object} SliceOpts
 * @property {number} sx source crop x, whole pixels
 * @property {number} sy source crop y
 * @property {number} sw source crop width
 * @property {number} sh source crop height
 * @property {number} resizeWidth  target width — the slide column, so the blit is 1:1
 * @property {number} resizeHeight target height
 * @property {'pixelated'|'low'|'medium'|'high'} resizeQuality
 */

/**
 * @typedef {object} RenderDeps
 * @property {(url: string) => Promise<Blob>} fetchBlob  same-origin GET of a content path
 * @property {(blob: Blob, opts: SliceOpts) => Promise<ImageBitmap>} decode  cropped + resized createImageBitmap
 * @property {(url: string) => Promise<{ w: number, h: number }>} probeSize  natural source pixel size
 * @property {(w: number, h: number) => { canvas: any, ctx: any }} makeSurface  a fresh canvas + 2D ctx
 * @property {(canvas: any, type: string, quality: number) => Promise<Blob|null>} encode  canvas.toBlob
 * @property {(file: File, meta: object) => Promise<{ id: number, path: string }>} upload
 * @property {(id: number) => Promise<any>} deleteMedia  used only to unwind a partial upload failure
 * @property {() => Promise<string>} [resolveFont]  the active theme's font
 *   stack, awaited once per render before the first layer is painted. Optional:
 *   a deps object without one paints in {@link DEFAULT_FONT_STACK}.
 */

/**
 * Browser-backed deps — the one place this module names `document`, `fetch`,
 * `Image`, `createImageBitmap` and the media API.
 *
 * @returns {RenderDeps}
 */
export function browserDeps() {
  return {
    fetchBlob: async (url) => {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`carousel source fetch failed (${res.status}): ${url}`);
      return res.blob();
    },
    decode: (blob, o) => createImageBitmap(blob, o.sx, o.sy, o.sw, o.sh, o),
    probeSize: (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error(`carousel source could not be loaded: ${url}`));
        img.src = url;
      }),
    makeSurface: (w, h) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('carousel render: 2D canvas context unavailable');
      return { canvas, ctx };
    },
    encode: (canvas, type, quality) =>
      new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
    resolveFont: async () => {
      // Await the face, not just the stack: `measureText` on a canvas whose
      // font has not loaded silently measures — and paints — a system
      // fallback, so the JPEG disagrees with the CSS preview beside it. That
      // only happens on a cold load, which is exactly the kind that ships.
      await document.fonts?.ready;
      const stack = getComputedStyle(document.documentElement)
        .getPropertyValue('--font-family')
        .trim();
      return stack || DEFAULT_FONT_STACK;
    },
    upload: (file, meta) => uploadMedia(file, meta),
    deleteMedia: (id) => deleteMedia(id),
  };
}

/**
 * The gradient `bg` describes, or `null` when it cannot make one.
 *
 * `document.normalizeBg` always writes an angle and two usable stops, so this
 * only bites a caller that hands `paintSlide` a background no document ever
 * normalized — which then falls through to the default fill rather than
 * throwing out of `addColorStop` half way through an encode.
 *
 * @param {import('./document.js').CarouselBg|null|undefined} bg
 * @returns {{angle: number, stops: Array<{at:number,color:string}>}|null}
 */
function gradientFill(bg) {
  if (!bg || bg.type !== 'gradient') return null;
  const stops = Array.isArray(bg.stops) ? bg.stops : [];
  if (stops.length < 2) return null;
  const usable = stops.every(
    (s) => s && Number.isFinite(s.at) && typeof s.color === 'string' && s.color,
  );
  return usable ? { angle: Number.isFinite(bg.angle) ? bg.angle : 180, stops } : null;
}

/**
 * The CSS font shorthand for one line of layer type.
 *
 * @param {number} weight 1..1000, as the schema clamps it
 * @param {number} size canvas pixels
 * @param {string} family the resolved stack
 */
export function fontSpec(weight, size, family) {
  return `${Math.round(weight) || 400} ${size}px ${family}`;
}

/**
 * Paint one `text` layer inside `box`: wrapped to the box, and either auto-fit
 * to it (`size: null`, the default) or set at the layer's own size.
 *
 * Measurement is the slide context's own `measureText` bound to the size being
 * tried — which is the whole reason {@link wrapText} and {@link autoFitText}
 * take a `measure` callback rather than guessing a metric from the character
 * count. Neither is reimplemented here; this function only decides which one to
 * ask and where to put the answer.
 *
 * A numeric `size` is a fraction of the canvas **height**, not a pixel count:
 * the box is normalized, so the type set against it has to survive an aspect
 * change the same way the box does.
 *
 * Everything the context is asked to remember — font, fill, alignment, shadow —
 * is set inside one `save`/`restore`, the measuring passes included, so no
 * layer can leak state into the next one.
 *
 * @param {any} ctx 2D context
 * @param {import('./document.js').CarouselTextLayer} layer a normalized layer
 * @param {{x:number,y:number,w:number,h:number}} box from {@link layerRect}
 * @param {number} frameH canvas height — what a numeric `size` is a fraction of
 * @param {string} family the resolved font stack
 */
function paintTextLayer(ctx, layer, box, frameH, family) {
  const text = typeof layer.text === 'string' ? layer.text : '';
  if (!text.trim()) return;
  const lineHeight = layer.lineHeight > 0 ? layer.lineHeight : 1.2;

  ctx.save();
  try {
    const measure = (candidate, size) => {
      ctx.font = fontSpec(layer.weight, size, family);
      return ctx.measureText(candidate);
    };

    let fontSize;
    /** @type {string[]} */
    let lines;
    if (layer.size == null) {
      // Bounded by the box on both axes before the scan starts: one line can
      // never be taller than the box, and a glyph roughly wider than the box
      // can never fit on one. Both only shorten `autoFitText`'s walk down —
      // the sizes they rule out are sizes it would have rejected anyway.
      const max = Math.max(MIN_AUTO_PX, Math.floor(Math.min(box.h / lineHeight, box.w)));
      ({ fontSize, lines } = autoFitText({
        text,
        maxWidth: box.w,
        maxHeight: box.h,
        measure,
        lineHeight,
        min: MIN_AUTO_PX,
        max,
      }));
    } else {
      fontSize = Math.max(1, Math.round(layer.size * frameH));
      lines = wrapText(text, box.w, fontSize, measure);
    }
    if (!lines.length) return;

    const lineBox = fontSize * lineHeight;
    // Negative slack — a fixed `size` too big for its box — centres or bottoms
    // the overflow rather than pinning it to the top, which is what the two
    // alignments would mean if the box did fit.
    const slack = box.h - lines.length * lineBox;
    const top = box.y + (VALIGN_SLACK[layer.valign] || VALIGN_SLACK.top)(slack);
    const x = box.x + (ALIGN_ANCHOR[layer.align] || ALIGN_ANCHOR.left)(box.w);

    ctx.font = fontSpec(layer.weight, fontSize, family);
    ctx.fillStyle = layer.color || DEFAULT_MARK_COLOR;
    ctx.textAlign = ALIGN_ANCHOR[layer.align] ? layer.align : 'left';
    // The em box centred in its line box: one term per line, and it puts the
    // block's optical centre where `valign: middle` says it is.
    ctx.textBaseline = 'middle';
    if (layer.shadow) {
      ctx.shadowColor = TEXT_SHADOW.color;
      ctx.shadowBlur = fontSize * TEXT_SHADOW.blur;
      ctx.shadowOffsetY = fontSize * TEXT_SHADOW.offsetY;
    }
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, top + (i + 0.5) * lineBox);
    }
  } finally {
    ctx.restore();
  }
}

/** A number, or `fallback` when the value cannot be one. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A layer's opacity as a canvas alpha, 0..1. The schema clamps it already; this
 * is for a caller that hands `paintSlide` a layer no document normalized, which
 * must dim the layer rather than poison the whole context with a `NaN` alpha.
 */
function alphaOf(layer) {
  return Math.min(1, Math.max(0, num(layer.opacity, 1)));
}

/**
 * Paint one `image` layer: a bitmap `deps.decode` already cropped and resized
 * to its place in the box, so this is a single blit at whole-pixel coordinates
 * and no fitting happens here.
 *
 * `placed` is what {@link loadLayerImages} resolved for this layer — absent
 * when its source could not be fetched, decoded, or fitted into a box with
 * area. A layer that could not load is skipped and the rest of the slide is
 * painted: one broken logo must never cost a whole carousel.
 *
 * @param {any} ctx 2D context
 * @param {import('./document.js').CarouselImageLayer} layer
 * @param {{bitmap: any, x: number, y: number, w: number, h: number}} [placed]
 */
function paintImageLayer(ctx, layer, placed) {
  const alpha = alphaOf(layer);
  if (!placed || !placed.bitmap || alpha <= 0) return;
  ctx.save();
  try {
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.drawImage(placed.bitmap, placed.x, placed.y, placed.w, placed.h);
  } finally {
    ctx.restore();
  }
}

/**
 * Paint one `rect` layer — the scrim a `text` layer later in the list is read
 * against, which is why paint order is list order and this composites under
 * whatever follows it rather than being drawn last.
 *
 * `radius` is a fraction of the box's shorter side (so `0.5` is a pill and the
 * corner survives a resize), converted to canvas pixels here. Below half a
 * pixel it is a square corner, and a context too old to have `roundRect` gets
 * one too: a square scrim beats a thrown render.
 *
 * @param {any} ctx 2D context
 * @param {import('./document.js').CarouselRectLayer} layer
 * @param {{x:number,y:number,w:number,h:number}} box from {@link layerRect}
 */
function paintRectLayer(ctx, layer, box) {
  const alpha = alphaOf(layer);
  if (alpha <= 0 || box.w < 1 || box.h < 1) return;
  const radius = Math.min(0.5, Math.max(0, num(layer.radius, 0))) * Math.min(box.w, box.h);

  ctx.save();
  try {
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.fillStyle = layer.fill || DEFAULT_RECT_FILL;
    if (radius >= 0.5 && typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, radius);
      ctx.fill();
    } else {
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
  } finally {
    ctx.restore();
  }
}

/**
 * A `counter` layer's format with `{i}` and `{n}` substituted. Everything else
 * in the string is literal, including a format carrying neither — the schema
 * allows that, because a fixed caption styled like a counter is a legitimate
 * thing to want.
 *
 * @param {string} format
 * @param {number} index 0-based slide index; `{i}` is `index + 1`
 * @param {number} count slides in the deck
 */
export function counterText(format, index, count) {
  const f = typeof format === 'string' ? format : '';
  return f.replace(/\{i\}/g, String(index + 1)).replace(/\{n\}/g, String(count));
}

/**
 * Paint one `arrow` layer: a stroked chevron pointing `direction`, fitted to
 * its box.
 *
 * A path rather than a glyph, because the theme font stack is whatever the
 * theme says it is and nothing guarantees it carries an arrow — a `text` layer
 * holding "→" is one missing face away from a tofu box baked into a JPEG.
 *
 * The box is the chevron's bounding box, inset by half the stroke so the round
 * cap stays inside it: the studio sizes the box and the shape follows, rather
 * than a fixed aspect the box would have to be reconciled with.
 *
 * @param {any} ctx 2D context
 * @param {import('./document.js').CarouselArrowLayer} layer
 * @param {{x:number,y:number,w:number,h:number}} box from {@link layerRect}
 */
function paintArrowLayer(ctx, layer, box) {
  const alpha = alphaOf(layer);
  if (alpha <= 0) return;
  const stroke = Math.max(1, Math.round(Math.min(box.w, box.h) * ARROW_STROKE));
  const inset = stroke / 2;
  const x0 = box.x + inset;
  const x1 = box.x + box.w - inset;
  const y0 = box.y + inset;
  const y1 = box.y + box.h - inset;
  // A box too small to hold its own stroke: skip it rather than draw a blot.
  if (!(x1 > x0) || !(y1 > y0)) return;
  const [tipX, tailX] = layer.direction === 'left' ? [x0, x1] : [x1, x0];

  ctx.save();
  try {
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.strokeStyle = layer.color || DEFAULT_MARK_COLOR;
    ctx.lineWidth = stroke;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(tailX, y0);
    ctx.lineTo(tipX, (y0 + y1) / 2);
    ctx.lineTo(tailX, y1);
    ctx.stroke();
  } finally {
    ctx.restore();
  }
}

/**
 * One painter per layer `type`, the draw-layer twin of `LAYER_BUILDERS` in
 * `document.js`: a table rather than a switch, so a type the schema knows and
 * this build cannot draw is a missing key — skipped whole — rather than a
 * half-executed branch.
 *
 * Every painter takes the same four arguments so the dispatch below stays one
 * line: the context, the layer, its already-resolved box, and the per-slide
 * environment nothing in a layer can carry on its own — the canvas height a
 * numeric type size is a fraction of, the resolved font stack, this slide's
 * position in the deck (which is what a `counter` needs and no per-slide layer
 * could know), and the images {@link loadLayerImages} decoded for this slide.
 *
 * @type {Record<string, (ctx: any, layer: any, box: {x:number,y:number,w:number,h:number}, env: any) => void>}
 */
const LAYER_PAINTERS = {
  text: (ctx, layer, box, env) => paintTextLayer(ctx, layer, box, env.frameH, env.family),

  image: (ctx, layer, box, env) => paintImageLayer(ctx, layer, env.images?.get(layer)),

  rect: (ctx, layer, box) => paintRectLayer(ctx, layer, box),

  // The same text path a `text` layer takes — same font resolution, same
  // align/valign, same auto-fit — with the format substituted for the copy.
  // Sharing the painter is what keeps a counter from drifting into a second,
  // subtly different typesetter.
  counter: (ctx, layer, box, env) =>
    paintTextLayer(
      ctx,
      { ...layer, text: counterText(layer.format, env.index, env.count) },
      box,
      env.frameH,
      env.family,
    ),

  arrow: (ctx, layer, box) => paintArrowLayer(ctx, layer, box),
};

/**
 * Dispatch one layer to its painter, rotated about its own box center when
 * `layer.box.rotate` is non-zero. The one point both {@link paintLayers} and
 * {@link paintSpanLayers} route through, so a rotated layer looks the same
 * whichever list it painted from and a painter never has to know rotation
 * exists.
 *
 * `rotate === 0` (the common case) skips `ctx.save`/`restore` entirely rather
 * than issuing a rotate by zero radians, so an unrotated layer's draw calls —
 * and the byte-identical JPEG they encode to — are untouched.
 */
function paintDispatch(ctx, layer, box, env) {
  const paint = layer && LAYER_PAINTERS[layer.type];
  if (!paint || !box) return;
  const rotate = num(layer.box?.rotate, 0);
  if (!rotate) {
    paint(ctx, layer, box, env);
    return;
  }
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  paint(ctx, layer, box, env);
  ctx.restore();
}

/**
 * Paint a slide's layers over the image, back to front — list order is meaning
 * and `normalizeLayers` (`document.js`) preserves it, so this does not sort. A
 * `rect` scrim under a headline is exactly a rect earlier in the list.
 *
 * A layer type this build does not know how to draw is not an error — the
 * schema keeps it, and a later version paints it.
 *
 * `aspect` rather than the pixel size, because {@link layerRect} is the Canvas
 * half of the layer pair and resolving a box any other way is how a filmstrip
 * starts lying about the render.
 *
 * @param {any} ctx 2D context
 * @param {import('./document.js').CarouselLayer[]|null|undefined} layers
 * @param {string} aspect the aspect key `ctx`'s canvas was sized from
 * @param {{font?: string, index?: number, count?: number,
 *   images?: Map<any, {bitmap:any,x:number,y:number,w:number,h:number}>}} [env]
 *   `font` is the resolved stack (the built-in default when empty); `index` and
 *   `count` place this slide in its deck for a `counter`; `images` holds what
 *   {@link loadLayerImages} decoded for this slide's `image` layers
 */
export function paintLayers(ctx, layers, aspect, env = {}) {
  if (!Array.isArray(layers) || !layers.length) return;
  const resolved = resolveLayerEnv(aspect, env);
  for (const layer of layers) {
    paintDispatch(ctx, layer, layerRect(layer, aspect), resolved);
  }
}

/** The per-slide environment a layer painter needs and no layer can carry on
 *  its own: the canvas height, the resolved font stack, this slide's place in
 *  the deck (for a `counter`), and the decoded `image` layer bitmaps. */
function resolveLayerEnv(aspect, env) {
  const [, frameH] = canvasSize(aspect);
  return {
    frameH,
    family: env.font || DEFAULT_FONT_STACK,
    // A direct caller that names neither reads as slide 1 of 1 rather than
    // painting "NaN/NaN" into a JPEG.
    index: Math.max(0, Math.floor(num(env.index, 0))),
    count: Math.max(1, Math.floor(num(env.count, 1))),
    images: env.images,
  };
}

/**
 * Paint the deck's spanning layers onto one slide, over its own layers — a span
 * headline or logo lockup is the deck's top-level chrome, so it composites last.
 *
 * Each entry's `box` is already this slide's slice of the deck box, from
 * {@link spanLayerRect}: slide-local canvas pixels, negative `x` and
 * width past the frame edge where the layer crosses a seam. The painters take a
 * pixel box directly (the same shape {@link layerRect} hands them), so the seam
 * is continuous because every slice was cut from one deck rect, and the canvas
 * clips the overflow for free.
 *
 * @param {any} ctx 2D context
 * @param {Array<{layer: import('./document.js').CarouselLayer,
 *   box: {x:number,y:number,w:number,h:number}}>|null|undefined} entries
 * @param {string} aspect the aspect key `ctx`'s canvas was sized from
 * @param {Parameters<typeof paintLayers>[3]} [env]
 */
export function paintSpanLayers(ctx, entries, aspect, env = {}) {
  if (!Array.isArray(entries) || !entries.length) return;
  const resolved = resolveLayerEnv(aspect, env);
  for (const { layer, box } of entries) {
    paintDispatch(ctx, layer, box, resolved);
  }
}

/**
 * The span layers that reach slide `i` of `n`, each paired with its slide-local
 * rect. `null` rects (a layer that misses this slide) are dropped. Shared by the
 * two render sequencers so a split deck and a deck deck slice span layers the
 * same way.
 *
 * @param {import('./document.js').CarouselLayer[]|null|undefined} spanLayers
 * @param {number} i slide index
 * @param {number} n slides in the deck
 * @param {string} aspect aspect key
 * @returns {Array<{layer: import('./document.js').CarouselLayer,
 *   box: {x:number,y:number,w:number,h:number}}>}
 */
function spanLayersForSlide(spanLayers, i, n, aspect) {
  if (!Array.isArray(spanLayers) || !spanLayers.length) return [];
  const out = [];
  for (const layer of spanLayers) {
    const box = spanLayerRect(layer, i, n, aspect);
    if (box) out.push({ layer, box });
  }
  return out;
}

/**
 * Paint one slide: clear the canvas, fill the background wherever the slide's
 * own pixels do not reach, then blit the decoded column 1:1 — the bitmap is
 * already cropped and scaled to `rect.dw × rect.dh` by `deps.decode`. Pure
 * call-issuer — the region comes from `geometry.padRects`, the gradient axis
 * from `geometry.gradientLine`, and nothing here measures anything — so a
 * recording fake ctx can assert the exact sequence, and the fill always
 * precedes the blit.
 *
 * The fill covers every rect `padRects` reports, which is what makes one code
 * path serve both shapes: the split path's full-height tail column, and a
 * contained deck slide letterboxed on two opposite sides at once.
 *
 * - `solid`: `bg.color`, black by default.
 * - `gradient`: one canvas gradient across the whole frame, clipped to the pad
 *   rects by the fills — so two letterbox bars read as ends of one gradient
 *   rather than two independent ones.
 * - `blur` (the default, and the fallback for anything unusable): the slide's
 *   own pixels stretched across the frame under a blur, so the gap bleeds
 *   instead of hard-edging.
 *
 * Layers are painted last, over the image, by {@link paintLayers} — a layer is
 * baked into the JPEG, never composited afterwards. A slide with none leaves
 * this function byte-for-byte where it was before layers existed: `paintLayers`
 * returns on an empty list without touching the context, so the S1/S2 render
 * paths encode exactly the bytes they always did.
 *
 * @param {any} ctx 2D context
 * @param {ImageBitmap} bitmap the decoded column, sized `rect.dw × rect.dh`
 * @param {{dx:number,dy:number,dw:number,dh:number,
 *   pad?:{x:number,w:number}|Array<{x:number,y:number,w:number,h:number}>}} rect
 *   from `sliceRects` (split) or `deckSlideRects` (deck)
 * @param {number} w canvas width
 * @param {number} h canvas height
 * @param {import('./document.js').CarouselBg|null} [bg] fill for the pad region
 * @param {import('./document.js').CarouselLayer[]} [layers] the slide's own
 *   layers, painted back to front over the image
 * @param {{aspect?: string, font?: string, index?: number, count?: number,
 *   images?: Map<any, {bitmap:any,x:number,y:number,w:number,h:number}>,
 *   spanLayers?: Array<{layer: import('./document.js').CarouselLayer,
 *     box: {x:number,y:number,w:number,h:number}}>}} [opts]
 *   `aspect` is the key `w`/`h` were sized from — layer boxes resolve against
 *   it; `font` is the stack resolved once per render by `deps.resolveFont`;
 *   `index`/`count` are this slide's place in the deck, which a `counter` layer
 *   needs and cannot know; `images` are the decoded `image` layer sources;
 *   `spanLayers` are the deck's spanning layers already sliced to this slide,
 *   painted last (over the slide's own layers)
 */
export function paintSlide(ctx, bitmap, rect, w, h, bg, layers, opts = {}) {
  ctx.clearRect(0, 0, w, h);
  const pad = padRects(rect, w, h);
  if (pad.length) {
    const fill = gradientFill(bg);
    if (bg && bg.type === 'solid') {
      ctx.fillStyle = bg.color || '#000000';
      for (const p of pad) ctx.fillRect(p.x, p.y, p.w, p.h);
    } else if (fill) {
      const line = gradientLine(fill.angle, w, h);
      const gradient = ctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1);
      for (const s of fill.stops) gradient.addColorStop(s.at, s.color);
      ctx.fillStyle = gradient;
      for (const p of pad) ctx.fillRect(p.x, p.y, p.w, p.h);
    } else {
      const radius = Math.max(1, Math.round((bg && 'radius' in bg && bg.radius) || w * 0.05));
      ctx.save();
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(bitmap, 0, 0, rect.dw, rect.dh, 0, 0, w, h);
      ctx.restore();
    }
  }
  ctx.drawImage(bitmap, rect.dx, rect.dy, rect.dw, rect.dh);
  paintSpanLayers(ctx, opts.spanLayers, opts.aspect, opts);
  paintLayers(ctx, layers, opts.aspect, opts);
}

/**
 * Decode every `image` layer on one slide, each cropped and resized to exactly
 * the place it will occupy — so the blit in {@link paintImageLayer} is 1:1, the
 * same discipline the slide's own bitmap follows, and a 24MP source dropped in
 * as a logo costs its box rather than its megapixels.
 *
 * Bytes come from the render's shared `load`, so a logo on all ten slides is
 * **one** fetch and one probe however many slides name it. The decode is not
 * shared: it is per layer, and every bitmap is closed with the slide's, which
 * is what keeps the memory bound the module header promises.
 *
 * Nothing here throws. A source that will not fetch, a decode that fails, a box
 * with no area — each drops its own layer out of the map, and
 * {@link paintImageLayer} skips what it cannot find. One broken layer must not
 * be able to fail a whole render.
 *
 * @param {import('./document.js').CarouselLayer[]|undefined} layers
 * @param {string|undefined} aspect the slide's aspect key
 * @param {((source: string) => Promise<{blob: Blob, w: number, h: number}>)|undefined} load
 * @param {RenderDeps} deps
 * @returns {Promise<Map<any, {bitmap:any,x:number,y:number,w:number,h:number}>>}
 */
async function loadLayerImages(layers, aspect, load, deps, spanEntries) {
  /** @type {Map<any, {bitmap:any,x:number,y:number,w:number,h:number}>} */
  const images = new Map();
  if (!load) return images;

  const place = async (layer, box) => {
    if (!layer || layer.type !== 'image' || !layer.source || images.has(layer)) return;
    try {
      const { blob, w, h } = await load(layer.source);
      const fit = fitRect(w, h, box.w, box.h, layer.fit === 'cover' ? 'cover' : 'contain');
      const dw = Math.round(fit.dw);
      const dh = Math.round(fit.dh);
      if (dw < 1 || dh < 1) return;
      const bitmap = await deps.decode(blob, {
        sx: Math.round(fit.sx),
        sy: Math.round(fit.sy),
        sw: Math.max(1, Math.round(fit.sw)),
        sh: Math.max(1, Math.round(fit.sh)),
        resizeWidth: dw,
        resizeHeight: dh,
        resizeQuality: 'high',
      });
      images.set(layer, {
        bitmap,
        x: box.x + Math.round(fit.dx),
        y: box.y + Math.round(fit.dy),
        w: dw,
        h: dh,
      });
    } catch {
      // Skipped, deliberately: the slide is painted without this layer.
    }
  };

  for (const layer of Array.isArray(layers) ? layers : []) {
    await place(layer, layerRect(layer, aspect));
  }
  // Span `image` layers resolve against a box already sliced to this slide, so
  // the blit lands in deck coordinates and the canvas clips whatever crosses
  // the frame edge — the same continuity the per-slide box gets for free.
  for (const { layer, box } of Array.isArray(spanEntries) ? spanEntries : []) {
    await place(layer, box);
  }
  return images;
}

/**
 * Decode one source rect, paint it, encode the slide — the shared body of both
 * sequencers, so a split slide and a deck slide are produced by literally the
 * same calls in the same order. The bitmap is decoded already cropped and
 * resized to `rect.dw × rect.dh` and closed in a `finally`, which is what keeps
 * exactly one decoded slide alive at a time no matter how many slides or how
 * many megapixels the source has. Any `image` layer bitmaps are closed in the
 * same `finally`, so the slide is still the bound.
 *
 * A `null` from `deps.encode` is a hard error — a silently dropped slide would
 * be worse.
 *
 * @param {Blob} blob the source image bytes
 * @param {{sx:number,sy:number,sw:number,sh:number,dx:number,dy:number,dw:number,dh:number,pad?:any}} rect
 *   from `sliceRects` (split) or `deckSlideRects` (deck)
 * @param {import('./document.js').CarouselBg|null|undefined} bg background fill
 *   for the pad region
 * @param {number} slideW @param {number} slideH canvas size
 * @param {RenderDeps} deps
 * @param {{aspect?: string, layers?: import('./document.js').CarouselLayer[],
 *   font?: string, index?: number, count?: number,
 *   load?: (source: string) => Promise<{blob: Blob, w: number, h: number}>,
 *   spanLayers?: Array<{layer: import('./document.js').CarouselLayer,
 *     box: {x:number,y:number,w:number,h:number}}>}} [paint]
 *   what `paintSlide` draws over the image
 * @returns {Promise<Blob>}
 */
async function encodeSlide(blob, rect, bg, slideW, slideH, deps, paint = {}) {
  const bitmap = await deps.decode(blob, {
    sx: rect.sx,
    sy: rect.sy,
    sw: rect.sw,
    sh: rect.sh,
    resizeWidth: rect.dw,
    resizeHeight: rect.dh,
    resizeQuality: 'high',
  });
  /** @type {Map<any, {bitmap:any,x:number,y:number,w:number,h:number}>} */
  let images = new Map();
  try {
    images = await loadLayerImages(
      paint.layers,
      paint.aspect,
      paint.load,
      deps,
      paint.spanLayers,
    );
    const { canvas, ctx } = deps.makeSurface(slideW, slideH);
    paintSlide(ctx, bitmap, rect, slideW, slideH, bg, paint.layers, {
      aspect: paint.aspect,
      font: paint.font,
      index: paint.index,
      count: paint.count,
      images,
      spanLayers: paint.spanLayers,
    });
    const encoded = await deps.encode(canvas, JPEG_TYPE, JPEG_QUALITY);
    if (!encoded) {
      throw new Error('carousel render: canvas.toBlob returned null (encoder failure)');
    }
    return encoded;
  } finally {
    bitmap.close?.();
    for (const placed of images.values()) placed.bitmap.close?.();
  }
}

/** The layer types the typesetter runs for — and so the only ones that make a
 *  render wait on a font. */
const TYPESET_LAYERS = ['text', 'counter'];

/**
 * Resolve the theme's font stack once per render, and only if something is
 * actually going to be typeset — a deck with no layers, or one carrying only
 * rects and arrows, must not wait on `document.fonts.ready`, and must issue
 * exactly the calls it issued before layers existed.
 *
 * The await belongs to the dep, not to the loop: `browserDeps.resolveFont`
 * waits for the face to load, and memoizing the promise here means slide 9 pays
 * nothing for what slide 1 already waited for. A dep without a `resolveFont`,
 * one that returns nothing usable, and one that throws all land on
 * {@link DEFAULT_FONT_STACK} — type in the wrong face beats a failed encode.
 *
 * @param {RenderDeps} deps
 * @returns {(layers: Array<{type?: string}|null|undefined>) => Promise<string>}
 */
function fontResolver(deps) {
  /** @type {Promise<string>|null} */
  let pending = null;
  return async (layers) => {
    if (!layers.some((l) => l && TYPESET_LAYERS.includes(l.type))) return '';
    if (!pending) {
      pending = (async () => {
        try {
          const stack = await deps.resolveFont?.();
          return (typeof stack === 'string' && stack.trim()) || DEFAULT_FONT_STACK;
        } catch {
          return DEFAULT_FONT_STACK;
        }
      })();
    }
    return pending;
  };
}

/**
 * A fetch-and-probe deduplicated per source path, shared by everything one
 * render loads: the slides' own sources and the sources of their `image`
 * layers. A deck frozen from a split names the same image on every slide, and a
 * logo layer names the same file on every slide — so without this an
 * eight-slide deck would issue eight identical GETs and eight probes, twice
 * over; with it, one of each.
 *
 * The cache holds the *compressed* blob, not a decoded bitmap — that is what
 * makes it safe to keep for the whole render. The memory bound the module
 * header promises is about decoded RGBA, and `encodeSlide` still keeps exactly
 * one slide's worth of those alive at a time.
 *
 * @param {RenderDeps} deps
 * @param {{source: string, w: number, h: number}|null} seed a size the caller
 *   already knows, skipping the probe — keyed by the path it describes, because
 *   a layer image loaded through this same cache is a different picture and
 *   must be probed on its own
 * @returns {(source: string) => Promise<{blob: Blob, w: number, h: number}>}
 */
function sourceLoader(deps, seed) {
  /** @type {Map<string, Promise<{blob: Blob, w: number, h: number}>>} */
  const cache = new Map();
  return (source) => {
    let pending = cache.get(source);
    if (!pending) {
      pending = (async () => {
        const blob = await deps.fetchBlob(source);
        const { w, h } = seed && seed.source === source ? seed : await deps.probeSize(source);
        // Geometry clamps a degenerate size to an empty frame rather than
        // throwing; here it would mean decoding a 0×0 rect, so it is fatal.
        if (!(w >= 1) || !(h >= 1)) {
          throw new Error(`carousel render: source has no pixel dimensions: ${source}`);
        }
        return { blob, w, h };
      })();
      cache.set(source, pending);
    }
    return pending;
  };
}

/**
 * The flat, doc-free spec the split path has taken since S1: one source, a
 * count, and the doc-level framing every column is a slave of.
 *
 * @typedef {object} SplitSpec
 * @property {string} source
 * @property {number} n
 * @property {string} aspect
 * @property {'cover'|'exact'|'pad'} [strategy]
 * @property {number} [anchorY]
 * @property {import('./document.js').CarouselBg|null} [bg]
 * @property {number} [srcW]
 * @property {number} [srcH]
 * @property {import('./document.js').CarouselLayer[][]} [layers]  each column's
 *   own layer list, index-aligned with the slides. Layers are not deck-only: a
 *   split deck carrying a headline is the headline use case.
 * @property {import('./document.js').CarouselLayer[]} [spanLayers]  the deck's
 *   spanning layers, sliced per column by {@link spanLayerRect} — a headline
 *   that runs across the seams of a split deck is exactly this.
 */

/**
 * Slice one source image into `n` slide JPEGs — one crop-and-resize decode per
 * slide, each painted + encoded onto its own `slideW × slideH` canvas. A `null`
 * from `deps.encode` is a hard error — a silently dropped slide would be worse.
 *
 * @param {SplitSpec} spec  `srcW`/`srcH` skip the `probeSize` call when the caller already knows them
 * @param {RenderDeps} deps
 * @param {(p: { done: number, total: number }) => void} [onProgress] fired after each slide
 * @param {Array<{id:number,path:string}|null>} [keep]  per-slide reuse: a
 *   truthy entry at index `i` means slide `i`'s inputs are unchanged since the
 *   last render (see `specHash` in document.js) — skip its decode/encode
 *   entirely and leave a `null` placeholder in its slot.
 * @returns {Promise<(Blob|null)[]>} the encoded slides, in deck order — `null`
 *   at every index `keep` reused
 */
export async function renderSplit(spec, deps, onProgress, keep) {
  const { source, aspect, strategy, anchorY } = spec;
  const bg = spec.bg ?? null;
  const count = Math.max(1, Math.floor(spec.n));
  const [slideW, slideH] = canvasSize(aspect);

  // One loader for the whole render, seeded with the caller's size for the
  // split source itself: an `image` layer names a different file, and it goes
  // through this same cache so a logo repeated across the columns is fetched
  // once rather than once per column.
  const load = sourceLoader(
    deps,
    spec.srcW >= 1 && spec.srcH >= 1 ? { source, w: spec.srcW, h: spec.srcH } : null,
  );
  const { blob, w: srcW, h: srcH } = await load(source);

  const rects = sliceRects(srcW, srcH, count, aspect, { strategy, anchorY });
  const font = fontResolver(deps);
  const slides = [];
  for (let i = 0; i < rects.length; i++) {
    if (keep && keep[i]) {
      slides.push(null);
      onProgress?.({ done: i + 1, total: rects.length });
      continue;
    }
    const layers = spec.layers?.[i] || [];
    const spanLayers = spanLayersForSlide(spec.spanLayers, i, rects.length, aspect);
    slides.push(
      await encodeSlide(blob, rects[i], bg, slideW, slideH, deps, {
        aspect,
        layers,
        spanLayers,
        font: await font(layers.concat(spanLayers.map((s) => s.layer))),
        index: i,
        count: rects.length,
        load,
      }),
    );
    onProgress?.({ done: i + 1, total: rects.length });
  }
  return slides;
}

/**
 * @typedef {object} RenderOpts
 * @property {number} [srcW] source pixel width the caller already probed
 * @property {number} [srcH] source pixel height — skips a `probeSize` call.
 *   Never a document field: the document stores no derived data.
 */

/**
 * Render a `deck` document: every slide names its own `source` and its own
 * normalized `crop`, so each one gets its rect from `deckSlideRects` instead of
 * being a slave of the doc-level strategy `renderSplit` applies.
 *
 * Sources are fetched and probed once each, however many slides share them —
 * the common case is a deck frozen from a split, where all N slides name one
 * image. `image` layers draw from the same cache, so a logo on every slide is
 * one GET too. Lazily, too: a deck whose every slide is in `keep` touches the network
 * not at all.
 *
 * Background fill is passed through to `paintSlide` as-is: a contained slide's
 * `pad` is an array of canvas rects (`deckSlideRects`) and the draw layer fills
 * every one of them, so a letterbox on two opposite sides is painted by the same
 * code as the split path's single tail column.
 *
 * @param {import('./document.js').CarouselDoc} doc a normalized deck document
 * @param {RenderDeps} deps
 * @param {(p: { done: number, total: number }) => void} [onProgress] fired after each slide
 * @param {Array<{id:number,path:string}|null>} [keep] per-slide reuse — see `renderSplit`
 * @param {RenderOpts} [opts]
 * @returns {Promise<(Blob|null)[]>} the encoded slides, in deck order — `null`
 *   at every index `keep` reused
 */
export async function renderDeck(doc, deps, onProgress, keep, opts = {}) {
  const slides = doc?.slides || [];
  const [slideW, slideH] = canvasSize(doc?.aspect);
  // A single-source deck can take the caller's dimensions; with two sources in
  // play they would be ambiguous, so every source is probed instead.
  const singleSource = slides.length > 0 && slides.every((s) => s.source === slides[0].source);
  const seed =
    singleSource && opts.srcW >= 1 && opts.srcH >= 1
      ? { source: slides[0].source, w: opts.srcW, h: opts.srcH }
      : null;
  const load = sourceLoader(deps, seed);
  const font = fontResolver(deps);

  const out = [];
  for (let i = 0; i < slides.length; i++) {
    if (keep && keep[i]) {
      out.push(null);
      onProgress?.({ done: i + 1, total: slides.length });
      continue;
    }
    const slide = slides[i];
    const { blob, w, h } = await load(slide.source);
    const rect = deckSlideRects(w, h, doc.aspect, slide.crop, slide.fit);
    const layers = slide.layers || [];
    const spanLayers = spanLayersForSlide(doc.spanLayers, i, slides.length, doc.aspect);
    out.push(
      await encodeSlide(blob, rect, slide.bg, slideW, slideH, deps, {
        aspect: doc.aspect,
        layers,
        spanLayers,
        font: await font(layers.concat(spanLayers.map((s) => s.layer))),
        index: i,
        count: slides.length,
        load,
      }),
    );
    onProgress?.({ done: i + 1, total: slides.length });
  }
  return out;
}

/**
 * Render a carousel document, whichever mode it is in — the one entry point
 * callers use, so the studio never branches on `doc.mode` itself.
 *
 * `split` is adapted into the flat spec `renderSplit` has always taken: the
 * shared source and count come from the slides, the framing from the doc-level
 * `strategy`/`anchorY`. The background comes from the **last** slide, the only
 * one `sliceRects` can leave a pad on; the layers come from every slide, since
 * unlike `crop`/`fit` they are painted in both modes.
 *
 * @param {import('./document.js').CarouselDoc} doc a normalized document
 * @param {RenderDeps} deps
 * @param {(p: { done: number, total: number }) => void} [onProgress] fired after each slide
 * @param {Array<{id:number,path:string}|null>} [keep] per-slide reuse — see `renderSplit`
 * @param {RenderOpts} [opts]
 * @returns {Promise<(Blob|null)[]>} the encoded slides, in deck order — `null`
 *   at every index `keep` reused
 */
export async function renderCarousel(doc, deps, onProgress, keep, opts = {}) {
  const slides = doc?.slides || [];
  // Nothing to draw. Guarded here rather than in the sequencers, because
  // `renderSplit` would round an empty deck up to one slide and fetch `''`.
  if (!slides.length) return [];
  if (doc.mode === 'deck') return renderDeck(doc, deps, onProgress, keep, opts);

  return renderSplit(
    {
      source: slides[0].source,
      n: slides.length,
      aspect: doc.aspect,
      strategy: doc.strategy,
      anchorY: doc.anchorY,
      bg: slides[slides.length - 1].bg,
      layers: slides.map((s) => s.layers || []),
      spanLayers: doc.spanLayers,
      srcW: opts.srcW,
      srcH: opts.srcH,
    },
    deps,
    onProgress,
    keep,
  );
}

/**
 * Render a split deck and upload each slide as a post-owned media file.
 *
 * `post_id` is set on every upload so the slides are never flagged as orphans
 * (`ListOrphanedMedia` keys on `post_id IS NULL`). Returns the uploaded media
 * rows in deck order, ready for `slides[].rendered`.
 *
 * Takes either shape: a `{ doc, postId }` document — any mode, rendered through
 * {@link renderCarousel} — or the flat split spec from S1. One front door, so
 * the upload and partial-failure unwind below are shared by both paths rather
 * than copied into a deck-shaped twin.
 *
 * @param {({ doc: import('./document.js').CarouselDoc } & RenderOpts & { postId: number })
 *   | (SplitSpec & { postId: number })} spec
 * @param {RenderDeps} deps
 * @param {(p: { done: number, total: number }) => void} [onProgress] fired after each slide
 * @param {Array<{id:number,path:string}|null>} [keep]  see `renderSplit` — a
 *   kept slide is reused verbatim and never uploaded
 * @returns {Promise<Array<{ id: number, path: string }>>}
 */
export async function renderAndUpload(spec, deps, onProgress, keep) {
  const blobs =
    'doc' in spec
      ? await renderCarousel(spec.doc, deps, onProgress, keep, spec)
      : await renderSplit(spec, deps, onProgress, keep);
  const uploaded = [];
  // Uploads made *this run* — as opposed to `keep` entries, which already
  // existed — so a failure partway through can unwind exactly those and
  // nothing else, leaving no orphaned rows behind (ListOrphanedMedia only
  // catches uploads with no post_id, and every upload here carries one).
  const uploadedThisRun = [];
  try {
    for (let i = 0; i < blobs.length; i++) {
      if (keep && keep[i]) {
        uploaded.push(keep[i]);
        continue;
      }
      const file = new File([blobs[i]], `carousel-${spec.postId}-${i + 1}.jpg`, {
        type: JPEG_TYPE,
      });
      const media = await deps.upload(file, { post_id: spec.postId });
      uploaded.push(media);
      uploadedThisRun.push(media);
    }
  } catch (err) {
    if (uploadedThisRun.length) {
      await Promise.allSettled(uploadedThisRun.map((m) => deps.deleteMedia(m.id)));
    }
    throw err;
  }
  return uploaded;
}
