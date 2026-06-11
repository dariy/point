/**
 * Tags API — tag CRUD and hierarchy.
 *
 * Backend prefix: /api/tags
 */

import { api } from './client.js';

/**
 * @param {{ include_empty?: boolean, important_only?: boolean }} [params]
 * @returns {Promise<{ tags: object[], total: number }>}
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

/** @param {number} id */
export function getTag(id) {
  return api.get(`/api/tags/${id}`);
}

/** @param {string} slug */
export function getTagBySlug(slug) {
  return api.get(`/api/tags/slug/${encodeURIComponent(slug)}`);
}

/**
 * @param {object} data  TagCreate payload
 * @returns {Promise<object>}
 */
export function createTag(data) {
  return api.post('/api/tags', data);
}

/**
 * @param {number} id
 * @param {object} data  TagUpdate payload (all optional)
 * @returns {Promise<object>}
 */
export function updateTag(id, data) {
  return api.put(`/api/tags/${id}`, data);
}

/**
 * Patch a tag — only the provided fields are updated (merge semantics).
 * @param {number} id
 * @param {object} fields  Partial tag fields to update
 * @returns {Promise<object>}
 */
export function patchTag(id, fields) {
  return api.patch(`/api/tags/${id}`, fields);
}

/**
 * Replace all parent relationships for a tag.
 * @param {number} id
 * @param {number[]} ids  Parent IDs (empty array = unfiled)
 * @returns {Promise<object>}
 */
export function setTagParents(id, ids) {
  return api.put(`/api/tags/${id}/parents`, { ids });
}

/**
 * Replace all child relationships for a tag.
 * @param {number} id
 * @param {number[]} ids  Child IDs
 * @returns {Promise<object>}
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
 * @returns {Promise<object>}
 */
export function reorderTag(tagId, data) {
  return api.post(`/api/tags/${tagId}/reorder`, data);
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
