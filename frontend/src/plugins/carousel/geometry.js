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
 * Split ONE source image across `n` slides so the deck reads as a single
 * continuous picture when swiped. The largest strip of the source with the
 * combined deck's aspect ratio (`n·dstW : dstH`) is taken, centered, then cut
 * into `n` equal columns; each column fills a whole slide canvas.
 *
 * Handles non-integer division (columns stay gap-free and exactly tile the
 * strip) and sources narrower than `n·dstW` (the strip is simply upscaled into
 * the canvases — the returned source rects always stay inside the image).
 *
 * @param {number} srcW source width in pixels
 * @param {number} srcH source height in pixels
 * @param {number} n slide count (>= 1)
 * @param {string} aspect aspect key
 * @returns {Array<{sx:number,sy:number,sw:number,sh:number,dx:number,dy:number,dw:number,dh:number}>}
 */
export function sliceRects(srcW, srcH, n, aspect) {
  const count = Math.max(1, Math.floor(n));
  const [dstW, dstH] = canvasSize(aspect);

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
  const stripY = (srcH - stripH) / 2;

  const rects = [];
  for (let i = 0; i < count; i++) {
    // Derive each edge from the strip so rounding never opens a seam: column i
    // starts exactly where column i-1 ended.
    const x0 = stripX + (stripW * i) / count;
    const x1 = stripX + (stripW * (i + 1)) / count;
    rects.push({
      sx: x0,
      sy: stripY,
      sw: x1 - x0,
      sh: stripH,
      dx: 0,
      dy: 0,
      dw: dstW,
      dh: dstH,
    });
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
