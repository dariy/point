/**
 * Pages API — compound endpoints that bundle multiple resources in one request.
 *
 * Backend prefix: /api/pages
 */

import { api } from './client.js';

/**
 * Home page data: recent posts, tag cloud, public settings.
 *
 * @param {{ page?: number, per_page?: number }} [params]
 * @returns {Promise<{ posts: object, tag_cloud: object[], settings: object }>}
 */
export function getHomePage(params = {}) {
  return api.get('/api/pages/home', params);
}

/**
 * Tag page data: tag info, breadcrumbs, posts filtered to that tag.
 *
 * @param {string} slug
 * @param {{ page?: number, per_page?: number }} [params]
 * @returns {Promise<{ tag: object, breadcrumbs: object[], posts: object }>}
 */
export function getTagPage(slug, params = {}) {
  return api.get(`/api/pages/tag/${encodeURIComponent(slug)}`, params);
}

/**
 * Tags index page data: full tag list with hierarchy + total.
 *
 * @returns {Promise<{ tags: object[], total: number }>}
 */
export function getTagsPage() {
  return api.get('/api/pages/tags');
}

/**
 * Map page data: tags with coordinates, categorised as country / city / other.
 *
 * @returns {Promise<{ tags: Array<{name,slug,post_count,lat,lng,type}> }>}
 */
export function getMapPage() {
  return api.get('/api/pages/map');
}
