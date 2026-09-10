/**
 * carousel/import/adapter.js — what every import adapter shares.
 *
 * An importer's job is to turn somebody else's file into the envelope
 * `document.js` already defines. That leaves four things which are the same
 * whichever file it is, and which are here so the PPTX and SVG adapters cannot
 * drift on them:
 *
 * - **The failure type.** {@link ImportError} — one vocabulary for "this is not
 *   a deck", so the import dialog has one thing to catch.
 * - **The canvas fit.** {@link centreFit} — Point has three aspects and a
 *   source file has whatever aspect its author chose. Fitting is *uniform and
 *   centred*, never a squash: a circle that arrives round stays round and a
 *   mismatch shows up as margin, which the report then names.
 * - **The asset budget.** {@link createAssets} — a template inlines its images
 *   as `data:` URLs, so an import has to be able to say "this deck's photos do
 *   not fit in a template" by name rather than by producing one the store
 *   rejects.
 * - **The report.** {@link createReport} — an import that silently lost half a
 *   design is worse than one that says it kept 14 of 22 shapes, and every
 *   adapter owes the same accounting.
 *
 * Pure: no DOM, no network, no canvas.
 */

import { ASPECTS } from '../document.js';
import { canvasSize } from '../geometry.js';

/**
 * A typed import failure. `code` is what a caller branches on and `part` names
 * the member of the file it belongs to when one does.
 *
 * These are *whole-import* failures. Anything that costs one slide or one
 * shape is a report entry instead — see {@link createReport}.
 *
 * @typedef {'malformed'|'unsupported'|'empty'|'too-large'} ImportErrorCode
 */
export class ImportError extends Error {
  /**
   * @param {ImportErrorCode} code
   * @param {string} message
   * @param {string} [part] member of the imported file the failure belongs to
   */
  constructor(code, message, part) {
    super(part ? `${part}: ${message}` : message);
    this.name = 'ImportError';
    /** @type {ImportErrorCode} */
    this.code = code;
    this.part = part || '';
  }
}

/**
 * How much image an import may inline.
 *
 * A template stores its assets as `data:` URLs inside one row, so these are not
 * decoration limits — they are what keeps a template storable at all. The
 * total is counted **on the encoded URLs**, not on the raw bytes, because that
 * is what the envelope actually costs and what the store's 8 MB cap
 * (`api/carousel.js` `TEMPLATE_MAX_BYTES`) measures. Base64 is 4 bytes per 3,
 * so ~5.8 MB of photographs is the real ceiling; the per-asset cap keeps one
 * hero image from spending it alone.
 */
