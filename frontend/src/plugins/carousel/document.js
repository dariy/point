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
 * A layer's placement box: `{x, y, w, h}` in 0..1 of the canvas it sits on.
 *
 * @typedef {object} CarouselBox
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * The typography a `text` and a `counter` layer share. `size` is the type size
 * as a fraction of the canvas height, or `null` to auto-fit the box. Opacity
 * lives in `color`'s alpha (`#rrggbbaa`), which is why neither carries one.
 *
 * @typedef {object} CarouselTextStyle
 * @property {'left'|'center'|'right'} align
 * @property {'top'|'middle'|'bottom'} valign
 * @property {string} color
 * @property {number} weight
 * @property {number|null} size
 * @property {boolean} shadow
 */

/**
 * One drawable placed over a slide's image, in that slide's canvas space — or,
 * in `doc.spanLayers`, in the deck's. A tagged union over five `type`s sharing
 * one `box`; {@link normalizeLayer} is the only thing that produces one.
 *
 * @typedef {{type:'text', box:CarouselBox, text:string, lineHeight:number} & CarouselTextStyle} CarouselTextLayer
 * @typedef {{type:'image', box:CarouselBox, source:string, fit:'cover'|'contain', opacity:number}} CarouselImageLayer
 * @typedef {{type:'rect', box:CarouselBox, fill:string, opacity:number, radius:number}} CarouselRectLayer
 * @typedef {{type:'counter', box:CarouselBox, format:string} & CarouselTextStyle} CarouselCounterLayer
 * @typedef {{type:'arrow', box:CarouselBox, direction:'left'|'right', color:string, opacity:number}} CarouselArrowLayer
 * @typedef {CarouselTextLayer|CarouselImageLayer|CarouselRectLayer|CarouselCounterLayer|CarouselArrowLayer} CarouselLayer
 */

/**
 * @typedef {object} CarouselSlide
 * @property {string} source
 * @property {CarouselCrop} crop
 * @property {'cover'|'contain'} fit
 * @property {CarouselBg|null} bg
 * @property {CarouselLayer[]} layers
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
 * @property {CarouselLayer[]} spanLayers  layers in the deck's canvas space,
 *   sliced across slide boundaries (addressed as slide {@link SPAN_SLIDE})
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

/* ── Layers ─────────────────────────────────────────────────────────────── */

export const ALIGNS = ['left', 'center', 'right'];
export const VALIGNS = ['top', 'middle', 'bottom'];
export const DIRECTIONS = ['left', 'right'];

/**
 * `slideIndex` addressing `doc.spanLayers` rather than a slide's own list, so
 * every mutator below has one call site in the studio instead of two parallel
 * families. Negative by construction: no slide can ever collide with it.
 */
export const SPAN_SLIDE = -1;

/**
 * The smallest a layer box may be on either axis: one pixel of the 1080px
 * canvas width, the one dimension every aspect shares. A box is normalized to
 * the canvas rather than to an aspect — `aspect` is a document-level switch and
 * layers move with the frame — so the clamp has no single canvas height to
 * measure against, and the width is the honest floor. Below it a layer is
 * invisible in the render and impossible to grab in the studio.
 */
const MIN_BOX = 1 / 1080;

const DEFAULT_ALIGN = 'left';
const DEFAULT_VALIGN = 'top';
/** White: a layer is a mark over a photograph, and dark photographs are the
 *  common case. The alpha channel of a `#rrggbbaa` colour is its opacity. */
const DEFAULT_LAYER_COLOR = '#ffffff';
const DEFAULT_WEIGHT = 400;
/** The CSS `font-weight` range, not the 100..900 of a static family: the theme
 *  font may be variable, and the canvas takes whatever CSS takes. */
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 1000;
const DEFAULT_LINE_HEIGHT = 1.2;
/** Below 0.5 lines overprint illegibly; above 4 the box holds one line anyway. */
const MIN_LINE_HEIGHT = 0.5;
const MAX_LINE_HEIGHT = 4;
const DEFAULT_COUNTER_FORMAT = '{i}/{n}';
/** `contain`, unlike a slide's `cover`: an image layer is a logo or a mark, and
 *  cropping one to fill its box is never what was meant. */
