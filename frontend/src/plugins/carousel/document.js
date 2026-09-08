/**
 * Carousel Studio — the carousel document model.
 *
 * One JSON document per post (stored in `carousels.doc`, a later bead) is the
 * source of truth for a carousel; the `:::{.carousel-block}` written into post
 * content is its *rendered output*, regenerated from `slides[].rendered.path`
 * on every save. This module is the pure boundary between the two: parse and
 * normalize the stored JSON, build the content block, and hash a slide's
 * inputs so an unchanged slide can skip re-rendering.
 *
 * No DOM, no canvas, no network. Schema: `docs/features/carousel-studio.md`.
 */

import { carouselFence, CAROUSEL_BLOCK_CLASS } from '../../utils/postNodes.js';
import { sliceRects, clampPan } from './geometry.js';

/** Bumped only on a breaking schema change; present since the first commit. */
export const DOC_VERSION = 1;

export const ASPECTS = ['4:5', '1:1', '1.91:1'];
export const MODES = ['split', 'deck'];
export const FITS = ['cover', 'contain'];
export const BG_TYPES = ['blur', 'solid', 'gradient'];
/** Doc-level split strategy (see `geometry.sliceRects`): resample-to-fill,
 *  pixel-exact with a trimmed remainder, or pixel-exact with a padded tail. */
export const STRATEGIES = ['cover', 'exact', 'pad'];

const DEFAULT_ASPECT = '4:5';
const DEFAULT_MODE = 'split';
const DEFAULT_FIT = 'cover';
const DEFAULT_STRATEGY = 'cover';
const DEFAULT_ANCHOR_Y = 0.5;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const isObj = (v) => v != null && typeof v === 'object';
const num = (v, d) => (Number.isFinite(v) ? /** @type {number} */ (v) : d);

/**
 * @typedef {object} CarouselCrop
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {object} CarouselRendered
 * @property {string} path
 * @property {number|null} media_id
 * @property {string} specHash
 */

/**
 * The background fill behind a slide's pixels. `blur` carries an optional
 * `radius` in canvas px, `solid` a `color`, `gradient` a CSS `angle` in degrees
 * plus its `stops`. `null` means the default, which renders as `blur`.
 *
 * @typedef {{type:'blur', radius?:number}
 *   | {type:'solid', color:string}
 *   | {type:'gradient', angle:number, stops:Array<{at:number,color:string}>}} CarouselBg
 */

/**
 * @typedef {object} CarouselSlide
 * @property {string} source
 * @property {CarouselCrop} crop
 * @property {'cover'|'contain'} fit
 * @property {CarouselBg|null} bg
 * @property {object[]} layers
 * @property {CarouselRendered|null} rendered
 */

/**
 * @typedef {object} CarouselDoc
 * @property {number} version
 * @property {string} aspect
 * @property {string} mode
 * @property {'cover'|'exact'|'pad'} strategy  how `split` mode fits the source to the deck
 * @property {number} anchorY  0..1 vertical placement of the crop band in its slack
 * @property {CarouselSlide[]} slides
 * @property {object[]} spanLayers
 * @property {{id:string,custom:boolean}|null} template
 */

/** A fresh, empty document. */
export function emptyDocument() {
  return normalizeDocument({});
}

/** @param {*} crop @returns {CarouselCrop} */
function normalizeCrop(crop) {
  const c = isObj(crop) ? crop : {};
  const w = clamp(num(c.w, 1), 0, 1);
  const h = clamp(num(c.h, 1), 0, 1);
  return {
    x: clamp(num(c.x, 0), 0, 1 - w),
    y: clamp(num(c.y, 0), 0, 1 - h),
    w,
    h,
  };
}

/**
 * Colours are hex or the `transparent` keyword, and nothing else.
 *
 * Deliberately narrower than CSS: a gradient stop reaches
 * `CanvasGradient.addColorStop`, which **throws** on a string it cannot parse,
 * so a colour that survives normalization has to be one the canvas is certain
 * to accept. Rejecting here is what keeps a bad background a normalization
 * problem instead of a render-time exception. Lowercased, so two spellings of
 * one colour hash the same.
 */
