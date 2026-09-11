/**
 * Carousel Studio — the template gallery's arithmetic.
 *
 * A template envelope inlines its images as `data:` URLs (see
 * `import/adapter.js`), and a carousel document must not: `render.js`'s
 * `fetchBlob` is a same-origin GET of a content path, and the studio's CSS
 * preview points a `background-image` at the same path. So applying a template
 * has one job this module answers the questions for — turn every inlined asset
 * into a real, post-owned media file and rewrite the document to name it.
 *
 * Everything here is pure: it walks documents, decodes base64 and counts bytes.
 * The uploading, the unwinding of a half-done upload and the toast are
 * `index.js`'s, which is the only half that can fail halfway.
 */

import { ASSET_LIMITS, fromDataUrl } from '../import/adapter.js';

/**
 * The caps the studio checks *before* a template is stored, so an oversized
 * deck is refused by the name of the image that broke it rather than by a 413
 * from `POST /api/carousel/templates`. The same two numbers the importers
 * budget against — one source, so a template that survives an import cannot be
 * rejected by the save that follows it.
 */
export { ASSET_LIMITS };

/** Megabytes, one decimal — `adapter.js`'s spelling, for messages that sit
 *  beside each other in the same report. */
const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

const isObj = (v) => v != null && typeof v === 'object';

/** Is this the kind of source that has to be materialized before it renders? */
const isInlined = (v) => typeof v === 'string' && v.startsWith('data:');

/**
 * A template's slug: what the store is keyed by, and what
 * `templateSlugPattern` (`api/internal/api/carousel.go`) accepts — lowercase
 * alphanumerics with hyphen or underscore inside, alphanumeric at both ends,
 * 100 characters at the outside.
 *
 * Derived from the name, and then *editable*, which is why this is a function
 * and not a field of the save dialog: the studio offers what the name suggests
 * and the author overrules it.
 *
 * @param {string} name
 * @returns {string}
 */
export function templateSlug(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 100)
    .replace(/[-_]+$/, '');
  return slug || 'template';
}

/**
 * A slug nothing in `taken` is already using: `bold-quote`, then
 * `bold-quote-2`, and so on.
 *
 * An import derives its slug from a filename, and two exports of one deck
 * carry one filename — so without this, importing a revision would silently
 * replace the template the author had already adapted. The store's upsert is
 * deliberate (it is what makes "save as template" idempotent), which means the
 * caller that must *not* replace is the one that has to say so.
 *
 * @param {string} slug
 * @param {Iterable<string>} taken
 * @returns {string}
 */
export function freeSlug(slug, taken) {
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  for (let n = 2; n < 1000; n++) {
    const next = `${slug.slice(0, 96)}-${n}`;
    if (!used.has(next)) return next;
  }
  return `${slug.slice(0, 96)}-${Date.now().toString(36).slice(-3)}`;
}

/**
 * @typedef {object} DocAsset
 * @property {string} url the `data:` URL, verbatim
 * @property {string} where what to call it in a message a person reads
 */

/**
 * Every inlined asset one document carries, in paint order and deduplicated —
 * a logo on eight slides is one upload and one media row, which is the whole
 * reason this returns a list of URLs rather than a list of places.
 *
 * @param {*} doc a normalized carousel document
 * @returns {DocAsset[]}
 */
export function dataAssets(doc) {
  /** @type {Map<string, DocAsset>} */
  const found = new Map();
  const add = (url, where) => {
    if (isInlined(url) && !found.has(url)) found.set(url, { url, where });
  };

  const slides = isObj(doc) && Array.isArray(doc.slides) ? doc.slides : [];
  slides.forEach((slide, i) => {
    add(slide?.source, `slide ${i + 1}`);
    (slide?.layers || []).forEach((layer, j) => add(layer?.source, `slide ${i + 1}, layer ${j + 1}`));
  });
  const span = isObj(doc) && Array.isArray(doc.spanLayers) ? doc.spanLayers : [];
  span.forEach((layer, j) => add(layer?.source, `deck layer ${j + 1}`));

  return [...found.values()];
}

