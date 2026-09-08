/**
 * Carousel Studio — pure geometry.
 *
 * No DOM, no canvas, no network: every function here takes numbers (or a
 * `measureText`-shaped callback) and returns plain objects, so the whole module
 * runs under `node:test` where linkedom has no canvas. The draw layer that
 * lands in a later bead (`render.js`) is a thin shim over these results — see
 * `docs/features/carousel-studio.md`.
 *
 * Rect convention: functions that describe a `drawImage` call return the full
 * 8-tuple `{sx,sy,sw,sh, dx,dy,dw,dh}` — source rectangle in the original
 * image's pixels, destination rectangle in canvas pixels.
 */

/** Output canvas dimensions per aspect key, in pixels. */
export const ASPECTS = {
  '4:5': [1080, 1350],
  '1:1': [1080, 1080],
  '1.91:1': [1080, 566],
};

/** @typedef {keyof typeof ASPECTS} AspectKey */

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (v, fallback) => (Number.isFinite(v) ? /** @type {number} */ (v) : fallback);

/**
 * Canvas `[width, height]` for an aspect key, falling back to 4:5.
 *
 * @param {string} aspect
 * @returns {[number, number]}
 */
export function canvasSize(aspect) {
  const dims = ASPECTS[/** @type {AspectKey} */ (aspect)] || ASPECTS['4:5'];
  return [dims[0], dims[1]];
}

/**
 * @typedef {object} FitReport
 * @property {number} n slides the strategy produces
 * @property {number} scale canvas px per source px (`>1` blows the source up)
 * @property {boolean} feasible the strategy can be honoured for this source
 * @property {number} stripW source px the deck consumes horizontally
 * @property {number} stripH source px the deck consumes vertically
 * @property {number} trimmedW source px cropped off the width (both sides)
 * @property {number} trimmedH source px cropped off the height (both sides)
 * @property {number} padPx canvas px of `slide.bg` fill on the last slide (`pad` only)
 * @property {'exact'|'downscale'|'upscale'} quality resampling the deck applies
 */

/**
 * The inverse of {@link sliceRects}: given a source and a slide size, what does
 * a deck cost? Three strategies, all cutting the same full-height band:
 *
 * | strategy | n | scale | effect |
 * |---|---|---|---|
 * | `cover` | the `n` you pass | `max(n·dstW/srcW, dstH/srcH)` | centred strip of the deck aspect, resampled to fill; may up- or downscale |
 * | `exact` | `floor(srcW/dstW)` | 1 | pixel-for-pixel, trims `srcW − n·dstW` of width |
 * | `pad`   | `ceil(srcW/dstW)`  | 1 | pixel-for-pixel; the last slide's tail is flush left, the gap filled from `slide.bg` |
 *
 * `exact`/`pad` are infeasible when the source is shorter than one canvas
 * (`srcH < dstH`) or — for `exact` — narrower than one (`srcW < dstW`).
 *
 * @param {number} srcW source width in pixels
 * @param {number} srcH source height in pixels
 * @param {number} n slide count (used by `cover`; derived for `exact`/`pad`)
 * @param {string} aspect aspect key
 * @param {'cover'|'exact'|'pad'} [strategy='cover']
 * @returns {FitReport}
 */
export function fitReport(srcW, srcH, n, aspect, strategy = 'cover') {
  const [dstW, dstH] = canvasSize(aspect);
  const nExact = srcW / dstW;

  if (strategy === 'exact' || strategy === 'pad') {
    const slides =
      strategy === 'exact' ? Math.floor(nExact) : Math.max(1, Math.ceil(nExact));
    const feasible =
      srcH >= dstH &&
      slides >= 1 &&
      (strategy === 'exact' ? slides * dstW <= srcW : (slides - 1) * dstW < srcW);
    const consumedW = strategy === 'exact' ? slides * dstW : srcW;
    return {
      n: Math.max(0, slides),
      scale: 1,
      feasible,
      stripW: consumedW,
      stripH: dstH,
      trimmedW: Math.max(0, srcW - consumedW),
      trimmedH: Math.max(0, srcH - dstH),
      padPx: strategy === 'pad' ? Math.max(0, slides * dstW - srcW) : 0,
      quality: 'exact',
    };
  }

  const count = Math.max(1, Math.floor(n));
  const scale = Math.max((count * dstW) / srcW, dstH / srcH);
  const stripW = (count * dstW) / scale;
  const stripH = dstH / scale;
  let quality = 'exact';
  if (scale > 1 + 1e-9) quality = 'upscale';
  else if (scale < 1 - 1e-9) quality = 'downscale';
  return {
    n: count,
    scale,
    feasible: true,
    stripW,
    stripH,
    trimmedW: Math.max(0, srcW - stripW),
    trimmedH: Math.max(0, srcH - stripH),
    padPx: 0,
    quality: /** @type {'exact'|'downscale'|'upscale'} */ (quality),
  };
}