const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** @param {*} value @param {string} fallback @returns {string} */
function normalizeColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const c = value.trim().toLowerCase();
  if (c === 'transparent') return c;
  return COLOR_RE.test(c) ? c : fallback;
}

const DEFAULT_BG_COLOR = '#000000';
/** Top → bottom, the CSS convention `geometry.gradientLine` reproduces. */
const DEFAULT_GRADIENT_ANGLE = 180;
/** Two stops, because a gradient needs at least two to be one. Near-black so
 *  the letterbox reads as a deliberate frame rather than a colour choice. */
const DEFAULT_GRADIENT_STOPS = [
  { at: 0, color: '#000000' },
  { at: 1, color: '#2b2b2b' },
];

/**
 * Gradient stops, or `null` when the value cannot make a gradient at all.
 * Entries whose colour the canvas would reject are dropped; a stop with no
 * usable `at` is spread evenly across what survives, so `[{color}, {color}]`
 * is a complete gradient.
 *
 * @param {*} stops
 * @returns {Array<{at:number,color:string}>|null}
 */
function normalizeStops(stops) {
  if (!Array.isArray(stops)) return null;
  const kept = [];
  for (const s of stops) {
    if (!isObj(s)) continue;
    const color = normalizeColor(s.color, '');
    if (color) kept.push({ at: s.at, color });
  }
  if (kept.length < 2) return null;
  const last = kept.length - 1;
  return kept.map((s, i) => ({ at: clamp(num(s.at, i / last), 0, 1), color: s.color }));
}

/**
 * A slide's background fill: what the render paints wherever the slide's own
 * pixels do not reach (a `contain` slide's letterbox, the `pad` strategy's tail
 * gap). Normalized per type — unknown fields dropped, like everywhere in this
 * module — and `null` for "the default", which the draw layer paints as `blur`.
 *
 * An unusable value degrades rather than throwing: a gradient with no parseable
 * stops falls back to {@link DEFAULT_GRADIENT_STOPS}, an unrecognized type to
 * `null`. `render.js` may not discover a bad background mid-encode.
 *
 * @param {*} bg
 * @returns {CarouselBg|null}
 */
function normalizeBg(bg) {
  if (!isObj(bg) || !BG_TYPES.includes(bg.type)) return null;
  if (bg.type === 'solid') {
    return { type: 'solid', color: normalizeColor(bg.color, DEFAULT_BG_COLOR) };
  }
  if (bg.type === 'gradient') {
    return {
      type: 'gradient',
      angle: ((num(bg.angle, DEFAULT_GRADIENT_ANGLE) % 360) + 360) % 360,
      stops: normalizeStops(bg.stops) || DEFAULT_GRADIENT_STOPS.map((s) => ({ ...s })),
    };
  }
  // blur: `radius` is optional — the draw layer derives one from the canvas
  // width when it is absent, so a zero or negative value is simply dropped.
  const radius = num(bg.radius, 0);
  return radius > 0 ? { type: 'blur', radius } : { type: 'blur' };
}

/** @param {*} rendered @returns {CarouselRendered|null} */
function normalizeRendered(rendered) {
  if (!isObj(rendered)) return null;
  const path = typeof rendered.path === 'string' ? rendered.path : '';
  if (!path) return null;
  return {
    path,
    media_id: Number.isFinite(rendered.media_id) ? rendered.media_id : null,
    specHash: typeof rendered.specHash === 'string' ? rendered.specHash : '',
  };
}

/** @param {*} slide @returns {CarouselSlide} */
function normalizeSlide(slide) {
  const s = isObj(slide) ? slide : {};
  return {
    source: typeof s.source === 'string' ? s.source : '',
    crop: normalizeCrop(s.crop),
    fit: FITS.includes(s.fit) ? s.fit : DEFAULT_FIT,
    bg: normalizeBg(s.bg),
    layers: Array.isArray(s.layers) ? s.layers.slice() : [],
    rendered: normalizeRendered(s.rendered),
  };
}

