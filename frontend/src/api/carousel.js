/**
 * Carousel API — the Carousel Studio document, one per post.
 *
 * Backend prefix: /api/carousel — gated by the `carousel` plugin, so every call
 * here 404s when the plugin is disabled. The post id rides in `?post=<id>` on
 * every verb; there is no path parameter.
 *
 * `doc` is the carousel document (see plugins/carousel/document.js). The server
 * stores and returns it verbatim, validating only that it is a JSON object.
 *
 * The template store under /api/carousel/templates is keyed by slug instead of
 * by post, and holds the same kind of envelope.
 */

import { api } from './client.js';

/**
 * Fetch a post's carousel document.
 *
 * Rejects with `{ status: 404 }` when the post has no carousel yet — a caller
 * opening the studio should treat that as "start from an empty document".
 *
 * @param {number} postId
 * @returns {Promise<{ post_id: number, doc: object, created_at: string, updated_at: string }>}
 */
export function getCarousel(postId) {
  return api.get('/api/carousel', { post: postId });
}

/**
 * Create or replace a post's carousel document. The post must already exist.
 *
 * @param {number} postId
 * @param {object} doc  The carousel document (a JSON object).
 * @returns {Promise<{ post_id: number, doc: object, created_at: string, updated_at: string }>}
 */
export function saveCarousel(postId, doc) {
  return api.put(`/api/carousel?post=${encodeURIComponent(postId)}`, { doc });
}

/**
 * Delete a post's carousel document. Idempotent — deleting one that is not
 * there still resolves.
 *
 * @param {number} postId
 * @returns {Promise<null>}
 */
export function deleteCarousel(postId) {
  return api.delete(`/api/carousel?post=${encodeURIComponent(postId)}`);
}

// ── Templates ────────────────────────────────────────────────────────────────

/**
 * The server's cap on one stored template envelope, in bytes (8 MB). A template
 * inlines its assets as `data:` URLs, so the envelope is the whole payload.
 * Exported so a caller can reject an oversized template before uploading it;
 * `saveCarouselTemplate` rejects with `{ status: 413 }` if it gets there anyway.
 */
export const TEMPLATE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * @typedef {Object} CarouselTemplateSummary
 * @property {string} slug
 * @property {string} name
 * @property {string} created_at
 */

/**
 * @typedef {Object} CarouselTemplate
 * @property {string} slug
 * @property {string} name
 * @property {object} doc  The template envelope (a JSON object).
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * List every template, name and slug only.
 *
 * The listing deliberately carries no envelopes: a gallery of names must not
 * pull every inlined asset of every template. Call `getCarouselTemplate` for
 * the one the user picks.
 *
 * @returns {Promise<CarouselTemplateSummary[]>}
 */
export function listCarouselTemplates() {
  return api.get('/api/carousel/templates');
}

/**
 * Fetch one template envelope in full.
 *
 * Rejects with `{ status: 404 }` when no template carries that slug.
 *
 * @param {string} slug
 * @returns {Promise<CarouselTemplate>}
 */
export function getCarouselTemplate(slug) {
  return api.get(`/api/carousel/templates/${encodeURIComponent(slug)}`);
}

/**
 * Store a template under its slug, replacing any template already there — so
 * "save as template" can send the same slug twice without asking first.
 *
 * `doc` is the template envelope `toTemplate()` builds (plugins/carousel/
 * document.js). Its `id` and `name` are inside the envelope, which the server
 * never parses — so pass them here too, matching what the envelope says.
 *
 * The slug must be url-safe: lowercase letters, digits, hyphen or underscore,
 * starting and ending with a letter or digit (what `utils/slugify` emits).
 *
 * Rejects with `{ status: 400 }` on a bad slug, a missing name or a `doc` that
 * is not a JSON object, and `{ status: 413 }` past `TEMPLATE_MAX_BYTES`.
 *
 * @param {string} slug
 * @param {string} name
 * @param {object} doc  The template envelope (a JSON object).
 * @returns {Promise<CarouselTemplate>}
 */
export function saveCarouselTemplate(slug, name, doc) {
  return api.post('/api/carousel/templates', { slug, name, doc });
}

/**
 * Delete a template. Idempotent — deleting one that is not there still
 * resolves.
 *
 * @param {string} slug
 * @returns {Promise<null>}
 */
export function deleteCarouselTemplate(slug) {
  return api.delete(`/api/carousel/templates/${encodeURIComponent(slug)}`);
}