/**
 * The CSS `background-size`/`background-position` (each an `[x, y]` percent
 * pair) that reproduces {@link sliceRects}' crop for one box spanning `span`
 * slide-widths, `offset` slide-widths into the deck — `span=1, offset=i` for
 * filmstrip frame `i`, `span=n, offset=0` for the whole stage.
 *
 * Percentages only: the box's actual rendered pixel size never enters the
 * arithmetic, so the result holds at any CSS size as long as the box's aspect
 * ratio is locked to `canvasSize(aspect)[0]*span : canvasSize(aspect)[1]` —
 * every caller sets that via an inline `aspect-ratio`. This is what lets a
 * single formula stand in for `cover`'s resample, `exact`'s centred trim and
 * `pad`'s flush-left tail: `fitReport` already resolved the strategy into a
 * scale plus a trimmed width/height, centred for `cover`/`exact` and
 * left-aligned for `pad`; here that trim (and `anchorY`, vertically) become
 * an offset into the same scaled image every slide's box shares.
 *
 * @param {number} srcW @param {number} srcH @param {string} aspect
 * @param {number} n slide count @param {'cover'|'exact'|'pad'} strategy
 * @param {number} anchorY 0..1 vertical placement of the crop band in its slack
 * @param {number} span how many slide-widths the box spans (1 or `n`)
 * @param {number} offset how many slide-widths precede this box (0..`n`-1)
 * @returns {{size: [number, number], position: [number, number]}} percent pairs
 */
export function backgroundFit(srcW, srcH, aspect, n, strategy, anchorY, span, offset) {
  const [dstW, dstH] = canvasSize(aspect);
  const { scale, trimmedW, trimmedH } = fitReport(srcW, srcH, n, aspect, strategy);
  const hAlign = strategy === 'pad' ? 0 : 0.5;

  const bgW = srcW * scale;
  const bgH = srcH * scale;
  const boxW = dstW * span;
  const boxH = dstH;

  const bgX = -(trimmedW * hAlign * scale) - offset * dstW;
  const bgY = -(trimmedH * anchorY * scale);
  const excessX = boxW - bgW;
  const excessY = boxH - bgH;

  // `0 / -excess` produces -0 (e.g. a centred strategy with no trim, offset
  // 0) — `=== 0` catches -0 too, so this normalizes it to +0 without touching
  // any other value.
  const pct = (v) => (v === 0 ? 0 : v);
  return {
    size: [pct((bgW / boxW) * 100), pct((bgH / boxH) * 100)],
    position: [
      pct(Math.abs(excessX) < 1e-6 ? 0 : (bgX / excessX) * 100),
      pct(Math.abs(excessY) < 1e-6 ? 0 : (bgY / excessY) * 100),
    ],
  };
}

/**
 * @typedef {object} SlideCountOption
 * @property {number} n
 * @property {'cover'|'exact'|'pad'} strategy
 * @property {string} label one-line chip text
 * @property {number} scale
 * @property {number} trimmedPx source px the deck throws away
 * @property {number} padPx canvas px of background fill (`pad` only)
 */

/**
 * @param {'cover'|'exact'|'pad'} strategy
 * @param {number} n
 * @param {number} scale
 * @param {number} trimmedPx
 * @param {number} padPx
 * @returns {string}
 */
function fitLabel(strategy, n, scale, trimmedPx, padPx) {
  const unit = n === 1 ? 'slide' : 'slides';
  if (strategy === 'exact') return `${n} ${unit} · pixel-exact`;
  if (strategy === 'pad') return `${n} ${unit} · ${padPx}px padding`;
  if (Math.abs(scale - 1) < 0.005) return `${n} ${unit} · full-bleed`;
  const pct = Math.round(Math.abs(scale - 1) * 100);
  return `${n} ${unit} · ${pct}% ${scale > 1 ? 'upscale' : 'downscale'}`;
}

