/**
 * Tags API — tag CRUD and hierarchy.
 *
 * Backend prefix: /api/tags
 */

import { api } from './client.ts';
import type { TagCloudItem } from './pages.ts';

/** A neighbour reference: how a tag names its parents and children. */
export interface TagStub {
  id: number;
  name: string;
  slug: string;
}

/**
 * A tag as GET /api/tags lists it and the single-tag endpoints return it
 * (tagView.listItem / tagView.fullResponse in api/internal/api). The single-tag
 * payload adds coordinates, siblings and created_at, and its neighbours carry
 * nav_order and post_count on top of the stub fields.
 */
export interface Tag {
  id: number;
  name: string;
  /** Name qualified by its ancestors, for display. */
  name_path: string;
  slug: string;
  description: string | null;
  kind: string;
  hidden: boolean;
  hides_posts: boolean;
  nav_order: number | null;
  in_breadcrumbs: boolean;
  show_related: boolean;
  in_ancestor_flyout: boolean;
  /** Hidden itself or through an ancestor. */
  effective_hidden: boolean;
  effective_hides_posts: boolean;
  post_count: number;
  parents: TagStub[];
  children: TagStub[];
  locations: Array<{ id: number, latitude: number, longitude: number }>;
  /** Ancestor the hiding is inherited from. Admin only. */
  hidden_via?: number;
  /** Single-tag responses only. */
  latitude?: number | null;
  /** Single-tag responses only. */
  longitude?: number | null;
  /** Single-tag responses only. */
  siblings?: TagStub[];
  /** Single-tag responses only. */
  created_at?: string;
}

/**
 * A tag's own fields as a write sends them — the keys tagPatchParams reads in
 * api/internal/api. On an update only the keys present change.
 */
export interface TagFields {
  name?: string;
  slug?: string;
  description?: string;
  kind?: string;
  hidden?: boolean;
  hides_posts?: boolean;
  nav_order?: number | null;
  in_breadcrumbs?: boolean;
  show_related?: boolean;
  in_ancestor_flyout?: boolean;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * A tag create or PUT body: its own fields plus its relationships
 * (CreateTagRequest). On a PUT an explicit empty `parent_ids` or `child_ids`
 * removes them all, and an omitted key leaves them as they are.
 */
export interface TagInput extends TagFields {
  parent_ids?: number[];
  child_ids?: number[];
  locations?: Array<{ latitude: number, longitude: number }>;
}

export function listTags(params: {
  include_empty?: boolean;
  important_only?: boolean;
  q?: string;
} = {}): Promise<{ tags: Tag[], total: number }> {
  return api.get('/api/tags', params);
}

export function getTagCloud(limit = 20): Promise<{ tags: TagCloudItem[] }> {
  return api.get('/api/tags/cloud', { limit });
}

export function getTag(id: number): Promise<Tag> {
  return api.get(`/api/tags/${id}`);
}

export function getTagBySlug(slug: string): Promise<Tag> {
  return api.get(`/api/tags/slug/${encodeURIComponent(slug)}`);
}

export function createTag(data: TagInput): Promise<Tag> {
  return api.post('/api/tags', data);
}

export function updateTag(id: number, data: TagInput): Promise<Tag> {
  return api.put(`/api/tags/${id}`, data);
}

/**
 * Patch a tag — only the provided fields are updated (merge semantics).
 *
 * @param fields - Relationship keys are ignored here;
 *   setTagParents and setTagChildren own those.
 */
export function patchTag(id: number, fields: TagFields): Promise<Tag> {
  return api.patch(`/api/tags/${id}`, fields);
}

/**
 * Replace all parent relationships for a tag.
 *
 * @param ids - Parent IDs (empty array = unfiled)
 */
export function setTagParents(id: number, ids: number[]): Promise<Tag> {
  return api.put(`/api/tags/${id}/parents`, { ids });
}

/**
 * Replace all child relationships for a tag.
 *
 * @param ids - Child IDs
 */
export function setTagChildren(id: number, ids: number[]): Promise<Tag> {
  return api.put(`/api/tags/${id}/children`, { ids });
}

export function deleteTag(id: number): Promise<null> {
  return api.delete(`/api/tags/${id}`);
}

/** Reorder a tag relative to another within its sibling group. */
export function reorderTag(
  tagId: number,
  data: { target_id: number | null, position: 'before' | 'after', parent_id: number | null },
): Promise<{ status: string }> {
  return api.post(`/api/tags/${tagId}/reorder`, data);
}

/**
 * Move a tag to a position within a sibling group under a specific parent.
 * Only renumbers the sort_order for that parent's edge group; other parents
 * are untouched.
 *
 * @param data - after_id=null → front
 */
export function moveTag(
  tagId: number,
  data: { parent_id: number, after_id: number | null },
): Promise<{ status: string }> {
  return api.post(`/api/tags/${tagId}/move`, data);
}

/** Geocode a tag by its name via Nominatim and store the result. */
export function geocodeTag(id: number): Promise<{ latitude: number, longitude: number }> {
  return api.post(`/api/tags/${id}/geocode`);
}

/** Recalculate all tag post counts. */
export function recalculateCounts() {
  return api.post('/api/tags/recalculate-counts');
}

/** Merge one tag into another. */
export function mergeTags(
  loserId: number,
  data: { winner_id: number, keep_redirect: boolean },
): Promise<null> {
  return api.post(`/api/tags/${loserId}/merge`, data);
}