const DEFAULT_LAYER_FIT = 'contain';
/** Rightward — an arrow layer is the swipe-onward hint. */
const DEFAULT_DIRECTION = 'right';

/**
 * A layer's box, clamped so the layer stays inside the canvas however it was
 * dragged or resized: `w`/`h` pinned to at least {@link MIN_BOX}, then the
 * origin so that `x+w <= 1` and `y+h <= 1`. The same discipline `clampPan`
 * keeps for a crop against its source, done arithmetically here — a box has no
 * source to measure against, which is what keeps this module independent of
 * `geometry.js`.
 *
 * A span layer's box clamps against this same 0..1 range. That its `1` means
 * "the whole deck" rather than "one slide" is the renderer's business.
 *
 * @param {*} box
 * @param {*} [base] an already-normal box whose fields stand in for the
 *   defaults — see {@link normalizeLayer}
 * @returns {CarouselBox}
 */
function normalizeBox(box, base) {
  const b = isObj(box) ? box : {};
  const d = isObj(base) ? base : { x: 0, y: 0, w: 1, h: 1 };
  const w = clamp(num(b.w, d.w), MIN_BOX, 1);
  const h = clamp(num(b.h, d.h), MIN_BOX, 1);
  return {
    x: clamp(num(b.x, d.x), 0, 1 - w),
    y: clamp(num(b.y, d.y), 0, 1 - h),
    w,
    h,
  };
}

/**
 * Type size as a fraction of the canvas height, or `null` for "auto-fit the
 * box" — which is the default, because a headline that fits is worth more than
 * one that is exactly 7% tall. Anything unusable falls back rather than
 * throwing: `render.js` cannot discover a bad size mid-encode.
 */
function normalizeSize(value, fallback) {
  return Number.isFinite(value) ? clamp(value, MIN_BOX, 1) : fallback;
}

/** The three types that carry their own opacity; the other two use `color`'s alpha. */
function normalizeOpacity(l, fb) {
  return clamp(num(l.opacity, fb('opacity', 1)), 0, 1);
}

/**
 * The typography `text` and `counter` share. Split out so the two cannot drift:
 * `.3` paints one and `.4` the other, from the same fields.
 *
 * @param {*} l the raw layer
 * @param {(key: string, dflt: *) => *} fb the fallback resolver
 * @returns {CarouselTextStyle}
 */
function normalizeTextStyle(l, fb) {
  return {
    align: ALIGNS.includes(l.align) ? l.align : fb('align', DEFAULT_ALIGN),
    valign: VALIGNS.includes(l.valign) ? l.valign : fb('valign', DEFAULT_VALIGN),
    color: normalizeColor(l.color, fb('color', DEFAULT_LAYER_COLOR)),
    weight: clamp(Math.round(num(l.weight, fb('weight', DEFAULT_WEIGHT))), MIN_WEIGHT, MAX_WEIGHT),
    size: normalizeSize(l.size, fb('size', null)),
    shadow: Boolean(l.shadow ?? fb('shadow', false)),
  };
}

/**
 * One builder per `type`: the full shape that type normalizes to, given the raw
 * layer, the fallback resolver and an already-clamped box. A table rather than
 * a switch so that {@link LAYER_TYPES} can be derived from it — the list of
 * what is valid and the code that produces it cannot disagree — and so adding a
 * sixth type is one entry rather than a longer function.
 *
 * @type {Record<string, (l: *, fb: (key: string, dflt: *) => *, box: CarouselBox) => CarouselLayer>}
 */
