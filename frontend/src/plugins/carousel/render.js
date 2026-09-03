/**
 * Carousel Studio — the draw layer.
 *
 * A thin, branch-free sequencer over `geometry.js`: it decodes one source
 * image, walks the rect list geometry produced, and issues `drawImage` /
 * `clearRect` onto a canvas per slide. Every measurement comes from geometry;
 * every side effect — decode, canvas creation, encode, upload — goes through
 * the injected `deps` object, so the logic never touches `document` or the
 * network directly and a test drives it with a recording fake.
 *
 * Memory: `deps.decode` is `createImageBitmap(blob, { resizeWidth, … })`, which
 * decodes-and-downscales in one step so a 50MP JPEG never lands as ~200MB of
 * RGBA in the decoder (mobile Safari kills tabs in that range). One bitmap is
 * held at a time and closed before returning. See `docs/features/carousel-studio.md`.
 */

import { canvasSize, sliceRects } from './geometry.js';
import { uploadMedia } from '../../api/media.js';

/** Fixed so identical inputs encode to identical bytes → SHA256 dedup reuses
 *  the same media row and re-render is idempotent. */
const JPEG_QUALITY = 0.92;
const JPEG_TYPE = 'image/jpeg';

/**
 * Cap the decoded strip width. Geometry wants `n · slideWidth` (≈3240px for a
 * 3-slide 4:5 deck) so each column maps ~1:1 onto its canvas; past this the
 * strip is downscaled instead, trading crispness on high slide counts for a
 * bounded RGBA footprint (a landscape source stays under ~16 MP).
 */
const MAX_STRIP_WIDTH = 4096;

/**
 * @typedef {object} RenderDeps
 * @property {(url: string) => Promise<Blob>} fetchBlob  same-origin GET of a content path
 * @property {(blob: Blob, opts: object) => Promise<ImageBitmap>} decode  createImageBitmap
 * @property {(w: number, h: number) => { canvas: any, ctx: any }} makeSurface  a fresh canvas + 2D ctx
 * @property {(canvas: any, type: string, quality: number) => Promise<Blob|null>} encode  canvas.toBlob
 * @property {(file: File, meta: object) => Promise<{ id: number, path: string }>} upload
 */

/**
 * Browser-backed deps — the one place this module names `document`, `fetch`,
 * `createImageBitmap` and the media API.
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
    decode: (blob, opts) => createImageBitmap(blob, opts),
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
    upload: (file, meta) => uploadMedia(file, meta),
  };
}

/** `min(n · slideWidth, cap)` — the width to decode the source strip at. */
export function stripWidth(n, aspect) {
  const count = Math.max(1, Math.floor(n));
  const [slideW] = canvasSize(aspect);
  return Math.min(count * slideW, MAX_STRIP_WIDTH);
}

/**
 * Paint one slide: clear the canvas, then blit its source rect. Pure
 * call-issuer — no measurement, no branching — so a recording fake ctx can
 * assert the exact sequence.
 *
 * @param {any} ctx 2D context
 * @param {ImageBitmap} bitmap the decoded strip
 * @param {{sx,sy,sw,sh,dx,dy,dw,dh}} rect from `sliceRects`
 * @param {number} w canvas width
 * @param {number} h canvas height
 */
export function paintSlide(ctx, bitmap, rect, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(
    bitmap,
    rect.sx, rect.sy, rect.sw, rect.sh,
    rect.dx, rect.dy, rect.dw, rect.dh,
  );
}

/**
 * Slice one source image into `n` slide JPEGs.
 *
 * Decodes the source once (downscaled to `stripWidth`), asks geometry for the
 * `n` gap-free source rects, and paints + encodes each onto its own
 * `slideW × slideH` canvas. A `null` from `deps.encode` is a hard error — a
 * silently dropped slide would be worse.
 *
 * @param {string} source content path of the image to split
 * @param {number} n slide count (2–10 in the UI; clamped to ≥1 here)
 * @param {string} aspect aspect key
 * @param {RenderDeps} deps
 * @returns {Promise<Blob[]>} the encoded slides, in deck order
 */
export async function renderSplit(source, n, aspect, deps) {
  const count = Math.max(1, Math.floor(n));
  const [slideW, slideH] = canvasSize(aspect);

  const blob = await deps.fetchBlob(source);
  const bitmap = await deps.decode(blob, {
    resizeWidth: stripWidth(count, aspect),
    resizeQuality: 'high',
  });

  try {
    const rects = sliceRects(bitmap.width, bitmap.height, count, aspect);
    const slides = [];
    for (const rect of rects) {
      const { canvas, ctx } = deps.makeSurface(slideW, slideH);
      paintSlide(ctx, bitmap, rect, slideW, slideH);
      const encoded = await deps.encode(canvas, JPEG_TYPE, JPEG_QUALITY);
      if (!encoded) {
        throw new Error('carousel render: canvas.toBlob returned null (encoder failure)');
      }
      slides.push(encoded);
    }
    return slides;
  } finally {
    bitmap.close?.();
  }
}

/**
 * Render a split deck and upload each slide as a post-owned media file.
 *
 * `post_id` is set on every upload so the slides are never flagged as orphans
 * (`ListOrphanedMedia` keys on `post_id IS NULL`). Returns the uploaded media
 * rows in deck order, ready for `slides[].rendered`.
 *
 * @param {{ source: string, n: number, aspect: string, postId: number }} spec
 * @param {RenderDeps} deps
 * @returns {Promise<Array<{ id: number, path: string }>>}
 */
export async function renderAndUpload(spec, deps) {
  const blobs = await renderSplit(spec.source, spec.n, spec.aspect, deps);
  const uploaded = [];
  for (let i = 0; i < blobs.length; i++) {
    const file = new File([blobs[i]], `carousel-${spec.postId}-${i + 1}.jpg`, {
      type: JPEG_TYPE,
    });
    uploaded.push(await deps.upload(file, { post_id: spec.postId }));
  }
  return uploaded;
}