/**
 * Rank the deck options for one source: which slide counts does it make, and at
 * what cost? One entry per stored strategy (`cover`, `exact`, `pad`), infeasible
 * ones dropped, best first — scale-1 strategies before any resample, then by
 * how much of the source is wasted. The UI adds its own "Fill" chip (`cover` at
 * `ceil(srcW/dstW)`); it is geometrically identical to `cover` and stores no
 * value, so it is not returned here.
 *
 * @param {number} srcW
 * @param {number} srcH
 * @param {string} aspect
 * @param {{min?: number, max?: number}} [opts] slide-count bounds (default 2–20)
 * @returns {SlideCountOption[]}
 */
export function slideCountOptions(srcW, srcH, aspect, opts = {}) {
  const [dstW] = canvasSize(aspect);
  const min = Math.max(1, Math.floor(opts.min ?? 2));
  const max = Math.max(min, Math.floor(opts.max ?? 20));
  const nExact = srcW / dstW;

  /** @param {'cover'|'exact'|'pad'} strategy @param {FitReport} r */
  const toChip = (strategy, r) => {
    const trimmedPx = Math.round(r.trimmedW + r.trimmedH);
    const padPx = Math.round(r.padPx);
    return {
      n: r.n,
      strategy,
      label: fitLabel(strategy, r.n, r.scale, trimmedPx, padPx),
      scale: r.scale,
      trimmedPx,
      padPx,
    };
  };

  /** @type {SlideCountOption[]} */
  const out = [];
  for (const strategy of /** @type {const} */ (['exact', 'pad'])) {
    const r = fitReport(srcW, srcH, 0, aspect, strategy);
    if (r.feasible && r.n >= min && r.n <= max) out.push(toChip(strategy, r));
  }
  const coverN = clamp(Math.max(1, Math.round(nExact)), min, max);
  out.push(toChip('cover', fitReport(srcW, srcH, coverN, aspect, 'cover')));

  const penalty = (c) =>
    c.strategy === 'cover'
      ? 1 + Math.abs(c.scale - 1)
      : (c.trimmedPx + c.padPx) / (c.n * dstW);
  return out.sort((a, b) => penalty(a) - penalty(b));
}

/**
 * Split ONE source image across `n` slides so the deck reads as a single
 * continuous picture when swiped. All three strategies cut the same full-height
 * band into columns whose edges are rounded to whole source pixels — the next
 * layer crops each column with `createImageBitmap`, whose rects must be integer,
 * and the shared edge (`x[i+1]` of one column IS `x[i]` of the next) keeps the
 * deck seamless after rounding.
 *
 * - `cover` (default, and the only behaviour of the 4-argument call): the
 *   largest strip carrying the deck aspect (`n·dstW : dstH`), centred
 *   horizontally, the vertical band placed by `anchorY` in the slack, resampled
 *   to fill each canvas. Handles non-integer division and sources narrower than
 *   `n·dstW` (the strip is upscaled; rects stay in-bounds).
 * - `exact`: `n` full canvases side by side at 1:1, centred, trimming the width
 *   remainder.
 * - `pad`: columns flush left from `x = 0`; the last one carries `dw < dstW` and
 *   a `pad: {x, w}` region the draw layer fills from `slide.bg`.
 *
 * `exact`/`pad` fall back to `cover` when the source cannot support them at
 * scale 1 (too short, or — `exact` — too narrow for `n` columns); the studio
 * only offers them via {@link slideCountOptions}, which omits infeasible ones.
 *
 * @param {number} srcW source width in pixels
 * @param {number} srcH source height in pixels
 * @param {number} n slide count (>= 1)
 * @param {string} aspect aspect key
 * @param {{strategy?: 'cover'|'exact'|'pad', anchorY?: number}} [opts]
 * @returns {Array<{sx:number,sy:number,sw:number,sh:number,dx:number,dy:number,dw:number,dh:number,pad?:{x:number,w:number}}>}
 */
