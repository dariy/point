/**
 * mediaUrl — the client half of the thumbnail ladder.
 *
 * A variant URL is `/YYYY/MM/file.jpg?s=<rung>&v=<generation>`. `s` selects a
 * rung of the ladder the server derives — the cap on the LONGEST side, aspect
 * ratio preserved, never upscaled — and `v` is the cache-busting token a
 * thumbnail rebuild rolls. `v` never selects bytes, it only decides how hard the
 * response may be cached, so a URL without one still resolves; it simply cannot
 * be pinned.
 *
 * Both the ladder and the token ride in `window.__MEDIA__`, injected into every
 * HTML document (bootstrapScript, api/cmd/api/main.go). Reading them from there
 * rather than from a copy is what keeps the two ends from drifting; THUMB_SIZES
 * below is only the fallback for a document that carries no bootstrap — node
 * tests, and a shell a service worker serves offline.
 */

import { html } from "./helpers.js";

/**
 * The ladder as of this build, and the fallback when `window.__MEDIA__` is
 * absent. Mirrors services.VariantSizes. Prefer thumbLadder(), which asks the
 * server's copy first.
 */
export const THUMB_SIZES = [128, 256, 512, 1024];

/**
 * The rung a bare `?thumb` resolves to server-side (services.DefaultVariantSize),
 * and the rung `src` aims at when a browser ignores `srcset`.
 */
export const DEFAULT_THUMB_SIZE = 512;

/** The `window.__MEDIA__` payload, or null outside a bootstrapped document. */
function bootstrap() {
  return (typeof window !== "undefined" && window.__MEDIA__) || null;
}

/** The server's ladder when it shipped one, else this build's copy. */
export function thumbLadder() {
  const sizes = bootstrap()?.sizes;
  return Array.isArray(sizes) && sizes.length ? sizes : THUMB_SIZES;
}

/** The current generation token, or "" when there is no bootstrap to read. */
function generation() {
  const gen = bootstrap()?.gen;
  return typeof gen === "string" ? gen : "";
}

/**
 * The path with any query stripped. Callers hand over paths that already carry
 * one — `posts.thumbnail_path` and published post content still say `?thumb`,
 * the media API's `thumbnail_path` says `?s=512&v=…` — and a rung must replace
 * that query, never append to it.
 */
function barePath(path) {
  const s = String(path ?? "");
  const q = s.indexOf("?");
  return q >= 0 ? s.slice(0, q) : s;
}

/**
 * The rung to actually ask for. The route rejects a size off the ladder rather
 * than clamping it, so snapping here turns a caller's stray number into a soft
 * thumbnail instead of a wall of 400s. Rounds up: a rung below the requested
 * size would be visibly upscaled.
 */
function nearestRung(size) {
  const ladder = thumbLadder();
  const want = Number(size);
  if (!Number.isFinite(want)) return DEFAULT_THUMB_SIZE;
  for (const rung of ladder) if (rung >= want) return rung;
  return ladder[ladder.length - 1];
}

/**
 * The URL of one ladder rung for `path`. The client twin of services.VariantURL.
 *
 * @param {string} path  media path, with or without an existing query
 * @param {number} [size]  desired rung; snapped onto the ladder
 * @returns {string} the variant URL, or "" for an empty path
 */
export function thumbUrl(path, size = DEFAULT_THUMB_SIZE) {
  const bare = barePath(path);
  if (!bare) return "";
  const rung = nearestRung(size);
  const gen = generation();
  return gen
    ? `${bare}?s=${rung}&v=${encodeURIComponent(gen)}`
    : `${bare}?s=${rung}`;
}

/**
 * A responsive candidate set for `path`: `{ src, srcset, sizes }`.
 *
 * With `width`/`height` the descriptors are exact. A rung caps the longest side,
 * so a WxH source at rung R is trunc(R * W/max(W,H)) wide — truncated, not
 * rounded, because imaging.Fit derives the short side with a Go int() conversion
 * and a descriptor one pixel over is a descriptor that is wrong. Rungs at or
 * above the longest side are never written — the server falls back to the
 * original for those — so they are dropped from the candidate list and the
 * original takes the top slot under its own URL. Emitting them anyway would hand
 * the browser four URLs serving one file, each a separate cache entry.
 *
 * Without dimensions the descriptor is the rung itself, which is the width only
 * for a landscape or square source. A portrait over-claims by its aspect ratio —
 * 1.33x for 3:4, 1.5x for 2:3 — so the browser can settle one rung lower than it
 * wanted and the image paints slightly soft. That is the accepted cost on the
 * post list, whose `post.media_url` is a denormalized string column with no
 * dimensions beside it: fixing it means a join onto the hot list query, and
 * cover-cropped 48px cards do not need the precision.
 *
 * @param {string} path
 * @param {{ sizes?: string, width?: number, height?: number }} [opts]
 *   `sizes` is passed through to the attribute of the same name; without one a
 *   browser assumes 100vw and over-fetches every thumbnail on the page.
 * @returns {{ src: string, srcset: string, sizes: string }}
 */
export function thumbSrcset(path, { sizes, width, height } = {}) {
  const bare = barePath(path);
  const sizesAttr = sizes || "";
  if (!bare) return { src: "", srcset: "", sizes: sizesAttr };

  const w = Number(width) || 0;
  const longest = Math.max(w, Number(height) || 0);
  const known = w > 0 && longest > 0;

  const ladder = thumbLadder();
  const candidates = [];
  let dropped = false;
  for (const rung of ladder) {
    if (known && rung >= longest) {
      dropped = true;
      break;
    }
    candidates.push({
      url: thumbUrl(bare, rung),
      w: known ? Math.max(1, Math.floor(rung * (w / longest))) : rung,
      rung,
    });
  }
  if (known && dropped) candidates.push({ url: bare, w, rung: 0 });
  if (!candidates.length) candidates.push({ url: bare, w: ladder[0], rung: 0 });

  // src is chosen by rung, not by descriptor: a portrait's descriptors are all
  // well under their rung, so picking the first one wide enough would walk past
  // every variant and land on the original — the one candidate a browser too old
  // for srcset can least afford.
  const rungs = candidates.filter((c) => c.rung);
  const src =
    rungs.find((c) => c.rung === DEFAULT_THUMB_SIZE) ||
    rungs[rungs.length - 1] ||
    candidates[candidates.length - 1];

  return {
    src: src.url,
    srcset: candidates.map((c) => `${c.url} ${c.w}w`).join(", "),
    sizes: sizesAttr,
  };
}

/**
 * thumbSrcset rendered as `src`/`srcset`/`sizes` attributes, for the call sites
 * that build an `<img>` as markup. Returns empty markup for an empty path, so
 * an `<img>` is never emitted with a bare `src`.
 *
 * @param {string} path
 * @param {{ sizes?: string, width?: number, height?: number }} [opts]
 * @returns {import("./helpers.js").RawHtml} the attributes, already escaped —
 *   interpolate it into an html`` template, or into a string that becomes one.
 */
export function thumbAttrs(path, opts = {}) {
  const { src, srcset, sizes } = thumbSrcset(path, opts);
  // Falsy, not html``: RawHtml('') is a String object and therefore truthy.
  if (!src) return '';
  // srcset is a comma-separated candidate list, not one URL, so it takes the
  // text policy — safeUrl() would reject the whole list. Each candidate URL in
  // it was built by thumbUrl() from the same path `src` carries.
  const attrs = html`src="${src}" srcset="${srcset}"`;
  return sizes ? html`${attrs} sizes="${sizes}"` : attrs;
}
