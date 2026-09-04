/**
 * Carousel Studio — the draw layer.
 *
 * A thin, branch-free sequencer over `geometry.js`: it fetches one source
 * image, asks geometry for the per-slide source rects, then — once per slide —
 * decodes that rect cropped and resampled straight to the slide canvas and
 * encodes it. Every measurement comes from geometry; every side effect —
 * decode, canvas creation, encode, upload — goes through the injected `deps`
 * object, so the logic never touches `document` or the network directly and a
 * test drives it with a recording fake.
 *
 * Memory: one decode per slide, cropped + resized in the same
 * `createImageBitmap` call, so the decoder never holds more than a single
 * `slideW × slideH` RGBA (~5.8 MB at 4:5) regardless of source megapixels or
 * slide count — a harder bound than the 4096px strip cap it replaced. Each
 * bitmap is closed before the next slide. Trade-off: `n` JPEG decodes instead
 * of one; accepted, because it is what makes the 1:1 mapping real and lets the
 * render report per-slide progress. See `docs/features/carousel-studio.md`.
 */

import { canvasSize, sliceRects } from './geometry.js';
import { deleteMedia, uploadMedia } from '../../api/media.js';

/** Fixed so identical inputs encode to identical bytes → SHA256 dedup reuses
 *  the same media row and re-render is idempotent. */
const JPEG_QUALITY = 0.92;
const JPEG_TYPE = 'image/jpeg';

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
    upload: (file, meta) => uploadMedia(file, meta),
    deleteMedia: (id) => deleteMedia(id),
  };
}

/**
 * Paint one slide: clear the canvas, fill the pad region (`pad` slides only,
 * from `bg`), then blit the decoded column 1:1 — the bitmap is already cropped
 * and scaled to `rect.dw × rect.dh` by `deps.decode`. Pure call-issuer — no
 * measurement — so a recording fake ctx can assert the exact sequence, and the
 * pad fill always precedes the blit.
 *
 * @param {any} ctx 2D context
 * @param {ImageBitmap} bitmap the decoded column, sized `rect.dw × rect.dh`
 * @param {{dx:number,dy:number,dw:number,dh:number,pad?:{x:number,w:number}}} rect from `sliceRects`
 * @param {number} w canvas width
 * @param {number} h canvas height
 * @param {{type?:string,color?:string,radius?:number}|null} [bg] fill for the pad region
 */
export function paintSlide(ctx, bitmap, rect, w, h, bg) {
  ctx.clearRect(0, 0, w, h);
  if (rect.pad) {
    if (bg && bg.type === 'solid') {
      ctx.fillStyle = bg.color || '#000000';
      ctx.fillRect(rect.pad.x, 0, rect.pad.w, h);
    } else {
      // blur (the default): the short column stretched across the whole canvas
      // under a blur, so the tail slide's gap bleeds instead of hard-edging.
      const radius = Math.max(1, Math.round((bg && bg.radius) || w * 0.05));
      ctx.save();
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(bitmap, 0, 0, rect.dw, rect.dh, 0, 0, w, h);
      ctx.restore();
    }
  }
  ctx.drawImage(bitmap, rect.dx, rect.dy, rect.dw, rect.dh);
}

/**
 * Slice one source image into `n` slide JPEGs — one crop-and-resize decode per
 * slide, each painted + encoded onto its own `slideW × slideH` canvas. A `null`
 * from `deps.encode` is a hard error — a silently dropped slide would be worse.
 *
 * @param {{
 *   source: string,
 *   n: number,
 *   aspect: string,
 *   strategy?: 'cover'|'exact'|'pad',
 *   anchorY?: number,
 *   bg?: {type?:string}|null,
 *   srcW?: number,
 *   srcH?: number,
 * }} spec  `srcW`/`srcH` skip the `probeSize` call when the caller already knows them
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
  const slides = [];
  for (let i = 0; i < rects.length; i++) {
    if (keep && keep[i]) {
      slides.push(null);
      onProgress?.({ done: i + 1, total: rects.length });
      continue;
    }
    const rect = rects[i];
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
      paintSlide(ctx, bitmap, rect, slideW, slideH, bg);
      const encoded = await deps.encode(canvas, JPEG_TYPE, JPEG_QUALITY);
      if (!encoded) {
        throw new Error('carousel render: canvas.toBlob returned null (encoder failure)');
      }
      slides.push(encoded);
    } finally {
      bitmap.close?.();
    }
    onProgress?.({ done: i + 1, total: rects.length });
  }
  return slides;
}

/**
 * Render a split deck and upload each slide as a post-owned media file.
 *
 * `post_id` is set on every upload so the slides are never flagged as orphans
 * (`ListOrphanedMedia` keys on `post_id IS NULL`). Returns the uploaded media
 * rows in deck order, ready for `slides[].rendered`.
 *
 * @param {{ source: string, n: number, aspect: string, postId: number,
 *   strategy?: 'cover'|'exact'|'pad', anchorY?: number, bg?: {type?:string}|null,
 *   srcW?: number, srcH?: number }} spec
 * @param {RenderDeps} deps
 * @param {(p: { done: number, total: number }) => void} [onProgress] fired after each slide
 * @param {Array<{id:number,path:string}|null>} [keep]  see `renderSplit` — a
 *   kept slide is reused verbatim and never uploaded
 * @returns {Promise<Array<{ id: number, path: string }>>}
 */
export async function renderAndUpload(spec, deps, onProgress, keep) {
  const blobs = await renderSplit(spec, deps, onProgress, keep);
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
