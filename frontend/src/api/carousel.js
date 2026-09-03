/**
 * Carousel API — the Carousel Studio document, one per post.
 *
 * Backend prefix: /api/carousel — gated by the `carousel` plugin, so every call
 * here 404s when the plugin is disabled. The post id rides in `?post=<id>` on
 * every verb; there is no path parameter.
 *
 * `doc` is the carousel document (see plugins/carousel/document.js). The server
 * stores and returns it verbatim, validating only that it is a JSON object.
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
