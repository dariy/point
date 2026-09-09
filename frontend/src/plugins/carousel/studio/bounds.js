/**
 * The studio's slide-count bounds.
 *
 * Shared by the state owner (`index.js`, which clamps every count it writes
 * into a document) and the markup (`studio/panels.js`, whose count slider and
 * suggestion chips have to offer exactly that range) — one definition, so the
 * control cannot offer a count the document would refuse.
 */

/** Instagram accepts up to 20 images per carousel
 *  (`api/internal/services/post_publish.go` truncates there;
 *  `docs/features/carousel-studio.md` says 2–20) — the studio spans the range. */
export const MIN_SLIDES = 2;
export const MAX_SLIDES = 20;
export const DEFAULT_SLIDES = 3;

/** Clamp a slide count into the studio's bounds. */
export const clampSlides = (v) => Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, Math.floor(v)));