export const ASSET_LIMITS = {
  maxAssetBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

/**
 * Image types a `data:` URL can carry into a canvas. PowerPoint also embeds
 * EMF and WMF — vector formats no browser decodes — and a template that
 * silently kept an unpaintable image would fail at render instead of at
 * import, so an extension that is not here is refused by name.
 */
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/**
 * The image MIME type for a path, or `''` when nothing here decodes it.
 *
 * @param {string} name
 * @returns {string}
 */
export function mimeForPath(name) {
  const ext = String(name || '').toLowerCase().split('.').pop() || '';
  return MIME_BY_EXT[/** @type {keyof typeof MIME_BY_EXT} */ (ext)] || '';
}

/** Base64 in 32 KB slices: one `fromCharCode` per byte would build a two
 *  million link string, and one call for the whole array overruns the argument
 *  limit on a real photograph. */
function base64(bytes) {
  const CHUNK = 0x8000;
  let out = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(out);
}

/**
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {string}
 */
export function dataUrl(bytes, mime) {
  return `data:${mime};base64,${base64(bytes)}`;
}

/** Megabytes, one decimal, for a message a person reads. */
const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/**
 * @typedef {object} ImportAssets
 * @property {(part: string, bytes: Uint8Array, slide: number|null) => string}
 *   inline the `data:` URL for an archive member, or `''` when it was refused —
 *   which is already recorded in the report, by name, with its slide
 * @property {() => {count: number, bytes: number}} totals
 */

/**
 * The asset budget, shared across every slide of one import so a logo reused
 * on eight slides is inlined — and counted — once.
 *
 * @param {ReturnType<typeof createReport>} report
 * @param {{maxAssetBytes?: number, maxTotalBytes?: number}} [limits]
 * @returns {ImportAssets}
 */
export function createAssets(report, limits = {}) {
  const maxAsset = limits.maxAssetBytes ?? ASSET_LIMITS.maxAssetBytes;
  const maxTotal = limits.maxTotalBytes ?? ASSET_LIMITS.maxTotalBytes;
  /** @type {Map<string, string>} */
  const seen = new Map();
  let bytes = 0;

  return {
    inline(part, raw, slide) {
      const already = seen.get(part);
      if (already !== undefined) return already;
      const name = part.split('/').pop() || part;
      const mime = mimeForPath(part);
      /** @param {string} why */
      const refuse = (why) => {
        report.drop(slide, `image Point cannot store: ${name} (${why})`);
        seen.set(part, '');
        return '';
      };
      if (!mime) return refuse('unsupported format');
      if (raw.byteLength > maxAsset) {
        return refuse(`${mb(raw.byteLength)}, over the ${mb(maxAsset)} per-image cap`);
      }
      const url = dataUrl(raw, mime);
      if (bytes + url.length > maxTotal) {
        return refuse(`the template's ${mb(maxTotal)} image budget is full`);
      }
      bytes += url.length;
      seen.set(part, url);
      return url;
    },
    totals: () => ({ count: [...seen.values()].filter(Boolean).length, bytes }),
  };
}

/**
 * @typedef {object} ImportFit
 * @property {string} aspect the {@link ASPECTS} key chosen
 * @property {number} fx  fraction of the target width the source occupies
 * @property {number} fy  fraction of the target height the source occupies
 * @property {(x: number, y: number, w: number, h: number) => {x:number,y:number,w:number,h:number}}
 *   box source-unit rect → a normalized layer box
 * @property {(h: number) => number} height source-unit length → fraction of the
 *   target canvas height (type sizes, in particular)
 * @property {{from: string, to: string, axis: 'x'|'y'|'', margin: number, note: string}} aspectReport
 */

/**
 * The {@link ASPECTS} key closest to a source canvas, compared in log space so
 * "how far off is it" means the same in both directions — 2:1 and 1:2 are
 * equally far from square, which a plain difference of ratios does not say.
 *
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
export function chooseAspect(w, h) {
  const src = Math.log(w / h);
  let best = ASPECTS[0];
  let bestOff = Infinity;
  for (const aspect of ASPECTS) {
    const [cw, ch] = canvasSize(aspect);
    const off = Math.abs(Math.log(cw / ch) - src);
    if (off < bestOff) {
      best = aspect;
      bestOff = off;
    }
  }
  return best;
}

/**
 * A ratio as people write one — `16:9`, `4:5` — falling back to `1.78:1` when
 * no small ratio is close enough to be honest.
 *
 * The search is over denominators rather than a `gcd` of the two numbers: the
 * inputs are EMU (914400 to the inch) or an SVG `viewBox`, so their greatest
 * common divisor is meaningless — `10287000:12858750` reduces to `4:5` only
 * after being asked for a *small* answer. The tolerance is relative, so a deck
 * that is a rounding error away from 16:9 still reads as 16:9.
 *
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
export function ratioLabel(w, h) {
  const ratio = w / h;
  for (let d = 1; d <= 40; d++) {
    const n = Math.round(ratio * d);
    if (n >= 1 && n <= 40 && Math.abs(n / d - ratio) < ratio * 0.002) return `${n}:${d}`;
  }
  return `${ratio.toFixed(2)}:1`;
}

/**
 * Map a source canvas onto one of Point's aspects: uniform scale, centred, so
 * the mismatch becomes margin instead of distortion.
 *
 * The returned `box` and `height` are the *only* way an importer should turn a
 * source coordinate into a schema one. Doing it per shape is how a deck ends
 * up with its rectangles fitted one way and its type another.
 *
 * @param {number} srcW
 * @param {number} srcH
 * @param {string} [aspect] the target, else the nearest by {@link chooseAspect}
 * @returns {ImportFit}
 */
export function centreFit(srcW, srcH, aspect = '') {
  const to = ASPECTS.includes(aspect) ? aspect : chooseAspect(srcW, srcH);
  const [cw, ch] = canvasSize(to);
  const src = srcW / srcH;
  const target = cw / ch;
  // Wider than the canvas → the width is the binding side and the margin is top
  // and bottom; narrower → the other way round.
  const wide = src > target;
  const fx = wide ? 1 : src / target;
  const fy = wide ? target / src : 1;
  const offX = (1 - fx) / 2;
  const offY = (1 - fy) / 2;

  return {
    aspect: to,
    fx,
    fy,
    box: (x, y, w, h) => ({
      x: offX + (x / srcW) * fx,
      y: offY + (y / srcH) * fy,
      w: (w / srcW) * fx,
      h: (h / srcH) * fy,
    }),
    height: (h) => (h / srcH) * fy,
    aspectReport: fitNote(ratioLabel(srcW, srcH), to, wide, wide ? offY : offX),
  };
}

/**
 * The fit in words: which aspect went into which, and how much margin that
 * left. Under half a percent is called exact — at that size it is a rounding
 * difference in somebody's export, not a design decision, and reporting "0%
 * margin" would invite a hunt for it.
 *
 * @param {string} from
 * @param {string} to
 * @param {boolean} wide source wider than the target, so the margin is vertical
 * @param {number} margin fraction of the binding side, one side of the two
 * @returns {ImportFit['aspectReport']}
 */
function fitNote(from, to, wide, margin) {
  if (margin < 0.005) return { from, to, axis: '', margin: 0, note: `${from} matches ${to}` };
  const side = wide ? 'top and bottom' : 'each side';
  return {
    from,
    to,
    axis: wide ? 'y' : 'x',
    margin,
    note: `${from} fitted into ${to} — ${Math.round(margin * 100)}% margin ${side}`,
  };
}

/**
 * @typedef {object} ImportReport
 * @property {string} format
 * @property {string} file
 * @property {number} slides slides the template ended up with
 * @property {number} sourceSlides slides the file offered
 * @property {{kept: number, total: number}} shapes
 * @property {ImportFit['aspectReport']} aspect
 * @property {string[]} fonts recorded, never applied
 * @property {{count: number, bytes: number}} assets
 * @property {Array<{slide: number|null, what: string, n: number}>} dropped
 * @property {Array<{slide: number|null, part: string, reason: string}>} failed
 * @property {string[]} warnings
 */

/**
 * The report accumulator.
 *
 * Every entry is a count or a name rather than a sentence, for the reason
 * `applyTemplate`'s report gives: the studio writes the prose, the importer
 * supplies the facts. Identical drops collapse into one entry with a count —
 * "3 groups" on slide 4, not three lines saying "group" — which is what makes
 * a 20-slide deck's report readable.
 *
 * `dropped` is deliberately the shape `normalizeDropped` accepts, so the same
 * list can be stored in the template's `origin` and survive a round trip
 * through the API: a template opened next month still says what it lost.
 *
 * @param {{format: string, file: string}} meta
 */
export function createReport(meta) {
  /** @type {Map<string, {slide: number|null, what: string, n: number}>} */
  const dropped = new Map();
  /** @type {Array<{slide: number|null, part: string, reason: string}>} */
  const failed = [];
  /** @type {Set<string>} */
  const fonts = new Set();
  /** @type {string[]} */
  const warnings = [];

  return {
    /**
     * Something the schema has no room for. `slide` is the index it happened
     * on, or `null` for the deck as a whole.
     *
     * @param {number|null} slide
     * @param {string} what
     * @param {number} [n]
     */
    drop(slide, what, n = 1) {
      const key = `${slide} ${what}`;
      const at = dropped.get(key);
      if (at) at.n += n;
      else dropped.set(key, { slide, what, n });
    },

    /**
     * A part that could not be read at all. One bad slide costs that slide,
     * not the import.
     *
     * @param {number|null} slide
     * @param {string} part
     * @param {string} reason
     */
    fail(slide, part, reason) {
      failed.push({ slide, part, reason });
    },

    /** A typeface the source named. Recorded; nothing renders it. @param {string} name */
    font(name) {
      const clean = String(name || '').trim();
      // `+mj-lt` / `+mn-lt` are references to the source theme's own fonts, not
      // typefaces. Recording them would name a font nobody has.
      if (clean && !clean.startsWith('+')) fonts.add(clean);
    },

    /** Something a person should be told in words. @param {string} text */
    warn(text) {
      if (text) warnings.push(text);
    },

    /** The dropped list, for the template's `origin`. */
    drops: () => [...dropped.values()],

    /** The recorded typefaces, first-seen order. */
    typefaces: () => [...fonts],

    /**
     * The plain, serializable report.
     *
     * @param {{slides: number, sourceSlides: number, shapes: {kept: number, total: number},
     *   aspect: ImportFit['aspectReport'], assets: {count: number, bytes: number}}} totals
     * @returns {ImportReport}
     */
    finish(totals) {
      return {
        format: meta.format,
        file: meta.file,
        slides: totals.slides,
        sourceSlides: totals.sourceSlides,
        shapes: totals.shapes,
        aspect: totals.aspect,
        fonts: [...fonts],
        assets: totals.assets,
        dropped: [...dropped.values()],
        failed,
        warnings,
      };
    },
  };
}

/**
 * A template's identity from the file it came from: `Bold Quote Deck.pptx` →
 * `{ id: 'bold-quote-deck', name: 'Bold Quote Deck' }`.
 *
 * `id` is a slug because that is what the template store is keyed by
 * (`api/carousel.js`), and the name keeps the author's capitalisation because
 * they chose it. Uniqueness is not settled here — two decks with one name are
 * the save path's problem, and it is the one place that can ask.
 *
 * @param {string} file
 * @returns {{id: string, name: string}}
 */
export function metaFromFilename(file) {
  const base = String(file || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '')
    .trim();
  const id = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return { id: id || 'imported', name: base || 'Imported template' };
}