const LAYER_BUILDERS = {
  text: (l, fb, box) => ({
    type: 'text',
    box,
    text: typeof l.text === 'string' ? l.text : fb('text', ''),
    lineHeight: clamp(
      num(l.lineHeight, fb('lineHeight', DEFAULT_LINE_HEIGHT)),
      MIN_LINE_HEIGHT,
      MAX_LINE_HEIGHT,
    ),
    ...normalizeTextStyle(l, fb),
  }),

  image: (l, fb, box) => ({
    type: 'image',
    box,
    source: typeof l.source === 'string' ? l.source : fb('source', ''),
    fit: FITS.includes(l.fit) ? l.fit : fb('fit', DEFAULT_LAYER_FIT),
    opacity: normalizeOpacity(l, fb),
  }),

  rect: (l, fb, box) => ({
    type: 'rect',
    box,
    fill: normalizeColor(l.fill, fb('fill', DEFAULT_BG_COLOR)),
    opacity: normalizeOpacity(l, fb),
    // A fraction of the box's shorter side, so 0.5 is a pill and the corner
    // survives a resize. Canvas px would not: the box is normalized.
    radius: clamp(num(l.radius, fb('radius', 0)), 0, 0.5),
  }),

  counter: (l, fb, box) => ({
    type: 'counter',
    box,
    // `{i}` is the 1-based slide number, `{n}` the deck's length; anything else
    // in the string is literal. A non-string is the only rejection — a format
    // with neither placeholder is a caption, and that is allowed.
    format: typeof l.format === 'string' ? l.format : fb('format', DEFAULT_COUNTER_FORMAT),
    ...normalizeTextStyle(l, fb),
  }),

  arrow: (l, fb, box) => ({
    type: 'arrow',
    box,
    direction: DIRECTIONS.includes(l.direction) ? l.direction : fb('direction', DEFAULT_DIRECTION),
    color: normalizeColor(l.color, fb('color', DEFAULT_LAYER_COLOR)),
    opacity: normalizeOpacity(l, fb),
  }),
};

/** The five things a layer can be. An unrecognized sixth is dropped, not kept. */
export const LAYER_TYPES = Object.keys(LAYER_BUILDERS);

/**
 * Coerce any value into a valid layer, or `null` when it cannot be one.
 *
 * **This is the one place the schema drops user data.** A layer's fields mean
 * nothing without its `type`, so an unrecognized one cannot be migrated, only
 * dropped — {@link normalizeLayers} filters the `null` out. `DOC_VERSION`
 * deliberately does not move for it: `layers` and `spanLayers` have been
 * reserved-but-unvalidated since version 1 and no released code ever wrote a
 * layer, so tightening them cannot invalidate a document in the wild. Every
 * other field degrades instead — out of range is clamped, unrecognized is
 * defaulted, unknown is dropped, exactly as everywhere else in this module.
 *
 * @param {*} layer
 * @param {*} [base] an already-normal layer of the same `type` whose fields
 *   stand in for the schema defaults. This is how {@link updateLayer} keeps
 *   `updateSlideFraming`'s contract — a patch value the schema rejects leaves
 *   the layer's own — without a second predicate per field.
 * @returns {CarouselLayer|null}
 */
export function normalizeLayer(layer, base = undefined) {
  const l = /** @type {*} */ (layer);
  if (!isObj(l) || !LAYER_TYPES.includes(l.type)) return null;
  const b = isObj(base) && /** @type {*} */ (base).type === l.type ? /** @type {*} */ (base) : {};
  /** The base layer's field when it has one, else the schema default. */
  const fb = (key, dflt) => (b[key] === undefined ? dflt : b[key]);
  return LAYER_BUILDERS[l.type](l, fb, normalizeBox(l.box, b.box));
}

/**
 * A layer list: every entry normalized, the ones that cannot be a layer at all
 * dropped. Painted back to front, so order is meaning and is preserved.
 *
 * @param {*} layers
 * @returns {CarouselLayer[]}
 */