export function sliceRects(srcW, srcH, n, aspect, opts) {
  const count = Math.max(1, Math.floor(n));
  const [dstW, dstH] = canvasSize(aspect);
  const { strategy: wanted = 'cover', anchorY: rawAnchorY = 0.5 } = opts || {};
  const anchorY = clamp(rawAnchorY, 0, 1);

  let strategy = wanted;
  if (strategy === 'exact' && (srcH < dstH || count * dstW > srcW)) strategy = 'cover';
  if (strategy === 'pad' && (srcH < dstH || (count - 1) * dstW >= srcW)) strategy = 'cover';

  if (strategy === 'exact' || strategy === 'pad') {
    // scale 1: the band is exactly one canvas tall, placed by anchorY.
    const sy = Math.min(Math.round((srcH - dstH) * anchorY), Math.floor(srcH - dstH));
    const rects = [];
    const stripX =
      strategy === 'exact' ? Math.round((srcW - count * dstW) / 2) : 0;
    for (let i = 0; i < count; i++) {
      const x0 = stripX + i * dstW;
      const x1 = strategy === 'exact' ? x0 + dstW : Math.min(srcW, x0 + dstW);
      const sw = x1 - x0;
      /** @type {any} */
      const rect = { sx: x0, sy, sw, sh: dstH, dx: 0, dy: 0, dw: sw, dh: dstH };
      if (sw < dstW) rect.pad = { x: sw, w: dstW - sw };
      rects.push(rect);
    }
    return rects;
  }

  // cover
  const stripAspect = (count * dstW) / dstH;
  const srcAspect = srcW / srcH;
  let stripW;
  let stripH;
  if (srcAspect > stripAspect) {
    // Source is wider than the strip — full height, crop the sides.
    stripH = srcH;
    stripW = srcH * stripAspect;
  } else {
    // Source is taller than the strip — full width, crop top and bottom.
    stripW = srcW;
    stripH = srcW / stripAspect;
  }
  const stripX = (srcW - stripW) / 2;
  const stripY = (srcH - stripH) * anchorY;
  const sy = clamp(Math.round(stripY), 0, Math.max(0, Math.floor(srcH - stripH)));
  const sh = Math.min(Math.round(stripH), Math.round(srcH) - sy);

  const rects = [];
  // Every column edge is derived from the same rounded strip, so column i starts
  // exactly where column i-1 ended — no seam even when division is non-integer.
  let prevX = Math.round(stripX);
  for (let i = 0; i < count; i++) {
    const nextX = Math.round(stripX + (stripW * (i + 1)) / count);
    rects.push({
      sx: prevX,
      sy,
      sw: nextX - prevX,
      sh,
      dx: 0,
      dy: 0,
      dw: dstW,
      dh: dstH,
    });
    prevX = nextX;
  }
  return rects;
}

/**
 * @typedef {{x:number, y:number, w:number, h:number}} CropRect normalized 0..1, relative to the source
 */

/** Sanitize a possibly-absent, possibly-garbage crop into the full frame. */
function safeCrop(crop) {
  const c = crop && typeof crop === 'object' ? crop : {};
  return { x: num(c.x, 0), y: num(c.y, 0), w: num(c.w, 1), h: num(c.h, 1) };
}

/**
 * Resolve a normalized crop into the whole-pixel source region a deck slide
 * shows, and the whole-pixel frame region it covers.
 *
 * Shared by {@link deckSlideRects} and {@link deckSlideFitCSS} so the canvas
 * render and the CSS preview cannot drift: both read the same rounded numbers
 * rather than each rounding a formula of their own.
 *
 * @param {number} srcW @param {number} srcH @param {string} aspect
 * @param {CropRect} crop @param {'cover'|'contain'} fit
 * @returns {{ok:boolean, dstW:number, dstH:number, sx:number, sy:number, sw:number,
 *   sh:number, dx:number, dy:number, dw:number, dh:number}}
 */