/** @param {*} template @returns {{id:string,custom:boolean}|null} */
function normalizeTemplate(template) {
  if (!isObj(template) || typeof template.id !== 'string' || !template.id) return null;
  return { id: template.id, custom: Boolean(template.custom) };
}

/**
 * Coerce any value into a valid `CarouselDoc`: unknown fields dropped, missing
 * fields defaulted, out-of-range numbers clamped. Idempotent — normalizing an
 * already-normal document returns an equal one, which is what makes the
 * parse/serialize pair a round trip.
 *
 * @param {*} input
 * @returns {CarouselDoc}
 */
export function normalizeDocument(input) {
  const doc = isObj(input) ? input : {};
  return {
    version: DOC_VERSION,
    aspect: ASPECTS.includes(doc.aspect) ? doc.aspect : DEFAULT_ASPECT,
    mode: MODES.includes(doc.mode) ? doc.mode : DEFAULT_MODE,
    strategy: STRATEGIES.includes(doc.strategy) ? doc.strategy : DEFAULT_STRATEGY,
    anchorY: clamp(num(doc.anchorY, DEFAULT_ANCHOR_Y), 0, 1),
    slides: Array.isArray(doc.slides) ? doc.slides.map(normalizeSlide) : [],
    spanLayers: Array.isArray(doc.spanLayers) ? doc.spanLayers.slice() : [],
    template: normalizeTemplate(doc.template),
  };
}

/**
 * Parse a stored document. Accepts the JSON string from `carousels.doc`, an
 * already-parsed object, or `null`/`''` (a post with no carousel yet → an empty
 * document). Throws only on a non-empty string that is not valid JSON — losing
 * a malformed document silently would be worse than surfacing the error.
 *
 * @param {string|object|null|undefined} input
 * @returns {CarouselDoc}
 */
export function parseDocument(input) {
  if (input == null || input === '') return emptyDocument();
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  return normalizeDocument(raw);
}

/**
 * Serialize a document for storage. Keys are written in a fixed order (the
 * order `normalizeDocument` builds them), so identical documents serialize to
 * identical strings.
 *
 * @param {*} doc
 * @returns {string}
 */
export function serializeDocument(doc) {
  return JSON.stringify(normalizeDocument(doc));
}

/**
 * The `:::{.carousel-block}` markdown for a document — one bare path per
 * rendered slide, in slide order, blank line between them. Slides with no
 * rendered output yet are skipped; an empty result is the empty string.
 *
 * @param {*} doc
 * @returns {string}
 */
export function buildCarouselBlock(doc) {
  const paths = normalizeDocument(doc)
    .slides.map((s) => (s.rendered ? s.rendered.path : ''))
    .filter(Boolean);
  return paths.length ? carouselFence(paths) : '';
}

/**
 * The existing `:::{.carousel-block}` fence in a post's content, if any.
 * Non-greedy to the first closing `:::` — a slide path can never contain one.
 */
const CAROUSEL_FENCE_RE = new RegExp(
  `:::\\{\\.${CAROUSEL_BLOCK_CLASS}\\}\\n[\\s\\S]*?\\n:::`,
);

/**
 * Splice a document's rendered block into a post's content: replace the
 * existing carousel fence in place, append one when there is none, or drop it
 * when the document has no rendered slides left. Everything else in the content
 * is untouched — this is a targeted string edit, not a parse/serialize round
 * trip.
 *
 * @param {string} content the post's markdown
 * @param {*} doc the carousel document
 * @returns {string}
 */
