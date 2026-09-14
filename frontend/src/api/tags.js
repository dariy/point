/**
 * Tags API — tag CRUD and hierarchy.
 *
 * Backend prefix: /api/tags
 */

import { api } from './client.js';

/**
 * A neighbour reference: how a tag names its parents and children.
 *
 * @typedef {object} TagStub
 * @property {number} id
 * @property {string} name
 * @property {string} slug
 */

/**
 * A tag as GET /api/tags lists it and the single-tag endpoints return it
 * (tagView.listItem / tagView.fullResponse in api/internal/api). The single-tag
 * payload adds coordinates, siblings and created_at, and its neighbours carry
 * nav_order and post_count on top of the stub fields.
 *
 * @typedef {object} Tag
 * @property {number} id
 * @property {string} name
 * @property {string} name_path  Name qualified by its ancestors, for display.
 * @property {string} slug
 * @property {string|null} description
 * @property {string} kind
 * @property {boolean} hidden
 * @property {boolean} hides_posts
 * @property {number|null} nav_order
 * @property {boolean} in_breadcrumbs
 * @property {boolean} show_related
 * @property {boolean} in_ancestor_flyout
 * @property {boolean} effective_hidden  Hidden itself or through an ancestor.
 * @property {boolean} effective_hides_posts
 * @property {number} post_count
 * @property {TagStub[]} parents
 * @property {TagStub[]} children
 * @property {Array<{ id: number, latitude: number, longitude: number }>} locations
 * @property {number} [hidden_via]  Ancestor the hiding is inherited from. Admin only.
 * @property {number|null} [latitude]  Single-tag responses only.
 * @property {number|null} [longitude]  Single-tag responses only.
 * @property {TagStub[]} [siblings]  Single-tag responses only.
 * @property {string} [created_at]  Single-tag responses only.
 */

/**
 * @param {{ include_empty?: boolean, important_only?: boolean, q?: string }} [params]
 * @returns {Promise<{ tags: Tag[], total: number }>}
 */
export function listTags(params = {}) {
  return api.get('/api/tags', params);
}

/**
 * @param {number} limit
 * @returns {Promise<{ tags: object[] }>}
 */
export function getTagCloud(limit = 20) {
  return api.get('/api/tags/cloud', { limit });
}

/**
 * @param {number} id
 * @returns {Promise<Tag>}
 */
export function getTag(id) {
  return api.get(`/api/tags/${id}`);
}

/**
 * @param {string} slug
 * @returns {Promise<Tag>}
 */
export function getTagBySlug(slug) {
  return api.get(`/api/tags/slug/${encodeURIComponent(slug)}`);
}

/**
 * @param {object} data  TagCreate payload
 * @returns {Promise<Tag>}
 */
export function createTag(data) {
  return api.post('/api/tags', data);
}

/**
 * @param {number} id
 * @param {object} data  TagUpdate payload (all optional)
 * @returns {Promise<Tag>}
 */
export function updateTag(id, data) {
  return api.put(`/api/tags/${id}`, data);
}

/**
 * Patch a tag — only the provided fields are updated (merge semantics).
 * @param {number} id
 * @param {object} fields  Partial tag fields to update
 * @returns {Promise<Tag>}
 */
export function patchTag(id, fields) {
  return api.patch(`/api/tags/${id}`, fields);
}

/**
 * Replace all parent relationships for a tag.
 * @param {number} id
 * @param {number[]} ids  Parent IDs (empty array = unfiled)
 * @returns {Promise<Tag>}
 */
export function setTagParents(id, ids) {
  return api.put(`/api/tags/${id}/parents`, { ids });
}

/**
 * Replace all child relationships for a tag.
 * @param {number} id
 * @param {number[]} ids  Child IDs
 * @returns {Promise<Tag>}
 */
export function setTagChildren(id, ids) {
  return api.put(`/api/tags/${id}/children`, { ids });
}

/**
 * @param {number} id
 * @returns {Promise<null>}
 */
export function deleteTag(id) {
  return api.delete(`/api/tags/${id}`);
}

/**
 * Reorder a tag relative to another within its sibling group.
 * @param {number} tagId
 * @param {{ target_id: number|null, position: 'before'|'after', parent_id: number|null }} data
 * @returns {Promise<{ status: string }>}
 */
export function reorderTag(tagId, data) {
  return api.post(`/api/tags/${tagId}/reorder`, data);
}

/**
 * Move a tag to a position within a sibling group under a specific parent.
 * Only renumbers the sort_order for that parent's edge group; other parents
 * are untouched.
 * @param {number} tagId
 * @param {{ parent_id: number, after_id: number|null }} data  after_id=null → front
 * @returns {Promise<{ status: string }>}
 */
export function moveTag(tagId, data) {
  return api.post(`/api/tags/${tagId}/move`, data);
}

/**
 * Geocode a tag by its name via Nominatim and store the result.
 * @param {number} id
 * @returns {Promise<{ latitude: number, longitude: number }>}
 */
export function geocodeTag(id) {
  return api.post(`/api/tags/${id}/geocode`);
}

/** Recalculate all tag post counts. */
export function recalculateCounts() {
  return api.post('/api/tags/recalculate-counts');
}

/**
 * Merge one tag into another.
 * @param {number} loserId
 * @param {{ winner_id: number, keep_redirect: boolean }} data
 * @returns {Promise<null>}
 */
export function mergeTags(loserId, data) {
  return api.post(`/api/tags/${loserId}/merge`, data);
}