function deckSlideFrame(srcW, srcH, aspect, crop, fit) {
  const [dstW, dstH] = canvasSize(aspect);
  const w0 = Number.isFinite(srcW) ? Math.floor(srcW) : 0;
  const h0 = Number.isFinite(srcH) ? Math.floor(srcH) : 0;
  if (w0 < 1 || h0 < 1) {
    return { ok: false, dstW, dstH, sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: 0, dh: 0 };
  }

  // clampPan already pins the crop to at least one source pixel and inside the
  // image, which is what makes a zero-width crop harmless here.
  const c = clampPan(safeCrop(crop), w0, h0);
  const x0 = clamp(Math.round(c.x * w0), 0, w0 - 1);
  const y0 = clamp(Math.round(c.y * h0), 0, h0 - 1);
  const cw = clamp(Math.round(c.w * w0), 1, w0 - x0);
  const ch = clamp(Math.round(c.h * h0), 1, h0 - y0);

  const cropAspect = cw / ch;
  const frameAspect = dstW / dstH;

  if (fit === 'contain') {
    // The whole crop is shown; the frame gives up the axis it has to spare.
    let dw = dstW;
    let dh = dstH;
    if (cropAspect > frameAspect) dh = clamp(Math.round(dstW / cropAspect), 1, dstH);
    else dw = clamp(Math.round(dstH * cropAspect), 1, dstW);
    return {
      ok: true,
      dstW,
      dstH,
      sx: x0,
      sy: y0,
      sw: cw,
      sh: ch,
      dx: Math.round((dstW - dw) / 2),
      dy: Math.round((dstH - dh) / 2),
      dw,
      dh,
    };
  }

  // cover (the default, and the fallback for an unknown `fit`): the frame is
  // filled, so the crop is centre-cropped further on whichever axis is long.
  let sw = cw;
  let sh = ch;
  if (cropAspect > frameAspect) sw = clamp(Math.round(ch * frameAspect), 1, cw);
  else sh = clamp(Math.round(cw / frameAspect), 1, ch);
  return {
    ok: true,
    dstW,
    dstH,
    sx: x0 + Math.round((cw - sw) / 2),
    sy: y0 + Math.round((ch - sh) / 2),
    sw,
    sh,
    dx: 0,
    dy: 0,
    dw: dstW,
    dh: dstH,
  };
}

/**
 * One deck slide's `drawImage` rect: which region of ITS OWN source shows, and
 * where on the slide canvas it lands. The deck-mode counterpart of
 * {@link sliceRects} — same 8-tuple — but driven by a per-slide normalized
 * `crop` (what pan/zoom edits) plus a `fit`, instead of a doc-level strategy
 * every slide is a slave of. `paintSlide` (`render.js`) consumes either
 * without branching.
 *
 * - `cover`: the frame is filled. If the crop's aspect differs from the slide's
 *   it is centre-cropped further, so zooming out past the frame aspect widens
 *   what is *available* without ever letterboxing.
 * - `contain`: the whole crop is shown, centred, and `pad` reports what is left
 *   over for the background fill.
 *
 * `pad` is an **array of canvas rects**, not the split path's single `{x, w}`
 * tail gap: a contained slide is letterboxed on two opposite sides at once
 * (left+right, or top+bottom), which one rect cannot describe. It is omitted
 * entirely when the frame is fully covered. The region is derivable from
 * `dx/dy/dw/dh`, but naming it explicitly keeps the draw layer a pure
 * call-issuer that measures nothing — see {@link padRects}, which flattens both
 * shapes into the one list `paintSlide` fills.
 *
 * Source fields are whole pixels — `createImageBitmap`'s crop arguments must
 * be integers, and rounding here (rather than in the caller) is what keeps the
 * CSS preview and the render agreeing on the same pixel.
 *
 * @param {number} srcW source width in pixels
 * @param {number} srcH source height in pixels
 * @param {string} aspect aspect key
 * @param {CropRect} crop normalized crop, 0..1 relative to the source
 * @param {'cover'|'contain'} [fit='cover']
 * @returns {{sx:number,sy:number,sw:number,sh:number,dx:number,dy:number,dw:number,dh:number,pad?:Array<{x:number,y:number,w:number,h:number}>}}
 */
