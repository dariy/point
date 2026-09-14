/**
 * Posts API — CRUD for blog posts.
 *
 * Backend prefix: /api/posts
 */

import { api } from './client.js';
import { clearPageCache } from './pages.js';

/**
 * A tag as it rides along on a post. `inherited` marks an ancestor the post is
 * matched by but not tagged with (the card and tag strip leave those out);
 * coordinates are present only on place tags.
 *
 * @typedef {object} PostTag
 * @property {string} name
 * @property {string} slug
 * @property {string} [kind]
 * @property {boolean} [inherited]
 * @property {number} [latitude]
 * @property {number} [longitude]
 * @property {boolean} [is_hidden_posts]  Admin responses only.
 */

/**
 * A media file a single-post response embeds, in the order the body uses it.
 *
 * @typedef {object} PostMediaRef
 * @property {string} path  Public path, e.g. "/2026/03/ts_file.jpg".
 * @property {string|null} alt_text
 * @property {Record<string, any>|null} metadata  EXIF and the like, as stored.
 */

/**
 * A post as the API returns it. One shape with three projections, which is why
 * so much of it is optional: list responses (the grid, the admin table) drop
 * `content` and `css`; single-post responses add `content_html`, `media` and
 * `thumbnail_path` but not `media_url`; admin responses add the `is_hidden*`
 * and `instagram_*` fields. See postToResponse / buildPostResponse in
 * api/internal/api.
 *
 * @typedef {object} Post
 * @property {number} id
 * @property {string} title
 * @property {string} slug
 * @property {string} type  'post' | 'page'
 * @property {string} status  'draft' | 'published' | 'hidden' | 'scheduled' | 'deleted'
 * @property {string} formatter
 * @property {string} immersive_mode
 * @property {string} [content]  Source markdown. Absent from list responses.
 * @property {string} [css]  Per-post CSS. Absent from list responses.
 * @property {string} [content_html]  Rendered body. Single-post responses only.
 * @property {string|null} excerpt
 * @property {string|null} meta_description
 * @property {boolean} is_featured
 * @property {number} view_count
 * @property {string|null} published_at
 * @property {string|null} scheduled_at
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string|null} [media_url]  First image, for cards. List responses.
 * @property {string|null} [thumbnail_path]  Single-post responses.
 * @property {PostTag[]} tags
 * @property {PostMediaRef[]} [media]  Single-post responses.
 * @property {boolean} [is_hidden]
 * @property {boolean} [is_hidden_by_tag]
 * @property {boolean} [instagram_share]
 * @property {string} [instagram_status]
 * @property {string|null} [instagram_media_id]
 * @property {string|null} [instagram_published_at]
 * @property {string|null} [instagram_error]
 */

/**
 * Just enough of a post to link to it — the prev/next navigation payload.
 *
 * @typedef {{ id: number, title: string, slug: string }} PostStub
 */

/**
 * One page of a post listing.
 *
 * @typedef {object} PostPage
 * @property {Post[]} posts
 * @property {number} total
 * @property {number} page
 * @property {number} per_page
 * @property {number} pages
 */

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
 * @param {{ page?: number, per_page?: number, status?: string, type?: string, tag?: string, q?: string }} [params]
 * @returns {Promise<PostPage & { tag?: import('./tags.js').Tag }>}
 */
export function listPosts(params = {}) {
  return api.get('/api/posts', params);
}

/**
 * Get a single post by numeric ID.
 * @param {number} id
 * @returns {Promise<Post>}
 */
export function getPost(id) {
  return api.get(`/api/posts/${id}`);
}

/**
 * Get a single post by slug (public, no auth).
 * @param {string} slug
 * @returns {Promise<Post>}
 */
export function getPostBySlug(slug) {
  return _cachedRead(`slug:${slug}`, () => api.get(`/api/posts/slug/${slug}`));
}

/**
 * Create a new post.
 * @param {object} data  PostCreate payload
 * @returns {Promise<Post>}
 */
export function createPost(data) {
  clearPostReadCache();
  return api.post('/api/posts', data);
}

/**
 * Update a post.
 * @param {number} id
 * @param {object} data  PostUpdate payload
 * @returns {Promise<Post>}
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
 * @returns {Promise<Post>}
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
 * @returns {Promise<Post>}
 */
export function setPostStatus(id, status) {
  clearPostReadCache();
  return api.patch(`/api/posts/${id}/status`, { status });
}

/**
 * Update a post's tags only.
 * @param {number} id
 * @param {string[]} tags  Tag names
 * @returns {Promise<Post>}
 */
export function updatePostTags(id, tags) {
  clearPostReadCache();
  return api.patch(`/api/posts/${id}/tags`, { tags });
}

/**
 * Get posts adjacent to a given post for prev/next navigation.
 * @param {number} id
 * @returns {Promise<{ prev: PostStub|null, next: PostStub|null }>}
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
 * @returns {Promise<Post>}  Updated post with instagram_status/error fields
 */
export function publishPostToInstagram(id) {
  return api.post(`/api/posts/${id}/instagram/publish`);
}

/**
 * Render markdown content to HTML for preview.
 * @param {string} content
 * @returns {Promise<{ html: string }>}
 */
export function previewRender(content) {
  return api.post('/api/posts/preview-render', { content });
}
