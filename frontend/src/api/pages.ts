/**
 * Pages API — compound endpoints that bundle multiple resources in one request.
 *
 * Backend prefix: /api/pages
 */

import { api } from './client.ts';
import type { NavTagNode } from './nav.ts';
import type { Post } from './posts.ts';
import type { Settings } from './settings.ts';
import type { Tag } from './tags.ts';

/**
 * A feed paginator — paginationResponse in api/internal/api/pages.go. A pinned
 * home page carries only the first four fields.
 */
export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  pages: number;
  /**
   * How far left the feed extends: 1, or 0 and below for an owner with scheduled posts queued.
   */
  min_page?: number;
  /** This page came from the scheduled half. */
  scheduled?: boolean;
}

export interface TagCloudItem {
  id: number;
  name: string;
  slug: string;
  count: number;
  weight: number;
}

/**
 * The tag a tag archive is about — tagToFullResponse, which is the single-tag
 * payload without the graph annotations, plus two visibility flags for admins.
 */
export type ArchiveTag = Omit<Tag, 'effective_hidden' | 'effective_hides_posts' | 'hidden_via'> & {
  is_hidden?: boolean;
  is_hidden_posts?: boolean;
};

/**
 * One step of a tag archive's breadcrumb trail. `href` is set only when the
 * request carried an explicit path; without it the crumb links to the tag.
 */
export interface Crumb {
  id: number;
  name: string;
  name_path: string;
  slug: string;
  nav_order: number | null;
  post_count: number;
  href?: string;
  /** Admin only. */
  is_hidden?: boolean;
  /** Admin only. */
  is_hidden_posts?: boolean;
}

/**
 * Short-lived read cache for the paginated list pages, so the public grid can
 * preload the previous/next page and then navigate to it without a visible
 * reload (the swipe-committed route swap resolves from cache within a
 * microtask, before paint). Mirrors the post read cache in posts.ts.
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
 * @returns tag_cloud and menu ride on the first, unfiltered page only.
 */
export function getHomePage(params: { page?: number, per_page?: number } = {}): Promise<{
  posts: Post[];
  pagination: Pagination;
  settings: Settings;
  tag_cloud?: TagCloudItem[];
  menu?: NavTagNode[];
}> {
  return _cachedPage(`home:${JSON.stringify(params)}`, () => api.get('/api/pages/home', params));
}

/** Tag page data: tag info, breadcrumbs, posts filtered to that tag. */
export function getTagPage(
  slug: string,
  params: { page?: number, per_page?: number } = {},
): Promise<{
  tag: ArchiveTag;
  breadcrumbs: Crumb[];
  posts: Post[];
  pagination: Pagination;
  menu: NavTagNode[];
  nav_children: NavTagNode[];
}> {
  return _cachedPage(
    `tag:${slug}:${JSON.stringify(params)}`,
    () => api.get(`/api/pages/tags/${encodeURIComponent(slug)}`, params),
  );
}

/** Tags index page data: full tag list with hierarchy + total. */
export function getTagsPage(): Promise<{
  tags: Array<Tag & { is_hidden?: boolean }>;
  total: number;
}> {
  return api.get('/api/pages/tags');
}

/**
 * Tags graph data: tag nodes + parent/child hierarchy edges, plus post ("shadow")
 * nodes and post→tag membership edges for the /tags force-graph (cloud) view.
 *
 * Pass `{ posts: 0 }` to omit posts + membership edges — the Atlas does this and
 * lazily fetches each place's recent posts on tap via getTagCloud, so the whole
 * post set never loads up front.
 */
export function getTagsGraph(params: { posts?: 0 } = {}): Promise<{
  tags: Array<{
    id: number;
    name: string;
    slug: string;
    kind: string;
    latitude?: number;
    longitude?: number;
    post_count: number;
  }>;
  hierarchyEdges: Array<{ parent: number, child: number }>;
  posts?: Array<{ id: number, slug: string, title: string, media_url?: string }>;
  membershipEdges?: Array<{ post: number, tag: number }>;
}> {
  return api.get('/api/pages/graph', params);
}

/**
 * The Atlas cloud for a single place: its sub-tree's 10 most recent posts and 10
 * most popular co-occurring tags, plus the membership/hierarchy edges wiring that
 * subset together. Optionally scoped to a timeline year range.
 */
export function getTagCloud(
  tagId: number,
  params: { year_from?: number, year_to?: number } = {},
): Promise<{
  tags: Array<{
    id: number;
    name: string;
    slug: string;
    kind: string;
    latitude?: number;
    longitude?: number;
  }>;
  posts: Array<{ id: number, slug: string, title: string, media_url?: string }>;
  membershipEdges: Array<{ post: number, tag: number }>;
  hierarchyEdges: Array<{ parent: number, child: number }>;
}> {
  return api.get(`/api/pages/graph/tag/${tagId}`, params);
}

/** Map page data: tags with coordinates, categorised as country / city / other. */
export function getMapPage(params: { year_from?: number, year_to?: number } = {}): Promise<{
  tags: Array<{
    name: string;
    slug: string;
    post_count: number;
    lat: number;
    lng: number;
    type: string;
  }>;
}> {
  return api.get('/api/pages/map', params);
}

