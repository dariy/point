/**
 * Utility API — miscellaneous helper endpoints.
 *
 * Backend prefix: /api/util
 */

import { api } from './client.js';

/**
 * Extract coordinates from a maps URL or coordinate string.
 * Accepts Google/Apple Maps URLs (including short links) and degree notation
 * strings such as "45.50777° N, 73.55446° W".
 *
 * @param {string} q  URL or coordinate string
 * @returns {Promise<{ lat: number, lng: number }>}
 */
export function parseMapsCoords(q) {
  return api.get('/api/util/parse-maps-coords', { q });
}
