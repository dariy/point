/**
 * Posts API — CRUD for blog posts.
 *
 * Backend prefix: /api/posts
 */

import { api } from './client.js';
import { clearPageCache } from './pages.js';

/**
 * Short-lived read cache for post reads + navigation, so the immersive viewer
 * can prefetch an adjacent post and then navigate to it without a visible
 * reload (the route swap resolves from cache within a microtask, before paint).
 */
const _readCache = new Map();           // key -> { t, data }
const READ_CACHE_TTL_MS = 120000;       // 2 min — long enough to linger on a photo before swiping

function _cachedRead(key, fetcher) {
  const hit = _readCache.get(key);
  if (hit && Date.now() - hit.t < READ_CACHE_TTL_MS) return hit.data;
  const data = fetcher();           // a promise; cached so concurrent callers share it
  _readCache.set(key, { t: Date.now(), data });
  data.catch(() => _readCache.delete(key));   // don't cache rejections
  return data;
}

/** Clear the post read cache — called after any mutation so edits show at once. */
export function clearPostReadCache() {
  _readCache.clear();
  clearPageCache();
}

/**
 * List posts with optional filters.
 *
 * @param {{ page?: number, per_page?: number, status?: string, tag?: string, q?: string }} [params]
 * @returns {Promise<{ items: object[], total: number, page: number, per_page: number, pages: number }>}
 */
export function listPosts(params = {}) {
  return api.get('/api/posts', params);
}

/**
 * Get a single post by numeric ID.
 * @param {number} id
 * @returns {Promise<object>}
 */
export function getPost(id) {
  return api.get(`/api/posts/${id}`);
}

/**
 * Get a single post by slug (public, no auth).
 * @param {string} slug
 * @returns {Promise<object>}
 */
export function getPostBySlug(slug) {
  return _cachedRead(`slug:${slug}`, () => api.get(`/api/posts/slug/${slug}`));
}

/**
 * Create a new post.
 * @param {object} data  PostCreate payload
 * @returns {Promise<object>}
 */
export function createPost(data) {
  clearPostReadCache();
  return api.post('/api/posts', data);
}

/**
 * Update a post.
 * @param {number} id
 * @param {object} data  PostUpdate payload
 * @returns {Promise<object>}
 */
export function updatePost(id, data) {
  clearPostReadCache();
  return api.put(`/api/posts/${id}`, data);
}

/**
 * Move a post to trash (soft delete).
 * @param {number} id
 * @returns {Promise<null>}
 */
export function deletePost(id) {
  clearPostReadCache();
  return api.delete(`/api/posts/${id}`);
}

/**
 * Restore a trashed post.
 * @param {number} id
 * @returns {Promise<null>}
 */
export function restorePost(id) {
  clearPostReadCache();
  return api.post(`/api/posts/${id}/restore`);
}

/**
 * Permanently delete a post (must be in trash first).
 * @param {number} id
 * @returns {Promise<null>}
 */
export function permanentlyDeletePost(id) {
  clearPostReadCache();
  return api.delete(`/api/posts/${id}/permanent`);
}

/**
 * Get a draft post for preview via its preview token.
 * @param {string} token
 * @returns {Promise<object>}
 */
export function previewPost(token) {
  return api.get(`/api/posts/preview/${encodeURIComponent(token)}`);
}

/**
 * Generate a shareable preview link for a post (valid 7 days).
 * @param {number} id
 * @returns {Promise<{ preview_url: string, token: string, expires_at: string }>}
 */
export function generatePreviewLink(id) {
  return api.post(`/api/posts/${id}/preview`);
}

/**
 * Update post status only.
 * @param {number} id
 * @param {string} status  'draft' | 'published' | 'hidden'
 * @returns {Promise<object>}
 */
export function setPostStatus(id, status) {
  clearPostReadCache();
  return api.patch(`/api/posts/${id}/status`, { status });
}

/**
 * Update a post's tags only.
 * @param {number} id
 * @param {string[]} tags  Tag names
 * @returns {Promise<object>}
 */
export function updatePostTags(id, tags) {
  clearPostReadCache();
  return api.patch(`/api/posts/${id}/tags`, { tags });
}

/**
 * Get posts adjacent to a given post for prev/next navigation.
 * @param {number} id
 * @returns {Promise<{ prev: object|null, next: object|null }>}
 */
export function getPostNavigation(id, tag = '') {
  const key = tag ? `nav:${id}:${tag}` : `nav:${id}`;
  return _cachedRead(key, () => api.get(`/api/posts/${id}/navigation`, tag ? { tag } : undefined));
}

/**
 * Find which home-feed (or tag-feed) page contains the given post.
 * @param {string} slug
 * @param {Object} [params] e.g. { tag: 'travel' }
 * @returns {Promise<{ page: number, per_page: number }>}
 */
export function getPostPageLocation(slug, params = {}) {
  return api.get(`/api/posts/${slug}/page`, params);
}

/**
 * Manually cross-post a post to Instagram.
 * @param {number} id
 * @returns {Promise<object>}  Updated post with instagram_status/error fields
 */
export function publishPostToInstagram(id) {
  return api.post(`/api/posts/${id}/instagram/publish`);
}

/** Render markdown content to HTML for preview. */
export function previewRender(content) {
  return api.post('/api/posts/preview-render', { content });
}
