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
 * render report per-slide progress. See `docs/features/carousel-studio.md`.
 */

import {
  autoFitText,
  canvasSize,
  deckSlideRects,
  gradientLine,
  layerRect,
  padRects,
  sliceRects,
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
const DEFAULT_FONT_STACK =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif';

/** Floor for auto-fit, in canvas pixels: below this the type is unreadable at
 *  any size the slide is viewed, so clipping is the more honest failure. */
const MIN_AUTO_PX = 8;

/** `shadow: true` is one opinionated preset — legibility over a photograph, not
 *  a typographic control surface. Both numbers are multiples of the font size,
 *  so the shadow survives a resize and an aspect change with the type. */
const TEXT_SHADOW = { color: 'rgba(0, 0, 0, 0.55)', blur: 0.16, offsetY: 0.05 };

/** Where the wrapped block sits in the slack its box leaves, per `valign`. */
const VALIGN_SLACK = {
  top: () => 0,
  middle: (slack) => slack / 2,
  bottom: (slack) => slack,
};

/** Where the text anchor sits in the box, per `align`. The keys double as the
 *  canvas `textAlign` values, which is what keeps the offset and the alignment
 *  it pairs with from drifting apart. */
const ALIGN_ANCHOR = {
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
function fontSpec(weight, size, family) {
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
    ctx.fillStyle = layer.color || '#ffffff';
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

/**
 * Paint a slide's layers over the image, back to front — list order is meaning
 * and `normalizeLayers` (`document.js`) preserves it, so this does not sort.
 *
 * Only `text` is drawn here; `image`, `rect`, `counter` and `arrow` are the
 * next bead and are skipped rather than half-painted. A layer type this build
 * does not know how to draw is not an error — the schema keeps it, and a later
 * version paints it.
 *
 * `aspect` rather than the pixel size, because {@link layerRect} is the Canvas
 * half of the layer pair and resolving a box any other way is how a filmstrip
 * starts lying about the render.
 *
 * @param {any} ctx 2D context
 * @param {import('./document.js').CarouselLayer[]|null|undefined} layers
 * @param {string} aspect the aspect key `ctx`'s canvas was sized from
 * @param {string} [font] the resolved font stack; the built-in default when empty
 */
export function paintLayers(ctx, layers, aspect, font) {
  if (!Array.isArray(layers) || !layers.length) return;
  const [, frameH] = canvasSize(aspect);
  const family = font || DEFAULT_FONT_STACK;
  for (const layer of layers) {
    if (!layer || layer.type !== 'text') continue;
    paintTextLayer(ctx, layer, layerRect(layer, aspect), frameH, family);
  }
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
 * @param {{aspect?: string, font?: string}} [opts] `aspect` is the key `w`/`h`
 *   were sized from — layer boxes resolve against it; `font` is the stack
 *   resolved once per render by `deps.resolveFont`
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
  paintLayers(ctx, layers, opts.aspect, opts.font);
}

/**
 * Decode one source rect, paint it, encode the slide — the shared body of both
 * sequencers, so a split slide and a deck slide are produced by literally the
 * same calls in the same order. The bitmap is decoded already cropped and
 * resized to `rect.dw × rect.dh` and closed in a `finally`, which is what keeps
 * exactly one decoded slide alive at a time no matter how many slides or how
 * many megapixels the source has.
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
 *   font?: string}} [paint] what `paintSlide` draws over the image
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
  try {
    const { canvas, ctx } = deps.makeSurface(slideW, slideH);
    paintSlide(ctx, bitmap, rect, slideW, slideH, bg, paint.layers, {
      aspect: paint.aspect,
      font: paint.font,
    });
    const encoded = await deps.encode(canvas, JPEG_TYPE, JPEG_QUALITY);
    if (!encoded) {
      throw new Error('carousel render: canvas.toBlob returned null (encoder failure)');
    }
    return encoded;
  } finally {
    bitmap.close?.();
  }
}

/**
 * Resolve the theme's font stack once per render, and only if something is
 * actually going to be typeset — a deck with no layers must not wait on
 * `document.fonts.ready`, and must issue exactly the calls it issued before
 * layers existed.
 *
 * The await belongs to the dep, not to the loop: `browserDeps.resolveFont`
 * waits for the face to load, and memoizing the promise here means slide 9 pays
 * nothing for what slide 1 already waited for. A dep without a `resolveFont`,
 * one that returns nothing usable, and one that throws all land on
 * {@link DEFAULT_FONT_STACK} — type in the wrong face beats a failed encode.
 *
 * @param {RenderDeps} deps
 * @returns {(layers: unknown[]) => Promise<string>}
 */
function fontResolver(deps) {
  /** @type {Promise<string>|null} */
  let pending = null;
  return async (layers) => {
    if (!layers.length) return '';
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

  const blob = await deps.fetchBlob(source);
  let { srcW, srcH } = spec;
  if (!srcW || !srcH) ({ w: srcW, h: srcH } = await deps.probeSize(source));

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
    slides.push(
      await encodeSlide(blob, rects[i], bg, slideW, slideH, deps, {
        aspect,
        layers,
        font: await font(layers),
      }),
    );
    onProgress?.({ done: i + 1, total: rects.length });
  }
  return slides;
}

/**
 * A fetch-and-probe deduplicated per source path. A deck frozen from a split
 * names the same image on every slide, so without this an eight-slide deck
 * would issue eight identical GETs and eight probes; with it, one of each.
 *
 * The cache holds the *compressed* blob, not a decoded bitmap — that is what
 * makes it safe to keep for the whole render. The memory bound the module
 * header promises is about decoded RGBA, and `encodeSlide` still keeps exactly
 * one of those alive at a time.
 *
 * @param {RenderDeps} deps
 * @param {{w:number,h:number}|null} seed source size the caller already knows,
 *   skipping the probe — only valid when every slide shares one source
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
        const { w, h } = seed || (await deps.probeSize(source));
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
 * image. Lazily, too: a deck whose every slide is in `keep` touches the network
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
    singleSource && opts.srcW >= 1 && opts.srcH >= 1 ? { w: opts.srcW, h: opts.srcH } : null;
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
    out.push(
      await encodeSlide(blob, rect, slide.bg, slideW, slideH, deps, {
        aspect: doc.aspect,
        layers,
        font: await font(layers),
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