function normalizeLayers(layers) {
  if (!Array.isArray(layers)) return [];
  const out = [];
  for (const layer of layers) {
    const normal = normalizeLayer(layer);
    if (normal) out.push(normal);
  }
  return out;
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
    layers: normalizeLayers(s.layers),
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
    spanLayers: normalizeLayers(doc.spanLayers),
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
 * `spanLayers` are carried through unchanged: their box is normalized to the
 * **deck**, not to a slide count, so re-slicing to a different `n` re-flows the
 * same headline across the new seams rather than dropping it (S3). The studio
 * passes the current document's span layers in on every re-slice.
 *
 * @param {{ source: string, n: number, aspect: string,
 *   strategy?: 'cover'|'exact'|'pad', anchorY?: number,
 *   spanLayers?: CarouselLayer[] }} spec
 * @returns {CarouselDoc}
 */
export function splitDocument({ source, n, aspect, strategy, anchorY, spanLayers }) {
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
    spanLayers,
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

/**
 * The layer list a `slideIndex` addresses — `doc.spanLayers` at
 * {@link SPAN_SLIDE}, a slide's own otherwise — or `null` when it names
 * nothing. `doc` must already be normal.
 *
 * @param {CarouselDoc} doc
 * @param {*} slideIndex
 * @returns {CarouselLayer[]|null}
 */
function layersAt(doc, slideIndex) {
  const i = Number(slideIndex);
  if (slideIndex == null || !Number.isInteger(i)) return null;
  if (i === SPAN_SLIDE) return doc.spanLayers;
  return i >= 0 && i < doc.slides.length ? doc.slides[i].layers : null;
}

/**
 * `layerIndex` as an index into `list`, or `-1` when it names no layer there.
 * The one definition of "in range" the three mutators below share, so none of
 * them can disagree with the others about what an out-of-range index is.
 *
 * @param {CarouselLayer[]|null} list
 * @param {*} layerIndex
 * @returns {number}
 */
function layerIndexIn(list, layerIndex) {
  const j = Number(layerIndex);
  return list && Number.isInteger(j) && j >= 0 && j < list.length ? j : -1;
}

/**
 * `doc` with the list `slideIndex` addresses replaced. Normalized on the way
 * out like every other writer here, so the result is a document the renderer
 * and the preview cannot read differently.
 *
 * @param {CarouselDoc} doc
 * @param {number} slideIndex
 * @param {CarouselLayer[]} layers
 * @returns {CarouselDoc}
 */
function withLayers(doc, slideIndex, layers) {
  const i = Number(slideIndex);
  if (i === SPAN_SLIDE) return normalizeDocument({ ...doc, spanLayers: layers });
  return normalizeDocument({
    ...doc,
    slides: doc.slides.map((s, j) => (j === i ? { ...s, layers } : s)),
  });
}

/**
 * Append a layer to a slide's list, or to `doc.spanLayers` at
 * {@link SPAN_SLIDE}. Appending, not inserting, because the list paints back to
 * front: a new layer belongs on top of what is already there.
 *
 * A layer the schema rejects outright, or an out-of-range `slideIndex`, returns
 * an equal document rather than throwing — the same contract
 * {@link updateSlideFraming} keeps, and for the same reason: these run from UI
 * handlers where a throw strands the studio.
 *
 * @param {*} doc
 * @param {number} slideIndex the slide, or {@link SPAN_SLIDE} for the deck
 * @param {*} layer
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function addLayer(doc, slideIndex, layer) {
  const base = normalizeDocument(doc);
  const list = layersAt(base, slideIndex);
  const next = normalizeLayer(layer);
  if (!list || !next) return base;
  return withLayers(base, slideIndex, [...list, next]);
}

/**
 * Merge a partial layer over the one at `layerIndex`, normalized.
 *
 * `patch` follows {@link updateSlideFraming}'s contract exactly: unknown keys
 * are dropped, and a value the schema rejects leaves the layer's own rather
 * than resetting it to the schema default — which is what passing the current
 * layer to {@link normalizeLayer} as its `base` buys. `box` merges field by
 * field over the current one, so a drag can send `{box:{x, y}}` without
 * resetting the size, exactly as a pan sends `{crop:{x, y}}`.
 *
 * A layer's `type` is fixed: patching it is ignored, because every other field
 * means something different under a different type. Remove and re-add instead.
 *
 * @param {*} doc
 * @param {number} slideIndex the slide, or {@link SPAN_SLIDE} for the deck
 * @param {number} layerIndex
 * @param {*} patch
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function updateLayer(doc, slideIndex, layerIndex, patch) {
  const base = normalizeDocument(doc);
  const list = layersAt(base, slideIndex);
  const j = layerIndexIn(list, layerIndex);
  if (!list || j < 0 || !isObj(patch)) return base;

  const current = list[j];
  const p = /** @type {*} */ (patch);
  const merged = { ...current, ...p, type: current.type };
  if ('box' in p) merged.box = mergeCrop(current.box, p.box);
  const next = normalizeLayer(merged, current);
  if (!next) return base;

  return withLayers(
    base,
    slideIndex,
    list.map((layer, k) => (k === j ? next : layer)),
  );
}

/**
 * Drop the layer at `layerIndex`. An out-of-range index is a no-op.
 *
 * @param {*} doc
 * @param {number} slideIndex the slide, or {@link SPAN_SLIDE} for the deck
 * @param {number} layerIndex
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function removeLayer(doc, slideIndex, layerIndex) {
  const base = normalizeDocument(doc);
  const list = layersAt(base, slideIndex);
  const j = layerIndexIn(list, layerIndex);
  if (!list || j < 0) return base;
  return withLayers(
    base,
    slideIndex,
    list.filter((_, k) => k !== j),
  );
}

/**
 * Move the layer at `from` to `to`, shifting the rest — a reorder, not a swap,
 * because the list is the paint order and dragging a layer up the stack must
 * not exchange it with whatever it landed on. Either index out of range is a
 * no-op; `from === to` returns an equal document.
 *
 * @param {*} doc
 * @param {number} slideIndex the slide, or {@link SPAN_SLIDE} for the deck
 * @param {number} from
 * @param {number} to
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function reorderLayer(doc, slideIndex, from, to) {
  const base = normalizeDocument(doc);
  const list = layersAt(base, slideIndex);
  const a = layerIndexIn(list, from);
  const b = layerIndexIn(list, to);
  if (!list || a < 0 || b < 0) return base;

  const next = list.slice();
  next.splice(b, 0, next.splice(a, 1)[0]);
  return withLayers(base, slideIndex, next);
}

// ── Slides ──────────────────────────────────────────────────────────────────
// The four writers below are to `slides` what the layer family above is to
// `layers`, and they keep the same contract: an index that names nothing
// returns an equal document, and nothing throws. They run from the rail's
// pointer handlers, where a throw strands a gesture.
//
// No slide-count bounds here. `MIN_SLIDES`/`MAX_SLIDES` (`studio/bounds.js`)
// belong to the state owner, which can refuse in a toast; a model that refused
// silently would leave its caller unable to tell a refusal from a no-op.
//
// Span layers need no work either way: their boxes are fractions of the whole
// n-wide deck, so a changed slide count re-flows them across the new seams —
// the same thing `splitDocument` relies on when it re-slices.

/**
 * `i` as an index into `slides`, or -1 when it names no slide — the slide twin
 * of {@link layerIndexIn}, so the writers below cannot disagree with each other
 * about what out of range means.
 *
 * @param {CarouselSlide[]} slides
 * @param {*} i
 * @returns {number}
 */
function slideIndexIn(slides, i) {
  const j = Number(i);
  // `i == null` before the coercion, because `Number(null)` is 0 and a control
  // that forgot to say which slide it meant must not silently mean the first.
  // The same guard `updateSlideFraming` opens with.
  if (i == null || !Number.isInteger(j)) return -1;
  return j >= 0 && j < slides.length ? j : -1;
}

/**
 * Insert a slide at `at`, shifting the rest along. `at` is a *position* rather
 * than an existing slide, so `slides.length` appends and `0` prepends; anything
 * outside `0..slides.length` returns an equal document.
 *
 * `slide` is optional, and with nothing given the new slide shows the photo of
 * the slide it follows (at the head, the one it precedes), uncropped: a slide
 * with no source is one the stage cannot draw and the render refuses, and a
 * control that adds an invisible slide has not added anything. Every other
 * field is {@link normalizeSlide}'s to fill — the studio never authors a slide
 * literal, the same rule {@link addLayer} keeps for layers.
 *
 * A new slide is never rendered, whatever it was handed. `rendered` names a
 * media row, and two slides claiming one row is the state the supersede cleanup
 * (`_deleteSuperseded` in `index.js`) cannot reason about — deleting one of the
 * pair would take the other's image with it. So it is dropped here rather than
 * trusted.
 *
 * @param {*} doc
 * @param {number} at insertion position, `0..slides.length`
 * @param {*} [slide] the slide to insert; omitted means "another like this one"
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function addSlide(doc, at, slide) {
  const base = normalizeDocument(doc);
  const i = Number(at);
  if (at == null || !Number.isInteger(i) || i < 0 || i > base.slides.length) return base;

  const neighbour = base.slides[i - 1] || base.slides[i] || null;
  const next = normalizeSlide(isObj(slide) ? slide : { source: neighbour ? neighbour.source : '' });
  next.rendered = null;
  const slides = base.slides.slice();
  slides.splice(i, 0, next);
  return normalizeDocument({ ...base, slides });
}

/**
 * Drop the slide at `i`. An out-of-range index is a no-op.
 *
 * The slide's `rendered` block goes with it, which is precisely why the caller
 * still owes its media row a delete: the row carries a `post_id`, so
 * `ListOrphanedMedia` will never flag it. `_deleteSuperseded` (`index.js`) does
 * that on the next render, from the *saved* set rather than from the document.
 *
 * @param {*} doc
 * @param {number} i
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function removeSlide(doc, i) {
  const base = normalizeDocument(doc);
  const j = slideIndexIn(base.slides, i);
  if (j < 0) return base;
  return normalizeDocument({ ...base, slides: base.slides.filter((_, k) => k !== j) });
}

/**
 * Copy the slide at `i` and land the copy directly after it — source, framing,
 * background and layers included, its `rendered` block not (see
 * {@link addSlide}). An out-of-range index is a no-op.
 *
 * The copy is pixel-for-pixel its twin until something moves, and two
 * byte-identical slides are what `assertDistinctMedia` (`index.js`) refuses —
 * so a duplicate is a starting point, and the caller says so.
 *
 * @param {*} doc
 * @param {number} i
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function duplicateSlide(doc, i) {
  const base = normalizeDocument(doc);
  const j = slideIndexIn(base.slides, i);
  if (j < 0) return base;
  return addSlide(base, j + 1, base.slides[j]);
}

/**
 * Move the slide at `from` to `to`, shifting the rest — a reorder, not a swap,
 * for the reason {@link reorderLayer} is one: the array is the order the
 * carousel is read in, and dragging a slide along must not exchange it with
 * whatever it landed on. Either index out of range is a no-op; `from === to`
 * returns an equal document.
 *
 * @param {*} doc
 * @param {number} from
 * @param {number} to
 * @returns {CarouselDoc} a new document; the input is not mutated
 */
export function moveSlide(doc, from, to) {
  const base = normalizeDocument(doc);
  const a = slideIndexIn(base.slides, from);
  const b = slideIndexIn(base.slides, to);
  if (a < 0 || b < 0) return base;

  const slides = base.slides.slice();
  slides.splice(b, 0, slides.splice(a, 1)[0]);
  return normalizeDocument({ ...base, slides });
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
 * two saves (with the same doc-level `aspect` / `strategy` / `anchorY` /
 * `spanLayers`, which the caller folds in) mean the slide can reuse its
 * existing render instead of re-encoding.
 *
 * @param {*} slide
 * @param {string} [aspect] doc-level aspect, included in the hash when given
 * @param {{ strategy?: string, anchorY?: number, spanLayers?: * }} [deck]
 *   doc-level inputs that reach into a single slide's pixels: the split
 *   strategy and vertical anchor, a change to either re-slicing every column,
 *   and the span layers, which paint across this slide whether it knows about
 *   them or not. Folding them in invalidates the cached render, which is the
 *   point — `specHash` sees one slide and cannot find them itself
 * @returns {string}
 */
export function specHash(slide, aspect = '', deck = {}) {
  const s = normalizeSlide(slide);
  return fnv1a(
    stableStringify({
      aspect,
      strategy: deck.strategy ?? '',
      anchorY: deck.anchorY ?? null,
      spanLayers: normalizeLayers(deck.spanLayers),
      source: s.source,
      crop: s.crop,
      fit: s.fit,
      bg: s.bg,
      layers: s.layers,
    }),
  );
}
