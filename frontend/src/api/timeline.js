import { api } from './client.js';

/**
 * Fetch timeline payload (pills and extent).
 *
 * @param {Object} params
 * @param {string} [params.context]  Optional context tag slug
 * @returns {Promise<Object>}
 */
export function getTimeline({ context } = {}) {
  const params = {};
  if (context) params.context = context;
  return api.get('/api/timeline', params);
}

/**
 * Fetch location tags co-occurring with a specific date tag.
 *
 * @param {Object} params
 * @param {string} params.tag       Date tag slug
 * @param {string} [params.context] Optional context tag slug
 * @param {number} [params.limit]   Optional results limit (default 10)
 * @returns {Promise<Array>}
 */
export function getTimelineLocations({ tag, context, limit } = {}) {
  const params = { tag };
  if (context) params.context = context;
  if (limit) params.limit = limit;
  return api.get('/api/timeline/locations', params);
}
