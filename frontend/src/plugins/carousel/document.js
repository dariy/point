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

/** Bumped only on a breaking schema change; present since the first commit. */
export const DOC_VERSION = 1;

export const ASPECTS = ['4:5', '1:1', '1.91:1'];
export const MODES = ['split', 'deck'];
export const FITS = ['cover', 'contain'];
export const BG_TYPES = ['blur', 'solid', 'gradient'];

const DEFAULT_ASPECT = '4:5';
const DEFAULT_MODE = 'split';
const DEFAULT_FIT = 'cover';

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
 * @typedef {object} CarouselSlide
 * @property {string} source
 * @property {CarouselCrop} crop
 * @property {'cover'|'contain'} fit
 * @property {{type:string}|null} bg
 * @property {object[]} layers
 * @property {CarouselRendered|null} rendered
 */

/**
 * @typedef {object} CarouselDoc
 * @property {number} version
 * @property {string} aspect
 * @property {string} mode
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

/** @param {*} bg @returns {{type:string}|null} */
function normalizeBg(bg) {
  if (!isObj(bg) || !BG_TYPES.includes(bg.type)) return null;
  return { ...bg, type: bg.type };
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
 * @param {{ source: string, n: number, aspect: string }} spec
 * @returns {CarouselDoc}
 */
export function splitDocument({ source, n, aspect }) {
  const count = Math.max(1, Math.floor(n));
  return normalizeDocument({
    version: DOC_VERSION,
    aspect,
    mode: 'split',
    slides: Array.from({ length: count }, (_, i) => ({
      source,
      crop: { x: i / count, y: 0, w: 1 / count, h: 1 },
    })),
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
 * two saves (with the same doc-level `aspect`, which the caller folds in) mean
 * the slide can reuse its existing render instead of re-encoding.
 *
 * @param {*} slide
 * @param {string} [aspect] doc-level aspect, included in the hash when given
 * @returns {string}
 */
export function specHash(slide, aspect = '') {
  const s = normalizeSlide(slide);
  return fnv1a(
    stableStringify({
      aspect,
      source: s.source,
      crop: s.crop,
      fit: s.fit,
      bg: s.bg,
      layers: s.layers,
    }),
  );
}
