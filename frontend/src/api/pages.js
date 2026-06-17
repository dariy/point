/**
 * Pages API — compound endpoints that bundle multiple resources in one request.
 *
 * Backend prefix: /api/pages
 */

import { api } from './client.js';

/**
 * Short-lived read cache for the paginated list pages, so the public grid can
 * preload the previous/next page and then navigate to it without a visible
 * reload (the swipe-committed route swap resolves from cache within a
 * microtask, before paint). Mirrors the post read cache in posts.js.
 */
const _pageCache = new Map();           // key -> { t, data }
const PAGE_CACHE_TTL_MS = 60000;        // 1 min — long enough to linger before swiping

function _cachedPage(key, fetcher) {
  const hit = _pageCache.get(key);
  if (hit && Date.now() - hit.t < PAGE_CACHE_TTL_MS) return hit.data;
  const data = fetcher();           // a promise; cached so concurrent callers share it
  _pageCache.set(key, { t: Date.now(), data });
  data.catch(() => _pageCache.delete(key));   // don't cache rejections
  return data;
}

/** Clear the list-page cache — called after any post mutation so edits show at once. */
export function clearPageCache() {
  _pageCache.clear();
}

/**
 * Home page data: recent posts, tag cloud, public settings.
 *
 * @param {{ page?: number, per_page?: number }} [params]
 * @returns {Promise<{ posts: object, tag_cloud: object[], settings: object }>}
 */
export function getHomePage(params = {}) {
  return _cachedPage(`home:${JSON.stringify(params)}`, () => api.get('/api/pages/home', params));
}

/**
 * Tag page data: tag info, breadcrumbs, posts filtered to that tag.
 *
 * @param {string} slug
 * @param {{ page?: number, per_page?: number }} [params]
 * @returns {Promise<{ tag: object, breadcrumbs: object[], posts: object }>}
 */
export function getTagPage(slug, params = {}) {
  return _cachedPage(
    `tag:${slug}:${JSON.stringify(params)}`,
    () => api.get(`/api/pages/tags/${encodeURIComponent(slug)}`, params),
  );
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
 * Tags graph data: tag nodes, post ("shadow") nodes, and the two edge sets
 * (parent/child hierarchy + post→tag membership) for the /tags force graph.
 *
 * @returns {Promise<{
 *   tags: Array<{id:number,name:string,slug:string,kind:string,latitude?:number,longitude?:number,post_count:number}>,
 *   posts: Array<{id:number,slug:string,title:string}>,
 *   hierarchyEdges: Array<{parent:number,child:number}>,
 *   membershipEdges: Array<{post:number,tag:number}>
 * }>}
 */
export function getTagsGraph() {
  return api.get('/api/pages/graph');
}

/**
 * Map page data: tags with coordinates, categorised as country / city / other.
 *
 * @param {{ year_from?: number, year_to?: number }} [params]
 * @returns {Promise<{ tags: Array<{name,slug,post_count,lat,lng,type}> }>}
 */
export function getMapPage(params = {}) {
  return api.get('/api/pages/map', params);
}

/**
 * Navigation menu: hierarchical tag tree scoped to the current user's auth level.
 * Guests receive only public/visible tags; admins receive all tags.
 *
 * @returns {Promise<{ menu: object[] }>}
 */
export function getNavMenu() {
  return api.get('/api/pages/nav');
}

/**
 * Admin: get current nav menu config (mode + custom items).
 *
 * @returns {Promise<{ mode: string, items: object[] }>}
 */
export function getAdminNavMenu() {
  return api.get('/api/nav-menu');
}

/**
 * Admin: save nav menu config.
 *
 * @param {{ mode: string, items: object[] }} data
 * @returns {Promise<{ mode: string, items: object[] }>}
 */
export function updateAdminNavMenu(data) {
  return api.put('/api/nav-menu', data);
}
