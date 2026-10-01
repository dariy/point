/**
 * Utility API — miscellaneous helper endpoints.
 *
 * Backend prefix: /api/util
 */

import { api } from './client.ts';

/**
 * Extract coordinates from a maps URL or coordinate string.
 * Accepts Google/Apple Maps URLs (including short links) and degree notation
 * strings such as "45.50777° N, 73.55446° W".
 *
 * @param q - URL or coordinate string
 */
export function parseMapsCoords(q: string): Promise<{ lat: number, lng: number }> {
  return api.get('/api/util/parse-maps-coords', { q });
}
