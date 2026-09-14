/**
 * Pages API — compound endpoints that bundle multiple resources in one request.
 *
 * Backend prefix: /api/pages
 */

import { api } from './client.js';

/**
 * A feed paginator — paginationResponse in api/internal/api/pages.go. A pinned
 * home page carries only the first four fields.
 *
 * @typedef {object} Pagination
 * @property {number} page
 * @property {number} per_page
 * @property {number} total
 * @property {number} pages
 * @property {number} [min_page]  How far left the feed extends: 1, or 0 and
 *   below for an owner with scheduled posts queued.
 * @property {boolean} [scheduled]  This page came from the scheduled half.
 */

/**
 * @typedef {object} TagCloudItem
 * @property {number} id
 * @property {string} name
 * @property {string} slug
 * @property {number} count
 * @property {number} weight
 */

/**
 * The tag a tag archive is about — tagToFullResponse, which is the single-tag
 * payload without the graph annotations, plus two visibility flags for admins.
 *
 * @typedef {Omit<import('./tags.js').Tag, 'effective_hidden'|'effective_hides_posts'|'hidden_via'>
 *   & { is_hidden?: boolean, is_hidden_posts?: boolean }} ArchiveTag
 */

/**
 * One step of a tag archive's breadcrumb trail. `href` is set only when the
 * request carried an explicit path; without it the crumb links to the tag.
 *
 * @typedef {object} Crumb
 * @property {number} id
 * @property {string} name
 * @property {string} name_path
 * @property {string} slug
 * @property {number|null} nav_order
 * @property {number} post_count
 * @property {string} [href]
 * @property {boolean} [is_hidden]  Admin only.
 * @property {boolean} [is_hidden_posts]  Admin only.
 */

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
 * @returns {Promise<{
 *   posts: import('./posts.js').Post[],
 *   pagination: Pagination,
 *   settings: import('./settings.js').Settings,
 *   tag_cloud?: TagCloudItem[],
 *   menu?: import('./nav.js').NavTagNode[],
 * }>}  tag_cloud and menu ride on the first, unfiltered page only.
 */
export function getHomePage(params = {}) {
  return _cachedPage(`home:${JSON.stringify(params)}`, () => api.get('/api/pages/home', params));
}

/**
 * Tag page data: tag info, breadcrumbs, posts filtered to that tag.
 *
 * @param {string} slug
 * @param {{ page?: number, per_page?: number }} [params]
 * @returns {Promise<{
 *   tag: ArchiveTag,
 *   breadcrumbs: Crumb[],
 *   posts: import('./posts.js').Post[],
 *   pagination: Pagination,
 *   menu: import('./nav.js').NavTagNode[],
 *   nav_children: import('./nav.js').NavTagNode[],
 * }>}
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
 * @returns {Promise<{ tags: Array<import('./tags.js').Tag & { is_hidden?: boolean }>, total: number }>}
 */
export function getTagsPage() {
  return api.get('/api/pages/tags');
}

/**
 * Tags graph data: tag nodes + parent/child hierarchy edges, plus post ("shadow")
 * nodes and post→tag membership edges for the /tags force-graph (cloud) view.
 *
 * Pass `{ posts: 0 }` to omit posts + membership edges — the Atlas does this and
 * lazily fetches each place's recent posts on tap via getTagCloud, so the whole
 * post set never loads up front.
 *
 * @param {{ posts?: 0 }} [params]
 * @returns {Promise<{
 *   tags: Array<{id:number,name:string,slug:string,kind:string,latitude?:number,longitude?:number,post_count:number}>,
 *   hierarchyEdges: Array<{parent:number,child:number}>,
 *   posts?: Array<{id:number,slug:string,title:string,media_url?:string}>,
 *   membershipEdges?: Array<{post:number,tag:number}>
 * }>}
 */
export function getTagsGraph(params = {}) {
  return api.get('/api/pages/graph', params);
}

/**
 * The Atlas cloud for a single place: its sub-tree's 10 most recent posts and 10
 * most popular co-occurring tags, plus the membership/hierarchy edges wiring that
 * subset together. Optionally scoped to a timeline year range.
 *
 * @param {number} tagId
 * @param {{ year_from?: number, year_to?: number }} [params]
 * @returns {Promise<{
 *   tags: Array<{id:number,name:string,slug:string,kind:string,latitude?:number,longitude?:number}>,
 *   posts: Array<{id:number,slug:string,title:string,media_url?:string}>,
 *   membershipEdges: Array<{post:number,tag:number}>,
 *   hierarchyEdges: Array<{parent:number,child:number}>
 * }>}
 */
export function getTagCloud(tagId, params = {}) {
  return api.get(`/api/pages/graph/tag/${tagId}`, params);
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