/**
 * The document with every inlined asset swapped for the path `paths` gives it.
 *
 * A URL with no entry is left alone rather than blanked: the caller uploads
 * all of them or none of them (a partial upload is unwound, see
 * `_materializeAssets` in `index.js`), so a miss here means a bug, and a
 * document that still says `data:` fails loudly at render instead of quietly
 * losing an image.
 *
 * The input is not mutated, and the result still has to go through
 * `normalizeDocument` — this only rewrites strings.
 *
 * @param {*} doc
 * @param {Map<string, string>|Record<string, string>} paths url → content path
 * @returns {*}
 */
export function replaceAssets(doc, paths) {
  const at = (url) =>
    (paths instanceof Map ? paths.get(url) : paths?.[url]) || url;
  const layer = (l) => (isInlined(l?.source) ? { ...l, source: at(l.source) } : l);

  return {
    ...doc,
    slides: (doc?.slides || []).map((s) => ({
      ...s,
      source: isInlined(s?.source) ? at(s.source) : s?.source,
      layers: (s?.layers || []).map(layer),
    })),
    spanLayers: (doc?.spanLayers || []).map(layer),
  };
}

/**
 * One inlined asset decoded, with the filename an upload should carry.
 *
 * `fromDataUrl` names the file from what it is given, and an inlined image has
 * no name of its own — so the caller's `stem` is what a person later sees in
 * the media library. The extension comes from the MIME type, since that is the
 * only thing the URL actually states.
 *
 * @param {string} url
 * @param {string} stem filename without the extension
 * @returns {{bytes: Uint8Array, mime: string, name: string}|null} null when
 *   the URL is not a base64 image this can store
 */
export function decodeAsset(url, stem) {
  return fromDataUrl(url, stem);
}

/**
 * Why this template cannot be stored, or `''` when it can.
 *
 * Two caps, both checked here so the refusal can name the offending image:
 * every inlined asset against `maxAssetBytes`, and the serialized envelope
 * against `maxTotalBytes`, which is the store's own 8 MB limit
 * (`maxTemplateDocBytes`, `api/internal/api/carousel.go`). The server enforces
 * both regardless — a limit only the client keeps is not a limit — but a 413
 * says nothing about *which* photograph to shrink, and that is the only fact
 * the author can act on.
 *
 * @param {*} envelope the `toTemplate()` result about to be sent
 * @param {{maxAssetBytes?: number, maxTotalBytes?: number}} [limits]
 * @returns {string}
 */
export function templateLimitError(envelope, limits = {}) {
  const maxAsset = limits.maxAssetBytes ?? ASSET_LIMITS.maxAssetBytes;
  const maxTotal = limits.maxTotalBytes ?? ASSET_LIMITS.maxTotalBytes;

  for (const asset of dataAssets(envelope?.doc)) {
    const decoded = decodeAsset(asset.url, 'asset');
    if (!decoded) {
      return `The image on ${asset.where} is not in a format Point can store.`;
    }
    if (decoded.bytes.byteLength > maxAsset) {
      return `The image on ${asset.where} is ${mb(decoded.bytes.byteLength)}, over the ${mb(
        maxAsset,
      )} limit for one image in a template.`;
    }
  }

  // Bytes, not characters: the store's cap is `len(req.Doc)` over the encoded
  // JSON, and a deck whose type is not ASCII would otherwise be measured
  // smaller here than it arrives there.
  const size = new TextEncoder().encode(JSON.stringify(envelope ?? null)).byteLength;
  if (size > maxTotal) {
    return `This template is ${mb(size)}, over the ${mb(
      maxTotal,
    )} limit — remove or shrink some of its images.`;
  }
  return '';
}
