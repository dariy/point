/**
 * Utility API — miscellaneous helper endpoints.
 *
 * Backend prefix: /api/util
 */

import { api } from './client.js';

/**
 * Resolve a short URL (maps.app.goo.gl) to its final destination.
 *
 * @param {string} url  Short URL to resolve
 * @returns {Promise<{ url: string }>}
 */
export function resolveUrl(url) {
  return api.get('/api/util/resolve-url', { url });
}
