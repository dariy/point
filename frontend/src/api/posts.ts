/**
 * Posts API — CRUD for blog posts.
 *
 * Backend prefix: /api/posts
 */

import { api } from './client.ts';
import { clearPageCache } from './pages.ts';
import type { Tag } from './tags.ts';

/**
 * A tag as it rides along on a post. `inherited` marks an ancestor the post is
 * matched by but not tagged with (the card and tag strip leave those out);
 * coordinates are present only on place tags.
 */
export interface PostTag {
  name: string;
  slug: string;
  kind?: string;
  inherited?: boolean;
  latitude?: number;
  longitude?: number;
  /** Admin responses only. */
  is_hidden_posts?: boolean;
}

/** A media file a single-post response embeds, in the order the body uses it. */
export interface PostMediaRef {
  /** Public path, e.g. "/2026/03/ts_file.jpg". */
  path: string;
  alt_text: string | null;
  /** EXIF and the like, as stored. */
  metadata: Record<string, any> | null;
}

/**
 * A post as the API returns it. One shape with three projections, which is why
 * so much of it is optional: list responses (the grid, the admin table) drop
 * `content` and `css`; single-post responses add `content_html`, `media` and
 * `thumbnail_path` but not `media_url`; admin responses add the `is_hidden*`
 * and `instagram_*` fields. See postToResponse / buildPostResponse in
 * api/internal/api.
 */
export interface Post {
  id: number;
  title: string;
  slug: string;
  /** 'post' | 'page' */
  type: string;
  /** 'draft' | 'published' | 'hidden' | 'scheduled' | 'deleted' */
  status: string;
  formatter: string;
  immersive_mode: string;
  /** Source markdown. Absent from list responses. */
  content?: string;
  /** Per-post CSS. Absent from list responses. */
  css?: string;
  /** Rendered body. Single-post responses only. */
  content_html?: string;
  excerpt: string | null;
  meta_description: string | null;
  is_featured: boolean;
  view_count: number;
  published_at: string | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
  /** First image, for cards. List responses. */
  media_url?: string | null;
  /** Single-post responses. */
  thumbnail_path?: string | null;
  tags: PostTag[];
  /** Single-post responses. */
  media?: PostMediaRef[];
  is_hidden?: boolean;
  is_hidden_by_tag?: boolean;
  instagram_share?: boolean;
  instagram_status?: string;
  instagram_media_id?: string | null;
  instagram_published_at?: string | null;
  instagram_error?: string | null;
}

/** Just enough of a post to link to it — the prev/next navigation payload. */
export interface PostStub {
  id: number;
  title: string;
  slug: string;
}

/** One page of a post listing. */
export interface PostPage {
  posts: Post[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

/**
 * The body of a post create or update — CreatePostRequest / UpdatePostRequest
 * in api/internal/api/posts.go, which share their fields. Every field may be
 * left out; an update keeps the stored title, content, slug, formatter, status
 * and type when those come back empty.
 */
export interface PostInput {
  title?: string;
  content?: string;
  css?: string;
  immersive_mode?: string;
  instagram_share?: boolean;
  excerpt?: string;
  slug?: string;
  formatter?: string;
  status?: string;
  type?: string;
  is_featured?: boolean;
  thumbnail_path?: string;
  meta_description?: string;
  /** Tag names. */
  tags?: string[];
  scheduled_at?: string | null;
}

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

/** List posts with optional filters. */
export function listPosts(params: {
  page?: number;
  per_page?: number;
  status?: string;
  type?: string;
  tag?: string;
  q?: string;
} = {}): Promise<PostPage & { tag?: Tag }> {
  return api.get('/api/posts', params);
}

/** Get a single post by numeric ID. */
export function getPost(id: number): Promise<Post> {
  return api.get(`/api/posts/${id}`);
}

/** Get a single post by slug (public, no auth). */
export function getPostBySlug(slug: string): Promise<Post> {
  return _cachedRead(`slug:${slug}`, () => api.get(`/api/posts/slug/${slug}`));
}

/** Create a new post. */
export function createPost(data: PostInput): Promise<Post> {
  clearPostReadCache();
  return api.post('/api/posts', data);
}

/** Update a post. */
export function updatePost(id: number, data: PostInput): Promise<Post> {
  clearPostReadCache();
  return api.put(`/api/posts/${id}`, data);
}

/** Move a post to trash (soft delete). */
export function deletePost(id: number): Promise<null> {
  clearPostReadCache();
  return api.delete(`/api/posts/${id}`);
}

/** Restore a trashed post. */
export function restorePost(id: number): Promise<null> {
  clearPostReadCache();
  return api.post(`/api/posts/${id}/restore`);
}

/** Permanently delete a post (must be in trash first). */
export function permanentlyDeletePost(id: number): Promise<null> {
  clearPostReadCache();
  return api.delete(`/api/posts/${id}/permanent`);
}

/** Get a draft post for preview via its preview token. */
export function previewPost(token: string): Promise<Post> {
  return api.get(`/api/posts/preview/${encodeURIComponent(token)}`);
}

/** Generate a shareable preview link for a post (valid 7 days). */
export function generatePreviewLink(id: number): Promise<{
  preview_url: string;
  token: string;
  expires_at: string;
}> {
  return api.post(`/api/posts/${id}/preview`);
}

/**
 * Update post status only.
 *
 * @param status - 'draft' | 'published' | 'hidden'
 */
export function setPostStatus(id: number, status: string): Promise<Post> {
  clearPostReadCache();
  return api.patch(`/api/posts/${id}/status`, { status });
}

/**
 * Update a post's tags only.
 *
 * @param tags - Tag names
 */
export function updatePostTags(id: number, tags: string[]): Promise<Post> {
  clearPostReadCache();
  return api.patch(`/api/posts/${id}/tags`, { tags });
}

/** Get posts adjacent to a given post for prev/next navigation. */
export function getPostNavigation(
  id: number,
  tag = '',
): Promise<{ prev: PostStub | null, next: PostStub | null }> {
  const key = tag ? `nav:${id}:${tag}` : `nav:${id}`;
  return _cachedRead(key, () => api.get(`/api/posts/${id}/navigation`, tag ? { tag } : undefined));
}

/** Find which home-feed (or tag-feed) page contains the given post. */
export function getPostPageLocation(
  slug: string,
  params: { tag?: string, per_page?: number } = {},
): Promise<{ page: number, per_page: number }> {
  return api.get(`/api/posts/${slug}/page`, params);
}

/**
 * Manually cross-post a post to Instagram.
 *
 * @returns Updated post with instagram_status/error fields
 */
export function publishPostToInstagram(id: number): Promise<Post> {
  return api.post(`/api/posts/${id}/instagram/publish`);
}

/** Render markdown content to HTML for preview. */
export function previewRender(content: string): Promise<{ html: string }> {
  return api.post('/api/posts/preview-render', { content });
}