export function deckSlideRects(srcW, srcH, aspect, crop, fit = 'cover') {
  const f = deckSlideFrame(srcW, srcH, aspect, crop, fit);
  /** @type {any} */
  const rect = {
    sx: f.sx,
    sy: f.sy,
    sw: f.sw,
    sh: f.sh,
    dx: f.dx,
    dy: f.dy,
    dw: f.dw,
    dh: f.dh,
  };
  if (!f.ok) {
    // Nothing to draw (no source yet, or a degenerate one): the whole frame is
    // background. Clamped, not thrown — same convention as `clampPan`.
    rect.pad = [{ x: 0, y: 0, w: f.dstW, h: f.dstH }];
    return rect;
  }

  // Pillars run full height; the letterbox bars stop at the pillars, so the
  // rects never overlap and their areas sum to the true uncovered region.
  const pad = [
    { x: 0, y: 0, w: f.dx, h: f.dstH },
    { x: f.dx + f.dw, y: 0, w: f.dstW - f.dx - f.dw, h: f.dstH },
    { x: f.dx, y: 0, w: f.dw, h: f.dy },
    { x: f.dx, y: f.dy + f.dh, w: f.dw, h: f.dstH - f.dy - f.dh },
  ].filter((p) => p.w > 0 && p.h > 0);
  if (pad.length) rect.pad = pad;
  return rect;
}

/**
 * The CSS that reproduces {@link deckSlideRects} in the DOM preview — the
 * deck-mode counterpart of {@link backgroundFit}. `size`/`position` are the
 * `background-size`/`background-position` percent pairs `applyBg` in `index.js`
 * already consumes; `box` says which part of the slide frame that element
 * covers, also in percent.
 *
 * Percentages only: no rendered pixel size enters the arithmetic, so the result
 * holds at any CSS size — the caller locks the frame's `aspect-ratio` to
 * `canvasSize(aspect)` and sizes the image element from `box`. That is what
 * lets a pan/zoom gesture repaint at 60fps by writing CSS instead of
 * re-decoding a bitmap.
 *
 * **`box` is not decoration.** For `cover` it is the whole frame
 * (`0,0,100,100`) and one element does the job. For `contain` it must be
 * honoured: the background is clipped to its element, and only an element cut
 * down to the letterboxed content rect hides the parts of the source outside
 * the crop — a full-frame element would bleed them into the pad region the
 * canvas fills with `bg`. The pad is then simply the frame showing through.
 *
 * Derived from the rects {@link deckSlideRects} returns rather than from the
 * crop directly, so the two cannot round differently: `background-size` is the
 * scale that takes the source's full width to `dw` (so the `sw` region spans
 * the element), and `background-position` is the fraction of the leftover that
 * puts source pixel `sx` at the element's left edge. The axes are computed
 * independently, reproducing the same non-uniform stretch `drawImage` applies
 * when rounding leaves `sw:sh` slightly off the frame ratio.
 *
 * @param {number} srcW @param {number} srcH @param {string} aspect
 * @param {CropRect} crop normalized crop, 0..1 relative to the source
 * @param {'cover'|'contain'} [fit='cover']
 * @returns {{size: [number, number], position: [number, number],
 *   box: {x:number, y:number, w:number, h:number}}} percent pairs, plus the
 *   image element's rect as a percentage of the slide frame
 */
export function deckSlideFitCSS(srcW, srcH, aspect, crop, fit = 'cover') {
  const f = deckSlideFrame(srcW, srcH, aspect, crop, fit);
  const fullBox = { x: 0, y: 0, w: 100, h: 100 };
  // No usable source: the neutral "fills the box, centred" pair, so a preview
  // waiting on a probe shows nothing odd rather than `NaN%`.
  if (!f.ok) return { size: [100, 100], position: [50, 50], box: fullBox };

  const bgW = (Math.floor(srcW) * f.dw) / f.sw;
  const bgH = (Math.floor(srcH) * f.dh) / f.sh;
  const bgX = -(f.sx * f.dw) / f.sw;
  const bgY = -(f.sy * f.dh) / f.sh;
  const excessX = f.dw - bgW;
  const excessY = f.dh - bgH;

  // `0 / -excess` produces -0; `=== 0` catches it and normalizes to +0.
  const pct = (v) => (v === 0 ? 0 : v);
  return {
    size: [pct((bgW / f.dw) * 100), pct((bgH / f.dh) * 100)],
    position: [
      pct(Math.abs(excessX) < 1e-6 ? 0 : (bgX / excessX) * 100),
      pct(Math.abs(excessY) < 1e-6 ? 0 : (bgY / excessY) * 100),
    ],
    box:
      f.dx === 0 && f.dy === 0 && f.dw === f.dstW && f.dh === f.dstH
        ? fullBox
        : {
            x: (f.dx / f.dstW) * 100,
            y: (f.dy / f.dstH) * 100,
            w: (f.dw / f.dstW) * 100,
            h: (f.dh / f.dstH) * 100,
          },
  };
}

