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
