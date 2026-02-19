/**
 * Tags API — tag CRUD and hierarchy.
 *
 * Backend prefix: /api/tags
 */

import { api } from './client.js';

/**
 * List all tags.
 * @param {{ q?: string, with_counts?: boolean }} [params]
 * @returns {Promise<object[]>}
 */
export function listTags(params = {}) {
  return api.get('/api/tags', params);
}

/**
 * Get a tag by ID.
 * @param {number} id
 * @returns {Promise<object>}
 */
export function getTag(id) {
  return api.get(`/api/tags/${id}`);
}

/**
 * Get a tag by slug (public).
 * @param {string} slug
 * @returns {Promise<object>}
 */
export function getTagBySlug(slug) {
  return api.get(`/api/tags/slug/${slug}`);
}

/**
 * Create a tag.
 * @param {object} data  TagCreate payload
 * @returns {Promise<object>}
 */
export function createTag(data) {
  return api.post('/api/tags', data);
}

/**
 * Update a tag.
 * @param {number} id
 * @param {object} data  TagUpdate payload
 * @returns {Promise<object>}
 */
export function updateTag(id, data) {
  return api.put(`/api/tags/${id}`, data);
}

/**
 * Delete a tag.
 * @param {number} id
 * @returns {Promise<null>}
 */
export function deleteTag(id) {
  return api.delete(`/api/tags/${id}`);
}

/**
 * Reorder tags (update display_order).
 * @param {Array<{ id: number, display_order: number }>} items
 * @returns {Promise<null>}
 */
export function reorderTags(items) {
  return api.put('/api/tags/reorder', { items });
}