/**
 * The canvas rects a slide's background fill covers — the one measurement the
 * draw layer needs to paint `bg`, so `paintSlide` can stay a pure call-issuer.
 *
 * Normalizes the two `pad` shapes this module produces into one list, which is
 * what lets the draw layer fill a split tail column and a deck letterbox with
 * the same loop:
 *
 * - {@link sliceRects} reports `pad: {x, w}` — the `pad` strategy's trailing gap
 *   on the tail slide, always full height, so `y`/`h` default to the frame.
 * - {@link deckSlideRects} reports `pad: [{x, y, w, h}, …]` — a contained slide
 *   is letterboxed on two opposite sides at once, which one rect cannot say.
 *
 * Zero-area rects are dropped, so an empty result means "the frame is fully
 * covered, paint no background at all".
 *
 * @param {{pad?: {x:number,w:number,y?:number,h?:number}
 *   | Array<{x:number,y:number,w:number,h:number}>}} rect a rect from either producer
 * @param {number} dstW canvas width — the default width of a shapeless pad
 * @param {number} dstH canvas height — the default height of a full-height pad
 * @returns {Array<{x:number,y:number,w:number,h:number}>}
 */
export function padRects(rect, dstW, dstH) {
  const pad = rect && typeof rect === 'object' ? rect.pad : null;
  if (!pad) return [];
  const list = Array.isArray(pad) ? pad : [pad];
  return list
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      x: num(p.x, 0),
      y: num(p.y, 0),
      w: num(p.w, dstW),
      h: num(p.h, dstH),
    }))
    .filter((p) => p.w > 0 && p.h > 0);
}

/**
 * The two endpoints of a linear gradient's axis across a `w × h` frame, for
 * `createLinearGradient`.
 *
 * Follows the CSS `linear-gradient(<angle>)` convention exactly — `0deg` points
 * to the top, angles turn clockwise, and the line is long enough that its ends
 * sit where the corner-most stop lands (`|w·sin a| + |h·cos a|`, centred). That
 * is deliberate: the studio's live preview is a CSS gradient on a DOM element
 * and the render is a canvas gradient, and the two must agree pixel for pixel or
 * the preview lies. Rounded to whole pixels so the call sequence is assertable.
 *
 * @param {number} angleDeg CSS gradient angle in degrees; any real number (it
 *   wraps), defaulting to `180` (top → bottom) when not finite
 * @param {number} w frame width @param {number} h frame height
 * @returns {{x0:number, y0:number, x1:number, y1:number}}
 */
export function gradientLine(angleDeg, w, h) {
  const deg = ((num(angleDeg, 180) % 360) + 360) % 360;
  const rad = (deg * Math.PI) / 180;
  // Screen coordinates: y grows downward, so `to top` is -1 on y.
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2;
  const cy = h / 2;
  // `sin(π)` is not quite zero, so an axis-aligned angle can round to -0;
  // `=== 0` catches it and normalizes to +0.
  const px = (v) => {
    const r = Math.round(v);
    return r === 0 ? 0 : r;
  };
  return {
    x0: px(cx - (dx * len) / 2),
    y0: px(cy - (dy * len) / 2),
    x1: px(cx + (dx * len) / 2),
    y1: px(cy + (dy * len) / 2),
  };
}

/**
 * Fit a source into a `dstW × dstH` frame.
 *
 * - `cover`: the frame is filled; the source is centre-cropped (destination is
 *   the whole frame).
 * - `contain`: the whole source is shown; the destination is letterboxed and
 *   centred inside the frame.
 *
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @param {'cover'|'contain'} mode
 * @returns {{sx:number,sy:number,sw:number,sh:number,dx:number,dy:number,dw:number,dh:number}}
 */
