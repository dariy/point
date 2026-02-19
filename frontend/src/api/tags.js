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
 * @param {number} id
 * @returns {Promise<null>}
 */
export function deleteTag(id) {
  return api.delete(`/api/tags/${id}`);
}

/**
 * Reorder a tag relative to another.
 * @param {number} tagId
 * @param {{ target_id: number|null, position: 'before'|'after'|'inside', current_parent_id: number|null }} data
 * @returns {Promise<object>}
 */
export function reorderTag(tagId, data) {
  return api.post(`/api/tags/${tagId}/reorder`, data);
}

/** Recalculate all tag post counts. */
export function recalculateCounts() {
  return api.post('/api/tags/recalculate-counts');
}