export function applyCarouselBlock(content, doc) {
  const block = buildCarouselBlock(doc);
  const src = String(content ?? '');

  if (CAROUSEL_FENCE_RE.test(src)) {
    const next = src.replace(CAROUSEL_FENCE_RE, () => block);
    return next.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (!block) return src;
  return src.trim() ? `${src.trim()}\n\n${block}` : block;
}

/**
 * A fresh `split` document: `n` slides, all drawn from the one `source` image.
 * `render.js` recomputes the exact draw rect from the slide index via
 * `geometry.sliceRects`; each slide's `crop` records the horizontal band it
 * covers so the document is self-describing and every slide's `specHash` is
 * distinct (equal hashes would collapse under the C8 re-render dedup).
 *
 * @param {{ source: string, n: number, aspect: string,
 *   strategy?: 'cover'|'exact'|'pad', anchorY?: number }} spec
 * @returns {CarouselDoc}
 */
export function splitDocument({ source, n, aspect, strategy, anchorY }) {
  const count = Math.max(1, Math.floor(n));
  return normalizeDocument({
    version: DOC_VERSION,
    aspect,
    mode: 'split',
    strategy,
    anchorY,
    slides: Array.from({ length: count }, (_, i) => ({
      source,
      crop: { x: i / count, y: 0, w: 1 / count, h: 1 },
    })),
  });
}

/**
 * Freeze a `split` document into a `deck` document: each slide keeps the source
 * it already had, but records as its own normalized `crop` the exact region
 * {@link sliceRects} was deriving for it. The user gains per-slide framing
 * without a pixel moving first — the conversion itself is meant to be
 * invisible, so anything the eye can catch here is a bug.
 *
 * One way. Going back to `split` discards these crops (the doc-level strategy
 * re-derives every slide); the caller says so in the UI.
 *
 * `strategy` and `anchorY` stay on the document — the schema keeps them, and a
 * later return to `split` needs them — but they **stop driving the render** the
 * moment `mode` is `deck`; from then on `crop` + `fit` alone decide what each
 * slide shows. They stay in `specHash` regardless, which is why a conversion
 * invalidates every slide's cached render even though the pixels are identical:
 * `rendered` is carried over, so the block keeps pointing at the current images
 * until the next save re-encodes them.
 *
 * Two seams worth knowing, both from `geometry`'s per-slide model meeting the
 * split path's whole-strip one:
 *
 * - **`pad`'s tail slide is re-centred.** In `split` the short last column sits
 *   flush left with the gap filled on the right, because it has to continue the
 *   column before it. `deckSlideRects` centres a `contain` slide by
 *   construction — the source region is identical, but the letterbox moves to
 *   both sides. It is the one case where the conversion is visible; deck mode
 *   has no horizontal alignment to express the alternative.
 * - **`cover` can land a source pixel off.** `deckSlideRects` re-derives the
 *   frame aspect from the rounded crop, so where `sliceRects`' column was a
 *   rounded pixel off the exact ratio the deck re-centre-crops it by one pixel
 *   an edge — at most 2 in `sw`/`sh`, 1 in `sx`/`sy`, always inside the split
 *   region, and the destination rect is untouched. `exact` and `pad` are
 *   pixel-identical wherever the source can honour them; where it cannot, both
 *   paths fall back to `cover` alike and inherit that bound.
 *
 * @param {*} doc the document to convert (any mode; already-`deck` is a no-op)
 * @param {number} srcW source width in pixels — an argument, never a document
 *   field: the document stores no derived data (callers re-probe on load)
 * @param {number} srcH source height in pixels
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function toDeckDocument(doc, srcW, srcH) {
  const base = normalizeDocument(doc);
  const w = Number.isFinite(srcW) ? Math.floor(srcW) : 0;
  const h = Number.isFinite(srcH) ? Math.floor(srcH) : 0;
  // No source dimensions yet (a probe still in flight) — flip the mode and keep
  // the bands `splitDocument` wrote. Clamped, not thrown: this is called from
  // a UI toggle, and a throw there strands the studio in split mode.
  if (base.mode === 'deck' || !base.slides.length || w < 1 || h < 1) {
    return normalizeDocument({ ...base, mode: 'deck' });
  }

  const rects = sliceRects(w, h, base.slides.length, base.aspect, {
    strategy: base.strategy,
    anchorY: base.anchorY,
  });
  return normalizeDocument({
    ...base,
    mode: 'deck',
    slides: base.slides.map((slide, i) => {
      const r = rects[i];
      return {
        ...slide,
        crop: { x: r.sx / w, y: r.sy / h, w: r.sw / w, h: r.sh / h },
        // A padded column is narrower than its frame: `contain` is what keeps
        // it unscaled and leaves the gap for the background fill.
        fit: r.pad ? 'contain' : 'cover',
      };
    }),
  });
}

/** Merge a partial crop over an existing one, ignoring anything not a number. */
function mergeCrop(current, patch) {
  const p = isObj(patch) ? patch : {};
  const out = { ...current };
  for (const k of ['x', 'y', 'w', 'h']) {
    if (Number.isFinite(p[k])) out[k] = p[k];
  }
  return out;
}

/**
 * Change one slide's framing, normalized. The single writer for `crop` / `fit` /
 * `bg` in deck mode: a pan or a zoom lands here, so a gesture cannot leave the
 * document in a state the renderer and the preview read differently.
 *
 * `update` is a partial `{crop?, fit?, bg?}` — unknown keys are dropped, as
 * everywhere in this module, and so are values the schema rejects (an
 * unrecognized `fit` leaves the slide's own). `crop` is merged field by field
 * over the current one, so a pan can send `{x, y}` without resetting the zoom,
 * then passed through {@link clampPan} — which is why this needs the source
 * dimensions, and why they arrive as options rather than as document fields.
 *
 * An out-of-range `slideIndex` returns an equal document instead of throwing:
 * this runs at gesture rate from pointer handlers, where a throw strands the
 * drag mid-flight.
 *
 * @param {*} doc
 * @param {number} slideIndex
 * @param {{crop?: Partial<CarouselCrop>, fit?: string, bg?: object|null}} update
 * @param {{srcW?: number, srcH?: number}} [opts] source pixel dimensions, used
 *   to clamp the crop; omitting them still clamps to the 0..1 normalized box
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function updateSlideFraming(doc, slideIndex, update, opts = {}) {
  const base = normalizeDocument(doc);
  const i = Number(slideIndex);
  if (
    slideIndex == null ||
    !Number.isInteger(i) ||
    i < 0 ||
    i >= base.slides.length ||
    !isObj(update)
  ) {
    return base;
  }

  const srcW = num(opts.srcW, 0);
  const srcH = num(opts.srcH, 0);
  const slide = base.slides[i];
  const next = { ...slide };
  if ('crop' in update) {
    next.crop = clampPan(normalizeCrop(mergeCrop(slide.crop, update.crop)), srcW, srcH);
  }
  if (FITS.includes(update.fit)) next.fit = /** @type {'cover'|'contain'} */ (update.fit);
  if ('bg' in update) next.bg = normalizeBg(update.bg);

  return normalizeDocument({
    ...base,
    slides: base.slides.map((s, j) => (j === i ? next : s)),
  });
}

/** Deterministic JSON: object keys sorted recursively. */
function stableStringify(value) {
  if (!isObj(value)) return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** 32-bit FNV-1a, hex, zero-padded to 8 chars. Change detection, not security. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable hash of the inputs that determine a slide's pixels — source, crop,
 * fit, background, layers — but NOT its `rendered` block. Equal hashes across
 * two saves (with the same doc-level `aspect` / `strategy` / `anchorY`, which
 * the caller folds in) mean the slide can reuse its existing render instead of
 * re-encoding.
 *
 * @param {*} slide
 * @param {string} [aspect] doc-level aspect, included in the hash when given
 * @param {{ strategy?: string, anchorY?: number }} [deck] doc-level split
 *   strategy and vertical anchor — a change to either re-slices every column,
 *   so folding them in invalidates the cached render
 * @returns {string}
 */
export function specHash(slide, aspect = '', deck = {}) {
  const s = normalizeSlide(slide);
  return fnv1a(
    stableStringify({
      aspect,
      strategy: deck.strategy ?? '',
      anchorY: deck.anchorY ?? null,
      source: s.source,
      crop: s.crop,
      fit: s.fit,
      bg: s.bg,
      layers: s.layers,
    }),
  );
}