export function fitRect(srcW, srcH, dstW, dstH, mode) {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;

  if (mode === 'contain') {
    let dw = dstW;
    let dh = dstH;
    if (srcAspect > dstAspect) {
      dh = dstW / srcAspect;
    } else {
      dw = dstH * srcAspect;
    }
    return {
      sx: 0,
      sy: 0,
      sw: srcW,
      sh: srcH,
      dx: (dstW - dw) / 2,
      dy: (dstH - dh) / 2,
      dw,
      dh,
    };
  }

  // cover
  let sw = srcW;
  let sh = srcH;
  if (srcAspect > dstAspect) {
    sw = srcH * dstAspect;
  } else {
    sh = srcW / dstAspect;
  }
  return {
    sx: (srcW - sw) / 2,
    sy: (srcH - sh) / 2,
    sw,
    sh,
    dx: 0,
    dy: 0,
    dw: dstW,
    dh: dstH,
  };
}

/**
 * The region of a slide canvas that Instagram's own UI (grid crop to a square,
 * page dots, action row) does not sit on top of. Content that must always be
 * visible — logos, headlines, the swipe cue — belongs inside this rect.
 *
 * Conservative: the square the feed grid crops a 4:5 post to, plus a small
 * breathing margin all round.
 *
 * @param {string} aspect
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function safeAreaRect(aspect) {
  const [w, h] = canvasSize(aspect);
  const side = 0.05 * w;
  const gridCropBand = Math.max(0, (h - w) / 2);
  const vMargin = gridCropBand + 0.04 * h;
  return {
    x: side,
    y: vMargin,
    w: w - 2 * side,
    h: h - 2 * vMargin,
  };
}

/**
 * Clamp a normalized crop rect (all fields 0..1, relative to the source) so it
 * stays fully inside the source however it was panned or zoomed. Width and
 * height are pinned to at least one source pixel and at most the whole image;
 * the origin is then clamped so `x+w <= 1` and `y+h <= 1`.
 *
 * @param {{x:number,y:number,w:number,h:number}} crop
 * @param {number} srcW
 * @param {number} srcH
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function clampPan(crop, srcW, srcH) {
  const minW = srcW > 0 ? Math.min(1, 1 / srcW) : 0;
  const minH = srcH > 0 ? Math.min(1, 1 / srcH) : 0;
  const w = clamp(crop.w, minW, 1);
  const h = clamp(crop.h, minH, 1);
  return {
    x: clamp(crop.x, 0, 1 - w),
    y: clamp(crop.y, 0, 1 - h),
    w,
    h,
  };
}

/**
 * @callback MeasureText
 * @param {string} text
 * @param {number} fontSize font size, in px, the width should be measured at
 * @returns {{width:number}} `measureText`-shaped result
 */

/**
 * Greedy word wrap. Splits on whitespace and packs as many words per line as
 * fit within `maxWidth` at `fontSize`. A single word wider than `maxWidth` is
 * left on its own line rather than dropped or broken.
 *
 * @param {string} text
 * @param {number} maxWidth
 * @param {number} fontSize
 * @param {MeasureText} measure
 * @returns {string[]} lines (empty array for blank input)
 */
export function wrapText(text, maxWidth, fontSize, measure) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  /** @type {string[]} */
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || measure(candidate, fontSize).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Largest integer font size (within `[min, max]`) at which `text`, wrapped to
 * `maxWidth`, fits inside `maxWidth × maxHeight`. `lineHeight` is a multiple of
 * the font size. Falls back to `min` when nothing fits.
 *
 * @param {{
 *   text: string,
 *   maxWidth: number,
 *   maxHeight: number,
 *   measure: MeasureText,
 *   lineHeight?: number,
 *   min?: number,
 *   max?: number,
 * }} opts
 * @returns {{fontSize:number, lines:string[]}}
 */
export function autoFitText(opts) {
  const { text, maxWidth, maxHeight, measure } = opts;
  const lineHeight = opts.lineHeight ?? 1.2;
  const min = Math.max(1, Math.floor(opts.min ?? 8));
  const max = Math.max(min, Math.floor(opts.max ?? 200));

  for (let size = max; size >= min; size--) {
    const lines = wrapText(text, maxWidth, size, measure);
    const widest = lines.reduce((m, line) => Math.max(m, measure(line, size).width), 0);
    const height = lines.length * size * lineHeight;
    if (widest <= maxWidth && height <= maxHeight) {
      return { fontSize: size, lines };
    }
  }
  return { fontSize: min, lines: wrapText(text, maxWidth, min, measure) };
}
