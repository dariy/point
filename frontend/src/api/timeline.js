import { api } from './client.js';

/**
 * One year or decade tag on the timeline — services.TimelinePill.
 *
 * @typedef {object} TimelinePill
 * @property {string} slug
 * @property {string} name
 * @property {number} year  The decade's first year when `is_decade`.
 * @property {boolean} is_decade
 * @property {number} post_count
 */

/**
 * GET /api/timeline — services.TimelinePayload. The server answers 404 rather
 * than send an empty `pills`.
 *
 * @typedef {object} TimelinePayload
 * @property {TimelinePill[]} pills
 * @property {{ min: number, max: number }} extent  First and last year.
 */

/**
 * A location tag and how many of the date tag's posts it shares —
 * services.LocationLink.
 *
 * @typedef {{ slug: string, name: string, post_count: number }} LocationLink
 */

/**
 * Fetch timeline payload (pills and extent).
 *
 * @param {object} params
 * @param {string} [params.context]  Optional context tag slug
 * @returns {Promise<TimelinePayload>}
 */
export function getTimeline({ context } = {}) {
  /** @type {Record<string, string|number|boolean>} */
  const params = {};
  if (context) params.context = context;
  return api.get('/api/timeline', params);
}

/**
 * Fetch location tags co-occurring with a specific date tag.
 *
 * @param {object} params
 * @param {string} params.tag       Date tag slug
 * @param {string} [params.context] Optional context tag slug
 * @param {number} [params.limit]   Optional results limit (default 10)
 * @returns {Promise<LocationLink[]>}
 */
export function getTimelineLocations({ tag, context, limit }) {
  /** @type {Record<string, string|number|boolean>} */
  const params = { tag };
  if (context) params.context = context;
  if (limit) params.limit = limit;
  return api.get('/api/timeline/locations', params);
}
